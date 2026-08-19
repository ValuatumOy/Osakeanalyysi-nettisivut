const { getReportByIdSync, getPublicReportsSync, recordCatalogPurchase: recordLocalPurchase } = require('./catalog');
const READY_REPORT_PRICE = 20;

function catalogBaseUrl() {
  return (process.env.CATALOG_API_URL || '').replace(/\/$/, '');
}

// The catalog may carry site-relative pdfUrls. reports.html prefixes them
// itself, but the purchase flow does not: the success page assigns pdfUrl
// straight to an href (resolving against /checkout/) and the confirmation email
// has no base URL at all. Normalizing here — the one point every catalog report
// passes through — keeps both correct.
function absolutePdfUrl(pdfUrl) {
  if (!pdfUrl) return pdfUrl;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(pdfUrl)) return pdfUrl;
  const site = (process.env.SITE_URL || 'https://valuatum.com').replace(/\/+$/, '');
  return `${site}/${String(pdfUrl).replace(/^\/+/, '')}`;
}

function toBackendReport(report) {
  const normalized = normalizeCatalogReport(report);
  if (!normalized) return null;
  return {
    id: normalized.id,
    name: normalized.name || normalized.companyName,
    companyName: normalized.companyName || normalized.name,
    ticker: normalized.ticker || '',
    exchange: normalized.exchange || '',
    reportDate: normalized.reportDateLabel || normalized.reportDate,
    reportDateIso: normalized.reportDate,
    pdfUrl: normalized.pdfUrl,
    price: normalized.price,
    isFree: normalized.isFree,
    reportType: normalized.reportType,
    fileName: normalized.fileName,
    revisable: Boolean(normalized.revisable),
  };
}

function normalizeCatalogReport(report) {
  if (!report) return null;
  const isFree = Boolean(report.isFree) || report.reportType === 'free' || Number(report.price) === 0;
  return {
    ...report,
    pdfUrl: absolutePdfUrl(report.pdfUrl),
    isFree,
    reportType: isFree ? 'free' : (report.reportType || 'existing'),
    price: isFree ? 0 : READY_REPORT_PRICE,
    priceLabel: isFree ? (report.priceLabel || 'Free report') : 'Ready report',
    creditCost: isFree ? 0 : (report.creditCost || 2),
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // .status lets callers (the order-page proxy endpoints) forward a
    // meaningful code — 409 for a double-submit, 402/404 — instead of
    // collapsing every backend error to a generic 500.
    const err = new Error(data.error || `Catalog API failed with ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function getCatalogReport(reportId) {
  const base = catalogBaseUrl();

  if (base) {
    try {
      const data = await fetchJson(`${base}/api/reports/${encodeURIComponent(reportId)}`);
      return toBackendReport(data.report || data);
    } catch (err) {
      console.warn('Catalog API report lookup failed, using local fallback:', err.message);
    }
  }

  return toBackendReport(getReportByIdSync(reportId, { persistState: false }));
}

async function getCatalogReports() {
  const base = catalogBaseUrl();

  if (base) {
    try {
      const data = await fetchJson(`${base}/api/reports`);
      return Array.isArray(data.reports) ? data.reports.map(normalizeCatalogReport).filter(Boolean) : [];
    } catch (err) {
      console.warn('Catalog API list failed, using local fallback:', err.message);
    }
  }

  return getPublicReportsSync({ persistState: false }).map(normalizeCatalogReport).filter(Boolean);
}

const SYNC_ATTEMPTS = 3;
const SYNC_RETRY_BASE_MS = 250;

// Sync a paid purchase to the catalog backend. This must NOT fail silently:
// on Vercel the "local fallback" writes to an ephemeral disk, which for a
// fresh order means a paid report that never gets generated. So when a
// backend is configured, failure here retries, alerts the admin, and THROWS —
// the webhook returns 500 and Stripe redelivers the event (the backend is
// idempotent on the session id). The local write remains only for
// environments with no backend configured (local dev, tests).
async function recordCatalogPurchase(purchase) {
  const base = catalogBaseUrl();
  const secret = process.env.CATALOG_SYNC_SECRET || '';

  if (!base || !secret) {
    recordLocalPurchase(purchase);
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= SYNC_ATTEMPTS; attempt += 1) {
    try {
      await fetchJson(`${base}/api/report-purchases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(purchase),
      });
      return;
    } catch (err) {
      lastError = err;
      console.warn(`Catalog purchase sync attempt ${attempt}/${SYNC_ATTEMPTS} failed:`, err.message);
      if (attempt < SYNC_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, SYNC_RETRY_BASE_MS * attempt));
      }
    }
  }

  console.error('Catalog purchase sync FAILED after retries:', lastError.message, {
    sessionId: purchase?.sessionId, type: purchase?.type,
  });
  try {
    const { sendAdminAlert } = require('./email');
    await sendAdminAlert('Purchase sync to the catalog API failed', [
      `Session: ${purchase?.sessionId || 'unknown'}`,
      `Type: ${purchase?.type || 'existing'} — ${purchase?.companyName || purchase?.reportId || ''}`,
      `Customer: ${purchase?.customerEmail || 'unknown'}`,
      `Error: ${lastError.message}`,
      'The webhook returned 500, so Stripe will retry the event automatically.',
    ]);
  } catch (alertErr) {
    console.error('Purchase-sync failure alert email also failed:', alertErr.message);
  }
  throw new Error(`Catalog purchase sync failed after ${SYNC_ATTEMPTS} attempts: ${lastError.message}`);
}

// Ask the backend for a short-lived signed download URL. The caller must have
// already established that this buyer is entitled to the report — the shared
// secret is what lets us mint the URL, not proof of purchase.
async function requestReportDownload(reportId) {
  const base = catalogBaseUrl();
  const secret = process.env.CATALOG_SYNC_SECRET || '';
  if (!base || !secret) {
    throw new Error('CATALOG_API_URL / CATALOG_SYNC_SECRET are not configured — cannot sign a download');
  }
  return fetchJson(`${base}/api/report-download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ reportId }),
  });
}

// Order-page state for a "+ Revisions" order (fresh or ready). The order id
// is the Stripe checkout session id, same as everywhere else in this file.
async function getOrderState(orderId) {
  const base = catalogBaseUrl();
  const secret = process.env.CATALOG_SYNC_SECRET || '';
  if (!base || !secret) {
    throw new Error('CATALOG_API_URL / CATALOG_SYNC_SECRET are not configured — cannot read order state');
  }
  return fetchJson(`${base}/api/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
}

// Submit a forecast-revision request. The caller must have already verified
// the buyer's Stripe session — the shared secret only authorizes the backend
// call, it is not proof of purchase on its own.
async function submitOrderRevision(orderId, comments) {
  const base = catalogBaseUrl();
  const secret = process.env.CATALOG_SYNC_SECRET || '';
  if (!base || !secret) {
    throw new Error('CATALOG_API_URL / CATALOG_SYNC_SECRET are not configured — cannot submit a revision');
  }
  return fetchJson(`${base}/api/orders/${encodeURIComponent(orderId)}/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ comments }),
  });
}

module.exports = {
  getCatalogReport,
  getCatalogReports,
  recordCatalogPurchase,
  requestReportDownload,
  getOrderState,
  submitOrderRevision,
  normalizeCatalogReport,
  toBackendReport,
};
