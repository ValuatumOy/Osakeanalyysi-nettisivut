# Engineering handoff — SEO pages, company pages, Astro & AWS migration

Context for the CTO taking over the Astro rebuild and the Vercel → AWS move. Written by the team
that built this static site. Read this before migrating.

## 1. What shipped in this change

- **9 report landing pages** — `reports/*-equity-report.html`, static, indexable. Free reports (Tesla,
  Stora Enso, UPM) show the full analysis; paid reports show a teaser + buy gate.
- **9 company-page mockups** — `mockups/*.html`. These are the **design spec** for the Astro company
  pages, not production pages. Disallowed in `robots.txt`. Free company → fully visible; paid → facts
  public + analysis gated (`locked-section`).
- **SEO plumbing** — `sitemap.xml` (report pages added), `robots.txt` (AI-bot allows + `/mockups/`
  disallow), `llms.txt`, per-page schema (Article/Corporation/FAQPage/Breadcrumb), GA4.
- **Catalog deep-linking** — `js/reportSlugs.js` (id→slug map) lets `reports.html` cards link to the
  report landing pages. Homepage free cards link to them too.
- **Generators** (the real spec — keep these):
  - `scripts/build-report-pages.mjs` → report landing pages + `js/reportSlugs.js` + sitemap fragment.
  - `scripts/build-company-pages.mjs` → company-page mockups (the Astro design reference).
  - `report-content/*.json` — per-report data extracted from PDFs. `report-content/_catalog.json` —
    snapshot of the live catalog API. Regenerate with `pdftotext` (poppler).

## 2. How the data flows (critical for the rebuild)

- **Catalog source of truth = the external API**, NOT files in this repo:
  `https://files.valuatum.com/api/reports` (configured as `CATALOG_BASE` in `reports.html`,
  `CATALOG_API_URL` server-side). `js/reportsData.js` + `server/report-manifest.json` are only
  offline fallbacks and drift from production — do not trust them.
- The catalog returns **reports** keyed by report id (e.g. `tesla-01062026`). Company pages must
  **group reports by company** (ticker) to build the "all reports" history/library.
- **PDF enrichment**: rich page content (thesis, value pools, reverse valuation, financials) is
  extracted from each report PDF. The mockup pipeline does this offline into `report-content/*.json`.
  For Astro, make this a build step (or content-collection loader) that runs on report upload.
- **Company profile**: pages have an "About {company}" slot that renders a `profile` field when the
  report/system provides it (placeholder until then). This is the substance for no-report pages and
  unique SEO text — wire it to the new company-profile section of reports.

## 3. Stripe / payments (verify env on AWS)

- Buy flow: catalog Buy button → `handleStripeCheckout(reportId)` → `POST /api/create-checkout`
  (Vercel serverless, `api/create-checkout.js`) → Stripe Checkout Session → redirect. Fresh reports
  → `/api/create-fresh-checkout`. Webhook → `api/webhook.js`.
- `API_BASE = window.VALUATUM_API_BASE || ''` (same-origin). If the API moves to a different host on
  AWS, set `window.VALUATUM_API_BASE` or keep `/api/*` same-origin.
- **Required env vars** (must be set wherever the functions run):
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SITE_URL`, `CATALOG_API_URL`, `CATALOG_SYNC_SECRET`,
  plus the AWS SES credentials (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  or an instance role with `ses:SendEmail`) used by `server/email.js`.
- On AWS: update the Stripe **webhook endpoint URL** in the Stripe dashboard, and `SITE_URL`
  (success/cancel URLs are built from it). Note the report PDFs are served from `files.valuatum.com`,
  not this app — they stay put.

## 4. Astro rebuild notes

- **Route**: `src/pages/equity-research/[slug].astro` + `getStaticPaths()`. URL decision already made:
  `/equity-research/{company-slug}/` (append ticker on slug collisions). Add 301s from the interim
  `reports/*-equity-report.html` to the new URLs.
- **Rendering**: hybrid. Prerender companies that have a report (scope decision = "only companies with
  a report"). If you later add the long tail, use on-demand rendering with caching.
- **Vercel → AWS specifics**:
  - Static output → S3 + CloudFront. Configure trailing-slash/clean-URL + custom 404 to match
    `trailingSlash: 'always'`.
  - Vercel serverless functions (`api/*.js`, signature `(req,res)` with parsed `req.body`) are
    **Vercel-flavoured** — port to Lambda + API Gateway (or a small Node/Express service on
    ECS/Lightsail). `req.body` parsing and `res.json()` need an adapter or rewrite on raw Lambda.
  - ISR/on-demand equivalent on AWS = CloudFront cache + Lambda (or OpenNext/SST-style). For the
    chosen "report-having only" scope, pure static to S3 is enough — no SSR needed yet.
  - Keep `pdftotext`/poppler available in the build/CI for PDF extraction.
- **Design**: reuse `css/style.css` tokens + components. The mockups already use the real site
  components (`report-company-header`, `locked-section`, `btn-gold`, `upsell-bar`). The custom grid in
  the mockup `<style>` block (`cp-grid`/`cp-cell`/`cp-scroll`) exists because the site's `.metrics-grid`
  paints a grey background behind empty cells and wraps long values — use the `cp-` pattern (transparent
  container, bordered cells, scrollable tables) for any data grid/table.

## 5. Known data issue

- `nuholdings-02062026` PDF body is **New Era Helium**, not Nu Holdings (catalog says Banks/Brazil).
  Excluded from generation (`EXCLUDE` set in both generators). Fix the source PDF before publishing it.
