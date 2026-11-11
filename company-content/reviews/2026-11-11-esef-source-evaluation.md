# ESEF source comparison — 11 November 2026

The [filings.xbrl.org API](https://filings.xbrl.org/docs/api) indexes reports obtained from national filing sources and provides converted xBRL-JSON. Its [source and limitations](https://filings.xbrl.org/docs/about) describe missing countries, possible validation errors, and filings that may have been amended or published in several languages. ESMA has also [used this index for its ESEF data assessment](https://www.esma.europa.eu/sites/default/files/2025-04/ESMA12-1209242288-856_Report_on_Quality_and_Use_of_Data_2024.pdf).

In the 2025 index, 393 overview pages had one Nordic filing-entity name candidate after normalization. These are leads, not verified identities or necessarily annual reports; multiple pages can refer to one entity. The index also contains interim filings. A company name alone does not establish that an ISIN or share class is correct.

After the ninth refresh batch, an additional comparison used the [GLEIF/ANNA ISIN-to-LEI relationship file](https://www.gleif.org/en/lei-data/lei-mapping/download-isin-to-lei-relationship-files) published on 11 November 2026. Of 1,058 pages still awaiting a financial review, 814 had a single mapped LEI, and 411 of those LEIs also appeared in the 2025 filing index. Four of the latter pages had already been marked with a historical company status. These are still review candidates: the mapping does not establish that a listing remains active, that a filing is the relevant audited annual report, or that its facts are suitable for a particular metric. GLEIF notes that its mapping does not cover every ISIN.

To rebuild a review queue, download the GLEIF ZIP and the relevant [annual filing index](https://filings.xbrl.org/indexes/filings-2025.json), then run:

```text
python scripts/company-pages/esef-review-queue.py --mapping-zip <gleif.zip> --filings-json <filings-2025.json> --year 2025
```

The read-only command checks each page's current ISIN and ticker against its audit snapshot or earlier review, rejects ambiguous mappings and filing URLs that do not match the entity and period, and lists possible filings with validation counts and the original audit status. A financial review excludes a matching page only for its reviewed year or earlier; older reviews can re-enter the queue for a later year. By default it omits pages with recorded company-status notes and prints the first 20 matches; add `--include-status` to include those pages or `--limit 0` to print every match. Status notes include delistings as well as some active companies with changed names or listings. A match can be an interim filing, an amended report or an incorrectly tagged fact. It never approves figures or changes a company page.

Run the read-only extractor on a downloaded xBRL-JSON filing:

```text
npm run audit:esef-candidate -- --file <filing.json> --lei <verified-LEI> --currency <ISO-currency> --period-start <YYYY-MM-DD> --period-end <YYYY-MM-DD>
```

It selects a small set of standard IFRS facts for the exact requested annual duration and matching year-end balance-sheet instant. Dimensional facts are ignored, conflicts or unexpected identities and currencies stop the extraction, and missing facts stay unavailable. Numeric facts must use the xBRL-JSON string representation. Values are in currency units, not millions. The command does not change pages or create an approved review.

An analyst must independently check the company/ISIN-to-LEI mapping, that the filing is the relevant audited annual report, the accounting scope, and each figure before using the existing reviewed refresh workflow. Standard facts may be missing or insufficient for the company's presentation; do not replace them with adjusted profit or a parent-company figure by guesswork.

The 2025 Formpipe filing illustrates why the original statements still need checking: its standard revenue tag contains SEK 243.302m of total operating income, while the report identifies SEK 242.400m as revenue and SEK 0.902m as other operating income. Saga Pure's 2025 filing presents investment-related operating income rather than a comparable revenue total. Neither figure should be published as revenue solely because a tag or model field suggests it.

Two examples were compared with their issuers' audited statements. [Rockwool FY2025](https://www.rockfon.com/globalassets/rockwool-prefab-building-systems/downloads/annual-report-2025.pdf) returned EUR 3,877m revenue, EUR 178m operating profit, EUR 28m owner earnings and EUR 2,741m owner equity. [Dovre FY2025](https://attachment.news.eu.nasdaq.com/ac7b7aec49810709219decb845c43a7b1) returned EUR 91.860m, EUR -66.325m, EUR -53.461m and EUR -48.011m respectively. Agreement in these two examples does not validate other filings.

An exploratory comparison on 11 November 2026 examined 379 not-yet-reviewed pages displaying FY2025, using their first matching 31 December 2025 ESEF filing with no reported validation errors. It found a possible EBIT difference on 261 pages. This is a prioritisation lead, not a count of confirmed errors: some entities had multiple filing candidates, some identities require further investigation, many filings had warnings, and standard tags may represent a different subtotal. The comparison did not check year-end market values and did not update pages.

The reviewed FY2025 statements for AAK, Acast, Fagerhult Group and AF Gruppen confirm actual EBIT differences from the Wisdom production income-statement data used by the page generator. In all four, reported and Wisdom pre-tax profit agree, while the allocation between operating profit and net financial items differs. The calculation or source-row mapping responsible has not been established. For Acast, the model's net sales also differ from the reported amount by exactly the currency adjustment shown in the issuer's growth reconciliation; this match is a lead, not proof of its cause. The [batch 14 review](./2026-11-11-batch-14.json) records the values and primary sources. Correcting the public pages does not itself correct the underlying Wisdom model or automatically review the remaining pages.
