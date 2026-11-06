import assert from 'node:assert/strict';
import test from 'node:test';
import { updateLastmods } from '../../scripts/seo-sitemap.mjs';

test('lastmod changes only existing, selected sitemap URLs', () => {
  const xml = `<urlset>
  <url>
    <loc>https://example.com/changed</loc>
    <lastmod>2026-01-01</lastmod>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://example.com/unchanged</loc>
    <lastmod>2026-02-02</lastmod>
  </url>
  <url>
    <loc>https://example.com/added?a=1&amp;b=2</loc>
    <priority>0.8</priority>
  </url>
</urlset>`;
  const updated = updateLastmods(xml, [
    'https://example.com/changed',
    'https://example.com/added?a=1&b=2',
    'https://example.com/missing',
  ], '2026-11-06');
  assert.match(updated, /<loc>https:\/\/example\.com\/changed<\/loc>\s*<lastmod>2026-11-06<\/lastmod>\s*<priority>0\.9<\/priority>/);
  assert.match(updated, /<loc>https:\/\/example\.com\/unchanged<\/loc>\s*<lastmod>2026-02-02<\/lastmod>/);
  assert.match(updated, /<loc>https:\/\/example\.com\/added\?a=1&amp;b=2<\/loc>\s*<lastmod>2026-11-06<\/lastmod>\s*<priority>0\.8<\/priority>/);
  assert.ok(!updated.includes('example.com/missing'));
  assert.equal(updateLastmods(updated, [], '2026-11-07'), updated);
});
