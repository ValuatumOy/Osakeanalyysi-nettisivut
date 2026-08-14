# Plan: customer forecast edits and report instructions on a fresh order

Implements the carry-over described in `../ai-stock-analysis/HANDOFF.md` for the
sales site: a buyer of a **fresh** report can review the company's revenue/EBIT
forecasts, change them (by describing the change in plain language, or by hand),
and add written instructions for the report — before the PDF is generated.

The interaction and safety contract is copied from the two existing
implementations:

- `../ai-stock-analysis` — the internal tool. Backend contract, Trunk import
  semantics, validation, magnitude warnings.
- `../Company_valuation_nettisivut` + `../AI-company-valuation-raportti` — the
  customer-facing valuation product. UI shape (description box first, example
  chips, before/after approval table, absolute ↔ percentage grid) and the
  emailed-link model that makes the flow survive a closed tab.

Nothing here changes the **ready report** purchase path.

---

## Decisions taken

| Question | Decision |
|---|---|
| Where the step sits | **Post-payment**, on a durable order page. The forecasts belong to a resolved Valuatum model, which does not exist before checkout. |
| Who gets the gate | **Opt-in**: a checkbox on the `#order-fresh` form. Orders that do not tick it render immediately, exactly as today. |
| How the customer gets back to it | **An emailed link**, as the valuation product does. The order page is the durable home for the gate, live progress, and the finished PDF. |
| AI request length | **10,000 characters.** |
| Auth | The Stripe checkout session id, the same bearer the gated PDF download already uses. |
| Report instructions cap | None beyond the engine's 300 KB `params` limit — see "Report instructions" below. |
| Preview transport | A **dedicated Lambda behind a Function URL**, off the API Gateway path, so the preview gets ~90 s instead of 22 s — see "The 28-second problem" below. |

---

## Target journey

```text
#order-fresh form  ──►  [x] Let me review the forecasts first
        │
        ▼
Stripe checkout (metadata.reviewForecasts = 'true')
        │
        ▼
webhook ──► POST /api/report-purchases ──► order row (NEW, reviewForecasts)
        │
        ▼
worker: resolve fid ──► POST /rest/estimates/generate/{fid} ──► AWAITING_INPUT
        │                                                            │
        │                                    ┌───────────────────────┘
        │                                    ▼
        │                    ✉  "Review your forecasts" email  ──► order page
        ▼
/order/?session_id=…   the durable page: gate, then live progress, then the PDF
        │  GET  order state + current ns/ebit series
        │  POST preview          AI proposal, non-mutating
        │  ── customer approves, fine-tunes the grid, writes instructions ──
        ▼
POST submit  (the only mutating call)
        │
        ▼
worker: POST /rest/estimates/import ──► new fid ──► engine job
        │      (params.fid, params.userComments, params.forecastsReviewed)
        ▼
RENDERING ──► DELIVERED (PDF emailed and published as today; the order page
                         also shows it, so the link stays useful afterwards)
```

