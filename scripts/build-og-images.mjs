#!/usr/bin/env node
// Build the Open Graph card images.
//
// og-image.png was 240x79 -- the logo strip, byte-identical to Valuatum_logo.png -- and was
// the share card on all 1,174 pages. Meanwhile og-image.svg was a properly designed
// 1200x630 card that had never been rasterised. So the card existed; nothing had ever
// turned it into the PNG the meta tags point at.
//
// This renders that card, and gives each report page a card of its own carrying the company,
// the rating and the price target: the things that make the link worth opening, and the
// things a plain logo says nothing about.
//
// Rendering is Chrome headless, which is already required elsewhere in the toolchain and
// avoids adding an image dependency.
//
//   node scripts/build-og-images.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { headlineOf, identity } from './report-headline.mjs';
import { SHOW_RATINGS_IN_METADATA } from './seo-flags.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'images', 'og');
const CHECK = process.argv.includes('--check');

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Fit a string to a width by trimming on a word boundary. */
const fit = (s, max) => (s.length <= max ? s : s.slice(0, max - 1).replace(/[\s,\-–—]+$/, '') + '…');

const RATING_COLOR = { BUY: '#3d9e72', HOLD: '#c9962c', SELL: '#c4553f' };

/**
 * The decorative trend line follows the rating. A line climbing across a SELL card argues
 * the opposite of the card, which on a share image is the only thing most people read.
 */
function trendLine(rating) {
  // No rating means no direction: a sloped line would still argue a case the card does not
  // make. Flat, with the same wobble, so it still reads as a chart.
  const slope = rating ? ({ BUY: -1, SELL: 1, HOLD: 0 }[rating] ?? 0) : 0;
  const wobble = [0, 8, -6, 10, -4, 6, -8, 4, -10, 2, -6, 0];
  return wobble.map((w, i) => {
    const x = 60 + i * 100;
    const y = 520 + slope * (i - 5.5) * 22 + w;
    return `${x},${Math.round(y)}`;
  }).join(' ');
}

/** One report's card, on the same grid as og-image.svg so the set looks like a set. */
function reportCard({ name, ticker, rating, target, current }) {
  // With ratings off, the verdict leaves the card entirely -- and so do the two things that
  // encode it without words: the accent colour (red reads SELL at a glance) and the slope of
  // the trend line. What is left describes what the report contains.
  if (!SHOW_RATINGS_IN_METADATA) {
    rating = null;
    target = null;
    current = null;
  }
  const accent = (rating && RATING_COLOR[rating]) || '#3d9e72';
  // A 240px tile holds about 11 characters at 30px; longer headings step down rather than
  // overflow the tile.
  const stat = (x, label, value, color = 'white') => `
  <rect x="${x}" y="380" width="240" height="96" rx="8" fill="rgba(61,158,114,0.08)" stroke="rgba(61,158,114,0.2)" stroke-width="1"/>
  <text x="${x + 120}" y="420" text-anchor="middle" font-family="Inter, -apple-system, sans-serif" font-size="${String(value).length > 11 ? 23 : 30}" font-weight="400" fill="${color}">${esc(value)}</text>
  <text x="${x + 120}" y="450" text-anchor="middle" font-family="Inter, -apple-system, sans-serif" font-size="14" fill="rgba(255,255,255,0.4)">${esc(label)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d1f1a"/>
      <stop offset="100%" stop-color="#111c18"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <line x1="0" y1="210" x2="1200" y2="210" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
  <line x1="0" y1="420" x2="1200" y2="420" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
  <line x1="400" y1="0" x2="400" y2="630" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
  <line x1="800" y1="0" x2="800" y2="630" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
  <polyline points="${trendLine(rating)}"
    stroke="${accent}" stroke-width="2" fill="none" opacity="0.28"/>
  <rect x="80" y="150" width="4" height="64" fill="${accent}" rx="2"/>
  <text x="104" y="185" font-family="Inter, -apple-system, sans-serif" font-size="26" font-weight="400" fill="${accent}" letter-spacing="0.06em">${esc(ticker)}</text>
  <text x="104" y="245" font-family="Inter, -apple-system, sans-serif" font-size="54" font-weight="300" fill="white" letter-spacing="-1">${esc(fit(name, 30))}</text>
  <text x="104" y="300" font-family="Inter, -apple-system, sans-serif" font-size="24" font-weight="300" fill="rgba(255,255,255,0.5)">AI equity report · value pool analysis · reverse valuation</text>
${rating
    ? `${stat(104, 'rating', rating, accent)}
${stat(364, 'price target', target)}
${current ? stat(624, 'current price', current) : ''}`
    // No verdict on the card: say what the reader gets instead of what we concluded.
    : `${stat(104, 'each business priced', 'Value pools')}
${stat(364, 'what the price implies', 'Reverse valuation')}
${stat(624, 'estimates & statements', 'Financials')}`}
  <text x="104" y="560" font-family="Inter, -apple-system, sans-serif" font-size="20" font-weight="500" fill="#3d9e72" letter-spacing="0.05em">VALUATUM</text>
  <text x="230" y="560" font-family="Inter, -apple-system, sans-serif" font-size="20" font-weight="300" fill="rgba(255,255,255,0.3)">· aiequityreports.com</text>
</svg>`;
}

/** Rasterise an SVG string to a PNG at exactly 1200x630. */
function rasterise(svg, outFile) {
  if (!CHROME) throw new Error('Chrome not found — set CHROME_PATH to rebuild OG images.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
  const page = path.join(tmp, 'card.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#0d1f1a;overflow:hidden}svg{display:block}</style>
${svg}`);
  try {
    execFileSync(CHROME, [
      '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      '--window-size=1200,630', `--screenshot=${outFile}`, `file:///${page.replace(/\\/g, '/')}`,
    ], { stdio: 'pipe' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── which report pages get their own card ───────────────────────────────────
function ratedReports() {
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'reports')).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ROOT, 'reports', f), 'utf8');
    const h = headlineOf(html);
    if (!h) continue; // company overview pages share the default card
    const id = identity(html);
    if (!id) continue;
    out.push({
      slug: f.replace(/\.html$/, ''),
      name: id.name,
      ticker: id.ticker,
      rating: h.recommendation,
      target: h.targetPrice || '',
      current: h.currentPrice || '',
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ── build ───────────────────────────────────────────────────────────────────
const reports = ratedReports();
const planned = [
  { out: path.join(ROOT, 'images', 'og-image.png'), svg: fs.readFileSync(path.join(ROOT, 'images', 'og-image.svg'), 'utf8'), key: 'default' },
  ...reports.map((r) => ({ out: path.join(OUT, `${r.slug}.png`), svg: reportCard(r), key: r.slug })),
];

if (CHECK) {
  const missing = planned.filter((p) => !fs.existsSync(p.out));
  const defaultPng = fs.readFileSync(path.join(ROOT, 'images', 'og-image.png'));
  const stillLogo = defaultPng.equals(fs.readFileSync(path.join(ROOT, 'images', 'Valuatum_logo.png')));
  console.log(`[check] ${planned.length - missing.length}/${planned.length} OG images present`
    + `${stillLogo ? ', default is STILL the logo strip' : ''}`);
  if (missing.length || stillLogo) {
    console.error('OG images are out of date — run: node scripts/build-og-images.mjs');
    process.exit(1);
  }
} else {
  fs.mkdirSync(OUT, { recursive: true });
  for (const p of planned) rasterise(p.svg, p.out);
  console.log(`wrote ${planned.length} OG images (1 default + ${reports.length} report cards) -> images/og/`);
}
