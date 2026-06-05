const Stripe = require('stripe');
const { REPORT_CATALOG } = require('../server/reports');
const { sendReportEmail, sendFreshConfirmEmail, sendAdminNotification } = require('../server/email');

// Vercel: disable body parser so we get raw body for Stripe signature verification
const handler = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook sig failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return res.json({ received: true });

    const email   = session.customer_details?.email;
    const isFresh = session.metadata?.isFresh === 'true';

    try {
      if (isFresh) {
        if (email) await sendFreshConfirmEmail(email, session.metadata);
        await sendAdminNotification(session.metadata, email);
      } else {
        const report = REPORT_CATALOG[session.metadata?.reportId];
        if (email && report) await sendReportEmail(email, report);
      }
    } catch (e) {
      console.error('Email error:', e.message);
    }
  }

  res.json({ received: true });
};

handler.config = { api: { bodyParser: false } };
module.exports = handler;
