# Valuatum Blog Engine — System Design

Automated pipeline that produces human-sounding, high-value blog articles for
www.aiequityreports.com, optimized for both traditional SEO and AI search
(Google AI Overviews / AI Mode, ChatGPT, Perplexity, Claude, Gemini).

Designed June 2026 from research on Nathan Gotch's methodology, the 2026 AI SEO
evidence base (Ahrefs, Semrush, seoClarity, Kevin Indig, Google's official AI
optimization guide), and Google's scaled-content-abuse enforcement patterns.

---

## 1. Why this design (research → decision)

| Finding (2026 evidence) | Design decision |
|---|---|
| Only 38% of AI Overview citations come from top-10 results (Ahrefs, down from 76% in 2025). Google AI Mode uses "query fan-out": passages are retrieved per sub-question, not per page. | Every H2 section is written as a self-contained answer to one sub-query (~100–170 words of extractable prose before any table). |
| ~50% of AI-search citations go to content < 13 weeks old; ChatGPT has the strongest recency bias. | The loop spends ~⅓ of its runs **refreshing** existing posts, not only publishing new ones. Every refresh makes substantive changes (new numbers + new paragraph), never date-bumps. |
| Opening a section with a direct declarative statement ("[X] is [Y]") raises citation rate +14% across sectors incl. finance (Kevin Indig). | Hard rule in the draft prompt: first sentence of the article and of every H2 is a direct answer with a number or position. |
| Google's information-gain patent + scaled-content-abuse enforcement: templated AI pages with no added value get sites deindexed (documented 60–80% traffic losses). ~17% of top-20 results are AI-generated and rank fine — the difference is unique value. | **Information-gain gate**: every post must contain ≥2 proprietary data points from `report-content/*.json` (our fair values, bull/base/bear implied prices, value-pool splits, 6-y projections) — numbers that exist nowhere else on the web. |
| Finance = YMYL. E-E-A-T signals carry ~3x weight on YMYL queries. Feb 2026: Google added an "Authors" section to Search Central docs. Anonymous finance content is a red flag. | Every post: named author + credentials + author page, "not investment advice" disclaimer, methodology link, dated statistics, sources. Never fabricate credentials. |
| Gotch: qualify keywords by intent + winnability (weak domains in top 10), build topic clusters (pillar + 5–10 supports), one intent = one page, kill cannibalization. | Topic queue is organized as clusters with explicit pillar/support roles and a target query + intent per article. Comparison pages already exist — blog posts target *different* intents and link to them. |
| Gotch + practitioner consensus: AI drafts are fine, one-shot publishing is not. Pipeline = outline → draft → critique → rewrite → fact-check. Two-pass + human verification cuts hallucination 12% → <2%. | 6-stage pipeline with hard gates (§4). Critique pass uses a different prompt than the draft pass. |
| LLM stylistic tells (em-dash overuse, "not X but Y", rule-of-three, "delve/leverage/landscape", uniform paragraphs, summary-sentence endings) are well-catalogued and detectable. | Voice guide + banned-move list injected into the draft prompt; dedicated humanizer critique pass scores the draft and forces a rewrite below threshold. |
| Velocity itself is a spam signal. Surviving sites publish at 2–4x human baseline, steady cadence. | Hard cap: **max 3 new posts/week**, steady schedule, no bursts. |
| Brand mentions correlate with AI visibility 3x more than backlinks (Ahrefs 75k-brand study). YouTube is the single most-cited domain in AI Overviews. | Out of scope for the loop itself, but §8 lists the off-page actions (YouTube earnings recaps, Reddit, Wikidata entity) that multiply the loop's effect. |
| llms.txt: no major AI vendor reads it in production; Google says it's unnecessary. | Site already has one; keep it updated by the build script, expect zero effect. robots.txt already allows all AI bots — keep. |

---

## 2. Architecture

Mirrors the existing report/comparison generators: **JSON content → build script → static HTML**.

```
blog-system/                  ← this directory: the transferable system
  DESIGN.md                   ← this file
  PIPELINE.md                 ← operational runbook the loop agent follows
  voice-guide.md              ← persona, register, banned moves, exemplars
  humanizer.md                ← full Humanizer skill (24 AI-pattern checks +
                                50-pt rubric) applied in the critique stage
  authors.json                ← real authors/reviewers: name, title, credentials,
                                bio, photo, LinkedIn (build fails on TODOs)
  topic-queue.json            ← clusters + proposals + article queue with status
  prompts/                    ← stage prompts (topic-proposal, brief, draft,
                                critique, factcheck)

blog-content/                 ← one JSON per article (created by the loop)
  _ledger.json                ← publish/refresh log: slug, dates, gate scores
  {slug}.json                 ← article content + metadata + sources

scripts/build-blog-pages.mjs  ← (to build) blog-content/*.json → /blog/*.html
                                + regenerates blog.html index, sitemap.xml entries
blog/{slug}.html              ← generated articles
```

