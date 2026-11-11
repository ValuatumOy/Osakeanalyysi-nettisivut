#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function auditCompanyReviewCoverage(rootDir = ROOT) {
  const reviewDir = path.join(rootDir, 'company-content', 'reviews');
  const reviewed = new Set();
  const pending = new Set();
  const statuses = new Set();
  for (const file of await fs.readdir(reviewDir)) {
    if (!/^\d{4}-\d{2}-\d{2}-.*\.json$/.test(file)) continue;
    if (!/(?:pilot|batch-\d+|corrections|freshness-audit|company-status)\.json$/.test(file)) continue;
    const data = JSON.parse(await fs.readFile(path.join(reviewDir, file), 'utf8'));
    if (/(?:pilot|batch-\d+|corrections)\.json$/.test(file)) {
      for (const page of data.pages || []) reviewed.add(path.basename(page.path));
    } else if (file.endsWith('company-status.json')) {
      for (const page of data.pages || []) statuses.add(path.basename(page.file));
    } else {
      for (const page of data.results || []) pending.add(path.basename(page.file));
    }
  }

  const pages = [];
  const reportDir = path.join(rootDir, 'reports');
  for (const file of (await fs.readdir(reportDir)).filter((name) => name.endsWith('-equity-report.html')).sort()) {
    const html = await fs.readFile(path.join(reportDir, file), 'utf8');
    if (!/valuatum-page-mode/i.test(html)) pages.push(file);
  }
  const inSet = (set) => pages.filter((file) => set.has(file)).length;
  return {
    total: pages.length,
    reviewed: inSet(reviewed),
    pending: inSet(pending),
    historicalStatus: inSet(statuses),
    untracked: pages.filter((file) => !reviewed.has(file) && !pending.has(file) && !statuses.has(file)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: npm run audit:company-review-coverage -- [--check]');
    const result = await auditCompanyReviewCoverage();
    console.log(JSON.stringify(result, null, 2));
    if (process.argv.includes('--check') && result.untracked.length) process.exitCode = 1;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