A customer who does not opt in keeps today's path exactly: `NEW → RENDERING →
DELIVERED`, no fid resolution, no gate. They still get the order page link, which
for them is just live progress and the finished PDF.

---

## 1. Trunk credentials — verified, with one caveat

`.env` now carries dev-server credentials:

```
WISDOM_API_BASE=https://trunkdev.valuatum.com/rest
WISDOM_API_TOKEN=y2hPxljmZ9smOssZIZ
```

Confirmed working against `trunkdev.valuatum.com`:

| Call | Result |
|---|---|
| `GET /rest/company?ticker=NESTE` | 200 — two entries, `models[].followedModelId` present (`NESTE.HE` → fid 10377) |
| `POST /rest/modeldata` `{fids:[10377], includeHistoryData:true, includeEstimates:true}` | 200 — `currency: EUR`, `currentYear: 2025`, annual `dataMap` 2017–2035 with `ns`/`ebit` |

That is exactly the read side `fetchEstimateSeries` needs, so the gate's display
half is unblocked. `POST /rest/estimates/generate/{fid}` and
`POST /rest/estimates/import` were **not** called — they mutate, so they want
your go-ahead. They are the one remaining access check, and step 1 of the
sequencing below.

**The caveat, and it matters.** These are *dev-server* credentials. The render
side is unaffected by them: `engine.submitJob` sends `aspQueryKey: 'Wisdom'`, and
the engine resolves *its own* provisioned Valuatum credentials from that key —
whichever environment those point at. Per
`../pdf-report-engine/docs/api.md`, `params.fid` has **no fallback**: a fid the
engine's credentials cannot read fails the job, and the job is **not retried**.

So a fid minted on trunkdev is only usable by an engine reading trunkdev. This is
the same hazard already written into `server/.env.example` for the FMP import
("Leave disabled until the endpoint is on the SAME env the engine reads"). Dev
credentials unblock building and end-to-end testing; going live needs the import
to happen on the environment the engine's `Wisdom` key reads. Worth settling
before step 4, not after.

**Naming.** The runtime already uses `WISDOM_REST_BASE` (host only, in
`server/search.js`) while `.env` uses `WISDOM_API_BASE` (host + `/rest`, used by
the local page generators). The estimates module gets its own
`VALUATUM_TRUNK_URL`, defaulting to `WISDOM_REST_BASE`, deliberately: repointing
`WISDOM_REST_BASE` at trunkdev would also repoint the fresh-order **company
search picker**, silently changing which companies customers can buy.

---

## 2. The 28-second problem

The preview is a synchronous LLM call, and the current path caps it hard:

| Hop | Limit |
|---|---|
| Browser → Vercel function | 10 s default; `functions.maxDuration` raises it (60 s Hobby, 300 s Pro) |
| Vercel → API Gateway **HTTP API** | **30 s maximum integration timeout, not adjustable** |
| API Gateway → API Lambda | 28 s (`infra/lib/api-stack.ts:49`) |

The API Gateway HTTP API ceiling is the binding one. (REST APIs can be raised
above 29 s by quota request; HTTP APIs cannot.) Staying on this path means the
interpreter timeout has to *drop* to ~22 s so a slow model still returns a
readable error — the opposite of what we want, and it constrains the model and
reasoning-effort choice.

**Decided: the preview gets its own Lambda behind a Function URL.**

- A dedicated `AiEquityReportsForecastPreview` function, **timeout 120 s**,
  LLM timeout ~90 s. Function URLs are not behind API Gateway and have no 30 s
  ceiling.
- The browser calls it **directly**, so Vercel's `maxDuration` is out of the
  path too. Auth is `authType: NONE` plus the same check everything else uses:
  the Stripe session must be paid, `isFresh`, and its order must be in
  `AWAITING_INPUT`. Nothing reaches the paid model before those pass, and the
  per-order rate limits below bound it further. This is the same "session id is
  the bearer" model as `api/report-download.js`.
- The short calls (read state, submit) stay on the existing API Gateway routes —
  they are well under a second and benefit from the provisioned-concurrency
  warm instance.

That takes the usable budget from 22 s to ~90 s, roughly 4×, and stops the
transport from dictating the model choice. The interpreter still keeps a hard
timeout and a user-actionable error: "substantially longer" must not mean "hangs
forever".

Because the URL is reachable without AWS credentials, the checks in front of the
paid model are the whole security boundary and are worth stating explicitly. In
order, before a single token is spent:

1. `sessionId` must retrieve a real Stripe Checkout Session that is **paid** and
   carries `isFresh`.
2. An order row must exist for it and be in **`AWAITING_INPUT`** — so previews
   are impossible before the gate opens or after the customer has submitted.
3. The per-order rate limits below (20/min, 40 lifetime) must pass, applied as
   conditional updates so they hold across concurrent Lambda instances.

A caller without a paid session id gets a 403 having cost us one Stripe API call
and nothing else. The session id is long and unguessable, and this is the same
bearer `api/report-download.js` already trusts for handing out purchased PDFs.

Two operational guards go with it, since the function is internet-facing:

- **Reserved concurrency** on the preview function (suggest 5). It bounds the
  worst case — a leaked session id, or a bug looping the browser — to a fixed
  spend rate rather than an unbounded one.
- A **CloudWatch alarm** on the function's invocation count, alongside the
  existing `AdminUnauthorized` probing alarm.

---

## 3. Emailed link and the durable order page

This is the part the valuation product already proved out. Its
`send_forecast_ready` carries the reasoning verbatim: *"the link is the whole
point, and without it an opted-in buyer who closes the success page would never
get their report."* Same conclusion here.

### `/order/index.html?session_id=…` (new page)

One page, four states, driven by the order status:

| Order status | Page shows |
|---|---|
| `NEW` / `PREPARING` | "Fetching the current forecasts" progress; polls |
| `AWAITING_INPUT` | **the gate** — description box, proposal panel, grid, instructions, submit |
| `APPLYING` / `RENDERING` | live generation progress ("applying your forecasts", "writing the report") |
| `DELIVERED` | the PDF, via the existing gated download |
| `FAILED` | what went wrong and the support address |

Because the state comes from the order, the same URL is correct at every point
in the order's life — which is what makes it safe to put in an inbox. Reopening
it after submitting shows progress, not a second editable gate.

`checkout/success.html` keeps its job (confirming payment) and links straight
through to the order page for fresh orders.

### Emails

| Email | When | Sent by |
|---|---|---|
| Order confirmed (existing, `sendFreshConfirmEmail`) | at payment | Vercel webhook |
| **Review your forecasts** (new) | when the order reaches `AWAITING_INPUT` | **the worker** |
| Report delivered (existing, `sendReportEmail`) | at delivery | worker |

The forecast email has to come from the worker, not the webhook: at webhook time
no model has been resolved, so there is nothing to review yet. For opted-in
orders the confirmation email's copy changes — no 30-minute promise, instead
"we're preparing your forecasts, you'll get a link in a minute". Every email
carries the order-page link.

Sending is best-effort in the same sense the existing confirmation email is: a
failed send is logged and alerted, never fatal to the order.

---

## Order state machine

`server/aws/orders-store.js` gains three statuses:

```
NEW ─┬─ (no opt-in) ───────────────────────────────► RENDERING ► DELIVERED
     └─ PREPARING ► AWAITING_INPUT ► APPLYING ─────► RENDERING ► DELIVERED
                          ▲               │
                          └── import failed (retryable, gateError set)
