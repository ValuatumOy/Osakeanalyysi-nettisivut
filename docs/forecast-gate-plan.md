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

A paid add-on tier, sold alongside every purchase path:

- **Standard** — today's flow, unchanged. No revisions.
- **+ Revisions** — the same report, plus **N included forecast-revision
  requests** (`REPORT_REVISIONS_INCLUDED`), submitted as free text after
  delivery, on a durable emailed order-page link. Each request calls the
  engine's `scope: "estimates"` revision endpoint, which decides what (if
  anything) to change and regenerates the report — target price, multiples,
  financial tables and change memo included.
- **Free report + Revisions** — a report in the free rotation has no base
  price, so the buyer pays for the N revisions alone (Stripe kind
  `free-revisions`, €10 for 3). It goes through exactly the ready-report
  path: `api/create-checkout.js` with `withRevisions: true`, the same
  webhook, the same order row seeded at `DELIVERED`, the same order page.
  A free report without revisions is still not purchasable at all.
- **Extra revision rounds** — an order that has run out buys more from
  either door (the anonymous order page or the members area). Both go
  through `createExtraRoundsCheckout` in `server/checkout.js` and price
  from the one Stripe kind `extra-revision`, so the two doors cannot quote
  different numbers. `EXTRA_REVISION_EUR` is only the fallback until the
  product exists.

Ready and free reports can only offer this where the underlying engine
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
Free, + revisions:    identical to ready + revisions; only the price differs
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

## One checkout module

Every Checkout Session the report shop creates is built in
`server/checkout.js`: `createReadyReportCheckout` (standard, ready +
revisions, free + revisions — it picks the price kind from the report and
refuses the impossible combinations with a `CheckoutError` the HTTP layer
passes through), `createFreshReportCheckout`, and
`createExtraRoundsCheckout`. `isCompletedCheckout`, `siteUrl` and
`orderPageUrl` live there too. The Vercel functions under `api/` and the
members Lambda's extra-rounds door both call it; neither builds a line item
or reads a price env var on its own.
The included-revision count comes from `revisionsIncluded()` in
`server/stripe-pricing.js`, likewise read nowhere else.

The members Lambda still builds its own subscription, top-up, analysis-sale
and fork sessions; those are member products, not report-shop ones, and
were left as they are.

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
- `REPORT_REVISIONS_INCLUDED` — how many revisions every "+ Revisions"
  tier includes. Read once, by `revisionsIncluded()`.
- Stripe kinds `ready-revisions`, `fresh-revisions`, `free-revisions` and
  `extra-revision` in `server/stripe-pricing.js`. Each is found by the
  `kind` metadata tag on its Product, which `scripts/stripe-setup-revisions.mjs`
  sets (test mode by default, `--live` for the live account).
  `STRIPE_{READY,FRESH,FREE}_REPORT_REVISIONS_{PRODUCT,PRICE}_ID` and
  `STRIPE_EXTRA_REVISION_{PRODUCT,PRICE}_ID` override the lookup. The three
  "+ Revisions" kinds have no fallback unit amount: a misconfigured paid
  tier fails loudly instead of selling at a guessed price. `extra-revision`
  falls back to `EXTRA_REVISION_EUR` so rounds stay on sale before the
  product exists.

## Free-report buttons

The page generator (`scripts/report-pages/render.mjs`) bakes an
"Add revisions" button next to every free report's download link — in the
page hero, the download section and the catalog card — only when the
catalog says the report is `revisable`. The button ships `hidden`;
`js/script.js` reveals it, with the live count and price, once
`/api/pricing` reports the `freeRevisions` tier, and sends it straight to
`api/create-checkout.js` with `withRevisions: true`. There is no
standard-or-plus modal for a free report: the report is already free, so
the button is the whole offer.

## Known gaps

- Two Stripe webhooks still each receive every checkout event and pick
  their share by metadata: `api/webhook.js` (report purchases) and the
  members Lambda's `/billing/webhook` (subscriptions, top-ups, sales, and
  the `extraRevisions` credit that the anonymous order page's rounds
  purchase also relies on). Merging them means moving the crediting write
  and re-pointing a Stripe endpoint — an infra change, not done here.
- The live Stripe products for `free-revisions` and `extra-revision` do not
  exist yet; run `scripts/stripe-setup-revisions.mjs --live` once approved.
  The pricing page does not mention any revision tier.
