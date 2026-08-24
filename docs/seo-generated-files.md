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
| `npm run seo:titles` | `<title>`, `og:title` on `reports/*.html` | each page's own title + description |
| `npm run seo:companies` | `companies.html`, `companies/<letter>.html`, sitemap entries | `reports/*.html` |
| `npm run seo:llms` | `llms.txt` | `reports/*.html`, `compare/`, `blog/` |
| `npm run seo:pricing` | `pricing.md`, JSON-LD in `pricing.html` | `pricing.html` pricing cards |
| `npm run seo:freshness` | `WebPage` JSON-LD on top-level pages | `git log -1` per file |
| `npm run seo:og` | `images/og-image.png`, `images/og/*.png` | `images/og-image.svg`, page ratings |

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

**`$` in a replacement string.** `String.replace(re, "…$276…")` reads `$2` as a capture
group. Every one of these scripts uses function replacements; a string replacement silently
corrupted `og:title` on every USD-priced page before that was caught.

## Deliberately not done

- **`AnalysisNewsArticle` on the 1,157 company pages.** They carry company data, not an
  analysis article; the 17 pages that do have an article already carry the type. Adding it
  would be schema misrepresentation on a site publishing investment ratings.
- **Comparison pages.** `scripts/build-comparison-pages.mjs` needs the live catalog, and the
  content is an editorial decision, not a mechanical one. `llms.txt` will list them the
  moment real pages replace the stubs.
- **A visible "Last updated" line.** The machine-readable half is done (`dateModified`);
  putting a date in front of readers is a design change and wants a person's eye.

## When something drifts

CI (`.github/workflows/seo-guard.yml`) fails with the exact command to run. Locally:

```
npm run seo:check     # what CI runs
npm run seo:build     # fix everything except images
npm run seo:og        # images, needs Chrome
```
