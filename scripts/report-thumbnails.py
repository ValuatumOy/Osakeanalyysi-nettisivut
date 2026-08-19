#!/usr/bin/env python3
"""Rebuild the homepage sample-report thumbnails from the real report PDFs.

The cards used to show screenshots of the company pages, which advertised the
website rather than the product — and went stale every time the nav changed.
These are crops of the actual report cover: recommendation, current and target
price, implied upside, market cap. Re-run when the sampled reports are refreshed.

  AWS_PROFILE=valuatum-pdf python3 scripts/report-thumbnails.py

Needs PyMuPDF (pip install pymupdf) and read access to the production PDF bucket.
"""
import pathlib
import subprocess
import sys
import tempfile

import fitz

BUCKET = "s3://aiequityreports-pdfs/reports/pdfs"
ROOT = pathlib.Path(__file__).resolve().parent.parent

# The three companies the homepage samples, and the report each card shows.
CARDS = [
    ("UPM_06082026.pdf", "upm-report-header.png"),
    ("StoraEnso_18082026.pdf", "stora-enso-report-header.png"),
    ("TeslaInc_18082026.pdf", "tesla-report-header.png"),
]

# .sample-thumbnail is 16:10 with object-fit: cover, so anything else gets
# cropped. Page 1 is A4; y=250pt starts just under the company name, which the
# card already prints as its own heading.
ASPECT = 16 / 10
TOP = 250
SCALE = 2.4


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        for source, target in CARDS:
            local = pathlib.Path(tmp) / source
            fetch = subprocess.run(
                ["aws", "s3", "cp", f"{BUCKET}/{source}", str(local), "--region", "eu-west-1", "--quiet"],
                capture_output=True, text=True,
            )
            if fetch.returncode != 0:
                print(f"FAILED {source}: {fetch.stderr.strip()}", file=sys.stderr)
                return 1
            page = fitz.open(local)[0]
            width = page.rect.width
            clip = fitz.Rect(0, TOP, width, TOP + width / ASPECT)
            out = ROOT / "images" / target
            page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE), clip=clip).save(out)
            print(f"wrote images/{target}  ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
