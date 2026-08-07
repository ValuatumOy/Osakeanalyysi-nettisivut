// JSON Schema for the report-content documents that scripts/report-pages/render.mjs consumes.
// Written for OpenAI-style strict structured outputs: every property is listed in `required`
// and objects set additionalProperties:false. Fields that may legitimately be absent are typed
// as nullable rather than omitted.
//
// Two shapes differ from the on-disk format and are converted by toReportContent() below:
//   - reverseValuation.scenarios[].cols is an open key/value map on disk; the model returns an
//     array of {column, value} pairs because strict schemas cannot express dynamic keys.
//   - id and slug are not model output at all; the generator fills them deterministically.

const str = { type: 'string' };
const nullableStr = { type: ['string', 'null'] };

const obj = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const arr = (items) => ({ type: 'array', items });

const financialTable = obj({
  columns: arr(str),
  rows: arr(obj({ label: str, values: arr(str) })),
});

export const REPORT_SCHEMA = obj({
  companyName: str,
  ticker: str,
  exchange: str,
  country: str,
  sector: str,
  currency: str,
  reportDate: str,

  headline: obj({
    recommendation: str,
    horizon: str,
    currentPrice: str,
    targetPrice: str,
    impliedUpside: str,
    marketCap: str,
    enterpriseValue: str,
  }),

  multiples: arr(obj({ label: str, value: str })),

  priceStats: obj({
    week52High: nullableStr,
    week52Low: nullableStr,
    oneYearChange: nullableStr,
    threeYearChange: nullableStr,
  }),

  summary: arr(str),

  thesis: arr(obj({ num: str, title: str, metric: str, text: str })),

  thesisBreaker: str,

  valuePools: arr(obj({ name: str, share: str, economics: str, text: str })),

  reverseValuation: obj({
    intro: str,
    scenarioColumns: arr(str),
    scenarios: arr(obj({
      scenario: str,
      cols: arr(obj({ column: str, value: str })),
      impliedValueOrUpside: str,
    })),
  }),

  coreAnalysis: arr(obj({ heading: str, text: str })),

  risks: arr(str),

  catalysts: arr(str),

  // Table order matches the render order in scripts/build-report-pages.mjs. Not every report
  // tabulates a balance sheet; when one is absent the model returns empty arrays and
  // toReportContent() drops the table rather than emitting an empty section.
  financials: obj({
    note: str,
    incomeStatement: financialTable,
    balanceSheet: financialTable,
    cashFlow: financialTable,
    ratios: financialTable,
  }),

  faqs: arr(obj({ q: str, a: str })),

  sources: arr(str),
});

// Key order used by the hand-written files, so generated output diffs cleanly against them.
const KEY_ORDER = [
  'id', 'slug', 'companyName', 'ticker', 'exchange', 'country', 'sector', 'currency', 'reportDate',
  'headline', 'multiples', 'priceStats', 'summary', 'thesis', 'thesisBreaker', 'valuePools',
  'reverseValuation', 'coreAnalysis', 'risks', 'catalysts', 'financials', 'faqs', 'sources',
];

/** Converts raw model output into the on-disk report-content shape. */
export function toReportContent(raw, { id, slug }) {
  const doc = { ...raw, id, slug };

  if (doc.reverseValuation?.scenarios) {
    doc.reverseValuation = {
      ...doc.reverseValuation,
      scenarios: doc.reverseValuation.scenarios.map((s) => ({
        scenario: s.scenario,
        cols: Object.fromEntries((s.cols || []).map((c) => [c.column, c.value])),
        impliedValueOrUpside: s.impliedValueOrUpside,
      })),
    };
    // The build script reads scenarioColumns to order the table; keep it last like the hand files.
    const { intro, scenarios, scenarioColumns } = doc.reverseValuation;
    doc.reverseValuation = { intro, scenarios, scenarioColumns };
  }

  for (const [k, v] of Object.entries(doc.priceStats || {})) {
    if (v === null) delete doc.priceStats[k];
  }

  for (const [k, table] of Object.entries(doc.financials || {})) {
    if (k !== 'note' && !table?.rows?.length) delete doc.financials[k];
  }

  const ordered = {};
  for (const k of KEY_ORDER) if (k in doc) ordered[k] = doc[k];
  for (const k of Object.keys(doc)) if (!(k in ordered)) ordered[k] = doc[k];
  return ordered;
}
