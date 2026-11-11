# Company page generator

`scripts/generate-company-pages.mjs` creates static company overview pages from
Wisdom financial model data. It fetches financial data on every run. Only the
AI-generated company profile is cached in `company-content/profiles/`.
Existing pages are not overwritten: use the reviewed refresh workflow below.

## Requirements

- Node.js 20 or newer
- A Wisdom bearer token with `Controller.Company` and `Controller.ModelData` rights
- An authenticated Codex CLI when profiles are not already cached

Set the environment variables before running the generator:

```bash
export WISDOM_API_BASE=https://wisdom.valuatum.com/rest
export WISDOM_API_TOKEN=...
export AI_PROVIDER=codex
export AI_MODEL=gpt-5.4-mini
export AI_REASONING_EFFORT=low
```

`AI_MODEL` is optional. The default is `gpt-5.4-mini`, and `--model`
overrides it for one run.
`AI_REASONING_EFFORT` defaults to `low`, which is sufficient for the short
factual profile task.

Profiles are one neutral paragraph of 45-65 words. They explain the company's
main businesses, products, services or value pools and exclude recommendations,
valuation, target prices, upside, investment theses and promotional language.

## Usage

Generate one or several pages:

```bash
npm run generate:companies -- FORTUM NOKIA KESKOB UPM WRT1V
```

Generate a new page and regenerate its company profile even when it is cached:

```bash
npm run generate:companies -- --refresh-ai --model gpt-5.4-mini FORTUM
```

Avoid AI calls and use a cached profile or Wisdom background text:

```bash
npm run generate:companies -- --skip-ai FORTUM
```

Generated pages are written to `reports/{company}-equity-report.html`. The
financial figures always come from relative position `Y-1` with history enabled
and estimates disabled.

After a successful run, the generator also adds or updates each page in
`js/companyPagesData.js` and `sitemap.xml`. This keeps the homepage and Reports
searches, internal discovery and search-engine discovery in sync with the
generated HTML pages. A normal command-line run also rebuilds the A–Z directory.
Use `--skip-discovery` only for isolated previews or tests.

## Selection rules

1. `/company?ticker=...` is filtered to an exact, case-insensitive ticker match.
2. All accessible followed models for the company are queried together.
3. The model with the lowest `orderNo` is selected. The followed model ID is the
   deterministic tie-breaker.
4. Missing figures are rendered as `N/A`; they are never converted to zero.
5. A failure for one ticker is reported without preventing successful tickers
   from being written. The command exits non-zero if any ticker failed.

## Tests

```bash
npm run test:company-pages
```

The tests use in-memory Wisdom responses and do not require network access,
credentials or an AI call.

## Refresh existing pages

`npm run refresh:companies` updates the financial sections of existing overview
pages without regenerating profiles or reports. It preserves their existing URL,
profile, calls to action, breadcrumbs and related links. Full report pages are
rejected, as are historical company pages and pages without an active report
order. Those pages need a separate status review. The page is identified using the current Wisdom ticker and the ISIN
already present in its schema, so a ticker suffix change does not require a new
profile or URL.

For a separately listed depositary receipt whose issuer has a different ISIN,
`modelIsin` and `identitySourceUrl` may be supplied only after checking the
instrument relationship in an issuer or exchange document. Use the receipt's
own year-end price and the relevant market-cap definition, not the other
listing's price.

Every batch requires a reviewed JSON manifest, for example
`company-content/reviews/2026-11-11-pilot.json`. For each company, the manifest
contains the current Wisdom ticker, the page's existing ticker, the official
annual report URL, the reviewed fiscal year and figures,
and a snapshot of Wisdom's corresponding model figures. Amounts other than the
share price are in millions. Verify each value, its currency, the share price
and the market-cap definition against the filing before adding it. Unverified
figures other than revenue may be set to `null` and will
appear as `N/A`; they are never filled from the model automatically. Record the
date on which the sources were checked in `checkedOn`.

```bash
# First validate all companies without modifying files.
npm run refresh:companies -- --manifest company-content/reviews/2026-11-11-pilot.json

# Only after reviewing the validation result, update the local pages and sitemap.
npm run refresh:companies -- --manifest company-content/reviews/2026-11-11-pilot.json --write
```

Both commands require `WISDOM_API_TOKEN`; neither uses AI. The refresh stops
before writing if an ISIN, fiscal year, currency or model figure differs from
the review, a page is not a recognized overview, or its sitemap entry is
missing. If the filing is newer than the model, record the model's period as
`modelFinancialYear` as well as the filing's `financialYear`. A new year or a changed model therefore needs a new filing review and
manifest. Running the command does not deploy the site. No scheduled automatic
refresh is configured.

A manifest cannot replace a review checked on a later date. A correction to an
already-reviewed page on the same day must also include `expectedPageSha256` for
that page in its manifest entry. Calculate the SHA-256 hash from the exact page
you reviewed; the refresh rejects the correction if the page changes first.
Re-running an identical review remains safe without a hash.

The model's `currentYear - 1` identifies the requested model period; it does
not prove that this is the latest published annual filing. The refreshed page
states the actual fiscal year without claiming it is the latest. Share price and
market cap are labelled as year-end, not current market data.

Run `npm run audit:company-review-coverage -- --check` to find overview pages
that are missing from both review manifests and audit inventories. The counts
describe inventory coverage, not whether every figure is current or correct.
Historical status reviews can include a separate source-checked financial review;
the pending count excludes pages with one, but includes other historical pages.

For a company that has been delisted, merged or otherwise ceased trading, first
record the event, date, primary source, exact page ticker and ISIN in a dated
`company-status.json` review. Verify any linked successor separately. Then run:

```bash
npm run mark:historical-companies -- --manifest company-content/reviews/2026-11-11-company-status.json
npm run mark:historical-companies -- --manifest company-content/reviews/2026-11-11-company-status.json --write
```

The first command checks the entire manifest without writing. The second removes
obsolete report orders and adds the reviewed status; it does not update financial
figures. Existing status pages are checked for consistency and re-runs are safe.

### Clarify historical overviews

The following command identifies older overviews that still call their figures
the latest and previews a wording correction. The `--write` option applies the
correction and updates the sitemap; it does not change any financial figures.

```bash
node scripts/clarify-historical-overviews.mjs
node scripts/clarify-historical-overviews.mjs --write
```

`company-content/reviews/2026-11-11-freshness-audit.json` records a read-only
Wisdom ticker, ISIN and model-year check of the remaining historical pages.
A newer model year only identifies a candidate for an annual-report review;
it does not validate the financial figures or establish whether a company is
still listed.

### Pilot source differences

- Aallon FY 2025: the annual report has EBIT of EUR 2.970m, while Wisdom has
  EUR 3.009m. Wisdom includes EUR 0.039m in other financial expenses; its EBIT
  and net financial expenses are each EUR 0.039m higher than the filing, with
  the same pre-tax profit. The upstream reason for the classification is not
  established. The filing reports year-end market cap of EUR 41.7m; Wisdom's
  EUR 40.695141m matches the year-end price multiplied by shares excluding
  treasury shares. The manifest uses the filing's reported values.
- Admicom FY 2025: the annual report has net earnings of EUR 5.307782m and
  year-end market cap of EUR 216.34m; Wisdom has EUR 5.379158m and EUR
  216.2351136m. The manifest uses the filing's reported values.

These observations do not justify applying the same adjustment to other
companies. Reconcile each reviewed page against its own filing.
