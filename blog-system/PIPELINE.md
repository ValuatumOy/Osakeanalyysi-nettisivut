# Blog Pipeline — Operational Runbook

Executed by a Claude Code agent per run. All state in git. Read `DESIGN.md`
once for context; this file is the loop.

## Run configuration

- **Scheduler**: a **Claude Routine** ("Valuatum Blog Pipeline"), managed in the
  claude.ai UI, NOT in this repo. There is no GitHub Actions workflow for the
  pipeline and no `ANTHROPIC_API_KEY`. The old `.github/workflows/blog-pipeline.yml`
  was deleted in August 2026: it had failed all 27 of its scheduled runs (empty
  API key, and `--dangerouslySkipPermissions` no longer exists), and if it had
  ever worked it would have double-run the pipeline against the Routine.
- **Schedule**: **once per week, Sunday 21:30 Europe/Helsinki** (Routine cron
  `30 18 * * 0` in UTC during EEST; it becomes `30 19 * * 0` when Finland
  returns to EET in late October). Evening runs by design: generation happens
  when interactive usage is idle. There is no longer a separate proposal day —
  the single weekly run does refresh, then article, then tops up proposals.
- **Model**: set on the Routine itself (`session_context.model`), not in this
  repo. Writing-quality stages (4 DRAFT, 5 CRITIQUE/HUMANIZE) want **Claude
  Opus 5 (`claude-opus-5`) at the highest thinking effort**. Changing the model
  means editing the Routine in the claude.ai UI; nothing in git affects it.
- **Mode**: stages run as subagents with the stage prompt from `prompts/`;
  the orchestrating agent follows this file top to bottom.

## Per-run procedure

### 0. Sync state
- Read `blog-system/topic-queue.json`, `blog-system/authors.json`,
  `blog-content/_ledger.json`, `sitemap.xml`.
- Run `node scripts/report-index.mjs` — this is the ONLY way to learn which
  report is current for a company. Do not glob `report-content/*.json` and pick
  by filename: reports are re-issued under a new dated filename AND updated in
  place, so the date in the name is not the date of the data. As of writing,
  `tesla-01062026.json` holds a 2026-07-23 report while `tesla-07072026.json`
  holds 2026-07-07. The resolver reads the `reportDate` FIELD, ignores coverage
  stubs that carry no rating, and skips reports the site excludes.
- Run `node scripts/report-index.mjs --live` to compare against the live
  catalog the rest of the site builds from (`scripts/live-catalog.mjs`). If it
  reports newer reports live than in `report-content/`, then report-content is
  itself stale — say so in the run summary rather than writing from it.
- Velocity check: 3 new posts already this calendar week → refresh-only run.

### 1. Refresh check (before new content)
Queue a refresh if any of:
- `node scripts/check-blog-freshness.mjs` exits non-zero — a published article
  cites a superseded report, or states a rating that the current report
  contradicts. This is the primary trigger and it is authoritative.
- A covered company's current report (per `report-index.mjs`) is newer than the
  `dateModified` of a post that cites it.
- Any published post has `dateModified` > 90 days old.

A refresh: re-run stages 4–7 on the existing article JSON with current report
data. Must change real content (new numbers, ≥1 new/updated paragraph), update
`dateModified` (visible + schema), keep the original author unless the reviewer
reassigns, log `"action": "refresh"` in ledger. If a refresh was queued, do it
this run; new post only if velocity allows.

### 2. Topic selection (human-first, AI-fallback)
Topics enter the queue two ways:
- **Human-approved**: a `"proposed"` item the human flipped to `"queued"`
  (optionally edited). Always preferred — take the oldest queued item,
  respecting cluster order (pillar before supports).
- **Auto-promoted**: if NO item has `status: "queued"`, the AI decides: take
  the highest-`score` item with `status: "proposed"` whose `proposedAt` is
  ≥ 48h old (the human had their window). Set `status: "queued"`,
  `autoApproved: true`, note it in the ledger and in the PR/commit message so
  the human sees what was chosen for them.
- If neither exists: run `prompts/00-topic-proposal.md` now, commit proposals,
  end the run as refresh-only. (Normal proposal cadence: the Sunday run, which
  also tops the list up whenever fewer than 6 proposals remain.)
