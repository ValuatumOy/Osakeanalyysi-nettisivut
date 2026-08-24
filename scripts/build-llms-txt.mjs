#!/usr/bin/env node
// Generate llms.txt from the built pages.
//
// This file was hand-maintained and drifted: 7 of its 9 report entries disagreed with the
// pages they linked to, three of them on the rating itself (it said BUY Kesko while the
// page said SELL), and one link pointed at a slug that does not exist. llms.txt is the one
// file handed to AI systems as ground truth, so on a site that publishes investment
// ratings it cannot be typed by hand.
//
// Every figure below is read out of the page it links to. Nothing is entered twice.
//
//   node scripts/build-llms-txt.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.aiequityreports.com';
const CHECK = process.argv.includes('--check');

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const meta = (html, name) => dec((html.match(new RegExp(`<meta name="${name}" content="([\\s\\S]*?)">`)) || [])[1] || '');
const prop = (html, p) => dec((html.match(new RegExp(`<meta property="${p}" content="([\\s\\S]*?)">`)) || [])[1] || '');

// ── read every report page ──────────────────────────────────────────────────
function collect() {
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'reports')).filter((x) => x.endsWith('.html'))) {
    const html = read(path.join('reports', f));
    const title = dec((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const m = title.match(/^(.*?)\s*\(([^)]+)\)\s*(?:Stock|Valuation)/);
    if (!m) continue;
    const desc = meta(html, 'description');
    const r = desc.match(/rates\s+\S+\s+([A-Z]+)\s+with a\s+([\d.,]+\s*[A-Z]{3})\s+price target(?:\s+vs\s+([\d.,]+\s*[A-Z]{3}))?/);
    out.push({
      slug: f.replace(/\.html$/, ''),
      name: m[1].trim(),
      ticker: m[2].trim(),
      mode: meta(html, 'valuatum-page-mode') || 'company',
      published: prop(html, 'article:published_time') || '',
      rating: r ? r[1] : null,
      target: r ? r[2].replace(/\s+/g, ' ') : null,
      current: r && r[3] ? r[3].replace(/\s+/g, ' ') : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const line = (p) => {
  const bits = [`- [${p.name} (${p.ticker}) AI equity report](${SITE}/reports/${p.slug}.html)`];
  if (p.rating) {
    let s = `: ${p.rating}, target ${p.target}`;
    if (p.current) s += ` (current ${p.current})`;
    bits.push(s + '.');
  } else {
    bits.push(`: share price, valuation and company profile; fresh report available on demand.`);
  }
  return bits.join('');
};

// The pages under compare/ are currently noindex redirect stubs -- the comparison feature
// was retired. Listing a stub here would point AI systems at a redirect, so anything
// noindex is skipped and the section simply reports itself empty until real pages return.
function comparisons() {
  const dir = path.join(ROOT, 'compare');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort().flatMap((f) => {
    const html = read(path.join('compare', f));
    if (/noindex/i.test(meta(html, 'robots'))) return [];
    const title = dec((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').split(/\s+[—|]\s+/)[0];
    const desc = meta(html, 'description');
    return [`- [${title}](${SITE}/compare/${f}): ${desc.split('. ')[0]}.`];
  });
}

function blogPosts() {
  const dir = path.join(ROOT, 'blog');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort().flatMap((f) => {
    const html = read(path.join('blog', f));
    if (/noindex/i.test(meta(html, 'robots'))) return [];
    const title = dec((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').split(/\s+[—|]\s+/)[0];
    const desc = meta(html, 'description');
    return [`- [${title}](${SITE}/blog/${f}): ${desc.split('. ')[0]}.`];
  });
}

// ── build ───────────────────────────────────────────────────────────────────
const pages = collect();
const free = pages.filter((p) => p.mode === 'free');
const paid = pages.filter((p) => p.mode === 'paid');
const covered = new Set([...free, ...paid].map((p) => p.slug));
const overview = pages.filter((p) => !covered.has(p.slug));

const body = `# Valuatum AI Equity Reports

> Valuatum AI Equity Reports produces professional, AI-generated equity research for any listed company.
> Each report applies a structured enterprise-value and value-pool methodology — including reverse valuation,
> risk and catalyst analysis, and full financial estimates — built on Valuatum's 25+ years of equity research
> practice (Helsinki, Finland, est. 2000). Reports are delivered as web pages and downloadable PDFs.
> All content is AI-generated research for informational purposes only and is not investment advice.
>
> Ratings and price targets below are read directly from each report page when this file is generated.
> Every figure is the one that page carried at that moment; the page itself is always authoritative.

## Free sample equity reports
${free.map(line).join('\n') || '- None published right now.'}

## Paid equity reports (free preview available)
${paid.map(line).join('\n') || '- None published right now.'}

## Stock comparisons
${comparisons().join('\n') || '- None published right now.'}

## Articles
${blogPosts().join('\n') || '- None published right now.'}

## Methodology & company
- [Methodology](${SITE}/methodology.html): how value-pool analysis and reverse valuation work.
- [Reports catalogue](${SITE}/reports.html): browse all available reports and order a fresh report.
- [Company index](${SITE}/companies.html): every company with a page on this site.
- [Pricing](${SITE}/pricing.html): credits and per-report pricing.
- [Pricing (machine-readable)](${SITE}/pricing.md): the same prices as plain markdown.
- [FAQ](${SITE}/faq.html): common questions about AI equity research, methodology and delivery.
- [About Valuatum](${SITE}/about.html): the company behind the reports.

## Key concepts
- Reverse valuation: works backwards from the current market price to reveal the growth and margin assumptions investors are implicitly paying for.
- Value pool analysis: decomposes a company's enterprise value into its distinct businesses and embedded options, each priced separately.

## Company overview pages
${overview.length} listed companies have a page with share price, valuation metrics and company profile,
each able to generate a fresh AI equity report on demand. They are listed in
[the company index](${SITE}/companies.html) and in [sitemap.xml](${SITE}/sitemap.xml).
`;

const target = path.join(ROOT, 'llms.txt');
const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

if (CHECK) {
  if (current.trim() !== body.trim()) {
    console.error('llms.txt is out of date with the report pages — run: node scripts/build-llms-txt.mjs');
    process.exit(1);
  }
  console.log(`[check] llms.txt matches: ${free.length} free, ${paid.length} paid, ${overview.length} overview pages`);
} else {
  fs.writeFileSync(target, body);
  console.log(`wrote llms.txt — ${free.length} free, ${paid.length} paid, ${comparisons().length} comparisons, ${overview.length} overview pages`);
}
