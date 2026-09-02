const Stripe = require('stripe');
const { reportError } = require('../server/email');
const { getPublicPricing } = require('../server/stripe-pricing');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json(await getPublicPricing(stripe, { bypassCache: true }));
  } catch (err) {
    console.error('pricing:', err.message);
    await reportError('vercel pricing', err);
    res.status(500).json({ error: 'Could not load pricing' });
  }
};
