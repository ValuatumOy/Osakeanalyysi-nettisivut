# SEO: what is generated, and from what

Everything in this document is **derived from the built pages**. Nothing here is a second
place to type a rating, a price or a company name.

That rule exists because the one file that broke it broke badly. `llms.txt` was
hand-maintained, and by August 2026 seven of its nine entries disagreed with the pages they
linked to — three of them on the rating itself, telling AI systems to BUY Kesko while the
page said SELL — plus a link to a slug that did not exist. It is the file handed to AI
systems as ground truth, on a site that publishes investment ratings.

## The scripts

| Command | Writes | Reads from |
|---|---|---|
| `npm run seo:titles` | `<title>`, `og:title` on `reports/*.html` | page title + `report-content/<id>.json` |
| `npm run seo:descriptions` | `<meta name="description">` on the 17 report pages | `report-content/<id>.json` + members API |
| `npm run seo:companies` | `companies.html`, `companies/<letter>.html`, sitemap entries | `reports/*.html` |
| `npm run seo:llms` | `llms.txt` | `reports/*.html`, `compare/`, `blog/` |
| `npm run seo:pricing` | `pricing.md`, JSON-LD in `pricing.html` | `pricing.html` pricing cards |
| `npm run seo:freshness` | `WebPage` JSON-LD on top-level pages | `git log -1` per file |
| `npm run seo:og` | `images/og-image.png`, `images/og/*.png` | `images/og-image.svg`, page ratings |
| `npm run seo:analyst-section` | analyst-reports section on `reports/*.html` | each page's own title |

`npm run seo:build` runs all but the images (which need Chrome).
`npm run seo:check` runs every script in `--check` mode plus the JSON-LD validator — this is
what CI runs, and every `--check` prints the command that fixes it.

## Conventions worth keeping

**Generators, not output.** `scripts/report-pages/render.mjs` and
`scripts/company-pages/render-company-page.mjs` were changed alongside every migration
script, so a regeneration does not undo the work. The migration scripts exist because
`sync.mjs` needs the live catalog and `generate-company-pages.mjs` needs Wisdom, so the
1,174 pages on disk cannot be rebuilt offline.

**Real dates, not today's.** `sitemap.xml` is edited in place rather than regenerated, and
page freshness uses each file's last commit date. Stamping "today" across 1,174 pages tells
Google everything changed at once, which is both false and checkable.

**Titles are budgeted.** `scripts/seo-title.mjs` picks the longest variant that fits in 60
rendered characters, so the rating and price target survive SERP truncation and the
boilerplate is what gets cut. Rendered length is what counts — `&amp;` is one character to a
reader and five in the file.

**noindex pages are skipped everywhere.** `compare/*.html`, `comparisons.html` and
`members.html` are noindex (the comparison feature was retired to redirect stubs). They are
kept out of `llms.txt`, out of the company index and out of the freshness stamping. Listing
a redirect stub to an AI system points it at a redirect.

**Ratings come from `report-content/<id>.json`, never from the page's own prose.** Every
page carries `<meta name="valuatum-report-id">` naming the JSON it was built from;
`scripts/report-headline.mjs` resolves it. The scripts used to recover the rating by regexing
the meta description, which broke the moment that sentence was rewritten — and rewriting it
is exactly what `seo:descriptions` does.

**The snippet has its own switch.** `SHOW_RATINGS_IN_SNIPPET` (on by default) is independent
of `SHOW_RATINGS_IN_METADATA` (off by default). A snippet sits under the page's own link, one
click from the disclaimer; a title or a share card travels without it. Decided 24.8.2026.

**Analyst counts are baked at build time.** A meta description cannot be filled in by the
browser, so `scripts/analyst-index.mjs` reads `GET /analyses` during the build.
It degrades rather than fails — the live catalog hard-fails on purpose, but an analyst count
is an enhancement on a page that is correct without it, so an outage returns null and leaves
existing descriptions alone rather than silently rewriting them all down to "no analysts".
Defaults to the **prod** members API; `MEMBERS_STAGE=test` for the test stack. Production has
0 published analyses today, so no committed page carries an analyst clause.

