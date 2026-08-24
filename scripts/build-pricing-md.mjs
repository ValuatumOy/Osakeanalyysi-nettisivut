#!/usr/bin/env node
// Generate /pricing.md from pricing.html.
//
// Transparent pricing is a real advantage over the "contact sales" research houses, but it
// only existed inside a rendered page. An AI agent comparing research providers on someone's
// behalf cannot parse a pricing grid out of a JavaScript-rendered layout, so the advantage
// was invisible in exactly the comparisons it should win.
//
// Read from the page rather than restated, so the file cannot drift the way llms.txt did.
// (Live prices come from Stripe at request time via /api/pricing; the page carries the same
// numbers as its rendered content, and those are what a reader is quoted.)
//
//   node scripts/build-pricing-md.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameText } from './same-text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const html = fs.readFileSync(path.join(ROOT, 'pricing.html'), 'utf8');

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—').replace(/&euro;/g, '€')
  .replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·').replace(/&rsquo;/g, '’');
const text = (s) => dec(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Every .pricing-card on the page, in document order. */
function cards() {
  const out = [];
  // Cards may carry inline styles after the class, so match any remaining attributes.
  const re = /<div class="pricing-card[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<!--|<\/div>|<div class="pricing-card)/g;
  let m;
  while ((m = re.exec(html))) {
    const block = m[1];
    const name = text((block.match(/<div class="pricing-name"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    if (!name) continue;
    // Membership cards carry a monthly/yearly toggle in data- attributes, so every tag here
    // may have attributes; the rendered text is the monthly (default) view.
    const priceTag = (block.match(/<span class="pricing-price-main"[^>]*>[\s\S]*?<\/span>/) || [])[0] || '';
    const price = text((priceTag.match(/>([\s\S]*?)<\/span>/) || [])[1] || '');
    const suffix = text((block.match(/<\/span>\s*<span[^>]*data-suffix-month[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '');
    const period = text((block.match(/<div class="pricing-period"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    const desc = text((block.match(/<p class="pricing-desc"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
    const features = [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((x) => text(x[1])).filter(Boolean);
    // The yearly alternative, where the card offers one.
    const yearPeriod = dec((block.match(/data-period-year="([^"]*)"/) || [])[1] || '');
    const yearFeats = [...block.matchAll(/data-feat-year="([^"]*)"/g)].map((x) => dec(x[1]));
    out.push({ name, price: price + suffix, period, desc, features, yearPeriod, yearFeats });
  }
  return out;
}

const all = cards();
if (all.length < 4) {
  console.error(`Only parsed ${all.length} pricing cards — pricing.html markup changed, fix this script before shipping.`);
  process.exit(1);
}

// The one-off products sit above the membership grid on the page; memberships follow.
const memberStart = all.findIndex((c) => /^(Analyst|Investor)$/i.test(c.name));
const oneOff = memberStart === -1 ? all : all.slice(0, memberStart);
const members = memberStart === -1 ? [] : all.slice(memberStart);

const note = text((html.match(/<p class="pricing-note"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '')
  || text((html.match(/Yearly plans include([\s\S]*?)<\/p>/) || [])[0] || '');

const render = (c) => [
  `### ${c.name}`,
  ``,
  `- Price: ${c.price || 'Custom — quoted per engagement'}${c.period ? ` (${c.period})` : ''}`,
  c.yearPeriod ? `- Billed yearly: ${c.yearPeriod}` : null,
  c.desc ? `- Summary: ${c.desc}` : null,
  c.features.length ? `- Includes: ${c.features.join('; ')}` : null,
  c.yearFeats.length ? `- On the yearly plan: ${c.yearFeats.join('; ')}` : null,
  ``,
].filter((x) => x !== null).join('\n');

const body = `# Pricing — Valuatum AI Equity Reports

Professional AI-generated equity research for listed companies. Prices in EUR, VAT excluded.
Billed securely by Stripe. No subscription is required to buy a single report.

Canonical page: https://www.aiequityreports.com/pricing.html

## Buy a single report

${oneOff.map(render).join('\n')}
## Memberships

${members.map(render).join('\n')}${note ? `\n${note}\n` : ''}
## How delivery works

- Ready reports download instantly as PDF, with an email copy.
- Fresh reports are generated on demand from the latest available financial data and
  arrive by email, usually within about 30 minutes.
- Any listed company Valuatum covers can be ordered as a fresh report, whether or not a
  ready report exists for it.

## Coverage

- 1,100+ listed companies across the Nordics, Europe and the US have a page on the site.
- Full list: https://www.aiequityreports.com/companies.html
- Reports ready to buy today: https://www.aiequityreports.com/reports.html

## Notes

- All reports are AI-generated research materials for informational purposes only.
  They are not investment advice.
- Enterprise pricing (volume, white-label, API access) is quoted per engagement —
  contact sales via https://www.aiequityreports.com/about.html
`;

// ── JSON-LD on pricing.html ─────────────────────────────────────────────────
// The page had no structured data at all, so the prices were readable only by rendering
// it. Built from the same parse as pricing.md above, so the two cannot disagree.
const NUM = /([\d]+(?:[.,]\d+)?)/;
const offerFor = (c) => {
  const m = String(c.price).replace(/,/g, '').match(NUM);
  return {
    '@type': 'Offer',
    name: c.name,
    description: c.desc || undefined,
    price: m ? m[1] : undefined,
    priceCurrency: 'EUR',
    availability: 'https://schema.org/InStock',
    url: 'https://www.aiequityreports.com/pricing.html',
    ...(m ? {} : { availability: 'https://schema.org/LimitedAvailability' }),
  };
};

const pricingJsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Product',
      '@id': 'https://www.aiequityreports.com/pricing.html#product',
      name: 'Valuatum AI Equity Report',
      description: 'AI-generated equity research report for a listed company, covering '
        + 'segment value analysis, reverse valuation, risks, catalysts and full financial estimates.',
      brand: { '@type': 'Organization', name: 'Valuatum Oy', url: 'https://www.aiequityreports.com/' },
      category: 'Equity research report',
      offers: oneOff.map(offerFor),
    },
    {
      '@type': 'Product',
      '@id': 'https://www.aiequityreports.com/pricing.html#membership',
      name: 'Valuatum AI Equity Reports membership',
      description: 'Monthly or yearly membership giving a report allowance from the catalogue '
        + 'at a fraction of the one-off price.',
      brand: { '@type': 'Organization', name: 'Valuatum Oy', url: 'https://www.aiequityreports.com/' },
      offers: members.map(offerFor),
    },
  ],
};

const LD_OPEN = '  <script type="application/ld+json" data-pricing-offers>';
const LD_CLOSE = '  </script>';
const ldBlock = `${LD_OPEN}\n${JSON.stringify(pricingJsonLd, (_k, v) => (v === undefined ? undefined : v), 2).replace(/</g, '\\u003c')}\n${LD_CLOSE}`;

let pricingHtml = html;
if (/data-pricing-offers/.test(pricingHtml)) {
  pricingHtml = pricingHtml.replace(/  <script type="application\/ld\+json" data-pricing-offers>[\s\S]*?<\/script>/, () => ldBlock);
} else {
  const anchor = '<link rel="canonical" href="https://www.aiequityreports.com/pricing.html">';
  if (!pricingHtml.includes(anchor)) {
    console.error('Could not find the canonical tag in pricing.html to anchor the JSON-LD.');
    process.exit(1);
  }
  pricingHtml = pricingHtml.replace(anchor, `${anchor}\n${ldBlock}`);
}

const target = path.join(ROOT, 'pricing.md');
const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
const htmlStale = !sameText(pricingHtml, html);

if (CHECK) {
  if (!sameText(current.trim(), body.trim()) || htmlStale) {
    console.error('pricing.md / pricing.html JSON-LD are out of date — run: node scripts/build-pricing-md.mjs');
    process.exit(1);
  }
  console.log(`[check] pricing.md and JSON-LD match: ${oneOff.length} one-off, ${members.length} membership tiers`);
} else {
  fs.writeFileSync(target, body);
  if (htmlStale) fs.writeFileSync(path.join(ROOT, 'pricing.html'), pricingHtml);
  console.log(`wrote pricing.md — ${oneOff.length} one-off products, ${members.length} membership tiers`
    + `${htmlStale ? '; updated pricing.html JSON-LD' : ''}`);
}
