#!/usr/bin/env node
// Generates static blog article pages from blog-content/*.json.
// Also regenerates blog.html index with live-article cards at the top.
// Hard-fails if any article references an author with TODO fields, missing photo, or missing LinkedIn.
// Run: node scripts/build-blog-pages.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.aiequityreports.com';
const CONTENT_DIR = path.join(ROOT, 'blog-content');
const OUT_DIR = path.join(ROOT, 'blog');
const AUTHORS_FILE = path.join(ROOT, 'blog-system', 'authors.json');

// ── helpers ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (s) => esc(s);
const isoDate = (s) => String(s ?? '').substring(0, 10);
const humanDate = (s) => {
  const d = new Date(String(s ?? '').substring(0, 10));
  return isNaN(d) ? String(s) : d.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
};

// An article carries its own lifecycle state. "hidden" means the human pulled
// it from the site via scripts/blog-admin.mjs: the JSON stays so it can be
// restored, but nothing is emitted for it — no page, no card, no sitemap entry.
const isHidden = (article) => article.status === 'hidden';

// The visible edit notice. Readers are told when an article changed after
// publication, to the minute, in Helsinki time — the stamp written by
// scripts/blog-admin.mjs, not the build clock.
function editedLabel(article) {
  const edits = article.editHistory;
  if (!Array.isArray(edits) || !edits.length) return null;
  const last = edits[edits.length - 1];
  if (!last?.date || !last?.time) return null;
  const [y, m, d] = last.date.split('-');
  return `Edited ${Number(d)}.${Number(m)}.${y} at ${last.time}`;
}

function editedNoticeHtml(edited) {
  if (!edited) return '';
  return `
      <div style="background:var(--off-white); border-left:3px solid var(--green); border-radius:var(--r-md); padding:0.75rem 1rem; margin-bottom:2rem;">
        <p style="font-size:var(--text-xs); color:var(--charcoal-mid); margin:0;"><strong>${esc(edited)}</strong> · This article was updated after publication. Times are Europe/Helsinki.</p>
      </div>
`;
}

function loadAuthors() {
  if (!fs.existsSync(AUTHORS_FILE)) throw new Error(`authors.json not found at ${AUTHORS_FILE}`);
  return JSON.parse(fs.readFileSync(AUTHORS_FILE, 'utf8'));
}

function validateAuthor(author, role) {
  const todos = ['name', 'title', 'bio', 'photo', 'linkedin'].filter(
    (f) => !author[f] || String(author[f]).includes('TODO')
  );
  if (todos.length) {
    throw new Error(
      `HARD FAIL: ${role} "${author.id}" has TODO fields: ${todos.join(', ')}. ` +
      `Fill blog-system/authors.json before publishing. No article ships with an anonymous or fake byline.`
    );
  }
  if (!author.photo || String(author.photo).includes('TODO')) {
    throw new Error(`HARD FAIL: ${role} "${author.id}" has no photo. Add a real photo file.`);
  }
}

function validateReviewer(reviewer, role) {
  const todos = ['name', 'title', 'linkedin'].filter(
    (f) => !reviewer[f] || String(reviewer[f]).includes('TODO')
  );
  if (todos.length) {
    throw new Error(
      `HARD FAIL: ${role} "${reviewer.id}" has TODO fields: ${todos.join(', ')}. ` +
      `Fill blog-system/authors.json before publishing.`
    );
  }
}

// ── data provenance ────────────────────────────────────────────────────────
// Which report each proprietary number came from. Shape is enforced here so a
// malformed entry cannot silently disable the staleness gate in
// scripts/check-blog-freshness.mjs, which is what reads this.
function validateProvenance(article) {
  const prov = article.dataProvenance;
  if (prov === undefined) return;            // absent is a warning in the gate, not a build failure
  if (!Array.isArray(prov)) {
    throw new Error(`HARD FAIL: article "${article.slug}" has dataProvenance that is not an array.`);
  }
  prov.forEach((p, i) => {
    for (const field of ['reportId', 'slug', 'reportDate']) {
      if (!p || !p[field]) {
        throw new Error(
          `HARD FAIL: article "${article.slug}" dataProvenance[${i}] is missing "${field}". ` +
          `Each entry needs { reportId, slug, reportDate, used } naming the report a number came from. ` +
          `Run 'node scripts/report-index.mjs' to see the current report for each company.`
        );
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.reportDate)) {
      throw new Error(
        `HARD FAIL: article "${article.slug}" dataProvenance[${i}].reportDate "${p.reportDate}" ` +
        `is not YYYY-MM-DD. It must be the reportDate FIELD of the report, not the date in its filename.`
      );
    }
  });
}

