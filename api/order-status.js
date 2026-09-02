// Order-page state for a customer holding a Stripe checkout session id.
//
// Same trust model as report-download.js: the session id is the bearer
// (long, unguessable, already in the success URL, the receipt email, and —
// for a "+ Revisions" order — the "review your forecasts"/"report updated"
// emails). Verify it with Stripe, then read the order's status from the
// backend. Nothing here is cacheable.

const Stripe = require('stripe');
const { getOrderState } = require('../server/catalog-client');
const { isCompletedCheckout } = require('../server/checkout');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  res.setHeader('cache-control', 'no-store');

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isCompletedCheckout(session)) {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    const order = await getOrderState(sessionId);
    res.status(200).json(order);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Order not found' });
    console.error('order-status:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
};
