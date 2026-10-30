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
import { sameText } from './same-text.mjs';
import { headlineOf, isMarketFirstPage } from './report-headline.mjs';

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
    // From report-content/<id>.json, not from the description prose: the description is a
    // marketing sentence whose wording changes, and it no longer carries the current price.
    const h = headlineOf(html);
    out.push({
      slug: f.replace(/\.html$/, ''),
      name: m[1].trim(),
      ticker: m[2].trim(),
      mode: meta(html, 'valuatum-page-mode') || 'company',
      published: prop(html, 'article:published_time') || '',
      rating: h ? h.recommendation : null,
      target: h && h.targetPrice ? String(h.targetPrice).replace(/\s+/g, ' ') : null,
      current: h && h.currentPrice ? String(h.currentPrice).replace(/\s+/g, ' ') : null,
      marketFirst: isMarketFirstPage(html),
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
  } else if (p.marketFirst) {
    // No rating and no target by design; saying so keeps an AI answer from inventing one.
    bits.push(`: market report — what the share price is made of, business by business; no rating or target price.`);
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

> Valuatum AI Equity Reports produces AI-generated equity research on listed companies worldwide.
> Each report starts from today's share price and explains it: analysts' consensus forecasts are kept as they are,
> the price is split between the company's businesses, and each business is set beside listed peers. The base
> report carries no rating or target; an analyst who revises it gets a 12-month target that follows from their own
> assumptions. Built on Valuatum's financial models (Helsinki, Finland, est. 2000). Delivered as web pages and PDFs.
> All content is AI-generated research for informational purposes only and is not investment advice.
>
> Any rating or price target below is read directly from each report page when this file is generated; reports
> that explain the price carry none.
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
- [Methodology](${SITE}/methodology.html): how the report reads the share price into the businesses, and where an analyst's view enters.
- [Reports catalogue](${SITE}/reports.html): browse all available reports and order a fresh report.
- [Company index](${SITE}/companies.html): every company with a page on this site.
- [Pricing](${SITE}/pricing.html): credits and per-report pricing.
- [Pricing (machine-readable)](${SITE}/pricing.md): the same prices as plain markdown.
- [FAQ](${SITE}/faq.html): common questions about AI equity research, methodology and delivery.
- [About Valuatum](${SITE}/about.html): the company behind the reports.
- [For institutions](${SITE}/institutions.html): how asset managers, brokers, advisory firms and IR teams use the reports, and how to request a free pilot.

## Key concepts
- Market-first report: takes today's share price as the market's best estimate and shows what each business must deliver for it to hold.
- Price split: today's share price divided between the company's businesses, each on a multiple of its forecast operating profit, so the parts add up to the price.
- Analyst revision: an analyst's plain-language instruction changes the assumptions; the revised forecast runs through Valuatum's financial model and a 12-month target follows.

## Company overview pages
${overview.length} listed companies have a page with share price, valuation metrics and company profile,
each able to generate a fresh AI equity report on demand. They are listed in
[the company index](${SITE}/companies.html) and in [sitemap.xml](${SITE}/sitemap.xml).
`;

const target = path.join(ROOT, 'llms.txt');
const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

if (CHECK) {
  if (!sameText(current.trim(), body.trim())) {
    console.error('llms.txt is out of date with the report pages — run: node scripts/build-llms-txt.mjs');
    process.exit(1);
  }
  console.log(`[check] llms.txt matches: ${free.length} free, ${paid.length} paid, ${overview.length} overview pages`);
} else {
  fs.writeFileSync(target, body);
  console.log(`wrote llms.txt — ${free.length} free, ${paid.length} paid, ${comparisons().length} comparisons, ${overview.length} overview pages`);
}
