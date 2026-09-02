const Stripe = require('stripe');
const { CheckoutError, createFreshReportCheckout } = require('../server/checkout');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { company, ticker, exchange, email, purpose, source, withRevisions, returnTo } = req.body || {};

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await createFreshReportCheckout(stripe, {
      company, ticker, exchange, email, purpose, source, withRevisions, returnTo,
    });
    res.json({ url: session.url });
  } catch (err) {
    if (err instanceof CheckoutError) return res.status(err.status).json({ error: err.message });
    console.error('create-fresh-checkout:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
};
