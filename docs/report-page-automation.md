# Automating report landing pages

Plan for making `reports/<slug>.html` and the `reports.html` listing generate and maintain
themselves, so that a purchase — or any other change to the catalog — reaches the public site
without anyone editing a file.

Status: built 7 August 2026 — `scripts/report-pages/` plus the two workflows below; awaiting
the `OPENROUTER_API_KEY` Actions secret and the worker deploy before going live. Written
7 August 2026; revised the same day after review, which
simplified the triggers to a cron, settled the free-vs-paid page question, and brought the
`reports.html` listing into the build. Revised a second time the same day: guard placement
settled, the same-day delivery overwrite fix pulled into scope, `js/reportSlugs.js` deleted
rather than owned, and the coverage-page metadata source made explicit.

## The gap this closes

```
purchase → api/webhook.js → order → worker Lambda → reconciler.deliver()
         → PDF + sidecar to S3 → buyer email → catalog serves it ready + paid
                                                        │
                                              ── the manual gap ──
                                                        │
         report-content/<id>.json  →  build-report-pages.mjs  →  reports/<slug>.html
                                                              →  git commit → Vercel deploy
```

Everything above the gap already runs by itself. `RESALE_ENABLED` is `true` in prod
(`infra/lib/worker-stack.ts:79`), so a delivered fresh report becomes a public `ready` + `paid`
catalog entry the moment it is delivered. The gap is the hand-written `report-content/<id>.json`
and the commit that follows it.

The site is static: all HTML is committed and Vercel serves the repo as-is, so the end of any
automation here is a git commit, not a running service.

## The site renders nothing at runtime

Today the catalog is rendered twice, by two different mechanisms:

- Landing pages are baked HTML, committed and served as-is.
- The `reports.html` listing is assembled in the browser: `buildReadyReports()` fetches
  `/api/reports` and builds the cards client-side.

Every sync problem this plan deals with is at bottom a disagreement between those two paths — the
live listing advertising a report whose baked page says something older, or nothing at all. So the
plan removes the second path: **the sync builds `reports.html` too**, from the same catalog
snapshot and in the same commit as the landing pages. Pages can then never disagree with each
other; the only lag left is between the whole site and the backend catalog, which no visitor can
observe because nothing on the site renders the catalog live.

This is also an SEO fix. The listing is currently invisible to any crawler that does not execute
JavaScript, and second-class even to Google. Baked, `reports.html` becomes a real hub page —
crawlable links to every landing page, indexable names and dates, a place for `ItemList` JSON-LD —
which is the entire reason this site commits HTML in the first place. The listing was the one page
exempted from that strategy.

What this deletes from the client:

- The inline catalog script in `reports.html` — `buildReadyReports()`, `pageUrlFor()` and its
  ticker fallback, the sort/dedup/price logic.
- `initLiveReadyReportCta()` in `js/script.js` (~100 lines). Its own comment says it exists
  because pages are static and rebuilds were manual; automated rebuilds retire it.
- `js/reportSlugs.js`. Its only consumers are the `reports.html` inline script above and
  `build-report-pages.mjs`, which folds into the sync — so it is deleted, not taken over.

What stays live in the browser: checkout only. Stripe sessions are created server-side against the
real catalog, so a stale price on a baked button can never charge the wrong amount — worst case,
someone clicks a button up to an hour after a state flip and the checkout tells them the truth.

## The unit is the company, not the report

This is the point everything else follows from.

The catalog carries one entry per *report*. A company can have several ready at once — on
7 August 2026 the 17 live entries covered 15 companies, with two each for AMD and Nokia:

| ticker | live report ids |
| --- | --- |
| AMD | `amd-05062026`, `advancedmicrodevices-06082026` |
| NOKIA.HE | `nokia-05062026`, `nokia-15072026` |

But there is only one landing page per company, because `resolveSlug` gives every report for a
company the same slug (`nokia-equity-report`). So N catalog entries compete for one page, and a
rule has to pick the winner. The rule, settled in this revision:

