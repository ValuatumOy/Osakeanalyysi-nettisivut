#!/usr/bin/env node
// The whole report-page automation, as one idempotent pass (docs/report-page-automation.md):
//
//   live catalog  vs  report-content/  vs  reports/
//     ├ missing content        → extract (strict gate — a failure skips the report, run fails)
//     ├ state changed          → rebuild landing page (free / paid / coverage)
//     ├ left the catalog       → rebuild as coverage page
//     └ always                 → reports.html card grid, sitemap entries
//
// Everything is derived from current state, so it does not matter which event woke the run; a
// no-change pass writes nothing. The GitHub Actions workflow commits whatever this changes.
//
// Run: node scripts/report-pages/sync.mjs [--no-extract] [--failures-out <file>]
//   --no-extract      rebuild pages from committed content only (no OpenRouter calls)
//   --failures-out    write failed extraction ids to <file> and exit 0; the workflow turns
//                     them into a loud failure after committing the good work
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchLiveCatalog } from '../live-catalog.mjs';
import { extractReport } from './extract.mjs';
import { loadEnv } from './openrouter.mjs';
import { loadContentDocs, resolveState, PAGES_DIR } from './owners.mjs';
import {
  SITE,
  coverageDocFrom,
  injectListing,
  loadCompanyPageCatalog,
  renderCards,
  renderPage,
  upsertSitemapEntry,
} from './render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const opts = { extract: true, failuresOut: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-extract') opts.extract = false;
    else if (a === '--failures-out') opts.failuresOut = path.resolve(argv[++i]);
    else throw new Error(`Unknown flag ${a}`);
  }
  return opts;
}

/** Write only when the content differs; returns whether the file changed on disk. */
function writeIfChanged(file, content) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (existing === content) return false;
  fs.writeFileSync(file, content);
  return true;
}

function headlineRow(r) {
  const h = r.headline || {};
  return `| ${r.companyName} | ${h.recommendation || '—'} | ${h.currentPrice || '—'} | ${h.targetPrice || '—'} | ${h.impliedUpside || '—'} |`;
}

async function main() {
  loadEnv(ROOT);
  const opts = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);

  const catalog = await fetchLiveCatalog();

  // ── extract content for live reports that have none ────────────────────────
  const extracted = [];
  const failures = [];
  {
    const { toExtract } = resolveState(catalog, loadContentDocs());
    if (toExtract.length && !opts.extract) {
      console.log(`skip extraction (--no-extract): ${toExtract.map((e) => e.id).join(', ')}`);
    }
    if (opts.extract) {
      for (const entry of toExtract) {
        try {
          const run = await extractReport(entry);
          extracted.push(run);
          console.log(`extracted  ${entry.id} → ${path.relative(ROOT, run.outPath)} (${run.headline?.recommendation}, target ${run.headline?.targetPrice})`);
        } catch (err) {
          failures.push({ id: entry.id, error: err.message });
          console.error(`FAILED     ${entry.id}: ${err.message}`);
        }
      }
    }
  }

  // ── resolve owners from the final content set and build every page ──────────
  const { companies } = resolveState(catalog, loadContentDocs());
  const pageDocs = [...companies.values()].map((c) => (c.owner ? c.owner.doc : coverageDocFrom(c.newestDoc)));

  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const changedPages = [];
  for (const company of companies.values()) {
    const d = company.owner ? company.owner.doc : coverageDocFrom(company.newestDoc);
    const cat = company.owner ? company.owner.cat : null;
    const file = path.join(PAGES_DIR, `${company.slug}.html`);
    const changed = writeIfChanged(file, renderPage(d, cat, pageDocs));
    if (changed) changedPages.push(company.slug);
    console.log(`${changed ? 'wrote ' : 'ok    '} reports/${company.slug}.html  (${company.mode}${company.owner ? `, ${company.owner.doc.id}` : ''})`);
  }

  // ── bake the reports.html card grid ─────────────────────────────────────────
  const listingFile = path.join(ROOT, 'reports.html');
  const listing = renderCards(companies, loadCompanyPageCatalog());
  const listingHtml = injectListing(fs.readFileSync(listingFile, 'utf8'), listing);
  const listingChanged = writeIfChanged(listingFile, listingHtml);
  console.log(`${listingChanged ? 'wrote ' : 'ok    '} reports.html  (${listing.count} cards)`);

  // ── sitemap: stamp lastmod only for pages that actually changed ─────────────
  const sitemapFile = path.join(ROOT, 'sitemap.xml');
  let sitemap = fs.readFileSync(sitemapFile, 'utf8');
  for (const company of companies.values()) {
    const loc = `${SITE}/reports/${company.slug}.html`;
    sitemap = upsertSitemapEntry(sitemap, loc, changedPages.includes(company.slug) ? today : null, today);
  }
  sitemap = upsertSitemapEntry(sitemap, `${SITE}/reports.html`, listingChanged ? today : null, today);
  const sitemapChanged = writeIfChanged(sitemapFile, sitemap);
  console.log(`${sitemapChanged ? 'wrote ' : 'ok    '} sitemap.xml`);

  // ── summaries ───────────────────────────────────────────────────────────────
  if (extracted.length && process.env.GITHUB_STEP_SUMMARY) {
    const table = [
      '## Extracted report content — glance at the figures',
      '',
      '| Company | Rating | Current price | Target | Upside |',
      '| --- | --- | --- | --- | --- |',
      ...extracted.map(headlineRow),
      '',
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + '\n');
  }
  if (failures.length && process.env.GITHUB_STEP_SUMMARY) {
    const lines = failures.map((f) => `- **${f.id}**: ${f.error}`).join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Failed extractions\n\n${lines}\n`);
  }

  const spend = extracted.reduce((sum, r) => sum + (r.usd || 0), 0);
  console.log(
    `\n${companies.size} companies · ${changedPages.length} pages changed · ` +
    `${extracted.length} extracted ($${spend.toFixed(4)}) · ${failures.length} failed`,
  );

  if (opts.failuresOut) {
    fs.writeFileSync(opts.failuresOut, failures.map((f) => f.id).join('\n') + (failures.length ? '\n' : ''));
  } else if (failures.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
