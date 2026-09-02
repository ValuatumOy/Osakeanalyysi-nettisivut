// AiEquityReportsApi Lambda — API Gateway HTTP API (payload v2) handler.
// Replaces the retired Express app (server/index.js) for the routes that survive the
// migration: public catalog reads, the purchase-sync endpoint the
// Vercel webhook calls, the Wisdom search proxy, Stripe pricing, and the admin
// page's report management. Reuses the existing server/ modules; the
// only new logic here is routing, auth, and the admin CRUD glue.

const crypto = require('crypto');
const Stripe = require('stripe');

const catalogAws = require('../aws/catalog-aws');
const stateStore = require('../aws/catalog-state-store');
const ordersStore = require('../aws/orders-store');
const pdfStore = require('../aws/pdf-store');
const { ensureSecrets } = require('../aws/secrets');
const { searchCompanies } = require('../search');
const { getPublicPricing } = require('../stripe-pricing');
const { companyToken } = require('../reconciler');
const { sendAdminAlert, reportError } = require('../email');
const { validateEditRequest, EditValidationError } = require('../report-edits');
const editing = require('../order-editing');

const STAGE = process.env.STAGE || 'prod';

// Same permanent, unsigned link the delivery/revision emails already carry
// (server/reconciler.js) — files.aiequityreports.com is a CloudFront
// distribution in front of the private PDF bucket (OAC), so no signing is
// needed and the link never expires. The order page used to presign these
// with pdfStore.presignPdfDownload, which is right for /api/report-download
// (a per-click link behind a fresh Stripe-session check) but wrong here: the
// same file is already durably reachable at this URL, so a 15-minute-expiry
// link only made the order page's copy worse without adding any security.
const PDF_BASE_URL = (process.env.REPORT_PDF_BASE_URL || 'https://files.aiequityreports.com/reports/pdfs').replace(/\/$/, '');
function permanentPdfUrl(fileName) {
  return `${PDF_BASE_URL}/${encodeURIComponent(fileName)}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return null;
  }
}

function bearerToken(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function secretsMatch(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// EMF metric for the admin-probing alarm: repeated admin 401s → SNS.
function emitAdminUnauthorized() {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'AiEquityReports',
        Dimensions: [['Stage']],
        Metrics: [{ Name: 'AdminUnauthorized' }],
      }],
    },
    Stage: STAGE,
    AdminUnauthorized: 1,
  }));
}

// Same public shape the retired Express app exposed — the Vercel frontend
// normalizes on top of this, so the payload must not change at cutover.
//
// One deliberate exception: `pdfUrl` is published only for FREE reports. It is
// a permanent unsigned link, so handing it out for paid reports turned the
// paywall into a suggestion — anyone could read /api/reports and download the
// lot. Buyers reach their PDF through /api/report-download, which checks the
// Stripe session and mints a short-lived signed URL.
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
    pdfUrl: report.isFree ? report.pdfUrl : undefined,
    reportType: report.reportType,
    availability: report.availability,
    price: report.price,
    priceLabel: report.priceLabel,
    creditCost: report.creditCost,
    isFree: report.isFree,
    description: report.description,
    tags: report.tags,
    // Whether a "+ Revisions" purchase can be offered on this report — see
    // server/catalog.js. Never the raw jobId itself.
    revisable: Boolean(report.revisable),
  };
}

let stripeClient;
function stripe() {
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

async function invokeWorkerAsync() {
  const functionName = process.env.WORKER_FUNCTION_NAME;
  if (!functionName) return;
  const { InvokeCommand } = require('@aws-sdk/client-lambda');
  const { lambda } = require('../aws/clients');
  await lambda().send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'Event',
    Payload: JSON.stringify({ action: 'tick', reason: 'fresh-order' }),
  }));
}

// Buyer count for the admin list / delete warning: strict matches only
// (fileName or reportId), scoped by the ledger's 366-day TTL.
function buyerCount(report, purchases) {
  return purchases.filter(purchase =>
    (purchase.fileName && purchase.fileName === report.fileName) ||
    (purchase.reportId && purchase.reportId === report.id),
  ).length;
}

// ── route handlers ───────────────────────────────────────────────────────────

async function getReports() {
  const { catalog } = await catalogAws.buildCatalogAws();
  return json(200, {
    generatedAt: catalog.generatedAt,
    week: catalog.week,
    reports: catalog.reports.map(publicReportPayload),
  }, { 'cache-control': 'public, max-age=300' });
}

async function getReportById(event) {
  const reportId = event.pathParameters?.id || '';
  const { catalog } = await catalogAws.buildCatalogAws();
  const report = catalog.reports.find(item => item.id === reportId);
  if (!report || report.availability === 'hidden') return json(404, { error: 'Report not found' });
  return json(200, { report: publicReportPayload(report) });
}

async function getPricing() {
  const pricing = await getPublicPricing(stripe(), { bypassCache: true });
  return json(200, pricing, { 'cache-control': 'no-store, max-age=0' });
}

async function getSearchCompanies(event) {
  const q = String(event.queryStringParameters?.q || '').trim();
  if (q.length < 1) return json(200, { query: q, results: [] });
  try {
    const results = await searchCompanies(q);
    return json(200, { query: q, results }, { 'cache-control': 'public, max-age=60' });
  } catch (err) {
    console.error('search-companies:', err.message);
    return json(502, { error: 'Company search is unavailable' });
  }
}

// POST /api/report-purchases — the Vercel webhook syncs paid purchases here.
// Same contract as the Express endpoint; a fresh order additionally lands in
// the orders table and pushes the worker awake.
async function postReportPurchases(event) {
  if (!secretsMatch(bearerToken(event), process.env.CATALOG_SYNC_SECRET)) {
    return json(process.env.CATALOG_SYNC_SECRET ? 401 : 503,
      { error: process.env.CATALOG_SYNC_SECRET ? 'Unauthorized' : 'CATALOG_SYNC_SECRET is not configured' });
  }

  const input = parseBody(event);
  if (!input) return json(400, { error: 'Invalid JSON body' });

  const purchase = await stateStore.recordPurchase(input);

  if (input.type === 'fresh' && input.sessionId) {
    await ordersStore.create({
      id: input.sessionId,
      email: input.customerEmail || input.email || '',
      companyName: input.companyName || input.company || '',
      ticker: input.ticker || '',
      exchange: input.exchange || '',
      sector: input.sector || '',
      industry: input.industry || '',
      revisionsAllowed: Number(input.revisionsAllowed || 0),
      amountTotal: input.amountTotal,
      currency: input.currency,
    });
    try {
      await invokeWorkerAsync();
    } catch (err) {
      // The 5-minute sweep picks the order up anyway.
      console.warn('worker push invoke failed (sweep will catch it):', err.message);
    }
  } else if (input.type === 'existing' && input.withRevisions && input.sessionId && input.fileName) {
    // A "+ Revisions" purchase on an already-published catalog report: seed
    // an order row directly at DELIVERED (there is nothing to generate),
    // pinned to the engine jobId that produced it — read fresh from the
    // sidecar here, server-side, never from anything the browser sent.
    try {
      const sidecar = await pdfStore.readSidecar(input.fileName);
      const jobId = sidecar?.provenance?.jobId || null;
      if (!jobId) {
        throw new Error(`report ${input.fileName} has no revisable jobId (sidecar provenance missing)`);
      }
      await ordersStore.create({
        id: input.sessionId,
        origin: 'ready',
        reportId: input.reportId || '',
        email: input.customerEmail || '',
        companyName: input.companyName || '',
        ticker: input.ticker || '',
        status: ordersStore.STATUS.DELIVERED,
        jobId,
        pdfFileName: input.fileName,
        revisionsAllowed: Number(input.revisionsAllowed || 0),
        amountTotal: input.amountTotal,
        currency: input.currency,
      });
    } catch (err) {
      // Non-fatal: the purchase itself is already recorded above and the
      // customer already has their PDF. Losing the revision entitlement is
      // a real problem, just not one worth a Stripe-retry loop — alert
      // instead of throwing.
      console.error('ready+revisions order seeding failed:', err.message, {
        sessionId: input.sessionId, reportId: input.reportId,
      });
      try {
        await sendAdminAlert('A "+ Revisions" purchase could not be linked to its report', [
          `Session: ${input.sessionId}`,
          `Report: ${input.reportId || 'unknown'} (${input.fileName})`,
          `Customer: ${input.customerEmail || 'unknown'}`,
          `Error: ${err.message}`,
          'The customer paid for revisions but has no order row to use them on — needs manual follow-up.',
        ]);
      } catch (alertErr) {
        console.error('ready+revisions seeding-failure alert also failed:', alertErr.message);
      }
    }
  }

  return json(200, { ok: true, purchase });
}

// POST /api/report-download — mint a short-lived signed URL for one report.
// Called server-side by the Vercel function that has already verified the
// buyer's Stripe session, so the shared catalog-sync secret is the auth here;
// the browser never talks to this route directly.
async function postReportDownload(event) {
  if (!secretsMatch(bearerToken(event), process.env.CATALOG_SYNC_SECRET)) {
    return json(process.env.CATALOG_SYNC_SECRET ? 401 : 503,
      { error: process.env.CATALOG_SYNC_SECRET ? 'Unauthorized' : 'CATALOG_SYNC_SECRET is not configured' });
  }

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  const reportId = String(body.reportId || '').trim();
  if (!reportId) return json(400, { error: 'reportId is required' });

  // includeNonPublic: a delivered fresh report is hidden by design, and its
  // buyer still has to be able to download it.
  const { catalog } = await catalogAws.buildCatalogAws({ includeNonPublic: true });
  const report = catalog.reports.find(item => item.id === reportId);
  if (!report) return json(404, { error: 'Report not found' });

  const url = await pdfStore.presignPdfDownload(report.fileName);
  return json(200, { url, expiresIn: 900, fileName: report.fileName }, { 'cache-control': 'no-store' });
}

// No ASCII control characters except \n — the same charset rule the report
// engine enforces on params.userComments / revision comments.
const FORBIDDEN_CONTROL_CHARS = /[\x00-\x09\x0B-\x1F\x7F]/;
// Long enough that no one writing instructions by hand will meet it: 4,000
// characters was about 600 words, which a single detailed objection can use
// up. Not unbounded — comments accumulate in the order item across the
// revision chain, and DynamoDB refuses an item over 400 KB, so an
// unbounded field trades a clear error for a confusing write failure.
const MAX_REVISION_COMMENT_LENGTH = 40000;

// GET /api/orders/{id} — order-page state. Called server-side by the Vercel
// proxy that has already verified the Stripe session id (same trust model as
// /api/report-download): the shared catalog-sync secret is the auth here.
async function getOrder(event) {
  if (!secretsMatch(bearerToken(event), process.env.CATALOG_SYNC_SECRET)) {
    return json(process.env.CATALOG_SYNC_SECRET ? 401 : 503,
      { error: process.env.CATALOG_SYNC_SECRET ? 'Unauthorized' : 'CATALOG_SYNC_SECRET is not configured' });
  }

  const id = event.pathParameters?.id || '';
  const order = await ordersStore.get(id);
  if (!order) return json(404, { error: 'Order not found' });

  const payload = {
    status: order.status,
    origin: order.origin,
    companyName: order.companyName,
    ticker: order.ticker,
    reportId: order.reportId,
    revisionsAllowed: order.revisionsAllowed || 0,
    revisionsUsed: order.revisionsUsed || 0,
    revisionError: order.revisionError || null,
    error: order.status === ordersStore.STATUS.FAILED ? order.error : null,
    // Text editing: whether the current version can be edited by hand, which
    // version number that is, and — while REVISING — whether the wait is an
    // edit (seconds) or an AI revision (tens of minutes).
    editable: editing.editableNow(order),
    currentVersion: editing.currentVersion(order),
    activity: editing.activityOf(order),
    editsUsed: order.editsUsed || 0,
  };

  // Only DELIVERED gets a PDF link — while REVISING, the order page shows
  // progress, not the (about to be superseded) previous file.
  if (order.status === ordersStore.STATUS.DELIVERED && order.pdfFileName) {
    payload.pdfUrl = permanentPdfUrl(order.pdfFileName);
  }

  // A "build on" order (server/lambda/members.js createForkOrder) is deliberately
  // created with no pdfFileName of its own — the parent's key is never shared,
  // so a fork's first revision can never overwrite the analyst's published PDF
  // (see test/orders/fork-order.test.mjs). Until that first revision lands, this
  // buyer has nothing to download under their own order — but they did pay for
  // the parent's analysis, so resolve it here, live, from the parent's own
  // current row. Read-only: nothing is written back to either order.
  if (order.status === ordersStore.STATUS.DELIVERED && !order.pdfFileName && order.forkedFrom) {
    const parent = await ordersStore.get(order.forkedFrom);
    if (parent?.status === ordersStore.STATUS.DELIVERED && parent.pdfFileName) {
      payload.originalUrl = permanentPdfUrl(parent.pdfFileName);
    }
  }

  // Every delivered revision's change memo + a re-download link for that
  // specific PDF, newest first — the order page renders these under "revision
  // history".
  payload.revisionHistory = (order.revisionHistory || []).slice().reverse().map((entry) => ({
    ...editing.historyEntryPayload(entry),
    pdfUrl: entry.pdfFileName ? permanentPdfUrl(entry.pdfFileName) : null,
  }));

  // Once at least one revision exists, order.pdfUrl above points at the latest
  // version — append the original as the oldest entry so it stays downloadable
  // too. Orders that revised before originalPdfFileName existed have none; that
  // original is unrecoverable, so it's simply omitted rather than shown broken.
  if (payload.revisionHistory.length && order.originalPdfFileName) {
    payload.revisionHistory.push({
      version: 1,
      original: true,
      completedAt: order.deliveredEmailAt || null,
      pdfUrl: permanentPdfUrl(order.originalPdfFileName),
    });
  }

  return json(200, payload, { 'cache-control': 'no-store' });
}

// POST /api/orders/{id}/revisions — the order page's one mutating call.
// Claims the order for a revision (DELIVERED -> REVISING, conditional on
// revisionsUsed < revisionsAllowed) and wakes the worker; the worker submits
// the comment to the report engine's own scope: "estimates" revision
// endpoint, which interprets it and updates the forecast — nothing here
// interprets the comment itself.
async function postOrderRevision(event) {
  if (!secretsMatch(bearerToken(event), process.env.CATALOG_SYNC_SECRET)) {
    return json(process.env.CATALOG_SYNC_SECRET ? 401 : 503,
      { error: process.env.CATALOG_SYNC_SECRET ? 'Unauthorized' : 'CATALOG_SYNC_SECRET is not configured' });
  }

  const id = event.pathParameters?.id || '';
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  const comments = String(body.comments || '').trim();
  if (!comments) return json(400, { error: 'comments is required' });
  if (comments.length > MAX_REVISION_COMMENT_LENGTH) {
    return json(400, { error: `comments must be ${MAX_REVISION_COMMENT_LENGTH} characters or fewer` });
  }
  if (FORBIDDEN_CONTROL_CHARS.test(comments)) {
    return json(400, { error: 'comments contains invalid control characters' });
  }

  const claimed = await ordersStore.claimRevision(id, comments);
  if (!claimed) {
    const existing = await ordersStore.get(id);
    if (!existing) return json(404, { error: 'Order not found' });
    return json(409, { error: 'This order cannot take a revision request right now', status: existing.status });
  }

  try {
    await invokeWorkerAsync();
  } catch (err) {
    // The 5-minute sweep picks the order up anyway.
    console.warn('worker push invoke failed (sweep will catch it):', err.message);
  }

  return json(200, { ok: true, status: claimed.status });
}

// POST /api/orders/{id}/edits — the customer's hand edits to the report text.
// Body `{ edits: { pointer: text }, originals?: { pointer: text }, editedBy? }`.
// Claims the order (DELIVERED -> REVISING, no allowance: edits are free and
// unlimited) and wakes the worker, which submits the edits to the engine's
// edit endpoint — a re-render in seconds with no AI pass.
async function postOrderEdits(event) {
  if (!secretsMatch(bearerToken(event), process.env.CATALOG_SYNC_SECRET)) {
    return json(process.env.CATALOG_SYNC_SECRET ? 401 : 503,
      { error: process.env.CATALOG_SYNC_SECRET ? 'Unauthorized' : 'CATALOG_SYNC_SECRET is not configured' });
  }

  const id = event.pathParameters?.id || '';
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  let request;
  try {
    request = validateEditRequest(body);
  } catch (err) {
    if (err instanceof EditValidationError) return json(400, { error: err.message });
    throw err;
  }

  const existing = await ordersStore.get(id);
  if (!existing) return json(404, { error: 'Order not found' });
  if (!editing.editableNow(existing)) {
    return json(409, {
      error: existing.status === ordersStore.STATUS.DELIVERED
        ? 'This report cannot be edited.'
        : 'This order is busy right now — wait for it to finish, then try again.',
      status: existing.status,
    });
  }

  const claimed = await ordersStore.claimEdit(id, {
    edits: request.edits,
    originals: request.originals,
    editedBy: request.editedBy,
    fromVersion: editing.currentVersion(existing),
  });
  if (!claimed) {
    return json(409, { error: 'This order cannot take an edit right now', status: existing.status });
  }

  try {
    await invokeWorkerAsync();
  } catch (err) {
    console.warn('worker push invoke failed (sweep will catch it):', err.message);
  }

  return json(200, { ok: true, status: claimed.status, version: editing.currentVersion(existing) + 1 });
}

// GET /api/orders/{id}/preview — the engine's rendered HTML of the current
// version, which the order page's text editor shows in a sandboxed frame.
async function getOrderPreview(event) {
  if (!secretsMatch(bearerToken(event), process.env.CATALOG_SYNC_SECRET)) {
    return json(process.env.CATALOG_SYNC_SECRET ? 401 : 503,
      { error: process.env.CATALOG_SYNC_SECRET ? 'Unauthorized' : 'CATALOG_SYNC_SECRET is not configured' });
  }

  const id = event.pathParameters?.id || '';
  const order = await ordersStore.get(id);
  if (!order) return json(404, { error: 'Order not found' });

  const result = await editing.loadPreviewHtml(order);
  if (result.status !== 200) return json(result.status, { error: result.error });
  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, max-age=300',
      'x-report-version': String(editing.currentVersion(order)),
    },
    body: result.html,
  };
}

// ── admin ──────────────────────────────────────────────────────────

function requireAdmin(event) {
  const expected = process.env.ADMIN_UPLOAD_PASSWORD;
  if (!expected) return json(503, { error: 'ADMIN_UPLOAD_PASSWORD is not configured' });
  if (!secretsMatch(bearerToken(event), expected)) {
    emitAdminUnauthorized();
    return json(401, { error: 'Unauthorized' });
  }
  return null;
}

async function getAdminReports() {
  const { catalog, state } = await catalogAws.buildCatalogAws({ includeNonPublic: true });
  const purchases = state.purchases || [];

  // Who made what. Every file an order produced — the delivered report and each
  // revised copy — carries that order's id in its sidecar, and the order names
  // the customer and how it came to exist. One scan; the table is small, and
  // this endpoint is one admin's page load.
  const orderOf = new Map();
  // When each file was produced, from the order that produced it: the
  // original delivery's timestamp, or the revision history entry for a revised
  // copy. S3's modification time is not this — a bulk sidecar rewrite resets
  // it for every file at once.
  const generatedAtOf = new Map();
  try {
    for (const order of await ordersStore.list()) {
      orderOf.set(order.id, order);
      const original = order.originalPdfFileName || order.pdfFileName;
      if (original && order.deliveredEmailAt) generatedAtOf.set(original, order.deliveredEmailAt);
      for (const entry of order.revisionHistory || []) {
        if (entry.pdfFileName && entry.completedAt) generatedAtOf.set(entry.pdfFileName, entry.completedAt);
      }
    }
  } catch (err) {
    console.warn('admin reports: orders join unavailable:', err.message);
  }

  return json(200, {
    generatedAt: catalog.generatedAt,
    week: catalog.week,
    reports: catalog.reports.map(report => {
      const order = report.provenanceSessionId ? orderOf.get(report.provenanceSessionId) : null;
      return {
        ...publicReportPayload(report),
        // The public payload drops the link for anything not free, which is
        // every paid report and every revised copy. This listing is behind the
        // admin password, so each row links to its file.
        pdfUrl: permanentPdfUrl(report.fileName),
        publicationStatus: report.publicationStatus,
        excludeFromFree: report.excludeFromFree,
        forceFree: report.forceFree,
        ageDays: report.ageDays,
        buyerCount: buyerCount(report, purchases),
        // The grouping key: all of one order's files fold into one chain, and a
        // hand-uploaded report (no provenance) stands alone under its own id.
        groupId: report.provenanceSessionId || report.id,
        isRevision: Boolean(report.isRevision),
        // uploaded: an admin put the PDF here by hand. order: a customer's paid
        // fresh report. generation: a member's monthly/coverage run (private by
        // construction, only in the catalog as plumbing).
        origin: !report.provenanceSessionId ? 'uploaded'
          : (order?.visibility === 'private' || (order && !order.email) ? 'generation' : 'order'),
        generatedBy: order ? (order.analystName || order.email || null) : null,
        generatedAt: generatedAtOf.get(report.fileName) || null,
      };
    }),
  });
}

// Step 1 of the upload flow: mint the canonical fileName and a presigned PUT.
async function postAdminUploadUrl(event) {
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  const companyName = String(body.companyName || '').trim();
  const reportDate = String(body.reportDate || '').trim(); // YYYY-MM-DD
  if (!companyName) return json(400, { error: 'companyName is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return json(400, { error: 'reportDate must be YYYY-MM-DD' });

  const [yyyy, mm, dd] = reportDate.split('-');
  const fileName = `${companyToken(companyName)}_${dd}${mm}${yyyy}.pdf`;
  const uploadUrl = await pdfStore.presignPdfUpload(fileName);
  return json(200, { fileName, uploadUrl, expiresInSeconds: 300 });
}

// Step 2: write the sidecar once the browser has PUT the PDF to S3.
async function postAdminPublish(event) {
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  const fileName = String(body.fileName || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.pdf$/.test(fileName)) return json(400, { error: 'Invalid fileName' });
  if (!await pdfStore.pdfExists(fileName)) {
    return json(409, { error: 'PDF not found in the bucket — upload it first' });
  }
  if (!String(body.companyName || '').trim()) return json(400, { error: 'companyName is required' });

  const isFree = Boolean(body.isFree);
  const price = Number(body.price);
  const sidecar = {
    companyName: String(body.companyName).trim(),
    ticker: String(body.ticker || '').trim().toUpperCase(),
    exchange: String(body.exchange || '').trim(),
    country: String(body.country || '').trim(),
    sector: String(body.sector || '').trim(),
    reportDate: String(body.reportDate || '').trim(),
    uploadedAt: new Date().toISOString(),
    description: String(body.description || '').trim() ||
      `AI equity report for ${String(body.companyName).trim()}.`,
    tags: ['AI Equity Report', 'PDF'],
  };
  if (isFree) {
    sidecar.forceFree = true;
  } else if (Number.isFinite(price) && price >= 0) {
    sidecar.price = price;
  }
  if (body.visibleNow) sidecar.forceVisible = true;

  await pdfStore.writeSidecar(fileName, sidecar);
  return json(200, { ok: true, fileName, sidecar });
}

// Edit: merge form fields into the existing sidecar (null clears a key).
async function postAdminUpdate(event) {
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  const fileName = String(body.fileName || '').trim();
  if (!fileName.endsWith('.pdf')) return json(400, { error: 'fileName is required' });
  if (!await pdfStore.pdfExists(fileName)) return json(404, { error: 'Report not found' });

  const existing = await pdfStore.readSidecar(fileName);
  const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
  const ALLOWED = new Set([
    'companyName', 'ticker', 'exchange', 'country', 'sector', 'reportDate',
    'uploadedAt', 'description', 'price', 'priceLabel', 'hidden', 'publicationStatus',
    'forceVisible', 'forceFree', 'excludeFromFree', 'expiresAt', 'tags',
  ]);

  const sidecar = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (!ALLOWED.has(key)) continue;
    if (value === null) delete sidecar[key];
    else sidecar[key] = value;
  }

  await pdfStore.writeSidecar(fileName, sidecar);
  return json(200, { ok: true, fileName, sidecar });
}

// Delete: the single deletion path in the system. The page has
// already shown the buyer warning and the typed-name confirmation.
async function postAdminDelete(event) {
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  const fileName = String(body.fileName || '').trim();
  if (!fileName.endsWith('.pdf') || fileName.includes('/')) return json(400, { error: 'fileName is required' });
  if (!await pdfStore.pdfExists(fileName)) return json(404, { error: 'Report not found' });

  await pdfStore.deleteReport(fileName);
  console.warn('admin: report deleted (permanent links to it are now dead)', { fileName });
  return json(200, { ok: true, deleted: fileName });
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const PUBLIC_ROUTES = {
  'GET /api/health': async () => json(200, { ok: true }),
  'GET /api/reports': getReports,
  'GET /api/reports/{id}': getReportById,
  'GET /api/pricing': getPricing,
  'GET /api/search-companies': getSearchCompanies,
  'POST /api/report-purchases': postReportPurchases,
  'POST /api/report-download': postReportDownload,
  'GET /api/orders/{id}': getOrder,
  'POST /api/orders/{id}/revisions': postOrderRevision,
  'POST /api/orders/{id}/edits': postOrderEdits,
  'GET /api/orders/{id}/preview': getOrderPreview,
};

const ADMIN_ROUTES = {
  'GET /api/admin/reports': getAdminReports,
  'POST /api/admin/upload-url': postAdminUploadUrl,
  'POST /api/admin/publish': postAdminPublish,
  'POST /api/admin/update': postAdminUpdate,
  'POST /api/admin/delete': postAdminDelete,
};

exports.publicReportPayload = publicReportPayload; // exported for tests

exports.handler = async (event) => {
  await ensureSecrets();

  const routeKey = event.routeKey || `${event.requestContext?.http?.method} ${event.rawPath}`;
  try {
    if (PUBLIC_ROUTES[routeKey]) return await PUBLIC_ROUTES[routeKey](event);
    if (ADMIN_ROUTES[routeKey]) {
      const denied = requireAdmin(event);
      if (denied) return denied;
      return await ADMIN_ROUTES[routeKey](event);
    }
    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error(`${routeKey}:`, err);
    await reportError(`api ${routeKey}`, err, {
      requestId: event.requestContext?.requestId,
      query: event.rawQueryString,
    });
    return json(500, { error: 'Internal error' });
  }
};