```

- **PREPARING** — the worker resolves the followed model for the ticker and runs
  Trunk estimate generation on it. Blocking, ~1–5 min, same shape as today's FMP
  import step. On success it sends the forecast email.
- **AWAITING_INPUT** — parked for the customer. **Not** in `PENDING_STATUSES`:
  the worker has nothing to do until the customer submits.
- **APPLYING** — claimed by the customer's submit; the worker runs the forecast
  import and then submits the render.

`listPending` adds `PREPARING` and `APPLYING`, not `AWAITING_INPUT`.
`emitOrderMetrics` gains an `OrdersAwaitingInput` gauge so a pile-up at the gate
is visible without alarming on it (waiting is legitimate here).

### New order-row fields

| Field | Purpose |
|---|---|
| `reviewForecasts` | true when the customer opted in at checkout |
| `fid` | the followed model the gate reads and the import is based on |
| `estimatesJobId`, `estimatesJobStartedAt` | resumable import polling across worker invocations |
| `values` | contiguous ns/ebit block submitted to the import |
| `rawEdits` | the customer's actual changed cells, for the audit trail |
| `proposalSummary` | the accepted AI interpretation summary, for the audit trail |
| `userComments` | report instructions, passed to the engine |
| `gateError` | non-terminal failure shown at the gate |
| `forecastEmailAt` | set before sending, so a crash mid-send cannot double-email |
| `previewCount`, `previewWindowStart`, `previewTotal` | preview rate limit + cost cap |
| `submittedAt` | when the customer left the gate |

---

## Backend

### `server/estimates.js` — Trunk forecast client (new)

A CommonJS port of `ai-stock-analysis/backend/src/services/estimates-import.ts`
plus the estimate-series read from its `financial-data.ts`. Semantics are copied,
not reinvented — they are the proven ones:

- `resolveFollowedModelId(ticker)` — `GET /rest/company?ticker=`, prefer the
  configured analyst's model, else the first. **Verified working.**
- `fetchEstimateSeries(fid)` — `POST /rest/modeldata`, returns
  `{ fid, currency, firstEstimateYear, historyYears, estimateYears, series }`.
  Values are **absolute millions in the model currency**. Up to 3 actualized
  years for context, up to 9 estimate years editable. **Verified working.**
- `generateEstimates(fid)` — `POST /rest/estimates/generate/{fid}`, poll
  `/rest/estimates/jobs/{jobId}`. **Base analyst model only** — never a
  forecast-import result fid, which would overwrite the customer's numbers.
- `importForecast(baseFid, values)` — `POST /rest/estimates/import`, poll
  `/rest/estimates/imports/{jobId}`. Mints a new fid; the base model is
  untouched. 10 s poll, 20 s per-request timeout.
  **Changed from the internal tool:** the job id is persisted on the order so a
  worker invocation that runs out of time resumes polling instead of
  re-importing. The deadline becomes a wall-clock budget checked against
  `estimatesJobStartedAt`, not a single-invocation loop.
- `validateEstimateEdits(edits, estimateYears)` — the allowlist: `ns`/`ebit`
  only, year must be an editable estimate year, finite value, `ns > 0`, no
  duplicate cells.
- `buildContiguousValues(edits, baseline, firstEstimateYear)` — per edited
  varname, emit every year from the first estimate year through the last edited
  year, filling untouched years from the model. The upstream import stops at the
  first year with no value, so a sparse block silently drops later years.

Config: `VALUATUM_TRUNK_URL` + `WISDOM_API_TOKEN`. Feature gate
`FORECAST_GATE_ENABLED` — without the URL and token, the opt-in checkbox is
hidden and any order that somehow carries the flag renders directly.

### `server/estimate-interpreter.js` — AI proposal (new)

Port of `estimate-interpreter.ts`. Unchanged: strict JSON response format,
temperature 0, `ns`/`ebit` only, absolute millions only, no cell repeated, empty
`edits` when the request contains no forecast change, and an explicit rule not to
follow instructions inside the customer's text.

Changed for this environment:

- **Timeout ~90 s** on the dedicated preview Lambda (see "The 28-second
  problem"). Still hard-bounded, with a user-actionable error on timeout.
- The prompt is sent **only** the current ns/ebit rows, the allowed years and the
  currency. No company name, no ticker, no email. The gate says so in plain text,
  as the valuation site does.
- `magnitudeNotes` unchanged: warn — never reject — on a change above 10× or
  below one tenth of the current value. This is the millions/tEUR mistake
  catcher, and Neste's numbers show why it matters: `ns` 2026 reads `19586`,
  meaning €19.6 bn, not €19.6 m.

Config: `OPENROUTER_API_KEY`, `ESTIMATE_INTERPRET_MODEL`,
`ESTIMATE_INTERPRET_REASONING_EFFORT`. Server-side only; the browser never sees
a model name or a key.

### Routes

**On the existing API Gateway** (`server/lambda/api.js`), called server-side by a
Vercel proxy with `CATALOG_SYNC_SECRET`, exactly like `POST /api/report-download`
today:

**`GET /api/orders/{id}/estimates`** — order-page state.

```json
{
  "status": "AWAITING_INPUT",
  "companyName": "Neste", "ticker": "NESTE.HE",
  "currency": "EUR", "firstEstimateYear": 2025,
  "historyYears": [2022, 2023, 2024], "estimateYears": [2025, …],
  "series": { "ns": { "2025": 18487.62, … }, "ebit": { … } },
  "gateError": null
}
```

`PREPARING` returns the status with no series; `RENDERING`/`DELIVERED` returns
the progress/download state so a reopened link cannot resubmit.

**`POST /api/orders/{id}/estimates`** — the only mutating submit.

```json
{ "values": [{ "varname": "ns", "year": 2027, "value": 21000 }],
  "comments": "Optional instructions for the report prose" }
