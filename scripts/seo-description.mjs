// Shared meta-description builder for pages under /reports/.
//
// Google renders roughly 160 characters. All 17 report descriptions were 206-245, so the
// tail was cut off every time -- and what it cut was "Share price forecast, valuation,
// segment-value analysis, reverse valuation, financials, risks & catalysts", about 73
// characters of keyword stuffing that no searcher has ever seen. (The Princeton GEO work
// has stuffing actively reducing AI-citation rates, so it was not earning anything
// elsewhere either.) That is the budget the analyst clause spends.
//
// Two deliberate omissions:
//
// The current share price. It used to read "17.10 EUR price target vs 19.20 EUR". Google
// caches a snippet for weeks while that price is fixed at the report date, so it goes
// publicly wrong on a finance site, and it is the one number in the sentence guaranteed to
// decay. Fifteen characters for a liability.
//
// The top-rated analyst's own target. It fits, and it is still left out: there is no room
// to attribute it to a person, so an unattributed "BUY at 12.00 EUR" inside Valuatum's own
// page description reads as Valuatum's second opinion. It is also worse for clicks -- "the
// top-rated one disagrees" poses the question, "rates it BUY at 12.00 EUR" answers it, and
// an answered snippet is a zero-click snippet.

import { SHOW_RATINGS_IN_SNIPPET } from './seo-flags.mjs';

export const DESCRIPTION_LIMIT = 160;

/**
 * @param {object} o
 * @param {string} o.name        short company name
 * @param {string} o.ticker
 * @param {string} [o.recommendation]
 * @param {string} [o.targetPrice]
 * @param {number} [o.analysts]   published analyst reports on this company
 * @param {boolean} [o.disagrees] whether the top-ranked analyst differs from the engine
 */
export function reportDescription({ name, ticker, recommendation, targetPrice, analysts = 0, disagrees = null }) {
  const rated = SHOW_RATINGS_IN_SNIPPET && recommendation && targetPrice;

  // Longest first; a long company name walks down the list rather than truncating.
  const heads = rated
    ? [
      `${name} (${ticker}) stock analysis: Valuatum rates ${ticker} ${recommendation} with a ${targetPrice} price target.`,
      `${name} (${ticker}) stock analysis: Valuatum rates it ${recommendation}, ${targetPrice} target.`,
      `${name} (${ticker}): Valuatum rates it ${recommendation}, ${targetPrice} target.`,
    ]
    : [
      `${name} (${ticker}) stock analysis and AI equity research from Valuatum: valuation, forecasts and a 12-month price target.`,
      `${name} (${ticker}) stock analysis from Valuatum: valuation, forecasts and a price target.`,
      `${name} (${ticker}) stock analysis and valuation from Valuatum.`,
    ];

  // The analyst clause is the click hook, so it shrinks before it is dropped.
  //
  // `disagrees` is null when we cannot tell: GET /analyses returns peerScore and counts but
  // not the analyst's own recommendation, so there is nothing to compare against the engine.
  // Surfacing `recommendation` on that endpoint would turn this into the stronger hook --
  // until then the count stands on its own rather than a guess standing in for it.
  const n = `${analysts} analyst report${analysts === 1 ? '' : 's'}`;
  const verdictKnown = disagrees !== null && disagrees !== undefined;
  const tails = analysts
    ? (verdictKnown
      ? [
        ` ${n} on ${name}, the top-rated one ${disagrees ? 'disagrees' : 'agrees'}.`,
        ` ${n} too; the top-rated one ${disagrees ? 'disagrees' : 'agrees'}.`,
        ` Plus ${n}.`,
      ]
      : [
        ` ${n} on ${name} as well, ranked by peer review.`,
        ` ${n} on ${name}, ranked by peer review.`,
        ` Plus ${n}, peer-ranked.`,
      ])
    : [
      ' Segment value analysis, reverse valuation and full financials.',
      ' Segment value, reverse valuation, financials.',
      '',
    ];

  // Prefer keeping the tail: try every head against the fullest tail before shortening it.
  for (const tail of tails) {
    for (const head of heads) {
      if ((head + tail).length <= DESCRIPTION_LIMIT) return head + tail;
    }
  }
  return heads[heads.length - 1].slice(0, DESCRIPTION_LIMIT);
}