**`$` in a replacement string.** `String.replace(re, "…$276…")` reads `$2` as a capture
group. Every one of these scripts uses function replacements; a string replacement silently
corrupted `og:title` on every USD-priced page before that was caught.

## The analyst layer

`report-store.html` was retired, but it was the only caller of three members-API endpoints
that exist for readers with **no account**:

```
GET  /analyses/{genId}/free           an administrator's public free window
POST /analyses/{genId}/buy-checkout   buying one without an account
GET  /analyses/{genId}/purchased      collecting it after Stripe
```

Those are the income side of the analyst programme — an analyst's report has to be buyable
by someone who is not a member, or publishing earns nothing. They now live in
[`js/analyst-reports.js`](../js/analyst-reports.js), mounted on the page for the company the
report is about, which is better placed than a separate shop: scoped to one company it needs
no company filter, no analyst filter and no search, because the page already is the filter.

The section and its header button are always shown. When nobody has published on a company
it says so in as many words, because an absent section tells a reader nothing about whether
the layer exists at all. A failed request says something different again — "could not be
loaded" — since on a site publishing ratings, "we could not reach the API" and "nobody has
covered this company" are not the same statement. Ordering comes from the API
(`server/members/ranking.js`) and is never re-sorted client-side.

The signed-in browser in `members.html` is unchanged and still owns reading against
allowance, the review obligation and the one-open-at-a-time lock.

## Ratings in metadata (`scripts/seo-flags.mjs`)

One switch, **off by default**, controls whether a rating and price target appear in the
surfaces that travel away from the page: the `<title>`, `og:title`, `og:/twitter:description`
and the Open Graph card art (including its accent colour and the slope of its trend line,
which encode a verdict without words).

Off because a search result reading "SELL, €17.10 Target" carries none of the page's
"AI-generated research, not investment advice", and an AI answer will repeat the verdict
stripped of every qualifier. Whether Valuatum publishes recommendations in that form is a
compliance question, and it is open.

The SEO cost is small: only 17 of 1,174 pages ever carried a rating, and the win was title
*length* (median 108 → 49 against Google's ~60), which the flag does not touch. Those 17
read "Stock Analysis & Price Target", which also keeps them distinct from the 1,157 overview
pages rather than competing for the same query.

**What the flag does not cover**, deliberately: the plain `<meta name="description">` — the
Google snippet — still states the rating, as does the visible page body above the paywall
and `llms.txt`. Those predate the flag and are the wider publication decision. Turning this
switch on does not make the site compliant; leaving it off does not make it silent.

```
SEO_SHOW_RATINGS=1 npm run seo:build && SEO_SHOW_RATINGS=1 npm run seo:og
```

## Deliberately not done

- **`AnalysisNewsArticle` on the 1,157 company pages.** They carry company data, not an
  analysis article; the 17 pages that do have an article already carry the type. Adding it
  would be schema misrepresentation on a site publishing investment ratings.
- **Comparison pages.** `scripts/build-comparison-pages.mjs` needs the live catalog, and the
  content is an editorial decision, not a mechanical one. `llms.txt` will list them the
  moment real pages replace the stubs.
- **A public analyst *index* across all companies.** That was the store, and it is what made
  the nav confusing. Per-company sections cover discovery from the pages people actually
  land on; if a cross-company index is wanted later it should be one browsable page, not a
  second storefront in the nav.
- **A visible "Last updated" line.** The machine-readable half is done (`dateModified`);
  putting a date in front of readers is a design change and wants a person's eye.

## When something drifts

CI (`.github/workflows/seo-guard.yml`) fails with the exact command to run. Locally:

```
npm run seo:check     # what CI runs
npm run seo:build     # fix everything except images
npm run seo:og        # images, needs Chrome
```
