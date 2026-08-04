import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handler = require('../../api/request-coverage.js');

test('coverage endpoint rejects missing and invalid requester data', async () => {
  const missing = await invoke({ company: '', email: '' });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.error, 'Company name is required');

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
