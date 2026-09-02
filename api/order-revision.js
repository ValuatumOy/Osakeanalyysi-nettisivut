// Submit a forecast-revision request for an order that carries revisions.
//
// Same trust model as report-download.js / order-status.js: the Stripe
// checkout session id is the bearer. This is the one mutating order-page
// call — everything else the customer sees is read-only progress.
//
// Buying more rounds lives in this function too rather than its own,
// because the Vercel plan is at its twelve-function ceiling — a thirteenth
// fails at deploy with no build error.

const Stripe = require('stripe');
const { submitOrderRevision } = require('../server/catalog-client');
const { CheckoutError, createExtraRoundsCheckout, isCompletedCheckout, orderPageUrl } = require('../server/checkout');

async function buyRounds(req, res, stripe, sessionId, session) {
  const orderUrl = orderPageUrl(sessionId);
  const { session: created, rounds, priceEur } = await createExtraRoundsCheckout(stripe, {
    orderId: sessionId,
    rounds: req.body?.rounds,
    email: session.customer_details?.email,
    companyLabel: session.metadata?.company || session.metadata?.ticker,
    successUrl: `${orderUrl}&revisions=added`,
    cancelUrl: `${orderUrl}&revisions=cancelled`,
  });
  return res.status(200).json({ url: created.url, rounds, priceEur });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sessionId = req.body?.session_id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

  const wantsRounds = Boolean(req.body?.buyRounds);
  const comments = String(req.body?.comments || '').trim();
  if (!wantsRounds && !comments) return res.status(400).json({ error: 'comments is required' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  res.setHeader('cache-control', 'no-store');

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isCompletedCheckout(session)) {
      return res.status(402).json({ error: 'Payment not completed' });
    }
    if (wantsRounds) return await buyRounds(req, res, stripe, sessionId, session);

    const result = await submitOrderRevision(sessionId, comments);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof CheckoutError) return res.status(err.status).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: 'Order not found' });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('order-revision:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
};
