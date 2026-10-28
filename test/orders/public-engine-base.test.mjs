import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rows = new Map();
const reads = [];
const clientsId = require.resolve('../../server/aws/clients.js');
require.cache[clientsId] = {
  id: clientsId, filename: clientsId, loaded: true,
  exports: { dynamo: () => ({ send: async command => {
    const input = command.input;
    if (input.Item) {
      assert.equal(input.ConditionExpression, 'attribute_not_exists(orderId)');
      if (rows.has(input.Item.orderId)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      rows.set(input.Item.orderId, structuredClone(input.Item));
      return {};
    }
    reads.push(input);
    return { Item: structuredClone(rows.get(input.Key.orderId)) };
  } }) },
};
process.env.ORDERS_TABLE = 'Orders';
const dynamo = require('../../server/aws/orders-store.js');
const local = require('../../server/orders.js');

for (const storage of ['local', 'dynamo']) {
  test(`${storage}: fresh eligibility is durable and duplicate creation cannot change it`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-orders-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const create = input => storage === 'local' ? local.create(input, path.join(dir, 'orders.json')) : dynamo.create(input);
    for (const [index, eligible] of [true, false, undefined, 'true'].entries()) {
      const id = `${storage}-${index}`;
      const order = await create({ id, publicEngineBase: eligible, ticker: 'NOKIA.HE' });
      assert.equal(order.publicEngineBase, eligible === true);
      const retry = await create({ id, publicEngineBase: eligible !== true });
      assert.equal(retry.publicEngineBase, eligible === true);
    }
    if (storage === 'dynamo') assert.ok(reads.every(read => read.ConsistentRead === true));
  });

  test(`${storage}: ready reports and copies cannot inherit public baseline eligibility`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-copies-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = { publicEngineBase: true, ticker: 'NOKIA.HE' };
    const copies = [
      { origin: 'ready' }, { forkedFrom: 'parent' }, { adminCopy: true },
      { jobId: 'existing-job' }, { reportId: 'existing-report' },
    ];
    for (const [index, copy] of copies.entries()) {
      const input = { ...source, ...copy, id: `${storage}-copy-${index}` };
      const order = storage === 'local' ? local.create(input, path.join(dir, 'orders.json')) : await dynamo.create(input);
      assert.equal(order.publicEngineBase, false);
    }
  });
}
