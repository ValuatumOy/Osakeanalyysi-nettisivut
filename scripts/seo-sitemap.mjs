// Small sitemap.xml helpers, shared by the SEO build scripts.
//
// sitemap.xml is edited in place rather than regenerated: the report and company page
// generators already own their own <url> blocks and stamp real lastmod dates onto them.
// Rewriting the file wholesale would flatten those dates to "today" for 1,174 pages and
// tell Google everything changed at once.

/** Every <loc> currently in the sitemap. */
export function sitemapLocs(xml) {
  return (xml.match(/<loc>([^<]+)<\/loc>/g) || []).map((m) => m.replace(/<\/?loc>/g, ''));
}

/**
 * Insert or update one <url> block, keeping the existing lastmod unless a new one is given.
 */
export function upsertUrl(xml, loc, { lastmod = null, changefreq = 'weekly', priority = '0.6' } = {}) {
  const esc = loc.replace(/&/g, '&amp;');
  const re = new RegExp(`\\s*<url>\\s*<loc>${esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>[\\s\\S]*?</url>`);
  const existing = xml.match(re);
  const keptLastmod = lastmod
    || (existing ? (existing[0].match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] : null)
    || new Date().toISOString().slice(0, 10);

  const block = `
  <url>
    <loc>${esc}</loc>
    <lastmod>${keptLastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;

  if (existing) return xml.replace(re, block);
  return xml.replace(/\s*<\/urlset>/, `${block}\n</urlset>`);
}

/** Drop one <url> block. Returns the xml unchanged when the loc is not present. */
export function removeUrl(xml, loc) {
  const esc = loc.replace(/&/g, '&amp;');
  const re = new RegExp(`\\s*<url>\\s*<loc>${esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>[\\s\\S]*?</url>`);
  return xml.replace(re, '');
}