// ── nav / footer (match site layout) ──────────────────────────────────────
function navHtml() {
  return `  <header class="nav scrolled" id="nav">
    <div class="nav-inner">
      <a href="/index.html" class="nav-logo">
        <img src="/images/logo.svg" class="nav-logo-img" alt="Valuatum">
        <div class="nav-logo-text">
          <span class="nav-logo-wordmark" style="color:var(--charcoal);">Valuatum</span>
          <span class="nav-logo-sub" style="color:var(--gray-steel);">AI Equity Reports</span>
        </div>
      </a>
      <nav class="nav-links" aria-label="Main navigation">
        <a href="/reports.html" class="nav-link is-active" aria-current="page">Reports</a>
        <a href="/report-store.html" class="nav-link">Store</a>
        <a href="/pricing.html" class="nav-link">Pricing</a>
        <a href="/analysts.html" class="nav-link">Analysts</a>
        <details class="nav-more">
          <summary class="nav-link">More</summary>
          <div class="nav-more-menu">
            <a href="/methodology.html" class="nav-link">Methodology</a>
            <a href="/about.html" class="nav-link">About</a>
            <a href="/faq.html" class="nav-link">FAQ</a>
            <a href="/blog.html" class="nav-link">Blog</a>
          </div>
        </details>
      </nav>
      <a href="/members.html" class="nav-signin">Sign in</a>
      <a href="/reports.html" class="nav-cta">Browse reports</a>
      <button class="nav-hamburger" aria-label="Open menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
    </div>
    <div class="nav-mobile-menu" id="mobileMenu" style="display:none;">
      <a href="/reports.html" class="nav-mobile-link is-active" aria-current="page">Reports</a>
      <a href="/report-store.html" class="nav-mobile-link">Store</a>
      <a href="/pricing.html" class="nav-mobile-link">Pricing</a>
      <a href="/analysts.html" class="nav-mobile-link">Analysts</a>
      <a href="/methodology.html" class="nav-mobile-link">Methodology</a>
      <a href="/about.html" class="nav-mobile-link">About</a>
      <a href="/faq.html" class="nav-mobile-link">FAQ</a>
      <a href="/blog.html" class="nav-mobile-link">Blog</a>
      <a href="/members.html" class="nav-mobile-link">Sign in</a>
      <a href="/reports.html" class="nav-mobile-link nav-mobile-cta">Browse reports →</a>
    </div>
  </header>`;
}

function footerHtml() {
  // Canonical site footer, kept identical to index.html / reports.html.
  // Generated blog pages drifted from the hand-maintained pages once before;
  // if the site footer changes, change it here too.
  return `  <footer class="footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <a href="/index.html" class="nav-logo" style="margin-bottom:1rem; display:inline-flex;">
            <img src="/images/logo.svg" class="nav-logo-img" alt="Valuatum">
            <div class="nav-logo-text">
              <span class="nav-logo-wordmark">Valuatum</span>
              <span class="nav-logo-sub">AI Equity Reports</span>
            </div>
          </a>
          <p>Professional AI-generated equity research reports for listed companies. Built on financial data, structured methodology, and 25+ years of analysis expertise.</p>
        </div>
        <div>
          <div class="footer-col-label">Reports</div>
          <div class="footer-links">
            <a href="/reports.html" class="footer-link">Browse reports</a>
            <a href="/reports.html#free" class="footer-link">Free samples</a>
            <a href="/reports.html#order-fresh" class="footer-link">Generate fresh report</a>
            <a href="/pricing.html" class="footer-link">Pricing</a>
            <a href="/methodology.html" class="footer-link">Methodology</a>
          </div>
        </div>
        <div>
          <div class="footer-col-label">Company</div>
          <div class="footer-links">
            <a href="/about.html" class="footer-link">About Valuatum</a>
            <a href="https://valuatum.com" class="footer-link" target="_blank" rel="noopener">Valuatum.com</a>
            <a href="mailto:contact26@valuatum.com" class="footer-link">Support</a>
            <a href="mailto:contact26@valuatum.com" class="footer-link">Enterprise sales</a>
          </div>
        </div>
        <div>
          <div class="footer-col-label">Legal</div>
          <div class="footer-links">
            <a href="/disclaimer.html" class="footer-link">Disclaimer</a>
            <a href="/disclaimer.html#terms" class="footer-link">Terms of use</a>
            <a href="/disclaimer.html#privacy" class="footer-link">Privacy policy</a>
          </div>
        </div>
      </div>
      <div class="footer-bottom">
        <span class="footer-copyright">© 2026 Valuatum Oy · Helsinki, Finland · Est. 2000</span>
        <span class="footer-disclaimer">Reports are AI-generated research materials for informational purposes only. Not investment advice. Past performance is not indicative of future results.</span>
      </div>
    </div>
  </footer>`;
}

