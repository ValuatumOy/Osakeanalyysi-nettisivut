#!/usr/bin/env node
// Post-publication lifecycle for blog articles: edit, hide, unhide, delete.
//
// Everything a published article needs after it goes live. The site is static
// and built from blog-content/*.json, so "hide" and "delete" are not database
// flags — they change what the build emits. This script is the only supported
// way to make those changes, because each one has bookkeeping attached that is
// easy to forget by hand: the edit stamp readers see, the _ledger.json entry,
// and the redirect that stops a deleted URL 404-ing for anyone who linked it.
//
//   node scripts/blog-admin.mjs list
//   node scripts/blog-admin.mjs edit   <slug> --note "corrected Nokia target"
//   node scripts/blog-admin.mjs hide   <slug> --note "why"
//   node scripts/blog-admin.mjs unhide <slug> --note "why"
//   node scripts/blog-admin.mjs delete <slug> --confirm <slug> --note "why"
//
// After any of these, run: node scripts/build-blog-pages.mjs
//
// Editing is a two-step on purpose: you change the article JSON yourself, then
// run `edit` to stamp it. The stamp is what puts the visible "Edited <date> at
// <time>" line on the page, so it must reflect a real content change rather
// than firing on every build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = path.join(ROOT, 'blog-content');
const OUT_DIR = path.join(ROOT, 'blog');
const LEDGER = path.join(CONTENT_DIR, '_ledger.json');
const VERCEL = path.join(ROOT, 'vercel.json');
const TZ = 'Europe/Helsinki';

// ── time ───────────────────────────────────────────────────────────────────
// Stamps are stored as a full ISO instant plus the Helsinki wall-clock parts.
// The instant is what machines compare; the wall clock is what the page shows,
// and storing it means the rendered label cannot drift with the build host's
// timezone.
function stamp(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  return {
    at: now.toISOString(),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    timezone: TZ,
  };
}

// ── io ─────────────────────────────────────────────────────────────────────
const articlePath = (slug) => path.join(CONTENT_DIR, `${slug}.json`);

