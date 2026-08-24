#!/usr/bin/env node
// Rewrite the meta description on the pages already built.
//
// All 17 report descriptions were 206-245 characters against Google's ~160, so every one was
// truncated and what it lost was keyword filler. See scripts/seo-description.mjs for what
// goes in, what comes out, and why.
//
// The rating comes from report-content/<id>.json via the page's own valuatum-report-id, not
// from re-parsing the sentence being replaced.
//
//   node scripts/redescribe-report-pages.mjs [--check]
//   MEMBERS_STAGE=test node scripts/redescribe-report-pages.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportDescription, DESCRIPTION_LIMIT } from './seo-description.mjs';
import { identity, headlineOf } from './report-headline.mjs';
import { fetchAnalystIndex, analystClause } from './analyst-index.mjs';
import { SHOW_RATINGS_IN_METADATA } from './seo-flags.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'reports');
const CHECK = process.argv.includes('--check');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s) => esc(s).replace(/"/g, '&quot;');

/** Short display name: the title carries it already, minus any corporate suffix. */
const shortName = (s) => s.replace(/,?\s+(Inc\.?|Oyj|Abp|Ltd\.?|plc|Corporation|Corp\.?|AB|ASA|A\/S|N\.V\.|S\.A\.|Group|Holdings?)\.?$/i, '').trim() || s;

const index = await fetchAnalystIndex();
if (!index) console.warn('  (no analyst index — analyst clauses left as they are)');

let changed = 0, skipped = 0, tooLong = 0;
const samples = [];

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.html'))) {
  const file = path.join(DIR, f);
  const html = fs.readFileSync(file, 'utf8');

  // Report pages only. The 1,157 company overview pages already carry a better description
  // than any template here could produce -- "2cureX (2CUREX.ST) financial overview for 2025:
  // revenue, EBIT, net earnings, book value, year-end share price and market capitalisation"
  // is specific, dated and inside the limit. Rewriting those would be a downgrade.
  if (!/valuatum-page-mode/.test(html)) { skipped++; continue; }

  const id = identity(html);
  if (!id) { skipped++; continue; }
  const headline = headlineOf(html);
  const clause = analystClause(index, id.ticker, headline?.recommendation) || { analysts: 0, disagrees: null };

  const next = reportDescription({
    name: shortName(id.name),
    ticker: id.ticker,
    recommendation: headline?.recommendation,
    targetPrice: headline?.targetPrice,
    analysts: clause.analysts,
    disagrees: clause.disagrees,
  });
  if (next.length > DESCRIPTION_LIMIT) tooLong++;

  let out = html.replace(/(<meta name="description" content=")[\s\S]*?(">)/, (_m, a, b) => `${a}${attr(next)}${b}`);

  // og:/twitter: descriptions follow the same rule as the share card: with ratings off they
  // keep the rating-free wording rather than inheriting the snippet.
  if (SHOW_RATINGS_IN_METADATA || !headline) {
    for (const [tag, attrName] of [['og:description', 'property'], ['twitter:description', 'name']]) {
      out = out.replace(new RegExp(`(<meta ${attrName}="${tag}" content=")[\\s\\S]*?(">)`),
        (_m, a, b) => `${a}${attr(next)}${b}`);
    }
  }

  if (out === html) continue;
  changed++;
  if (samples.length < 5) samples.push([next.length, next]);
  if (!CHECK) fs.writeFileSync(file, out);
}

console.log(`${CHECK ? '[check] ' : ''}${changed} descriptions ${CHECK ? 'out of date' : 'rewritten'}`
  + `, ${skipped} left alone (company overview pages)${tooLong ? `, ${tooLong} still over ${DESCRIPTION_LIMIT}` : ''}`);
samples.forEach(([n, s]) => console.log(`  ${String(n).padStart(3)}  ${s}`));
if (CHECK && changed) {
  console.error('Descriptions are out of date — run: node scripts/redescribe-report-pages.mjs');
  process.exit(1);
}
