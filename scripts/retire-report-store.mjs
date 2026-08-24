#!/usr/bin/env node
// Retire /report-store.html and put /companies.html in the nav slot it was using.
//
// The store was built around the analyst layer -- "Every Report, Every Analyst", the word
// "analyst" 31 times in a 303-word page -- and no analyst has published yet. With that
// layer empty it showed a filtered view of the same catalogue reports.html already shows,
// which is why its own copy had to send people away: "To buy a Valuatum report on its own,
// or order a fresh one for a company nobody has covered yet, use the reports page."
// Search Console agrees: indexed, crawled, linked from every page in the site, 0
// impressions and 0 clicks in 30 days.
//
// The nav slot goes to the company index, which does need a sitewide entry point, so the
// nav keeps its shape and 1,158 pages gain a link from every page on the site.
//
//   node scripts/retire-report-store.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const SKIP_DIRS = new Set(['node_modules', '.git', '.codex_pdf_audit', 'mockups']);

/** Desktop and mobile nav entries, and the handful of prose links. */
const RULES = [
  // nav: Store -> Companies
  [/<a href="(\/?)report-store\.html" class="nav-link">Store<\/a>/g,
    '<a href="$1companies.html" class="nav-link">Companies</a>'],
  [/<a href="(\/?)report-store\.html" class="nav-mobile-link">Store<\/a>/g,
    '<a href="$1companies.html" class="nav-mobile-link">Companies</a>'],
  // any other nav shape that still points at the store
  [/href="(\/?)report-store\.html"([^>]*class="nav-[^"]*")>Store</g, 'href="$1companies.html"$2>Companies<'],
  // prose: the store no longer exists, the reports page is what these meant
  [/<a href="(\/?)report-store\.html"([^>]*)>report store<\/a>/g, '<a href="$1reports.html"$2>reports page</a>'],
  [/<a href="(\/?)report-store\.html"([^>]*)>Browse the report store<\/a>/g, '<a href="$1reports.html"$2>Browse the reports</a>'],
  // catch-all for any link left over
  [/href="(\/?)report-store\.html"/g, 'href="$1reports.html"'],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (/\.(html|mjs|js)$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

const store = path.join(ROOT, 'report-store.html');
let touched = 0;
for (const file of walk(ROOT)) {
  if (file === store) continue;
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [re, to] of RULES) after = after.replace(re, to);
  if (after === before) continue;
  touched++;
  if (!CHECK) fs.writeFileSync(file, after);
}

// The page itself goes; vercel.json 301s it so the ~20 pages that linked to it, and
// whatever Google has indexed, consolidate onto reports.html instead of 404ing.
const storeExists = fs.existsSync(store);
if (storeExists && !CHECK) fs.unlinkSync(store);

console.log(`${CHECK ? '[check] ' : ''}${touched} files ${CHECK ? 'still reference' : 'updated'}, report-store.html ${storeExists ? (CHECK ? 'still present' : 'removed') : 'already gone'}`);
if (CHECK && (touched || storeExists)) {
  console.error('Report store is not fully retired — run: node scripts/retire-report-store.mjs');
  process.exit(1);
}
