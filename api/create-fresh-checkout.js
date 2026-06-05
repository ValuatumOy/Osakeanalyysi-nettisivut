const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { company, ticker, exchange, email, purpose } = req.body;
  if (!company) return res.status(400).json({ error: 'Company name required' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Fresh AI Equity Report — ${company}`,
            description: `Latest-data report for ${company}${ticker ? ` (${ticker})` : ''}. Delivered by email within 1 business day.`,
          },
          unit_amount: 990,
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: email || undefined,
      metadata: {
        isFresh:       'true',
        company,
        ticker:        ticker   || '',
        exchange:      exchange  || '',
        customerEmail: email    || '',
        purpose:       purpose  || '',
      },
      success_url: `${process.env.SITE_URL}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}&type=fresh`,
      cancel_url:  `${process.env.SITE_URL}/reports.html#order-fresh`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('create-fresh-checkout:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
};