> **A company's page belongs to its free ready report if it has one; otherwise to its newest
> ready report.** The listing shows one card per company — the page owner.

Without the free clause this is the "newest wins" rule the site already applies in three places
(`buildReadyReports()`, `initLiveReadyReportCta()`, `docs/report-lifecycle.md`) — and with the
listing baked, those client implementations are deleted and the sync becomes the rule's only
implementation. Why the free clause exists is covered below.

`scripts/build-report-pages.mjs` currently follows no rule at all: it writes pages in whatever
order `Object.entries(catalog)` yields, so which report owns a company's page is incidental. This
is why the AMD page shows the 5 June report while a 6 August one is live — nothing picked it.

## How the resale window actually works

Worth writing down, because the name suggests a general expiry and it is not one.

`RESALE_WINDOW_DAYS` (default 14) applies **only** to the resale copy of a report someone paid to
generate. Two independent gates keep it away from everything else:

1. `REAPER_DRY_RUN` defaults to `true` (`server/reaper.js:39`) and CDK sets it to `'true'` in prod
   (`infra/lib/worker-stack.ts:80`). The reaper has never hidden anything — it logs `WOULD hide`
   and returns.
2. Even armed, `hasProvenance()` only lets it touch sidecars carrying
   `provenance: { sessionId, jobId }`, i.e. reports the reconciler generated for a fresh order.
   An uploaded catalog report has no provenance and is skipped forever.

Hence a manually added report stays purchasable indefinitely — which is why the 15 July Nokia
report is still on sale weeks later. Nothing is broken; the window simply does not apply to it.

Consequence for this plan: the "report disappears from the catalog" cases below are today driven
almost entirely by admin hides and deletes, not by the reaper. Arming the reaper would make them
routine.

## State on 7 August 2026

Comparing the live catalog against committed `js/reportSlugs.js`:

| Company | Page built from | Catalog has | Verdict |
| --- | --- | --- | --- |
| Nokia | `nokia-15072026` | `nokia-05062026`, `nokia-15072026` | correct — newest wins |
| Intel | `intel-05062026` | `intel-05062026` | correct |
| AMD | `amd-05062026` | `amd-05062026`, `advancedmicrodevices-06082026` | **stale** — shows June, August is live |
| UPM | `upm-08072026` | `upm-06082026` | **dead** — page cites a report no longer in the catalog |

Twelve `report-content/` files describe reports that have left the catalog
(`tesla-01062026`, `kesko-05062026`, `nvidia-13072026`, …). They are history, not errors: they
must be kept and must never build a page.

## Every case

The eleven situations below collapse into three behaviours. The sync derives which applies from
the live catalog, so it never needs to know which event woke it.

| # | Situation | Behaviour |
| --- | --- | --- |
| A | Company has a ready report, no page yet | Generate content, build the report page |
| B | Newer report supersedes an older one, both ready and both paid | **Newest wins the slug.** The older keeps its content file, stays reachable by direct id, is never listed |
| C | Free/paid flips in the weekly rotation | Rebuild the same page. Free renders the full analysis, paid a teaser plus buy gate. No generation, no cost |
| D | Report hidden, deleted or expired; company has another ready report | Rebuild to the next-newest. Nothing degrades |
| E | Report hidden via admin and it was the company's only one | **Degrade to the coverage page** |
| F | Report hidden by an armed reaper at the end of its resale window | Degrade to the coverage page |
| G | Report deleted via admin — the single deletion path in the system | Degrade to the coverage page; the PDF link would otherwise 404 |
| H | `expiresAt` or the `visibleAfterDays` timer fires | D or E, time-driven, with no event to hook |
| I | Hand-written coverage stub that never had a report (`fortum-coverage`, `orion-coverage`) | Leave alone |
| J | Content file for a report no longer in the catalog | Keep as history, never build from it |
| K | Company has both a free report and a newer paid one | **Free keeps the page** until it stops being free; then newest wins as usual |

