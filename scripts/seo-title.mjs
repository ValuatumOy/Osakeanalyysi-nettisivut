// Shared <title> builder for every page under /reports/.
//
// Google renders roughly 60 characters of a title. The old template spent 71 of them on
// boilerplate identical on all 1,174 pages ("Stock Analysis & AI Equity Report — Price
// Target & Valuation | Valuatum"), so the part that differed was cut off in the SERP and
// the rating never made it in front of a searcher.
//
// The rules below pick the longest variant that still fits, so the rating and price target
// — the only things on the page a competitor cannot copy — survive the truncation.

export const TITLE_LIMIT = 60;

/**
 * Report pages, where the engine has published a rating.
 *
 * @param {string} name    short company name, e.g. "Kesko"
 * @param {string} ticker  e.g. "KESKOB.HE"
 * @param {object} h       headline: { recommendation, targetPrice }
 */
export function reportTitle(name, ticker, h = {}) {
  const rec = (h.recommendation || '').trim().toUpperCase();
  const target = compactPrice(h.targetPrice);
  const candidates = [];
  if (rec && target) {
    candidates.push(`${name} (${ticker}) Stock Analysis — ${rec}, ${target} Target`);
    candidates.push(`${name} (${ticker}) Stock Analysis — ${rec} ${target}`);
    candidates.push(`${name} (${ticker}) Stock Forecast — ${rec} ${target}`);
    candidates.push(`${name} Stock Analysis — ${rec}, ${target} Target`);
  }
  if (rec) {
    candidates.push(`${name} (${ticker}) Stock Analysis — ${rec} Rating`);
    candidates.push(`${name} (${ticker}) Stock Analysis — ${rec}`);
    candidates.push(`${name} Stock Analysis — ${rec}`);
  }
  candidates.push(`${name} (${ticker}) Stock Analysis & Price Target`);
  candidates.push(`${name} (${ticker}) Stock Analysis`);
  candidates.push(`${name} Stock Analysis`);
  return pick(candidates, name);
}

/**
 * Company overview pages, which carry no rating — nothing has been published for them yet.
 */
export function companyTitle(name, ticker) {
  return pick([
    `${name} (${ticker}) Stock Analysis & Valuation`,
    `${name} (${ticker}) Stock Analysis`,
    `${name} (${ticker}) Valuation`,
    `${name} Stock Analysis & Valuation`,
    `${name} Stock Analysis`,
  ], name);
}

/** First candidate inside the limit; otherwise the shortest one we have. */
function pick(candidates, name) {
  const fit = candidates.find((c) => c.length <= TITLE_LIMIT);
  if (fit) return fit;
  const shortest = candidates.reduce((a, b) => (b.length < a.length ? b : a));
  // A company name long enough to blow the limit on its own gets trimmed on a word
  // boundary rather than mid-word.
  if (shortest.length > TITLE_LIMIT && name) {
    const trimmed = truncateWords(name, TITLE_LIMIT - ' Stock Analysis'.length);
    return `${trimmed} Stock Analysis`;
  }
  return shortest;
}

function truncateWords(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 8 ? cut.slice(0, sp) : cut).replace(/[\s,\-–—]+$/, '');
}

/**
 * "17.10 EUR" -> "€17.10";  "413.00 USD" -> "$413";  keeps it short enough to fit a title.
 * Trailing ".00" is dropped — it costs three characters and tells a reader nothing.
 */
export function compactPrice(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const m = s.match(/([\d.,]+)\s*([A-Z]{3}|[€$£])?/);
  if (!m) return '';
  // Only a whole ".00" goes — "17.10" keeps its cent, or the price reads as broken.
  const num = m[1].replace(/,/g, '').replace(/\.00$/, '');
  const sym = { EUR: '€', USD: '$', GBP: '£', SEK: ' SEK', NOK: ' NOK', DKK: ' DKK' }[m[2]] || (m[2] ? ` ${m[2]}` : '');
  return sym.startsWith(' ') ? `${num}${sym}` : `${sym}${num}`;
}
