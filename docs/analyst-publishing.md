# Analyst publishing, bounty and ranking

How an analyst's edited report reaches the site, what they earn for it, and how
they are ranked. Test stack only — see [members-test.md](members-test.md) for the
membership/quota system this builds on.

Public-facing description of the programme: [`analysts.html`](../analysts.html)
— it describes the intended flow, so parts of it are ahead of implementation
(revision UX, the company-page section, analyst profile pages).

## What an "edited report" is

The analyst gets a report — bought, or the freemium one free generation per month
— and then prompts the AI to revise it toward their own view. The revision UX is
**owned by the engine team, not this repo**. The mechanism already exists in
`pdf-report-engine`:

| Call | What it does | Cost |
|---|---|---|
| `POST /jobs` with `params.userComments` (≤2000 chars) | analytical direction on the first run | full run |
| `POST /jobs/{jobId}/revisions` `{comments, scope:"content"}` | one grounded call patches the prose, existing figures must survive | seconds |
| `…{scope:"narrative"}` | writing pipeline reruns against the frozen snapshot, no data refetch | LLM pipeline |
| `…{scope:"full"}` | fresh generation with accumulated comments | everything |

Comments accumulate across the chain, so a later comment can undo an earlier one.
The engine's boundary is *evidence, not conclusions*: instructions can steer
emphasis, assumptions, peer set and valuation method, but cannot invent facts or
rewrite supplied financial data. Rating is derived arithmetically from the target
price — "make this a SELL" only lands as an upstream assumption change.

**Consequence for us: we never edit report content.** The published artefact is
always an engine PDF from a specific `jobId`. That keeps
[report-fact-provenance](../../.claude/memory) intact and keeps the compliance
story simple: every published claim is traceable to an engine job and its comment
chain.

## Publication surface — recommendation

**Analyst analyses render as a section on the existing company report page**
(`/reports/<company>-equity-report.html`), permalink = anchor. Not standalone
`/analysis/<company>` pages.

Why, from this repo's own history:

- There are 1174 report pages, exactly one per company, and `owners.mjs` exists
  purely to enforce that rule.
- `vercel.json` actively 301s `*-stock-analysis`, `*-oyj-equity-report` and other
  slug variants **into** the canonical page. The site has already fought this
  cannibalization fight and consolidated.