A, B and K are one rule — the page-owner rule above. C is one rule. D through H are one rule.

## When a free report meets a newer paid one

The case that breaks plain "newest wins", and the one a fresh purchase creates by itself.

Tesla on 7 August 2026 is the worked example. `teslainc-05082026` is free — pinned with
`forceFree`, since the weekly rotation cannot have chosen it (`freeEligibleAfterDays` is 7 and the
report is 2 days old). Someone then buys a *fresh* Tesla report. `deliver()` publishes
`teslainc-07082026` as `ready` + `paid`, with `excludeFromFree: true` and `forceVisible: true`.
Two ready entries for one company, one free and one paid, the paid one newer.

Under plain "newest wins", the landing page would flip from the full free analysis to a teaser
plus buy gate, and the listing would drop the free report's card. The free report would then be
reachable only by direct URL while `forceFree` and `freeCount: 3` still count its slot as filled —
the site advertising three free reports while a visitor can find two.

The underlying confusion is between two questions that "newest wins" answers at once: **which
report the page is about**, and **which reports the page offers**. For this case they must not
have the same answer, and the resolution chosen is the cheaper of the two orderings: **the free
report keeps the page**, rendered in full — the best possible search surface, since the whole
analysis stays indexed. The newer paid report is buyable by direct id but unlisted, exactly like
any superseded report (open decision 1). The situation is self-limiting: the rotation flips
weekly, the free pin ends, and the newest report takes the page under the ordinary rule.

The cost is temporary staleness — while the pin lasts, the page shows older figures than the
newest report available. The alternative (an offer block listing every ready report side by side)
is correct on both axes but is a template redesign; it remains the natural follow-up if
multi-report companies become the norm rather than the exception.

## Defect: same-day deliveries overwrite each other

`pdfStore.putPdf` and `writeSidecar` are bare `PutObjectCommand` calls — no `IfNoneMatch`, no
existence check — and `deliver()` names the file `companyToken(companyName)_ddmmyyyy`. Company plus
UTC date is therefore the whole identity of a report, and a second write to the same identity
silently replaces the first. Two ways to reach it:

- Two customers order a fresh report for the same company on the same day. The second delivery
  overwrites the first, and `provenance.sessionId` afterwards names only the second order, so the
  first buyer's permanent link serves someone else's render and the audit trail for their order is
  gone.
- An admin-uploaded report and a delivered fresh order collide on the same UTC day. The
  reconciler's sidecar wins wholesale, which replaces `forceFree` with `excludeFromFree: true` and
  `accessStatus: paid`. This is the one case where a free report really is overwritten and stops
  being free.

Narrow, but silent and lossy — and truly concurrent orders make it worse: probing with
`pdfExists()` before writing is check-then-act, so two worker invocations delivering the same
company can both probe, both see nothing, and both write. The fix (in scope for this build) is an
atomic conditional create in `deliver()`: `PutObjectCommand` with `IfNoneMatch: '*'`, which S3
rejects with 412 if the key already exists. Try `Tesla_07082026.pdf`; on 412, take the next
suffix (`_2`, `_3`, …). S3 arbitrates atomically, so concurrent deliveries cannot both claim a
key. The PDF write is the claim; the sidecar is then written under the winning name and cannot
race, since its key derives from an already-claimed one.

One knock-on: report ids derive from the filename stem, and the derivation regexes (in
`pdf-text.mjs` and the catalog) require the date to end the stem — `Tesla_07082026_2.pdf` would
not parse today. The fix therefore includes teaching id derivation to accept an optional trailing
suffix, yielding ids like `tesla-07082026-2`. This also resolves the admin-upload collision
cleanly: instead of the reconciler's sidecar silently replacing the admin's, the second writer
becomes a second catalog entry for the same company, which the page-owner rule already handles.

This is the one piece of the plan that touches the worker Lambda; its deploy is proposed and
approved separately from the Actions rollout.