// ── author box ─────────────────────────────────────────────────────────────
function authorBoxHtml(author, reviewer, dateStr) {
  return `
        <div style="border-top:1px solid var(--color-border); margin-top:3rem; padding-top:2rem;">
          <div style="display:flex; gap:1.25rem; align-items:flex-start; flex-wrap:wrap;">
            <img src="${attr(author.photo)}" alt="${attr(author.name)}" width="72" height="72"
              style="width:72px; height:72px; border-radius:50%; object-fit:cover; flex-shrink:0; border:2px solid var(--color-border);">
            <div style="flex:1; min-width:200px;">
              <div style="font-size:var(--text-xs); text-transform:uppercase; letter-spacing:0.08em; color:var(--gray-steel); margin-bottom:0.25rem;">Written by</div>
              <div style="font-weight:600; color:var(--charcoal); margin-bottom:0.15rem;">${esc(author.name)}</div>
              <div style="font-size:var(--text-sm); color:var(--gray-steel); margin-bottom:0.5rem;">${esc(author.title)}</div>
              <p style="font-size:var(--text-sm); color:var(--charcoal-mid); line-height:1.65; margin:0 0 0.75rem;">${esc(author.bio)}</p>
              <a href="${attr(author.linkedin)}" target="_blank" rel="noopener noreferrer"
                style="display:inline-flex; align-items:center; gap:0.4rem; font-size:var(--text-xs); font-weight:600; color:var(--green); text-decoration:none; border:1px solid var(--green); border-radius:var(--r-pill); padding:0.3rem 0.75rem;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3A2 2 0 0 1 21 5V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V5A2 2 0 0 1 5 3H19M18.5 18.5V13.2A3.26 3.26 0 0 0 15.24 9.94C14.39 9.94 13.4 10.46 12.92 11.24V10.13H10.13V18.5H12.92V13.57A1.32 1.32 0 0 1 14.24 12.25A1.32 1.32 0 0 1 15.56 13.57V18.5H18.5M6.88 8.56A1.68 1.68 0 0 0 8.56 6.88C8.56 5.95 7.81 5.19 6.88 5.19A1.69 1.69 0 0 0 5.19 6.88C5.19 7.81 5.95 8.56 6.88 8.56M8.27 18.5V10.13H5.5V18.5H8.27Z"/></svg>
                LinkedIn
              </a>
            </div>
          </div>
          <div style="margin-top:1.25rem; font-size:var(--text-xs); color:var(--gray-steel); border-top:1px solid var(--color-border); padding-top:0.75rem;">
            Reviewed and accepted by <strong>${esc(reviewer.name)}</strong> · ${esc(reviewer.title)} · ${humanDate(dateStr)}
          </div>
        </div>`;
}

// ── FAQ block ──────────────────────────────────────────────────────────────
function faqHtml(faqs) {
  if (!Array.isArray(faqs) || !faqs.length) return '';
  return `
        <section id="faq" style="margin-top:3rem;">
          <h2>Frequently asked questions</h2>
          ${faqs.map(f => `
          <div style="border-bottom:1px solid var(--color-border); padding:1.1rem 0;">
            <h3 style="font-size:var(--text-md); margin:0 0 0.4rem;">${esc(f.q)}</h3>
            <p style="margin:0;">${esc(f.a)}</p>
          </div>`).join('')}
        </section>`;
}

// ── Sources section ────────────────────────────────────────────────────────
function sourcesHtml(sources) {
  if (!Array.isArray(sources) || !sources.length) return '';
  return `
        <section id="sources" style="margin-top:2.5rem;">
          <h2 style="font-size:var(--text-md);">Sources</h2>
          <ul style="padding-left:1.2rem; margin:0;">
            ${sources.map(s => `<li style="margin-bottom:0.4rem; font-size:var(--text-sm);">
              ${s.url ? `<a href="${attr(s.url)}" style="color:var(--green);">${esc(s.label)}</a>` : esc(s.label)}
            </li>`).join('')}
          </ul>
        </section>`;
}

function internalLinksHtml(article) {
  const links = (article.internalLinks || [])
    .filter(href => href && href !== `/blog/${article.slug}.html` && href !== '/blog.html')
    .filter(href => {
      const local = href.split('#')[0].split('?')[0].replace(/^\/+/, '') || 'index.html';
      return fs.existsSync(path.join(ROOT, local));
    })
    .slice(0, 4);
  if (!links.length) return '';
  const labels = {
    '/methodology.html': 'Explore the Valuatum methodology',
    '/reports.html': 'Browse AI equity reports',
  };
  return `
        <section aria-labelledby="continue-researching" style="margin-top:2.5rem;background:var(--off-white);border-radius:var(--r-lg);padding:1.5rem;">
          <h2 id="continue-researching" style="font-size:var(--text-md);margin-top:0;">Continue researching</h2>
          <ul style="margin:0;padding-left:1.2rem;">
            ${links.map(href => {
              const fallback = href.split('/').pop().replace(/\.html$/, '').replace(/-/g, ' ');
              return `<li style="margin-bottom:.55rem;"><a href="${attr(href)}">${esc(labels[href] || fallback)}</a></li>`;
            }).join('')}
          </ul>
        </section>`;
}

