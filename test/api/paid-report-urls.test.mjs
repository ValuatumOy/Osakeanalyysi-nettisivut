// The public catalog must not hand out a permanent PDF link for a paid report:
// that turned the €20 paywall into a suggestion, since anyone could read
// /api/reports and download every report in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { publicReportPayload } = require('../../server/lambda/api.js');

const report = {
  id: 'amd-05062026',
  companyName: 'Advanced Micro Devices, Inc.',
  ticker: 'AMD',
  fileName: 'AMD_05062026.pdf',
  pdfUrl: 'https://files.aiequityreports.com/reports/pdfs/AMD_05062026.pdf',
  price: 20,
};

test('a paid report is published without its PDF URL', () => {
  const payload = publicReportPayload({ ...report, isFree: false });
  assert.equal(payload.pdfUrl, undefined);
  assert.equal(payload.fileName, 'AMD_05062026.pdf', 'the rest of the payload is unchanged');
  assert.equal(payload.price, 20);
});

test('a free report keeps its direct PDF URL', () => {
  const payload = publicReportPayload({ ...report, isFree: true, price: 0 });
  assert.equal(payload.pdfUrl, report.pdfUrl);
});

test('the payload survives a missing report', () => {
  assert.equal(publicReportPayload(null), null);
});