Separately, `api/create-fresh-checkout.js` performs no catalog lookup — the company name goes
straight from the form into a Stripe session. Nothing stops a customer paying for a fresh report
for a company whose report is currently free. That may be intended, since the fresh report carries
newer data, but the flow never tells them.

**Degrading to the coverage page** means rendering the branch that already exists — `if
(!hasReport) → generateGate(d)` in `build-report-pages.mjs`, as used by `fortum-coverage.json`.
The URL, its inbound links and its search ranking survive; the stale figures and the dead unlock
link go; the visitor is offered a fresh report, which is a sale rather than a dead end. Deleting
the page instead would throw away the SEO surface the page exists for.

The company metadata for a degraded page (name, ticker, exchange) comes from the company's newest
historical content file — the one place it survives once every report has left the catalog. This
is the single exception to case J's "never build from history": historical files never supply
*report* content, but they do supply *company* identity. Hand-written stubs (case I) are
distinguished by the `-coverage` filename convention and are never touched.

## Why a cron and nothing else

An earlier draft of this plan added event triggers — `repository_dispatch` POSTs from
`reconciler.deliver()` and the admin routes, plus a poll in the workflow to wait out the
five-minute CDN cache on `/api/reports`. Dropped, for one reason: since the sync is idempotent and
derives everything from current state, events could never affect *correctness*, only *latency* —
and there is nobody waiting. The buyer already has their PDF by email the moment the order
delivers; the landing page is a search and marketing surface, and search engines do not index
within the hour. Meanwhile three catalog changes are time-driven and fire no event at all (the
weekly free rotation, the reaper if armed, the `visibleAfterDays` / `expiresAt` timers), so the
cron had to exist regardless. Events were pure cost: a dispatch module, four call sites, a GitHub
token in SSM, worker and API Lambda redeploys — all deployment risk in the order path, buying
minutes on a page nobody is refreshing.

**Cadence: hourly.** A no-change run is a catalog fetch and a diff — no LLM call, no commit,
seconds of free Actions time — so frequency costs nothing, and hourly caps every mismatch window
(a rotation flip, a hide, a delivery) at an hour. Daily would stretch the worst case to a day of
last week's free report staying fully readable after the flip; there is no simplicity gained in
exchange. `workflow_dispatch` on the same workflow is the manual "sync now" button for the rare
moment an hour matters.

The CDN cache stops being a problem to engineer around: a cron run acts on whatever the catalog
says at that moment, and anything it misses, the next run catches.

## Design

One idempotent script, `scripts/report-pages/sync.mjs`, is the whole feature.

```
hourly cron            ┐
manual workflow_dispatch ┴→ sync workflow → commit main → Vercel deploy

    sync.mjs:
      live catalog  vs  report-content/  vs  reports/
      ├ missing content        → extract (strict gate)
      ├ state changed          → rebuild landing page (free/paid)
      ├ left the catalog       → rebuild as coverage page
      └ always                 → reports.html, sitemap; guard, then commit
```

**Runner.** GitHub Actions. The deliverable is a git commit, and `pdftotext` and the OpenRouter
key do not belong in the worker Lambda. The push uses the workflow's own `GITHUB_TOKEN` with
`contents: write` — no personal token, no SSM, no backend changes anywhere in the publishing
path. (The one backend change in scope, the `deliver()` overwrite fix, is independent of
publishing — see the defect section.)

**Publishing.** Straight to `main`; Vercel deploys on push. Fully automated — no human in the
loop, which is what the strict gate below is for. If a human pushed between the sync's checkout
and its push, the push is rejected: the run fails loudly and the next hourly run catches up. A
red run shortly after someone pushed is therefore expected, not a bug.

**Guard.** A check that every `reports/*.html` claiming a report id resolves to a live `ready`
catalog entry, that every ready entry has a page, and that the baked `reports.html` cards match
both. It fails on `main` today for AMD and UPM, so it also serves as the fix list.

