// Wisdom company-search proxy (Task B).
//
// The fresh-report picker must only offer companies Wisdom actually covers
// (a fixed followed universe): an empty result means "not covered", and a
// free-text order for an uncovered company would fail at render time.
//
// This module holds the Wisdom bearer token server-side and calls
// GET {WISDOM_REST_BASE}/rest/company?ticker=<q> (prefix match) or ?name=<q>
// (substring match). It returns a trimmed list — companyName, ticker, industry
// — and never exposes the token or the ISIN (companyCode) to the browser.
//
// ticker on the Wisdom result is SYMBOL.EXCHANGE (e.g. NESTE.HE) — exactly the
// companyCode the engine expects — so the picker carries it straight into the
// fresh-checkout call.

const REST_BASE = (process.env.WISDOM_REST_BASE || 'https://wisdom.valuatum.com').replace(/\/$/, '');
const TOKEN = () => process.env.WISDOM_API_TOKEN;
const TIMEOUT_MS = Number.parseInt(process.env.WISDOM_TIMEOUT_MS || '6000', 10);
const MAX_RESULTS = Number.parseInt(process.env.WISDOM_MAX_RESULTS || '10', 10);
const CACHE_TTL_MS = Number.parseInt(process.env.WISDOM_CACHE_TTL_MS || '60000', 10);

// Small in-memory TTL cache so debounced keystrokes don't hammer Wisdom.
const cache = new Map(); // key -> { at, value }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value); // crude cap
}

// A query "looks like a name" (rather than a ticker) if it contains whitespace.
// Tickers are single tokens (NESTE, NESTE.HE, TSLA); names have spaces.
function looksLikeName(query) {
  return /\s/.test(query);
}

async function fetchWisdom(param, query) {
  const url = `${REST_BASE}/rest/company?${param}=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN()}`, accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'wisdom search timed out' : `wisdom search request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) throw new Error(`wisdom auth rejected (${res.status}) — check WISDOM_API_TOKEN`);
  if (!res.ok) throw new Error(`wisdom search ${res.status}: ${res.statusText}`);

  const data = await res.json().catch(() => null);
  // The endpoint returns a JSON array; tolerate a {companies:[...]} envelope too.
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.companies)) return data.companies;
  return [];
}

// Trim an upstream row to what the browser is allowed to see. Drops rows with no
// usable ticker (can't be rendered) and the ISIN (companyCode).
function toPublic(row) {
  const ticker = (row.ticker || '').trim();
  if (!ticker) return null;
  return {
    companyName: (row.companyName || '').trim() || ticker,
    ticker,
    industry: (row.industry || '').trim() || undefined,
  };
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || seen.has(r.ticker)) continue;
    seen.add(r.ticker);
    out.push(r);
  }
  return out;
}

// Public API: resolve a user query to a list of covered companies.
// Returns [] for "not covered" (empty upstream) — never throws for that case.
async function searchCompanies(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (query.length < 1) return [];
  if (!TOKEN()) throw new Error('WISDOM_API_TOKEN is not set');

  const key = query.toLowerCase();
  const cached = cacheGet(key);
  if (cached) return cached;

  // Route by shape: names (with spaces) go to ?name=, single tokens to ?ticker=.
  // For a single token, if the ticker prefix search comes back empty, fall back
  // to a name substring search so "neste" still finds "Neste Oyj".
  let rows;
  if (looksLikeName(query)) {
    rows = await fetchWisdom('name', query);
  } else {
    rows = await fetchWisdom('ticker', query);
    if (rows.length === 0) rows = await fetchWisdom('name', query);
  }

  const result = dedupe(rows.map(toPublic).filter(Boolean)).slice(0, MAX_RESULTS);
  cacheSet(key, result);
  return result;
}

module.exports = { searchCompanies };
