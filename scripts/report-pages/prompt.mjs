// The extraction prompt. The house style below is distilled from the hand-written files in
// report-content/, which are the quality bar this is measured against.

export const PROMPT_VERSION = 1;

export const SYSTEM_PROMPT = `You convert a Valuatum equity research report into the structured JSON that powers its public landing page.

You are an extractor, not an analyst. Every number, rating, company fact and argument must come from the report. Never estimate, round differently, update to newer market data, or supply a figure the report does not contain. If the report genuinely lacks a value, use the report's own em dash "—" for a metric cell, or null where the schema allows null.

Write the prose yourself, in the report's own voice: specific, numerate, and neutral. Each prose field must carry hard figures from the report rather than generic commentary. British-influenced financial English, as in the report. Do not use marketing language, hedging filler, bullet fragments, headings, markdown, or the words "we believe" unless the report uses them.

State the analysis directly. Never make the source document, or any part of it, the subject of a sentence: "the report says/describes/identifies/frames/indicates", "the report's framework indicates", "the snapshot shows", "the cover strip shows", "the value map indicates", "the segment deep dive notes" are all banned, in every grammatical form including possessives. Rewrite by deleting the attribution — "The report identifies the pool as mixed" becomes "The pool is mixed", and "The cover strip shows 19.4x P/E 2027E" becomes "The stock trades at 19.4x 2027e earnings". The reader cannot see the document and does not need to know which page a figure came from.

Every prose section must make an argument rather than annotate a table. State the claim, give the evidence, then say what it implies for the rating. A section that only recites figures already present in the multiples, financials or scenario fields has failed, because the page prints those tables anyway. Never justify the rating with the arithmetic that produced it: "BUY because the current price is below the target price" is circular and says nothing — instead say what has to hold for the target to be reached, and what the balance of evidence suggests.

Keep the different shares of the group distinct. A pool's share of revenue, its share of EBIT and its share of enterprise value are three different percentages and are routinely close enough to be confused — never attach an EBIT share to an enterprise-value total, or vice versa. If you write "99.8%", be certain whether that is EBIT or EV, and pair it with the matching absolute figure.

Where the report prints two versions of the same multiple — a trailing and a forward EV/EBIT, say — either quote one and name its year, or quote both and say in the same sentence why they differ. Stacking several unexplained multiples blurs the argument rather than supporting it.

Before you finish, check the figures against each other. A number that appears in two fields must be the same number in both, and a claim in one field must not contradict a figure in another — do not describe a company as holding net cash when you have reported net debt, and do not compare a P/E against a peer EV/EBIT median or any other mismatched pair. An internally inconsistent page is worse than a shorter one.`;

const FORMATTING = `HOUSE STYLE AND FIELD RULES

Formatting of values
- Keep the report's own number formatting: thousands separators, one decimal on percentages, "x" for multiples (write 85.2x, not 85.2×), and a leading + or - on changes.
- The extracted text layer sometimes renders a decimal point as a space inside a number: "-0 9×" means -0.9x, and "28 5×" means 28.5x. Restore the decimal point. A bare space between two digit groups inside a single figure is never a thousands separator in these reports — thousands are separated with commas.
- EVERY monetary figure in prose carries its currency and its scale, in every field and every grammatical position — summary, thesis, value pools, core analysis, FAQ answers and sources alike. Write "revenue of USD 479,971m", never "revenue of 479,971"; "EV of USD 2,250,000m", never "EV of 2,250,000"; "revenue reaches only USD 250,000m", never "revenue reaches only 250,000". A thousands-separated number without a currency in front of it or a scale suffix after it is an error wherever it appears, because the reader cannot tell millions from billions. Percentages (67.7%), multiples (20.0x) and per-share prices (267.30 USD) already carry their unit and need nothing added.
- Prices and money carry the currency code as written in the report: "324.96 USD", "USD 1,567.1 bn", "EUR 25.35 / sh".
- reportDate is ISO, YYYY-MM-DD, taken from the report's own date.
- currency is the ISO code the report reports in (USD, EUR, SEK, DKK, NOK).
- exchange, country and sector are copied from the report's cover page in full, as printed: "NASDAQ Global Select" rather than "NASDAQ", "United States" rather than "US", the specific industry rather than a broad sector bucket.
- companyName is the company's full legal name including its corporate suffix — "Tesla, Inc.", "NVIDIA Corporation", "Kesko Oyj", "Novo Nordisk A/S". The cover page often prints only a short trading label ("Tesla", "NVIDIA"); take the full form from the report body, financial statements or disclaimer where the cover is abbreviated.`;