- Cannibalization check before proceeding: grep sitemap + existing titles for
  the target query's intent. Collision → `status: "blocked-cannibalization"`,
  take next.

### 3. Brief — `prompts/01-brief.md`
- WebSearch the target query + 2–3 phrasings. Note: who ranks, formats,
  competitor H2s, People-Also-Ask, the gap they all miss.
- Check AI answers (ChatGPT/Perplexity if reachable) — note who gets cited.
- **Source plan**: select ≥3 external sources per the source policy (below):
  at least 1 primary (company filing/IR release/exchange/regulator data),
  rest Tier 1–2. Record URL + what each will support.
- Pick ≥2 proprietary numbers from the CURRENT report for each company, as
  named by `node scripts/report-index.mjs`. Never open a report file chosen by
  filename. A company whose only entry is a coverage stub has no rating or
  target and cannot support a valuation claim — pick another company or narrow
  the article.
- Output brief into the article JSON skeleton (`blog-content/{slug}.json`).

### 4. Draft — `prompts/02-draft.md` (Opus 5, xhigh thinking)
- Inputs: brief + `voice-guide.md` + raw facts pasted from report JSONs +
  fetched excerpts of the planned sources.
- Numbers come ONLY from supplied data or the planned sources — never memory.

### 5. Critique + humanize — `prompts/03-critique.md` (Opus 5, xhigh thinking)
- Fresh subagent, no draft context. Applies **`blog-system/humanizer.md`**
  (the full Humanizer skill: 24 AI-pattern checks + voice section + final
  checklist) plus the finance-specific bans in `voice-guide.md`.
- Score with the humanizer 50-point rubric. Score < 40 → rewrite worst
  sections per the skill's workflow, re-score. Max 3 iterations; still < 40 →
  `status: "needs-human"`, stop.

### 6. Fact-check — `prompts/04-factcheck.md`
- Every numeric/factual claim traced to a report JSON field or a cited URL
  (re-fetch to verify). Source-policy compliance checked here too.
- GATE: zero unverified claims; ≥3 external sources, ≥1 primary, all Tier 1–2
  (Tier 3 allowed only in addition, never as sole support for a claim).
- Populate `sources` + `proprietaryData` arrays.
- **Populate `dataProvenance`** — one entry per company whose numbers appear:
  ```json
  "dataProvenance": [
    { "reportId": "upm-21052026", "slug": "upm-equity-report",
      "reportDate": "2026-07-24", "used": "rating, 12-month target, EV/EBITDA" }
  ]
  ```
  `reportDate` is the `reportDate` FIELD of the report, never the date in its
  filename. This is what lets a later run detect that the article has gone
  stale; without it an article can only be checked by the weaker rating scan.
  Set `"ratingCheckExempt": true` on an entry only when the article discusses a
  rating generically rather than asserting one (rare — justify it in the PR).
- GATE: `node scripts/check-blog-freshness.mjs` must exit 0.

### 7. Build + publish (approval flow)
- On-page lint (all must pass):
  - exactly one H1; target query in title, H1, slug, meta description
  - title ≤ 60 chars, meta description 140–160 chars
  - FAQ block 3–5 questions; sections open with direct answers
  - internal links ≥3 out (pillar + sibling + report/comparison page),
    ≥1 link added TO this post from an existing related page
  - sources rendered as a visible "Sources" section with links
  - hard gates from DESIGN.md §4
  - `node scripts/check-blog-freshness.mjs` exits 0 — no article cites a
    superseded report or states a rating the current report contradicts.
    CI runs this on every blog PR (`.github/workflows/blog-freshness.yml`),
    so a stale post cannot be merged even if this step is skipped locally.
- **Author/reviewer assignment**: set `authorId`/`reviewerId` to the defaults
  from `authors.json`. The human can change both during PR review — that is
  the moment "who wrote this / who read and accepted this" is decided.
- Run `node scripts/build-blog-pages.mjs`. Build FAILS if the referenced
  author has TODO fields, missing photo, or missing LinkedIn URL. Renders the
  author box (photo, name, title, authority bio, LinkedIn button) + reviewer
  line ("Reviewed by …") + Person schema with `sameAs` LinkedIn.
