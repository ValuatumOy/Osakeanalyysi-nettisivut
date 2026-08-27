// A reviewer grades what the analyst added on top of the engine, and the revision
// prompts ARE that addition — so opening someone else's analysis must hand them
// over with the document, not leave them admin-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

const PROMPTS = 'Flat 2027 capex, no recovery.\n\nPush mobile margin to 2024 level.';

stub('../../server/aws/catalog-aws.js', {});
stub('../../server/search.js', { searchCompanies: async () => [] });
stub('../../server/members/bounty.js', {});
stub('../../server/members/auth.js', {
  requireUser: async () => ({ profile: { userId: 'reviewer', role: 'analyst' }, deny: null }),
});
stub('../../server/aws/orders-store.js', {
  get: async () => ({ status: 'DELIVERED', pdfFileName: null, jobId: 'job-1' }),
  update: async () => {},
});
stub('../../server/members/store.js', {
  table: () => 'stub',
  findPublicationIndex: async () => ({
    genId: 'g1', userId: 'author', status: 'published', companyId: 'NOKIA.HE',
    publishedAt: '2026-08-20T00:00:00.000Z', priceEur: 5,
  }),
  getPublication: async (userId, genId) =>
    (userId === 'author' && genId === 'g1' ? { promptsText: PROMPTS } : null),
  listUserItems: async () => [],
  runTransact: async () => true,
  getProfile: async () => ({ userId: 'reviewer' }),
  getItem: async () => null,
  audit: async () => {},
});

const { handler } = require('../../server/lambda/members.js');

test('opening another analyst\'s analysis returns the revision prompts', async () => {
  const res = await handler({
    routeKey: 'POST /analyses/{genId}/open',
    pathParameters: { genId: 'g1' },
    headers: { authorization: 'Bearer stub' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).promptsText, PROMPTS);
});

test('the review panel renders the prompts as text, never as markup', () => {
  const html = readFileSync(new URL('../../members.html', import.meta.url), 'utf8');
  assert.match(html, /reviewPromptsText'\)\.textContent = prompts/);
});
