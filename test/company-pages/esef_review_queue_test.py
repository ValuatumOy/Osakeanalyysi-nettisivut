import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("esef_review_queue", ROOT / "scripts/company-pages/esef-review-queue.py")
QUEUE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QUEUE)


class EsefQueueTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        (self.root / "reports").mkdir()
        self.reviews = self.root / "company-content/reviews"
        self.reviews.mkdir(parents=True)
        self.lei = "54930000000000000001"
        self.isin = "FI0000000001"
        self.pages = [
            {"file": "first-equity-report.html", "ticker": "ONE.HE", "isin": self.isin, "pageYear": 2023},
            {"file": "ambiguous-equity-report.html", "ticker": "TWO.HE", "isin": "FI0000000002", "pageYear": 2022},
            {"file": "mismatch-equity-report.html", "ticker": "THREE.HE", "isin": self.isin, "pageYear": 2024},
            {"file": "old-equity-report.html", "ticker": "OLD.HE", "isin": self.isin, "pageYear": 2021},
            {"file": "done-equity-report.html", "ticker": "DONE.HE", "isin": self.isin, "pageYear": 2022},
        ]
        for page in self.pages:
            entity = {"@type": "WebPage", "mainEntity": {"identifier": page["isin"], "tickerSymbol": page["ticker"]}}
            if page["ticker"] == "THREE.HE":
                entity["mainEntity"]["tickerSymbol"] = "DIFFERENT.HE"
            html = '<script type="application/ld+json">' + json.dumps({"@graph": [entity]}) + '</script>'
            (self.root / "reports" / page["file"]).write_text(html, encoding="utf8")
        (self.reviews / "2026-11-11-freshness-audit.json").write_text(json.dumps({"results": self.pages}), encoding="utf8")
        (self.reviews / "2026-11-11-batch-1.json").write_text(json.dumps({"pages": [{"path": "reports/done-equity-report.html", "ticker": "DONE.HE", "isin": self.isin, "financialYear": 2025}]}), encoding="utf8")
        (self.reviews / "2026-11-11-company-status.json").write_text(json.dumps({"pages": [{"file": "reports/old-equity-report.html"}]}), encoding="utf8")
        self.mapping = self.root / "mapping.zip"
        with zipfile.ZipFile(self.mapping, "w") as archive:
            archive.writestr("mapping.csv", f"LEI,ISIN\n{self.lei},{self.isin}\n{self.lei},FI0000000002\n54930000000000000002,FI0000000002\n")
        self.filings = self.root / "filings.json"
        self.filing = {"id": "1", "attributes": {"fxo_id": self.lei + "-2025-12-31-ESEF-FI-0", "period_end": "2025-12-31", "report_url": f"/{self.lei}/2025-12-31/report.xhtml", "json_url": f"/{self.lei}/2025-12-31/facts.json", "error_count": 0}, "relationships": {"entity": {"links": {"related": "/api/entities/" + self.lei}}}}
        self.filings.write_text(json.dumps({"data": [self.filing], "meta": {"count": 1}}), encoding="utf8")

    def test_requires_matching_page_identity_and_unique_mapping(self):
        result = QUEUE.build_queue(self.root, self.mapping, self.filings, 2025)
        self.assertEqual(result["matchedPages"], 1)
        self.assertEqual(result["ambiguousMappings"], 1)
        self.assertEqual(result["pageIdentityMismatches"], ["mismatch-equity-report.html"])
        self.assertEqual(result["candidates"][0]["file"], "first-equity-report.html")
        self.assertEqual(result["candidates"][0]["filings"][0]["reportUrl"], f"https://filings.xbrl.org/{self.lei}/2025-12-31/report.xhtml")
        self.assertNotIn("values", result["candidates"][0])
        with_historical = QUEUE.build_queue(self.root, self.mapping, self.filings, 2025, True)
        self.assertEqual(with_historical["matchedPages"], 2)
        self.assertTrue(with_historical["candidates"][0]["statusRecorded"])

    def test_rejects_incomplete_index_and_ignores_untrusted_filing_urls(self):
        self.filings.write_text(json.dumps({"data": [self.filing], "meta": {"count": 2}}), encoding="utf8")
        with self.assertRaisesRegex(ValueError, "incomplete"):
            QUEUE.build_queue(self.root, self.mapping, self.filings, 2025)
        self.filing["attributes"]["report_url"] = "//outside.example/report"
        self.filings.write_text(json.dumps({"data": [self.filing], "meta": {"count": 1}}), encoding="utf8")
        self.assertEqual(QUEUE.build_queue(self.root, self.mapping, self.filings, 2025)["matchedPages"], 0)

    def test_rejects_other_entity_or_period_in_report_links(self):
        attrs = self.filing["attributes"]
        for key, value in [("report_url", "/54930000000000000002/2025-12-31/report.xhtml"),
                           ("json_url", f"/{self.lei}/2024-12-31/facts.json"),
                           ("fxo_id", self.lei + "-2024-12-31-ESEF-FI-0")]:
            original = attrs[key]
            attrs[key] = value
            self.filings.write_text(json.dumps({"data": [self.filing], "meta": {"count": 1}}), encoding="utf8")
            self.assertEqual(QUEUE.build_queue(self.root, self.mapping, self.filings, 2025)["matchedPages"], 0)
            attrs[key] = original

    def test_previous_review_returns_next_year_and_non_graph_json_is_ignored(self):
        done = self.root / "reports/done-equity-report.html"
        done.write_text('<script type="application/ld+json">null</script>' + done.read_text(encoding="utf8"), encoding="utf8")
        audits = self.reviews / "2026-11-11-freshness-audit.json"
        audits.write_text(json.dumps({"results": [p for p in self.pages if p["ticker"] != "DONE.HE"]}), encoding="utf8")
        attrs = self.filing["attributes"]
        attrs.update(fxo_id=self.lei + "-2026-12-31-ESEF-FI-0", period_end="2026-12-31",
                     report_url=f"/{self.lei}/2026-12-31/report.xhtml", json_url=f"/{self.lei}/2026-12-31/facts.json")
        self.filings.write_text(json.dumps({"data": [self.filing], "meta": {"count": 1}}), encoding="utf8")
        result = QUEUE.build_queue(self.root, self.mapping, self.filings, 2026)
        prior = next(x for x in result["candidates"] if x["file"] == "done-equity-report.html")
        self.assertEqual(prior["pageYear"], 2025)
        self.assertEqual(prior["auditStatus"], "reviewed_earlier_year")

    def test_current_review_replaces_stale_same_year_audit_identity(self):
        audit = self.reviews / "2026-11-11-freshness-audit.json"
        data = json.loads(audit.read_text(encoding="utf8"))
        done = next(p for p in data["results"] if p["ticker"] == "DONE.HE")
        done.update(ticker="FORMER.HE", pageYear=2025)
        audit.write_text(json.dumps(data), encoding="utf8")
        attrs = self.filing["attributes"]
        attrs.update(fxo_id=self.lei + "-2026-12-31-ESEF-FI-0", period_end="2026-12-31",
                     report_url=f"/{self.lei}/2026-12-31/report.xhtml", json_url=f"/{self.lei}/2026-12-31/facts.json")
        self.filings.write_text(json.dumps({"data": [self.filing], "meta": {"count": 1}}), encoding="utf8")
        result = QUEUE.build_queue(self.root, self.mapping, self.filings, 2026)
        prior = next(x for x in result["candidates"] if x["file"] == "done-equity-report.html")
        self.assertEqual(prior["ticker"], "DONE.HE")
        self.assertNotIn("done-equity-report.html", result["pageIdentityMismatches"])

    def test_status_exclusion_follows_current_page_identity(self):
        status = self.reviews / "2026-11-11-company-status.json"
        status.write_text(json.dumps({"pages": [{"file": "reports/old-equity-report.html", "ticker": "OLD.HE", "isin": self.isin}]}), encoding="utf8")
        result = QUEUE.build_queue(self.root, self.mapping, self.filings, 2025)
        self.assertNotIn("old-equity-report.html", [p["file"] for p in result["candidates"]])
        status.write_text(json.dumps({"pages": [{"file": "reports/old-equity-report.html", "ticker": "FORMER.HE", "isin": self.isin}]}), encoding="utf8")
        result = QUEUE.build_queue(self.root, self.mapping, self.filings, 2025)
        self.assertIn("old-equity-report.html", [p["file"] for p in result["candidates"]])

    def test_does_not_suggest_older_filing_than_page(self):
        audit = self.reviews / "2026-11-11-freshness-audit.json"
        data = json.loads(audit.read_text(encoding="utf8"))
        data["results"][0]["pageYear"] = 2026
        audit.write_text(json.dumps(data), encoding="utf8")
        result = QUEUE.build_queue(self.root, self.mapping, self.filings, 2025)
        self.assertNotIn("first-equity-report.html", [p["file"] for p in result["candidates"]])


if __name__ == "__main__":
    unittest.main()
