# Plan: moving the report backend from files.valuatum.com to AWS (CDK)

> **Status (2026-09-02): complete.** The migration shipped in July 2026 and
> the box is decommissioned. `server/index.js`, its nginx snippet and its own
> `package.json` were deleted; the duplicate Stripe routes went with them, and
> every Checkout Session the shop opens is now built in `server/checkout.js`.
> The rest of this document is the plan as it was executed, kept for the
> design rationale.

Decisions locked in (2026-07-30): same AWS account as pdf-report-engine; PDFs move
to S3; light admin upload page at `www.aiequityreports.com/admin`; no
backwards-compatibility for old PDF links; all CDK constructs named
`AiEquityReports…`; Wisdom/FMP permission fix handled separately; **JSON ledgers
move to DynamoDB** (not S3 — see §2.2.1); **provisioned concurrency 1 on the API
Lambda in prod** (interactive company search must not eat cold starts); admin
page is full add/edit/delete with a shared password kept in localStorage (§4);
aiequityreports.com DNS is **Route53 in this account** — records + ACM
validation fully CDK-managed.

Scope: the Node/Express process currently running under PM2 on files.valuatum.com
(`server/` in this repo). Everything else stays where it is:

| Component | Stays put |
|---|---|
| Static site + serverless functions (`api/*.js`) | Vercel (`www.aiequityreports.com`) |
| Stripe webhook endpoint | Vercel (`api/webhook.js`) — Stripe config does not change |
| PDF rendering engine | AWS Lambda (`pdf-report-engine`, already in AWS) |
| Company data + FMP import endpoint | Wisdom (Java) — permission bug fixed separately |
| Email | AWS SES (already AWS; only the caller moves) |

## 1. What actually has to move

Live responsibilities of the Express process (`server/index.js`):

1. **Catalog API** — `GET /api/reports`, `GET /api/reports/:id`. Built by scanning the
   PDF directory + JSON sidecars, merged with rotation/purchase state.
2. **Purchase sync** — `POST /api/report-purchases` (bearer `CATALOG_SYNC_SECRET`,
   called by the Vercel webhook). Writes the purchase ledger; fresh orders also
   enqueue a generation order.
3. **Wisdom search proxy** — `GET /api/search-companies` (keeps `WISDOM_API_TOKEN` server-side).
4. **Stripe pricing** — `GET /api/pricing`.
5. **Reconciler** — order state machine NEW → IMPORTING (FMP→Wisdom import,
   ≤ ~6 min) → RENDERING (submit + poll engine Lambda) → deliver (download PDF,
   publish PDF+sidecar to the catalog, SES email).
6. **Reaper** (Phase-2 resale retention) — deletes expired auto-generated PDFs.
7. **State on local disk** — `server/data/orders.json` (order queue),
   `server/data/catalog-state.json` (purchase ledger + weekly free rotation) —
   both move to DynamoDB (§2.2.1).
8. **PDF hosting** — moves to S3 (§3).

Explicitly **not** migrated: the duplicate Stripe routes in `server/index.js`
(`/api/create-checkout`, `/api/webhook`, `/api/get-report-link`) — production uses the
Vercel copies; the duplicates are dead code and get deleted during decommission.

## 2. Architecture (serverless, matching pdf-report-engine conventions)

New `infra/` directory in this repo: TypeScript CDK app, `eu-west-1`, same AWS
account as pdf-report-engine, `prod`/`test` stages selected with `-c stage=test`
(suffix pattern). **Every stack and construct is prefixed `AiEquityReports`.**

**Stacks:**

- **`AiEquityReportsStorage`**
  - S3 **PDF bucket** `aiequityreports-pdfs` — the catalog: `reports/pdfs/<Name>_<ddmmyyyy>.pdf`
    + sidecar JSONs, same flat layout as today so `catalog.js` logic carries over.
  - DynamoDB tables (on-demand, `-test` suffix in the test stage):
    - **`AiEquityReportsOrders`** — the order ledger (replaces `orders.json`).
    - **`AiEquityReportsCatalogState`** — purchase ledger + weekly free rotation
      (replaces `catalog-state.json`).
  - SNS alerts topic (email subscription → admin).
