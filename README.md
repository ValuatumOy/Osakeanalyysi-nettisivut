# AI Equity Reports — website & report backend

The commercial site for Valuatum's AI-generated equity research reports
(**www.aiequityreports.com**) plus the serverless backend that sells, generates
and delivers them.

Two things live in this repo:

1. **A static, SEO-first website** — thousands of pre-rendered company, report,
   comparison and blog pages, deployed on Vercel, with a handful of Vercel
   serverless functions for checkout and catalog reads.
2. **The report backend** — an AWS CDK app (`infra/`) plus the Lambda handlers
   in `server/` that host the PDF catalog, run the fresh-report order state
   machine, and email finished reports to buyers.

The product itself: a buyer searches a listed company, then either buys a
**ready report** (a PDF already in the catalog) or orders a **fresh report**
(generated on demand from live financial data and delivered by email in roughly
30 minutes). Some reports rotate into a free tier for SEO and lead generation.

---

## Contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [The report catalog](#the-report-catalog)
- [Order flows](#order-flows)
- [Static page generators](#static-page-generators)
- [Blog pipeline](#blog-pipeline)
- [Admin pages](#admin-pages)
- [Tests](#tests)
- [Deployment](#deployment)
- [Further reading](#further-reading)

---

## Architecture

```
                    ┌────────────────────────────────────────────┐
  browser  ────────▶│ Vercel — www.aiequityreports.com           │
                    │  static HTML (reports/, blog/, compare/…)  │
                    │  api/*.js  (Stripe checkout, webhook,      │
                    │             catalog + pricing proxies)     │
                    └───────────────┬────────────────────────────┘
                                    │ CATALOG_API_URL
                                    ▼
                    ┌────────────────────────────────────────────┐
                    │ AWS (eu-west-1) — infra/ CDK app           │
                    │  API Lambda   api.aiequityreports.com      │
                    │  Worker Lambda  reconciler + reaper        │
                    │  DynamoDB  Orders + CatalogState           │
                    │  S3 + CloudFront  files.aiequityreports.com│
                    └──────┬───────────────────────┬─────────────┘
                           │                       │
                    pdf-report-engine        Wisdom (financial
                    (Lambda, renders PDFs)    model data) / FMP
```

Roles, in short:

| Layer | Responsibility |
|---|---|
| **Vercel static site** | Everything indexable. Company pages, report landing pages, comparisons, blog, marketing pages. No build step — the HTML is committed. |
| **Vercel functions** (`api/*.js`) | Stripe checkout sessions, the Stripe webhook, post-payment download links, and thin proxies to the AWS catalog/pricing/search APIs. |
| **AWS API Lambda** (`server/lambda/api.js`) | Public catalog reads, purchase sync from the webhook, Wisdom company search, Stripe pricing, and the admin CRUD routes. |
| **AWS Worker Lambda** (`server/lambda/worker.js`) | The reconciler (fresh-order state machine) on a 5-minute sweep plus push invocations, and the daily reaper. |
| **`server/index.js`** | The legacy always-on Express app that used to run under PM2 on `files.valuatum.com`. Kept for local development; production is the Lambdas. |

The AWS backend replaced an EC2 box in July 2026 — see
[`docs/aws-migration-plan.md`](docs/aws-migration-plan.md) for the full design
and the cutover procedure.

---

## Repository layout

```
.
├── index.html, reports.html, pricing.html, faq.html, …   marketing + catalog pages
├── reports/                 ~1,170 generated company & report pages (committed)
├── compare/                 generated "X vs Y stock comparison" pages
├── blog/, authors/          generated blog articles and author pages
├── checkout/                Stripe success + cancel pages
├── css/, js/, images/       shared front-end assets
│   └── js/companyPagesData.js   catalog of generated company pages (search index)
│
├── api/                     Vercel serverless functions
├── server/                  backend modules (shared by Express and Lambda)
│   ├── lambda/              api.js + worker.js handlers
│   ├── aws/                 DynamoDB / S3 / SSM adapters
│   ├── catalog.js           catalog build, free rotation, purchase ledger
│   ├── reconciler.js        fresh-order state machine
│   ├── reaper.js            resale-window retirement
│   ├── engine-client.js     pdf-report-engine calls (SigV4)
│   ├── search.js            Wisdom company search proxy
│   ├── stripe-pricing.js    price lookup from Stripe products
│   └── email.js             SES delivery + admin notifications
│
├── infra/                   AWS CDK app (TypeScript) — see infra/README.md
├── scripts/                 static page generators
├── report-content/          extracted report data (JSON) → report landing pages
├── company-content/         cached AI company profiles → company pages
├── blog-content/            article JSON + publish ledger
├── blog-system/             blog pipeline design, prompts, topic queue, authors
├── docs/                    architecture and lifecycle documentation
├── test/                    node:test suites
└── mockups/                 design mockups, not published
```

---

## Getting started

Requirements: **Node.js 20+**.

```bash
npm install
```

### Run the site locally

The site is plain static HTML — any static server works:

```bash
npx serve -l 5173 .        # http://localhost:5173
```

Front-end calls to `/api/*` are not served this way. To exercise them, run the
Vercel dev server instead (`vercel dev`), or point the page at a deployed API.

### Run the legacy Express backend locally

```bash
cd server
npm install
cp .env.example .env       # fill in the values you need
node index.js              # http://localhost:3001
```

Without `ORDERS_TABLE` / `REPORT_PDF_BUCKET` set, the backend uses local JSON
files (`server/data/`) and a local PDF directory instead of DynamoDB and S3, so
it runs without AWS credentials for catalog work. Note that delivery of a fresh
report deliberately has **no** local-disk path: `deliver()` fails loudly if
`REPORT_PDF_BUCKET` is unset.

---

## Environment variables

Two `.env.example` files document the full set:

- [`.env.example`](.env.example) — what Vercel needs (Stripe keys, SES, the
  catalog API URL and sync secret, plus the local generator settings).
- [`server/.env.example`](server/.env.example) — the backend's full surface,
  annotated per subsystem.

The ones worth knowing:

| Variable | Meaning |
|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe credentials. |
| `STRIPE_READY_REPORT_PRODUCT_ID`, `STRIPE_FRESH_REPORT_PRODUCT_ID` | **Pricing lives in Stripe.** The app reads each product's current default Price; changing it in Stripe changes checkout and displayed prices after cache expiry. |
| `CATALOG_API_URL` | Backend base URL the Vercel functions call (`https://api.aiequityreports.com`). Flipping this is the migration rollback switch. |
| `CATALOG_SYNC_SECRET` | Bearer shared between the Vercel webhook and `POST /api/report-purchases`. |
| `WISDOM_API_TOKEN` | Server-side token for company search and the page generator. |
| `PDF_ENGINE_URL` + `AWS_INVOKER_*` | pdf-report-engine Function URL and the keys used to SigV4-sign calls to it. |
| `FRESH_IMPORT_ENABLED`, `RESALE_ENABLED`, `REAPER_DRY_RUN` | Feature flags for the FMP import step, resale of generated reports, and the reaper's safety mode. |
| `REPORT_VISIBLE_AFTER_DAYS`, `REPORT_FREE_*` | Catalog visibility and free-rotation rules. |

In AWS, secrets come from SSM Parameter Store (`/aiequityreports/<stage>/…`),
loaded at cold start by `server/aws/secrets.js`. Everything else is set on the
Lambdas by CDK.

---

## The report catalog

The catalog is built from the PDF store: each `reports/pdfs/<Name>_<ddmmyyyy>.pdf`
may have a `<same-name>.json` **sidecar** carrying its metadata. State that isn't
a property of the file — purchases, the weekly free rotation — lives in the
`AiEquityReportsCatalogState` DynamoDB table.

Visibility and price are separate concerns, spelled out in
[`docs/report-lifecycle.md`](docs/report-lifecycle.md):

- **Publication status** — `ready` (public), `hidden` (exists but not public;
  the default for a newly delivered customer report), `archived`, `expired`.
- **Access status** — ready reports are either `free` (direct PDF download) or
  `paid` (checkout).

Consumer rules follow from that: the reports catalog, company pages, checkout,
sitemap and related-report links all take only `ready` entries, and free
rotation picks only from `ready` reports. `forceFree: true` pins a curated
sample into the free tier; `excludeFromFree: true` keeps a report out of it.

The free rotation is a **deterministic seeded hash of the ISO week plus the
report ids**, so concurrent readers agree without writing; the worker records
the week's selection with a conditional put for the repeat-cooldown history.

---

## Order flows

### Ready report (PDF already exists)

1. `reports.html` loads `/api/reports` and renders the catalog.
2. Buy → `api/create-checkout.js` verifies the report is `ready` + `paid`,
   reads the current Stripe price, and creates a Checkout Session.
3. Stripe redirects to `checkout/success.html`, which calls
   `api/get-report-link.js` to exchange the session id for the PDF URL.
4. `api/webhook.js` records the purchase via `POST /api/report-purchases` and
   emails the report.

### Fresh report (generated on demand)

1. The company picker calls `/api/search-companies` (Wisdom proxy).
2. `api/create-fresh-checkout.js` creates a Checkout Session carrying the
   company, ticker and email in metadata.
3. The webhook posts the order to the backend, which enqueues it and
   async-invokes the worker.
4. The reconciler walks the state machine:

   ```
   NEW ──(FRESH_IMPORT_ENABLED)──▶ IMPORTING ──▶ RENDERING ──poll──▶ DELIVERED
                                                              └────▶ FAILED
   ```

   `IMPORTING` pulls fresh FMP data into Wisdom (up to ~6 min); `RENDERING`
   submits the job to pdf-report-engine and polls it (~20 s inside one
   invocation, then across sweeps, bounded by `RECONCILER_MAX_POLLS`).
5. Delivery uploads the PDF and a sidecar to S3 and emails the buyer. The new
   report starts `hidden` + `excludeFromFree`, or `ready` + `paid` when
   `RESALE_ENABLED` is on.
6. The **reaper** ends a resale window once the report passes
   `RESALE_WINDOW_DAYS`. It never deletes: it rewrites the sidecar to `hidden`,
   so every link already emailed keeps working. It only touches reports whose
   sidecar carries reconciler provenance, and `REAPER_DRY_RUN` (default `true`)
   logs its targets without writing.

Admin is emailed on every failure, and on success when
`ADMIN_NOTIFY_ON_SUCCESS` is set.

---

## Static page generators

All generated HTML is **committed** — there is no build step on Vercel. Run a
generator locally, review the diff, commit.

The generators that touch the catalog fetch it live from
`https://www.aiequityreports.com/api/reports` (`scripts/live-catalog.mjs`).
There is deliberately no local-snapshot fallback and any fetch error is fatal —
building from a stale snapshot once served outdated pages for weeks.

### Company pages — `npm run generate:companies -- TICKER…`

Builds `reports/<company>-equity-report.html` from Wisdom financial model data
plus a cached one-paragraph AI profile (`company-content/profiles/`). Financial
data is refetched every run; only the profile text is cached.

```bash
npm run generate:companies -- FORTUM NOKIA KESKOB UPM WRT1V
npm run generate:companies -- --refresh-ai FORTUM     # regenerate profile text
npm run generate:companies -- --skip-ai FORTUM        # no AI calls at all
```

Needs `WISDOM_API_BASE` + `WISDOM_API_TOKEN`, and an authenticated Codex CLI
when profiles aren't cached. After a successful run it also updates
`js/companyPagesData.js` and `sitemap.xml` so search and discovery stay in
sync. Full details, including model-selection rules, in
[`docs/company-page-generator.md`](docs/company-page-generator.md).

### Report landing pages — `node scripts/build-report-pages.mjs`

Builds indexable pages from `report-content/*.json`. Free reports expose the
full analysis (maximum SEO surface); paid reports expose a citable teaser plus a
buy gate. Also writes `js/reportSlugs.js` and `scripts/sitemap-fragment.xml`.

> Both generators write to `reports/<slug>.html`. For a company that has both a
> profile and extracted report content, whichever generator ran last owns the
> file — re-run the report-page build after a company-page sweep if you want the
> full report page to win.

### Comparison pages — `node scripts/build-comparison-pages.mjs`

Generates "X vs Y stock comparison" pages for every same-sector pair with
extracted report content. Fully templated and data-only, so it scales.

### Blog pages — `node scripts/build-blog-pages.mjs`

Renders `blog-content/*.json` into `blog/`, regenerates the `blog.html` index,
and renders author boxes with Person schema. **Hard-fails** if an article
references an author with TODO fields, a missing photo, or a missing LinkedIn
URL — no article ships without a real, named author.

### Validation — `npm run validate:jsonld`

Parses every `<script type="application/ld+json">` block in every HTML file and
fails on the first invalid one.

---

## Blog pipeline

An automated, human-approved content pipeline lives in `blog-system/`, driven by
a Claude Code agent from [`.github/workflows/blog-pipeline.yml`](.github/workflows/blog-pipeline.yml)
(Mon/Wed/Fri 21:30 Europe/Helsinki, plus a Sunday topic-proposal run).

Per run: sync state → refresh check → topic selection → brief → draft →
critique/humanize → fact-check → lint + build → **open a PR**.

Two rules matter most:

- **Human merge only, no exceptions, no timeout.** The pipeline never merges a
  blog PR, however green its gates are. Passing gates are a precondition for
  review, not a substitute for it.
- **Gates are hard.** Zero unverified numeric claims; ≥3 external sources with
  ≥1 primary; a humanizer score ≥40/50; on-page SEO lint.

Topics are human-approved by flipping an entry in `blog-system/topic-queue.json`
to `"queued"`; if nobody picks within 48 hours the agent auto-promotes the
highest-scoring proposal and says so in the PR.
See [`blog-system/PIPELINE.md`](blog-system/PIPELINE.md) for the runbook and
`DESIGN.md` for the rationale.

---

## Admin pages

- **`/admin`** (`admin/index.html`) — the admin dashboard: report catalog
  management (upload, publish, edit including free status, delete) plus the
  members side — analyst publications, users, earnings and payouts, activity
  stats, and live promo codes. One password (`admin-upload-password`, kept in
  `localStorage`) unlocks both APIs. To point it at the test stage:
  `localStorage.setItem('aerAdminApiBase', 'https://api-test.aiequityreports.com')` and
  `localStorage.setItem('aerAdminMembersApiBase', 'https://members-test.aiequityreports.com')`.
- **`/blog-admin.html`** — the older blog admin, which authenticates through
  `api/auth.js` and works against the GitHub API. Renamed from `admin.html`,
  which read as the site's main admin while sitting next to `/admin`.

Both are `noindex` and disallowed in `robots.txt`.

---

## Tests

`node:test`, no network access or credentials required — Wisdom and catalog
responses are supplied in memory.

```bash
npm run test:api             # Vercel function handlers
npm run test:catalog         # catalog client, lifecycle rules, PDF URLs
npm run test:reaper          # resale-window retirement
npm run test:company-pages   # generator, normalization, Wisdom client
npm run validate:jsonld      # structured-data sanity check
```

---

## Deployment

### Website (Vercel)

Push to `main`. Vercel serves the repo as-is — `vercel.json` sets no build
command and carries the legacy URL redirects; `.vercelignore` keeps generator
inputs, docs and tests out of the deployment.

### Backend (AWS CDK)

```bash
cd infra && npm install
npm run deploy:test    # cdk deploy -c stage=test --all
npm run deploy:prod
```

Five stacks: `AiEquityReportsUsEast1` (CloudFront cert + health check),
`…Storage` (S3 + DynamoDB + SNS), `…Worker`, `…Api`, `…Files` (CloudFront over
the private PDF bucket). DNS is Route53 in the same account, so records and ACM
validation are fully CDK-managed. Secrets are created once per stage by hand as
SSM SecureStrings. See [`infra/README.md`](infra/README.md) for first-time
setup, context values and the migration scripts.

> Discuss and get approval before deploying infrastructure or environment
> changes to production.

---

## Further reading

| Document | What it covers |
|---|---|
| [`docs/aws-migration-plan.md`](docs/aws-migration-plan.md) | Full backend architecture, why each choice was made, and the cutover/rollback plan. |
| [`docs/report-lifecycle.md`](docs/report-lifecycle.md) | The publication/access status contract every consumer follows. |
| [`docs/company-page-generator.md`](docs/company-page-generator.md) | Company page generation, selection rules, options. |
| [`infra/README.md`](infra/README.md) | CDK stacks, secrets, deploy commands, one-time migration. |
| [`blog-system/PIPELINE.md`](blog-system/PIPELINE.md) / [`DESIGN.md`](blog-system/DESIGN.md) | Blog pipeline runbook and design. |
| [`ai_equity_report_website_prd.md`](ai_equity_report_website_prd.md) | The original product requirements document. |
| [`docs/seo-generated-files.md`](docs/seo-generated-files.md) | Which SEO files are generated, from what, and how to regenerate them. |
| [`llms.txt`](llms.txt) | Machine-readable site summary for AI answer engines &mdash; generated, never hand-edited. |

---

All published report content is AI-generated research for informational
purposes only, and is not investment advice — see
[`disclaimer.html`](disclaimer.html).