```

- Valid only from `AWAITING_INPUT`; the change to `APPLYING` is a conditional
  update, so a double-click or a second tab gets a 409 rather than two imports.
- Validates the cells, builds the contiguous block, stores `values`, `rawEdits`,
  `proposalSummary`, `userComments` and `submittedAt`, then pushes the worker
  awake (`invokeWorkerAsync`, already in this file).
- Empty `values` **and** empty `comments` is the legitimate "generate with the
  current forecasts" path here — unlike the internal tool, this order has not
  produced a report yet, so there is nothing to accidentally burn.

**On a dedicated Function URL** (new `server/lambda/forecast-preview.js`):

**`POST /preview`** — `{ sessionId, text }` → the proposal.

- Verifies the Stripe session (paid, `isFresh`) and that the order is in
  `AWAITING_INPUT` before any paid-model call.
- Rejects empty text and text over **10,000 characters**.
- Fetches the current forecast, calls the model, then validates every returned
  cell with the same allowlist manual editing uses. A malformed or unsafe
  proposal is rejected, never repaired.
- Returns `{ edits, summary, notes, rows }` where each `rows` entry carries
  `previous` for the before/after table.
- **Non-mutating**: no import, no engine job, no state change beyond the
  rate-limit counters.
- Rate limit: **20 previews per minute per order**, plus a hard **40 previews per
  order** lifetime cap. Both are conditional updates on the order row, so they
  hold across Lambda instances. Previews cost real money and the order is the
  paying entity — a better key than the client IP.

### Vercel proxy — `api/order-estimates.js` (new, one file)

Verifies the Stripe session and proxies the two short API Gateway calls. `GET`
reads state, `POST` submits. One function rather than two keeps the deployed
function count where it is. The preview does not go through here.

### Worker — `server/reconciler.js`

`advance()` gains two branches, both following the existing blocking-step
pattern:

- **`NEW` with `reviewForecasts`** → `PREPARING`: resolve the fid, run estimate
  generation, store `fid`, set `AWAITING_INPUT`, send the forecast email.
  If the fid cannot be resolved or generation fails, **degrade rather than
  strand the customer**: log, alert the admin, clear `reviewForecasts` and fall
  through to the normal render. The customer has paid; a broken gate must not
  cost them the report.
- **`APPLYING`** → import (resumable via `estimatesJobId`), then
  `engine.submitJob({ companyCode, params: { fid, userComments,
  forecastsReviewed: true } })` and on to `RENDERING`.
  An import failure is **non-terminal**: back to `AWAITING_INPUT` with
  `gateError` set, so the customer can retry or continue without changes. After
  `MAX_ATTEMPTS` failed imports, render on the base fid with the instructions
  only and say so in the delivery email.

`engine-client.js` `submitJob` already forwards `params`; no change needed
beyond passing them.

`forecastsReviewed: true` is documented in `../pdf-report-engine/docs/api.md`: it
tells the writing stages to treat the supplied figures as authoritative, so
"growth looks optimistic" in the instructions reads as a request for a scenario
rather than licence to re-forecast the numbers the customer just set.

### Report instructions

Passed as `params.userComments`. Per the handoff, do **not** reintroduce the
former 2,000-character cap — it was removed from the engine in `27888ae`. Keep
only the control-character validation the engine requires (`\n` allowed), and
surface a useful error if the engine's 300 KB whole-`params` limit is ever hit.

---

## Frontend

No build step in this repo — the gate is vanilla JS in the site's existing design
language.

### `reports.html` — the opt-in

A checkbox in the `#order-fresh` form, below the purpose select:

