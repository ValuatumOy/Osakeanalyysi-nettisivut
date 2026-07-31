#!/usr/bin/env node
// Resolves which report-content/*.json is CURRENT for each covered company.
//
// Why this exists: report files are added under a dated filename AND updated
// in place, so the date in the filename is NOT the date of the data inside.
// As of writing, tesla-01062026.json holds a 2026-07-23 report while
// tesla-07072026.json holds 2026-07-07 — picking "the newest Tesla file" by
// name gives you data two weeks stale. Blog posts cited that way go out with
// ratings that contradict the live site. Always resolve through this module;
// never glob report-content/*.json and guess.
//
// Companies are keyed by `slug` (e.g. upm-equity-report), which is stable
// across report versions. Recency is decided by the `reportDate` FIELD.
//
// A file is a "full" report only if it carries headline.recommendation.
// Coverage stubs (orion-coverage.json, fortum-coverage.json) are placeholders
// for covered-but-unrated companies and can carry a NEWER reportDate than the
// last real report — they must never shadow a rated report for citation.
//
// Run: node scripts/report-index.mjs            # human-readable table
//      node scripts/report-index.mjs --json     # machine-readable
//      node scripts/report-index.mjs --live     # also flag catalog reports missing locally
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = path.join(ROOT, 'report-content');

// Kept in sync with the same constant in build-report-pages.mjs: reports whose
// content does not match their catalog identity. The site refuses to publish
// them, so a blog post must not cite them either.
const EXCLUDE = new Set(['nuholdings-02062026']);

/**
 * The ddmmyyyy encoded in a report id (upm-21052026 → 2026-05-21), or null for
 * ids with no date (coverage stubs). Used ONLY to detect filename/data
 * disagreement — never to decide recency.
 */
function filenameDate(id) {
  const m = /-(\d{2})(\d{2})(\d{4})$/.exec(id);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// ── loading ────────────────────────────────────────────────────────────────

/** Read and normalise every report file. Throws on unreadable/invalid JSON. */
export function loadAllReports() {
  if (!fs.existsSync(CONTENT_DIR)) throw new Error(`report-content not found at ${CONTENT_DIR}`);
  const files = fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .filter((f) => !EXCLUDE.has(f.replace(/\.json$/, '')));
  return files.map((file) => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8'));
    } catch (e) {
      throw new Error(`HARD FAIL: report-content/${file} is not valid JSON: ${e.message}`);
    }
    const headline = data.headline || {};
    const reportDate = String(data.reportDate || '').substring(0, 10);
    if (!reportDate) throw new Error(`HARD FAIL: report-content/${file} has no reportDate.`);
    if (!data.slug) throw new Error(`HARD FAIL: report-content/${file} has no slug.`);
    return {
      file,
      id: data.id || file.replace(/\.json$/, ''),
      slug: data.slug,
      ticker: data.ticker || null,
      companyName: data.companyName || data.slug,
      reportDate,
      filenameDate: filenameDate(data.id || file.replace(/\.json$/, '')),
      // Only a rated report is citable for a valuation claim.
      kind: headline.recommendation ? 'full' : 'coverage',
      recommendation: headline.recommendation || null,
      currentPrice: headline.currentPrice || null,
      targetPrice: headline.targetPrice || null,
      impliedUpside: headline.impliedUpside || null,
    };
  });
}

// Newest first; tie-break on id so ordering is deterministic across machines.
const byDateDesc = (a, b) => (a.reportDate === b.reportDate ? b.id.localeCompare(a.id) : b.reportDate.localeCompare(a.reportDate));

/**
 * Index of covered companies keyed by slug.
 * `current` is the newest RATED report — the only thing a blog post may cite
 * for a valuation claim. `superseded` lists older versions still on disk.
 */
export function buildReportIndex() {
  const bySlug = new Map();
  for (const r of loadAllReports()) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push(r);
  }
  const index = new Map();
  for (const [slug, versions] of bySlug) {
    versions.sort(byDateDesc);
    const rated = versions.filter((v) => v.kind === 'full');
    const current = rated[0] || null;
    index.set(slug, {
      slug,
      ticker: versions[0].ticker,
      companyName: versions[0].companyName,
      current,                                   // newest RATED report, or null if only stubs
      newestAny: versions[0],                    // newest file regardless of kind
      superseded: versions.filter((v) => v !== current),
      // True when a stub is newer than the newest rating: coverage exists but
      // the rating behind it is older than the stub implies.
      stubShadowsRating: Boolean(current) && versions[0].kind === 'coverage' && versions[0].reportDate > current.reportDate,
      // Files whose NAME implies they are newer than the file that actually
      // holds the newest data. These are the ones that mislead a picker.
      misleadingFilenames: current
        ? versions.filter(
            (v) => v !== current && v.filenameDate && current.filenameDate && v.filenameDate > current.filenameDate
          )
        : [],
    });
  }
  return index;
}

/** Look up a company by slug, ticker, or report id. Case-insensitive. */
export function resolveCompany(key) {
  const index = buildReportIndex();
  const needle = String(key || '').toLowerCase();
  for (const entry of index.values()) {
    if (entry.slug.toLowerCase() === needle) return entry;
    if (entry.ticker && entry.ticker.toLowerCase() === needle) return entry;
  }
  // Fall back to matching a specific report id (e.g. upm-21052026).
  for (const entry of index.values()) {
    const all = [entry.current, ...entry.superseded].filter(Boolean);
    if (all.some((r) => r.id.toLowerCase() === needle)) return entry;
  }
  return null;
}

