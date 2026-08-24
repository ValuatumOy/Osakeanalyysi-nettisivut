// Thin client for the Valuatum PDF report engine.
//
// The engine is an AWS Lambda Function URL in eu-west-1 secured with IAM auth
// (SigV4) — see pdf-report-engine/docs/api.md. There is no API key: every
// request is signed with the `pdf-report-backend-invoker` access key (the
// files.valuatum.com box is hosted outside the engine's AWS account, so an
// instance role is not an option — we sign with static keys via aws4fetch).
//
// The API is asynchronous: submit a job, poll it, download the PDF from a
// presigned S3 URL (valid ~1h). This module wraps those three calls.
const { AwsClient } = require('aws4fetch');

const ENGINE_URL = (process.env.PDF_ENGINE_URL || '').replace(/\/$/, '');
const REGION = process.env.PDF_ENGINE_REGION || 'eu-west-1';
const ASP_QUERY_KEY = process.env.PDF_ENGINE_ASP_QUERY_KEY || 'Wisdom';
const TEMPLATE_NAME = process.env.PDF_ENGINE_TEMPLATE || 'osakeanalyysi';
const USERNAME = process.env.PDF_ENGINE_USERNAME || 'osakeanalyysi-site';

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

// A stalled connection (engine cold start, network stall) must fail fast
// instead of hanging the caller indefinitely: reconciler.js's poll loop only
// checks its own time budget between calls, so one fetch that never resolves
// can outlast that budget and the whole Lambda invocation, up to its hard
// timeout — with nothing logged in between. See fmp-client.js for the same
// pattern applied to the other outbound call in this pipeline.
const REQUEST_TIMEOUT_MS = intEnv('PDF_ENGINE_TIMEOUT_MS', 20 * 1000);
const DOWNLOAD_TIMEOUT_MS = intEnv('PDF_ENGINE_DOWNLOAD_TIMEOUT_MS', 60 * 1000);

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

let cachedClient;

function client() {
  if (!ENGINE_URL) throw new Error('PDF_ENGINE_URL is not set');

  // Prefer the static invoker key pair (the legacy server, outside the engine's AWS
  // account). In Lambda those are absent and we sign with the function role's
  // credentials from the runtime env — including the session token, which
  // temporary credentials require. Role creds rotate mid-lifetime, so the
  // client is rebuilt whenever the key id changes (no stale-cache 403s).
  const staticKeyId = process.env.AWS_INVOKER_ACCESS_KEY_ID;
  const accessKeyId = staticKeyId || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = staticKeyId
    ? process.env.AWS_INVOKER_SECRET_ACCESS_KEY
    : process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = staticKeyId ? undefined : process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('No AWS credentials for the engine: set AWS_INVOKER_ACCESS_KEY_ID / '
      + 'AWS_INVOKER_SECRET_ACCESS_KEY, or run under an AWS role');
  }

  if (!cachedClient || cachedClient.accessKeyId !== accessKeyId) {
    cachedClient = new AwsClient({ accessKeyId, secretAccessKey, sessionToken, region: REGION, service: 'lambda' });
  }
  return cachedClient;
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

function describeError(res, data) {
  return `${res.status}: ${data.error || data.message || res.statusText}`;
}

