// Every Stripe Checkout the report shop sells, in one place.
//
// The Vercel functions under api/ and the since-retired Express server each
// carried their own copy of every session builder, reading their own env
// vars and drifting apart (the Express copies never learned about revisions
// at all). The functions now call these. The members Lambda shares the
// extra-round builder for the same reason: two doors, one product, one price.
//
// Nothing here talks to the catalog or the orders table — callers look the
// report up and pass it in, so this module needs only a Stripe client.

const { getStripePricing, revisionsIncluded } = require('./stripe-pricing');

const MAX_EXTRA_ROUNDS = 10;

// A refusal the HTTP layer can pass straight through to the buyer, as
// opposed to an unexpected failure that should be logged and become a 500.
class CheckoutError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CheckoutError';
    this.status = status;
  }
}

function siteUrl() {
  return (process.env.SITE_URL || 'https://www.aiequityreports.com').replace(/\/+$/, '');
}

// A checkout session counts as done when it was paid, or when a promotion
// code brought the total to zero.
function isCompletedCheckout(session) {
  return session.payment_status === 'paid' || Number(session.amount_total || 0) === 0;
}

// The durable, emailable page for an order that carries revisions. The
// checkout session id is the order id everywhere.
function orderPageUrl(sessionId) {
  return `${siteUrl()}/order/index.html?session_id=${encodeURIComponent(sessionId)}`;
}

// The Stripe Price when the kind resolved to one, otherwise an inline amount.
// The inline branch exists only for the two base kinds, which keep a
// hardcoded fallback so the shop stays open when Stripe cannot be reached.
function lineItem(pricing, { name, description, quantity = 1 }) {
  if (pricing.priceId) return { price: pricing.priceId, quantity };
  return {
    price_data: {
      currency: pricing.currency || 'eur',
      product_data: { name, description },
      unit_amount: pricing.unitAmount,
    },
    quantity,
  };
}

function isFreeReport(report) {
  return Boolean(report.isFree) || Number(report.price) <= 0;
}

// Which price kind a catalog report sells under. A free report has nothing
// to sell on its own; it becomes purchasable only together with revisions.
function readyReportKind(report, withRevisions) {
  if (!withRevisions) {
    if (isFreeReport(report)) throw new CheckoutError(400, 'Report is free');
    return 'ready';
  }
  // Never trust the client's button state alone — a report only supports
  // revisions when the engine jobId that produced it was recoverable.
  if (!report.revisable) throw new CheckoutError(400, 'This report does not support revisions');
  return isFreeReport(report) ? 'free-revisions' : 'ready-revisions';
}

function readyReportCopy(report, kind, included) {
  const name = report.name || report.companyName;
  if (kind === 'free-revisions') {
    return {
      name: `Report Revisions - ${name}`,
      description: `${report.ticker} - ${included} report-revision requests on the free report.`,
    };
  }
  if (kind === 'ready-revisions') {
    return {
      name: `AI Equity Report + Revisions - ${name}`,
      description: `${report.ticker} - Full PDF, plus ${included} report-revision requests after purchase.`,
    };
  }
  return {
    name: `AI Equity Report - ${name}`,
    description: `${report.ticker} - Full PDF with value pool analysis, reverse valuation, risks & financials.`,
  };
}

// A ready (already published) catalog report, with or without revisions.
async function createReadyReportCheckout(stripe, report, options = {}) {
  if (!report) throw new CheckoutError(404, 'Report not found');
  const withRevisions = Boolean(options.withRevisions);
  const kind = readyReportKind(report, withRevisions);
  const included = withRevisions ? revisionsIncluded() : 0;
  const pricing = await getStripePricing(stripe, kind, { bypassCache: true });

  return stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [lineItem(pricing, readyReportCopy(report, kind, included))],
    mode: 'payment',
    allow_promotion_codes: true,
    metadata: {
      reportId: report.id,
      reportName: report.name || report.companyName || '',
      ticker: report.ticker || '',
      price: String(pricing.unitAmount / 100),
      // What was actually bought. A free report's buyer paid for revisions
      // only, and the receipt page and email must not thank them for a
      // report they already had — the catalog's free flag rotates weekly,
      // so the session is the durable record of that.
      kind,
      withRevisions: withRevisions ? 'true' : 'false',
      revisionsAllowed: String(included),
    },
    success_url: `${siteUrl()}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl()}/reports.html`,
  });
}

