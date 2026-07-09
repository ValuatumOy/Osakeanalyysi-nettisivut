// Fresh-report reconciler (Task D).
//
// A single-flight background loop that walks each pending order through the
// generation state machine and delivers the finished PDF:
//
//   NEW ─(FRESH_IMPORT_ENABLED)→ IMPORTING → RENDERING ─poll→ DELIVERED | FAILED
//
// It runs inside the always-on Express process (started from index.js). Because
// a fresh FMP import can block up to ~5 minutes and rendering is polled across
// ticks, a run in progress blocks the next tick from re-entering (single-flight).
//
// Delivery publishes to the catalog with no catalog code change: it writes the
// PDF plus a sidecar into REPORT_PDF_DIR, marked hidden + excludeFromFree, so the
// buyer gets it by email now and Phase 2 resale is a later flag-flip. Admin is
// emailed on failure always, and on success when ADMIN_NOTIFY_ON_SUCCESS is set.

const fs = require('fs');
const path = require('path');

const engine = require('./engine-client');
const email = require('./email');
const orders = require('./orders');
const fmp = require('./fmp-client');

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

const INTERVAL_MS = intEnv('RECONCILER_INTERVAL_MS', 45000);
const MAX_POLLS = intEnv('RECONCILER_MAX_POLLS', 40);
const MAX_ATTEMPTS = intEnv('RECONCILER_MAX_ATTEMPTS', 6);
const FRESH_IMPORT_ENABLED = boolEnv('FRESH_IMPORT_ENABLED', false);
const ADMIN_NOTIFY_ON_SUCCESS = boolEnv('ADMIN_NOTIFY_ON_SUCCESS', true);

const PDF_DIR = process.env.REPORT_PDF_DIR || '/var/www/html/reports/pdfs';
const PDF_BASE_URL = (process.env.REPORT_PDF_BASE_URL || 'https://files.valuatum.com/reports/pdfs').replace(/\/$/, '');

// Yahoo/FMP-style exchange suffix on the ticker (SYMBOL.EXCHANGE) -> a short
// market label (city, matching the existing Nordic style so the catalog market
// filter does not fragment) and the country. A US listing has no suffix.
const EXCHANGE_BY_SUFFIX = {
  // Nordics
  HE: 'Helsinki', ST: 'Stockholm', OL: 'Oslo', CO: 'Copenhagen', IC: 'Iceland',
  // Rest of Europe
  L: 'London', PA: 'Paris', AS: 'Amsterdam', BR: 'Brussels', DE: 'Frankfurt',
  F: 'Frankfurt', MI: 'Milan', MC: 'Madrid', SW: 'Zurich',
  // Americas
  TO: 'Toronto', V: 'Toronto', SA: 'Sao Paulo', SN: 'Santiago',
  // Asia-Pacific
  HK: 'Hong Kong', T: 'Tokyo', SS: 'Shanghai', SZ: 'Shenzhen',
  NS: 'Mumbai', BO: 'Mumbai', JK: 'Jakarta', TW: 'Taipei', AX: 'Sydney',
};
const COUNTRY_BY_SUFFIX = {
  HE: 'Finland', ST: 'Sweden', OL: 'Norway', CO: 'Denmark', IC: 'Iceland',
  L: 'United Kingdom', PA: 'France', AS: 'Netherlands', BR: 'Belgium',
  DE: 'Germany', F: 'Germany', MI: 'Italy', MC: 'Spain', SW: 'Switzerland',
  TO: 'Canada', V: 'Canada', SA: 'Brazil', SN: 'Chile',
  HK: 'Hong Kong', T: 'Japan', SS: 'China', SZ: 'China',
  NS: 'India', BO: 'India', JK: 'Indonesia', TW: 'Taiwan', AX: 'Australia',
};

function tickerSuffix(ticker) {
  const parts = String(ticker || '').split('.');
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
}

