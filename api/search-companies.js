const { reportError } = require('../server/email');
const { searchCompaniesUpstream } = require('../server/company-search-upstream');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const query = String(req.query?.q || '').trim();
  if (!query || query.length > 100) {
    return res.status(400).json({ error: 'A valid company search query is required' });
  }

  try {
    const results = await searchCompaniesUpstream(query);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ query, results });
  } catch (error) {
    console.error('search-companies:', error.message);
    await reportError('vercel search-companies', error, { query: req.query?.q });
    return res.status(502).json({ error: 'Company search is temporarily unavailable' });
  }
};
