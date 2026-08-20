import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A route the Lambda answers but the stack never registers is a 404 in
// production and nowhere else — the members revision workspace was exactly
// that shape of bug. Keep the two lists in step.
const lambda = readFileSync(new URL('../../server/lambda/members.js', import.meta.url), 'utf8');
const stack = readFileSync(new URL('../../infra/lib/members-stack.ts', import.meta.url), 'utf8');

const lambdaRoutes = [...lambda.matchAll(/^\s*'(GET|POST) (\/[^']*)':/gm)].map(m => `${m[1]} ${m[2]}`);
const stackRoutes = [...stack.matchAll(/HttpMethod\.(GET|POST), '(\/[^']*)'/g)].map(m => `${m[1]} ${m[2]}`);

test('every route the members Lambda handles is registered on the API', () => {
  assert.ok(lambdaRoutes.length > 20, 'route map not found');
  const missing = lambdaRoutes.filter(route => !stackRoutes.includes(route));
  assert.deepEqual(missing, []);
});

test('the revision workspace routes are wired end to end', () => {
  for (const route of ['GET /generations', 'GET /generations/{genId}/order', 'POST /generations/{genId}/revisions']) {
    assert.ok(lambdaRoutes.includes(route), `${route} missing from the Lambda`);
    assert.ok(stackRoutes.includes(route), `${route} missing from the stack`);
  }
});
