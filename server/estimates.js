// Customer forecast editing against the Valuatum Trunk REST API.
//
// Two halves:
//
//   read  — resolve a company's followed model and pull its net sales / EBIT
//           series, which is what the order page's forecast grid displays.
//   write — apply the customer's edited values on top of that model. The import
//           does not modify the base model: it generates a brand-new one and
//           returns its fid, which the render job is then pinned to.
//
// Semantics are ported from the internal tool (ai-stock-analysis,
// backend/src/services/estimates-import.ts + financial-data.ts), which in turn
// took them from the arvonmääritys implementation. They are proven against the
// live API and deliberately not re-derived here.
//
// One deliberate difference: the import is split into submit + single poll
// rather than a blocking loop. A cold import measured ~99 s upstream but has no
// guaranteed ceiling, and the worker Lambda's invocation is capped at 10
// minutes. The caller stores the job id and resumes polling on a later
// invocation, so running out of time costs a wait instead of a second import.
//
// IMPORTANT: never run POST /estimates/generate on the fid an import returned.
// That model's values ARE the customer's forecasts, and generation would
// overwrite them.

const POLL_INTERVAL_MS = 10000;
const REQUEST_TIMEOUT_MS = 20000;
const GENERATE_DEADLINE_MS = 300000;
// Wall-clock budget for an import, measured by the caller against the time it
// first submitted the job — not against a single invocation.
const IMPORT_DEADLINE_MS = 600000;

// Forecast horizon the grid shows and lets the customer edit. Trunk models carry
// annual poses far past anything reviewed by hand (Neste's runs to 2035); beyond
// this the grid stops fitting on screen.
const MAX_ESTIMATE_YEARS = 9;
// Actualized years shown read-only for context. Three is enough to make the
// growth-% view meaningful without pushing the editable columns off-screen.
const HISTORY_YEARS = 3;

// Mirrors the server-side forecast-import allowlist. Anything else is rejected
// here rather than discovered upstream after a slow, uncancellable import.
const ALLOWED_VARNAMES = new Set(['ns', 'ebit']);

// The analyst whose model to prefer when a company has several. Matches the
// internal tool's default.
const PREFERRED_ANALYST_NAME = () => process.env.VALUATUM_PREFERRED_ANALYST || 'ValuatumDataSources';

// Deliberately NOT WISDOM_REST_BASE: that one also drives the fresh-order
// company search picker, and repointing it at a different environment would
// silently change which companies customers can buy.
function restBase() {
  const base = process.env.VALUATUM_TRUNK_URL || process.env.WISDOM_REST_BASE || '';
  return base.replace(/\/+$/, '');
}

function token() {
  return process.env.VALUATUM_TRUNK_TOKEN || process.env.WISDOM_API_TOKEN || '';
}

// Feature gate: the forecast gate needs the flag AND somewhere to talk to.
function estimatesConfigured() {
  return /^(1|true|yes|on)$/i.test(process.env.FORECAST_GATE_ENABLED || '')
    && Boolean(restBase() && token());
}

// 400 = the customer can fix it (a bad value, an out-of-range year).
// 502 = upstream failed; the order returns to an editable state and can retry.
class EstimatesError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'EstimatesError';
    this.status = status;
  }
}

