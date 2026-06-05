const Stripe = require('stripe');
const { REPORT_CATALOG } = require('../server/reports');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    if (session.metadata?.isFresh === 'true') {
      return res.json({
        type:    'fresh',
        company: session.metadata.company,
        email:   session.customer_details?.email,
      });
    }

    const report = REPORT_CATALOG[session.metadata?.reportId];
    if (!report) return res.status(404).json({ error: 'Report not found' });

    res.json({
      type:       'existing',
      reportName: report.name,
      ticker:     report.ticker,
      reportDate: report.reportDate,
      pdfUrl:     report.pdfUrl,
      email:      session.customer_details?.email,
    });
  } catch (err) {
    console.error('get-report-link:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
};
