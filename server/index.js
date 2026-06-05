require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const {
  buildCatalog,
  getReportByIdSync,
  recordCatalogPurchase,
} = require('./catalog');
const { sendReportEmail, sendFreshConfirmEmail, sendAdminNotification } = require('./email');

const app = express();
const PORT = process.env.PORT || 3001;
const FRESH_REPORT_PRICE_CENTS = Number.parseInt(process.env.FRESH_REPORT_PRICE_CENTS || '990', 10);

// Allow the static frontend (Vercel or any *.valuatum.com) to call the API.
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok =
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

function stripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function publicReportPayload(report) {
  if (!report) return null;
  return {
    id: report.id,
    companyName: report.companyName,
    name: report.name,
    ticker: report.ticker,
    exchange: report.exchange,
    country: report.country,
    sector: report.sector,
    reportDate: report.reportDate,
    reportDateLabel: report.reportDateLabel,
    uploadedAt: report.uploadedAt,
    fileName: report.fileName,
    pdfUrl: report.pdfUrl,
    reportType: report.reportType,
    availability: report.availability,
    price: report.price,
    priceLabel: report.priceLabel,
    creditCost: report.creditCost,
    isFree: report.isFree,
    description: report.description,
    tags: report.tags,
  };
}

function requireCatalogSyncAuth(req, res, next) {
  const secret = process.env.CATALOG_SYNC_SECRET;
  if (!secret) return res.status(503).json({ error: 'CATALOG_SYNC_SECRET is not configured' });

  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  next();
}

// GET /api/reports - public catalog generated from the SFTP/FTP PDF folder.
app.get('/api/reports', (_, res) => {
  try {
    const catalog = buildCatalog();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      generatedAt: catalog.generatedAt,
      week: catalog.week,
      reports: catalog.reports.map(publicReportPayload),
    });
  } catch (err) {
    console.error('reports:', err.message);
    res.status(500).json({ error: 'Could not load reports' });
  }
});

// GET /api/reports/:reportId - used by checkout to resolve current price.
app.get('/api/reports/:reportId', (req, res) => {
  try {
    const report = getReportByIdSync(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ report: publicReportPayload(report) });
  } catch (err) {
    console.error('report lookup:', err.message);
    res.status(500).json({ error: 'Could not load report' });
  }
});

// POST /api/report-purchases - Vercel webhook syncs paid purchases here.
app.post('/api/report-purchases', requireCatalogSyncAuth, (req, res) => {
  try {
    const purchase = recordCatalogPurchase(req.body || {});
    res.json({ ok: true, purchase });
  } catch (err) {
    console.error('record purchase:', err.message);
    res.status(500).json({ error: 'Could not record purchase' });
  }
});

// POST /api/create-checkout
app.post('/api/create-checkout', async (req, res) => {
  const { reportId } = req.body;
  if (!reportId) return res.status(400).json({ error: 'Missing report id' });

  try {
    const report = getReportByIdSync(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.isFree || report.price <= 0) {
      return res.status(400).json({ error: 'Report is free' });
    }

    const session = await stripeClient().checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `AI Equity Report - ${report.companyName}`,
            description: `${report.ticker} - Full PDF with value pool analysis, reverse valuation, risks & financials.`,
          },
          unit_amount: Math.round(report.price * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: {
        reportId: report.id,
        reportName: report.companyName,
        ticker: report.ticker || '',
        price: String(report.price),
      },
      success_url: `${process.env.SITE_URL}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/reports.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout:', err.message);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// POST /api/create-fresh-checkout
app.post('/api/create-fresh-checkout', async (req, res) => {
  const { company, ticker, exchange, email, purpose } = req.body;
  if (!company) return res.status(400).json({ error: 'Company name required' });

  try {
    const session = await stripeClient().checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Fresh AI Equity Report - ${company}`,
            description: `Latest-data report for ${company}${ticker ? ` (${ticker})` : ''}. Delivered by email within 1 business day.`,
          },
          unit_amount: FRESH_REPORT_PRICE_CENTS,
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
      },
      success_url: `${process.env.SITE_URL}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}&type=fresh`,
      cancel_url: `${process.env.SITE_URL}/reports.html#order-fresh`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-fresh-checkout:', err.message);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// GET /api/get-report-link - success page download link after payment.
app.get('/api/get-report-link', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripeClient().checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    if (session.metadata?.isFresh === 'true') {
      return res.json({
        type: 'fresh',
        company: session.metadata?.company,
        email: session.customer_details?.email,
      });
    }

    const report = getReportByIdSync(session.metadata?.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    res.json({
      type: 'existing',
      reportName: report.companyName,
      ticker: report.ticker,
      reportDate: report.reportDateLabel || report.reportDate,
      pdfUrl: report.pdfUrl,
      email: session.customer_details?.email,
    });
  } catch (err) {
    console.error('get-report-link:', err.message);
    res.status(500).json({ error: 'Failed to retrieve session' });
  }
});

// POST /api/webhook
app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).send('Webhook Error: STRIPE_WEBHOOK_SECRET is not set');
  }

  let event;
  try {
    event = stripeClient().webhooks.constructEvent(req.body, sig, webhookSecret);
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
        recordCatalogPurchase({
          type: 'fresh',
          sessionId: session.id,
          companyName: session.metadata?.company || '',
          ticker: session.metadata?.ticker || '',
          customerEmail: email || '',
          purchasedAt: new Date((session.created || Date.now() / 1000) * 1000).toISOString(),
        });

        if (email) {
          await sendFreshConfirmEmail(email, session.metadata);
        } else {
          console.warn('Fresh report email skipped: missing customer email', { sessionId: session.id });
        }
        await sendAdminNotification(session.metadata, email);
      } else {
        const report = getReportByIdSync(reportId);
        if (!email) {
          console.warn('Report email skipped: missing customer email', { sessionId: session.id, reportId });
        } else if (!report) {
          console.error('Report email skipped: unknown report id', { sessionId: session.id, reportId });
        } else {
          recordCatalogPurchase({
            type: 'existing',
            reportId: report.id,
            fileName: report.fileName,
            ticker: report.ticker,
            companyName: report.companyName,
            sessionId: session.id,
            customerEmail: email,
            purchasedAt: new Date((session.created || Date.now() / 1000) * 1000).toISOString(),
          });
          await sendReportEmail(email, {
            ...report,
            name: report.companyName,
            reportDate: report.reportDateLabel || report.reportDate,
          });
        }
      }
    } catch (emailErr) {
      console.error('Email send error:', emailErr.message, { sessionId: session.id, isFresh, reportId: reportId || null });
    }
  }

  res.json({ received: true });
});

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Valuatum API on port ${PORT}`));
