# Forecast revisions

Supersedes an earlier version of this document, which planned a manual
forecast-editing grid backed by a local Trunk REST client and a local AI
proposal-interpreter (`server/estimates.js` + `server/estimate-interpreter.js`,
commit `07e853f`). That approach is abandoned: per
`../ai-stock-analysis/HANDOFF.md`, customers no longer edit forecast numbers
by hand at all, even in the internal tool this was copied from. They write a
free-text request; an AI analyst interprets it and updates the forecast, with
no approval step. The report engine we already call directly
(`server/engine-client.js`) implements exactly that natively — see
`../pdf-report-engine/docs/api.md`, `POST /jobs/{jobId}/revisions` with
`scope: "estimates"`. There is no local Trunk client, no local interpreter,
and no proposal-review UI to build.

## What this is

A paid add-on tier, sold alongside both purchase paths:

- **Standard** — today's flow, unchanged. No revisions.
- **+ Revisions** — the same report, plus **N included forecast-revision
  requests** (`REPORT_REVISIONS_INCLUDED`), submitted as free text after
  delivery, on a durable emailed order-page link. Each request calls the
  engine's `scope: "estimates"` revision endpoint, which decides what (if
  anything) to change and regenerates the report — target price, multiples,
  financial tables and change memo included.

Ready-report purchases can only offer this where the underlying engine
`jobId` is known — see `revisable` below. Manually-uploaded catalog reports
have no jobId and cannot be revised until one is attached to them.

## Order states

```
Fresh, standard:      NEW → IMPORTING → RENDERING → DELIVERED | FAILED
Fresh, + revisions:   same, then DELIVERED ⇄ REVISING (0..N times)
Ready, standard:      no order row — Stripe-session-gated download only
Ready, + revisions:   an order row created directly in DELIVERED
                       (jobId/pdfFileName copied from the catalog entry),
                       then DELIVERED ⇄ REVISING same as fresh
```

`REVISING` submits `engine.submitRevision({ parentJobId: order.jobId,
comments })`. The returned job id is stashed on a separate `revisionJobId`
field — `order.jobId` keeps pointing at the last *delivered* job throughout
polling. A `FAILED` revision reverts to `DELIVERED` with `revisionError` set,
`jobId` untouched (so the next attempt still has a valid, DONE parent to
revise from) and `revisionJobId` cleared; it does not consume the customer's
allowance. Retries within one revision request are bounded by a
`revisionAttempts` counter, separate from the generation path's `attempts` —
exhausting it reverts to `DELIVERED`, never to the terminal `FAILED` an
already-delivered order must not be able to reach. On success, `jobId`
becomes the new job and `revisionsUsed` increments.

Delivering a revision (`deliverRevision` in `server/reconciler.js`) never
overwrites `order.pdfFileName` in place: for a ready-origin order that name
is the *shared public catalog file*, and even a resold fresh-origin report
must not have its public copy silently replaced by one customer's requested
scenario. Every revision is downloaded into its own file (suffixed with the
order id) and its sidecar is always written `hidden: true` — a forecast
revision reflects one customer's scenario, never the analyst's base case, so
it never enters resale or free rotation.

## `revisable`

`server/catalog.js` (`buildRawReports`) surfaces `revisable:
Boolean(meta.provenance?.jobId)` on every catalog report, computed from the
sidecar `provenance` field `server/reconciler.js` already writes on every
delivery. The raw `jobId` is never sent to the browser. The "+ Revisions"
purchase button only renders when `revisable` is true, and
`api/create-checkout.js` re-checks it server-side before creating the
Stripe session — the client's button state is never trusted alone. A
ready+revisions order row is seeded straight into `DELIVERED` by
`POST /api/report-purchases` (`server/lambda/api.js`), which reads the raw
jobId from the sidecar itself — the raw id never leaves the AWS backend.

## Routes

- `GET /api/orders/{id}` / `POST /api/orders/{id}/revisions` —
  `server/lambda/api.js`, same `CATALOG_SYNC_SECRET` bearer as
  `/api/report-download`. The POST route is the only mutating order-page
  call: it conditionally claims `DELIVERED -> REVISING` via
  `ordersStore.claimRevision`, so a double-submit 409s instead of starting
  two revision jobs.
- `api/order-status.js` / `api/order-revision.js` — Vercel proxies. The
  Stripe checkout session id (== the order id) is the bearer, verified
  against Stripe before either AWS route is called.
- `/order/index.html` + `js/order-page.js` — the durable, emailable order
  page. Polls order status while pending, shows the PDF + a revision
  textarea once `DELIVERED` with revisions remaining, shows progress while
  `REVISING`.

## Config

- `FORECAST_REVISIONS_ENABLED` — master flag, ships `false`. Also gates
  whether `getPublicPricing` (`server/stripe-pricing.js`) exposes the
  revisions price tiers at all, which is what the `reports.html` checkbox
  keys off to show/hide itself.
- `REPORT_REVISIONS_INCLUDED` — how many revisions the "+ Revisions" tier
  includes (read independently by `api/create-fresh-checkout.js`,
  `api/create-checkout.js`, and `server/stripe-pricing.js` — keep them in
  sync if it changes).
- `STRIPE_{READY,FRESH}_REPORT_REVISIONS_{PRODUCT,PRICE}_ID` — the two new
  Stripe price kinds in `server/stripe-pricing.js`. Unlike the existing
  `ready`/`fresh` kinds, these have no fallback unit amount: a misconfigured
  paid tier fails loudly instead of selling at a guessed price.

## Known gaps

- No buy-button UI on the ready/catalog report pages yet (the hundreds of
  pre-generated static `reports/*.html` pages and the `reports.html` catalog
  cards) — the backend fully supports a ready+revisions purchase, but
  nothing currently links to `api/create-checkout.js` with `withRevisions:
  true`. Needs a look at the report-page generator
  (`scripts/report-pages/`) rather than a client-side patch, since these
  pages are pre-baked.
- `server/index.js` (the local/legacy Express server being phased out per
  `docs/aws-migration-plan.md`) was not updated — `api/webhook.js` (Vercel,
  the actual production webhook target) and `server/lambda/api.js` (AWS,
  the actual production API) are.
- Real Stripe products/prices for the two revisions tiers, and the actual
  included-revision count and price delta, are not set — `.env`/SSM changes,
  needs your sign-off before deploying per usual.
