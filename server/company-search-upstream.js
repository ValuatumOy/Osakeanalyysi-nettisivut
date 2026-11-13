const { isCoveredTicker } = require('./search');

const UPSTREAM = process.env.COMPANY_SEARCH_UPSTREAM || 'https://files.valuatum.com/api/search-companies';
const TIMEOUT_MS = Number.parseInt(process.env.COMPANY_SEARCH_TIMEOUT_MS || '8000', 10);

async function searchCompaniesUpstream(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${UPSTREAM}?q=${encodeURIComponent(query)}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`upstream returned ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.results)) throw new Error('upstream returned invalid company results');
    return data.results.map(toPublicCompany).filter(Boolean)
      .filter((company) => isCoveredTicker(company.ticker))
      .sort((a, b) => Number(b.ticker.toUpperCase() === query.toUpperCase()) - Number(a.ticker.toUpperCase() === query.toUpperCase()))
      .slice(0, 10);
  } finally {
    clearTimeout(timeout);
  }
}

function toPublicCompany(company) {
  const ticker = String(company?.ticker || '').trim();
  if (!ticker) return null;
  return {
    companyName: String(company?.companyName || '').trim() || ticker,
    ticker,
    industry: String(company?.industry || '').trim() || undefined,
  };
}

module.exports = { searchCompaniesUpstream };