- **`AiEquityReportsApi`** — one NodejsFunction behind an **API Gateway HTTP API**
  with custom domain `api.aiequityreports.com`. aiequityreports.com is
  registered and hosted on **Route53 in this same account**, so CDK creates the
  record and DNS-validates the ACM cert directly against the hosted zone —
  no manual DNS step anywhere. **Provisioned
  concurrency 1 in prod** (published version + alias; none in test): the
  company-search picker is interactive and must not pay cold starts. Routes
  reuse the existing `server/` modules the way the Vercel `api/*.js` functions
  already do:
  - `GET /api/reports`, `GET /api/reports/:id`, `GET /api/pricing`,
    `GET /api/search-companies`, `GET /api/health`
  - `POST /api/report-purchases` (bearer `CATALOG_SYNC_SECRET`)
  - Admin routes (§4, all bearer `ADMIN_UPLOAD_PASSWORD`, throttled):
    `GET /api/admin/reports` (catalog incl. hidden + per-report buyer count),
    `POST /api/admin/upload-url`, `POST /api/admin/publish`,
    `POST /api/admin/update`, `POST /api/admin/delete`
- **`AiEquityReportsWorker`** — reconciler NodejsFunction, **event-driven with a
  scheduled backstop** (§2.1): invoked async on new fresh orders, plus an
  EventBridge `rate(5 minutes)` sweep. Timeout 10 min, reserved concurrency 1
  (replaces the in-process single-flight guard). Reaper runs in the same
  function on a daily rule. CloudWatch log groups, 1-month retention.

### 2.1 Worker cadence — why not every minute

The 1-minute tick was an artifact of the always-on process, and even there it
mostly no-ops. Replaced with:

- **Push**: when `POST /api/report-purchases` enqueues a fresh order, the API
  Lambda async-invokes the worker immediately → generation starts in seconds,
  not "next tick". (If the worker is already busy, the async invoke is
  throttled by reserved concurrency 1 and sits in Lambda's async retry queue —
  that's fine and intentional; the sweep covers the worst case. Don't "fix" it.)
- **Backstop sweep**: EventBridge `rate(5 minutes)` calls the same `tick()`.
  This is what retries after a crashed invocation and catches any lost event.
  A tick with an empty queue is one DynamoDB query.
- **RENDERING polls loop inside one invocation**: instead of one `getJob` poll
  per tick (30+ min of wall clock at 5-min cadence), the worker polls every
  ~20 s within its 10-min timeout, then leaves the order RENDERING for the next
  sweep if the render still isn't done. `RECONCILER_MAX_POLLS` bounds total
  polls so the overall render timeout window stays ~30 min.

Cost was never the issue (a 1-min schedule is ~$0); the 5-min sweep is purely
less noise in logs. Delivery latency impact: none for the happy path (push),
≤ 5 min added on recovery paths — fine against the "within ~30 minutes" promise.

### 2.2 Code changes (small, centralized)

1. **State layer → DynamoDB** (§2.2.1 for schema and why-not-S3).
   `loadState`/`saveState`/`recordCatalogPurchase` (`server/catalog.js`) and
   `orders.js` swap `fs` for the DocumentClient. `GET /api/reports` becomes
   **read-only** (`persistState: false` semantics): the weekly free selection
   is a deterministic seeded hash of week + report ids, so concurrent readers
   agree without persisting; the week's selection is *recorded* (for the
   repeat-cooldown history) with a conditional put — first writer wins,
   attribute_not_exists — from the worker tick.
