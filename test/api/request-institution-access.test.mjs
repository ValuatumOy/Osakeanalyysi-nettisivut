import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Stub the send before the handler resolves it, so no test ever reaches SES.
const email = require('../../server/email.js');
const sent = [];
email.sendInstitutionRequest = async (meta) => { sent.push(meta); };

const handler = require('../../api/request-institution-access.js');

const VALID = {
  organisation: 'Example Asset Management',
  orgWebsite: 'example.com',
  contactName: 'A Person',
  email: 'person@example.com',
  analysesPerYear: '10 to 50',
  analystCount: '3 to 5',
};

test('institution endpoint requires the four facts the pilot is sized from', async () => {
  const cases = [
    [{ ...VALID, organisation: '' }, 'Organisation is required'],
    [{ ...VALID, orgWebsite: '' }, 'Website is required'],
    [{ ...VALID, contactName: '' }, 'Your name is required'],
    [{ ...VALID, email: 'invalid' }, 'A valid work email is required'],
    [{ ...VALID, analysesPerYear: '' }, 'Analyses per year is required'],
    [{ ...VALID, analystCount: '' }, 'Analyst headcount is required'],
  ];
  for (const [body, error] of cases) {
    const response = await invoke(body);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, error);
  }
});

test('institution endpoint silently accepts honeypot submissions', async () => {
  const before = sent.length;
  const response = await invoke({ ...VALID, website: 'https://spam.example' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(sent.length, before, 'honeypot submissions must not be emailed');
});

test('institution endpoint forwards a complete request', async () => {
  const response = await invoke({ ...VALID, notes: 'Nordic small caps' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
  const last = sent.at(-1);
  assert.equal(last.organisation, VALID.organisation);
  assert.equal(last.email, VALID.email);
  assert.equal(last.analystCount, '3 to 5');
  assert.equal(last.notes, 'Nordic small caps');
});

test('institution endpoint rejects non-POST', async () => {
  const response = await invoke(VALID, 'GET');
  assert.equal(response.statusCode, 405);
});

async function invoke(body, method = 'POST') {
  const result = { statusCode: 200, body: null };
  const req = { method, body };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(value) { result.body = value; return this; },
    end() { return this; },
    setHeader() {},
  };
  await handler(req, res);
  return result;
}
