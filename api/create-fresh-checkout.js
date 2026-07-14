const Stripe = require('stripe');

const FRESH_REPORT_PRICE_CENTS = Number.parseInt(process.env.FRESH_REPORT_PRICE_CENTS || '990', 10);
// Price for the "Generate this report" button on the generated company pages
// (render-company-page.mjs NEW_REPORT_PRICE = 50 EUR). Kept server-side so the
// charged amount is never taken from the client. Must match that page price.
const FRESH_REPORT_COVERAGE_PRICE_CENTS = Number.parseInt(process.env.FRESH_REPORT_COVERAGE_PRICE_CENTS || '5000', 10);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { company, ticker, exchange, email, purpose, source } = req.body;
  if (!company) return res.status(400).json({ error: 'Company name required' });

  const priceCents = source === 'coverage' ? FRESH_REPORT_COVERAGE_PRICE_CENTS : FRESH_REPORT_PRICE_CENTS;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Fresh AI Equity Report - ${company}`,
            description: `Latest-data report for ${company}${ticker ? ` (${ticker})` : ''}. Delivered by email within about 30 minutes.`,
          },
          unit_amount: priceCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: email || undefined,
      metadata: {
        isFresh: 'true',
        company,
        ticker: ticker || '',
        exchange: exchange || '',
        customerEmail: email || '',
        purpose: purpose || '',
        source: source || '',
      },
      success_url: `${process.env.SITE_URL}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}&type=fresh`,
      cancel_url: `${process.env.SITE_URL}/reports.html#order-fresh`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-fresh-checkout:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
};
