const DISPATCH_URL = 'https://api.github.com/repos/ValuatumOy/Osakeanalyysi-nettisivut/actions/workflows/report-pages-sync.yml/dispatches';

// Best-effort wake-up only: the caller handles failures; the hourly sync recovers.
// The token needs Actions: write for this repository, stored as a SecureString at
// `${SECRETS_SSM_PREFIX}/report-pages-dispatch-token` (or injected for local tests).
async function dispatchReportPages({
  env = process.env,
  stage = env.STAGE || 'prod',
  fetchImpl = globalThis.fetch,
  ssmClient,
  timeoutMs = 5000,
} = {}) {
  if (stage !== 'prod' && stage !== 'test') throw new Error('Report page dispatch: unsupported stage.');
  const ref = stage === 'test' ? 'staging' : 'main';
  let token = (env.REPORT_PAGES_DISPATCH_TOKEN || '').trim();
  const prefix = (env.SECRETS_SSM_PREFIX || '').replace(/\/+$/, '');
  if (!token && !prefix) return { dispatched: false, reason: 'unconfigured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (!token) {
      try {
        const { GetParameterCommand } = require('@aws-sdk/client-ssm');
        const client = ssmClient || require('./aws/clients').ssm();
        const result = await client.send(new GetParameterCommand({
          Name: `${prefix}/report-pages-dispatch-token`,
          WithDecryption: true,
        }), { abortSignal: controller.signal });
        token = (result.Parameter?.Value || '').trim();
      } catch (error) {
        if (controller.signal.aborted) throw new Error('Report page dispatch timed out.');
        if (error.name === 'ParameterNotFound') return { dispatched: false, reason: 'missing-token' };
        throw new Error('Report page dispatch failed (SSM token lookup).');
      }
      if (!token) return { dispatched: false, reason: 'missing-token' };
    }

    let response;
    try {
      response = await fetchImpl(DISPATCH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        body: JSON.stringify({ ref }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (_) {
      if (controller.signal.aborted) throw new Error('Report page dispatch timed out.');
      throw new Error('Report page dispatch failed (GitHub request).');
    }
    if (!response.ok) throw new Error(`Report page dispatch failed (GitHub HTTP ${response.status}).`);
    return { dispatched: true, ref };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { dispatchReportPages };
