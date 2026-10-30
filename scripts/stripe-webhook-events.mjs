export async function ensureWebhookEvents(stripe, hook, required) {
  const current = hook.enabled_events;
  if (!Array.isArray(current)) throw new Error('Existing webhook event subscriptions are unavailable');
  if (current.includes('*')) return hook;
  const enabled_events = [...new Set([...current, ...required])];
  if (enabled_events.length === current.length) return hook;
  return stripe.webhookEndpoints.update(hook.id, { enabled_events });
}
