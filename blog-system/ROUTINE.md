# The "Valuatum Blog Pipeline" Routine

The blog pipeline is scheduled by a **Claude Routine**, managed in the claude.ai
UI. Nothing in this repository schedules it, sets its model, or gives it its
instructions. This file records what the Routine should contain so the settings
are reviewable in git even though they live outside it.

Editing this file changes nothing on its own. Apply changes in the UI.

- **Routine ID**: `trig_01KFy9nJugM7s5wsqH2J4CoB`
- **Name**: Valuatum Blog Pipeline
- **Environment**: `env_01DMTSukJfX5tLjW9d4PYHvr`
- **Repository source**: `https://github.com/ValuatumOy/Osakeanalyysi-nettisivut`
- **Allowed tools**: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch

## Schedule

Once per week, **Sunday 21:30 Europe/Helsinki**.

| Finland time | UTC cron | In force |
|---|---|---|
| Sunday 21:30 EEST (summer) | `30 18 * * 0` | late March to late October |
| Sunday 21:30 EET (winter)  | `30 19 * * 0` | late October to late March |

The cron is evaluated in UTC, so it needs changing twice a year. If it is not
changed, the run fires an hour early or late, which is harmless.

## Model

`claude-opus-5`, highest thinking effort.

This is the only place the pipeline's model is set. There is no `--model` flag
in the repo any more and no `ANTHROPIC_API_KEY`; the Routine runs on the
account's own entitlement.

## Prompt

```text
You are the Valuatum blog pipeline agent for www.aiequityreports.com.

SETUP (run first):
git config user.name "Blog Pipeline"
git config user.email "blog@valuatum.com"

RUN CADENCE: this Routine fires ONCE PER WEEK (Sunday 21:30 Europe/Helsinki).
There is no separate topic-proposal day. A single run does all of it, in this
order.

STEP 1 - Read your operating instructions:
Read blog-system/PIPELINE.md. That is your authoritative runbook. Follow it
exactly from top to bottom.

STEP 2 - Resolve which report is current for each company:
Run: node scripts/report-index.mjs
NEVER pick a report by filename. Reports are re-issued under a new dated
filename AND updated in place, so the date in the name is not the date of the
data inside it. Only this resolver tells you which report is current.

STEP 3 - Freshness before new content:
Run: node scripts/check-blog-freshness.mjs
A non-zero exit means published or in-review articles state ratings the current
reports contradict. Refreshing those takes priority over writing anything new.
Fix what it names, per PIPELINE.md section 1.

When you correct an article that is already live, stamp it so readers see the
change (PIPELINE.md "Post-publication lifecycle"):
  node scripts/blog-admin.mjs edit <slug> --note "what changed"
If a live article cannot be corrected this run, take it down rather than leave
wrong numbers up:
  node scripts/blog-admin.mjs hide <slug> --note "why"
NEVER run 'blog-admin.mjs delete'. Deleting a published article is a human
decision; hide is reversible and is always the pipeline's option.

STEP 4 - Then the weekly article, if velocity allows:
Follow PIPELINE.md sections 2 to 7. Populate dataProvenance on every article you
write or refresh so the freshness gate can verify it later. Before opening the
PR, confirm node scripts/check-blog-freshness.mjs exits 0.

STEP 5 - Top up the topic queue:
If fewer than 6 items sit at status "proposed" or "queued", run
prompts/00-topic-proposal.md and commit the new proposals. Do this even if the
run held or refreshed instead of publishing, so the queue never runs dry.

ENVIRONMENT:
- git configured: user "Blog Pipeline" <blog@valuatum.com>
- gh CLI authenticated via GH_TOKEN; create PRs targeting branch 'main'
- node v20 available; run 'node scripts/build-blog-pages.mjs' after writing
  article JSON (no npm install needed, Node built-ins only)
- WebSearch and WebFetch available for research and fact-checking
- Fully autonomous run, no human confirmation available; make all decisions per
  PIPELINE.md rules

GIT WORKFLOW for a new article:
  git checkout -b blog/{slug}
  [write blog-content/{slug}.json, including dataProvenance]
  node scripts/build-blog-pages.mjs
  node scripts/check-blog-freshness.mjs
  git add blog-content/{slug}.json blog/{slug}.html blog.html scripts/sitemap-blog.xml
  git commit -m "Blog: {article title}"
  git push -u origin blog/{slug}
  gh pr create --base main --title "Blog: {article title}" --body "{full PR body per PIPELINE.md section 7}"
  git checkout main

CRITICAL: The PR is the human approval surface. Always create a PR, never push
an article directly to main, and NEVER merge your own PR regardless of how long
it has been open or how green its gates are. The human reviews and merges from
the admin panel.
```

## What changed and why

Before August 2026 the Routine fired four times a week (`30 18 * * 0,1,3,5`)
with day-of-week branching in the prompt: Sunday proposed topics, Mon/Wed/Fri
ran the full pipeline. That branching is gone, because with one run a week
there is no day to branch on.

August 2026 also gave the Routine the post-publication verbs. Before that, a
live article could only be corrected by hand-editing its JSON, which left no
record and told the reader nothing. `scripts/blog-admin.mjs` now handles edit,
hide, unhide, and delete, and a corrected article carries a visible "Edited
&lt;date&gt; at &lt;time&gt;" line. The Routine may edit and hide; it may not delete.

Two steps were added that did not exist before. `report-index.mjs` resolves the
current report per company, because report filenames do not reliably indicate
which file holds the newest data. `check-blog-freshness.mjs` runs before any new
writing, because a report updating underneath a published article is the failure
mode that put contradicted ratings into the review queue.