// ── JSON-LD ────────────────────────────────────────────────────────────────
function jsonLd(article, author, reviewer) {
  const url = `${SITE}/blog/${article.slug}.html`;
  const authorId = `${SITE}${author.authorPage}#person`;
  const graph = [
    {
      '@type': 'Organization',
      '@id': `${SITE}/#organization`,
      name: 'Valuatum Oy',
      url: 'https://valuatum.com',
      logo: {
        '@type': 'ImageObject',
        url: `${SITE}/images/Valuatum_logo.png`,
      },
    },
    {
      '@type': 'Person',
      '@id': authorId,
      name: author.name,
      url: `${SITE}${author.authorPage}`,
      image: `${SITE}${author.photo}`,
      sameAs: author.sameAs || [author.linkedin],
      jobTitle: author.title,
      worksFor: { '@id': `${SITE}/#organization` },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE}/blog.html` },
        { '@type': 'ListItem', position: 3, name: article.title, item: url },
      ],
    },
    {
      '@type': 'BlogPosting',
      '@id': url + '#article',
      headline: article.title,
      description: article.metaDescription,
      datePublished: isoDate(article.datePublished),
      dateModified: isoDate(article.dateModified),
      inLanguage: 'en',
      mainEntityOfPage: url,
      image: `${SITE}/images/og-image.png`,
      author: { '@id': authorId },
      publisher: { '@id': `${SITE}/#organization` },
      reviewedBy: reviewer ? {
        '@type': 'Person',
        name: reviewer.name,
        sameAs: reviewer.linkedin,
        jobTitle: reviewer.title,
      } : undefined,
      keywords: [article.targetQuery, article.cluster, ...(article.keywords || [])].filter(Boolean),
      about: article.cluster ? { '@type': 'Thing', name: String(article.cluster).replace(/-/g, ' ') } : undefined,
      isAccessibleForFree: true,
    },
  ];
  if (Array.isArray(article.faq) && article.faq.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: article.faq.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2);
}