It is one script (`scripts/report-pages/check.mjs`) run in two places. First, inside the sync
workflow, after building and **before committing** — so an inconsistent state never reaches
`main` at all: a failing run is a red workflow and no commit, and the site freezes at its last
consistent state, the benign failure mode. Second, an ordinary `on: push`/PR workflow (the
`blog-freshness.yml` pattern) runs the same script for human edits. This split is forced by a
GitHub Actions rule that would otherwise bite silently: pushes made with a workflow's own
`GITHUB_TOKEN` do not trigger other workflows, so an on-push guard would never run on sync
commits — the case it most exists for. With the guard inside the sync, that suppression stops
mattering: the sync has already run the identical check on exactly the tree it pushes. (Vercel is
unaffected either way — it is a GitHub App reacting to push webhooks, which do fire.)

Because the whole site is now baked, a silently failing sync is the one thing nothing else would
surface, so the workflow must be loud on failure (Actions failure notifications at minimum).

**Ownership.** The sync owns every catalog-derived byte in the repo: `reports/<slug>.html`,
`reports.html`, the report-pages sitemap fragment. This retires the standing caveat that the
company-page and report-page generators both write to `reports/` and whichever ran last wins.
`js/reportSlugs.js` is not taken over but deleted — see the client-deletion list above.

**Skipped reports.** Per `docs/report-lifecycle.md`, a report that is not public — e.g. a hidden
customer-specific report — has no public catalog entry, so the sync never sees it and never builds
a page. That property previously needed a check in the dispatch call sites; with the catalog as
the only input it holds by construction.

## Extraction

`scripts/report-ai/` was a harness for comparing models and is not kept. What carries over:

- **`prompt.mjs`, verbatim.** It is the tuned artefact and the reason the output is publishable.
- **The JSON schema.** The prompt is written against it; it is the contract, not scaffolding.

