# Company page generator

`scripts/generate-company-pages.mjs` creates static company overview pages from
Wisdom financial model data. It fetches financial data on every run. Only the
AI-generated company profile is cached in `company-content/profiles/`.

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

Regenerate company profile text even when it is cached:

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
generated HTML pages. Use `--skip-discovery` only for isolated previews or tests.

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