// ── article page template ──────────────────────────────────────────────────
function renderArticle(article, author, reviewer) {
  const url = `${SITE}/blog/${article.slug}.html`;
  const clusterLabel = {
    'ai-equity-research': 'AI Equity Research',
    'valuation-methodology': 'Valuation Methodology',
    'helsinki-stocks': 'Helsinki Stocks',
    'company-deep-dives': 'Company Analysis',
  }[article.cluster] || article.cluster;
  const edited = editedLabel(article);

  const sectionsHtml = (article.sections || []).map(s =>
    `<section style="margin-top:2.5rem;" id="${attr(s.h2.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}">
          <h2>${esc(s.h2)}</h2>
          ${s.html}
        </section>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(article.title)} | Valuatum Blog</title>
  <meta name="description" content="${attr(article.metaDescription)}">
  <link rel="canonical" href="${url}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta property="og:title" content="${attr(article.title)}">
  <meta property="og:description" content="${attr(article.metaDescription)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${SITE}/images/og-image.png">
  <meta property="article:published_time" content="${isoDate(article.datePublished)}">
  <meta property="article:modified_time" content="${isoDate(article.dateModified)}">
  <meta property="article:author" content="${attr(author.linkedin)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${attr(article.title)}">
  <meta name="twitter:description" content="${attr(article.metaDescription)}">
  <meta name="twitter:image" content="${SITE}/images/og-image.png">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-HSRL85C0K5"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-HSRL85C0K5');</script>
  <script type="application/ld+json">
${jsonLd(article, author, reviewer)}
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300;0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
  <style>
    .blog-post-hero { background: var(--forest); padding: var(--section-py) 0 2.5rem; }
    .blog-post-body { max-width: 720px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
    .blog-post-body h2 { font-size: var(--text-lg); font-weight: 500; color: var(--charcoal); margin-top: 0; letter-spacing: -0.02em; }
    .blog-post-body p { font-size: var(--text-sm); line-height: 1.8; color: var(--charcoal); margin-top: 0; margin-bottom: 1.25rem; }
    .blog-post-body p:last-child { margin-bottom: 0; }
    .blog-post-body a { color: var(--green); }
    .blog-post-body ul, .blog-post-body ol { font-size: var(--text-sm); line-height: 1.8; margin-bottom: 1.25rem; }
    @media (max-width: 600px) { .blog-post-body { padding: 2rem 1rem 3rem; } }
  </style>
</head>
<body>
${navHtml()}

  <main>
    <section class="blog-post-hero">
      <div class="container" style="max-width:720px;">
        <nav aria-label="Breadcrumb" style="font-size:var(--text-xs); color:rgba(255,255,255,0.5); margin-bottom:1.5rem;">
          <a href="/" style="color:rgba(255,255,255,0.6);">Home</a> ›
          <a href="/blog.html" style="color:rgba(255,255,255,0.6);">Blog</a> ›
          <span>${esc(clusterLabel)}</span>
        </nav>
        <div style="font-size:var(--text-xs); font-weight:600; text-transform:uppercase; letter-spacing:0.1em; color:var(--green-light); margin-bottom:1rem;">${esc(clusterLabel)}</div>
        <h1 style="font-size:clamp(1.5rem,4vw,2.25rem); font-weight:300; color:white; line-height:1.25; letter-spacing:-0.03em; margin-bottom:1.25rem;">${esc(article.title)}</h1>
        <div style="display:flex; align-items:center; gap:1rem; flex-wrap:wrap;">
          <img src="${attr(author.photo)}" alt="${attr(author.name)}" width="32" height="32"
            style="width:32px; height:32px; border-radius:50%; object-fit:cover; border:1.5px solid rgba(255,255,255,0.3);">
          <span style="font-size:var(--text-xs); color:rgba(255,255,255,0.7);">
            ${esc(author.name)} · ${humanDate(article.datePublished)}${article.readingTimeMinutes ? ` · ${article.readingTimeMinutes} min read` : ''}
          </span>
          ${edited
            ? `<span style="font-size:var(--text-xs); color:var(--green-light);">${esc(edited)}</span>`
            : article.dateModified && article.dateModified !== article.datePublished
              ? `<span style="font-size:var(--text-xs); color:rgba(255,255,255,0.45);">Updated ${humanDate(article.dateModified)}</span>`
              : ''}
        </div>
      </div>
    </section>

    <div class="blog-post-body">
${editedNoticeHtml(edited)}
      ${sectionsHtml}

      ${faqHtml(article.faq)}

      ${sourcesHtml(article.sources)}

      ${internalLinksHtml(article)}

      <div style="background:var(--off-white); border-radius:var(--r-lg); padding:1.25rem 1.5rem; margin-top:2.5rem; border-left:3px solid var(--gray-steel);">
        <p style="font-size:var(--text-xs); color:var(--gray-steel); margin:0;"><strong>Disclaimer:</strong> This article is for informational purposes only and does not constitute investment advice or a buy/sell recommendation. Always do your own research. See our <a href="/disclaimer.html">full disclaimer</a> and <a href="/methodology.html">methodology</a>. Valuatum Oy, Helsinki, Finland.</p>
      </div>

      ${authorBoxHtml(author, reviewer, article.approval?.date || article.datePublished)}

      <div style="margin-top:2.5rem; padding-top:1.5rem; border-top:1px solid var(--color-border);">
        <a href="/blog.html" style="font-size:var(--text-sm); color:var(--green); text-decoration:none;">← Back to Blog</a>
      </div>

    </div>
  </main>

${footerHtml()}
  <script src="/js/script.js"></script>
</body>
</html>
`;
}

// ── blog index ─────────────────────────────────────────────────────────────
function renderBlogIndex(publishedArticles, authorsData) {
  const articleCards = publishedArticles.map(a => {
    const author = authorsData.authors.find(x => x.id === a.authorId);
    const clusterLabel = {
      'ai-equity-research': 'AI Equity Research',
      'valuation-methodology': 'Valuation Methodology',
      'helsinki-stocks': 'Helsinki Stocks',
      'company-deep-dives': 'Company Analysis',
    }[a.cluster] || a.cluster;
    const intro = (a.sections && a.sections[0] && a.sections[0].html || '')
      .replace(/<[^>]+>/g, '').substring(0, 160).trim();
    return `
          <a href="/blog/${esc(a.slug)}.html" style="text-decoration:none;" class="blog-card">
            <div class="blog-card-thumb">
              <span class="blog-card-thumb-label">${esc(clusterLabel)}</span>
            </div>
            <div class="blog-card-body">
              <div class="blog-card-category">${esc(clusterLabel)}</div>
              <div class="blog-card-title">${esc(a.title)}</div>
              <p class="blog-card-desc">${esc(intro)}…</p>
              <div class="blog-card-footer">
                <span class="blog-card-meta">${author ? esc(author.name) : 'Valuatum'} · ${a.readingTimeMinutes ? a.readingTimeMinutes + ' min read' : humanDate(a.datePublished)}</span>
                <span style="font-size:var(--text-xs); font-weight:600; color:var(--green);">Read →</span>
              </div>
            </div>
          </a>`;
  }).join('\n');

  const publishedSection = publishedArticles.length ? `
        <div style="display:flex; align-items:center; gap:1rem; margin-bottom:0.5rem;">
          <span style="font-size:var(--text-sm); font-weight:600; color:var(--charcoal);">Latest articles</span>
          <span style="flex:1; height:1px; background:var(--color-border);"></span>
        </div>
        <div class="blog-grid" style="margin-bottom:3rem;">
          ${articleCards}
        </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Blog — AI Equity Research Insights — Valuatum</title>
  <meta name="description" content="Insights on AI equity research, valuation methodology, reverse valuation, and how to read professional equity reports. Written by the Valuatum team.">
  <link rel="canonical" href="${SITE}/blog.html">
  <meta property="og:title" content="Blog — AI Equity Research Insights — Valuatum">
  <meta property="og:description" content="Insights on AI equity research, valuation methodology, and how professional equity analysis works. Written by the Valuatum team.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${SITE}/blog.html">
  <meta property="og:image" content="${SITE}/images/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${SITE}/images/og-image.png">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-HSRL85C0K5"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-HSRL85C0K5');</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300;0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/style.css">
  <style>
    .blog-hero { background: var(--forest); padding: var(--section-py) 0; }
    .blog-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 2rem; margin-top: 1.5rem; }
    .blog-card { background: var(--white); border: 1px solid var(--color-border); border-radius: var(--r-xl); overflow: hidden; display: flex; flex-direction: column; }
    .blog-card-thumb { background: var(--forest); height: 160px; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; }
    .blog-card-thumb-label { font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--green-light); }
    .blog-card-body { padding: 1.75rem; flex: 1; display: flex; flex-direction: column; }
    .blog-card-category { font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--green); margin-bottom: 0.75rem; }
    .blog-card-title { font-size: var(--text-md); font-weight: 500; color: var(--charcoal); line-height: 1.4; margin-bottom: 0.75rem; }
    .blog-card-desc { font-size: var(--text-sm); font-weight: 300; color: var(--gray-steel); line-height: 1.7; flex: 1; margin-bottom: 1.25rem; }
    .blog-card-footer { display: flex; align-items: center; justify-content: space-between; }
    .blog-card-meta { font-size: var(--text-xs); color: var(--gray-steel); }
    .blog-coming-soon { display: inline-flex; align-items: center; gap: 0.4rem; font-size: var(--text-xs); font-weight: 600; background: var(--off-white); color: var(--gray-steel); border: 1px solid var(--color-border); border-radius: 99px; padding: 0.3rem 0.75rem; }
    .blog-coming-soon-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--gold); }
  </style>
</head>
<body>

  <header class="nav scrolled" id="nav">
    <div class="nav-inner">
      <a href="index.html" class="nav-logo">
        <img src="/images/logo.svg" class="nav-logo-img" alt="Valuatum">
        <div class="nav-logo-text">
          <span class="nav-logo-wordmark" style="color:var(--charcoal);">Valuatum</span>
          <span class="nav-logo-sub" style="color:var(--gray-steel);">AI Equity Reports</span>
        </div>
      </a>
      <nav class="nav-links" aria-label="Main navigation">
        <a href="/reports.html" class="nav-link is-active" aria-current="page">Reports</a>
        <a href="/report-store.html" class="nav-link">Store</a>
        <a href="/pricing.html" class="nav-link">Pricing</a>
        <a href="/analysts.html" class="nav-link">Analysts</a>
        <details class="nav-more">
          <summary class="nav-link">More</summary>
          <div class="nav-more-menu">
            <a href="/methodology.html" class="nav-link">Methodology</a>
            <a href="/about.html" class="nav-link">About</a>
            <a href="/faq.html" class="nav-link">FAQ</a>
            <a href="/blog.html" class="nav-link">Blog</a>
          </div>
        </details>
      </nav>
      <a href="/members.html" class="nav-signin">Sign in</a>
      <a href="/reports.html" class="nav-cta">Browse reports</a>
      <button class="nav-hamburger" aria-label="Open menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
    </div>
    <div class="nav-mobile-menu" id="mobileMenu" style="display:none;">
      <a href="/reports.html" class="nav-mobile-link is-active" aria-current="page">Reports</a>
      <a href="/report-store.html" class="nav-mobile-link">Store</a>
      <a href="/pricing.html" class="nav-mobile-link">Pricing</a>
      <a href="/analysts.html" class="nav-mobile-link">Analysts</a>
      <a href="/methodology.html" class="nav-mobile-link">Methodology</a>
      <a href="/about.html" class="nav-mobile-link">About</a>
      <a href="/faq.html" class="nav-mobile-link">FAQ</a>
      <a href="/blog.html" class="nav-mobile-link">Blog</a>
      <a href="/members.html" class="nav-mobile-link">Sign in</a>
      <a href="/reports.html" class="nav-mobile-link nav-mobile-cta">Browse reports →</a>
    </div>
  </header>

  <main>

    <section class="blog-hero">
      <div class="container">
        <span class="section-eyebrow section-eyebrow--light">Blog</span>
        <h1 class="section-headline section-headline--light" style="max-width:640px;">Insights on AI equity research.</h1>
        <p style="font-size:var(--text-md); font-weight:300; color:rgba(255,255,255,0.6); max-width:520px; line-height:1.75;">Practical writing on equity valuation, how AI equity reports work, and what to look for when analysing a company.</p>
      </div>
    </section>

    <section style="padding: var(--section-py) 0;">
      <div class="container">

        ${publishedSection}

        <div style="display:flex; align-items:center; gap:1rem; margin-bottom:0.5rem;">
          <span style="font-size:var(--text-sm); font-weight:600; color:var(--charcoal);">Coming soon</span>
          <span style="flex:1; height:1px; background:var(--color-border);"></span>
        </div>
        <p style="font-size:var(--text-sm); color:var(--gray-steel); margin-bottom:3rem;">More articles in progress. Subscribe below to get notified.</p>

        <div class="blog-grid">

          <div class="blog-card">
            <div class="blog-card-thumb">
              <svg aria-hidden="true" style="position:absolute;bottom:0;left:0;width:100%;opacity:0.15;" viewBox="0 0 400 100" fill="none"><polyline points="0,80 60,65 120,70 180,50 240,55 300,30 360,35 400,15" stroke="#6DBFA0" stroke-width="2" fill="none"/></svg>
              <span class="blog-card-thumb-label">Valuation</span>
            </div>
            <div class="blog-card-body">
              <div class="blog-card-category">Methodology</div>
              <div class="blog-card-title">What is reverse valuation and why does it matter more than a price target?</div>
              <p class="blog-card-desc">Most equity research ends with a price target. Reverse valuation starts there and works backwards, asking what has to be true for today's stock price to make sense.</p>
              <div class="blog-card-footer">
                <span class="blog-card-meta">Valuatum · 8 min read</span>
                <span class="blog-coming-soon"><span class="blog-coming-soon-dot"></span>Coming soon</span>
              </div>
            </div>
          </div>

          <div class="blog-card">
            <div class="blog-card-thumb">
              <svg aria-hidden="true" style="position:absolute;bottom:0;left:0;width:100%;opacity:0.15;" viewBox="0 0 400 100" fill="none"><polyline points="0,90 80,75 160,80 240,45 320,55 400,20" stroke="#6DBFA0" stroke-width="2" fill="none"/><polyline points="0,95 80,88 160,90 240,72 320,78 400,55" stroke="#3D9E72" stroke-width="1.5" fill="none" stroke-dasharray="4 4"/></svg>
              <span class="blog-card-thumb-label">AI Research</span>
            </div>
            <div class="blog-card-body">
              <div class="blog-card-category">AI equity research</div>
              <div class="blog-card-title">AI vs traditional equity research: what is actually different?</div>
              <p class="blog-card-desc">AI-generated equity reports follow the same analytical structure as traditional research notes. What changes is the speed, the cost, and how assumptions are made explicit.</p>
              <div class="blog-card-footer">
                <span class="blog-card-meta">Valuatum · 6 min read</span>
                <span class="blog-coming-soon"><span class="blog-coming-soon-dot"></span>Coming soon</span>
              </div>
            </div>
          </div>

          <div class="blog-card">
            <div class="blog-card-thumb">
              <svg aria-hidden="true" style="position:absolute;bottom:0;left:0;width:100%;opacity:0.15;" viewBox="0 0 400 100" fill="none"><polyline points="0,60 100,40 200,55 300,20 400,35" stroke="#6DBFA0" stroke-width="2" fill="none"/></svg>
              <span class="blog-card-thumb-label">Finnish Stocks</span>
            </div>
            <div class="blog-card-body">
              <div class="blog-card-category">Helsinki Stocks</div>
              <div class="blog-card-title">Investing in Helsinki-listed stocks: a guide for international investors</div>
              <p class="blog-card-desc">OMXH structure, sectors, and access for international investors — with proprietary valuations of five covered names.</p>
              <div class="blog-card-footer">
                <span class="blog-card-meta">Valuatum · 9 min read</span>
                <span class="blog-coming-soon"><span class="blog-coming-soon-dot"></span>Coming soon</span>
              </div>
            </div>
          </div>

        </div>

        <div style="background:var(--forest); border-radius:var(--r-xl); padding:3rem; margin-top:4rem; text-align:center;">
          <h2 style="font-size:var(--text-2xl); font-weight:300; color:white; letter-spacing:-0.02em; margin-bottom:0.75rem;">Get notified when articles go live.</h2>
          <p style="font-size:var(--text-sm); color:rgba(255,255,255,0.5); margin-bottom:2rem;">We will email you when the first articles are published. No spam.</p>
          <div style="display:flex; gap:0.75rem; justify-content:center; flex-wrap:wrap; max-width:460px; margin:0 auto;">
            <input type="email" placeholder="your@email.com" style="flex:1; min-width:220px; padding:0.75rem 1rem; border-radius:var(--r-md); border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.08); color:white; font-size:var(--text-sm); outline:none;" />
            <button class="btn btn-primary" onclick="this.textContent='Subscribed'; this.disabled=true;">Notify me</button>
          </div>
        </div>

      </div>
    </section>

  </main>

${footerHtml()}

  <script src="js/script.js"></script>
</body>
</html>
`;
}

function renderAuthorPage(author, articles) {
  const url = `${SITE}${author.authorPage}`;
  const articleLinks = articles.map(article =>
    `<li style="margin-bottom:0.75rem;"><a href="/blog/${attr(article.slug)}.html">${esc(article.title)}</a></li>`
  ).join('');
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    '@id': `${url}#profile`,
    url,
    name: `${author.name} — Valuatum author`,
    mainEntity: {
      '@type': 'Person',
      '@id': `${url}#person`,
      name: author.name,
      image: `${SITE}${author.photo}`,
      jobTitle: author.title,
      description: author.bio,
      sameAs: author.sameAs || [author.linkedin],
      worksFor: { '@type': 'Organization', name: 'Valuatum Oy', url: 'https://valuatum.com' },
    },
  }, null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(author.name)} — Author at Valuatum</title>
  <meta name="description" content="${attr(author.bio)}">
  <link rel="canonical" href="${url}">
  <meta property="og:title" content="${attr(author.name + ' — Author at Valuatum')}">
  <meta property="og:description" content="${attr(author.bio)}">
  <meta property="og:type" content="profile">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${SITE}${attr(author.photo)}">
  <script type="application/ld+json">
