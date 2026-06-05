const Stripe = require('stripe');
const { REPORT_CATALOG } = require('../server/reports');
const { sendReportEmail, sendFreshConfirmEmail, sendAdminNotification } = require('../server/email');

// Vercel: disable body parser so we get raw body for Stripe signature verification
const handler = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).send('Webhook Error: STRIPE_WEBHOOK_SECRET is not set');
  }

  let event;
  try {
    const payload = Buffer.isBuffer(req.body) || typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);

    event = stripe.webhooks.constructEvent(payload, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook sig failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return res.json({ received: true });

    const email   = session.customer_details?.email || session.customer_email || session.metadata?.customerEmail;
    const isFresh = session.metadata?.isFresh === 'true';
    const reportId = session.metadata?.reportId;

    console.log('Checkout completed webhook received', {
      sessionId: session.id,
      isFresh,
      reportId: reportId || null,
      paymentStatus: session.payment_status,
    });

    try {
      if (isFresh) {
        if (email) {
          await sendFreshConfirmEmail(email, session.metadata);
        } else {
          console.warn('Fresh report email skipped: missing customer email', { sessionId: session.id });
        }
        await sendAdminNotification(session.metadata, email);
      } else {
        const report = REPORT_CATALOG[reportId];
        if (!email) {
          console.warn('Report email skipped: missing customer email', { sessionId: session.id, reportId });
        } else if (!report) {
          console.error('Report email skipped: unknown report id', { sessionId: session.id, reportId });
        } else {
          await sendReportEmail(email, report);
        }
      }
    } catch (e) {
      console.error('Email error:', e.message, { sessionId: session.id, isFresh, reportId: reportId || null });
    }
  }

  res.json({ received: true });
};

handler.config = { api: { bodyParser: false } };
module.exports = handler;
