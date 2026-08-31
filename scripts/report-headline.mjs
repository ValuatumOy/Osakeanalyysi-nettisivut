// Read a built page's rating and price target from the structured source, not from its own
// prose.
//
// The SEO scripts used to recover the rating by regexing the meta description for
// "rates KESKOB.HE SELL with a 17.10 EUR price target". That worked only for as long as
// nobody changed the sentence -- and changing that sentence is exactly what the snippet
// rewrite does. Every built report page carries <meta name="valuatum-report-id">, which
// names the report-content/<id>.json the page was generated from, and that file holds the
// headline as data.
//
// Company overview pages have no report id and no rating; they return null.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = path.join(ROOT, 'report-content');

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—');

/** Company name and ticker, from the page's own title. */
export function identity(html) {
  const title = dec((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
  const m = title.match(/^(.*?)\s*\(([^)]+)\)\s*(?:Stock|Valuation)/);
  return m ? { name: m[1].trim(), ticker: m[2].trim() } : null;
}

/**
 * { recommendation, targetPrice, currentPrice, impliedUpside } for a rated page, else null.
 */
export function headlineOf(html) {
  const id = (html.match(/valuatum-report-id" content="([^"]*)"/) || [])[1];
  if (!id) return null;
  const file = path.join(CONTENT_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const h = doc.headline;
  return h && h.recommendation ? h : null;
}