2. **Catalog listing → S3.** The directory-scan in `catalog.js` becomes
   `ListObjectsV2` on `reports/pdfs/`; sidecars read via GetObject.
   Drop absolute `pdfUrl` values from sidecars — derive as
   `REPORT_PDF_BASE_URL + fileName` (the code already supports this env),
   so files never carry a hostname again. One-time cleanup of existing
   sidecars during the copy — and in the same pass **stamp each sidecar with
   `uploadedAt` from the current file's mtime**: the S3 copy resets
   LastModified to copy time, and without the stamp `availableAt =
   max(reportDate, uploadedAt) + visibleAfterDays` would hide every report
   without an explicit date for 5 days after cutover.
3. **IAM roles replace static keys** (same account): worker role gets
   `lambda:InvokeFunctionUrl` on the engine (sign with role creds via
   aws4fetch + session token) and `ses:SendEmail`; both roles get scoped
   `dynamodb:*Item`/`Query` on the two tables; `AWS_INVOKER_*` and the SES
   key pair are deleted.
4. **Secrets → SSM Parameter Store** (SecureString): `STRIPE_SECRET_KEY`,
   `CATALOG_SYNC_SECRET`, `WISDOM_API_TOKEN`, `FMP_IMPORT_TOKEN`,
   `ADMIN_UPLOAD_PASSWORD`. Everything else is plain Lambda env set by CDK.
   This finally gives the env vars one documented home (today: an undocumented
   `.env` on the box; `.env.example` is missing 8 vars the code reads).
5. **Delivery idempotency marker.** If the worker dies between the buyer email
   and the DELIVERED update (`reconciler.js` `deliver()`), a retry re-emails.
   Set `deliveredEmailAt` on the order *before* sending and skip the email on
   retry — Lambda timeouts make mid-flight death likelier than under PM2.

### 2.2.1 Ledgers → DynamoDB (decided 2026-07-30)

Why not JSON-in-S3: the current files are safe only because every access is a
synchronous read-modify-write inside one single-threaded process (the argument
documented at the top of `server/orders.js`). Split across an API Lambda and a
worker Lambda, that argument dies: a webhook `orders.create` racing a worker
`orders.update` on one `orders.json` object silently loses one of the writes —
worst case a **paid order disappears**. Same race on `catalog-state.json`,
where today even `GET /api/reports` writes state. Reserved concurrency 1 only
serializes the worker against itself. DynamoDB gives per-item writes and
conditional puts, which removes the whole class.

- **`AiEquityReportsOrders`** — PK `orderId` (S, = Stripe checkout session id).
  Attributes = the existing order row verbatim (status, ticker, jobId, polls,
  attempts, timestamps…). `create` → PutItem with
  `attribute_not_exists(orderId)` (idempotent on webhook redelivery, as today);
  `update` → UpdateItem. `listPending` → Scan with a status filter — the table
  holds tens of rows, a GSI is not worth it.
- **`AiEquityReportsCatalogState`** — PK `pk` (S), two item kinds:
  - `PURCHASE#<sessionId>` — the purchase row, plus a TTL attribute at
    purchasedAt + 366 days (replaces the manual prune-and-cap in
    `recordCatalogPurchase`). Loaded via Scan (small, capped by TTL).
  - `WEEK#<isoWeek>` — the week's free-selection ids. Written once per week
    with `attribute_not_exists(pk)`; deterministic selection means every
    writer computes the same value anyway.

Both tables on-demand billing (~$0 at this volume), point-in-time recovery on
`AiEquityReportsOrders`.

### 2.3 Observability (the main reason for this migration)

- All logs in CloudWatch.
- Alarm: worker Lambda errors ≥ 1 in 15 min → SNS email.
- Alarm: any order FAILED or stuck in NEW/IMPORTING > 30 min — emit a metric
  from `tick()` (2 lines) and alarm on it.
- Route53 health check on `GET /api/health` → SNS (catches "API down" from outside).
- **Companion fix on the Vercel side** (do it regardless of migration):
  `server/catalog-client.js` silently falls back to Vercel's ephemeral disk when
  the purchase sync POST fails — a paid €50 fresh order vanishes with only a
  `console.warn`. Make it loud: retry, then alert + return 500 so Stripe
  retries the webhook.

## 3. PDFs on S3

