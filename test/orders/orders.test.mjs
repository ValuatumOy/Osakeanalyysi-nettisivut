import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const orders = require('../../server/orders.js');

function isolate(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-test-'));
  const statePath = path.join(dir, 'orders.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return statePath;
}

test('create() defaults to a fresh, standard order with no revisions', (t) => {
  const statePath = isolate(t);
  const order = orders.create({ id: 'cs_1', ticker: 'NOKIA.HE' }, statePath);
  assert.equal(order.status, orders.STATUS.NEW);
  assert.equal(order.origin, 'fresh');
  assert.equal(order.jobId, null);
  assert.equal(order.pdfFileName, null);
  assert.equal(order.revisionsAllowed, 0);
  assert.equal(order.revisionsUsed, 0);
  assert.equal(order.revisionJobId, null);
});

test('create() seeds a ready+revisions order directly at DELIVERED', (t) => {
  const statePath = isolate(t);
  const order = orders.create({
    id: 'cs_2',
    origin: 'ready',
    reportId: 'nokia-01012026',
    status: orders.STATUS.DELIVERED,
    jobId: 'job_base',
    pdfFileName: 'Nokia_01012026.pdf',
    revisionsAllowed: 3,
  }, statePath);
  assert.equal(order.status, orders.STATUS.DELIVERED);
  assert.equal(order.origin, 'ready');
  assert.equal(order.reportId, 'nokia-01012026');
  assert.equal(order.jobId, 'job_base');
  assert.equal(order.pdfFileName, 'Nokia_01012026.pdf');
  assert.equal(order.revisionsAllowed, 3);
  assert.equal(order.revisionsUsed, 0);
});

test('create() is idempotent on id', (t) => {
  const statePath = isolate(t);
  const first = orders.create({ id: 'cs_3', ticker: 'ABB.ST' }, statePath);
  const second = orders.create({ id: 'cs_3', ticker: 'DIFFERENT' }, statePath);
  assert.equal(second.ticker, first.ticker);
  assert.equal(orders.list(statePath).length, 1);
});

test('claimRevision succeeds from DELIVERED with revisions left, and claims REVISING', (t) => {
  const statePath = isolate(t);
  orders.create({
    id: 'cs_4', status: orders.STATUS.DELIVERED, jobId: 'job_1',
    pdfFileName: 'a.pdf', revisionsAllowed: 2,
  }, statePath);

  const claimed = orders.claimRevision('cs_4', 'raise 2027 margin', statePath);
  assert.ok(claimed);
  assert.equal(claimed.status, orders.STATUS.REVISING);
  assert.equal(claimed.pendingRevisionComment, 'raise 2027 margin');
  assert.equal(claimed.revisionAttempts, 0);
});

test('claimRevision refuses a second concurrent claim (double-submit)', (t) => {
  const statePath = isolate(t);
  orders.create({
    id: 'cs_5', status: orders.STATUS.DELIVERED, jobId: 'job_1',
    pdfFileName: 'a.pdf', revisionsAllowed: 2,
  }, statePath);

  const first = orders.claimRevision('cs_5', 'comment one', statePath);
  assert.ok(first); // now REVISING
  const second = orders.claimRevision('cs_5', 'comment two', statePath);
  assert.equal(second, null);
});

test('claimRevision refuses once the allowance is exhausted', (t) => {
  const statePath = isolate(t);
  orders.create({
    id: 'cs_6', status: orders.STATUS.DELIVERED, jobId: 'job_1',
    pdfFileName: 'a.pdf', revisionsAllowed: 1,
  }, statePath);
  orders.update('cs_6', { revisionsUsed: 1 }, statePath);

  const claimed = orders.claimRevision('cs_6', 'one more please', statePath);
  assert.equal(claimed, null);
});

test('claimRevision refuses on an order with no revisions purchased', (t) => {
  const statePath = isolate(t);
  orders.create({
    id: 'cs_7', status: orders.STATUS.DELIVERED, jobId: 'job_1', pdfFileName: 'a.pdf',
  }, statePath); // revisionsAllowed defaults to 0

  const claimed = orders.claimRevision('cs_7', 'please change this', statePath);
  assert.equal(claimed, null);
});

test('REVISING is a pending status the worker sweep picks up', (t) => {
  const statePath = isolate(t);
  orders.create({
    id: 'cs_8', status: orders.STATUS.DELIVERED, jobId: 'job_1',
    pdfFileName: 'a.pdf', revisionsAllowed: 1,
  }, statePath);
  orders.claimRevision('cs_8', 'go', statePath);

  const pending = orders.listPending(statePath);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'cs_8');
});
