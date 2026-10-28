// Gated download for a purchased report.
//
// The public catalog no longer carries pdfUrl for paid reports, so this is the
// buyer's way in: the Stripe checkout session id is the bearer token (long,
// unguessable, and already in the success URL and the receipt email). Verify it
// with Stripe, then redirect to a short-lived signed S3 URL minted by the
// backend. Nothing here is cacheable.

const Stripe = require('stripe');
const { reportError } = require('../server/email');
const { requestReportDownload, getOrderState } = require('../server/catalog-client');
const { isCompletedCheckout } = require('../server/checkout');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isCompletedCheckout(session)) {
      return res.status(402).json({ error: 'Payment not completed' });
    }
    try { await getOrderState(sessionId); }
    catch (err) { if (err.status !== 404) throw err; }

    // A fresh order has no report until the reconciler delivers it; the buyer
    // gets that one by email.
    const reportId = session.metadata?.reportId;
    if (!reportId) {
      return res.status(409).json({ error: 'This purchase has no downloadable report yet' });
    }

    const { url } = await requestReportDownload(reportId);
    res.setHeader('cache-control', 'no-store');
    res.redirect(302, url);
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: 'Sign in to access this purchase' });
    if (err.status === 404) return res.status(404).json({ error: 'Report not found' });
    console.error('report-download:', err.message);
    await reportError('vercel report-download', err, { sessionId });
    res.status(500).json({ error: 'Failed' });
  }
};