> ☐ **Let me review the forecasts first.** Before we write the report you can
> adjust the revenue and EBIT forecasts and tell the analyst what to focus on.
> We'll email you a link. Generation starts when you're done.

`js/script.js` sends `reviewForecasts` to `/api/create-fresh-checkout`, which
puts it in the Stripe session metadata. It flows webhook → purchase sync → order
row. The delivery-time copy next to the button changes when it is ticked: the
30-minute promise starts at submit, not at payment.

Hidden entirely when the feature flag is off.

### `order/index.html` + `js/order-page.js` (new)

The four states above. The gate itself mirrors the valuation site's
`ForecastGate`/`ForecastEditor`:

1. **Description box first**, above the table, saying plainly that it changes
   forecast values and not just report wording.
2. **Example chips** — "Faster growth, better margin", "More conservative
   growth" — that fill the box, copied in spirit from `ReportApp.tsx:1422`.
3. Action labelled **"Create proposal"**, not "Apply changes".
4. **Proposal panel**: variable, year, current value, proposed value, the AI's
   interpretation summary, and any assumptions/warnings.
5. **"Use these changes"** to approve, **"Edit request"** to discard the pending
   proposal without touching a number.
6. After approval, a compact confirmation making clear the grid can still be
   fine-tuned.
7. **Manual grid** with two views per row — revenue absolute ↔ YoY growth %,
   EBIT absolute ↔ EBIT margin % — where editing a percentage updates the
   underlying absolute value immediately (`ReportApp.tsx:1317`).
