const Stripe = require('stripe');

const FRESH_REPORT_PRICE_CENTS = Number.parseInt(process.env.FRESH_REPORT_PRICE_CENTS || '5000', 10);
const DEFAULT_FRESH_REPORT_PRICE_ID = 'price_1TtPUr2FVkKDgcuUBSFqewde';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { company, ticker, exchange, email, purpose, source } = req.body;
  if (!company) return res.status(400).json({ error: 'Company name required' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [freshReportLineItem(company, ticker)],
      mode: 'payment',
      allow_promotion_codes: true,
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

function freshReportLineItem(company, ticker) {
  const priceId = stripePriceId(process.env.STRIPE_FRESH_REPORT_PRICE_ID, DEFAULT_FRESH_REPORT_PRICE_ID);
  if (priceId) {
    return { price: priceId, quantity: 1 };
  }

  return {
    price_data: {
      currency: 'eur',
      product_data: {
        name: `Fresh AI Equity Report - ${company}`,
        description: `Latest-data report for ${company}${ticker ? ` (${ticker})` : ''}. Delivered by email within about 30 minutes.`,
      },
      unit_amount: FRESH_REPORT_PRICE_CENTS,
    },
    quantity: 1,
  };
}

function stripePriceId(value, fallback) {
  const priceId = String(value || '').trim();
  if (/^price_[A-Za-z0-9]+$/.test(priceId)) return priceId;
  return fallback;
}