Deploy: git push → Vercel auto-deploy (existing flow).

### Article JSON shape

```json
{
  "slug": "how-reverse-valuation-works",
  "cluster": "valuation-methodology",
  "role": "support",
  "targetQuery": "what is reverse valuation",
  "intent": "informational",
  "title": "...", "metaDescription": "...",
  "authorId": "author-1", "reviewerId": "reviewer-1",
  "approval": { "auto": false, "mergedBy": "human", "date": "2026-06-12" },
  "datePublished": "2026-06-12", "dateModified": "2026-06-12",
  "sections": [{ "h2": "...", "html": "..." }],
  "faq": [{ "q": "...", "a": "..." }],
  "proprietaryData": [
    { "claim": "Our base-case DCF puts Nokia fair value at €X (June 2026)",
      "source": "report-content/nokia-05062026.json" }
  ],
  "internalLinks": ["/reports/nokia-equity-report.html", "/methodology.html"],
  "sources": [{ "label": "...", "url": "..." }],
  "gateScores": { "humanizer": 42, "factcheck": "pass", "onpage": "pass" }
}
```

The build script renders: BlogPosting + FAQPage + BreadcrumbList JSON-LD,
Person author with `sameAs` → LinkedIn, visible "Updated [date]", disclaimer
block, a visible Sources section, related-posts links (cluster siblings +
pillar), and links into report / comparison pages. Server-rendered static
HTML — AI crawlers don't run JS.

### Author box (every article, rendered from authors.json)

- Profile photo, name, title, credentials
- 2–3 sentence authority bio (what they've analyzed, how long, where)
- **LinkedIn button** linking to the author's profile (also in Person schema
  `sameAs` — AI engines verify authors by graph traversal: site bio ↔ LinkedIn)
- "Reviewed and accepted by [reviewer name]" line with date
- Link to the author page (`/authors/{slug}.html`, lists all their articles)

Who wrote / who reviewed is decided **at approval time**: every post ships as
a PR whose description carries an author + reviewer checklist; whoever merges
can switch either before accepting. There is no auto-merge and no timeout —
a post stays as an open PR indefinitely until a human merges it, however long
that takes. Build hard-fails if the chosen author has TODO fields, no photo,
or no LinkedIn URL — YMYL pages never ship with an anonymous or fake byline.

---

## 3. Content strategy — clusters

One intent = one page. Pillar + supports, cross-linked. Comparison pages
(`/compare/*`) and report pages (`/reports/*`) are the commercial layer; blog
posts are the authority layer that links down into them.

### Cluster A — Valuation methodology (pillar cluster, evergreen, builds topical authority)
- **Pillar**: "How to value a stock: the complete guide" (DCF, multiples, scenarios)
- Supports: reverse valuation explained · value-pool analysis · EV vs market cap
  · P/E vs EV/EBITDA when to use which · terminal growth assumptions · FCF yield
  · how to read an equity research report
- Unique angle: every concept illustrated with *live numbers from our own reports*.

### Cluster B — Helsinki / Finnish stocks (underserved in English = winnable SERPs)
- **Pillar**: "Investing in Helsinki-listed stocks: guide for international investors"
- Supports: Nokia / UPM / Stora Enso / Kesko / Wärtsilä analysis takes,
  Finnish dividend stocks, forestry sector outlook (UPM + Stora Enso data).
- This is the wedge: tier-1 US media owns "is Tesla overvalued"; almost nobody
  covers OMXH names in structured English with proprietary valuations.

### Cluster C — AI in equity research (brand cluster)
- **Pillar**: "Can AI analyze stocks? What AI equity research can and can't do"
- Supports: how our reports are built · AI vs human analyst · limitations & failure modes.
- Honest-limitations content is rare → high information gain + trust.

### Cluster D — Company deep-dive questions (commercial-adjacent, freshness-driven)
- "Is [X] overvalued in 2026?" / "[X] stock forecast" per covered ticker.
- These are the refresh workhorses: re-run on every new report date.
- Must NOT cannibalize comparison pages: blog post answers valuation-opinion
  intent, comparison page answers head-to-head intent; they link to each other.

### Quarterly original-data piece (highest leverage)
Once per quarter, a study from our own model across the coverage universe,
e.g. "We ran our DCF on every stock we cover: X of Y trade above fair value."
Original research is the most-cited and most-linked format.

---

## 4. Pipeline — stages, hard gates

Stage prompts live in `prompts/`. Full operational detail in `PIPELINE.md`.

