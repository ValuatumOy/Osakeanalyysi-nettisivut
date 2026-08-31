const Stripe = require('stripe');
const { getStripePricing } = require('../server/stripe-pricing');

// How many forecast-revision requests the "+ Revisions" tier includes.
const REPORT_REVISIONS_INCLUDED = Number.parseInt(process.env.REPORT_REVISIONS_INCLUDED || '', 10) || 3;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { company, ticker, exchange, email, purpose, source, withRevisions, returnTo } = req.body;
  if (!company) return res.status(400).json({ error: 'Company name required' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const revisions = Boolean(withRevisions);

  try {
    const pricing = await getStripePricing(stripe, revisions ? 'fresh-revisions' : 'fresh', { bypassCache: true });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [freshReportLineItem(company, ticker, pricing, revisions)],
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
        withRevisions: revisions ? 'true' : 'false',
        revisionsAllowed: revisions ? String(REPORT_REVISIONS_INCLUDED) : '0',
      },
      success_url: `${process.env.SITE_URL}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}&type=fresh`,
      // Abandoning the checkout returns to the page the order was started from —
      // a company page otherwise dropped its buyer on the catalog, which is the
      // one place their company is hardest to find again. Path only, from our
      // own site: the client cannot name another host.
      cancel_url: `${process.env.SITE_URL}${cancelPath(returnTo)}`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-fresh-checkout:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
};

// A same-site path, or the catalog. Anything with a scheme, a host or a
// traversal is refused rather than sanitised.
function cancelPath(requested) {
  const raw = String(requested || '');
  if (!/^\/[A-Za-z0-9\-._~/]*(?:#[A-Za-z0-9\-._~]*)?$/.test(raw) || raw.includes('//') || raw.includes('..')) {
    return '/reports.html#order-fresh';
  }
  return raw;
}

function freshReportLineItem(company, ticker, pricing, revisions) {
  if (pricing.priceId) {
    return { price: pricing.priceId, quantity: 1 };
  }

  const name = revisions
    ? `Fresh AI Equity Report + Revisions - ${company}`
    : `Fresh AI Equity Report - ${company}`;
  const description = revisions
    ? `Latest-data report for ${company}${ticker ? ` (${ticker})` : ''}, plus ${REPORT_REVISIONS_INCLUDED} report-revision requests after delivery.`
    : `Latest-data report for ${company}${ticker ? ` (${ticker})` : ''}. Delivered by email within about 30 minutes.`;

  return {
    price_data: {
      currency: 'eur',
      product_data: { name, description },
      unit_amount: pricing.unitAmount,
    },
    quantity: 1,
  };
}
