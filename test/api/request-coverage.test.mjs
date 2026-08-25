import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Stub the send before the handler resolves it, so no test reaches SES.
const email = require('../../server/email.js');
const sent = [];
email.sendCoverageRequest = async (meta) => { sent.push(meta); };

const handler = require('../../api/request-coverage.js');

test('coverage endpoint rejects missing and invalid requester data', async () => {
  const missing = await invoke({ company: '', email: '' });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.error, 'At least one company is required');

  const invalidEmail = await invoke({ company: 'Example Oyj', email: 'invalid' });
  assert.equal(invalidEmail.statusCode, 400);
  assert.equal(invalidEmail.body.error, 'A valid email is required');
});

test('coverage endpoint silently accepts honeypot submissions', async () => {
  const response = await invoke({ website: 'https://spam.example', company: 'Spam', email: 'spam@example.com' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
});

async function invoke(body, method = 'POST') {
  const result = { statusCode: 200, body: null };
  const req = { method, body };
  const res = {
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(value) {
      result.body = value;
      return this;
    },
    end() {
      return this;
    },
    setHeader() {},
  };
  await handler(req, res);
  return result;
}

test('coverage endpoint takes a whole list in one request', async () => {
  const response = await invoke({
    companies: ['Nokia, NOKIA.HE', 'Novo Nordisk, NOVO-B.CO', 'Apple, AAPL'],
    email: 'desk@example.com',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(sent.at(-1).companies, ['Nokia, NOKIA.HE', 'Novo Nordisk, NOVO-B.CO', 'Apple, AAPL']);
});

test('coverage endpoint accepts a newline-separated list and drops blank lines', async () => {
  const response = await invoke({ companies: 'Nokia\n\n  Kesko, KESKOB.HE  \n', email: 'desk@example.com' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(sent.at(-1).companies, ['Nokia', 'Kesko, KESKOB.HE']);
});

test('coverage endpoint caps a list at 200 companies', async () => {
  const tooMany = Array.from({ length: 201 }, (_, i) => `Company ${i}`);
  const response = await invoke({ companies: tooMany, email: 'desk@example.com' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'Please send at most 200 companies per request');

  const atLimit = await invoke({ companies: tooMany.slice(0, 200), email: 'desk@example.com' });
  assert.equal(atLimit.statusCode, 200);
});

test('coverage endpoint still accepts the old single-company shape', async () => {
  const response = await invoke({ company: 'Nokia', ticker: 'NOKIA.HE', email: 'desk@example.com' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(sent.at(-1).companies, ['Nokia, NOKIA.HE']);
});