async function trunkFetch(path, init = {}) {
  const base = restBase();
  if (!base || !token()) {
    throw new EstimatesError('VALUATUM_TRUNK_URL / WISDOM_API_TOKEN are not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...init.headers,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new EstimatesError(`trunk request to ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new EstimatesError(`trunk request to ${path} failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Pull the human-readable message out of an error body, falling back to the raw
// text so an unexpected shape is still diagnosable from the logs.
async function errorDetail(res) {
  const body = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(body);
    for (const key of ['error', 'message', 'detail']) {
      if (typeof parsed[key] === 'string' && parsed[key]) return parsed[key];
    }
  } catch (_) {
    // not JSON — fall through to the raw body
  }
  return body.slice(0, 500);
}

// ── reads ────────────────────────────────────────────────────────────────────

// Resolve the followed model for a ticker: the preferred analyst's model when
// the company has one, otherwise the first. A ticker can match several company
// entries (NESTE and NESTE.HE are separate rows upstream), so the exact ticker
// the order carries is what gets sent.
async function resolveFollowedModelId(ticker) {
  if (!ticker) throw new EstimatesError('resolveFollowedModelId: ticker is required', 400);

  const res = await trunkFetch(`/rest/company?ticker=${encodeURIComponent(ticker)}`, { method: 'GET' });
  if (!res.ok) {
    throw new EstimatesError(`company lookup failed (${res.status}): ${await errorDetail(res)}`);
  }

  const companies = await res.json().catch(() => null);
  if (!Array.isArray(companies) || companies.length === 0) {
    throw new EstimatesError(`no company found for ticker ${ticker}`);
  }

  // Prefer an exact ticker match before falling back to the first row, so
  // "NESTE.HE" cannot silently resolve to the "NESTE" company's model.
  const wanted = String(ticker).toUpperCase();
  const company = companies.find(c => String(c.ticker || '').toUpperCase() === wanted) || companies[0];

  const models = company.models || [];
  if (models.length === 0) throw new EstimatesError(`no models found for ticker ${ticker}`);

  const preferred = models.find(m => m.analystName === PREFERRED_ANALYST_NAME());
  const chosen = preferred || models[0];
  if (models.length > 1) {
    console.log(
      `estimates: ${ticker} has ${models.length} models `
      + `(${models.map(m => `${m.followedModelId}:${m.analystName || '?'}`).join(', ')}) — `
      + `picked ${chosen.followedModelId}${preferred ? ' [preferred analyst]' : ' [fallback: first]'}`,
    );
  }

  const fid = Number(chosen.followedModelId);
  if (!Number.isInteger(fid) || fid <= 0) {
    throw new EstimatesError(`ticker ${ticker} resolved to an invalid model id: ${chosen.followedModelId}`);
  }
  return fid;
}

// An annual pose is a bare year; quarterly poses are YYYYQ and the terminal
// value is "0".
function isAnnual(pos) {
  return /^\d{4}$/.test(pos);
}

// The editable forecast grid for one model. Values are absolute, in millions of
// the model currency — exactly the unit POST /estimates/import expects, so
// nothing is converted on the way in or out.
async function fetchEstimateSeries(fid) {
  const res = await trunkFetch('/rest/modeldata', {
    method: 'POST',
    body: JSON.stringify({
      fids: [Number(fid)],
      varPoses: [],
      includeHistoryData: true,
      includeEstimates: true,
    }),
  });
  if (!res.ok) {
    throw new EstimatesError(`model data fetch failed (${res.status}): ${await errorDetail(res)}`);
  }

  const payload = await res.json().catch(() => null);
  const model = payload && payload[String(fid)];
  if (!model) throw new EstimatesError(`no model data found for fid ${fid}`);

  const currentYear = model.currentYear != null ? model.currentYear : model.currentyear;
  if (currentYear == null) throw new EstimatesError(`model ${fid} has no currentYear`);

  const dataMap = model.dataMap || {};
  const annualYears = Object.keys(dataMap).filter(isAnnual).map(Number).sort((a, b) => a - b);

  const lastEstimateYear = annualYears[annualYears.length - 1];
  if (lastEstimateYear == null || lastEstimateYear < currentYear) {
    throw new EstimatesError(`model ${fid} has no estimate years`);
  }

  const historyYears = annualYears.filter(y => y < currentYear).slice(-HISTORY_YEARS);

  // A contiguous range rather than only the poses present in dataMap: a year the
  // model happens to skip must stay editable, or the contiguous fill on import
  // would demand a value for a year the customer was never allowed to set.
  const lastShownYear = Math.min(lastEstimateYear, currentYear + MAX_ESTIMATE_YEARS - 1);
  const estimateYears = [];
  for (let y = currentYear; y <= lastShownYear; y += 1) estimateYears.push(y);

  const series = { ns: {}, ebit: {} };
  for (const year of [...historyYears, ...estimateYears]) {
    for (const varname of ALLOWED_VARNAMES) {
      const value = (dataMap[String(year)] || {})[varname];
      series[varname][String(year)] = typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
  }

  return {
    fid: Number(fid),
    companyName: model.companyName || null,
    currency: model.currency || null,
    firstEstimateYear: currentYear,
    historyYears,
    estimateYears,
    series,
  };
}

// ── validation ───────────────────────────────────────────────────────────────

// Cheap checks before the slow, uncancellable import. Trunk validates
// authoritatively; this keeps the obvious mistakes at a fast 400. The same
// function guards manual grid edits and AI-proposed ones — an AI proposal gets
// no privileged path.
function validateEstimateEdits(edits, estimateYears) {
  if (!Array.isArray(edits)) {
    throw new EstimatesError('values must be an array', 400);
  }

  const seen = new Set();
  for (const edit of edits) {
    const { varname, year, value } = edit || {};
    if (!ALLOWED_VARNAMES.has(varname)) {
      throw new EstimatesError(
        `varname must be one of: ${[...ALLOWED_VARNAMES].join(', ')} (got ${JSON.stringify(varname)})`,
        400,
      );
    }
    if (!Number.isInteger(year) || !estimateYears.includes(year)) {
      throw new EstimatesError(
        `year ${JSON.stringify(year)} is not an editable estimate year (${estimateYears.join(', ')})`,
        400,
      );
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new EstimatesError(`value for ${varname} ${year} must be a finite number`, 400);
    }
    if (varname === 'ns' && value <= 0) {
      throw new EstimatesError(`net sales for ${year} must be positive`, 400);
    }
    const key = `${varname}:${year}`;
    if (seen.has(key)) {
      throw new EstimatesError(`duplicate value for ${key}`, 400);
    }
    seen.add(key);
  }
  return edits;
}

// The import applies values year by year and stops at the first year with no
// value, so sending only the changed cells (say 2027-2029) drops them when an
// earlier year has none — verified end to end upstream. Per edited varname, emit
// a contiguous block from the first estimate year through the last edited year,
// filling untouched years with their current model value. Harmless if the
// upstream behaviour is ever fixed: baseline values are a no-op.
function buildContiguousValues(edits, baseline, firstEstimateYear) {
  const byVarname = new Map();
  for (const { varname, year, value } of edits) {
    if (!byVarname.has(varname)) byVarname.set(varname, new Map());
    byVarname.get(varname).set(year, value);
  }

  const values = [];
  for (const [varname, edited] of byVarname) {
    const lastEditedYear = Math.max(...edited.keys());
    for (let year = firstEstimateYear; year <= lastEditedYear; year += 1) {
      const own = edited.get(year);
      const value = own !== undefined ? own : (baseline[varname] || {})[String(year)];
      if (value == null) {
        throw new EstimatesError(
          `cannot fill ${varname} ${year}: the model has no value for it — edit that year explicitly`,
          400,
        );
      }
      values.push({ varname, year, value });
    }
  }
  return values;
}

// ── jobs ─────────────────────────────────────────────────────────────────────

function jobIdOf(payload) {
  const jobId = Number(payload && payload.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new EstimatesError(`estimates job returned an invalid jobId: ${JSON.stringify(payload && payload.jobId)}`);
  }
  return jobId;
}

function statusOf(payload) {
  return String((payload && payload.status) || '').toUpperCase();
}

// Normalise one job poll into { status, resultFid, errorMessage }, rejecting
// anything that isn't a status we know how to act on. An unrecognised status is
// an error rather than "keep waiting": waiting forever on a status we cannot
// interpret is how an order silently stalls.
function normaliseJob(payload, jobId) {
  const status = statusOf(payload);
  if (status === 'OK') {
    const resultFid = payload.resultFid == null ? null : Number(payload.resultFid);
    return { status, resultFid, errorMessage: null };
  }
  if (status === 'ERROR') {
    return { status, resultFid: null, errorMessage: payload.errorMessage || 'unknown error' };
  }
  if (status === 'PENDING' || status === 'RUNNING') {
    return { status, resultFid: null, errorMessage: null };
  }
  throw new EstimatesError(`estimates job ${jobId} returned an unknown status: ${status || '(empty)'}`);
}

// Submit the customer's values on top of `baseFid`. Returns the job id; the
// caller stores it and polls with pollForecastImport.
async function submitForecastImport(baseFid, values) {
  const res = await trunkFetch('/rest/estimates/import', {
    method: 'POST',
    body: JSON.stringify({ baseFid: Number(baseFid), values }),
  });
  if (res.status !== 200 && res.status !== 202) {
    throw new EstimatesError(`estimates import was rejected (${res.status}): ${await errorDetail(res)}`);
  }

  const payload = await res.json().catch(() => ({}));
  const jobId = jobIdOf(payload);
  // A job can come back already finished; hand the caller that first state so a
  // fast import needs no extra round trip.
  return { jobId, ...normaliseJob(payload, jobId) };
}

// One poll of a running import. Returns the same shape as submitForecastImport
// so the caller's state machine has a single case to handle.
async function pollForecastImport(jobId) {
  const res = await trunkFetch(`/rest/estimates/imports/${encodeURIComponent(jobId)}`, { method: 'GET' });
  if (res.status === 404) {
    throw new EstimatesError(`estimates import job ${jobId} disappeared while polling`);
  }
  if (res.status !== 200) {
    throw new EstimatesError(`estimates import polling failed (${res.status}): ${await errorDetail(res)}`);
  }

  const payload = await res.json().catch(() => ({}));
  // A mismatched job id means we are reading someone else's import; treat it as
  // an error rather than acting on the wrong result fid.
  if (jobIdOf(payload) !== Number(jobId)) {
    throw new EstimatesError(
      `estimates import polling returned the wrong job (expected ${jobId}, got ${payload.jobId})`,
    );
  }

  const job = normaliseJob(payload, jobId);
  if (job.status === 'OK' && (!Number.isInteger(job.resultFid) || job.resultFid <= 0)) {
    throw new EstimatesError(`estimates import job ${jobId} finished without a valid resultFid`);
  }
  return { jobId: Number(jobId), ...job };
}

// (Re)generate a model's own estimates. Run before the customer reviews them —
// a data import alone does not refresh them upstream. Blocking: this one is
// bounded at 5 minutes and only ever runs during PREPARING, where the worker has
// nothing else to do for this order.
//
// Base analyst model ONLY. Never the fid an import returned; see the module note.
async function generateEstimates(fid, { now = () => Date.now(), sleep = defaultSleep } = {}) {
  const deadline = now() + GENERATE_DEADLINE_MS;

  const res = await trunkFetch(`/rest/estimates/generate/${encodeURIComponent(fid)}`, { method: 'POST' });
  if (res.status !== 200 && res.status !== 202) {
    throw new EstimatesError(`estimate generation was rejected (${res.status}): ${await errorDetail(res)}`);
  }

  let payload = await res.json().catch(() => ({}));
  const jobId = jobIdOf(payload);

  for (;;) {
    const job = normaliseJob(payload, jobId);
    if (job.status === 'OK') {
      console.log(`estimates: generation job ${jobId} OK — fid=${fid}`);
      return;
    }
    if (job.status === 'ERROR') {
      throw new EstimatesError(`estimate generation failed (job ${jobId}): ${job.errorMessage}`);
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new EstimatesError(
        `estimate generation job ${jobId} timed out after ${GENERATE_DEADLINE_MS / 1000}s`,
      );
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));

    const poll = await trunkFetch(`/rest/estimates/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
    if (poll.status === 404) {
      throw new EstimatesError(`estimate generation job ${jobId} disappeared while polling`);
    }
    if (poll.status !== 200) {
      throw new EstimatesError(`estimate generation polling failed (${poll.status}): ${await errorDetail(poll)}`);
    }
    payload = await poll.json().catch(() => ({}));
    if (jobIdOf(payload) !== jobId) {
      throw new EstimatesError(
        `estimate generation polling returned the wrong job (expected ${jobId}, got ${payload.jobId})`,
      );
    }
  }
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  EstimatesError,
  ALLOWED_VARNAMES,
  MAX_ESTIMATE_YEARS,
  HISTORY_YEARS,
  POLL_INTERVAL_MS,
  IMPORT_DEADLINE_MS,
  GENERATE_DEADLINE_MS,
  estimatesConfigured,
  resolveFollowedModelId,
  fetchEstimateSeries,
  validateEstimateEdits,
  buildContiguousValues,
  submitForecastImport,
  pollForecastImport,
  generateEstimates,
};