function deriveExchange(ticker) {
  const suffix = tickerSuffix(ticker);
  if (EXCHANGE_BY_SUFFIX[suffix]) return EXCHANGE_BY_SUFFIX[suffix];
  // No suffix = US listing (NYSE/Nasdaq, both New York); unknown suffix = raw.
  return suffix || 'New York';
}

function deriveCountry(ticker) {
  const suffix = tickerSuffix(ticker);
  if (COUNTRY_BY_SUFFIX[suffix]) return COUNTRY_BY_SUFFIX[suffix];
  return suffix ? '' : 'United States';
}

// Filesystem-safe company token for the report filename: strip diacritics and
// punctuation, PascalCase the words. "Stora Enso" -> "StoraEnso".
function companyToken(name) {
  const cleaned = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
  if (!cleaned) return 'Report';
  return cleaned.split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

function writeFileAtomic(filePath, buffer) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, filePath);
}

// Terminal failure: mark FAILED and email the admin to generate manually.
async function fail(order, reason) {
  orders.update(order.id, {
    status: orders.STATUS.FAILED,
    error: reason,
    attempts: (order.attempts || 0) + 1,
  });
  console.warn('reconciler: order failed', { id: order.id, reason });
  try {
    await email.sendAdminNotification(
      { company: order.companyName, ticker: order.ticker, exchange: order.exchange, error: reason },
      order.email,
    );
  } catch (err) {
    console.warn('reconciler: admin failure notice failed:', err.message);
  }
}

