import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const clientsId = require.resolve('../../server/aws/clients.js');
let current;
let sent;
require.cache[clientsId] = {
  id: clientsId, filename: clientsId, loaded: true,
  exports: {
    dynamo: () => ({ send: async command => {
      sent = command;
      return { Item: command.input.ConsistentRead ? current : {
        orderId: 'g1', status: 'DELIVERED', pdfFileName: 'original.pdf',
      } };
    } }),
  },
};
process.env.ORDERS_TABLE = 'stub-orders';
const orders = require('../../server/aws/orders-store.js');

test('order-state reads use the primary key and see an acknowledged revision instead of stale delivery', async () => {
  current = { orderId: 'g1', status: 'REVISING', pdfFileName: 'original.pdf' };
  const order = await orders.get('g1');
  assert.ok(sent instanceof GetCommand);
  assert.deepEqual(sent.input, { TableName: 'stub-orders', Key: { orderId: 'g1' }, ConsistentRead: true });
  assert.equal(order.id, 'g1');
  assert.equal(order.status, 'REVISING');
});

test('the latest failed-revision outcome includes the error and previous PDF', async () => {
  current = {
    orderId: 'g1', status: 'DELIVERED', pdfFileName: 'original.pdf',
    revisionError: 'Required bridge checks failed',
  };
  assert.deepEqual(await orders.get('g1'), {
    id: 'g1', status: 'DELIVERED', pdfFileName: 'original.pdf',
    revisionError: 'Required bridge checks failed',
  });
});

test('missing orders still return null', async () => {
  current = undefined;
  assert.equal(await orders.get('missing'), null);
});