/**
 * The report a blog post must cite for `key`. Throws rather than returning a
 * stub, so a caller can never silently quote an unrated company.
 */
export function currentReportFor(key) {
  const entry = resolveCompany(key);
  if (!entry) throw new Error(`HARD FAIL: no report-content entry for "${key}".`);
  if (!entry.current) {
    throw new Error(
      `HARD FAIL: "${key}" is covered but has no rated report — only a coverage stub ` +
      `(${entry.newestAny.file}). It has no recommendation or target price, so it cannot ` +
      `support a valuation claim. Pick a different company or narrow the article.`
    );
  }
  return entry.current;
}

/** Every company's current rated report, alphabetical by slug. */
export function currentReports() {
  return [...buildReportIndex().values()]
    .filter((e) => e.current)
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((e) => e.current);
}

// ── live cross-check ───────────────────────────────────────────────────────

/**
 * Compare committed report-content against the live catalog the rest of the
 * site builds from. Surfaces reports that are live but not yet committed —
 * i.e. cases where report-content itself is the stale thing.
 * Never throws on network failure; returns { ok:false, reason } instead, so a
 * freshness gate can still run offline.
 */
export async function crossCheckLiveCatalog() {
  let catalog;
  try {
    const { fetchLiveCatalog } = await import('./live-catalog.mjs');
    catalog = await fetchLiveCatalog();
  } catch (e) {
    return { ok: false, reason: e.message, missing: [], newerLive: [] };
  }
  const index = buildReportIndex();
  const localIds = new Set();
  for (const entry of index.values()) {
    for (const r of [entry.current, ...entry.superseded].filter(Boolean)) localIds.add(r.id);
  }
  const missing = [];
  const newerLive = [];
  for (const c of catalog) {
    const cid = c.id || c.slug;
    if (!cid) continue;
    const liveDate = String(c.reportDate || c.date || '').substring(0, 10);
    if (!localIds.has(cid)) {
      missing.push({ id: cid, reportDate: liveDate || 'unknown' });
      continue;
    }
    if (!liveDate) continue;
    const entry = resolveCompany(cid);
    if (entry && entry.current && liveDate > entry.current.reportDate) {
      newerLive.push({ id: cid, liveDate, localDate: entry.current.reportDate });
    }
  }
  return { ok: true, missing, newerLive };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const index = buildReportIndex();
  const entries = [...index.values()].sort((a, b) => a.slug.localeCompare(b.slug));

  if (args.includes('--json')) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  console.log('CURRENT report per company (cite these — never pick by filename):\n');
  const pad = (s, n) => String(s ?? '—').padEnd(n);
  console.log(pad('COMPANY', 26) + pad('CURRENT FILE', 28) + pad('DATE', 12) + pad('REC', 6) + 'TARGET');
  console.log('─'.repeat(96));
  for (const e of entries) {
    const c = e.current;
    console.log(
      pad(e.companyName.slice(0, 25), 26) +
      pad(c ? c.file : `(stub ${e.newestAny.file})`, 28) +
      pad(c ? c.reportDate : e.newestAny.reportDate, 12) +
      pad(c ? c.recommendation : 'NONE', 6) +
      (c && c.targetPrice ? c.targetPrice : '—')
    );
  }

  // The trap this module exists to prevent: filename order != data order.
  const inverted = entries.filter((e) => e.misleadingFilenames.length);
  if (inverted.length) {
    console.log('\n⚠ Filename date DISAGREES with report date — newest data is in the older-NAMED file:');
    for (const e of inverted) {
      for (const s of e.misleadingFilenames) {
        console.log(
          `   ${e.companyName}: use ${e.current.file} (named ${e.current.filenameDate}, data ${e.current.reportDate}) ` +
          `— NOT ${s.file} (named ${s.filenameDate}, data ${s.reportDate})`
        );
      }
    }
  }

  const shadowed = entries.filter((e) => e.stubShadowsRating);
  if (shadowed.length) {
    console.log('\n⚠ Coverage stub is newer than the latest rating (stub carries no recommendation):');
    for (const e of shadowed) {
      console.log(`   ${e.companyName}: stub ${e.newestAny.file} (${e.newestAny.reportDate}) > rated ${e.current.file} (${e.current.reportDate})`);
    }
  }

  const unrated = entries.filter((e) => !e.current);
  if (unrated.length) {
    console.log('\n⚠ Covered but UNRATED — cannot support a valuation claim:');
    for (const e of unrated) console.log(`   ${e.companyName} (${e.newestAny.file})`);
  }

  if (args.includes('--live')) {
    crossCheckLiveCatalog().then((res) => {
      if (!res.ok) {
        console.log(`\n⚠ Live catalog unreachable — local index shown above is unverified.\n   ${res.reason}`);
        return;
      }
      if (res.newerLive.length) {
        console.log('\n⚠ Live catalog has NEWER reports than report-content (report-content is stale):');
        for (const m of res.newerLive) console.log(`   ${m.id}: live ${m.liveDate} > local ${m.localDate}`);
      }
      if (res.missing.length) {
        console.log(`\n⚠ In live catalog but not in report-content (${res.missing.length}):`);
        for (const m of res.missing.slice(0, 15)) console.log(`   ${m.id} (${m.reportDate})`);
        if (res.missing.length > 15) console.log(`   … and ${res.missing.length - 15} more`);
      }
      if (!res.newerLive.length && !res.missing.length) console.log('\n✓ report-content is in sync with the live catalog.');
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
