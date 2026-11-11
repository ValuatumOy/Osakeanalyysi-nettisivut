import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditCompanyReviewCoverage } from '../../scripts/audit-company-review-coverage.mjs';

test('review coverage finds omitted overviews and excludes full reports', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-coverage-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reviews = path.join(root, 'company-content', 'reviews');
  const reports = path.join(root, 'reports');
  await fs.mkdir(reviews, { recursive: true });
  await fs.mkdir(reports);
  for (const name of ['reviewed', 'pending', 'historical', 'omitted']) {
    await fs.writeFile(path.join(reports, `${name}-equity-report.html`), '<html></html>');
  }
  await fs.writeFile(path.join(reports, 'full-equity-report.html'), '<meta name="valuatum-page-mode" content="report">');
  await fs.writeFile(path.join(reviews, '2026-11-11-batch-1.json'), JSON.stringify({ pages: [{ path: 'reports/reviewed-equity-report.html' }] }));
  await fs.writeFile(path.join(reviews, '2026-11-11-fy2025-freshness-audit.json'), JSON.stringify({ results: [{ file: 'pending-equity-report.html' }] }));
  await fs.writeFile(path.join(reviews, '2026-11-11-company-status.json'), JSON.stringify({ pages: [{ file: 'reports/historical-equity-report.html' }] }));
  assert.deepEqual(await auditCompanyReviewCoverage(root), {
    total: 4, reviewed: 1, pending: 1, historicalStatus: 1, untracked: ['omitted-equity-report.html'],
  });
});
