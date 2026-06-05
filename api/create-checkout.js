const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { reportId, reportName, price, ticker } = req.body;
  if (!reportId || !price) return res.status(400).json({ error: 'Missing fields' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `AI Equity Report — ${reportName}`,
            description: `${ticker} · Full PDF with value pool analysis, reverse valuation, risks & financials.`,
          },
          unit_amount: Math.round(price * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: { reportId, reportName, ticker: ticker || '' },
      success_url: `${process.env.SITE_URL}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL}/reports.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
};
