# Wisdom corrections from the 11 November 2026 filing reviews

Company pages now always show Wisdom's figures (`scripts/sync-company-pages.mjs`), so a figure that is wrong in Wisdom is wrong on the page and in the report alike. This list collects the differences the filing reviews of 11 November found, for correction in Wisdom. After a correction, the weekly sync puts the new figure on the page.

Generated from the review manifests in `company-content/reviews/` (filing value vs the Wisdom snapshot taken during the review). Differences under 0.5 % are left out. Not every row is a Wisdom error: market capitalisation in particular can differ by definition (treasury shares, unlisted share classes, a second listing). Each row needs a check against the source before Wisdom is changed.

Explained cases with more detail: [model-classification-findings](../company-content/reviews/2026-11-11-model-classification-findings.md) (Aallon, Rockwool, Embracer, Duell) and [esef-source-evaluation](../company-content/reviews/2026-11-11-esef-source-evaluation.md). The ESEF comparison also flagged 261 further pages with a possible EBIT difference; those are leads that have not been checked.

## Most important

- **Summa Defence (SUMMA.HE) FY 2025**: Wisdom still has the preliminary March 2026 figures (EBIT -19.842, net earnings -21.988, book value 168.4). The final audited statements: EBIT -21.804, net earnings -24.443, owner equity 166.464 (EUR m), after a c. EUR 2m goodwill impairment.
- **Rockwool (ROCK-B.CO) FY 2025**: Wisdom EBIT 568 excludes the EUR -392m Russian business value adjustment; reported EBIT is 178.

## Differing values (80 rows, 46 companies)

