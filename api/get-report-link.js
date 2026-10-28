const Stripe = require('stripe');
const { reportError } = require('../server/email');
const { getCatalogReport, getOrderState } = require('../server/catalog-client');
const { isCompletedCheckout, isRevisionsOnly } = require('../server/checkout');

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
    try { await getOrderState(session_id); }
    catch (err) { if (err.status !== 404) throw err; }

    const withRevisions = session.metadata?.withRevisions === 'true';
    const orderUrl = session.metadata?.isFresh === 'true' || withRevisions || session.metadata?.revisable === 'true'
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

    const reportId = session.metadata?.reportId;
    if (!reportId) return res.status(404).json({ error: 'Report not found' });
    const report = await getCatalogReport(reportId) || {
      name: session.metadata?.reportName || 'Report',
      ticker: session.metadata?.ticker || '',
      reportDate: session.metadata?.reportDate || '',
    };

    res.json({
      type: 'existing',
      // Revisions bought on a free report: the page must not present the
      // PDF as the purchase.
      revisionsOnly: isRevisionsOnly(session),
      revisionsAllowed: Number(session.metadata?.revisionsAllowed || 0),
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
    if (err.status === 403) return res.status(403).json({ error: 'Sign in to access this purchase' });
    console.error('get-report-link:', err.message);
    await reportError('vercel get-report-link', err, { sessionId: session_id });
    res.status(500).json({ error: 'Failed' });
  }
};
