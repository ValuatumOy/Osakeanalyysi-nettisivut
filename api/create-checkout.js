const Stripe = require('stripe');
const { getCatalogReport } = require('../server/catalog-client');
const { CheckoutError, createReadyReportCheckout } = require('../server/checkout');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { reportId, withRevisions } = req.body || {};
  if (!reportId) return res.status(400).json({ error: 'Missing report id' });

  try {
    const report = await getCatalogReport(reportId);
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await createReadyReportCheckout(stripe, report, { withRevisions });
    res.json({ url: session.url });
  } catch (err) {
    if (err instanceof CheckoutError) return res.status(err.status).json({ error: err.message });
    console.error('create-checkout:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
};
