# Blog Pipeline — Operational Runbook

Executed by a Claude Code agent per run. All state in git. Read `DESIGN.md`
once for context; this file is the loop.

## Run configuration

- **Schedule**: 3 runs/week — Mon/Wed/Fri **21:30 Europe/Helsinki** (cron
  `30 21 * * 1,3,5`, timezone Europe/Helsinki). Evening/night runs by design:
  generation happens when interactive usage is idle, so the account's quota is
  free for it. Topic-proposal run: Sundays 21:30 (`30 21 * * 0`).
- **Model**: writing-quality stages (4 DRAFT, 5 CRITIQUE/HUMANIZE) run on
  **Claude Opus 4.8 (`claude-opus-4-8`) with extended thinking at the highest
  effort setting ("xhigh")**. Configure the scheduled routine / subagent model
  accordingly (e.g. `model: "claude-opus-4-8"` + max thinking effort). Mechanical
  stages (sync, lint, build) may run on a cheaper model.
- **Mode**: stages run as subagents with the stage prompt from `prompts/`;
  the orchestrating agent follows this file top to bottom.

## Per-run procedure

### 0. Sync state
- Read `blog-system/topic-queue.json`, `blog-system/authors.json`,
  `blog-content/_ledger.json`, `report-content/_catalog.json`, `sitemap.xml`.
- Velocity check: 3 new posts already this calendar week → refresh-only run.

### 1. Refresh check (before new content)
Queue a refresh if either:
- A covered ticker has a new report date in `_catalog.json` newer than the
  related post's `dateModified` (Cluster D posts), or
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
- Pick ≥2 proprietary numbers from `report-content/*.json`.
- Output brief into the article JSON skeleton (`blog-content/{slug}.json`).

### 4. Draft — `prompts/02-draft.md` (Opus 4.8, xhigh thinking)
- Inputs: brief + `voice-guide.md` + raw facts pasted from report JSONs +
  fetched excerpts of the planned sources.
- Numbers come ONLY from supplied data or the planned sources — never memory.

### 5. Critique + humanize — `prompts/03-critique.md` (Opus 4.8, xhigh thinking)
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

### 7. Build + publish (approval flow)
- On-page lint (all must pass):
  - exactly one H1; target query in title, H1, slug, meta description
  - title ≤ 60 chars, meta description 140–160 chars
  - FAQ block 3–5 questions; sections open with direct answers
  - internal links ≥3 out (pillar + sibling + report/comparison page),
    ≥1 link added TO this post from an existing related page
  - sources rendered as a visible "Sources" section with links
  - hard gates from DESIGN.md §4
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

## Weekly (Sunday run)
- Run `prompts/00-topic-proposal.md` → append 3–5 scored proposals to
  `topic-queue.json`, commit with message `Blog topics: N proposals — pick or
  ignore (auto-pick after 48h)`. Human approves by flipping `status` to
  `"queued"` (or `"rejected"`) any time.

## Monthly (first run of month)
- AI-visibility check: top 20 target queries × ChatGPT / Perplexity / Google
  AI Mode → `blog-content/_visibility-log.md`.
- GSC check: queries ranking 5–20 → queue optimization refreshes.

## Failure rules
- Any gate fails after retries → `status: "needs-human"`, ledger note, move on. Never force-publish.
- Never invent author credentials, numbers, or sources. Missing data → narrow the article scope.
- Build must hard-fail on TODO author fields — no article ships without a real, named author with photo + LinkedIn.
- Quarterly original-data piece is human-collaborative, not autonomous.