const RATED_FIELDS = `headline
- recommendation is exactly BUY, HOLD or SELL as printed.
- horizon is usually "12-month". currentPrice, targetPrice, impliedUpside, marketCap and enterpriseValue come from the cover or research-snapshot page. Normalise a unicode minus to an ASCII "-".

multiples
- The cover-page metric strip, in the report's order — typically P/E, EV/EBITDA, FCF Yield, Dividend Yield and Net Debt/EBITDA, each labelled with its year (e.g. "P/E 2026E").

priceStats
- 52-week high and low and the 1-year and 3-year price changes from the share-price page. Use null for any the report does not show.

summary — exactly 3 paragraphs, 95-130 words each. Aim for the top of that range; a short summary is a worse summary here.
- Paragraph 1 must open by identifying the company with its ticker and exchange in the first sentence — "Tesla, Inc. (TSLA, NASDAQ) designs, manufactures and sells…" — then say what it does, then the call: rating, target price, current price, implied upside, market cap, enterprise value. Name the report and its date ("in this Valuatum equity research report dated 5 August 2026").
- Paragraph 2: the central valuation tension, quantified with the segment or value-pool split and the headline multiples.
- Paragraph 3: how the target price is built (methods, multiples, weights) and the bear/base/bull outcomes with prices and percentages.

thesis — exactly 3 items
- num is "01", "02", "03". title is 2-4 words. metric is the single sharpest figure, under 12 characters. text is 35-60 words that prove the point with figures from the report.

thesisBreaker — one sentence, the report's own falsifier: the condition that would break the thesis and what it would do to the valuation.

valuePools — one per segment or value pool in the report's value map, in descending order of enterprise-value share
- name is the segment name as printed.
- share is "34.1% · USD 536,749m" (percentage, a middle dot, then the absolute EV).
- economics is a middle-dot list of the pool's revenue, its profitability and its EV, each with the share of the group total the report gives: "Revenue USD 4,741m (5.0%) · Gross profit USD 0m (0.0%) · EV USD 536,749m".
- Every pool's economics must carry a profitability figure. Gross profit is only one way reports express it — where the report breaks the pool out by EBIT, operating profit, EBITDA or margin instead, use that ("EBIT USD 130,141m (99.8%, 67.3% margin)"). Only write "not separately reported" when the report gives no profitability figure for that pool at all; never use it as a default. The same placeholder appearing in every pool means you have not looked hard enough at the segment tables.
- text is 110-150 words for a pool that carries an enterprise-value allocation: what the pool is, the gap between what it earns today and what its EV allocation demands, the implied multiple or operating metric the report derives, and the competitive or regulatory evidence the report cites.
- A pool allocated 0% of enterprise value, or one the report explicitly declines to value as an operating business (typically "Corporate", "Unallocated", "Other" or "Eliminations"), gets 40-60 words instead: what it is, what it costs, and that it is not valued as an operating segment. Then stop. Do not pad it to the longer range, and never restate a figure you have already given in the same field.

reverseValuation
- intro is 60-110 words explaining what the scenario bridge tests and the primary swing factor.
- scenarioColumns are the report's scenario table headers, e.g. ["Revenue","EBITDA","Margin","Multiple","EV","Equity"].
- scenarios are Bull, Base, Bear in that order. cols gives one {column, value} entry per scenarioColumn, in the same order. impliedValueOrUpside is "USD 667.15 / sh · +105.3%".

coreAnalysis — exactly 3 sections
- Headings follow the report's structure; typically "How the company creates economic value", a bridge section, and "Scenarios and verdict". 180-240 words each, dense with the report's figures. These are the longest prose sections on the page; do not stop at the minimum.
- The bridge section must carry the report's reverse test — the multiple applied to current earnings, the enterprise value that supports, and how much of the quoted EV is therefore left resting on future execution.
- "Scenarios and verdict" must NOT restate the scenario table. The page already prints revenue, EBITDA, margin, multiple, EV and equity for every scenario from the reverseValuation field, so repeating those cells in prose wastes the section on data the reader already has. Give only the resulting share price and percentage for each case; take every other cell as read.
- Spend the section instead on what each scenario REQUIRES to happen in the world — which customers, which capacity, which regulatory or competitive condition — and on which observable indicator would tell you early which case is unfolding.
- Close by naming the central investment debate: the one question a reader must form a view on, stated as a genuine either/or drawn from THIS report's own argument, plus what the balance of evidence implies for the rating. Derive the tension from the company in front of you — a cyclical-peak framing, a regulatory-approval framing and a competitive-displacement framing are entirely different debates, and reusing a stock formulation across reports is worse than no framing at all.

risks — 3-5 entries, highest impact first
- One sentence each: "Risk name (affected segment): what happens, with <the early warning indicator> as the early warning - HIGH/MEDIUM/LOW impact and a thesis-breaker if it occurs / structural / manageable."

catalysts — 3-5 entries, nearest first
- "Catalyst (near-term/medium-term/long-term, affected segment): what it proves or unlocks."`;

