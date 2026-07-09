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

let cachedClient;

function client() {
  if (cachedClient) return cachedClient;

  if (!ENGINE_URL) throw new Error('PDF_ENGINE_URL is not set');
  const accessKeyId = process.env.AWS_INVOKER_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_INVOKER_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS_INVOKER_ACCESS_KEY_ID / AWS_INVOKER_SECRET_ACCESS_KEY are not set');
  }

  cachedClient = new AwsClient({ accessKeyId, secretAccessKey, region: REGION, service: 'lambda' });
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
    params: { companyCode, aspQueryKey, ...params },
  });

  const res = await client().fetch(`${ENGINE_URL}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const data = await readJson(res);

  if (!res.ok) throw new Error(`engine submitJob ${describeError(res, data)}`);
  if (!data.jobId) throw new Error('engine submitJob: response had no jobId');
  return { jobId: data.jobId };
}

// GET /jobs/{jobId} — job status. status is PENDING | RUNNING | DONE | FAILED
// (NOT_FOUND is synthesised for a 404). On DONE the response carries s3Url.
async function getJob(jobId) {
  if (!jobId) throw new Error('getJob: jobId is required');

  const res = await client().fetch(`${ENGINE_URL}/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
  if (res.status === 404) return { jobId, status: 'NOT_FOUND' };

  const data = await readJson(res);
  if (!res.ok) throw new Error(`engine getJob ${describeError(res, data)}`);

  return {
    jobId: data.jobId || jobId,
    status: data.status,
    outputType: data.outputType,
    s3Url: data.s3Url,
    error: data.error,
    completedAt: data.completedAt,
  };
}

// Download the finished PDF from its presigned S3 URL (no signing needed).
async function downloadPdf(s3Url) {
  if (!s3Url) throw new Error('downloadPdf: s3Url is required');
  const res = await fetch(s3Url);
  if (!res.ok) throw new Error(`engine downloadPdf ${res.status}: ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { submitJob, getJob, downloadPdf };
