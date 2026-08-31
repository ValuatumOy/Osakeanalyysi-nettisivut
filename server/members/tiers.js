// Allowances as data, not constants scattered through the code. Every tier and
// every role is four numbers (three from Esa 17.8.2026, revisions added with
// the engine's revision feature):
//
//   generations   fresh reports the member may generate per calendar month
//   basePicks     already-generated engine reports they may read per month
//   analystReads  other analysts' published analyses they may open per month
//   revisions     revision rounds on each generation, before it is published
//
// All four are demand-tuned, so they must be changeable without a code change:
// MEMBERS_LIMITS_JSON overrides any subset, e.g. {"analyst":{"basePicks":15}}.

const DEFAULT_LIMITS = {
  // Roles. An analyst publishes what they generate; a reader has the same
  // LinkedIn login without the publish obligation and sees about half as much.
  // Revising toward their own view is the analyst's whole job, so they get
  // the most rounds; every round is a real engine run, hence a cap at all.
  analyst: { generations: 1, basePicks: 10, analystReads: 20, revisions: 5 },
  // A promoted analyst: the reservation transact accepts the role, so it must
  // have allowances — same as analyst until coaching gets its own tuning.
  coaching: { generations: 1, basePicks: 10, analystReads: 20, revisions: 5 },
  reader: { generations: 1, basePicks: 5, analystReads: 10, revisions: 2 },

  // Subscription tiers. Monthly plans deliberately get less than annual ones:
  // at the €20 one-off price, 5 picks for one €19 month is €100 of product and
  // nothing stops a subscriber cancelling once the PDF is downloaded.
  none: { generations: 0, basePicks: 0, analystReads: 0, revisions: 0 },
  // analystReads track the tier's own generosity: each one now pays the analyst
  // who wrote what was read (bounty.readRateEur), so ten of them on the 19 EUR
  // tier handed out a quarter of gross while the headline benefit was three
  // picks. The peripheral perk must not be more generous than the core one.
  investor: { generations: 0, basePicks: 3, analystReads: 5, revisions: 0 },
  'investor:year': { generations: 0, basePicks: 5, analystReads: 5, revisions: 0 },
  investor_plus: { generations: 1, basePicks: 10, analystReads: 20, revisions: 2 },
  'investor_plus:year': { generations: 1, basePicks: 15, analystReads: 20, revisions: 2 },
  coverage: { generations: 0, basePicks: 0, analystReads: 0, revisions: 0 }, // its own yearly path
};

const ZERO = { generations: 0, basePicks: 0, analystReads: 0, revisions: 0 };

function overrides() {
  const raw = process.env.MEMBERS_LIMITS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn('MEMBERS_LIMITS_JSON is not valid JSON, ignoring:', err.message);
    return {};
  }
}

function row(key) {
  const base = DEFAULT_LIMITS[key];
  if (!base) return null;
  return { ...base, ...(overrides()[key] || {}) };
}

// A subscriber who is also an analyst keeps whichever allowance is larger on
// each of the four numbers — an upgrade must never take something away.
function limitsFor({ role, tier, interval = 'month' } = {}) {
  const rows = [row(role)];
  if (tier) rows.push(row(interval === 'year' ? `${tier}:year` : tier) || row(tier));
  const found = rows.filter(Boolean);
  if (!found.length) return { ...ZERO };
  return {
    generations: Math.max(...found.map((r) => r.generations || 0)),
    basePicks: Math.max(...found.map((r) => r.basePicks || 0)),
    analystReads: Math.max(...found.map((r) => r.analystReads || 0)),
    revisions: Math.max(...found.map((r) => r.revisions || 0)),
  };
}

// Roles that sign in with LinkedIn and read the archive rather than the newest
// reports. Analysts publish; readers do not.
const LINKEDIN_ROLES = new Set(['analyst', 'reader', 'coaching']);
// Roles allowed to publish (and therefore carrying the publish obligation).
const PUBLISHING_ROLES = new Set(['analyst', 'coaching']);
const ROLES = ['analyst', 'reader', 'coaching', 'subscriber'];

function isPublishingRole(role) {
  return PUBLISHING_ROLES.has(role);
}

function isLinkedinRole(role) {
  return LINKEDIN_ROLES.has(role);
}

module.exports = {
  DEFAULT_LIMITS,
  ROLES,
  limitsFor,
  isPublishingRole,
  isLinkedinRole,
};
