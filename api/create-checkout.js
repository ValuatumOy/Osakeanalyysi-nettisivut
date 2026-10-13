const Stripe = require('stripe');
const { reportError } = require('../server/email');
const { getCatalogReport, findTestStandIn, isStripeTestMode } = require('../server/catalog-client');
const { CheckoutError, createReadyReportCheckout } = require('../server/checkout');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { reportId, withRevisions } = req.body || {};
  if (!reportId) return res.status(400).json({ error: 'Missing report id' });

  try {
    let report = await getCatalogReport(reportId);
    // Test site only (Stripe test key): a production report id gets the test
    // catalog's newest report for the same company. See findTestStandIn.
    if (!report) {
      report = await findTestStandIn(reportId, { withRevisions: Boolean(withRevisions) });
      if (report) console.log('create-checkout: test stand-in', { requested: reportId, using: report.id });
      else if (isStripeTestMode()) {
        return res.status(404).json({ error: 'This report is not in the test catalog, and test has no report for the same company. Generate one on test first.' });
      }
    }
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await createReadyReportCheckout(stripe, report, { withRevisions });
    res.json({ url: session.url });
  } catch (err) {
    if (err instanceof CheckoutError) return res.status(err.status).json({ error: err.message });
    console.error('create-checkout:', err.message);
    await reportError('vercel create-checkout', err, { reportId: req.body?.reportId });
    res.status(500).json({ error: 'Checkout failed' });
  }
};
