import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// A fork or an admin copy starts DELIVERED, so the reconciler that stamps
// marketFirst and hasPreview on a delivery never sees it. The copy has to carry
// them from its parent, or a copy of a market-first report offers the scope
// choice and the hand editor (editableNow) until its first revision lands.
const require = createRequire(import.meta.url);
const clientsId = require.resolve('../../server/aws/clients.js');
const sent = [];
require.cache[clientsId] = {
  id: clientsId, filename: clientsId, loaded: true,
  exports: { dynamo: () => ({ send: async (command) => { sent.push(command.input); return {}; } }) },
};
process.env.ORDERS_TABLE = 'stub-orders';
const orders = require('../../server/aws/orders-store.js');
const editing = require('../../server/order-editing.js');

test('the Dynamo order row keeps marketFirst and hasPreview given at creation', async () => {
  const order = await orders.create({
    id: 'fork-mf', ticker: 'KNEBV', status: 'DELIVERED', jobId: 'job-mf', forkedFrom: 'parent', marketFirst: true, hasPreview: true,
  });
  assert.equal(sent.at(-1).Item.marketFirst, true);
  assert.equal(sent.at(-1).Item.hasPreview, true);
  assert.equal(editing.editableNow({ ...order, id: order.orderId }), false, 'a market-first copy is not hand-editable');
});

test('an ordinary order is stored without either field, as before', async () => {
  await orders.create({ id: 'plain', ticker: 'NOKIA.HE' });
  assert.equal(sent.at(-1).Item.marketFirst, undefined);
  assert.equal(sent.at(-1).Item.hasPreview, undefined);
});

test('a hasPreview of false survives, so a copy without the editable HTML stays uneditable', async () => {
  await orders.create({ id: 'no-preview', ticker: 'TSLA', hasPreview: false });
  assert.equal(sent.at(-1).Item.hasPreview, false);
});

test('the fork the webhook builds passes the parent\'s marketFirst and hasPreview', () => {
  const src = fs.readFileSync(new URL('../../server/lambda/members.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function createForkOrder'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /marketFirst: Boolean\(parent\.marketFirst\)/);
  assert.match(body, /hasPreview: parent\.hasPreview/);
});
