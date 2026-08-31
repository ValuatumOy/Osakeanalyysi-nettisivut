// Buying an analyst analysis from a company report page returned the buyer to
// members.html — the only page in the allowlist — which had no handler for the
// purchase parameters. Money taken, nothing delivered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

process.env.MEMBERS_FRONTEND_URLS = [
  'https://www.aiequityreports.com/members.html',
  'https://www.aiequityreports.com/report-store.html',
].join(',');

const auth = require('../../server/members/auth.js');

test('a report page on our own origin is returned to, not replaced', () => {
  assert.equal(
    auth.frontendUrl('https://www.aiequityreports.com/reports/tesla-equity-report.html'),
    'https://www.aiequityreports.com/reports/tesla-equity-report.html',
  );
});

test('an exact allowlisted page still works', () => {
  assert.equal(
    auth.frontendUrl('https://www.aiequityreports.com/members.html'),
    'https://www.aiequityreports.com/members.html',
  );
});

test('the parameters of an earlier round trip are dropped, never stacked', () => {
  assert.equal(
    auth.frontendUrl('https://www.aiequityreports.com/members.html?bought=g1&session_id=cs_1#x'),
    'https://www.aiequityreports.com/members.html',
  );
});

test('another origin falls back — this must never be an open redirect', () => {
  for (const hostile of [
    'https://evil.example.com/steal.html',
    'javascript:alert(1)',
    'not a url',
    '',
  ]) {
    assert.equal(auth.frontendUrl(hostile), 'https://www.aiequityreports.com/members.html', hostile);
  }
});

test('the buyer is emailed as soon as Stripe confirms, not when they come back', () => {
  const src = readFileSync(new URL('../../server/lambda/members.js', import.meta.url), 'utf8');
  const branch = src.slice(src.indexOf("if (object.metadata?.analysisGenId)"));
  assert.match(branch.slice(0, 400), /sendAnalysisReceipt\(object\)/);
  // A link that outlives a presigned URL: the session id is re-verified per visit.
  assert.match(src, /session_id=\$\{encodeURIComponent\(session\.id\)\}/);
});

test('members.html hands over a purchase without requiring a login', () => {
  const html = readFileSync(new URL('../../members.html', import.meta.url), 'utf8');
  assert.match(html, /collectPurchase\(\);\n    if \(token\(\)\) loadMe\(\);/);
  assert.match(html, /params\.get\('bought'\)/);
  assert.match(html, /params\.get\('forked'\)/);
});