function readArticle(slug) {
  const file = articlePath(slug);
  if (!fs.existsSync(file)) {
    fail(`No article "${slug}" in blog-content/. Run 'list' to see what is there.`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeArticle(article) {
  fs.writeFileSync(articlePath(article.slug), JSON.stringify(article, null, 2) + '\n');
}

function appendLedger(entry) {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  ledger.entries.push(entry);
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Remove a generated page if it exists, so hidden/deleted articles stop being served. */
function removePage(slug) {
  const page = path.join(OUT_DIR, `${slug}.html`);
  if (fs.existsSync(page)) {
    fs.unlinkSync(page);
    console.log(`removed blog/${slug}.html`);
  }
}

// ── commands ───────────────────────────────────────────────────────────────

function cmdList() {
  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  if (!files.length) return console.log('No articles in blog-content/.');
  console.log('STATUS     LAST EDITED        SLUG');
  for (const file of files.sort()) {
    const a = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8'));
    const edits = a.editHistory || [];
    const last = edits.length ? `${edits[edits.length - 1].date} ${edits[edits.length - 1].time}` : '—';
    console.log(`${(a.status || 'published').padEnd(10)} ${String(last).padEnd(18)} ${a.slug}`);
  }
}

function cmdEdit(slug, note) {
  if (!note) fail('edit needs --note "<what changed>". It goes in the ledger, not on the page.');
  const article = readArticle(slug);
  const s = stamp();

  article.dateModified = s.date;
  article.editHistory = [...(article.editHistory || []), { ...s, note }];
  writeArticle(article);

  appendLedger({
    slug, action: 'edit',
    datePublished: article.datePublished,
    dateModified: s.date,
    editedAt: s.at,
    authorId: article.authorId,
    reviewerId: article.reviewerId,
    notes: note,
  });

  console.log(`✓ ${slug} stamped as edited ${s.date} ${s.time} ${TZ}.`);
  console.log('  Rebuild to publish the change: node scripts/build-blog-pages.mjs');
}

function cmdHide(slug, note) {
  if (!note) fail('hide needs --note "<why>".');
  const article = readArticle(slug);
  if (article.status === 'hidden') fail(`${slug} is already hidden.`);
  const s = stamp();

  article.status = 'hidden';
  article.hiddenAt = s.at;
  writeArticle(article);
  removePage(slug);

  appendLedger({
    slug, action: 'hide',
    datePublished: article.datePublished,
    dateModified: s.date,
    authorId: article.authorId,
    reviewerId: article.reviewerId,
    notes: note,
  });

  console.log(`✓ ${slug} hidden. The JSON is kept, so unhide restores it exactly.`);
  console.log('  Rebuild to drop it from the index and sitemap: node scripts/build-blog-pages.mjs');
}

function cmdUnhide(slug, note) {
  const article = readArticle(slug);
  if (article.status !== 'hidden') fail(`${slug} is not hidden.`);
  const s = stamp();

  article.status = 'published';
  delete article.hiddenAt;
  writeArticle(article);

  appendLedger({
    slug, action: 'unhide',
    datePublished: article.datePublished,
    dateModified: s.date,
    authorId: article.authorId,
    reviewerId: article.reviewerId,
    notes: note || 'Restored to the live index.',
  });

  console.log(`✓ ${slug} is published again.`);
  console.log('  Check it still holds up before rebuilding: node scripts/check-blog-freshness.mjs');
}

function cmdDelete(slug, note, confirm) {
  if (!note) fail('delete needs --note "<why>".');
  if (confirm !== slug) {
    fail(`delete is permanent. Re-run with --confirm ${slug} if you mean it — or use 'hide', which is reversible.`);
  }
  const article = readArticle(slug);
  const s = stamp();

  // The URL was public, so it stays resolvable. A permanent redirect to the
  // blog index beats a 404 for anyone holding a link or a search result.
  const vercel = JSON.parse(fs.readFileSync(VERCEL, 'utf8'));
  vercel.redirects = vercel.redirects || [];
  const source = `/blog/${slug}.html`;
  if (!vercel.redirects.some((r) => r.source === source)) {
    vercel.redirects.push({ source, destination: '/blog.html', permanent: true });
    fs.writeFileSync(VERCEL, JSON.stringify(vercel, null, 2) + '\n');
    console.log(`added redirect ${source} → /blog.html`);
  }

  fs.unlinkSync(articlePath(slug));
  console.log(`removed blog-content/${slug}.json`);
  removePage(slug);

  appendLedger({
    slug, action: 'delete',
    datePublished: article.datePublished,
    dateModified: s.date,
    deletedAt: s.at,
    authorId: article.authorId,
    reviewerId: article.reviewerId,
    notes: note,
  });

  console.log(`✓ ${slug} deleted. The content is still in git history: git show HEAD:blog-content/${slug}.json`);
  console.log('  Rebuild to drop it from the index and sitemap: node scripts/build-blog-pages.mjs');
}

// ── args ───────────────────────────────────────────────────────────────────
const [command, slug] = process.argv.slice(2);
const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const USAGE = `Usage:
  node scripts/blog-admin.mjs list
  node scripts/blog-admin.mjs edit   <slug> --note "<what changed>"
  node scripts/blog-admin.mjs hide   <slug> --note "<why>"
  node scripts/blog-admin.mjs unhide <slug> [--note "<why>"]
  node scripts/blog-admin.mjs delete <slug> --confirm <slug> --note "<why>"`;

if (command !== 'list' && !slug) fail(`Missing slug.\n${USAGE}`);

switch (command) {
  case 'list':   cmdList(); break;
  case 'edit':   cmdEdit(slug, flag('note')); break;
  case 'hide':   cmdHide(slug, flag('note')); break;
  case 'unhide': cmdUnhide(slug, flag('note')); break;
  case 'delete': cmdDelete(slug, flag('note'), flag('confirm')); break;
  default:       fail(`Unknown command "${command || ''}".\n${USAGE}`);
}