```
0 PROPOSE  (Sunday run) AI generates 3–5 scored topic candidates → status
           "proposed" in topic-queue.json. Human picks any time by flipping
           status to "queued". No human pick within 48h → loop auto-promotes
           the top-scored proposal (flagged autoApproved in PR + ledger).
1 TOPIC    take oldest human-queued item, else auto-promote (velocity cap,
           cluster order, cannibalization check vs sitemap)
2 BRIEF    research target query: live SERP + AI answers; competitor headings/
           entities/PAA; unique angle; proprietary-data plan; SOURCE PLAN
           (≥3 external, ≥1 primary per source policy)
3 DRAFT    Opus 5, xhigh thinking. Write from brief + voice-guide + report-
           content facts + fetched source excerpts (RAG — never model memory)
4 HUMANIZE Opus 5, xhigh thinking. Fresh pass applying humanizer.md (full
           Humanizer skill) + voice-guide bans → gate: rubric ≥ 40/50 else
           rewrite (max 3 iterations)
5 FACTCHECK every claim traced to report JSON or re-fetched URL; source-policy
           compliance                       → gate: zero unverified claims
6 BUILD+PR on-page lint → generate HTML (author box, sources section, schema)
           → PR with author/reviewer checklist → human merge = acceptance.
           No auto-merge, no timeout: the pipeline never merges its own PRs.
```

**Hard gates (publish blocked on failure):**
- ≥2 proprietary data points with dates and source pointers
- ≥3 external sources (≥1 primary: filing/IR/exchange/regulator), all linked,
  visible Sources section
- ≥1 explicit opinion with reasoning, ≥1 stated assumption, ≥1 named risk
- Humanizer rubric ≥ 40/50
- Zero unverified factual claims
- All YMYL furniture present (real author from authors.json with photo +
  LinkedIn, reviewer line, disclaimer, methodology link)
- No target-query collision with existing pages

**Velocity:** max 3 new posts/week. Refresh runs don't count against the cap.

---

## 5. Voice (summary — full guide in voice-guide.md)

Register: Morningstar discipline + Inderes plainness. Data-first, position-taking,
transparent about assumptions and track record. Never hype.

- Lead with a number or a position, never a topic intro.
- One explicit opinion per post, with reasoning.
- State assumptions ("we assume 4% terminal growth, because...").
- Admit uncertainty ranges. End with a concrete implication or risk, never "time will tell".
- Banned: delve, leverage (verb), landscape, testament, pivotal, robust, seamless,
  "not X but Y", "serves/stands as", rule-of-three lists, ANY em dash (zero tolerance),
  paragraph-final summary sentences, "experts say", optimistic formula endings.
- Required: varied sentence and paragraph lengths, first person allowed, plain "is/has".

---

## 6. Refresh loop

Triggers, checked every run from `_ledger.json` + `report-content/_catalog.json`:
1. New report date for a covered ticker → refresh that ticker's Cluster D post(s)
   within 7 days.
2. Any post `dateModified` > 90 days → queue refresh.
3. Refresh = new numbers + ≥1 new/updated paragraph + updated dateModified
   (visible + schema). Never a date-bump alone.

---

## 7. Loop operation & transfer to another Claude account

The system is **file-complete**: another Claude Code instance needs only this
repo. Entry point: `blog-system/PIPELINE.md`.

- Schedule: 3 runs/week, **Mon/Wed/Fri 21:30 Europe/Helsinki** (cron
  `30 21 * * 1,3,5`), plus topic-proposal run Sundays 21:30. Evening/night
  Finland time on purpose: generation runs when the account's interactive
  usage is idle, so quota goes to writing.
- Model: draft + humanize stages on **Claude Opus 5 (`claude-opus-5`)
  with extended thinking at highest effort ("xhigh")**; mechanical stages can
  use a cheaper model.
- Every post ships as a PR — that PR is the approval surface (author/reviewer
  selection + accept). Merge is human-only and untimed: the pipeline never
  merges its own PRs, no matter how long they sit open or how green the gates.
- State lives in git: `topic-queue.json` (proposals + queue), `authors.json`,
  `_ledger.json` (what happened, who approved), article JSONs. No external state.

## 8. Off-page multipliers (manual, not in the loop)

1. Wikidata item for Valuatum Oy + author entities (LinkedIn `sameAs`). Highest-leverage one-time entity work.
2. YouTube: even simple earnings-recap videos — YouTube is the most-cited domain in AI Overviews.
3. Authentic Reddit (r/stocks, r/SecurityAnalysis) and LinkedIn presence (now #5 in ChatGPT citations).
4. Monthly AI-visibility check: top 20 queries × ChatGPT/Perplexity/AI Mode, log who gets cited. Visibility is the KPI, not clicks (93% of AI Mode sessions end zero-click; but AI-referred visitors convert ~20x better).

## 9. Open decisions

1. **Author identity** (blocking for first post): fill the TODO fields in
   `authors.json` — real name, title, credentials, bio, profile photo,
   LinkedIn URL — for at least one author and one reviewer. Build hard-fails
   until done. Do NOT invent a persona — fake credentials on YMYL is the
   single worst pattern.
2. Whether Cluster D posts for *paid* report tickers reveal the fair-value
   number (citation magnet) or a range (protects paywall). Recommendation:
   reveal base-case number, gate bull/bear detail — the number is what gets cited.
