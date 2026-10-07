import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const claims = [];
const publication = { status: 'private' };
function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
delete process.env.WORKER_FUNCTION_NAME;
delete process.env.SECRETS_SSM_PREFIX;
stub('../../server/members/auth.js', {
  requireUser: async () => ({ profile: { userId: 'u1' }, deny: null }),
});
stub('../../server/members/store.js', {
  getPublication: async () => publication,
  audit: async () => {},
});
stub('../../server/aws/orders-store.js', {
  get: async () => ({ status: 'DELIVERED', revisionsAllowed: 2, revisionsUsed: 0 }),
  claimRevision: async (...args) => { claims.push(args); return { status: 'REVISING' }; },
});
const { handler } = require('../../server/lambda/members.js');
const request = body => handler({
  routeKey: 'POST /generations/{genId}/revisions', pathParameters: { genId: 'g1' },
  headers: { authorization: 'Bearer stub' }, body: JSON.stringify(body),
});

test('members scope is validated, carried to the claim, and locked overrides force narrative', async () => {
  for (const scope of ['edit', 'narrative', '', null, 42, {}]) {
    claims.length = 0;
    assert.equal((await request({ comments: 'Revise', scope })).statusCode, 400);
    assert.equal(claims.length, 0);
  }
  for (const scope of ['content', 'estimates', undefined]) {
    claims.length = 0;
    assert.equal((await request({ comments: 'Revise', scope })).statusCode, 200);
    assert.deepEqual(claims[0], ['g1', 'Revise', null, scope || 'estimates']);
  }
  const valuationOverrides = { auto: { selectedMultiple: 12 } };
  for (const scope of ['content', 'estimates', 'narrative', undefined]) {
    claims.length = 0;
    assert.equal((await request({ comments: 'Use my assumptions', scope, valuationOverrides })).statusCode, 200);
    assert.deepEqual(claims[0], ['g1', 'Use my assumptions', valuationOverrides, 'narrative']);
  }
});

test('published member reports cannot take a scoped revision', async () => {
  publication.status = 'published';
  claims.length = 0;
  assert.equal((await request({ comments: 'Revise', scope: 'content' })).statusCode, 409);
  assert.equal(claims.length, 0);
  publication.status = 'private';
});

test('the order form routes both scopes through member and shop requests', async () => {
  const source = fs.readFileSync(new URL('../../js/order-page.js', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('  function postRevision('), source.indexOf('  // The target-price workbench'));
  const html = fs.readFileSync(new URL('../../order/index.html', import.meta.url), 'utf8');
  assert.match(html, /<label for="revisionScope">/);
  assert.match(html, /value="estimates" selected/);
  assert.match(html, /value="content"/);
  assert.match(source, /postRevision\(comments, null, document.getElementById\('revisionScope'\).value\)/);
  for (const member of [true, false]) {
    const requests = [];
    const context = vm.createContext({
      isMemberRun: () => member, sessionId: 'g1', MEMBERS_API: 'https://members-test.example',
      memberToken: () => 'stub', fetch: (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); },
    });
    vm.runInContext(functionSource, context);
    for (const scope of ['content', 'estimates']) {
      context.postRevision('Revise', null, scope);
      assert.equal(requests.at(-1).body.scope, scope);
      assert.equal(requests.at(-1).url, member ? 'https://members-test.example/generations/g1/revisions' : '/api/order-revision');
    }
    context.postRevision('Use my assumptions', { auto: { selectedMultiple: 12 } }, 'content');
    assert.equal(requests.at(-1).body.scope, 'narrative');
  }
});
