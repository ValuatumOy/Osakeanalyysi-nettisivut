require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const {
  buildCatalog,
  getReportByIdSync,
  recordCatalogPurchase,
} = require('./catalog');
const { sendReportEmail, sendFreshConfirmEmail } = require('./email');
const { REPORTS_CATALOG = [] } = require('../js/reportsData');
const orders = require('./orders');
const reconciler = require('./reconciler');
const reaper = require('./reaper');
const { searchCompanies } = require('./search');

const app = express();
const PORT = process.env.PORT || 3001;
const READY_REPORT_PRICE_CENTS = 2000;
const FRESH_REPORT_PRICE_CENTS = Number.parseInt(process.env.FRESH_REPORT_PRICE_CENTS || '5000', 10);
const DEFAULT_READY_REPORT_PRICE_ID = 'price_1TtPVO2FVkKDgcuUAOQ8uvIa';
const DEFAULT_FRESH_REPORT_PRICE_ID = 'price_1TtPUr2FVkKDgcuUBSFqewde';

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

function readyReportLineItem(report) {
  const priceId = stripePriceId(process.env.STRIPE_READY_REPORT_PRICE_ID, DEFAULT_READY_REPORT_PRICE_ID);
  if (priceId) {
    return { price: priceId, quantity: 1 };
  }

  return {
    price_data: {
      currency: 'eur',
      product_data: {
        name: `AI Equity Report - ${report.companyName}`,
        description: `${report.ticker} - Full PDF with value pool analysis, reverse valuation, risks & financials.`,
      },
      unit_amount: READY_REPORT_PRICE_CENTS,
    },
    quantity: 1,
  };
}

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
    const report = getReadyReportById(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ report: publicReportPayload(report) });
  } catch (err) {
    console.error('report lookup:', err.message);
    res.status(500).json({ error: 'Could not load report' });
  }
});

// Record a paid purchase in the catalog cooldown ledger, and — for a fresh
// order — enqueue it as a NEW row in the generation pipeline so the reconciler
// (Task D) can fulfil it. Idempotent on the Stripe session id (orders.create
// no-ops on a repeat).
function recordPurchaseAndQueue(input = {}) {
  const purchase = recordCatalogPurchase(input);
  if (input.type === 'fresh' && input.sessionId) {
    orders.create({
      id: input.sessionId,
      email: input.customerEmail || input.email || '',
      companyName: input.companyName || input.company || '',
      ticker: input.ticker || '',
      exchange: input.exchange || '',
      sector: input.sector || '',
      industry: input.industry || '',
    });
  }
  return purchase;
}

// POST /api/report-purchases - Vercel webhook syncs paid purchases here.
app.post('/api/report-purchases', requireCatalogSyncAuth, (req, res) => {
  try {
    const purchase = recordPurchaseAndQueue(req.body || {});
    res.json({ ok: true, purchase });
  } catch (err) {
    console.error('record purchase:', err.message);
    res.status(500).json({ error: 'Could not record purchase' });
  }
});

// GET /api/search-companies?q= - Wisdom-backed picker for fresh orders. Returns
// only companies Wisdom covers; an empty list means "not covered". The bearer
// token stays server-side (server/search.js).
app.get('/api/search-companies', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ query: q, results: [] });

  try {
    const results = await searchCompanies(q);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ query: q, results });
  } catch (err) {
    console.error('search-companies:', err.message);
    res.status(502).json({ error: 'Company search is unavailable' });
  }
});

// POST /api/create-checkout
app.post('/api/create-checkout', async (req, res) => {
  const { reportId } = req.body;
  if (!reportId) return res.status(400).json({ error: 'Missing report id' });

  try {
    const report = getReadyReportById(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.isFree || report.price <= 0) {
      return res.status(400).json({ error: 'Report is free' });
    }

    const session = await stripeClient().checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [readyReportLineItem(report)],
      mode: 'payment',
      allow_promotion_codes: true,
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
  const { company, ticker, exchange, email, purpose, source } = req.body;
  if (!company) return res.status(400).json({ error: 'Company name required' });

  try {
    const session = await stripeClient().checkout.sessions.create({
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
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// GET /api/get-report-link - success page download link after payment.
app.get('/api/get-report-link', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripeClient().checkout.sessions.retrieve(session_id);
    if (!isCompletedCheckout(session)) {
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
    if (!isCompletedCheckout(session)) return res.json({ received: true });

    const email = session.customer_details?.email || session.customer_email || session.metadata?.customerEmail;
    const isFresh = session.metadata?.isFresh === 'true';
    const reportId = session.metadata?.reportId;

    console.log('Checkout completed webhook received', {
      sessionId: session.id,
      isFresh,
      reportId: reportId || null,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
    });

    try {
      if (isFresh) {
        recordPurchaseAndQueue({
          type: 'fresh',
          sessionId: session.id,
          companyName: session.metadata?.company || '',
          ticker: session.metadata?.ticker || '',
          exchange: session.metadata?.exchange || '',
          customerEmail: email || '',
          purchasedAt: new Date((session.created || Date.now() / 1000) * 1000).toISOString(),
        });

        if (email) {
          await sendFreshConfirmEmail(email, session.metadata);
        } else {
          console.warn('Fresh report email skipped: missing customer email', { sessionId: session.id });
        }
        // Fulfilment is now the reconciler's job (Task D). The admin is emailed
        // by the reconciler — on success (flag ADMIN_NOTIFY_ON_SUCCESS) and
        // always on failure — not here, where generation hasn't happened yet.
      } else {
        const report = getReadyReportById(reportId);
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

function isCompletedCheckout(session) {
  return session.payment_status === 'paid' || Number(session.amount_total || 0) === 0;
}

function getReadyReportById(reportId) {
  const report = REPORTS_CATALOG.find(item => item.id === reportId);
  if (!report || report.availability === 'hidden') return null;
  const isFree = Boolean(report.isFree) || report.reportType === 'free' || Number(report.price) === 0;
  return {
    ...report,
    isFree,
    reportType: isFree ? 'free' : (report.reportType || 'existing'),
    price: isFree ? 0 : 20,
    priceLabel: isFree ? (report.priceLabel || 'Free report') : 'Ready report',
    creditCost: isFree ? 0 : (report.creditCost || 2),
  };
}

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Valuatum API on port ${PORT}`);
  // Start the fresh-report generation loop (no-op if PDF_ENGINE_URL is unset).
  reconciler.start();
  // Start the resale retention sweep (no-op unless RESALE_ENABLED).
  reaper.start();
});
