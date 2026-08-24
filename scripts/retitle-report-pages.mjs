#!/usr/bin/env node
// One-off migration: bring already-built pages under /reports/ onto the shortened title
// rule in scripts/seo-title.mjs.
//
// The generators are fixed too, but sync.mjs needs the live catalog and generate-company-
// pages.mjs needs Wisdom, so the 1,174 pages on disk cannot simply be rebuilt offline.
// Everything below is derived from what is already in each file — no network, no new facts.
//
//   node scripts/retitle-report-pages.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportTitle, companyTitle, TITLE_LIMIT } from './seo-title.mjs';
import { SHOW_RATINGS_IN_METADATA } from './seo-flags.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'reports');
const CHECK = process.argv.includes('--check');

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s) => esc(s).replace(/"/g, '&quot;');

/** Pull company name, ticker and (where present) the rating out of the built page. */
function parse(html) {
  const title = dec((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
  const desc = dec((html.match(/<meta name="description" content="([\s\S]*?)">/) || [])[1] || '');
  // "Kesko (KESKOB.HE) Stock Analysis & AI Equity Report — ..."
  const m = title.match(/^(.*?)\s*\(([^)]+)\)\s*(?:Stock Analysis|Stock Forecast|Valuation)/);
  if (!m) return null;
  const [, name, ticker] = m;
  // "...Valuatum rates KESKOB.HE SELL with a 17.10 EUR price target vs 19.20 EUR."
  const r = desc.match(/rates\s+\S+\s+([A-Z]+)\s+with a\s+([\d.,]+\s*[A-Z]{3})\s+price target/);
  return { name: name.trim(), ticker: ticker.trim(), headline: r ? { recommendation: r[1], targetPrice: r[2] } : null };
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.html'));
let changed = 0, skipped = 0, tooLong = 0;
const samples = [];

for (const f of files) {
  const file = path.join(DIR, f);
  const html = fs.readFileSync(file, 'utf8');
  const d = parse(html);
  if (!d) { skipped++; continue; }

  const next = d.headline ? reportTitle(d.name, d.ticker, d.headline) : companyTitle(d.name, d.ticker);
  if (next.length > TITLE_LIMIT) tooLong++;

  // Function replacements throughout: a literal "$276" in a string replacement would be
  // read as capture group $2 followed by "76" and silently corrupt the tag.
  let out = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(next)}</title>`);
  out = out.replace(/(<meta property="og:title" content=")[\s\S]*?(">)/, (_m, a, b) => `${a}${attr(next)}${b}`);
  // twitter:title stays its own shorter line; only rewrite it when it carried the old boilerplate.
  out = out.replace(/(<meta name="twitter:title" content=")[\s\S]*?(">)/, (mm, a, b) =>
    /Price Target & Valuation \| Valuatum/.test(mm) ? `${a}${attr(next)}${b}` : mm);

  // The share card is one surface: neutral art beside text reading "rates KESKOB.HE SELL"
  // is worse than either alone. The plain <meta name="description"> is left alone on purpose
  // -- that is the Google snippet, a wider question than the share card.
  if (!SHOW_RATINGS_IN_METADATA && d.headline) {
    const share = `${d.name} (${d.ticker}) stock analysis & AI equity report: segment-value `
      + `analysis, reverse valuation, financial estimates, risks & catalysts, with a 12-month price target.`;
    for (const tag of ['og:description', 'twitter:description']) {
      const attrName = tag.startsWith('og:') ? 'property' : 'name';
      // Double-escaped: inside a template literal "\s" collapses to "s", which would build
      // the character class [sS] and match almost nothing.
      out = out.replace(new RegExp(`(<meta ${attrName}="${tag}" content=")[\\s\\S]*?(">)`),
        (_m, a, b) => `${a}${attr(share)}${b}`);
    }
  }

  if (out !== html) {
    changed++;
    if (samples.length < 6) samples.push([d.name, next.length, next]);
    if (!CHECK) fs.writeFileSync(file, out);
  }
}

console.log(`${CHECK ? '[check] ' : ''}${changed} retitled, ${skipped} skipped (no parse), ${tooLong} still over ${TITLE_LIMIT} chars`);
samples.forEach(([n, len, t]) => console.log(`  ${String(len).padStart(3)}  ${t}`));
if (CHECK && changed) {
  console.error('Titles are out of date — run: node scripts/retitle-report-pages.mjs');
  process.exit(1);
}
