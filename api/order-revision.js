// Submit a forecast-revision request for a "+ Revisions" order.
//
// Same trust model as report-download.js / order-status.js: the Stripe
// checkout session id is the bearer. This is the one mutating order-page
// call — everything else the customer sees is read-only progress.

const Stripe = require('stripe');
const { submitOrderRevision, submitOrderEdit } = require('../server/catalog-client');

// What one more round of steering costs. Same variable the members Lambda
// prices its own top-up with, so the two doors never quote different numbers.
const EXTRA_REVISION_EUR = Number(process.env.EXTRA_REVISION_EUR || '') || 5;

function isCompletedCheckout(session) {
  return session.payment_status === 'paid' || Number(session.amount_total || 0) === 0;
}

// Buying more rounds on an order somebody already has.
//
// It lives in this function rather than its own because the Vercel plan is at
// its twelve-function ceiling — a thirteenth fails at deploy with no build
// error. Same trust model either way: the checkout session id is the bearer.
//
// Nothing is credited here. The metadata is what the members webhook reads
// (addRevisionRounds), and Stripe delivers every completed checkout in the
// account to that endpoint, so an abandoned return trip cannot lose rounds that
// were paid for.
async function buyRounds(req, res, sessionId, session) {
  const rounds = Math.min(10, Math.max(1, Math.round(Number(req.body?.rounds) || 1)));
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const site = (process.env.SITE_URL || 'https://www.aiequityreports.com').replace(/\/$/, '');
  const orderUrl = `${site}/order/index.html?session_id=${encodeURIComponent(sessionId)}`;
  const company = session.metadata?.company || session.metadata?.ticker || 'your report';

  const created = await stripe.checkout.sessions.create({
    mode: 'payment',
    allow_promotion_codes: true,
    ...(session.customer_details?.email ? { customer_email: session.customer_details.email } : {}),
    line_items: [{
      quantity: rounds,
      price_data: {
        currency: 'eur',
        unit_amount: Math.round(EXTRA_REVISION_EUR * 100),
        product_data: {
          name: `Extra revision round — ${company}`,
          description: 'One more round of steering on a report you already have.',
        },
      },
    }],
    metadata: { extraRevisions: String(rounds), generationId: sessionId },
    success_url: `${orderUrl}&revisions=added`,
    cancel_url: `${orderUrl}&revisions=cancelled`,
  });
  return res.status(200).json({ url: created.url, rounds, priceEur: rounds * EXTRA_REVISION_EUR });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sessionId = req.body?.session_id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

  const wantsRounds = Boolean(req.body?.buyRounds);
  // Hand edits to the report text travel through this function too (the
  // twelve-function ceiling again): `{ edits, originals?, editedBy? }`. The
  // backend validates the edits; only the session is verified here.
  const edits = req.body?.edits && typeof req.body.edits === 'object' ? req.body.edits : null;
  const comments = String(req.body?.comments || '').trim();
  if (!wantsRounds && !edits && !comments) return res.status(400).json({ error: 'comments is required' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  res.setHeader('cache-control', 'no-store');

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isCompletedCheckout(session)) {
      return res.status(402).json({ error: 'Payment not completed' });
    }
    if (wantsRounds) return await buyRounds(req, res, sessionId, session);
    if (edits) {
      const result = await submitOrderEdit(sessionId, {
        edits,
        originals: req.body.originals && typeof req.body.originals === 'object' ? req.body.originals : undefined,
        editedBy: typeof req.body.editedBy === 'string' ? req.body.editedBy : undefined,
      });
      return res.status(200).json(result);
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