8. Changed cells highlighted with the original value beneath, plus **"Restore
   original values"**.
9. A **report instructions** textarea and one **"Generate my report"** submit
   covering both forecasts and instructions.

Units: the series is **absolute millions**; the valuation site's grid is in tEUR.
Show millions with the model currency and label it — do not port the tEUR
conversion.

---

## Infra, env and secrets

Everything below is a deployment change and needs your approval before it is
applied to prod.

| Where | Variable | Note |
|---|---|---|
| API + Worker + Preview Lambdas | `VALUATUM_TRUNK_URL` | Deliberately separate from `WISDOM_REST_BASE` so the company-search picker is not repointed |
| API + Worker + Preview Lambdas | `WISDOM_API_TOKEN` | Already an SSM secret; must be the token for the environment the **engine** reads, not only the one the gate reads |
| Preview Lambda | `OPENROUTER_API_KEY` | New SSM secret. The key in `.env` is a local experiment key, not runtime |
| Preview Lambda | `ESTIMATE_INTERPRET_MODEL`, `ESTIMATE_INTERPRET_REASONING_EFFORT` | Model and effort — a real cost decision, see below |
| All three | `FORECAST_GATE_ENABLED` | Master flag, ships `false` |

Infra changes:

- **New `AiEquityReportsForecastPreview` Lambda**, 120 s timeout, Function URL
  (`authType: NONE`), reserved concurrency 5, read/write on the orders table,
  SSM read. No provisioned concurrency — a cold start is irrelevant next to a
  90 s model call. Its Function URL is a new stack output the order page needs,
  so it also becomes a build-time value in `js/order-page.js` or a field on the
  `GET /api/orders/{id}/estimates` response; the latter avoids hardcoding a URL
  into committed HTML and is the suggested route.
- The API Lambda's IAM role gains `UpdateItem` on the orders table; today it only
  creates.
- The worker keeps its 10-minute timeout — the resumable import polling is what
  makes that safe, since the cold import measured ~99 s upstream but is not
  guaranteed to be.
- SES: the new forecast email uses the existing sender and identity, no change.

