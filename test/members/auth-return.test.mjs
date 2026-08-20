import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.MEMBERS_JWT_SECRET = 'test-secret';
process.env.LINKEDIN_CLIENT_ID = 'test-client-id';
process.env.MEMBERS_API_URL = 'https://members-test.aiequityreports.com';
process.env.MEMBERS_FRONTEND_URLS = [
  'https://test.aiequityreports.com/members.html',
  'https://www.aiequityreports.com/members.html',
].join(',');

const auth = require('../../server/members/auth.js');

test('the LinkedIn start URL carries the requested return target in its state', () => {
  const url = new URL(auth.linkedinStartUrl('https://www.aiequityreports.com/members.html'));
  assert.ok(url.searchParams.get('state').includes('https://www.aiequityreports.com/members.html'));
});

test('an off-allowlist return target falls back to the default (no open redirect)', () => {
  assert.equal(auth.frontendUrl('https://evil.example.com/steal'), 'https://test.aiequityreports.com/members.html');
  assert.equal(auth.frontendUrl(''), 'https://test.aiequityreports.com/members.html');
  assert.equal(auth.frontendUrl(undefined), 'https://test.aiequityreports.com/members.html');
});

test('an allowlisted return target is preserved', () => {
  assert.equal(
    auth.frontendUrl('https://www.aiequityreports.com/members.html'),
    'https://www.aiequityreports.com/members.html',
  );
});

// The prod incident this pins: the fallback is the FIRST allowlist entry, so
// the stack must put this stage's own site first — a prod checkout or failed
// sign-in must never land on the test domain, and the store page must be an
// accepted return target for the anonymous buy flow.
test('the stage default comes first and the store page is a valid return target', () => {
  const urls = process.env.MEMBERS_FRONTEND_URLS.split(',');
  const prodLike = [
    'https://www.aiequityreports.com/members.html',
    'https://www.aiequityreports.com/report-store.html',
    ...urls,
  ];
  process.env.MEMBERS_FRONTEND_URLS = prodLike.join(',');
  try {
    assert.equal(auth.frontendUrl('nonsense'), 'https://www.aiequityreports.com/members.html');
    assert.equal(
      auth.frontendUrl('https://www.aiequityreports.com/report-store.html'),
      'https://www.aiequityreports.com/report-store.html');
  } finally {
    process.env.MEMBERS_FRONTEND_URLS = urls.join(',');
  }
});
