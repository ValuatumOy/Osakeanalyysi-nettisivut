// Order-page state for a customer holding a Stripe checkout session id.
//
// Same trust model as report-download.js: the session id is the bearer
// (long, unguessable, already in the success URL, the receipt email, and —
// for a "+ Revisions" order — the "review your forecasts"/"report updated"
// emails). Verify it with Stripe, then read the order's status from the
// backend. Nothing here is cacheable.
//
// `?preview=1` returns the rendered report as HTML instead of the order
// state, for the text editor on the order page. It lives on this function
// rather than its own because the Vercel plan is at its twelve-function
// ceiling — a thirteenth fails at deploy with no build error.

const Stripe = require('stripe');
const { reportError } = require('../server/email');
const { getOrderState, getOrderPreview } = require('../server/catalog-client');
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

    if (req.query.preview) {
      const { html } = await getOrderPreview(sessionId);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }

    const order = await getOrderState(sessionId);
    res.status(200).json(order);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Order not found' });
    if (err.status === 409 || err.status === 502) return res.status(err.status).json({ error: err.message });
    console.error('order-status:', err.message);
    await reportError('vercel order-status', err, { sessionId, preview: Boolean(req.query.preview) });
    res.status(500).json({ error: 'Failed' });
  }
};
