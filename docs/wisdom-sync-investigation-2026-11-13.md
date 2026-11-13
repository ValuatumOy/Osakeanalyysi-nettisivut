# Wisdom page-sync investigation, 13 November 2026

A read-only dry run against production Wisdom checked the company pages before
enabling the weekly sync. It found 1,621 pages unchanged, 193 candidate updates,
327 skipped and three unresolved tickers. All 193 candidate updates changed
only FY2025 net earnings; none changed the fiscal year or any other metric.

At least one candidate conflicts with the issuer's figures. The Alma Media page
shows EUR 55.7m for FY2025; Wisdom's primary model currently returns EUR 56.5m.
The [company's 2025 annual report](https://www.almamedia.fi/wp-content/uploads/2026/03/Alma-Media-Corporation-Annual-Report-2025.pdf)
reports EUR 55.7m profit for the period and EUR 55.4m attributable to owners.
The model's EUR 71.7m pre-tax profit also differs from the filing's EUR 70.7m.
The source and calculation of the difference have not yet been established.

Consequently the sync leaves a whole page unchanged whenever its net earnings
would change, even if the change is smaller than 20%. It also holds reviewed
pages, changes to or from N/A, larger changes and unverified fiscal-year moves.
Those safeguards prevent automatic publication of the known candidates; they do
not repair the underlying Wisdom models or prove that all other figures are
correct. The job summary lists pages that remain to be reviewed. Do not remove
the net-earnings hold until its calculation has been reconciled at the source.