// A same-site path, or the catalog. Anything with a scheme, a host or a
// traversal is refused rather than sanitised.
function cancelPath(requested) {
  const raw = String(requested || '');
  if (!/^\/[A-Za-z0-9\-._~/]*(?:#[A-Za-z0-9\-._~]*)?$/.test(raw) || raw.includes('//') || raw.includes('..')) {
    return '/reports.html#order-fresh';
  }
  return raw;
}

function freshReportCopy(company, ticker, withRevisions, included) {
  const label = `${company}${ticker ? ` (${ticker})` : ''}`;
  return withRevisions
    ? {
      name: `Fresh AI Equity Report + Revisions - ${company}`,
      description: `Latest-data report for ${label}, plus ${included} report-revision requests after delivery.`,
    }
    : {
      name: `Fresh AI Equity Report - ${company}`,
      description: `Latest-data report for ${label}. Delivered by email within about 30 minutes.`,
    };
}

// A report generated on demand for a company, with or without revisions.
async function createFreshReportCheckout(stripe, order = {}) {
  const company = String(order.company || '').trim();
  if (!company) throw new CheckoutError(400, 'Company name required');
  const withRevisions = Boolean(order.withRevisions);
  const included = withRevisions ? revisionsIncluded() : 0;
  const pricing = await getStripePricing(stripe, withRevisions ? 'fresh-revisions' : 'fresh', { bypassCache: true });

  return stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [lineItem(pricing, freshReportCopy(company, order.ticker, withRevisions, included))],
    mode: 'payment',
    allow_promotion_codes: true,
    customer_email: order.email || undefined,
    metadata: {
      isFresh: 'true',
      company,
      ticker: order.ticker || '',
      exchange: order.exchange || '',
      customerEmail: order.email || '',
      purpose: order.purpose || '',
      source: order.source || '',
      withRevisions: withRevisions ? 'true' : 'false',
      revisionsAllowed: String(included),
    },
    success_url: `${siteUrl()}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}&type=fresh`,
    // Abandoning the checkout returns to the page the order was started from —
    // a company page otherwise dropped its buyer on the catalog, which is the
    // one place their company is hardest to find again.
    cancel_url: `${siteUrl()}${cancelPath(order.returnTo)}`,
  });
}

function clampRounds(value) {
  return Math.min(MAX_EXTRA_ROUNDS, Math.max(1, Math.round(Number(value) || 1)));
}

// More revision rounds on an order somebody already has. Nothing is credited
// here: the members Lambda's billing webhook reads the `extraRevisions`
// metadata off every completed checkout in the account, so an abandoned
// return trip cannot lose rounds that were paid for.
//
// `extraMetadata` is for the caller's own bookkeeping (the members door adds
// the buyer's userId for its audit trail); it can never override the keys
// the webhook credits from.
async function createExtraRoundsCheckout(stripe, { orderId, rounds, email, companyLabel, successUrl, cancelUrl, extraMetadata } = {}) {
  if (!orderId) throw new CheckoutError(400, 'Missing order id');
  const quantity = clampRounds(rounds);
  const pricing = await getStripePricing(stripe, 'extra-revision', { bypassCache: true });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    allow_promotion_codes: true,
    ...(email ? { customer_email: email } : {}),
    line_items: [lineItem(pricing, {
      quantity,
      name: `Extra revision round — ${companyLabel || 'your report'}`,
      description: 'One more round of steering on a report you already have.',
    })],
    metadata: {
      ...(extraMetadata || {}),
      extraRevisions: String(quantity),
      generationId: orderId,
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return { session, rounds: quantity, priceEur: (quantity * pricing.unitAmount) / 100 };
}

// True when the session bought revisions on a report the buyer already had
// for free — the PDF was never the purchase.
function isRevisionsOnly(session) {
  return session?.metadata?.kind === 'free-revisions';
}

module.exports = {
  CheckoutError,
  isRevisionsOnly,
  MAX_EXTRA_ROUNDS,
  cancelPath,
  clampRounds,
  createExtraRoundsCheckout,
  createFreshReportCheckout,
  createReadyReportCheckout,
  isCompletedCheckout,
  lineItem,
  orderPageUrl,
  readyReportKind,
  siteUrl,
};
