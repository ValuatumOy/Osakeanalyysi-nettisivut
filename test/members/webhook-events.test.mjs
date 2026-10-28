import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureWebhookEvents } from '../../scripts/stripe-webhook-events.mjs';

test('existing webhook event subscriptions are preserved when adding delayed payments', async () => {
  const calls = [];
  const stripe = { webhookEndpoints: { update: async (id, params) => { calls.push({ id, ...params }); return params; } } };
  await ensureWebhookEvents(stripe, { id: 'we_1', enabled_events: ['custom.event', 'checkout.session.completed'] },
    ['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
  assert.deepEqual(calls[0].enabled_events, ['custom.event', 'checkout.session.completed', 'checkout.session.async_payment_succeeded']);
});

test('an already subscribed or wildcard endpoint needs no update', async () => {
  const stripe = { webhookEndpoints: { update: async () => { throw new Error('unnecessary update'); } } };
  for (const enabled_events of [['*'], ['checkout.session.async_payment_succeeded']]) {
    const hook = { id: 'we_1', enabled_events };
    assert.equal(await ensureWebhookEvents(stripe, hook, ['checkout.session.async_payment_succeeded']), hook);
  }
  await assert.rejects(() => ensureWebhookEvents(stripe, { id: 'we_1' }, ['checkout.session.async_payment_succeeded']));
});
