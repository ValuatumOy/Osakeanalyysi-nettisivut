#!/usr/bin/env node
// Put the analyst-reports section on the pages already built.
//
// Both renderers emit it now, but sync.mjs needs the live catalog and generate-company-
// pages.mjs needs Wisdom, so the 1,174 pages on disk cannot be rebuilt offline. Ticker and
// company name are read out of each page's own title.
//
//   node scripts/add-analyst-section.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'reports');
const CHECK = process.argv.includes('--check');

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s) => esc(s).replace(/"/g, '&quot;');

const section = (ticker, name) => `    <!-- Public surface for the analyst layer: hidden until the members API returns an
         analysis for this company, so a company nobody has covered shows nothing. -->
    <section class="container analyst-reports" data-analyst-reports data-ticker="${attr(ticker)}" hidden
             style="max-width:1760px; padding-bottom:3rem;">
      <div class="store-company-head">
        <h2 style="font-size:var(--text-2xl); font-weight:300; margin:0;">Analyst reports on ${esc(name)}</h2>
        <span class="store-count" data-analyst-count></span>
      </div>
      <p class="store-note" style="max-width:70ch;">Each is this company's Valuatum report re-run with an analyst's own
        assumptions and published under their name. They are ordered by what other analysts said the work added over the
        engine's report &mdash; a score out of five from people who had to read it to give it.</p>
      <div class="store-banner" data-analyst-banner hidden></div>
      <div data-analyst-list></div>
    </section>
`;

const SCRIPT = '  <script src="/js/analyst-reports.js" defer></script>';

let added = 0, already = 0, skipped = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.html'))) {
  const file = path.join(DIR, f);
  const html = fs.readFileSync(file, 'utf8');

  if (html.includes('data-analyst-reports')) { already++; continue; }

  const title = dec((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
  const m = title.match(/^(.*?)\s*\(([^)]+)\)\s*(?:Stock|Valuation)/);
  if (!m) { skipped++; continue; }
  const [, name, ticker] = m;

  // Sits at the end of <main>, after the report body and before the footer.
  const closeMain = html.lastIndexOf('  </main>');
  if (closeMain === -1) { skipped++; continue; }

  let next = html.slice(0, closeMain) + section(ticker.trim(), name.trim()) + html.slice(closeMain);

  if (!next.includes('/js/analyst-reports.js')) {
    const anchor = '  <script src="/js/script.js"></script>';
    next = next.includes(anchor)
      ? next.replace(anchor, () => `${anchor}\n${SCRIPT}`)
      : next.replace(/<\/body>/, () => `${SCRIPT}\n</body>`);
  }

  added++;
  if (!CHECK) fs.writeFileSync(file, next);
}

console.log(`${CHECK ? '[check] ' : ''}${added} pages ${CHECK ? 'missing the section' : 'given the section'}`
  + `, ${already} already had it${skipped ? `, ${skipped} skipped (no parse)` : ''}`);
if (CHECK && added) {
  console.error('Analyst section missing — run: node scripts/add-analyst-section.mjs');
  process.exit(1);
}
