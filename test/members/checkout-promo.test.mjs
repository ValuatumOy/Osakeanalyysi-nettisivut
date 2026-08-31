import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The site's other checkouts (api/create-checkout.js, api/create-fresh-checkout.js,
// server/index.js) all accept a promotion code. The members Lambda opened four
// sessions and accepted none, so a discount code — or a 100% code used to test
// a paid flow in production — worked everywhere except on member purchases.
const src = readFileSync(new URL('../../server/lambda/members.js', import.meta.url), 'utf8');

test('every checkout the members Lambda opens accepts a promotion code', () => {
  const starts = [...src.matchAll(/checkout\.sessions\.create\(\{/g)].map((m) => m.index);
  assert.ok(starts.length >= 4, `expected the four member checkouts, found ${starts.length}`);

  const missing = starts.filter((start, i) => {
    const end = starts[i + 1] ?? src.length;
    return !src.slice(start, end).includes('allow_promotion_codes: true');
  });
  assert.deepEqual(missing, [], 'a member checkout that refuses promotion codes');
});