`style.mjs` and its repair pass (a mechanical prose-defect checker plus a one-shot repair call,
detailed in `docs/report-content-generation.md`) shipped as part of the strict CI gate, but was
removed on 2026-08-20: two live reports (Stora Enso, Tesla) got stuck failing every scheduled sync
because its `unitless-figure` regex flagged real, correctly-written figures (unit nouns like
"hectares" and adjective-qualified units like "500,000 paid rides" weren't recognised) and its
`scenario-recitation` check kept rejecting a draft the repair pass couldn't converge on within its
two-round budget. Both checks are gone; extraction is a single ungated model call again, checked
only by the structural gate below.

Dropped: `compare.mjs`, the LLM judge, `runs.jsonl`, `pdf-cache/`, and every flag that exists to
vary the model — `--model`, `--latest`, `--dry-run`, `--example`, `--pdf-native`, `--pdf-engine`,
`--no-schema`, `--json` — along with the cost-reporting apparatus.

Model: `openai/gpt-5.6-luna` via OpenRouter, pinned. Chosen on measured cost and quality —
roughly $0.005 per report, factually exact on the corpus tested, and matching a model ten times
the price on prose. The findings behind that choice stay in
`docs/report-content-generation.md`.

New home `scripts/report-pages/`: `sync.mjs`, `extract.mjs`, `prompt.mjs`, `schema.mjs`,
`openrouter.mjs`. `scripts/build-report-pages.mjs` folds into it, including the listing build.

**Gate before publishing.** Structure valid (schema-enforced structured outputs, plus a
BUY/HOLD/SELL and ISO-date sanity check) and JSON-LD valid; a report that fails the gate is
skipped (its page stays a coverage page) and the run fails loudly rather than publishing a bad
extraction. There is no prose-style check any more (see the note under "Extraction" above) —
figures cannot be verified automatically either way, no reference file exists for a new report —
so the generated headline block (rating, current price, target, upside) goes into the job summary
and the existing admin delivery email, where a five-second glance catches the fatal class of error
after the fact; a bad figure is fixed by correcting the content file and letting the next run
rebuild.

## Fixed along the way

Prerequisites rather than scope creep:

- **Slug collisions.** Three content files resolve to `tesla-equity-report`; today which one wins
  is incidental. Group by slug and apply the page-owner rule (free first, then newest
  `reportDate`), log the drops. Commit `ae39f7c` worked around this by deleting a superseded
  content file by hand.
- **Same-day delivery overwrites**, as described above. Independent of this plan, but this plan
  makes deliveries frequent enough for the collision to matter.
- **Sitemap `lastmod`.** Hardcoded to `'2026-06-08'` in `build-report-pages.mjs`; set it to the
  build date.

## Decided in this revision

1. **Triggers: hourly cron plus manual dispatch, no events.** See "Why a cron and nothing else".
2. **Case K: the free report keeps the page** until it stops being free. The offer-block template
   (page about the newest, offering every ready report) is the follow-up if multi-report companies
   become the norm.
3. **`reports.html` is baked by the sync**, and the client-side catalog rendering
   (`buildReadyReports()`, `initLiveReadyReportCta()`) is deleted. Checkout remains the only live
   call in the browser.
4. **Fully automated, no human approval step.** The gate is structural (schema, JSON-LD);
   figure review is retrospective via the job summary and admin email.

Decided in the second review, same day:

5. **The guard runs inside the sync workflow, before the commit**, with the same script also
   running as an ordinary push/PR workflow for human edits. See "Guard" for why the split is
   forced.
6. **The same-day delivery overwrite fix is in scope**: atomic conditional create
   (`IfNoneMatch: '*'`) with suffixed retries, plus the id-derivation change it requires. Its
   worker deploy is approved separately from the Actions rollout.
7. **`js/reportSlugs.js` is deleted**, not owned by the sync — nothing consumes it once the
   client catalog rendering goes.
8. **Degraded coverage pages take company identity from the newest historical content file**;
   `-coverage` stubs are recognized by filename and left alone.

## Still open

1. **Should a superseded report stay purchasable?** The 5 June Nokia and AMD reports are unlisted
   everywhere but still buyable by direct id. Leaving them live costs nothing, keeps permanent
   links working, and is the current behaviour. The alternative is having the sync auto-hide
   superseded entries through the admin API. Does not block the build.
2. **Should the reaper be armed?** While `REAPER_DRY_RUN` stays on, a purchased fresh report
   published for resale stays on sale forever — free catalog inventory, which may well be the
   point. But it makes `RESALE_WINDOW_DAYS` dead config, and cases E–G then only ever fire from
   manual admin hides. Worth deciding deliberately rather than inheriting the default. Does not
   block the build; it only changes how often the degrade path runs.
3. **Paid content is publicly reachable, and automation scales that up.** The repo is public, so
   every committed content file — including, under this plan, the full extraction of a report a
   customer just paid for — is readable on GitHub while the landing page shows a teaser. The
   live catalog API withholds `pdfUrl` for paid entries (only the local-fallback `catalog.js`
   builds it unconditionally), but the file host serves every PDF unauthenticated under its
   `fileName` — the same unsigned URL the buyer email carries — so a paid PDF is one derived
   URL away, and that derived URL is exactly how the Actions extraction fetches paid PDFs
   without AWS credentials (`scripts/report-pages/extract.mjs`). Accepted for now as a
   soft-paywall trade-off (reviewed 7 August 2026); to be fixed later. The plan turns this from
   occasional to systematic, so the later fix will need to give the extraction an authenticated
   path to PDFs.

## Prerequisites needing approval before deployment

- `OPENROUTER_API_KEY` as a GitHub Actions secret.
- The worker Lambda deploy carrying the `deliver()` conditional-create fix (decision 6) —
  proposed for approval separately when built.

Dropping the event triggers removed the fine-grained GitHub token, the SSM secret, and the API
Lambda redeploy the earlier draft required.