- **Mark topic as in-review**: in `topic-queue.json`, set the topic's `status` to `"in-review"` and add `"prNumber": <PR number>`. This prevents the next pipeline run from generating a duplicate. Commit this change to main (not to the PR branch).
- **Open a PR** (always — this is the approval surface), body containing:
  - the brief's angle + the humanizer score + fact-check claim table
  - source list
  - author/reviewer checklist:
    `Author: [x] author-1 (default) [ ] other → edit authorId`
    `Reviewed & accepted by: [x] reviewer-1 (default) [ ] other → edit reviewerId`
  - if topic was auto-promoted: "Topic auto-selected (no human pick within 48h)"
- **Merge policy: human merge only, no exceptions, no timeout.** The pipeline
  agent NEVER merges a blog-post PR itself, regardless of how long it has sat
  open or how green its gates are. All gates passing is a precondition for a
  human to review, not a substitute for the review. A human merging the PR is
  the only valid publish action; the merger's chosen author/reviewer stand.
  If a PR sits open past 48h, the next run leaves it open, does not touch it
  further, and may note its age in a status summary for the human — it never
  merges it, edits its base branch state to mark it published, or otherwise
  treats it as accepted. Human edits to the PR branch are honored (re-run
  lint + build after edits; a human still merges).
- Until a human merges the PR, the topic's `status` in `topic-queue.json`
  stays `"in-review"` — do not set it to `"published"` from the pipeline.
  Only a human merge (or a subsequent run confirming the merge happened)
  moves it to `"published"`, at which point `_ledger.json` gets the publish
  entry: slug, action, dates, gate scores, target query, authorId,
  reviewerId, `approval: { "auto": false, "mergedBy": "human" }`.
- Commit: `Blog: <title>`; Vercel auto-deploys once a human merges the PR to main.

## Source policy
- **Tier 1 (primary)**: company filings, IR releases, exchange data (Nasdaq
  Helsinki/NASDAQ), regulators, central banks, official statistics, our own
  `report-content/*.json`.
- **Tier 2**: major financial media (Reuters, Bloomberg, FT, WSJ), recognized
  research houses, official docs.
- **Tier 3**: reputable blogs/studies — supporting color only, never sole
  support for a factual claim.
- Banned: content farms, AI-generated aggregators, undated pages, anything
  the fact-checker cannot re-fetch.
- Every external claim gets an inline link; full list in the visible Sources
  section. (Outbound citations to authoritative sources are also a measured
  +40% AI-citation factor — cite generously.)

## Topic top-up (end of every run)
This used to be a separate Sunday run. With a single weekly run it is the last
step of that run instead.
- If fewer than 6 items sit at `status` `"proposed"` or `"queued"`, run
  `prompts/00-topic-proposal.md` → append 3–5 scored proposals to
  `topic-queue.json`, commit with message `Blog topics: N proposals — pick or
  ignore (auto-pick after 48h)`. Human approves by flipping `status` to
  `"queued"` (or `"rejected"`) any time.
- Do this even when the run held or refreshed instead of publishing, so the
  queue never runs dry between weekly runs.

## Monthly (first run of month)
- AI-visibility check: top 20 target queries × ChatGPT / Perplexity / Google
  AI Mode → `blog-content/_visibility-log.md`.
- GSC check: queries ranking 5–20 → queue optimization refreshes.

## Failure rules
- Any gate fails after retries → `status: "needs-human"`, ledger note, move on. Never force-publish.
- Never invent author credentials, numbers, or sources. Missing data → narrow the article scope.
- Build must hard-fail on TODO author fields — no article ships without a real, named author with photo + LinkedIn.
- Never resolve a report by filename. `report-index.mjs` is the only source of
  truth for "which report is current"; a number taken from a superseded file is
  a wrong number even when it was right when written.
- A stale-data failure is a refresh, never a suppression: fix the article
  against the current report. Do not silence the gate with `ratingCheckExempt`
  to get a merge through.
- Quarterly original-data piece is human-collaborative, not autonomous.
