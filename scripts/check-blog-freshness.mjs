#!/usr/bin/env node
// Publish gate: blocks a blog article whose report data has gone stale.
//
// Two independent checks, because posts fail in two different ways:
//
//   1. PROVENANCE — an article declares which report each number came from
//      (`dataProvenance`). If a newer rated report exists for that company,
//      the article's numbers are stale and it must be refreshed before merge.
//
//   2. RATING CONTRADICTION — an article names a covered company near a
//      BUY/HOLD/SELL verdict that disagrees with that company's CURRENT
//      rating. This catches posts written before provenance existed, which
//      is exactly how two in-review posts came to call UPM a BUY while the
//      live model said HOLD.
//
// Exit 1 on any error, so this can gate a merge. Warnings never fail.
//
// Run: node scripts/check-blog-freshness.mjs
//      node scripts/check-blog-freshness.mjs --dir blog-content/pending-review
//      node scripts/check-blog-freshness.mjs --live    # also verify report-content itself
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReportIndex, resolveCompany, crossCheckLiveCatalog } from './report-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RATINGS = ['BUY', 'HOLD', 'SELL'];
// A rating token further than this from any company mention is not a claim
// about a specific company.
const PROXIMITY = 140;
// A lowercase rating word is only a verdict in an explicit rating construction
// ("our model rates WRT1V a sell"). Bare prose — "a buy call was published",
// "investors hold shares" — is not.
const EXPLICIT_RATING = /\brate[sd]?\b[^.?!]{0,30}$/i;
// Either/or phrasing is a question, not a verdict: "a buy or sell right now".
const ENUMERATION = /\b(buy|hold|sell)\b\s*(,|\/|\bor\b|\band\b)\s*\b(buy|hold|sell)\b/i;
// A rating explicitly scoped to a superseded report is history, not a claim:
// "our previous report rated the stock a sell". Articles should be able to say
// how a view changed without tripping the gate.
const HISTORICAL = /\b(previous(ly)?|prior|earlier|former(ly)?|used to|no longer|last (report|model)|superseded)\b/i;
const CONTEXT_WINDOW = 45;

// ── helpers ────────────────────────────────────────────────────────────────

