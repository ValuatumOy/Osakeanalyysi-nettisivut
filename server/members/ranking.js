// Ordering of the analyses shown under one company. This is the product: the
// engine's report is the base, and the analysts' takes sit on top of it in an
// order that has to mean something (Esa, 17.8.2026).
//
// Deliberately one small pure function. The formula is tuning — peer scores,
// realised-accuracy points and read counts will be weighted differently once
// there is data — but the shape (score, then sort) is what the callers depend on.

const DAY_MS = 24 * 3600 * 1000;
// Peer scores are 1..5; 3 is the neutral prior an unreviewed analysis gets, so a
// single grumpy review cannot bury it and an unreviewed one cannot lead.
const NEUTRAL_SCORE = 3;
const PRIOR_WEIGHT = 2;
// A dated take goes stale: half a year of no reviews costs about one point.
const AGE_PENALTY_PER_DAY = 1 / 180;

function peerScore(item) {
  const count = Number(item?.reviewCount) || 0;
  const sum = Number(item?.scoreSum) || 0;
  return (sum + NEUTRAL_SCORE * PRIOR_WEIGHT) / (count + PRIOR_WEIGHT);
}

function score(item, now = new Date()) {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(item?.publishedAt || 0)) / DAY_MS);
  const reviews = Number(item?.reviewCount) || 0;
  // Reviews are evidence, not popularity: the log keeps a well-reviewed analysis
  // ahead of an unreviewed one without letting review count alone decide.
  return peerScore(item) + Math.log10(1 + reviews) - ageDays * AGE_PENALTY_PER_DAY;
}

// Published analyses for one company, best first. Taken-down ones never appear.
function orderAnalyses(items, now = new Date()) {
  return (items || [])
    .filter((item) => item && item.status === 'published')
    .map((item) => ({ ...item, peerScore: peerScore(item), rank: score(item, now) }))
    // Ties fall back to publish order and then the id, so the same set always
    // renders in the same order however it came out of Dynamo.
    .sort((a, b) => b.rank - a.rank
      || String(a.publishedAt).localeCompare(String(b.publishedAt))
      || String(a.genId).localeCompare(String(b.genId)));
}

// An analysis is readable without spending anything while its hand-picked free
// window is open, or once the analyst's own decay time has passed.
function isFreeNow(item, now = new Date()) {
  const at = now.toISOString();
  if (item?.freeUntil && at <= item.freeUntil) return true;
  return Boolean(item?.freeFrom && at >= item.freeFrom);
}

module.exports = { orderAnalyses, score, peerScore, isFreeNow };
