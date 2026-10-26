import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const commands = [];
const clients = require.resolve('../../server/aws/clients.js');
require.cache[clients] = {
  id: clients, filename: clients, loaded: true,
  exports: { dynamo: () => ({ send: async command => { commands.push(command.input); return { Item: {} }; } }) },
};
process.env.MEMBERS_TABLE = 'Members';
process.env.ORDERS_TABLE = 'Orders';
const members = require('../../server/members/store.js');
const orders = require('../../server/aws/orders-store.js');

test('gift balance, receipt and recovery reads can request strong consistency without changing default reads', async () => {
  await members.getProfile('u1', true);
  await members.getItem('USER#u1', 'GENERATIONGRANT#request', true);
  await orders.get('g1', true);
  assert.deepEqual(commands, [
    { TableName: 'Members', Key: { pk: 'USER#u1', sk: 'PROFILE' }, ConsistentRead: true },
    { TableName: 'Members', Key: { pk: 'USER#u1', sk: 'GENERATIONGRANT#request' }, ConsistentRead: true },
    { TableName: 'Orders', Key: { orderId: 'g1' }, ConsistentRead: true },
  ]);
  commands.length = 0;
  await members.getProfile('u1');
  await orders.get('g1');
  assert.ok(commands.every(command => command.ConsistentRead === undefined));
});
