#!/usr/bin/env node
// Add a WebPage node carrying dateModified to the hand-written top-level pages.
//
// Every page under /reports/ already has one; none of the top-level pages did. For a site
// whose product is a *current* price target, freshness is the core claim, and AI systems
// weight recency heavily when choosing what to cite -- so the pages arguing the methodology
// and the pricing were the ones with no date on them at all.
//
// The date is each file's last commit date, not today's: stamping "today" on every page at
// every build is the same lie as the sitemap's bulk lastmod, and a reader or a crawler that
// checks will find the page unchanged.
//
// about.html, blog.html, analysts.html and disclaimer.html had no structured data at all
// and get a WebPage node of their own.
//
//   node scripts/build-page-freshness.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sameText } from './same-text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.aiequityreports.com';
const CHECK = process.argv.includes('--check');

// Hand-written pages only. reports/, companies/ and blog/ are generated and already dated.
const PAGES = [
  'index.html', 'reports.html', 'pricing.html', 'faq.html', 'methodology.html',
  'about.html', 'analysts.html', 'analyst-story.html', 'analyst-terms.html',
  'institutions.html',
  'blog.html', 'disclaimer.html', 'members.html', 'comparisons.html',
];

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&mdash;/g, '—').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Last commit date for a file, falling back to its mtime when git has nothing. */
function lastModified(rel) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', rel], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
  } catch { /* not a repo, or file never committed */ }
  return new Date(fs.statSync(path.join(ROOT, rel)).mtime).toISOString().slice(0, 10);
}

const MARKER = 'data-page-freshness';
let changed = 0, missing = 0, skipped = 0;

for (const rel of PAGES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { missing++; continue; }
  const html = fs.readFileSync(abs, 'utf8');

  // comparisons.html is a noindex redirect stub whose canonical points at reports.html;
  // stamping it would publish a WebPage node claiming to be a page it is not. Strip one if
  // an earlier run added it.
  if (/noindex/i.test((html.match(/<meta name="robots" content="([^"]*)"/) || [])[1] || '')) {
    skipped++;
    if (html.includes(MARKER)) {
      const stripped = html.replace(new RegExp(`\\s*<script type="application/ld\\+json" ${MARKER}>[\\s\\S]*?</script>`), '');
      changed++;
      if (!CHECK) fs.writeFileSync(abs, stripped);
    }
    continue;
  }

  const title = dec((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || rel);
  const description = dec((html.match(/<meta name="description" content="([\s\S]*?)">/) || [])[1] || '');
  const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || `${SITE}/${rel}`;

  const node = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${canonical}#page`,
    url: canonical,
    name: title,
    ...(description ? { description } : {}),
    dateModified: lastModified(rel),
    inLanguage: 'en',
    isPartOf: { '@type': 'WebSite', name: 'Valuatum AI Equity Reports', url: `${SITE}/` },
    publisher: { '@type': 'Organization', name: 'Valuatum Oy', url: `${SITE}/` },
  };

  const block = `  <script type="application/ld+json" ${MARKER}>\n${JSON.stringify(node, null, 2).replace(/</g, '\\u003c')}\n  </script>`;

  let next;
  if (html.includes(MARKER)) {
    next = html.replace(new RegExp(`  <script type="application/ld\\+json" ${MARKER}>[\\s\\S]*?</script>`), () => block);
  } else {
    // Anchor on the canonical tag where there is one, otherwise just before </head>.
    const anchor = (html.match(/<link rel="canonical" href="[^"]+">/) || [])[0];
    next = anchor
      ? html.replace(anchor, () => `${anchor}\n${block}`)
      : html.replace(/<\/head>/, () => `${block}\n</head>`);
  }

  if (sameText(next, html)) continue;
  changed++;
  if (!CHECK) fs.writeFileSync(abs, next);
}

console.log(`${CHECK ? '[check] ' : ''}${changed} pages ${CHECK ? 'out of date' : 'stamped'}`
  + `${skipped ? `, ${skipped} skipped (noindex)` : ''}${missing ? `, ${missing} not found` : ''}`);
if (CHECK && changed) {
  console.error('Page freshness JSON-LD is out of date — run: node scripts/build-page-freshness.mjs');
  process.exit(1);
}