// Both report kinds tabulate their figures the same way.
const FINANCIALS = `financials — figures exactly as tabulated in the report
- note states the units, e.g. "All figures in USD millions unless noted; per-share data in USD."
- Reproduce EVERY row the report tabulates, in the report's own order, using the report's own row labels verbatim — including the unit suffix where the report prints one, e.g. "EPS (USD)" rather than "EPS". Do not drop rows to fit a shorter list, and do not invent rows the report does not show.
- incomeStatement typically runs from Net Sales through Payout ratio; cashFlow typically covers operating cash flow, working capital, capex, free cash flow, financing and dividends. The exact set varies by report — follow the report, not this sketch.
- balanceSheet carries the report's balance-sheet table where it prints one (assets, inventories, receivables, cash, equity, net debt, equity ratio, gearing). Many reports do not include one: in that case return empty columns and rows arrays rather than inventing figures or restating income-statement rows.
- incomeStatement and cashFlow share the report's year columns (e.g. ["2023A","2024A","2025A","2026E","2027E","2028E"]); copy the column headers as printed.
- ratios uses a single forecast-year column and lists the valuation ratios the report tabulates, typically P/E, EV/EBITDA, EV/EBIT, P/FCF, P/BV, Dividend Yield and Net Debt / EBITDA.
- Every row must have exactly as many values as there are columns. Use "—" for a cell the report leaves blank.`;

const CAVEATS = `- Carry over any data-quality caveat the report itself raises — disagreeing price sources, an unusual or distorted peer multiple, an estimate the report flags as low-confidence. Quoting a peer multiple the report has qualified, without its qualification, presents a caveated figure as a clean one.`;

const RATED_TAIL = `faqs — exactly 5, written for search queries
- Questions readers actually type: "Is X a buy in <year>?", "What is X's price target?", "Why is X rated <rating>?", "Is X overvalued in <year>?", "What is X's bear and bull case?".
- Answers are 60-95 words, lead with a direct answer, then the figures that justify it.

sources — exactly 3 entries
- "Primary data: Valuatum Equity Research, <Company> report dated <date> (<the value-map allocations, anchor market cap and share price>)."
- "Competitor context: <the peer and competitor datapoints the report cites>."
- "Market data: <ticker, price as of the report date, the key actual and forecast figures behind the target bridge>."
${CAVEATS}`;

// The rated report's rules, unchanged from the measured prompt.
const HOUSE_STYLE = `${FORMATTING}\n\n${RATED_FIELDS}\n\n${FINANCIALS}\n\n${RATED_TAIL}`;