// POST /jobs — submit a render job. Returns { jobId }.
async function submitJob({
  companyCode,
  templateName = TEMPLATE_NAME,
  username = USERNAME,
  aspQueryKey = ASP_QUERY_KEY,
  output = 'pdf',
  params = {},
} = {}) {
  if (!companyCode) throw new Error('submitJob: companyCode (exchange ticker) is required');

  const body = JSON.stringify({
    username,
    templateName,
    output,
    // The engine defaults to lang 'fi', which only shows in the PDF's own
    // metadata title ("Osakeanalyysi – Intel Corporation") — the report text
    // is English either way, and most readers see that title, not the filename.
    params: { companyCode, aspQueryKey, lang: 'en', ...params },
  });

  const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await client().fetch(`${ENGINE_URL}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
    });
  } finally {
    cancel();
  }
  const data = await readJson(res);

  if (!res.ok) throw new Error(`engine submitJob ${describeError(res, data)}`);
  if (!data.jobId) throw new Error('engine submitJob: response had no jobId');
  return { jobId: data.jobId };
}

// POST /jobs/{jobId}/revisions — revise a DONE job with further comments.
// scope "estimates" turns the comment into forecast values, imports them into
// a new branch model and regenerates the report; the analyst's base model and
// the parent job are never modified. Returns { jobId } for the new (child) job,
// same shape as submitJob — poll it with getJob like any other job.
async function submitRevision({
  parentJobId,
  username = USERNAME,
  comments,
  scope = 'estimates',
} = {}) {
  if (!parentJobId) throw new Error('submitRevision: parentJobId is required');
  if (!comments) throw new Error('submitRevision: comments is required');

  const body = JSON.stringify({ username, comments, scope });

  const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await client().fetch(`${ENGINE_URL}/jobs/${encodeURIComponent(parentJobId)}/revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
    });
  } finally {
    cancel();
  }
  const data = await readJson(res);

  if (!res.ok) throw new Error(`engine submitRevision ${describeError(res, data)}`);
  if (!data.jobId) throw new Error('engine submitRevision: response had no jobId');
  return { jobId: data.jobId };
}

// GET /jobs/{jobId} — job status. status is PENDING | RUNNING | DONE | FAILED
// (NOT_FOUND is synthesised for a 404). On DONE the response carries s3Url.
const RECOMMENDATIONS = new Set(['BUY', 'HOLD', 'SELL']);

/** Only the three the engine issues; anything else is treated as absent rather than shown. */
function normaliseRecommendation(value) {
  const v = String(value || '').trim().toUpperCase();
  return RECOMMENDATIONS.has(v) ? v : null;
}

function cleanStr(value) {
  const v = String(value ?? '').trim();
  return v ? v.slice(0, 40) : null;
}

async function getJob(jobId) {
  if (!jobId) throw new Error('getJob: jobId is required');

  const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await client().fetch(`${ENGINE_URL}/jobs/${encodeURIComponent(jobId)}`, { method: 'GET', signal });
  } finally {
    cancel();
  }
  if (res.status === 404) return { jobId, status: 'NOT_FOUND' };

  const data = await readJson(res);
  if (!res.ok) throw new Error(`engine getJob ${describeError(res, data)}`);

  // The headline is the engine's own output, so it is taken from the job rather than read
  // back out of the PDF. Undefined when the engine does not send it -- every consumer
  // treats it as optional, so this costs nothing until the engine surfaces it.
  const headline = data.headline || {};
  return {
    jobId: data.jobId || jobId,
    status: data.status,
    outputType: data.outputType,
    s3Url: data.s3Url,
    changesUrl: data.changesUrl,
    error: data.error,
    completedAt: data.completedAt,
    recommendation: normaliseRecommendation(data.recommendation ?? headline.recommendation),
    targetPrice: cleanStr(data.targetPrice ?? headline.targetPrice),
    currentPrice: cleanStr(data.currentPrice ?? headline.currentPrice),
  };
}

// Download the finished PDF from its presigned S3 URL (no signing needed).
async function downloadPdf(s3Url) {
  if (!s3Url) throw new Error('downloadPdf: s3Url is required');
  const { signal, cancel } = withTimeout(DOWNLOAD_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(s3Url, { signal });
  } finally {
    cancel();
  }
  if (!res.ok) throw new Error(`engine downloadPdf ${res.status}: ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

// Fetch the change memo for an in-place revision from its presigned URL (see
// "The change memo" in pdf-report-engine/docs/api.md). Best-effort by design
// upstream — the caller should treat a rejection as "no memo" rather than
// failing the whole delivery.
async function fetchChangeMemo(changesUrl) {
  if (!changesUrl) throw new Error('fetchChangeMemo: changesUrl is required');
  const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(changesUrl, { signal });
  } finally {
    cancel();
  }
  if (!res.ok) throw new Error(`engine fetchChangeMemo ${res.status}: ${res.statusText}`);
  return res.json();
}

module.exports = { submitJob, submitRevision, getJob, downloadPdf, fetchChangeMemo };
