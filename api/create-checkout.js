const Stripe = require('stripe');
const { getCatalogReport } = require('../server/catalog-client');
const { getStripePricing } = require('../server/stripe-pricing');

// How many forecast-revision requests the "+ Revisions" tier includes.
const REPORT_REVISIONS_INCLUDED = Number.parseInt(process.env.REPORT_REVISIONS_INCLUDED || '', 10) || 3;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { reportId, withRevisions } = req.body;
  if (!reportId) return res.status(400).json({ error: 'Missing report id' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const revisions = Boolean(withRevisions);

  try {
    const report = await getCatalogReport(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.isFree || report.price <= 0) {
      return res.status(400).json({ error: 'Report is free' });
    }
    // Never trust the client's button state alone — a report only supports
    // revisions when the engine jobId that produced it was recoverable.
    if (revisions && !report.revisable) {
      return res.status(400).json({ error: 'This report does not support revisions' });
    }

    const pricing = await getStripePricing(stripe, revisions ? 'ready-revisions' : 'ready', { bypassCache: true });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [readyReportLineItem(report, pricing, revisions)],
      mode: 'payment',
      allow_promotion_codes: true,
      metadata: {
        reportId: report.id,
        reportName: report.name,
        ticker: report.ticker || '',
        price: String(pricing.unitAmount / 100),
        withRevisions: revisions ? 'true' : 'false',
        revisionsAllowed: revisions ? String(REPORT_REVISIONS_INCLUDED) : '0',
      },
      success_url: `${process.env.SITE_URL}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/reports.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
};

function readyReportLineItem(report, pricing, revisions) {
  if (pricing.priceId) {
    return { price: pricing.priceId, quantity: 1 };
  }

  const name = revisions ? `AI Equity Report + Revisions - ${report.name}` : `AI Equity Report - ${report.name}`;
  const description = revisions
    ? `${report.ticker} - Full PDF, plus ${REPORT_REVISIONS_INCLUDED} report-revision requests after purchase.`
    : `${report.ticker} - Full PDF with value pool analysis, reverse valuation, risks & financials.`;

  return {
    price_data: {
      currency: 'eur',
      product_data: { name, description },
      unit_amount: pricing.unitAmount,
    },
    quantity: 1,
  };
}
