const { reportError } = require('../server/email');

const UPSTREAM = process.env.COMPANY_SEARCH_UPSTREAM || 'https://files.valuatum.com/api/search-companies';
const TIMEOUT_MS = Number.parseInt(process.env.COMPANY_SEARCH_TIMEOUT_MS || '8000', 10);

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const query = String(req.query?.q || '').trim();
  if (!query || query.length > 100) {
    return res.status(400).json({ error: 'A valid company search query is required' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(`${UPSTREAM}?q=${encodeURIComponent(query)}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!upstream.ok) throw new Error(`upstream returned ${upstream.status}`);

    const data = await upstream.json();
    const results = Array.isArray(data?.results)
      ? data.results.map(toPublicCompany).filter(Boolean).slice(0, 10)
      : [];
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ query, results });
  } catch (error) {
    console.error('search-companies:', error.message);
    await reportError('vercel search-companies', error, { query: req.query?.q });
    return res.status(502).json({ error: 'Company search is temporarily unavailable' });
  } finally {
    clearTimeout(timeout);
  }
};

function toPublicCompany(company) {
  const ticker = String(company?.ticker || '').trim();
  if (!ticker) return null;
  return {
    companyName: String(company?.companyName || ticker).trim(),
    ticker,
    industry: String(company?.industry || '').trim() || undefined,
  };
}
