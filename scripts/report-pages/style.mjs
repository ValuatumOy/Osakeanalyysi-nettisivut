// Mechanical prose defects an LLM judge reliably penalises, detected deterministically so that
// prompt iteration does not need a paid judgement every round, and so the generator can ask the
// model to repair its own output. The hand-written report-content files score 0 on all of these.
export const PROSE_FIELDS = (d) => [
  ...(d.summary || []),
  ...(d.thesis || []).map((t) => t.text),
  ...(d.valuePools || []).map((p) => p.text),
  ...(d.coreAnalysis || []).map((c) => c.text),
  ...(d.faqs || []).map((f) => f.a),
  d.reverseValuation?.intro,
  d.thesisBreaker,
].filter(Boolean);

const TICS = [
  // "revenue of 479,971" / "reaches only 250,000" — a thousands-separated figure with neither a
  // preceding currency code nor a trailing scale suffix, so millions and billions read alike.
  // Counts are not money: "1,000 units per month" and "450,000 paid rides" are complete as written,
  // so the trailing exclusion list covers unit nouns as well as currency scale suffixes.
  ['unitless-figure', /(?<!(?:USD|EUR|SEK|DKK|NOK|GBP|CHF|JPY)\s?)(?<![\d.,])-?\d{1,3}(?:,\d{3})+(?![\d.,])(?![-\s]*(?:m\b|bn\b|million|billion|trillion|USD|EUR|SEK|DKK|NOK|x\b|%|units?|vehicles?|cars?|rides?|robots?|subscribers?|customers?|users?|employees?|stores?|shipments?|deliveries|tonnes?|tons?|MW\b|GW\b|kWh|miles?|per\b))/g],
  // "the report describes" — narrating the source document instead of asserting the analysis.
  ['meta-attribution', /\b(?:the|this)\s+(?:report|snapshot|research snapshot|cover strip|value map|segment deep dive|document)(?:'s)?\s+(?:\w+\s+)?(?:says|describes|identifies|characteris\w+|characteriz\w+|states|notes|shows|models|lists|frames|indicates|reports|assumes|treats)/gi],
  // "BUY because the price is below the target" restates the rating instead of justifying it.
  ['circular-verdict', /\b(?:supports?|justifies|warrants)\s+(?:a\s+)?(?:BUY|SELL|HOLD)[^.]{0,80}\bbecause\b[^.]{0,80}\b(?:below|above)\s+the\b[^.]{0,40}\btarget/gi],
];


// Matching must respect digit boundaries: a naive substring test finds "15,000" inside
// "USD 115,000m". A figure immediately followed by a count noun is also not the scenario cell —
// "450,000 paid rides per week" merely collides with a scenario value.
function echoesFigure(prose, cellDigits) {
  const re = new RegExp(`(?<!\\d)${cellDigits}(?!\\d)(?![-\\s]*(?:units?|vehicles?|cars?|rides?|robots?|subscribers?|customers?|users?|employees?|stores?|shipments?|deliveries|tonnes?|tons?|MW\\b|GW\\b|kWh|miles?|per\\b))`, 'i');
  return re.test(prose);
}

/**
 * The scenario table is printed on the page from reverseValuation, so restating its cells in
 * coreAnalysis spends the section's words on data the reader already has. The hand-written files
 * echo none of them; they argue about what each scenario requires instead.
 */
function scenarioRecitation(gen) {
  const flat = (s) => String(s).replace(/[,\s]/g, '');
  const cells = new Set();
  for (const s of gen.reverseValuation?.scenarios || []) {
    for (const v of Object.values(s.cols || {})) {
      // Only the large absolute figures count. A margin or a multiple legitimately reappears
      // elsewhere — the bridge section's reverse test applies a multiple to current earnings by
      // design — so counting those would flag the argument the prompt actually asks for.
      if (/%|x\s*$/i.test(String(v))) continue;
      const digits = (String(v).match(/\d/g) || []).length;
      if (digits >= 4) cells.add(flat(v));
    }
  }
  const prose = flat((gen.coreAnalysis || []).map((c) => c.text).join(' '));
  const echoed = [...cells].filter((c) => c.length > 3 && echoesFigure(prose, c));
  return { echoed: echoed.length, of: cells.size };
}

export function scenarioRecitationDetail(gen) {
  const flat = (s) => String(s).replace(/[,\s]/g, '');
  const raw = new Map();
  for (const s of gen.reverseValuation?.scenarios || []) {
    for (const v of Object.values(s.cols || {})) {
      if (/%|x\s*$/i.test(String(v))) continue;
      if ((String(v).match(/\d/g) || []).length >= 4) raw.set(flat(v), String(v));
    }
  }
  const prose = flat((gen.coreAnalysis || []).map((c) => c.text).join(' '));
  const echoed = [...raw.entries()].filter(([k]) => k.length > 3 && echoesFigure(prose, k)).map(([, v]) => v);
  return { echoed, cells: raw.size };
}

export function overlongUnvalued(gen) {
  return (gen.valuePools || []).filter((p) => {
    const unvalued = /(?:^|[^\d.])0(?:\.0)?%/.test(String(p.share)) || /no allocated|zero enterprise/i.test(p.text);
    return unvalued && p.text.split(/\s+/).length > 70;
  }).map((p) => p.name);
}

/**
 * The offending excerpts, so a repair request can quote them back rather than restate the rule the
 * model has already been given and missed.
 */
export function styleViolations(gen) {
  const out = [];
  for (const field of PROSE_FIELDS(gen)) {
    for (const [name, re] of TICS) {
      for (const hit of String(field).match(re) || []) {
        const at = field.indexOf(hit);
        out.push({ tic: name, excerpt: field.slice(Math.max(0, at - 60), at + hit.length + 60).trim() });
      }
    }
  }
  const { echoed, cells } = scenarioRecitationDetail(gen);
  if (echoed.length) out.push({ tic: 'scenario-recitation', excerpt: `these scenario-table figures are restated in coreAnalysis: ${echoed.join(', ')} (of ${cells} scenario figures)` });
  for (const name of overlongUnvalued(gen)) {
    out.push({ tic: 'overlong-unvalued-pool', excerpt: `valuePools["${name}"] carries no enterprise-value allocation but its text runs past the 40-60 word limit for such a pool` });
  }
  return out;
}

export function checkStyle(gen) {
  const text = PROSE_FIELDS(gen).join('\n');
  const counts = Object.fromEntries(TICS.map(([name, re]) => [name, (text.match(re) || []).length]));
  const recited = scenarioRecitation(gen);
  counts['scenario-recitation'] = recited.echoed;

  // A pool the report does not value needs a sentence or two, not the full word range.
  const overlong = overlongUnvalued(gen);

  return { counts, overlongUnvaluedPools: overlong, total: Object.values(counts).reduce((a, b) => a + b, 0) + overlong.length };
}