${schema}
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
${navHtml()}
  <main>
    <section style="background:var(--forest);padding:var(--section-py) 0 3rem;">
      <div class="container" style="max-width:760px;display:flex;gap:2rem;align-items:center;flex-wrap:wrap;">
        <img src="${attr(author.photo)}" alt="${attr(author.name)}" width="132" height="132" style="width:132px;height:132px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.2);">
        <div style="flex:1;min-width:260px;">
          <span class="section-eyebrow section-eyebrow--light">Valuatum author</span>
          <h1 style="color:white;font-size:var(--text-2xl);font-weight:300;margin:.5rem 0;">${esc(author.name)}</h1>
          <p style="color:var(--green-light);margin:0 0 .75rem;">${esc(author.title)}</p>
          <p style="color:rgba(255,255,255,.72);line-height:1.7;margin:0;">${esc(author.credentials || '')}</p>
        </div>
      </div>
    </section>
    <section style="padding:3rem 0;">
      <div class="container" style="max-width:760px;">
        <h2>About ${esc(author.name)}</h2>
        <p style="line-height:1.8;">${esc(author.bio)}</p>
        <p><a href="${attr(author.linkedin)}" target="_blank" rel="noopener noreferrer">View LinkedIn profile &rarr;</a></p>
        ${articles.length ? `<h2 style="margin-top:2.5rem;">Articles by ${esc(author.name)}</h2><ul>${articleLinks}</ul>` : ''}
      </div>
    </section>
  </main>
