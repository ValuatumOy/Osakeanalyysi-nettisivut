#!/usr/bin/env python3
"""Match unreviewed pages to possible ESEF filings without changing any pages."""

import argparse
import csv
import datetime
import io
import json
import pathlib
import re
import sys
import zipfile
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parents[2]
LEI = re.compile(r"[A-Z0-9]{20}\Z")
ISIN = re.compile(r"[A-Z]{2}[A-Z0-9]{10}\Z")
SCRIPT = re.compile(r'<script type="application/ld\+json">\s*(.*?)\s*</script>', re.S)


def load_review_candidates(root, include_status, year):
    review_dir = root / "company-content" / "reviews"
    reviewed, statuses, pending, previous_reviews = set(), set(), {}, []
    for filename in sorted(review_dir.glob("????-??-??-*.json")):
        data = json.loads(filename.read_text(encoding="utf-8-sig"))
        if re.search(r"(?:pilot|batch-\d+|corrections)\.json$", filename.name):
            for page in data.get("pages", []):
                previous_reviews.append({
                    "file": pathlib.PurePosixPath(page["path"]).name,
                    "ticker": page.get("pageTicker") or page.get("ticker"),
                    "isin": page.get("isin"), "pageYear": page.get("financialYear"),
                })
        elif filename.name.endswith("company-status.json"):
            for page in data.get("pages", []):
                name = pathlib.PurePosixPath(page["file"]).name
                identity = {"file": name, "ticker": page.get("ticker"), "isin": page.get("isin")}
                if not identity["ticker"] or not identity["isin"] or page_matches(root, identity):
                    statuses.add(name)
                if page.get("financialReview"):
                    previous_reviews.append({
                        "file": name, "ticker": page.get("ticker"), "isin": page.get("isin"),
                        "pageYear": page["financialReview"].get("financialYear"),
                    })
        elif filename.name.endswith("freshness-audit.json"):
            for page in data.get("results", []):
                pending[page["file"]] = page
    for page in previous_reviews:
        if not isinstance(page["pageYear"], int) or not page_matches(root, page):
            continue
        name = page["file"]
        if page["pageYear"] >= year:
            reviewed.add(name)
        elif name not in pending or not page_matches(root, pending[name]) or page["pageYear"] > (pending[name].get("pageYear") or 0):
            pending[name] = dict(page, status="reviewed_earlier_year")
    return [
        dict(page, statusRecorded=name in statuses)
        for name, page in pending.items()
        if name not in reviewed and (include_status or name not in statuses)
        and (not isinstance(page.get("pageYear"), int) or page["pageYear"] <= year)
    ]


def page_matches(root, page):
    name = page.get("file", "")
    if not re.fullmatch(r"[a-z0-9-]+-equity-report\.html", name):
        return False
    try:
        html = (root / "reports" / name).read_text(encoding="utf8")
        entities = []
        for match in SCRIPT.finditer(html):
            document = json.loads(match.group(1))
            graph = document.get("@graph", []) if isinstance(document, dict) else []
            if isinstance(graph, list):
                entities.extend(x["mainEntity"] for x in graph if isinstance(x, dict) and x.get("@type") == "WebPage" and isinstance(x.get("mainEntity"), dict))
        return len(entities) == 1 and entities[0].get("identifier") == page.get("isin") and entities[0].get("tickerSymbol") == page.get("ticker")
    except (OSError, ValueError, TypeError, KeyError):
        return False


def build_queue(root, mapping_zip, filings_json, year, include_status=False):
    pages = load_review_candidates(root, include_status, year)
    pending_count = len(pages)
    mismatches = [p["file"] for p in pages if not page_matches(root, p)]
    pages = [p for p in pages if p["file"] not in mismatches and ISIN.fullmatch(p.get("isin") or "")]
    wanted = {p["isin"] for p in pages}
    mappings = defaultdict(set)
    with zipfile.ZipFile(mapping_zip) as archive:
        names = [n for n in archive.namelist() if n.lower().endswith(".csv") and not n.endswith("/")]
        if len(names) != 1:
            raise ValueError("Mapping archive must contain exactly one CSV")
        with io.TextIOWrapper(archive.open(names[0]), encoding="utf-8-sig", newline="") as handle:
            rows = csv.DictReader(handle)
            if rows.fieldnames != ["LEI", "ISIN"]:
                raise ValueError("Unexpected ISIN-to-LEI CSV header")
            for row in rows:
                if row["ISIN"] in wanted:
                    if not LEI.fullmatch(row["LEI"]):
                        raise ValueError("Invalid LEI for a candidate ISIN")
                    mappings[row["ISIN"]].add(row["LEI"])

    index = json.loads(pathlib.Path(filings_json).read_text(encoding="utf-8-sig"))
    filings = index.get("data")
    if not isinstance(filings, list) or index.get("meta", {}).get("count") != len(filings):
        raise ValueError("Filings index is incomplete or invalid")
    by_lei = defaultdict(list)
    for filing in filings:
        attrs = filing.get("attributes", {})
        period = attrs.get("period_end") or ""
        related = filing.get("relationships", {}).get("entity", {}).get("links", {}).get("related") or ""
        lei = related.rsplit("/", 1)[-1]
        if not LEI.fullmatch(lei) or not re.fullmatch(rf"{year}-\d{{2}}-\d{{2}}", period):
            continue
        try:
            datetime.date.fromisoformat(period)
        except ValueError:
            continue
        if not str(attrs.get("fxo_id", "")).startswith(lei + "-" + period + "-"):
            continue
        urls = [attrs.get("report_url"), attrs.get("json_url")]
        if any(not isinstance(url, str) or not url.startswith(f"/{lei}/{period}/") or ".." in url for url in urls):
            continue
        by_lei[lei].append({
            "id": filing.get("id"), "periodEnd": period,
            "reportUrl": "https://filings.xbrl.org" + urls[0],
            "jsonUrl": "https://filings.xbrl.org" + urls[1],
            "errorCount": attrs.get("error_count"), "warningCount": attrs.get("warning_count"),
        })

    candidates = []
    for page in pages:
        matches = mappings.get(page["isin"], set())
        if len(matches) != 1:
            continue
        lei = next(iter(matches))
        if lei in by_lei:
            candidates.append({
                "file": page["file"], "ticker": page["ticker"], "isin": page["isin"],
                "pageYear": page.get("pageYear"), "auditStatus": page.get("status"),
                "statusRecorded": page["statusRecorded"],
                "lei": lei, "filings": by_lei[lei],
            })
    candidates.sort(key=lambda p: (p["pageYear"] or 9999, p["file"]))
    return {
        "note": "Unreviewed leads only. Verify identity, listing status, audited annual filing, accounting scope and every figure before publication.",
        "pendingPages": pending_count, "pageIdentityMismatches": mismatches,
        "uniqueMappings": sum(len(mappings.get(p["isin"], set())) == 1 for p in pages),
        "ambiguousMappings": sum(len(mappings.get(p["isin"], set())) > 1 for p in pages),
        "matchedPages": len(candidates), "candidates": candidates,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mapping-zip", required=True)
    parser.add_argument("--filings-json", required=True)
    parser.add_argument("--year", required=True, type=int, choices=range(2000, 2101))
    parser.add_argument("--include-status", action="store_true", help="include pages with recorded company-status notes")
    parser.add_argument("--limit", type=int, default=20, help="maximum candidates to print; 0 prints all")
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit must be non-negative")
    result = build_queue(ROOT, args.mapping_zip, args.filings_json, args.year, args.include_status)
    if args.limit:
        result["candidates"] = result["candidates"][:args.limit]
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
