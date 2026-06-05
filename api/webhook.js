const Stripe = require('stripe');
const { getCatalogReport, recordCatalogPurchase } = require('../server/catalog-client');
const { sendReportEmail, sendFreshConfirmEmail, sendAdminNotification } = require('../server/email');

// Vercel: disable body parser so Stripe signature verification receives the raw body.
async function getRawBody(req) {
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
    return req.body;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length) return Buffer.concat(chunks);
  return JSON.stringify(req.body);
}

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
    const payload = await getRawBody(req);
    event = stripe.webhooks.constructEvent(payload, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook sig failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return res.json({ received: true });

    const email = session.customer_details?.email || session.customer_email || session.metadata?.customerEmail;
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
        const purchase = {
          type: 'fresh',
          sessionId: session.id,
          companyName: session.metadata?.company || '',
          ticker: session.metadata?.ticker || '',
          customerEmail: email || '',
          purchasedAt: new Date((session.created || Date.now() / 1000) * 1000).toISOString(),
        };

        await recordCatalogPurchase(purchase);

        if (email) {
          await sendFreshConfirmEmail(email, session.metadata);
        } else {
          console.warn('Fresh report email skipped: missing customer email', { sessionId: session.id });
        }
        await sendAdminNotification(session.metadata, email);
      } else {
        const report = await getCatalogReport(reportId);
        if (!email) {
          console.warn('Report email skipped: missing customer email', { sessionId: session.id, reportId });
        } else if (!report) {
          console.error('Report email skipped: unknown report id', { sessionId: session.id, reportId });
        } else {
          await recordCatalogPurchase({
            type: 'existing',
            reportId: report.id,
            fileName: report.fileName,
            ticker: report.ticker,
            companyName: report.name,
            sessionId: session.id,
            customerEmail: email,
            purchasedAt: new Date((session.created || Date.now() / 1000) * 1000).toISOString(),
          });
          await sendReportEmail(email, report);
        }
      }
    } catch (e) {
      console.error('Email or catalog sync error:', e.message, { sessionId: session.id, isFresh, reportId: reportId || null });
    }
  }

  res.json({ received: true });
};

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