${footerHtml()}
  <script src="/js/script.js"></script>
</body>
</html>`;
}

// ── run ────────────────────────────────────────────────────────────────────
const authorsData = loadAuthors();
const authorMap = Object.fromEntries(authorsData.authors.map(a => [a.id, a]));
const reviewerMap = Object.fromEntries(authorsData.reviewers.map(r => [r.id, r]));

const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
if (!files.length) {
  console.log('No article JSON files found in blog-content/. Nothing to build.');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const published = [];
for (const file of files) {
  const article = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8'));

  if (isHidden(article)) {
    // Delete any page left from when it was live, or hiding would only remove
    // the card and leave the article itself served at its old URL.
    const stale = path.join(OUT_DIR, `${article.slug}.html`);
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
    console.log(`hidden ${article.slug} — no page, card, or sitemap entry`);
    continue;
  }

  const author = authorMap[article.authorId];
  const reviewer = reviewerMap[article.reviewerId];

  if (!author) throw new Error(`HARD FAIL: article "${article.slug}" references unknown authorId "${article.authorId}".`);
  if (!reviewer) throw new Error(`HARD FAIL: article "${article.slug}" references unknown reviewerId "${article.reviewerId}".`);

  validateAuthor(author, 'Author');
  validateReviewer(reviewer, 'Reviewer');
  validateProvenance(article);

  const html = renderArticle(article, author, reviewer);
  const outPath = path.join(OUT_DIR, `${article.slug}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`wrote  blog/${article.slug}.html`);
  published.push(article);
}