| Field | Ticker | Page | FY | Ccy | Wisdom | Filing | Diff | Source |
|---|---|---|---|---|--:|--:|--:|---|
| Revenue | GOD.OL | goodtech | 2025 | NOK | 848.60 | 724.00 | 17.2 % | [filing](https://mnd-assets.mynewsdesk.com/image/upload/f_pdf%2Cfl_attachment/pk491rrqyvr02j17szd4bu) |
| Revenue | ACAST.ST | acast | 2025 | SEK | 2,418 | 2,517 | 3.9 % | [filing](https://attachment.news.eu.nasdaq.com/a5333ee241c5a3695cb7f917a402097f0) |
| Revenue | TAL1T.TL | as-tallink-grupp | 2025 | EUR | 793.14 | 765.29 | 3.6 % | [filing](https://attachment.news.eu.nasdaq.com/a4bfc4f2a7566177c13dafa5278f6e07e) |
| Revenue | CIBUS.ST | cibus | 2025 | EUR | 192.34 | 188.80 | 1.9 % | [filing](https://attachment.news.eu.nasdaq.com/a87bac281ad88d093b7b868df39294ba1) |
| EBIT | CONTX.OL | contextvision | 2025 | SEK | -2.94 | 0.42 | 804.3 % | [filing](https://storage.mfn.se/78a1fac3-8215-4526-b855-aa647d050773/contextvision-annual-report-2025.pdf) |
| EBIT | ACAST.ST | acast | 2025 | SEK | -79.50 | -18.04 | 340.8 % | [filing](https://attachment.news.eu.nasdaq.com/a5333ee241c5a3695cb7f917a402097f0) |
| EBIT | ROCK-B.CO | rockwool | 2025 | EUR | 568.11 | 178.00 | 219.2 % | [filing](https://www.rockfon.com/globalassets/rockwool-prefab-building-systems/downloads/annual-report-2025.pdf) |
| EBIT | MSON-B.ST | midsona | 2025 | SEK | 134.00 | 58.00 | 131.0 % | [filing](https://storage.mfn.se/a/midsona/49a04be2-6233-4e64-97ad-5a9a6cf6c805/midsona-annual-report-2025.pdf) |
| EBIT | GOD.OL | goodtech | 2025 | NOK | 14.41 | 36.60 | 60.6 % | [filing](https://mnd-assets.mynewsdesk.com/image/upload/f_pdf%2Cfl_attachment/pk491rrqyvr02j17szd4bu) |
| EBIT | PEN.OL | panoro-energy | 2025 | USD | 46.10 | 29.73 | 55.1 % | [filing](https://www.panoroenergy.com/wp-content/uploads/2026/04/Panoro-Annual-Report-Web-Version.pdf) |
| EBIT | TAL1T.TL | as-tallink-grupp | 2025 | EUR | 71.15 | 50.30 | 41.5 % | [filing](https://attachment.news.eu.nasdaq.com/a4bfc4f2a7566177c13dafa5278f6e07e) |
| EBIT | FSKRS.HE | fiskars | 2025 | EUR | 51.90 | 38.10 | 36.2 % | [filing](https://fiskarsgroup.com/wp-content/uploads/2026/02/FiskarsGroup_Annual_Report_2025.pdf) |
| EBIT | ELUX-B.ST | ab-electrolux | 2025 | SEK | 2,341 | 3,657 | 36.0 % | [filing](https://www.electroluxgroup.com/wp-content/uploads/sites/2/2026/02/Annual-Report-2025-1.pdf) |
| EBIT | AFG.OL | af-gruppen | 2025 | NOK | 2,219 | 1,662 | 33.5 % | [filing](https://www.afgruppen.com/49bf71/siteassets/investor-ovrig-innhold/annual-general-meeting/af-annual-report-2025.pdf) |
| EBIT | ALIF-B.ST | addlife | 2025 | SEK | 780.00 | 993.00 | 21.5 % | [filing](https://www.add.life/media/2pbl1ybt/addlife-annual-report-2025.pdf) |
| EBIT | AFRY.ST | afry | 2025 | SEK | 1,665 | 1,387 | 20.0 % | [filing](https://afry.com/sites/default/files/2026-03/annual_and_sustainability_report_2025.pdf) |
| EBIT | AMBEA.ST | ambea | 2025 | SEK | 1,202 | 1,379 | 12.8 % | [filing](https://mb.cision.com/Main/5048/4328625/4015461.pdf) |
| EBIT | BOOZT.ST | boozt | 2025 | SEK | 446.83 | 404.00 | 10.6 % | [filing](https://storage.mfn.se/dfadd7c7-d227-4293-b084-99295099a7a2/uk-boozt-annual-report-2025.pdf) |
| EBIT | SUMMA.HE | summa-defence | 2025 | EUR | -19.84 | -21.80 | 9.0 % | [filing](https://attachment.news.eu.nasdaq.com/a65ef1702f89a1bd5feab30f1bc6be59b) |
| EBIT | ALFA.ST | alfa-laval-corporate | 2025 | SEK | 12,790 | 11,749 | 8.9 % | [filing](https://www.alfalaval.com/globalassets/documents/investors/english/annual-reports/2025/annual-and-sustainability-report-2025.pdf) |
| EBIT | FAG.ST | ab-fagerhult-publ | 2025 | SEK | 531.30 | 577.50 | 8.0 % | [filing](https://storage.mfn.se/3ab35679-736b-4072-9606-1b4ac93b3b80/fagerhult-group-annual-and-sustainability-report-2025.pdf) |
| EBIT | EPI-A.ST | epiroc | 2025 | SEK | 12,689 | 11,925 | 6.4 % | [filing](https://reports.epirocgroup.com/annual-and-sustainability-report-2025/) |
| EBIT | AAK.ST | aak-ab-publ | 2025 | SEK | 4,456 | 4,675 | 4.7 % | [filing](https://storage.mfn.se/c0ccfa59-3ca3-4597-9f78-1f0588efbc27/aak-annual-report-2025.pdf) |
| EBIT | SKF-B.ST | ab-skf | 2025 | SEK | 7,498 | 7,755 | 3.3 % | [filing](https://cdn.skfmediahub.skf.com/api/public/096ee325b273e74a/pdf_preview_medium/SKF_ASR_2025_ENG_locked_pdf_preview_medium.pdf) |
| EBIT | ALIG.ST | alimak-group | 2025 | SEK | 1,002 | 977.00 | 2.6 % | [filing](https://corporate.alimakgroup.com/en/wp-content/uploads/sites/2/2021/10/AlimakGroup-AR-2025-ENG.pdf) |
| EBIT | EMBRAC-B.ST | embracer-group | 2026 | SEK | -7,187 | -7,053 | 1.9 % | [filing](https://embracer.com/wp-content/uploads/2026/06/Embracer-Group-publishes-annual-report-202526-260618.pdf) |
| EBIT | HUSQ-B.ST | husqvarna | 2025 | SEK | 2,920 | 2,898 | 0.8 % | [filing](https://www.husqvarnagroup.com/sites/husqvarna/files/2026-03/202603249629-1.pdf) |
| EBIT | APETIT.HE | apetit | 2025 | EUR | 13.60 | 13.70 | 0.7 % | [filing](https://apetit.fi/app/uploads/2026/06/taloudellinen-katsaus_2025.pdf) |
| Net earnings | STRO.OL | strongpoint | 2025 | NOK | -4.97 | -1.03 | 384.0 % | [filing](https://www.strongpoint.com/app/uploads/2026/03/strongpoint-asa-annual-report-2025-screen.pdf) |
| Net earnings | TAL1T.TL | as-tallink-grupp | 2025 | EUR | 69.90 | 17.26 | 304.9 % | [filing](https://attachment.news.eu.nasdaq.com/a4bfc4f2a7566177c13dafa5278f6e07e) |
| Net earnings | TNOM.HE | talenom | 2025 | EUR | 1.05 | 0.46 | 127.2 % | [filing](https://storage.googleapis.com/inderes-widgets-prod-assets/talenom/attachments/882cced8-0863-44d2-a52c-47388d293af3/talenom-annual-review-2025.pdf) |
| Net earnings | CONTX.OL | contextvision | 2025 | SEK | -0.08 | 0.79 | 109.9 % | [filing](https://storage.mfn.se/78a1fac3-8215-4526-b855-aa647d050773/contextvision-annual-report-2025.pdf) |
| Net earnings | WWI.OL | wilh-wilhelmsen-holding | 2025 | USD | 998.00 | 652.00 | 53.1 % | [filing](https://www.wilhelmsen.com/globalassets/investor-relations/annual-report/wwh-annual-report-2025-web2.pdf) |
| Net earnings | GOD.OL | goodtech | 2025 | NOK | 9.88 | 18.90 | 47.7 % | [filing](https://mnd-assets.mynewsdesk.com/image/upload/f_pdf%2Cfl_attachment/pk491rrqyvr02j17szd4bu) |
| Net earnings | AFG.OL | af-gruppen | 2025 | NOK | 1,288 | 1,093 | 17.8 % | [filing](https://www.afgruppen.com/49bf71/siteassets/investor-ovrig-innhold/annual-general-meeting/af-annual-report-2025.pdf) |
| Net earnings | SUMMA.HE | summa-defence | 2025 | EUR | -21.99 | -24.44 | 10.0 % | [filing](https://attachment.news.eu.nasdaq.com/a65ef1702f89a1bd5feab30f1bc6be59b) |
| Net earnings | SKF-B.ST | ab-skf | 2025 | SEK | 4,168 | 3,927 | 6.1 % | [filing](https://cdn.skfmediahub.skf.com/api/public/096ee325b273e74a/pdf_preview_medium/SKF_ASR_2025_ENG_locked_pdf_preview_medium.pdf) |
| Net earnings | DURC-B.ST | duroc | 2026 | SEK | -106.71 | -100.90 | 5.8 % | [filing](https://www.duroc.se/upl/files/266882/duroc-arsredovisning-2025-2026.pdf?t=844159740) |
| Net earnings | APETIT.HE | apetit | 2025 | EUR | 8.50 | 9.00 | 5.6 % | [filing](https://apetit.fi/app/uploads/2026/06/taloudellinen-katsaus_2025.pdf) |
| Net earnings | ENRO.ST | eniro-group | 2025 | SEK | 45.00 | 46.00 | 2.2 % | [filing](https://www.enirogroup.com/media/w0abgh2a/a-rsredovisning_2025.pdf) |
| Net earnings | FSKRS.HE | fiskars | 2025 | EUR | 9.50 | 9.30 | 2.2 % | [filing](https://fiskarsgroup.com/wp-content/uploads/2026/02/FiskarsGroup_Annual_Report_2025.pdf) |
| Net earnings | CIBUS.ST | cibus | 2025 | EUR | 93.11 | 91.40 | 1.9 % | [filing](https://attachment.news.eu.nasdaq.com/a87bac281ad88d093b7b868df39294ba1) |
| Net earnings | ADMCM.HE | admicom | 2025 | EUR | 5.38 | 5.31 | 1.3 % | [filing](https://www.admicom.com/hubfs/Admicom%20-%20sijoittajat/Admicom%20-%20Vuosikertomus%202025.pdf) |
| Book value | K2A-B.ST | k2a-knaust-and-andersson-fastigheter | 2025 | SEK | 1,822 | 2,272 | 19.8 % | [filing](https://attachment.news.eu.nasdaq.com/a1ab2e0832de6d8b708c56d8fd3cd45a3) |
| Book value | TAL1T.TL | as-tallink-grupp | 2025 | EUR | 848.85 | 750.07 | 13.2 % | [filing](https://attachment.news.eu.nasdaq.com/a4bfc4f2a7566177c13dafa5278f6e07e) |
| Book value | STRO.OL | strongpoint | 2025 | NOK | 477.62 | 485.12 | 1.5 % | [filing](https://www.strongpoint.com/app/uploads/2026/03/strongpoint-asa-annual-report-2025-screen.pdf) |
| Book value | GOD.OL | goodtech | 2025 | NOK | 273.46 | 277.00 | 1.3 % | [filing](https://mnd-assets.mynewsdesk.com/image/upload/f_pdf%2Cfl_attachment/pk491rrqyvr02j17szd4bu) |
| Book value | SUMMA.HE | summa-defence | 2025 | EUR | 168.43 | 166.46 | 1.2 % | [filing](https://attachment.news.eu.nasdaq.com/a65ef1702f89a1bd5feab30f1bc6be59b) |
| Book value | PEN.OL | panoro-energy | 2025 | USD | 220.79 | 223.07 | 1.0 % | [filing](https://www.panoroenergy.com/wp-content/uploads/2026/04/Panoro-Annual-Report-Web-Version.pdf) |
| Share price | ENRO.ST | eniro-group | 2025 | SEK | 19.50 | 0.39 | 4900.0 % | [filing](https://www.enirogroup.com/media/w0abgh2a/a-rsredovisning_2025.pdf) |
| Share price | ASMDEE-B.ST | asmodee-group | 2026 | SEK | 9.68 | 106.34 | 90.9 % | [filing](https://view.news.eu.nasdaq.com/view?id=b94aa90633c9f152b69bda7ae7c5944f4&lang=en&src=micro) |
| Share price | BOOZT.ST | boozt | 2025 | SEK | 77.90 | 113.50 | 31.4 % | [filing](https://storage.mfn.se/dfadd7c7-d227-4293-b084-99295099a7a2/uk-boozt-annual-report-2025.pdf) |
| Share price | TAL1T.TL | as-tallink-grupp | 2025 | EUR | 0.61 | 0.58 | 4.1 % | [filing](https://attachment.news.eu.nasdaq.com/a4bfc4f2a7566177c13dafa5278f6e07e) |
| Share price | MNTC.ST | mentice | 2025 | SEK | 13.35 | 13.00 | 2.7 % | [filing](https://storage.mfn.se/900844b2-bc91-4b47-858c-115e171ea986/260421-mentice-ar25-en.pdf) |
| Share price | CONTX.OL | contextvision | 2025 | NOK | 4.24 | 4.20 | 1.0 % | [filing](https://storage.mfn.se/78a1fac3-8215-4526-b855-aa647d050773/contextvision-annual-report-2025.pdf) |
| Share price | EMBRAC-B.ST | embracer-group | 2026 | SEK | 48.05 | 48.34 | 0.6 % | [filing](https://embracer.com/wp-content/uploads/2026/06/Embracer-Group-publishes-annual-report-202526-260618.pdf) |
| Market cap | ENRO.ST | eniro-group | 2025 | SEK | 14,196 | 284.00 | 4898.6 % | [filing](https://www.enirogroup.com/media/w0abgh2a/a-rsredovisning_2025.pdf) |
| Market cap | ASMDEE-B.ST | asmodee-group | 2026 | SEK | 2,262 | 24,851 | 90.9 % | [filing](https://view.news.eu.nasdaq.com/view?id=b94aa90633c9f152b69bda7ae7c5944f4&lang=en&src=micro) |
| Market cap | EMIL-PREF.ST | fastighetsbolaget-emilshus | 2025 | SEK | 3,741 | 7,736 | 51.6 % | [filing](https://www.emilshus.com/sv/wp-content/uploads/sites/4/2026/04/Emilshus_2025_ENG_print.pdf) |
| Market cap | CORE-B.ST | corem-property-group | 2025 | SEK | 5,580 | 11,000 | 49.3 % | [filing](https://www.corem.se/app/uploads/2026/05/corem_annual-report-and-sustainability-report-2025.pdf) |
| Market cap | ACRI-B.ST | acrinova | 2025 | SEK | 669.84 | 456.00 | 46.9 % | [filing](https://mb.cision.com/Main/12091/4329685/4018630.pdf) |
| Market cap | FPAR-A.ST | fastpartner | 2025 | SEK | 12,109 | 8,603 | 40.7 % | [filing](https://fastpartner.se/media/fastpartner_annual_report_2025_en.pdf) |
| Market cap | EMBRAC-B.ST | embracer-group | 2026 | SEK | 10,235 | 11,000 | 7.0 % | [filing](https://embracer.com/wp-content/uploads/2026/06/Embracer-Group-publishes-annual-report-202526-260618.pdf) |
| Market cap | TAL1T.TL | as-tallink-grupp | 2025 | EUR | 452.09 | 434.20 | 4.1 % | [filing](https://attachment.news.eu.nasdaq.com/a4bfc4f2a7566177c13dafa5278f6e07e) |
| Market cap | ADDT-B.ST | addtech-ab-publ | 2026 | SEK | 85,739 | 82,554 | 3.9 % | [filing](https://attachment.news.eu.nasdaq.com/ac2b2a30f0737d7194e8c35f9dc83e54d) |
| Market cap | EPI-A.ST | epiroc | 2025 | SEK | 253,778 | 245,716 | 3.3 % | [filing](https://reports.epirocgroup.com/annual-and-sustainability-report-2025/) |
| Market cap | BERG-B.ST | bergman-and-beving | 2026 | SEK | 7,193 | 7,408 | 2.9 % | [filing](https://bergmanbeving.com/en/investors/financial-reports-and-presentations/annual-report-2025-2026) |
| Market cap | MNTC.ST | mentice | 2025 | SEK | 375.48 | 365.60 | 2.7 % | [filing](https://storage.mfn.se/900844b2-bc91-4b47-858c-115e171ea986/260421-mentice-ar25-en.pdf) |
| Market cap | AALLON.HE | aallon-group | 2025 | EUR | 40.70 | 41.70 | 2.4 % | [filing](https://aallon.fi/wp-content/uploads/2026/02/20260223_AALLON-Vuosikatsaus-2025-.pdf) |
| Market cap | MATAS.CO | matas | 2026 | DKK | 3,915 | 4,000 | 2.1 % | [filing](https://storage.mfn.se/b6059eb5-1b05-4ad8-a9a2-84e8ee59f625/matasgroup-ar-2025-26-final.pdf) |
| Market cap | AMBEA.ST | ambea | 2025 | SEK | 11,826 | 11,601 | 1.9 % | [filing](https://mb.cision.com/Main/5048/4328625/4015461.pdf) |
| Market cap | CONTX.OL | contextvision | 2025 | NOK | 322.23 | 328.00 | 1.8 % | [filing](https://storage.mfn.se/78a1fac3-8215-4526-b855-aa647d050773/contextvision-annual-report-2025.pdf) |
| Market cap | APETIT.HE | apetit | 2025 | EUR | 86.07 | 87.50 | 1.6 % | [filing](https://apetit.fi/app/uploads/2026/06/taloudellinen-katsaus_2025.pdf) |
| Market cap | NEOLA.ST | neola-medical | 2025 | SEK | 81.25 | 82.60 | 1.6 % | [filing](https://storage.mfn.se/56fc16b2-6ee6-47da-9f0d-d02beb396aec/arsredovisning-neola-medical-2025.pdf) |
| Market cap | VINCIT.HE | vincit | 2025 | EUR | 21.42 | 21.70 | 1.3 % | [filing](https://ir-cdn.inderes.com/assets/vincit/calendar-event-attachments/9c7e7228-cdb2-41b4-8da5-a0a800da1dde/vincit-financial-statements-and-board-of-directors-report.pdf) |
| Market cap | HUSQ-B.ST | husqvarna | 2025 | SEK | 26,590 | 26,783 | 0.7 % | [filing](https://www.husqvarnagroup.com/sites/husqvarna/files/2026-03/202603249629-1.pdf) |
| Market cap | CHEMM.CO | chemometec | 2026 | DKK | 6,265 | 6,303 | 0.6 % | [filing](https://attachment.news.eu.nasdaq.com/a772ca2d52624dd57c81a282b8e1fb8aa) |
| Market cap | ROCK-B.CO | rockwool | 2025 | DKK | 46,276 | 46,542 | 0.6 % | [filing](https://www.rockfon.com/globalassets/rockwool-prefab-building-systems/downloads/annual-report-2025.pdf) |
| Market cap | ITERA.OL | itera | 2025 | NOK | 701.11 | 705.00 | 0.6 % | [filing](https://www.itera.com/annual-report-2025) |
| Market cap | ACAST.ST | acast | 2025 | SEK | 6,236 | 6,268 | 0.5 % | [filing](https://attachment.news.eu.nasdaq.com/a5333ee241c5a3695cb7f917a402097f0) |

## Wisdom behind the filed year (27 companies)

The filing review found a newer annual report than the Wisdom model's latest actual year. Until Wisdom has that year, the sync leaves these pages as they are (it never moves a page back to an older year) and lists them as skipped.

| Ticker | Page | Wisdom FY | Filed FY | Source |
|---|---|--:|--:|---|
| ARR.OL | arribatec-solutions | 2024 | 2025 | [filing](https://live.euronext.com/sites/default/files/company_press_releases/attachments_oslo/2026/04/29/671741_Arribatec%20Annual%20Report%202025.pdf) |
| ASML | asml | 2024 | 2025 | [filing](https://ourbrand.asml.com/m/71076aaad607de4d/original/asml-2025-annual-report-based-on-us-gaap.pdf) |
| CALVIK.ST | job-solution-sweden-holding | 2024 | 2025 | [filing](https://storage.mfn.se/50211e8b-a182-4311-8e5a-5855b3ebdcc3/calviks-arsredovisning-2025.pdf) |
| CAVEN.OL | cavendish-hydrogen | 2024 | 2025 | [filing](https://storage.mfn.se/b8f44dc8-9c62-4295-a501-37c4a246b9d1/cavendish-hydrogen-asa-annual-report-2025.pdf) |
| CEDER.ST | cedergrenska | 2024 | 2026 | [filing](https://storage.mfn.se/2c2a663e-c0d1-4f55-843c-c1d12b5ad84e/cedergrenska-arsredovisning-2025-26.pdf) |
| CYVIZ.OL | cyviz-as | 2024 | 2025 | [filing](https://www.cyviz.com/wp-content/uploads/2026/05/Cyviz-Annual-Report-2025.pdf) |
| DIAH.ST | diadrom-holding | 2024 | 2025 | [filing](https://storage.mfn.se/8c7d6640-4964-4928-886f-75d93c0d14b0/arsredovisning-2025.pdf) |
| EAGLE.HE | loudspring | 2021 | 2025 | [filing](https://eaglefiltersgroup.com/site/wp-content/uploads/2026/04/Eagle-Filters-Group-konsernitilinpaatos-2025.pdf) |
| ELABS.OL | elliptic-laboratories | 2024 | 2025 | [filing](https://storage.mfn.se/9ba0657c-2240-4d45-b46b-44e38993403c/annual-report-2025-elliptic-laboratories-asa.pdf) |
| ENSU.OL | ensurge-micropower | 2024 | 2025 | [filing](https://live.euronext.com/sites/default/files/company_press_releases/attachments_oslo/2026/04/10/670411_Ensurge_annual_2025_FINAL.pdf) |
| EQVA.OL | eqva | 2024 | 2025 | [filing](https://storage.mfn.se/c/aHR0cHM6Ly9hcGkzLm9zbG8ub3Nsb2JvcnMubm8vdjEvbmV3c3JlYWRlci9hdHRhY2htZW50P21lc3NhZ2VJZD02NzIxMjEmYXR0YWNobWVudElkPTMyNDc2NA/annual-report-eqva-asa-2025.pdf?news-id=3608e784-4737-5cbe-8eaa-fdb3a5e3bce0) |
| HUDL.OL | huddlestock-fintech-as | 2024 | 2025 | [filing](https://storage.mfn.se/2dd2cb78-0d45-432c-90f2-7df4988a3199/huddlestock-group-annual-report-2025.pdf) |
| HYPRO.OL | hydrogenpro | 2024 | 2025 | [filing](https://live.euronext.com/sites/default/files/company_press_releases/attachments_oslo/2026/03/27/669527_FINAL%20Annual%20Report%202025.pdf?VersionId=F.UoWZXnCJ4RkR8zGD_GrU7gsaEfc29j) |
| IDEX.OL | idex-biometrics | 2024 | 2025 | [filing](https://storage.mfn.se/dd5515b8-481a-48c7-a9ad-cf4ff45cb43b/2025-idex-biometrics-asa-annual-report.pdf) |
| ININ.OL | elop-as | 2021 | 2025 | [filing](https://inin.no/wp-content/uploads/2026/05/ININ_2025-Arsrapport_inkl.-revisjonsberetning.pdf) |
| IOX.OL | interoil-exploration-and-production | 2024 | 2025 | [filing](https://interoil.no/wp-content/uploads/pdfs/reports/interoil-annual-report-2025-and-independent-auditors-report.pdf) |
| JDT.ST | jondetech-sensors | 2024 | 2025 | [filing](https://storage.mfn.se/95c8b3db-3675-477d-a107-acf8275dbcf6/jondetech-sensors-ab-publ-arsredovisning-2025.pdf) |
| LOHILO.ST | lohilo-foods | 2024 | 2025 | [filing](https://mb.cision.com/Main/19752/4341044/4061783.pdf) |
| LYTIX.OL | lytix-biopharma-as | 2024 | 2025 | [filing](https://storage.mfn.se/c/aHR0cHM6Ly9hcGkzLm9zbG8ub3Nsb2JvcnMubm8vdjEvbmV3c3JlYWRlci9hdHRhY2htZW50P21lc3NhZ2VJZD02NjkxMzcmYXR0YWNobWVudElkPTMyMTk0NA/2025-lytix-annual-report-final-2023-03-23.pdf?news-id=58a3b800-0925-5fb8-a127-85ec26ce652d) |
| NORSE.OL | norse-atlantic | 2024 | 2025 | [filing](https://live.euronext.com/en/products/equities/company-news/2026-04-30-norse-atlantic-asa-annual-report-2025) |
| OMDA.OL | csam-health-group-as | 2022 | 2025 | [filing](https://live.euronext.com/sites/default/files/company_press_releases/attachments_oslo/2026/04/10/670348_Omda%20Annual%20Report%202025.pdf) |
| RACE.MI | ferrari | 2024 | 2025 | [filing](https://ferrari.scene7.com/is/content/ferrari/Ferrari_Annual_Report_2025_20F%20Form) |
| SAGA-B.ST | ab-sagax | 2024 | 2025 | [filing](https://www.sagax.se/sites/default/files/pr/20260416-c55602b6-73fb-4c6c-9f17-d754717aa7bd-1.pdf) |
| SAGA.OL | saga-pure | 2024 | 2025 | [filing](https://mb.cision.com/Main/20232/4338125/4050609.pdf) |
| SCANA.OL | scana | 2024 | 2025 | [filing](https://scana.no/wp-content/uploads/2026/04/2025-MD-Annual-report-260422.pdf) |
| VOW.OL | vow | 2024 | 2025 | [filing](https://www.vowasa.com/wp-content/uploads/2026/04/Vow-Annual-and-Sustainability-Report-2025.pdf) |
| WSTEP.OL | webstep | 2024 | 2025 | [filing](https://s22.q4cdn.com/155297899/files/doc_financials/2025/ar/WSTEP-Annual-report-2025.pdf) |