- **Requirement: download URLs are permanent.** A buyer must be able to reuse
  the emailed link any time later. Therefore: plain, unsigned, stable URLs
  (`https://files.aiequityreports.com/reports/pdfs/<file>.pdf`), no S3
  lifecycle expiry on `reports/pdfs/`, and delivered PDFs are **never deleted
  automatically** (storage at this volume is negligible; the only manual
  exception is the admin delete with its buyer warning, §4).
- **Serving**: CloudFront in front of the private bucket (OAC), domain
  `files.aiequityreports.com` (CloudFront cert in us-east-1; record + cert
  validation in the Route53 hosted zone, managed by CDK). No directory
  listing → the "exact link required" property is the same as today's nginx
  setup; per the accepted threat model there are **no signed URLs** (which
  would also violate the permanence requirement — presigned links expire).
  (Cheapest-possible alternative: a public bucket and raw
  `…s3.eu-west-1.amazonaws.com` URLs — works, but these URLs go into customer
  emails, so the small one-time CloudFront + domain setup is worth it.)
- **Migration**: one-time `aws s3 cp --recursive` of the current folder +
  sidecar `pdfUrl` cleanup. **No 301s / no backwards compatibility** (decided):
  links in already-sent emails die when the box is decommissioned.
- **Reconciler delivery** becomes a plain PutObject.
- **Reaper change (required by URL permanence)**: today `server/reaper.js`
  *deletes* the delivered PDF when the resale window ends — that would break
  the buyer's saved link. Change it to end the resale only: rewrite the
  sidecar to `availability: hidden` (the catalog already supports hidden)
  and leave the PDF object in place. Nothing under `reports/pdfs/` is ever
  deleted by any *automatic* path once a customer has received its URL; the
  single exception is an explicit admin delete on the admin page (§4), which
  shows the buyer count and warns that those links die.

## 4. Admin page — `www.aiequityreports.com/admin`

Replaces the WinSCP workflow. A static page on Vercel (same styling/pattern as
the existing `admin.html`), talking to the AiEquityReportsApi (CORS allows the
site origin). Full report management: **add, edit, delete**.

**Auth (decided 2026-07-30):** one shared password, stored in SSM as
`ADMIN_UPLOAD_PASSWORD` — never hardcoded in the page or repo. The page stores
it in **localStorage** after first entry so admins don't retype it, and sends
it as a bearer on every `/api/admin/*` call. localStorage is readable by any
JS on the site origin (XSS steals it) and persists on shared machines —
accepted: the password guards catalog admin only, blast radius is catalog
vandalism, and two server-side compensations make abuse slow and visible:
- API Gateway throttle on `/api/admin/*` (e.g. 5 req/s, burst 10).
- CloudWatch alarm on repeated 401s → SNS (someone is probing or a stored
  password is being brute-forced from).
A "log out" button that clears localStorage; on any 401 the page clears the
stored value and re-prompts (covers password rotation).

**Add** (the upload flow):
1. Form: PDF file + company name, ticker, exchange, sector, report date, price
   / free flag.
2. `POST /api/admin/upload-url` validates the password, returns a presigned S3
   PUT for the PDF (browser uploads the file straight to S3 — nothing streams
   through the Lambda; the URL is short-lived and pinned to one key).
3. `POST /api/admin/publish` validates again, writes the sidecar JSON generated
   from the form fields.
4. Page shows the resulting catalog entry (re-fetch the list) as confirmation.

**List + edit**: `GET /api/admin/reports` returns the full catalog including
hidden reports (`includeNonPublic`), each report annotated with its **buyer
count** from the purchase ledger. Edit opens the same form pre-filled;
`POST /api/admin/update` rewrites the sidecar fields (price, hidden/visible,
sector, dates…). Hiding a report is the safe way to retire it — it leaves the
PDF and every emailed link working.

**Delete**: `POST /api/admin/delete` removes the PDF + sidecar from S3. This is
the **only** deletion path in the system (§3) and it breaks the permanent-URL
promise for that report, so the confirmation dialog must:
- show the report's buyer count from the purchase ledger and warn
  "N buyers received a permanent link to this PDF — deleting it kills those
  links";