// DONE job -> download, publish (PDF + sidecar), email buyer, mark DELIVERED.
async function deliver(order, job) {
  const pdf = await engine.downloadPdf(job.s3Url);

  const now = new Date();
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  const dateToken = `${dd}${mm}${yyyy}`;
  const reportDateIso = `${yyyy}-${mm}-${dd}`;

  const fileBase = `${companyToken(order.companyName || order.ticker)}_${dateToken}`;
  const pdfFileName = `${fileBase}.pdf`;
  const exchange = order.exchange || deriveExchange(order.ticker);
  const companyLabel = order.companyName || order.ticker;

  fs.mkdirSync(PDF_DIR, { recursive: true });
  writeFileAtomic(path.join(PDF_DIR, pdfFileName), pdf);

  // Sidecar consumed by catalog.js at runtime. hidden + excludeFromFree keep a
  // just-purchased report off the public site and out of the free rotation;
  // provenance links it back to the order and engine job for Phase 2.
  const sidecar = {
    companyName: companyLabel,
    ticker: order.ticker || '',
    exchange,
    country: deriveCountry(order.ticker),
    sector: order.sector || undefined,
    reportDate: reportDateIso,
    description: `AI equity report for ${companyLabel}, generated ${reportDateIso}.`,
    tags: ['AI Equity Report', 'PDF'],
    hidden: true,
    excludeFromFree: true,
    provenance: { sessionId: order.id, jobId: order.jobId },
  };
  writeFileAtomic(path.join(PDF_DIR, `${fileBase}.json`), Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`));

  const pdfUrl = `${PDF_BASE_URL}/${encodeURIComponent(pdfFileName)}`;

  if (order.email) {
    await email.sendReportEmail(order.email, {
      name: companyLabel,
      ticker: order.ticker,
      reportDate: reportDateIso,
      pdfUrl,
    });
  } else {
    console.warn('reconciler: delivered PDF but order has no email', { id: order.id, pdfFileName });
  }

  // Mark DELIVERED before the admin FYI: the buyer email already went out, and
  // DELIVERED removes the order from listPending so it is never re-processed.
  orders.update(order.id, { status: orders.STATUS.DELIVERED, pdfFileName, error: null });
  console.log('reconciler: delivered', { id: order.id, pdfFileName });

  if (ADMIN_NOTIFY_ON_SUCCESS) {
    try {
      await email.sendAdminDeliveryNotice({
        company: companyLabel, ticker: order.ticker, exchange, customerEmail: order.email, pdfUrl,
      });
    } catch (err) {
      console.warn('reconciler: admin delivery notice failed:', err.message);
    }
  }
}

// Advance one order by one step. Throwing signals a TRANSIENT error (network,
// etc.) -> the order keeps its status and is retried next tick until MAX_ATTEMPTS.
// Terminal problems call fail() and return.
async function advance(order) {
  if ((order.attempts || 0) >= MAX_ATTEMPTS) {
    return fail(order, `exceeded ${MAX_ATTEMPTS} retry attempts (last error: ${order.error || 'unknown'})`);
  }

  if (order.status === orders.STATUS.NEW || order.status === orders.STATUS.IMPORTING) {
    if (!order.ticker) return fail(order, 'no ticker resolved for this order');

    // Optional fresh FMP import before rendering (Task E, flag-gated).
    if (FRESH_IMPORT_ENABLED && order.importStatus == null) {
      orders.update(order.id, { status: orders.STATUS.IMPORTING });
      const outcome = await fmp.fmpImport(order.ticker); // blocking, terminal
      if (outcome.status === 'FAILED') {
        return fail(order, `FMP import failed: ${outcome.message || 'unknown error'}`);
      }
      if (outcome.status === 'TIMEOUT') {
        // Worker still running server-side; leave in IMPORTING and retry (a
        // later call will SKIP quickly once the import has finished).
        orders.update(order.id, { attempts: (order.attempts || 0) + 1 });
        return;
      }
      orders.update(order.id, { importStatus: outcome.status }); // SUCCESS | SKIPPED
    }

    const { jobId } = await engine.submitJob({ companyCode: order.ticker });
    orders.update(order.id, { status: orders.STATUS.RENDERING, jobId, polls: 0, error: null });
    return;
  }

  if (order.status === orders.STATUS.RENDERING) {
    if (!order.jobId) return fail(order, 'order is RENDERING but has no jobId');

    const job = await engine.getJob(order.jobId);

    if (job.status === 'DONE') {
      if (!job.s3Url) return; // presigned URL not minted yet; re-fetch next tick
      return deliver(order, job);
    }
    if (job.status === 'FAILED' || job.status === 'NOT_FOUND') {
      return fail(order, `engine job ${job.status}${job.error ? `: ${job.error}` : ''}`);
    }

    // PENDING / RUNNING -> keep waiting, bounded by MAX_POLLS.
    const polls = (order.polls || 0) + 1;
    if (polls > MAX_POLLS) {
      return fail(order, `render did not finish within ${MAX_POLLS} polls`);
    }
    orders.update(order.id, { polls });
    return;
  }
}

let running = false;

// One reconciliation pass over all pending orders. Single-flight: a pass already
// in progress makes this a no-op (returns false).
async function tick() {
  if (running) return false;
  running = true;
  try {
    for (const order of orders.listPending()) {
      try {
        await advance(order);
      } catch (err) {
        // Transient: bump attempts, keep status, retry next tick.
        console.error(`reconciler: transient error on order ${order.id}:`, err.message);
        try {
          orders.update(order.id, { error: err.message, attempts: (order.attempts || 0) + 1 });
        } catch (updateErr) {
          console.error('reconciler: could not record error for', order.id, updateErr.message);
        }
      }
    }
    return true;
  } finally {
    running = false;
  }
}

function start() {
  if (!process.env.PDF_ENGINE_URL) {
    console.warn('Reconciler not started: PDF_ENGINE_URL is not set');
    return null;
  }
  console.log(
    `Reconciler started (interval ${INTERVAL_MS}ms, fresh import ${FRESH_IMPORT_ENABLED ? 'ON' : 'off'}, ` +
    `admin-on-success ${ADMIN_NOTIFY_ON_SUCCESS ? 'on' : 'off'})`,
  );
  const timer = setInterval(() => {
    tick().catch(err => console.error('reconciler: tick error:', err.message));
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { start, tick, advance, deliver, fail, companyToken, deriveExchange, deriveCountry };
