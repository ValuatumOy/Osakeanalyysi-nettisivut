import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handler = require('../../api/search-companies.js');

test('company search proxy returns a trimmed Wisdom result', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    assert.match(String(url), /q=Elisa/);
    return {
      ok: true,
      async json() {
        return {
          results: [{
            companyName: 'Elisa',
            ticker: 'ELISA.HE',
            industry: 'Telecommunication Services',
            companyCode: 'not-public',
          }],
        };
      },
    };
  };

  const response = await invoke({ q: 'Elisa' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    query: 'Elisa',
    results: [{
      companyName: 'Elisa',
      ticker: 'ELISA.HE',
      industry: 'Telecommunication Services',
    }],
  });
  assert.equal(response.headers['Cache-Control'], 's-maxage=60, stale-while-revalidate=300');
});

test('company search proxy rejects an empty query', async () => {
  const response = await invoke({ q: '' });
  assert.equal(response.statusCode, 400);
});

async function invoke(query, method = 'GET') {
  const result = { statusCode: 200, body: null, headers: {} };
  const req = { method, query };
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
    setHeader(name, value) {
      result.headers[name] = value;
    },
  };
  await handler(req, res);
  return result;
}