- offer **Hide instead** as the default-highlighted action;
- require typing the report name to confirm an actual delete.

This also kills the hand-edited-sidecar workflow that produced the stale ids
and 404 pdfUrls in the current catalog.

Note the existing `api/auth.js` pattern returns a GitHub PAT to the browser —
we deliberately do **not** copy that; the admin page never receives AWS
credentials, only single-use presigned URLs.

## 5. Migration sequence

**Phase 0 — prerequisites**
- Land `fix/live-catalog-source-of-truth` (+ the generator-collision and
  live-catalog publish decisions). The backend must already be the source of
  truth before it moves.

**Phase 1 — build in `test` stage**
- CDK skeleton (`infra/`), Storage + Api stacks; ledgers on DynamoDB, catalog
  listing on S3; copy of current PDFs into the test bucket (+ sidecar
  `uploadedAt` stamping, §2.2 item 2); one-time import script:
  `orders.json` → `AiEquityReportsOrders`, `catalog-state.json` →
  `AiEquityReportsCatalogState`.
- Parity check: diff `GET /api/reports` between the box and the test stage.

**Phase 2 — worker + admin in `test`**
- Worker Lambda with `FRESH_IMPORT_ENABLED=false` (matching prod today), Stripe
  test mode: one test fresh order end-to-end → order row in DynamoDB, engine
  render, delivery email, PDF + sidecar in the test bucket.
- Admin page against the test API: upload a PDF, verify it appears in the
  catalog; edit it; delete it and verify the buyer-count warning renders.
- Alarms wired and test-fired.

**Phase 3 — cutover (low-traffic window)**
- Freeze uploads; final S3 sync of the PDF folder; re-run the ledger import
  against the prod tables (fresh `orders.json` + `catalog-state.json`).
- DNS already done: the `api.` and `files.` Route53 records are created by the
  prod `cdk deploy` (new subdomains, no traffic until the env flip below).
- Flip Vercel env: `CATALOG_API_URL=https://api.aiequityreports.com`
  (same `CATALOG_SYNC_SECRET` value in SSM). That's the whole cutover — the
  site and Stripe never notice.
- Place one real €20 and one €50 order; watch alarms.
- Rollback = flip `CATALOG_API_URL` back (keep the box's PM2 app running for a
  grace week).

**Phase 4 — decommission**
- Stop the PM2 app; remove the nginx `/api/` proxy block; retire the WinSCP workflow.
- Delete the dead duplicate Stripe routes from `server/index.js`; update
  `.env.example`; document `cdk deploy` in README. (`HANDOFF.md` was deleted
  outright — its Astro/AWS handoff purpose was served.)

## 6. Cost (prod, monthly, rough)

Lambda + API Gateway + EventBridge + DynamoDB (on-demand): cents. S3 +
CloudFront at current volume: < $1. Logs, alarms, Route53 health check: ~$2.
Provisioned concurrency 1 on the API Lambda: ~$3–5 depending on memory size
(prod only). **Total ~$6–10/month** (vs the Fargate-container alternative at
~$30–35 — rejected: more cost and VPC plumbing to save half a day of
state-layer work).

## 7. Remaining open points

- **Uploader hand-over**: short screenshot guide for the admin page; confirm
  with the uploaders before decommissioning WinSCP access.
- **Wisdom/FMP** permission bug is out of scope here (owned separately), but
  note the new FAILED/stuck-order alarm will finally make its failures visible.
- **Free-rotation continuity**: after cutover verify the same reports stay free
  (`catalog-state.json` free selections are imported as `WEEK#` items as-is,
  so they should).
- **Stripe as recovery source of truth**: `orders.js` claims a lost ledger can
  be re-derived from `isFresh` checkout sessions, but nothing implements that.
  With DynamoDB + PITR the claim stops being load-bearing; either write the
  small re-derivation script someday or delete the comment during the port.
