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

const section = (ticker, name) => `    <!-- Public surface for the analyst layer. Always shown: when nobody has published on
         this company the script says so, which tells a reader the layer exists. -->
    <section class="container analyst-reports" id="analyst-reports" data-analyst-reports data-company="${attr(name)}" data-ticker="${attr(ticker)}"
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

const JUMP = '  <a href="#analyst-reports" class="btn btn-gold analyst-jump" data-analyst-jump'
  + ' style="font-size:var(--text-xs);">Analyst reports</a>\n          ';

let added = 0, already = 0, skipped = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.html'))) {
  const file = path.join(DIR, f);
  const html = fs.readFileSync(file, 'utf8');

  const title = dec((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
  const m = title.match(/^(.*?)\s*\(([^)]+)\)\s*(?:Stock|Valuation)/);
  if (!m) { skipped++; continue; }
  const [, name, ticker] = m;

  let next = html;

  // Each piece is added only if absent, so a page that already has the section never gets a
  // second one. (It did once: keying "is this done?" off the jump button alone appended a
  // duplicate section to every page that already had one.)
  if (!next.includes('data-analyst-reports')) {
    // Sits at the end of <main>, after the report body and before the footer.
    const closeMain = next.lastIndexOf('  </main>');
    if (closeMain === -1) { skipped++; continue; }
    next = next.slice(0, closeMain) + section(ticker.trim(), name.trim()) + next.slice(closeMain);
  } else {
    // Present from an earlier run: bring it up to date in place rather than adding another.
    if (!/id="analyst-reports"/.test(next)) {
      next = next.replace('<section class="container analyst-reports" data-analyst-reports',
        '<section class="container analyst-reports" id="analyst-reports" data-analyst-reports');
    }
    // The section and the button used to be hidden when a company had no coverage. They are
    // always shown now: the section states that nobody has published on this company yet,
    // which tells a reader the layer exists, where an absent section tells them nothing.
    next = next.replace(/(<section class="container analyst-reports"[^>]*?) hidden(\r?\n)/, '$1$2');
    next = next.replace(' class="btn btn-gold analyst-jump" data-analyst-jump hidden',
      ' class="btn btn-gold analyst-jump" data-analyst-jump');
    if (!/data-analyst-reports data-company=/.test(next)) {
      next = next.replace('data-analyst-reports data-ticker=',
        `data-analyst-reports data-company="${attr(name.trim())}" data-ticker=`);
    }
  }

  // Top-of-page entry point. The section sits below the report body, so without this the
  // marketplace is only findable by scrolling past the whole thing. The script replaces the
  // label with a count once it knows one.
  if (!next.includes('data-analyst-jump')) {
    const actions = next.indexOf('</div>', next.indexOf('class="company-header-actions"'));
    if (actions !== -1) {
      next = next.slice(0, actions) + JUMP + next.slice(actions);
    }
  }

  if (!next.includes('/js/analyst-reports.js')) {
    const anchor = '  <script src="/js/script.js"></script>';
    next = next.includes(anchor)
      ? next.replace(anchor, () => `${anchor}\n${SCRIPT}`)
      : next.replace(/<\/body>/, () => `${SCRIPT}\n</body>`);
  }

  if (next === html) { already++; continue; }
  added++;
  if (!CHECK) fs.writeFileSync(file, next);
}

console.log(`${CHECK ? '[check] ' : ''}${added} pages ${CHECK ? 'out of date' : 'updated'}`
  + `, ${already} already complete${skipped ? `, ${skipped} skipped (no parse)` : ''}`);
if (CHECK && added) {
  console.error('Analyst section missing — run: node scripts/add-analyst-section.mjs');
  process.exit(1);
}
