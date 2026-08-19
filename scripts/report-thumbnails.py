#!/usr/bin/env python3
"""Rebuild the homepage sample-report thumbnails from the real report PDFs.

The cards used to show screenshots of the company pages, which advertised the
website rather than the product. These are crops of the actual report cover:
recommendation, current price, implied upside, market cap.

Nothing about which report to use is hardcoded. The cards come from
index.html (`data-company-card` plus the thumbnail it renders) and the PDF
comes from the live catalog — the newest free report for that ticker — so a
refreshed free report is picked up by re-running this, and a card added to or
removed from the homepage needs no edit here.

  AWS_PROFILE=valuatum-pdf python3 scripts/report-thumbnails.py
  AWS_PROFILE=valuatum-pdf python3 scripts/report-thumbnails.py --check

--check exits 1 when a card's free report is no longer the one its thumbnail
was cut from (images/report-thumbnails.json), without writing anything.

Needs PyMuPDF (pip install pymupdf) and read access to the production PDF bucket.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import tempfile

import fitz

BUCKET = "s3://aiequityreports-pdfs/reports/pdfs"
CATALOG_URL = "https://www.aiequityreports.com/api/reports"
ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "images" / "report-thumbnails.json"

# The cover's six metric tiles sit in a fixed block whose distance from the top
# of the page varies with the length of the company profile above it. Anchor on
# a sublabel that appears exactly once, and take the block's own geometry as
# constant — it comes from one renderer. Verified across reports 6.8. and 18.8.:
# the recommendation label is always 150.75pt above the anchor and the ratio
# strip always ~50pt below it.
ANCHOR = "vs. current price"
BOTTOM_FROM_ANCHOR = 45.5    # clears the ratio strip, which sits ~50pt below
LEFT = 39.68                 # page margin
RIGHT = 385                  # the gutter between the second and third tile column
ASPECT = 16 / 10             # .sample-thumbnail, with object-fit: cover
SCALE = 2.4

# Two of the three tile columns. The whole six-tile block is 2.7:1, so cropping
# it to the card's 16:10 would letterbox — and at 366px the labels would be 4px
# tall either way. Half the page width is what makes BUY and +16.7% readable.
VERDICTS = ("BUY", "SELL", "HOLD")


def cards():
    """(ticker, thumbnail filename) for every sample card on the homepage."""
    html = (ROOT / "index.html").read_text()
    found = re.findall(
        r'data-company-card="([^"]+)".*?class="sample-thumbnail-img" src="images/([^"]+)"',
        html, re.S)
    if not found:
        raise SystemExit("No sample cards found in index.html — has the markup changed?")
    return found


def free_report(catalog, ticker):
    """The newest free report for a ticker. The cards advertise a free PDF, so a
    newer paid report for the same company must not take the card over."""
    hits = [r for r in catalog if str(r.get("ticker", "")).upper() == ticker.upper() and r.get("isFree")]
    if not hits:
        raise SystemExit(f"No free report in the live catalog for {ticker}")
    return max(hits, key=lambda r: str(r.get("reportDate", "")))["fileName"]


def crop(pdf_path):
    page = fitz.open(pdf_path)[0]
    hits = page.search_for(ANCHOR)
    if len(hits) != 1:
        raise SystemExit(f"{pdf_path.name}: expected one '{ANCHOR}', found {len(hits)}")
    anchor = hits[0].y0
    bottom = anchor + BOTTOM_FROM_ANCHOR
    # Width is what the card is cut to; the aspect then decides where the top
    # lands. It clears the recommendation label by ~20pt, and the template
    # always leaves 40pt of air between the profile text and that label.
    clip = fitz.Rect(LEFT, bottom - (RIGHT - LEFT) / ASPECT, RIGHT, bottom)
    if not page.rect.contains(clip):
        raise SystemExit(f"{pdf_path.name}: crop {clip} falls outside the page")
    verdict = next((v for v in VERDICTS
                    for r in page.search_for(v) if clip.contains(r)), None)
    if not verdict:
        raise SystemExit(f"{pdf_path.name}: no recommendation inside the crop — layout moved")
    return page, clip, verdict


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="report thumbnails whose source report has changed, write nothing")
    parser.add_argument("--force", action="store_true",
                        help="re-cut every thumbnail even when its source is unchanged")
    args = parser.parse_args()

    # curl, not urllib: the python.org build has no CA bundle of its own.
    fetch = subprocess.run(["curl", "-fsS", CATALOG_URL], capture_output=True, text=True)
    if fetch.returncode != 0:
        raise SystemExit(f"Catalog fetch failed: {fetch.stderr.strip()}")
    payload = json.loads(fetch.stdout)
    catalog = payload if isinstance(payload, list) else payload["reports"]

    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    wanted = {target: free_report(catalog, ticker) for ticker, target in cards()}

    stale = {t: s for t, s in wanted.items() if manifest.get(t) != s}
    if args.check:
        for target, source in stale.items():
            print(f"stale  images/{target}  {manifest.get(target, '(none)')} -> {source}")
        print(f"\n{len(stale)} of {len(wanted)} thumbnails out of date")
        return 1 if stale else 0

    todo = wanted if args.force else stale
    if not todo:
        print(f"{len(wanted)} thumbnails already cut from the current free reports")
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        for target, source in todo.items():
            local = pathlib.Path(tmp) / source
            fetch = subprocess.run(
                ["aws", "s3", "cp", f"{BUCKET}/{source}", str(local), "--region", "eu-west-1", "--quiet"],
                capture_output=True, text=True)
            if fetch.returncode != 0:
                print(f"FAILED {source}: {fetch.stderr.strip()}", file=sys.stderr)
                return 1
            page, clip, verdict = crop(local)
            out = ROOT / "images" / target
            page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE), clip=clip).save(out)
            manifest[target] = source
            print(f"wrote images/{target}  {source}  {verdict}  ({out.stat().st_size // 1024} KB)")

    MANIFEST.write_text(json.dumps(dict(sorted(manifest.items())), indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
