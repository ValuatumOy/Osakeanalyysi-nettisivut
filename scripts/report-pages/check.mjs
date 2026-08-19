#!/usr/bin/env node
// The guard: verifies that the committed report pages agree with the live catalog under the
// page-owner rule, that the baked reports.html cards match the pages, and that every JSON-LD
// block parses. Runs in two places — inside the sync workflow before its commit (so an
// inconsistent state never reaches main), and as an ordinary push/PR workflow for human edits.
//
// Because the whole site is baked, a failing check means the site is frozen at its last
// consistent state; nothing else surfaces that, so failures here must be loud.
//
// Run: node scripts/report-pages/check.mjs [--allow-missing id1,id2] [--allow-missing-file <file>]
//   --allow-missing[-file]  live report ids with no extracted content that are already known
//                           (i.e. this run's failed extractions) — reported but not fatal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchLiveCatalog } from '../live-catalog.mjs';
import { catalogById, loadContentDocs, resolveState, EXCLUDE, PAGES_DIR } from './owners.mjs';
import { parseListingCards } from './render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const allow = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-missing') for (const id of String(argv[++i]).split(',')) allow.add(id.trim());
    else if (a === '--allow-missing-file') {
      const file = argv[++i];
      if (fs.existsSync(file)) {
        for (const id of fs.readFileSync(file, 'utf8').split('\n')) if (id.trim()) allow.add(id.trim());
      }
    } else throw new Error(`Unknown flag ${a}`);
  }
  return { allow };
}

const meta = (html, name) =>
  (html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`)) || [])[1] ?? null;

function checkJsonLd(file, html, violations) {
  for (const m of html.matchAll(/<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/gi)) {
    try {
      JSON.parse(m[1]);
    } catch (e) {
      violations.push(`${file}: invalid JSON-LD (${e.message})`);
    }
  }
}

async function main() {
  const { allow } = parseArgs(process.argv.slice(2));
  const violations = [];
  const allowed = [];

  const catalog = await fetchLiveCatalog();
  const docs = loadContentDocs();
  const { companies } = resolveState(catalog, docs);
  const live = catalogById(catalog);

  // Every live ready report either has extracted content or is a known exclusion/failure.
  for (const entry of live.values()) {
    if (docs.has(entry.id) || EXCLUDE.has(entry.id)) continue;
    const msg = `live report ${entry.id} (${entry.companyName || entry.name}) has no report-content file`;
    if (allow.has(entry.id)) allowed.push(msg);
    else violations.push(msg);
  }

  // Every company page exists and was built for the report the page-owner rule picks.
  for (const company of companies.values()) {
    const file = path.join(PAGES_DIR, `${company.slug}.html`);
    const rel = `reports/${company.slug}.html`;
    if (!fs.existsSync(file)) {
      violations.push(`${rel}: page missing (expected ${company.mode} page${company.owner ? ` for ${company.owner.doc.id}` : ''})`);
      continue;
    }
    const html = fs.readFileSync(file, 'utf8');
    const pageId = meta(html, 'valuatum-report-id');
    const pageMode = meta(html, 'valuatum-page-mode');
    if (pageId === null || pageMode === null) {
      violations.push(`${rel}: not built by the report-page sync (identity meta tags missing)`);
      continue;
    }
    const expectedId = company.owner ? company.owner.doc.id : '';
    if (pageId !== expectedId) {
      violations.push(`${rel}: built for "${pageId || 'coverage'}" but the page-owner rule picks "${expectedId || 'coverage'}"`);
    }
    if (pageMode !== company.mode) {
      violations.push(`${rel}: rendered as ${pageMode} but the catalog says ${company.mode}`);
    }
    checkJsonLd(rel, html, violations);
  }

  // The baked reports.html cards: one per company with a live report, newest first, matching pages.
  const listingHtml = fs.readFileSync(path.join(ROOT, 'reports.html'), 'utf8');
  const cards = parseListingCards(listingHtml);
  if (!cards) {
    violations.push('reports.html: the baked report-cards markers are missing');
  } else {
    const expected = [...companies.values()]
      .filter((c) => c.owner)
      .sort((a, b) => String(b.owner.cat.reportDateIso || b.owner.cat.reportDate || '')
        .localeCompare(String(a.owner.cat.reportDateIso || a.owner.cat.reportDate || '')));
    const expectedIds = expected.map((c) => c.owner.doc.id);
    const cardIds = cards.map((c) => c.id);
    if (JSON.stringify(cardIds) !== JSON.stringify(expectedIds)) {
      violations.push(`reports.html: baked cards [${cardIds.join(', ')}] do not match the page owners [${expectedIds.join(', ')}]`);
    } else {
      for (let i = 0; i < cards.length; i++) {
        const company = expected[i];
        if (cards[i].pageUrl !== `/reports/${company.slug}.html`) {
          violations.push(`reports.html: card ${cards[i].id} links to ${cards[i].pageUrl}, expected /reports/${company.slug}.html`);
        }
        if (cards[i].free !== (company.mode === 'free')) {
          violations.push(`reports.html: card ${cards[i].id} is marked ${cards[i].free ? 'free' : 'paid'} but the catalog says ${company.mode}`);
        }
      }
    }
  }
  checkJsonLd('reports.html', listingHtml, violations);

  for (const msg of allowed) console.log(`allowed  ${msg} (extraction failed this run)`);
  if (violations.length) {
    console.error(`\n${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(`✓ ${companies.size} pages, ${cards ? cards.length : 0} cards consistent with the live catalog.`);
}

main().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
