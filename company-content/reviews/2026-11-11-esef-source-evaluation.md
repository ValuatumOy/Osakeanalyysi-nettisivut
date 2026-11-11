# ESEF source comparison — 11 November 2026

The [filings.xbrl.org API](https://filings.xbrl.org/docs/api) indexes reports obtained from national filing sources and provides converted xBRL-JSON. Its [source and limitations](https://filings.xbrl.org/docs/about) describe missing countries, possible validation errors, and filings that may have been amended or published in several languages. ESMA has also [used this index for its ESEF data assessment](https://www.esma.europa.eu/sites/default/files/2025-04/ESMA12-1209242288-856_Report_on_Quality_and_Use_of_Data_2024.pdf).

In the 2025 index, 393 overview pages had one Nordic filing-entity name candidate after normalization. These are leads, not verified identities or necessarily annual reports; multiple pages can refer to one entity. The index also contains interim filings. A company name alone does not establish that an ISIN or share class is correct.

Run the read-only extractor on a downloaded xBRL-JSON filing:

```text
npm run audit:esef-candidate -- --file <filing.json> --lei <verified-LEI> --currency <ISO-currency> --period-start <YYYY-MM-DD> --period-end <YYYY-MM-DD>
```

It selects a small set of standard IFRS facts for the exact requested annual duration and matching year-end balance-sheet instant. Dimensional facts are ignored, conflicts or unexpected identities and currencies stop the extraction, and missing facts stay unavailable. Numeric facts must use the xBRL-JSON string representation. Values are in currency units, not millions. The command does not change pages or create an approved review.

An analyst must independently check the company/ISIN-to-LEI mapping, that the filing is the relevant audited annual report, the accounting scope, and each figure before using the existing reviewed refresh workflow. Standard facts may be missing or insufficient for the company's presentation; do not replace them with adjusted profit or a parent-company figure by guesswork.

Two examples were compared with their issuers' audited statements. [Rockwool FY2025](https://www.rockfon.com/globalassets/rockwool-prefab-building-systems/downloads/annual-report-2025.pdf) returned EUR 3,877m revenue, EUR 178m operating profit, EUR 28m owner earnings and EUR 2,741m owner equity. [Dovre FY2025](https://attachment.news.eu.nasdaq.com/ac7b7aec49810709219decb845c43a7b1) returned EUR 91.860m, EUR -66.325m, EUR -53.461m and EUR -48.011m respectively. Agreement in these two examples does not validate other filings.
