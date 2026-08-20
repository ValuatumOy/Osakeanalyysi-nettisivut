// The prompts published with an analyst's report come from the order's
// revisionHistory — the comments actually sent to the engine — not from the
// client. quota.revisionPrompts is the one place that derivation lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const quota = require('../../server/members/quota.js');

test('revision comments join oldest-first, blanks dropped', () => {
  const order = { revisionHistory: [
    { version: 2, comments: 'Flat 2027 capex, no recovery.' },
    { version: 3, comments: '   ' },
    { version: 4, comments: 'Push mobile margin to 2024 level.' },
  ] };
  assert.equal(quota.revisionPrompts(order),
    'Flat 2027 capex, no recovery.\n\nPush mobile margin to 2024 level.');
});

test('no revisions, no history, no order: empty string', () => {
  assert.equal(quota.revisionPrompts({ revisionHistory: [] }), '');
  assert.equal(quota.revisionPrompts({}), '');
  assert.equal(quota.revisionPrompts(null), '');
});
