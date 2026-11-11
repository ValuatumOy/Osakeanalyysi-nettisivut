# ESEF comparison queue

Create a complete queue with `esef-review-queue.py --year 2025 --limit 0`, then run:

```text
npm run --silent audit:esef-compare -- --queue <complete-queue.json> --year 2025
```

The command prints JSON to stdout and does not write files. Redirect stdout to a separate review artifact if needed. It compares revenue, operating profit, parent-owner earnings and parent-owner equity only; share price and market capitalisation are outside its scope.

It checks the current page's ticker, ISIN and per-metric fiscal year, official filing URLs and validation counts. Unresolved identities and recorded company-status notes require a separate review. Filings with validation errors are skipped; warnings and source links remain visible. Multiple plausible filings are marked ambiguous, without choosing the first. A single filing must contain an unambiguous annual duration of 350–380 days ending on its stated fiscal end date; the existing fact extractor checks the exact entity, currency, annual duration and balance-sheet instant.

Each comparable field includes the displayed amount, its rounding tolerance, the source's raw currency-unit value, its value in millions and any difference. Unsupported or missing source facts remain unavailable. Results are **unreviewed leads**, including when all comparable figures agree. They do not establish that a filing is the correct audited source or that a standard XBRL concept has the right accounting meaning. Independently verify the original statements and listing identity before using the reviewed refresh workflow.

`no_variance_candidate` requires all four fields to be comparable and match; a match for only some fields is `partial_comparison`. Filing warnings produce a separate `_with_warnings` status. A valid filing accompanied by another filing with validation errors requires source review rather than automatic selection.

On 11 November 2026, a run against the then-current FY2025 queue returned 389 rows: 250 with one or more possible metric differences, 42 partial comparisons with no detected difference, 9 matches for all four fields, 71 ambiguous filings, 2 identities requiring review, and 15 other source or parsing cases. These categories are leads only, not confirmed errors or reviewed pages. The input queue excluded pages with an already-recorded company status; the amounts and categories will change as reviews are completed.

Focused offline verification:

```text
node --test test/company-pages/esef-compare-queue.test.mjs
```