/** "UPM-Kymmene Oyj" → ["UPM-Kymmene", "UPM"]; enough to spot a mention. */
function nameVariants(companyName, ticker) {
  const stripped = companyName
    .replace(/\b(Oyj|Abp|Oy|A\/S|AS|Inc\.?|Corporation|Corp\.?|Ltd\.?|plc|PLC|Company|Holdings|Pharmaceuticals)\b/g, '')
    .replace(/,/g, '')
    .trim();
  const variants = new Set([stripped]);
  const firstWord = stripped.split(/[\s-]+/)[0];
  if (firstWord && firstWord.length >= 3) variants.add(firstWord);
  // Articles often use the bare ticker root ("rates KESKOB a BUY").
  if (ticker) {
    const root = String(ticker).split('.')[0];
    if (root && root.length >= 2) variants.add(root);
  }
  return [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
}

const ENTITIES = { auml: 'ä', ouml: 'ö', aring: 'å', Auml: 'Ä', Ouml: 'Ö', Aring: 'Å', amp: '&', nbsp: ' ', euro: '€', quot: '"', '#39': "'" };

/** All visible prose in an article: tags stripped, entities decoded. */
function articleText(article) {
  const parts = [article.title || '', article.metaDescription || ''];
  for (const s of article.sections || []) parts.push(s.h2 || '', s.html || '');
  for (const f of article.faq || []) parts.push(f.q || '', f.a || '');
  return parts
    .join('\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z]+|#\d+);/g, (m, e) => ENTITIES[e] ?? m)
    .replace(/\s+/g, ' ');
}

function loadArticles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => ({ file: path.join(dir, f), article: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

// ── checks ─────────────────────────────────────────────────────────────────

function checkProvenance(article, index, errors, warnings) {
  const prov = article.dataProvenance;
  if (!Array.isArray(prov) || !prov.length) return false;

  for (const p of prov) {
    const entry = p.slug ? index.get(p.slug) : resolveCompany(p.reportId || '');
    if (!entry) {
      errors.push(`${article.slug}: dataProvenance references unknown company "${p.slug || p.reportId}".`);
      continue;
    }
    if (!entry.current) {
      errors.push(`${article.slug}: cites ${entry.companyName}, which has no rated report (coverage stub only).`);
      continue;
    }
    const cited = String(p.reportDate || '').substring(0, 10);
    if (!cited) {
      errors.push(`${article.slug}: dataProvenance entry for ${entry.companyName} has no reportDate.`);
      continue;
    }
    if (cited < entry.current.reportDate) {
      errors.push(
        `${article.slug}: STALE — cites ${entry.companyName} at ${cited} (${p.reportId || '?'}), ` +
        `but the current report is ${entry.current.reportDate} (${entry.current.file}, ` +
        `${entry.current.recommendation} target ${entry.current.targetPrice}). Refresh before merge.`
      );
    } else if (p.reportId && p.reportId !== entry.current.id) {
      warnings.push(
        `${article.slug}: cites ${p.reportId} for ${entry.companyName}; current is ${entry.current.id} ` +
        `(same date ${cited}, so numbers may still be valid — verify).`
      );
    }
  }
  return true;
}

/**
 * Attribute each rating token to the NEAREST company mention, not to every
 * company within the window. Articles routinely put several companies in one
 * sentence ("Tesla (P/E 239x, SELL) and UPM (EV/EBITDA 7.8x, BUY)") or in a
 * comparison table, and a naive window blames the wrong company for a rating
 * that belongs to its neighbour.
 */
function checkRatingContradictions(article, index, errors) {
  const text = articleText(article);
  const upper = text.toUpperCase();
  const exempt = new Set(
    (article.dataProvenance || []).filter((p) => p.ratingCheckExempt).map((p) => p.slug)
  );

  // 1. Every company mention, with position. All aliases are registered (a
  // company can appear as "UPM-Kymmene" in a table and bare "UPM" in prose);
  // overlapping hits collapse to the longest so one mention counts once.
  let mentions = [];
  for (const entry of index.values()) {
    if (!entry.current) continue;
    for (const variant of nameVariants(entry.companyName, entry.ticker)) {
      const needle = variant.toUpperCase();
      let from = 0;
      for (;;) {
        const at = upper.indexOf(needle, from);
        if (at === -1) break;
        mentions.push({ at, end: at + needle.length, entry, variant });
        from = at + needle.length;
      }
    }
  }
  if (!mentions.length) return;
  mentions.sort((a, b) => a.at - b.at || b.end - a.end);
  mentions = mentions.filter((m, i, arr) => !arr.some((o, j) => j < i && o.at <= m.at && o.end >= m.end));

  // A single-company article owns its unattributed verdicts: "What would prove
  // our SELL call wrong?" in an AMD piece is about AMD, even when the nearest
  // company name in the text is a competitor.
  const identity = `${article.slug || ''} ${article.title || ''}`.toUpperCase();
  let subject = null;
  for (const entry of index.values()) {
    if (!entry.current) continue;
    for (const variant of nameVariants(entry.companyName, entry.ticker)) {
      if (variant.length >= 3 && identity.includes(variant.toUpperCase())) { subject = entry; break; }
    }
    if (subject) break;
  }

  // 2. Every rating token that reads as a verdict rather than ordinary prose.
  const claims = [];
  for (const rating of RATINGS) {
    for (const m of text.matchAll(new RegExp(`\\b${rating}\\b`, 'gi'))) {
      const before = text.slice(Math.max(0, m.index - CONTEXT_WINDOW), m.index);
      const around = text.slice(Math.max(0, m.index - CONTEXT_WINDOW), m.index + m[0].length + CONTEXT_WINDOW);
      if (ENUMERATION.test(around)) continue;
      // Scoped to an older report, so not a claim about the current one.
      if (HISTORICAL.test(text.slice(Math.max(0, m.index - 90), m.index))) continue;
      // A rhetorical question ("Is Tesla a buy in 2026?") is not a verdict.
      const sentence = text.slice(Math.max(0, m.index - 120), m.index + 120);
      const isUpper = m[0] === m[0].toUpperCase();
      if (!isUpper) {
        if (/\?/.test(sentence.slice(sentence.indexOf(m[0])))) continue;
        if (!EXPLICIT_RATING.test(before)) continue;
      }
      claims.push({ at: m.index, rating });
    }
  }

  // 3. Attribute to the nearest PRECEDING mention. A verdict follows its
  //    subject ("UPM trades at 16.4x P/E (BUY) and Tesla at 239.4x (SELL)",
  //    "our SELL call … displaces Nvidia") so a plain nearest-match blames the
  //    neighbour. Only fall back to a following mention when nothing precedes.
  const flagged = new Set();
  for (const c of claims) {
    let best = null;
    let bestDist = Infinity;
    for (const m of mentions) {
      if (m.end > c.at) continue;
      const dist = c.at - m.end;
      if (dist < bestDist) { bestDist = dist; best = m; }
    }
    if (!best || bestDist > PROXIMITY) {
      // Nothing precedes it: the article's own subject owns the verdict.
      if (subject) {
        best = { at: c.at, end: c.at, entry: subject, variant: subject.companyName };
        bestDist = 0;
      } else {
        for (const m of mentions) {
          if (m.at < c.at) continue;
          const dist = m.at - c.at;
          if (dist < bestDist) { bestDist = dist; best = m; }
        }
      }
    }
    if (!best || bestDist > PROXIMITY) continue;

    // One rating can cover a list of companies: "we rate UPM (€34.00 target)
    // and Stora Enso (€12.76) BUY", "both screen as a BUY". Walk back through
    // adjacent mentions joined by a conjunction and attribute to all of them.
    // A rating word inside the gap means the earlier company already had its
    // own verdict, so the list stops there.
    const cluster = [best];
    const plural = /\b(both|all|each|two)\b/i.test(text.slice(Math.max(0, c.at - 80), c.at));
    const ordered = mentions.filter((m) => m.end <= c.at).sort((a, b) => b.at - a.at);
    for (let i = ordered.indexOf(best) + 1; i < ordered.length; i++) {
      const prev = ordered[i];
      const gap = text.slice(prev.end, cluster[cluster.length - 1].at);
      if (gap.length > 60) break;
      if (new RegExp(`\\b(${RATINGS.join('|')})\\b`, 'i').test(gap)) break;
      if (!plural && !/\band\b|&|\bor\b|\bvs\.?\b|,/i.test(gap)) break;
      cluster.push(prev);
      if (cluster.length >= 3) break;
    }

    for (const m of cluster) {
      const { entry } = m;
      if (exempt.has(entry.slug) || flagged.has(entry.slug)) continue;
      const current = entry.current.recommendation;
      if (c.rating === current) continue;
      flagged.add(entry.slug);
      const from = Math.max(0, Math.min(m.at, c.at) - 40);
      const to = Math.max(m.end, c.at + c.rating.length) + 30;
      const snippet = text.slice(from, to).trim().replace(/\s+/g, ' ');
      errors.push(
        `${article.slug}: reads "${c.rating}" for ${entry.companyName}, but the current report says ` +
        `${current} (${entry.current.file}, ${entry.current.reportDate}, target ${entry.current.targetPrice}).\n` +
        `      …${snippet}…\n` +
        `      Refresh the article, or set ratingCheckExempt on its dataProvenance entry if the mention is generic.`
      );
    }
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dirArg = args.indexOf('--dir');
const CONTENT_DIR = path.resolve(ROOT, dirArg !== -1 ? args[dirArg + 1] : 'blog-content');

const index = buildReportIndex();
const articles = loadArticles(CONTENT_DIR);
if (!articles.length) {
  console.log(`No articles in ${path.relative(ROOT, CONTENT_DIR)} — nothing to check.`);
  process.exit(0);
}

const errors = [];
const warnings = [];

for (const { article } of articles) {
  const hadProvenance = checkProvenance(article, index, errors, warnings);
  if (!hadProvenance) {
    warnings.push(`${article.slug}: no dataProvenance — report numbers cannot be verified automatically.`);
  }
  checkRatingContradictions(article, index, errors);
}

console.log(`Checked ${articles.length} article(s) in ${path.relative(ROOT, CONTENT_DIR)} against ${index.size} covered companies.\n`);

if (warnings.length) {
  console.log('WARNINGS');
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  console.log('');
}

if (errors.length) {
  console.log('ERRORS (block merge)');
  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log(`\n✗ ${errors.length} error(s). Refresh the article against the current report before merging.`);
  process.exit(1);
}

console.log('✓ No stale report data or contradicted ratings.');

if (args.includes('--live')) {
  const res = await crossCheckLiveCatalog();
  if (!res.ok) {
    console.log(`\n⚠ Live catalog unreachable — report-content freshness unverified.\n   ${res.reason}`);
  } else if (res.newerLive.length) {
    console.log('\n⚠ report-content is itself behind the live catalog:');
    for (const m of res.newerLive) console.log(`   ${m.id}: live ${m.liveDate} > local ${m.localDate}`);
    console.log('   Articles verified above may still be citing outdated numbers.');
  } else {
    console.log('\n✓ report-content is in sync with the live catalog.');
  }
}
