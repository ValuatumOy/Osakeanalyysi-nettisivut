# The report store

Design note for the second step of the analyst programme (Esa's direction,
19.8.2026). **Nothing here is built yet** — this is the plan, plus an honest
inventory of what the backend already does and what it does not.

The first step is done and on staging: the member area now states the offer as
10 engine reports, 20 analyst analyses unlocked one at a time, and one fresh
generation you commit to publishing. See [members-test.md](members-test.md).

## What the store is

One page listing **every** report the site holds, of two kinds:

- the engine's own €20 report for a company — one per company, unmodified;
- every analyst analysis published on top of it — analyst name, peer rating,
  the price that analyst set, ranked.

Filterable by company and by analyst. A visitor who lands on it from Tesla's
company page arrives with the company filter already applied.

The three buttons on a company page become: **Get the full report — €20**,
**Generate a fresh report**, **See all analyst reports** (deep-links into the
store, pre-filtered). The first two already exist in
`scripts/report-pages/render.mjs`; the third is one more anchor in the same
template plus a regeneration of the 1174 pages.

## What already exists

More than the shape of the plan suggests.

| Need | Status |
|---|---|
| Ranked list of analyses for one company | `GET /analyses?companyId=NOKIA.HE` — live, public, no auth |
| Ranked list of **all** analyses | `GET /analyses` with no query — live, public, no auth. Returns the whole `PUBINDEX` partition ordered by `server/members/ranking.js` |
| Ranking that means something | peer score with a neutral prior, review count, age decay — `ranking.js`, 6 unit tests |
| Analyst's own price | `priceEur` on every row, set at submit |
| Free-window flag | `free: true` while a hand-picked or decayed free window is open |
| The engine's €20 report per company | the public catalog, `https://www.aiequityreports.com/api/reports` |

So the store's **data** is already served by two endpoints that need no login.
The page is mostly front-end work over payloads that exist today.

## What does not exist

1. **Filtering by analyst has no stable key.** `GET /analyses` returns
   `analyst` as a display name only. Two analysts called Mikko Virtanen collapse
   into one filter. Fix: add the LinkedIn-derived user id to the payload and
   filter on that, showing the name. Small change in `getAnalyses`.
2. **Nothing lets a visitor open an analyst analysis.**
   `POST /analyses/{genId}/open` requires a member token and spends a monthly
   read. A logged-out visitor can see the row — name, rating, price — and cannot
   get the document, even when `free: true`. An anonymous free-window open is a
   new endpoint, and a deliberate decision: it gives away a PDF to someone who
   has not signed in.
3. **Nothing sells an analyst analysis.** `priceEur` is stored and displayed;
   there is no checkout behind it, so revenue share is still not computable.
   Deferred, see [analyst-publishing.md](analyst-publishing.md).
4. **The two kinds are not joined.** The catalog and `PUBINDEX` are separate
   reads keyed differently — the catalog by report id (`nokia-05062026`), the
   index by `companyId` (`NOKIA.HE`). The store page has to join them, and the
   join key is the ticker. Worth pinning down before the page is written.
5. **`PUBINDEX` is a single partition** capped at a 1 MB page. Fine now, and
   `store.js` already records where the GSI on `publishedAt` goes when it
   is not.

## Abuse control — what holds and what does not

Esa's question was how the system resists being gamed. Split honestly:

**Already enforced, atomically, in `server/members/quota.js`:**

- An analyst cannot open or review their own analysis (checked against the
  index's `userId`, returns 400).
- One review per reviewer per analysis — the review row's sort key is
  `REVIEW#<genId>#<reviewerId>` with `attribute_not_exists`, so a second one
  cannot be written.
- One open review obligation at a time — `openReviewId` is set with
  `attribute_not_exists` and removed only by a review of that same id. The read
  and the obligation are one transaction, so a race cannot leave a read paid for
  without an obligation, or an obligation without a read.
- A review costs a written comparison of at least 40 characters. A rating with
  no reasoning cannot be submitted.
- Ratings are 1–5 with decimals, rounded to one place server-side.
- Every open is written to the audit trail (`store.audit`, `analysis-opened`),
  with the reader, the owner and the timestamp.
- One bounty per analyst per company per calendar quarter, and a monthly cap —
  five takes on one company is not five fees.
- Publishing requires a `DELIVERED` order, so nothing can be published that the
  engine did not actually generate.

**Not enforced, and worth knowing before this is public:**

- **Reciprocal rating.** Two analysts can open and rate each other up. Nothing
  detects the pair. The audit trail contains everything needed to find it — a
  report over reviewer/owner pairs is the first admin tool to write.
- **Rings.** Same problem with three or more, and the pair report will not see it.
- **Sybil accounts.** The identity anchor is the LinkedIn account, and nothing
  stops one person holding two. A minimum LinkedIn account age, or the deferred
  joining fee, is the real answer.
- **Rating inflation.** Everyone rates everyone 5. Countermeasure is to
  normalise per reviewer rather than to police it — cheap, and it should happen
  before ratings are shown publicly, because a public 4.9 that means nothing is
  worse than no number.
- **Prompt-farming.** An analyst can publish a barely-modified report every
  month. The admin fast-clear (`GET /admin/members/publications`) exists exactly
  to read what was published; nothing measures how far it moved from the base.

None of these block the store's design — they block making the ratings public
and monetised, which is the step after it.

## Suggested order

1. Add the analyst id to `GET /analyses`, so filtering by analyst is sound.
2. Build the store page against the two existing endpoints, filterable by
   company and analyst, joined on ticker.
3. Third button on the company-page template, regenerate the report pages.
4. Decide the anonymous free-window open — the one product decision this needs.
5. Reviewer-pair report on the audit trail, before ratings go public.
6. Per-reviewer normalisation of ratings.
7. Checkout behind `priceEur`, which is what makes revenue share computable.

## The gate still applies

All of this is staging-only until the engine team's revision feature is in
production, and Stripe is switched to live in the same merge. See the
prod-rollout blockers in [members-test.md](members-test.md).
