import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const clientsId = require.resolve('../../server/aws/clients.js');
const sent = [];
require.cache[clientsId] = {
  id: clientsId, filename: clientsId, loaded: true,
  exports: { dynamo: () => ({ send: async command => { sent.push(command.input); return { Attributes: { orderId: 'g1' } }; } }) },
};
process.env.ORDERS_TABLE = 'stub-orders';
const orders = require('../../server/aws/orders-store.js');

test('Dynamo revision claim persists the scope atomically with the comment', async () => {
  for (const scope of ['content', 'estimates', undefined]) {
    await orders.claimRevision('g1', 'Revise', null, scope);
    const input = sent.at(-1);
    assert.match(input.UpdateExpression, /pendingRevisionScope = :scope/);
    assert.equal(input.ExpressionAttributeValues[':scope'], scope || 'estimates');
    assert.equal(input.ExpressionAttributeValues[':comment'], 'Revise');
    assert.equal(input.ConditionExpression, '#s = :delivered AND revisionsUsed < revisionsAllowed');
  }
  const overrides = { auto: { selectedMultiple: 12 } };
  await orders.claimRevision('g1', 'Use my assumptions', overrides, 'content');
  assert.equal(sent.at(-1).ExpressionAttributeValues[':scope'], 'narrative');
  assert.deepEqual(sent.at(-1).ExpressionAttributeValues[':overrides'], overrides);
});
