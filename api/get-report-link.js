const Stripe = require('stripe');
const { getCatalogReport } = require('../server/catalog-client');
const { isCompletedCheckout } = require('../server/checkout');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!isCompletedCheckout(session)) {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    const withRevisions = session.metadata?.withRevisions === 'true';
    const orderUrl = withRevisions
      ? `/order/index.html?session_id=${encodeURIComponent(session_id)}`
      : null;

    if (session.metadata?.isFresh === 'true') {
      return res.json({
        type: 'fresh',
        company: session.metadata.company,
        email: session.customer_details?.email,
        orderUrl,
      });
    }

    const report = await getCatalogReport(session.metadata?.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    res.json({
      type: 'existing',
      reportName: report.name,
      ticker: report.ticker,
      reportDate: report.reportDate,
      // Paid reports have no public URL; the buyer downloads through the gated
      // endpoint, which re-verifies this session every time.
      downloadUrl: `/api/report-download?session_id=${encodeURIComponent(session_id)}`,
      email: session.customer_details?.email,
      orderUrl,
    });
  } catch (err) {
    console.error('get-report-link:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
};
