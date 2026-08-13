# Analyst publishing, bounty and ranking

How an analyst's edited report reaches the site, what they earn for it, and how
they are ranked. Test stack only — see [members-test.md](members-test.md) for the
membership/quota system this builds on.

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
already on the engine job. Record them now, score later.

## Open questions

1. **Handoff contract with the engine team.** Where does their "tuomassa
   sivuille" end — at the revision UX, or does it include publication? If they
   publish too, our scope collapses to attribution + bounty + ranking. Blocking
   for the renderer, not for anything else.
2. **Rendering the section.** Assumed: submit carries the final revision `jobId`,
   we resolve jobId → PDF → `scripts/report-pages/extract.mjs` → section. Needs
   1 answered first.
3. `BOUNTY_EUR_PER_REPORT` and the monthly cap N.
4. Analyst display identity: LinkedIn name/photo directly, or a declared handle
   plus a moderated profile? Affects the profile-page surface above.
</content>