**Model choice** is a real cost decision: every preview is a paid call, capped at
40 per order. Suggest starting on the same light model the internal tool defaults
to, at `medium` effort, and reviewing spend after the first week. The raised
timeout means a heavier model is now *possible* — that should be a deliberate
choice, not a default.

---

## Tests

`test/` is `node:test`, run with `npm test`. New suites:

| Suite | Covers |
|---|---|
| `test/estimates/validate.test.mjs` ✅ | allowlist: unknown varname, non-estimate year, non-finite value, `ns <= 0`, duplicate cell |
| `test/estimates/contiguous.test.mjs` ✅ | contiguous fill from the first estimate year; a gap year with no model value is a 400, not a silent drop |
| `test/estimates/series.test.mjs` ✅ | `fetchEstimateSeries` against a recorded `modeldata` fixture (the real Neste response) — history/estimate split, null handling, 9-year cap; plus `resolveFollowedModelId` ticker matching and the feature gate |
| `test/estimates/interpreter.test.mjs` ✅ | malformed JSON, fenced JSON, duplicate cell, non-numeric value, empty edits, 10× magnitude warning, and that the prompt carries no company identity (stubbed fetch) |
| `test/estimates/import-poll.test.mjs` ✅ | PENDING→OK, ERROR, unknown status, 404 mid-poll, job-id mismatch, resume from a stored `estimatesJobId` |
| `test/api/order-estimates.test.mjs` | wrong session, unpaid session, non-fresh order, wrong status, rate limit at 20/min and the 40 lifetime cap, double submit → 409 |
| `test/reconciler/gate.test.mjs` | opt-in path through PREPARING → AWAITING_INPUT + email; fid resolution failure degrades to a direct render; import failure returns to AWAITING_INPUT with `gateError`; forecast email not sent twice; no-opt-in path unchanged |

End-to-end, against test Stripe and a test order, walking the handoff's list:
no-change continue, AI proposal accepted, proposal rejected, accepted plus a
manual tweak, a percentage edit, a 10× unit warning, malformed AI JSON, import
failure and retry, unauthorized/rate-limited preview calls, and reopening the
emailed link in each order state.

---

## Sequencing

1. **Confirm `/rest/estimates/generate` and `/rest/estimates/import` on
   trunkdev** with this token, and settle which environment the engine's
   `Wisdom` key reads. Everything downstream is wasted if the fid the gate mints
   is not the fid the engine can read. *(Blocking.)*
2. ✅ **Done.** `server/estimates.js` + `server/estimate-interpreter.js` + their
   unit tests (`npm run test:estimates`, 88 tests). Pure modules, nothing
   deployed and nothing wired into the running site yet.
3. Orders-store statuses and fields; reconciler `PREPARING` / `APPLYING`
   branches; the forecast email; reconciler tests.
4. AWS API routes, the preview Lambda + Function URL, rate limiting, IAM grant;
   API tests.
5. The Vercel proxy function.
6. `order/index.html` + `js/order-page.js`.
7. The order-form checkbox, script wiring, and the email copy changes.
8. Behind `FORECAST_GATE_ENABLED=false`: deploy, then enable for a test order
   before turning it on publicly.

Steps 2–4 are the bulk of the backend; step 6 is the largest single file, because
the grid is being rewritten in vanilla JS rather than reused from React.

---

## Decisions still needed

1. **Abandoned gates.** The emailed link makes this much less likely, but an
   opted-in customer who never returns has still paid and has no report.
   Recommendation: the worker renders with the current forecasts after 24 hours
   and emails the PDF, having sent one reminder at 2 hours. The alternative is to
   leave it parked and rely on the admin alert.
2. **Which environment mints the fid** — the trunkdev/prod question in section 1.
3. **Preview cost ceiling.** 40 previews per order is a guess. If the model is
   priced as expected this is single-digit cents per order; confirm after the
   model is picked.
4. **Audit retention.** `rawEdits` and `proposalSummary` are proposed to live on
   the order row, an internal trail only. Say if the accepted changes should also
   be summarised in the delivery email.
