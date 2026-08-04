// Task E — synchronous FMP data-import trigger.
//
// Refreshes a single company's data from FinancialModelingPrep into Wisdom just
// before rendering, so a "fresh" report reflects current figures. The Java
// endpoint (DataImportController, provider=FMP) is SYNCHRONOUS: it blocks for
// the whole import (tens of seconds, 5-minute server cap) and returns a terminal
// outcome, so there is nothing to poll. See the fmp-import-java-dependency notes.
//
// Gated by FRESH_IMPORT_ENABLED. Requires FMP_IMPORT_URL (prod wisdom) and a
// bearer token with the Controller.DataImport grant (FMP_IMPORT_TOKEN).

const IMPORT_URL = process.env.FMP_IMPORT_URL || '';
const TOKEN = process.env.FMP_IMPORT_TOKEN || '';
const ASP_ID = process.env.FMP_IMPORT_ASP_ID || '131';

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

// Client-side wait budget; a little above the server's 5-minute cap so the
// server itself decides the timeout (returning 504) rather than us aborting.
const TIMEOUT_MS = intEnv('FMP_IMPORT_TIMEOUT_MS', 6 * 60 * 1000);

// Returns a normalised outcome:
//   { status: 'SUCCESS'|'SKIPPED'|'FAILED'|'TIMEOUT', companyId?, followedModelId?,
//     skipped?, message?, durationMs? }
// Throws only on misconfiguration or a 400/401 (which are our bugs, not FMP's).
async function fmpImport(ticker, { onlyIfNewData = true } = {}) {
  if (!IMPORT_URL) throw new Error('FMP_IMPORT_URL is not set');
  if (!ticker) throw new Error('fmpImport: ticker is required');

  const url = new URL(IMPORT_URL);
  url.searchParams.set('provider', 'FMP');
  url.searchParams.set('aspId', ASP_ID);
  url.searchParams.set('ticker', ticker);
  url.searchParams.set('onlyIfNewData', String(onlyIfNewData));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));

    // 400 (bad ticker/param) and 401 (missing Controller.DataImport grant) are
    // configuration errors on our side -> surface as thrown, not a soft outcome.
    if (res.status === 400 || res.status === 401) {
      throw new Error(`FMP import ${res.status}: ${data.error || res.statusText}`);
    }
    // 504: the server worker keeps running to completion; a later retry with
    // onlyIfNewData=true will SKIP fast. Report TIMEOUT so the caller re-queues.
    if (res.status === 504) {
      return { status: 'TIMEOUT', message: 'import exceeded the server budget; worker continues in the background' };
    }
    // 200 SUCCESS/SKIPPED and 502 FAILED both carry the terminal status in the body.
    return {
      status: data.status || (res.ok ? 'SUCCESS' : 'FAILED'),
      companyId: data.companyId,
      followedModelId: data.followedModelId,
      skipped: data.skipped,
      message: data.message,
      durationMs: data.durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fmpImport };
