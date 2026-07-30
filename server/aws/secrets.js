// SSM Parameter Store secrets (plan §2.2 item 4). CDK sets SECRETS_SSM_PREFIX
// (e.g. /aiequityreports/prod); at cold start the handler awaits
// ensureSecrets(), which loads the SecureStrings below into process.env so the
// existing server/ modules read them exactly as they always have. Values
// already present in the environment are never overwritten (local dev, tests).

const { GetParametersCommand } = require('@aws-sdk/client-ssm');
const { ssm } = require('./clients');

const SECRET_ENV_BY_NAME = {
  'stripe-secret-key': 'STRIPE_SECRET_KEY',
  'catalog-sync-secret': 'CATALOG_SYNC_SECRET',
  'wisdom-api-token': 'WISDOM_API_TOKEN',
  'fmp-import-token': 'FMP_IMPORT_TOKEN',
  'admin-upload-password': 'ADMIN_UPLOAD_PASSWORD',
};

let loaded = null;

async function ensureSecrets() {
  const prefix = (process.env.SECRETS_SSM_PREFIX || '').replace(/\/$/, '');
  if (!prefix) return; // not running in AWS (box / local / tests)
  if (loaded) return loaded;

  loaded = (async () => {
    const names = Object.keys(SECRET_ENV_BY_NAME).map(name => `${prefix}/${name}`);
    const res = await ssm().send(new GetParametersCommand({ Names: names, WithDecryption: true }));

    for (const parameter of res.Parameters || []) {
      const shortName = parameter.Name.slice(prefix.length + 1);
      const envName = SECRET_ENV_BY_NAME[shortName];
      if (envName && !process.env[envName]) process.env[envName] = parameter.Value;
    }
    if (res.InvalidParameters?.length) {
      // Not fatal: a stage may intentionally omit some secrets (e.g. FMP token
      // while FRESH_IMPORT_ENABLED=false). The consuming module errors loudly
      // if it actually needs one.
      console.warn('secrets: missing SSM parameters', res.InvalidParameters);
    }
  })();
  return loaded;
}

module.exports = { ensureSecrets, SECRET_ENV_BY_NAME };
