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
import { fetchAnalystIndex, analystClause } from '../analyst-index.mjs';
import { extractReport } from './extract.mjs';
import { loadEnv } from './openrouter.mjs';
import { loadContentDocs, resolveState, CONTENT_DIR, PAGES_DIR } from './owners.mjs';
import { IS_TEST } from './stage.mjs';
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

// The test catalog carries PDFs no extraction can read: the engine's one-page stub for a run
// that failed. Each would fail the gate again every hour and cost a call each time, so on the
// test site a failed id is remembered and not tried again; deleting the file retries them all.
const TEST_FAILED_FILE = path.join(CONTENT_DIR, '_failed.json');

function readTestFailed() {
  if (!IS_TEST || !fs.existsSync(TEST_FAILED_FILE)) return {};
  return JSON.parse(fs.readFileSync(TEST_FAILED_FILE, 'utf8'));
}

// test.aiequityreports.com's report pages: one per company that has a live report in the test
// catalog, kept out of search engines, plus the index js/script.js reads to send a reader from a
// production page to its test version. Companies with no test report keep the production page,
// so nothing here is a coverage page, and reports.html and the sitemap are production's alone.
const NOINDEX = '<meta name="robots" content="noindex, nofollow">';

function buildTestSite(companies, pageDocs) {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const owned = [...companies.values()].filter((c) => c.owner);
  const keep = new Set(owned.map((c) => `${c.slug}.html`));
  for (const file of fs.readdirSync(PAGES_DIR)) {
    if (file.endsWith('.html') && !keep.has(file)) {
      fs.rmSync(path.join(PAGES_DIR, file));
      console.log(`removed reports/${file} (no live test report)`);
    }
  }
  let changed = 0;
  for (const company of owned) {
    const html = renderPage(company.owner.doc, company.owner.cat, pageDocs).replace(/<head>/i, (m) => `${m}\n  ${NOINDEX}`);
    const wrote = writeIfChanged(path.join(PAGES_DIR, `${company.slug}.html`), html);
    if (wrote) changed++;
    console.log(`${wrote ? 'wrote ' : 'ok    '} test-site/reports/${company.slug}.html  (${company.mode}, ${company.owner.doc.id})`);
  }
  const index = owned
    .map((c) => ({ slug: c.slug, ticker: c.owner.doc.ticker || '', reportId: c.owner.doc.id }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  writeIfChanged(path.join(PAGES_DIR, 'index.json'), `${JSON.stringify({ pages: index }, null, 2)}\n`);
  return changed;
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
    const failedBefore = readTestFailed();
    const toExtract = resolveState(catalog, loadContentDocs()).toExtract.filter((e) => !failedBefore[e.id]);
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

  if (IS_TEST) {
    if (failures.length) {
      const failed = readTestFailed();
      for (const f of failures) failed[f.id] = f.error;
      fs.mkdirSync(CONTENT_DIR, { recursive: true });
      fs.writeFileSync(TEST_FAILED_FILE, `${JSON.stringify(failed, null, 2)}\n`);
    }
    const changed = buildTestSite(companies, pageDocs);
    const spend = extracted.reduce((sum, r) => sum + (r.usd || 0), 0);
    if (opts.failuresOut) fs.writeFileSync(opts.failuresOut, failures.map((f) => `${f.id}\n`).join(''));
    console.log(`\ntest site: ${changed} pages changed · ${extracted.length} extracted ($${spend.toFixed(4)}) · ${failures.length} failed (remembered in _failed.json)`);
    return;
  }

  // The meta description mentions the analyst reports a company has, from the
  // same index scripts/redescribe-report-pages.mjs reads. Without it every
  // rebuilt page lost that clause and the SEO guard flagged it on the next PR.
  const analystIndex = await fetchAnalystIndex();
  if (!analystIndex) console.warn('  (no analyst index — descriptions will omit analyst counts)');

  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const changedPages = [];
  for (const company of companies.values()) {
    const d = company.owner ? company.owner.doc : coverageDocFrom(company.newestDoc);
    const cat = company.owner ? company.owner.cat : null;
    const clause = analystClause(analystIndex, d.ticker, d.headline?.recommendation);
    if (clause) {
      d.analystCount = clause.analysts;
      d.analystDisagrees = clause.disagrees;
    }
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
