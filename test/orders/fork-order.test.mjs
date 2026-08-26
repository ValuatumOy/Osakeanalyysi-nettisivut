import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const orders = require('../../server/orders.js');

function isolate(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'orders.json');
}

// The reconciler writes an existing pdfFileName in place, and a reader of a
// published analysis resolves its PDF live from the order behind it. A fork
// that shared the parent's key would therefore replace the published report
// under everyone reading it, on the forker's first revision.
test('a fork starts with no PDF of its own, whatever the parent had', (t) => {
  const statePath = isolate(t);
  const parent = orders.create({ id: 'parent', ticker: 'TSLA', pdfFileName: 'Tesla_25082026.pdf' }, statePath);
  const fork = orders.create({ id: 'fork', ticker: 'TSLA', forkedFrom: 'parent', jobId: 'job-parent' }, statePath);

  assert.equal(fork.forkedFrom, 'parent');
  assert.equal(fork.pdfFileName, null);
  assert.notEqual(fork.pdfFileName, parent.pdfFileName);
  // The parent is the base to revise from, so the job id is shared on purpose.
  assert.equal(fork.jobId, 'job-parent');
});

test('an ordinary order carries no fork lineage', (t) => {
  const statePath = isolate(t);
  const order = orders.create({ id: 'plain', ticker: 'NOKIA.HE' }, statePath);
  assert.equal(order.forkedFrom, null);
});

test('the fork order the webhook builds never passes a pdfFileName', () => {
  const src = fs.readFileSync(new URL('../../server/lambda/members.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function createForkOrder'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/pdfFileName/.test(body), 'createForkOrder must never set pdfFileName');
  assert.match(body, /jobId: parent\.jobId/);
});