- A standalone analyst page would target the same head query ("Nokia stock
  analysis") as the page that already holds the authority, and split it.
- Analyses are dated takes. Adding them to the company page makes that page
  fresher and deeper — the two things the canonical page actually wants.

The carrot for analysts is the **second indexable surface, which cannibalizes
nothing**: analyst profile pages, extending the existing `authors/` pattern.
"Firstname Lastname equity analyst" belongs to no company page. Index those from
day one, link every analysis section back to the profile.

Data model stays surface-agnostic: an analysis is its own entity with its own
slug and `analystId`. If long-tail demand for thesis-level queries shows up
later ("Nokia target price after Q2"), standalone pages can be promoted without
a migration.

## Publish flow

Auto-publish with post-moderation (business decision, 13.8.2026).

```
POST /generations/free {company, ticker} ──► order → worker → engine
        │                                    (+ revisions, engine team's UI)
        └─► POST /generations/{genId}/submit {promptsText}
                  │  company + jobId come from the order, never from the request:
                  │  the bounty keys on the company, so a client-supplied ticker
                  │  would be a way to farm one bounty per spelling of a name.
                  │  Releases the obligation, PUB item → status "published"
                  ▼
            company page section (renderer: see open questions)
                  │
                  └─► admin takedown ──► status "takendown", bounty voided
```

Statuses on the `PUB#<genId>` item: `generating` → `published` → optionally
`takendown`. There is no `submitted` holding state any more — submit publishes.

## Bounty — per published report

Business decision (13.8.2026): fixed fee per published analysis, not a revenue
pool.

Auto-publish plus pay-per-report is a spam incentive if the two happen at the
same moment, so **payment is where the quality gate moved**:

| Rule | Value | Why |
|---|---|---|
| Maturity | `publishedAt + 14 days`, not taken down | publish instantly, pay slowly — moderation window is the gate |
| Uniqueness | one bounty per analyst per company per calendar quarter | kills "same company, five takes" farming |
| Monthly cap | N eligible analyses per analyst per month | bounds worst-case spend |
| Takedown | voids the bounty; clawed back if already paid | takedown must cost something |
| Amount | `BOUNTY_EUR_PER_REPORT`, unset by default | open business question, not a code decision |

**Eligibility is derived, never stored.** Every input (publish time, company,
takedown, which genIds were paid) already lives on the user's `PUB#` and
`PAYOUT#` items, so a single Dynamo query plus a pure function gives the answer.
No sweep job, no accrual transactions, no race conditions. Only payouts are
written.

Payout rails are deliberately out of scope. Stripe Connect means KYC and tax
handling; the ledger is recorded and settled manually until volume justifies it.

## Ranking

Visibility only — it does not decide money (the bounty does). Minimum viable:

- `analystId` on everything published (already the members `userId`).
- View/download counters per analysis, in the same members table.
- Score = published analyses × engagement, decayed by age. Formula is tuning, not
  architecture — keep it in one pure function.
- Uses: ordering of the analyses section on a company page, and a public analyst
  leaderboard once there are enough analysts for one to mean anything.

Credibility scoring against realised returns (was the call right?) is the
obvious later step and needs the target price and date per analysis — both
already on the engine job. Record them now, score later — and see the next
section, because Valuatum already built that scoring once.

## What the 2004 freelance system already solved

Valuatum ran a freelance equity-analyst marketplace with ~40 analysts in Finland
(`old.valuatum.com/freelance/`). Read before reinventing: `rewarding.shtml`,
`points.shtml`, `admin-points.shtml`, `automatic-points.shtml`,
`customer-points.shtml`, `coaching-analysts.shtml`, `original_analyst.shtml`,
`pay_salary.shtml`.

The economics do not transfer — back then the analyst built the whole model, so
they earned 50% of revenue. The engine does the modelling now. The **mechanics**
transfer almost unchanged:

**Rank per company, not globally.** Every covered company was ranked separately,
so one analyst held a different position for each company they followed. That is
exactly what our company-page section needs: an ordering, per company.

**Rank-weighted revenue split.** #1 got 2× #2, #2 got 2× #3, and so on. One line
of code, and it makes competing for a company worth something. The page itself
flags the failure mode: if #2 gets too little to stay motivated, flatten the
curve, or make the split track the *distance* between ranks rather than the ranks
themselves. Worth grafting on top of the flat bounty once there is more than one
analyst per company.

**Three point categories whose weights shift over time** — admin (human review),
customer, automatic — starting at ~100% admin and moving to automatic + customer
as data accumulates. This is the right answer to our cold-start problem: on day
one there is nothing to compute a score from.

**Automatic points = was the call right.** The best idea on those pages, and the
one we can build with what the engine already produces. Monthly, per analysis:
compare the recommendation against the realised share-price move, score
`Successful +1 / OK 0 / Not available -0.1 / Unsuccessful -1` against per-rating
thresholds (Buy: >1% successful, 0–1% OK; Hold: ±2% successful, ±5% OK; Sell:
< -1% successful; Accumulate and Reduce in between), convert to a **percentile
against every other analysis that month**, then combine months with recent ones
weighted heavier — old mistakes fade, so a bad month is recoverable. Every input
exists: rating and target price are on the engine job, the price series is in
Valuatum REST.

**Percentile, not raw score, in the UI.** "This analysis ranks better than 76% of
all analyses" reads better than a number and needs no explaining.

**A quality floor with teeth.** Below 0.5 admin points the analysis was labelled
UNRELIABLE, dropped out of the ranking lists, and earned nothing. Softer and more
useful than our binary takedown: a floor demotes, takedown removes.

**Coaching analysts — peer review as a paid role.** Any analyst holding at least
one 1.1-point analysis could apply to review others' work, and the reviewers
shared 10% of revenue. This is the answer to our unstaffed moderation queue: it
scales with the analyst pool instead of with our headcount. The booking step
(claim a request so two reviewers don't duplicate) is worth copying too.

**The feedback-request loop.** The analyst signals "ready for review", gets
points *plus* concrete improvement suggestions, fixes, and re-requests. Rating
without a fix path just ranks people; this makes the ranking a ladder.

**Customer ratings count only with a written comment.** Ratings without one were
stored but excluded from anything that decided money or position. Cheap rule,
kills drive-by noise.

**The non-monetary pitch was the real one.** Public track record against
consensus, an objective accuracy score to show an employer, and a visible
shop-window: six of about forty freelancers were hired as analysts by brokers or
corporate finance units within nine months. That is what analyst profile pages
are for.

Deliberately **not** taken: the 50% revenue share (the engine does the modelling
now); the original-analyst incentive of 20% for 3 years (nobody has to bring a
company in — the engine does); company reservations to avoid overlapping
coverage (coverage is no longer scarce); and payroll (35% social costs, tax
cards, 12 € payroll fee) — invoice-only stays our rule. Two payout mechanics are
worth keeping: a **minimum payout threshold** so tiny transfers never happen, and
a **fixed due date** on the invoice rather than ad-hoc payment dates.

## Open questions

1. **Handoff contract with the engine team.** Where does their "tuomassa
   sivuille" end — at the revision UX, or does it include publication? If they
   publish too, our scope collapses to attribution + bounty + ranking. Blocking
   for the renderer, not for anything else.
2. **Rendering the section.** Assumed: submit carries the final revision `jobId`,
   we resolve jobId → PDF → `scripts/report-pages/extract.mjs` → section. Needs
   1 answered first.
3. `BOUNTY_EUR_PER_REPORT` and the monthly cap N.
5. Whether the flat bounty stays flat, or gets the 2004 rank weighting on top
   once a company has more than one analyst (see the section above).
6. Whether peer review ("coaching analysts") is the moderation model. It is the
   only one that scales without headcount, but it needs a paid role and a
   seniority bar before anyone is trusted with it.
4. Analyst display identity: LinkedIn name/photo directly, or a declared handle
   plus a moderated profile? Affects the profile-page surface above.
</content>
