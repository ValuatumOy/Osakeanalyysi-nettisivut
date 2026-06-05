require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { REPORT_CATALOG } = require('./reports');
const { sendReportEmail, sendFreshConfirmEmail, sendAdminNotification } = require('./email');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ─────────────────────────────────────────────────────────────────────
// Allow the static frontend (Vercel or any *.valuatum.com) to call the API.
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // Stripe webhook has no Origin
    const ok =
      !origin ||
      /\.valuatum\.com$/.test(origin) ||
      /\.vercel\.app$/.test(origin) ||
      origin === process.env.SITE_URL ||
      /^http:\/\/localhost/.test(origin);
    cb(ok ? null : new Error('CORS: origin not allowed'), ok);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
}));

// Raw body for webhook; JSON for everything else.
app.use((req, res, next) => {
  if (req.path === '/api/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// ── POST /api/create-checkout ─────────────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { reportId, reportName, price, ticker } = req.body;

  if (!reportId || !price) return res.status(400).json({ error: 'Missing fields' });

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
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// ── POST /api/create-fresh-checkout ──────────────────────────────────────────
app.post('/api/create-fresh-checkout', async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { company, ticker, exchange, email, purpose } = req.body;

  if (!company) return res.status(400).json({ error: 'Company name required' });

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
          unit_amount: 990, // €9.90
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: email || undefined,
      metadata: {
        isFresh: 'true',
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
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// ── GET /api/get-report-link ──────────────────────────────────────────────────
// Called by the success page to show the download button immediately.
app.get('/api/get-report-link', async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { session_id } = req.query;

  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    const isFresh = session.metadata?.isFresh === 'true';
    if (isFresh) {
      return res.json({
        type: 'fresh',
        company: session.metadata?.company,
        email:   session.customer_details?.email,
      });
    }

    const report = REPORT_CATALOG[session.metadata?.reportId];
    if (!report) return res.status(404).json({ error: 'Report not found' });

    res.json({
      type:       'existing',
      reportName: report.name,
      ticker:     report.ticker,
      reportDate: report.reportDate,
      pdfUrl:     report.pdfUrl,
      email:      session.customer_details?.email,
    });
  } catch (err) {
    console.error('get-report-link:', err.message);
    res.status(500).json({ error: 'Failed to retrieve session' });
  }
});

// ── POST /api/webhook ─────────────────────────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
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
    } catch (emailErr) {
      // Log but don't fail — Stripe already has the payment
      console.error('Email send error:', emailErr.message);
    }
  }

  res.json({ received: true });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Valuatum API on port ${PORT}`));
