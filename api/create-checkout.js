const Stripe = require('stripe');
const { getCatalogReport } = require('../server/catalog-client');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { reportId } = req.body;
  if (!reportId) return res.status(400).json({ error: 'Missing report id' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const report = await getCatalogReport(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.isFree || report.price <= 0) {
      return res.status(400).json({ error: 'Report is free' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `AI Equity Report - ${report.name}`,
            description: `${report.ticker} - Full PDF with value pool analysis, reverse valuation, risks & financials.`,
          },
          unit_amount: Math.round(report.price * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: {
        reportId: report.id,
        reportName: report.name,
        ticker: report.ticker || '',
        price: String(report.price),
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
