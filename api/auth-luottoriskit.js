// Auth for the luottoriskit.fi Artikkelit admin (hosted at luottoriskit.fi/admin/).
// Exchanges the shared admin password for the Bitbucket repo access token.
// Env vars (Vercel): LUOTTORISKIT_ADMIN_PASSWORD, LUOTTORISKIT_BITBUCKET_TOKEN
const ALLOWED_ORIGINS = ['https://luottoriskit.fi', 'https://www.luottoriskit.fi', 'http://localhost:4321'];

module.exports = (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();
  const { password } = req.body || {};
  if (!password || password !== process.env.LUOTTORISKIT_ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: process.env.LUOTTORISKIT_BITBUCKET_TOKEN });
};
