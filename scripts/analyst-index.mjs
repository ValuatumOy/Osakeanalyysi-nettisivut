// Published analyst reports per company, for baking into static metadata.
//
// The section on a company page fetches this in the browser, but a meta description cannot:
// Google reads the HTML it is served, so the analyst count has to be in the file at build
// time. sync.mjs runs hourly, which bounds how stale the count can get.
//
// Degrades rather than fails. The live catalog hard-fails on purpose -- building pages from
// a stale catalog once served outdated reports for weeks -- but an analyst count is an
// enhancement on top of a page that is correct without it. A members API outage should not
// stop the report pages rebuilding, and it must not silently rewrite every description down
// to "no analysts" either, so callers get null and are expected to leave existing pages
// alone.

const PROD = 'https://members.aiequityreports.com';
const TEST = 'https://members-test.aiequityreports.com';

/** Prod unless MEMBERS_API says otherwise; MEMBERS_STAGE=test is the shorthand. */
export function membersApiUrl() {
  if (process.env.MEMBERS_API) return process.env.MEMBERS_API.replace(/\/$/, '');
  return process.env.MEMBERS_STAGE === 'test' ? TEST : PROD;
}

/**
 * Map of TICKER -> { count, topAnalyst, topPeerScore, topRecommendation|null }.
 * Returns null when the API could not be read at all.
 */
export async function fetchAnalystIndex({ timeoutMs = 15000 } = {}) {
  const url = `${membersApiUrl()}/analyses`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      console.warn(`analyst index: ${url} returned HTTP ${res.status}; leaving counts untouched`);
      return null;
    }
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.analyses;
    if (!Array.isArray(list)) {
      console.warn(`analyst index: unexpected payload from ${url}; leaving counts untouched`);
      return null;
    }

    const byTicker = new Map();
    for (const a of list) {
      const key = String(a.companyId || '').trim().toUpperCase();
      if (!key) continue;
      if (!byTicker.has(key)) byTicker.set(key, []);
      byTicker.get(key).push(a);
    }

    const out = new Map();
    for (const [ticker, entries] of byTicker) {
      // Already ranked by the API (server/members/ranking.js) -- the first is the top one.
      const top = entries[0];
      out.set(ticker, {
        count: entries.length,
        topAnalyst: top.analyst || null,
        topPeerScore: typeof top.peerScore === 'number' ? top.peerScore : null,
        // Not currently returned by GET /analyses. Present here so that surfacing it on the
        // endpoint is the only change needed to unlock the agrees/disagrees phrasing.
        topRecommendation: top.recommendation || null,
      });
    }
    return out;
  } catch (err) {
    console.warn(`analyst index: could not read ${url} (${err.message}); leaving counts untouched`);
    return null;
  }
}

/**
 * How the description clause should read for one company.
 * `engineRecommendation` is Valuatum's own rating, for the comparison when it is possible.
 */
export function analystClause(index, ticker, engineRecommendation) {
  if (!index) return null; // unknown: caller leaves the page as it is
  const entry = index.get(String(ticker || '').trim().toUpperCase());
  if (!entry || !entry.count) return { analysts: 0, disagrees: null };
  const bothKnown = entry.topRecommendation && engineRecommendation;
  return {
    analysts: entry.count,
    disagrees: bothKnown
      ? entry.topRecommendation.toUpperCase() !== engineRecommendation.toUpperCase()
      : null,
  };
}
