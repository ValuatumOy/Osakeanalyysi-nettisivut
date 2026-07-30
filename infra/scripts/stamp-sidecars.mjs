#!/usr/bin/env node
// One-time sidecar cleanup before the S3 copy (plan §2.2 item 2), run against
// a LOCAL copy of the box's reports/pdfs folder:
//
//   1. Drop absolute pdfUrl values — the catalog derives them from
//      REPORT_PDF_BASE_URL, so files never carry a hostname again.
//   2. Stamp uploadedAt — `aws s3 cp` resets LastModified to copy time, and
//      without the stamp every report without an explicit date would go
//      hidden for visibleAfterDays after cutover. Preference order:
//      sidecar reportDate → date in the filename → file mtime (the mtime is
//      last because a plain copy off the box flattens it to copy time).
//
// Creates a sidecar for PDFs that have none (uploadedAt only). Idempotent.
//
// Usage:  node infra/scripts/stamp-sidecars.mjs /path/to/reports/pdfs
//         # then: aws s3 cp /path/to/reports/pdfs "s3://aiequityreports-pdfs/reports/pdfs/" --recursive

import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('Usage: node infra/scripts/stamp-sidecars.mjs /path/to/reports/pdfs');
  process.exit(1);
}

// Mirrors catalog.js: Company_DDMMYYYY.pdf -> YYYY-MM-DD.
function dateFromFileName(fileName) {
  const match = fileName.match(/(\d{8})(?=\.pdf$|[^0-9])/i);
  if (!match) return null;
  const raw = match[1];
  const dd = Number(raw.slice(0, 2));
  const mm = Number(raw.slice(2, 4));
  if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
    return `${raw.slice(4, 8)}-${raw.slice(2, 4)}-${raw.slice(0, 2)}`;
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

let stamped = 0;
let cleaned = 0;
let created = 0;

for (const file of fs.readdirSync(dir)) {
  if (!/\.pdf$/i.test(file)) continue;
  const pdfPath = path.join(dir, file);
  const sidecarPath = path.join(dir, file.replace(/\.pdf$/i, '.json'));
  const mtimeIso = fs.statSync(pdfPath).mtime.toISOString();

  let sidecar = {};
  let existed = false;
  if (fs.existsSync(sidecarPath)) {
    existed = true;
    try {
      sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      console.warn(`SKIP ${file}: unparseable sidecar (${err.message})`);
      continue;
    }
  }

  let changed = !existed;
  if (sidecar.pdfUrl) {
    delete sidecar.pdfUrl;
    cleaned += 1;
    changed = true;
  }
  if (!sidecar.uploadedAt) {
    const dateOnly = sidecar.reportDate || dateFromFileName(file);
    sidecar.uploadedAt = dateOnly ? `${dateOnly}T00:00:00.000Z` : mtimeIso;
    stamped += 1;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    if (!existed) created += 1;
  }
}

console.log(`Done: ${stamped} uploadedAt stamped, ${cleaned} pdfUrl removed, ${created} sidecars created.`);
