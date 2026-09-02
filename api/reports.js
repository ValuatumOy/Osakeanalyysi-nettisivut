const { getCatalogReports } = require('../server/catalog-client');
const { reportError } = require('../server/email');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const reports = await getCatalogReports();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
    res.json({
      generatedAt: new Date().toISOString(),
      reports,
    });
  } catch (err) {
    console.error('reports:', err.message);
    await reportError('vercel reports', err);
    res.status(500).json({ error: 'Could not load reports' });
  }
};
