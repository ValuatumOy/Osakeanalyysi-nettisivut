// Submit a forecast-revision request for a "+ Revisions" order.
//
// Same trust model as report-download.js / order-status.js: the Stripe
// checkout session id is the bearer. This is the one mutating order-page
// call — everything else the customer sees is read-only progress.

const Stripe = require('stripe');
const { submitOrderRevision } = require('../server/catalog-client');

function isCompletedCheckout(session) {
  return session.payment_status === 'paid' || Number(session.amount_total || 0) === 0;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sessionId = req.body?.session_id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

  const comments = String(req.body?.comments || '').trim();
  if (!comments) return res.status(400).json({ error: 'comments is required' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  res.setHeader('cache-control', 'no-store');

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isCompletedCheckout(session)) {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    const result = await submitOrderRevision(sessionId, comments);
    res.status(200).json(result);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Order not found' });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('order-revision:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
};