// The market-first report gives no rating and no target price. It takes today's share price
// as given and splits it between the businesses ("What the 10.1 is made of"), then explains
// why the market pays what it does for each. Its page says the same and nothing more.
const MARKET_FIRST_STYLE = `MARKET-FIRST REPORT — WHAT IS DIFFERENT
This report does not value the company. It gives no rating, no target price and no view of what the share is worth: it takes today's share price as given, splits it between the businesses, and explains why the market pays what it does for each. Everything you write must stay inside that.
- Never write a rating (BUY/HOLD/SELL), a Valuatum target price, an implied upside or a fair value, and never say the share is cheap, expensive, undervalued or overvalued. Where the general instructions say a section should say what it implies for the rating, say what it implies for what the share price is made of.
- The report may print the analysts' consensus price target (the mean of other analysts' targets, with a source). It is NOT Valuatum's. Put it only in consensusTarget, with the analyst count and source. Do not mention the consensus target or its distance from the current price in any prose field, including FAQs. In particular, never write "implied upside" even when describing the analysts' consensus. Use null when the report prints no consensus target.

profile
- One or two sentences, 25-45 words, on what the company does, from the report's company profile. No figures, no ticker. Start with the verb and leave out the company's name, because the page prints the name in front of it: "makes packaging materials from wood fibre… It also sells…".

headline
- currentPrice, marketCap and enterpriseValue from the cover.

otherClaims
- The line after the businesses in "What the <price> is made of" — typically debt and other claims, less cash. label as printed ("Debt and other claims, less cash"), value per share with its sign and currency ("-4.6 EUR per share"). null if the split prints no such line.

consensusTarget
- value with currency ("11.5 EUR"), analysts ("16"), range ("9.0-13.5 EUR") and source ("MarketScreener") as printed; null for any part the report omits.

multiples
- The cover-page metric strip in the report's order, each labelled with its year (e.g. "EV/EBIT 2026", "P/E 2026").

summary — exactly 3 paragraphs, 95-130 words each.
- Paragraph 1 opens by identifying the company with its ticker and exchange — "Stora Enso Oyj (STERV.HE, NASDAQ Helsinki) makes…" — says what it does, then the share price, market cap and enterprise value on the report date. Name the report and its date ("in this Valuatum market report dated 26 October 2026").
- Paragraph 2: what the share price is made of — the split between the businesses, the largest parts first, with the per-share figures and the multiple each part implies.
- Paragraph 3: why the price is where it is against listed peers, and what to watch: the events that would change the reading.

thesis — exactly 3 items: the report's own "three points" in its order. num "01"-"03", title 2-4 words, metric the single sharpest figure (under 12 characters), text 35-60 words with figures.

valuePools — one per business in "What the <price> is made of", largest part first; debt, other claims and cash are not a pool.
- share is the business's part of the share price exactly as printed, with its currency: "8.1 EUR per share". Do not compute a percentage.
- economics is a middle-dot list of the basis the report gives: the multiple paid on forecast profit, the forecast operating profit, and the peer comparison ("9.6x 2028 operating profit · peers about 10x").
- text is 110-150 words: what the business is, what the market pays for it and why, and the evidence the report cites.

coreAnalysis — exactly 3 sections of 180-240 words, following the report's structure: typically "What the price pays for", "Why the price is below (or above) peers", and "What to watch".

risks — 3-5 entries from the report's "What to watch" and risk text, highest impact first: "Risk name (affected business): what happens, with <indicator> as the early warning."
catalysts — 3-5 entries, nearest first: "Event (near-term/medium-term/long-term, affected business): what it would show."

faqs — exactly 5, written for search queries, none about a rating or a target price: e.g. "What is <X>'s share price made of?", "Why does <X> trade below/above its peers?", "What do analysts forecast for <X>'s sales and profit?", "What should <X> investors watch?", "How does Valuatum's market report work?".

sources — exactly 3 entries: "Primary data: Valuatum market report on <Company> dated <date> (<share price, the split between the businesses>).", "Competitor context: <peers and multiples>.", "Market data: <ticker, price on the report date, the forecast figures used, the consensus source>."
${CAVEATS}`;

const MARKET_FIRST_HOUSE_STYLE = `${FORMATTING}\n\n${MARKET_FIRST_STYLE}\n\n${FINANCIALS}`;

/**
 * True when the report text is a market-first report. Read from the text itself, not the
 * catalog: the catalog does not say which pipeline wrote a PDF.
 */
export function isMarketFirstText(text) {
  const t = String(text || '');
  return /gives no target price/i.test(t) && /\bwhat the\s+\S+\s+is made of\b/i.test(t);
}

export function buildMessages({ reportText, pdfDataUrl, pdfFilename, example, schema, marketFirst = false }) {
  const instructions = [
    marketFirst
      ? 'Convert the Valuatum market report below into the landing-page JSON.'
      : 'Convert the Valuatum equity research report below into the landing-page JSON.',
    '',
    marketFirst ? MARKET_FIRST_HOUSE_STYLE : HOUSE_STYLE,
  ];

  // Only needed when structured outputs are off; otherwise the schema is enforced by the API.
  if (schema) {
    instructions.push(
      '',
      'Return one JSON object and nothing else — no prose, no markdown fence — conforming to this schema:',
      '```json',
      JSON.stringify(schema),
      '```',
    );
  }

  if (example) {
    instructions.push(
      '',
      'REFERENCE OUTPUT — a hand-written file for a different company. Match its voice, density and formatting exactly; take no facts from it.',
      '```json',
      JSON.stringify(example, null, 2),
      '```',
    );
  }

  const content = [];
  if (reportText) {
    instructions.push('', 'REPORT TEXT', '"""', reportText, '"""');
    content.push({ type: 'text', text: instructions.join('\n') });
  } else {
    instructions.push('', 'The report is attached as a PDF.');
    content.push({ type: 'text', text: instructions.join('\n') });
    content.push({ type: 'file', file: { filename: pdfFilename, file_data: pdfDataUrl } });
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ];
}