// Sort newest first
published.sort((a, b) => new Date(b.datePublished) - new Date(a.datePublished));

// Regenerate blog.html
fs.writeFileSync(path.join(ROOT, 'blog.html'), renderBlogIndex(published, authorsData));
console.log(`wrote  blog.html  (${published.length} live article${published.length !== 1 ? 's' : ''})`);

const authorsDir = path.join(ROOT, 'authors');
fs.mkdirSync(authorsDir, { recursive: true });
for (const author of authorsData.authors) {
  validateAuthor(author, 'Author');
  const authorArticles = published.filter(article => article.authorId === author.id);
  const authorSlug = path.basename(author.authorPage, '.html');
  fs.writeFileSync(path.join(authorsDir, `${authorSlug}.html`), renderAuthorPage(author, authorArticles));
  console.log(`wrote  authors/${authorSlug}.html`);
}

// Sitemap fragment
const today = new Date().toISOString().substring(0, 10);
const frag = published.map(a =>
  `  <url>\n    <loc>${SITE}/blog/${a.slug}.html</loc>\n    <lastmod>${isoDate(a.dateModified)}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>`
).concat(authorsData.authors.map(author =>
  `  <url>\n    <loc>${SITE}${author.authorPage}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`
)).join('\n');
fs.writeFileSync(path.join(ROOT, 'scripts', 'sitemap-blog.xml'), frag + '\n');
console.log(`wrote  scripts/sitemap-blog.xml`);

console.log(`\n${published.length} blog page${published.length !== 1 ? 's' : ''} written.`);
