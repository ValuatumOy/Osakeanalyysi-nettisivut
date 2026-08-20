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
