# Product Requirements Document: AI Equity Report Website

## 1. Product Context

### 1.1 Project Summary

This project is to build a commercial website for an AI-generated equity research report product. The website must allow users to discover companies, generate free report previews, purchase full reports, view sample reports, download professional PDF outputs, and provide behavioral data that helps Valuatum improve product quality, pricing, and market targeting.

The product is based on an automated equity analysis report pipeline that combines structured financial data, AI-generated company value mapping, value pool analysis, core investment analysis, reverse valuation, investment summary, and a professional HTML/PDF report template.

The website should not be treated as a generic SaaS landing page. It should be built as a conversion-oriented report commerce engine:

> Search company → See instant value → Generate free preview → Unlock full report → Download PDF → Upsell credits/subscription.

The strategic goal is to maximize user curiosity, trust, conversion, and data collection while avoiding overpromising or presenting the product as regulated investment advice.

---

## 2. Product Vision

### 2.1 Vision Statement

Create the fastest and most credible way for investors, analysts, founders, advisors, and finance professionals to generate a professional equity research-style report for any listed company.

The user should feel:

1. “This is not just a dashboard.”
2. “This looks like a real institutional-style equity research report.”
3. “I can understand the investment case faster than by starting from scratch.”
4. “The free preview is useful, but the full report is clearly worth unlocking.”
5. “I want to try another company.”

### 2.2 Core User Promise

Primary promise:

> Generate a professional AI equity research report and understand what the market must believe for a company’s valuation to make sense.

Alternative copy:

> Don’t start from a blank spreadsheet. Search a listed company and get a full AI-generated equity research report in minutes.

Finnish strategic equivalent:

> Älä aloita tyhjästä Excelistä. Luo valmis osakeanalyysiraportti ja näe, mitä markkina hinnoittelee.

### 2.3 Product Positioning

The product should be positioned as a report product first, not a full investment terminal.

Initial positioning:

> A professional AI equity report generator for listed companies.

Avoid these weaker positions:

- “AI stock picker”
- “AI investment advice”
- “Financial dashboard”
- “Another stock screener”
- “Chatbot for stocks”
- “Automated buy/sell signals”

This product should feel closer to:

- a professional research report shop
- an automated analyst workbench
- a premium PDF research product
- a fast valuation and investment case explainer

Not like:

- a retail stock app
- a meme-stock tool
- a generic AI chatbot
- a dashboard-only data product

---

## 3. Strategic Objectives

### 3.1 Business Objectives

The website must achieve the following business goals:

1. Convert visitors into free report users.
2. Convert free preview users into paid full report buyers.
3. Capture email leads from users who are not ready to buy.
4. Learn which companies, markets, sectors, and report sections create the highest purchase intent.
5. Test pricing willingness across single reports, bundles, and subscriptions.
6. Create SEO-indexable company report pages over time.
7. Build credibility through sample reports and transparent methodology.
8. Create a scalable base for future SaaS, subscription, and B2B offerings.

### 3.2 Product Objectives

The website must:

1. Make company search the main interaction.
2. Show value before asking for payment.
3. Make the report feel tangible before purchase.
4. Use locked sections to create curiosity without giving away the full report.
5. Use professional visual design consistent with the provided website design/repository, while allowing creative extensions for this product.
6. Support future report PDF examples and sample report assets.
7. Support dynamic pricing experiments.
8. Support analytics from day one.
9. Be modular enough for iteration.

### 3.3 Conversion Objectives

The product should optimize for these conversion events:

1. Visitor searches for a company.
2. Visitor generates a free preview.
3. Visitor enters email.
4. Visitor clicks locked section.
5. Visitor opens a sample report.
6. Visitor starts checkout.
7. Visitor completes purchase.
8. Visitor downloads PDF.
9. Visitor generates or purchases another report.
10. Visitor signs up for report credits or subscription.

---

## 4. Target Users

### 4.1 Primary User Segments

#### 4.1.1 Individual Active Investors

Users who invest in listed stocks and want a fast, structured view of a company.

Needs:

- Understand investment case quickly.
- Avoid reading dozens of fragmented sources.
- Get a report they can save, compare, or share.
- See valuation assumptions and risks.

Likely conversion trigger:

- Searches a company they already own or are considering buying.
- Sees a useful preview and unlocks the full report for convenience.

#### 4.1.2 Finance Professionals and Analysts

Users working in finance, advisory, research, valuation, corporate finance, IR, or wealth management.

Needs:

- Get a starting point for analysis.
- Create internal discussion material quickly.
- Compare companies faster.
- Use PDF outputs in workflows.

Likely conversion trigger:

- Needs many reports or recurring use.
- Buys report credits or subscription.

#### 4.1.3 Students and Early-Career Finance Users

Users learning equity research, valuation, or company analysis.

Needs:

- See how a professional report is structured.
- Understand value pools and reverse valuation.
- Learn from examples.

Likely conversion trigger:

- Free preview first, then low-price single reports.

#### 4.1.4 B2B / IR / Wealth / Advisory Buyers

Organizations that may want recurring reports, client-ready material, or customized outputs.

Needs:

- Scalable report generation.
- Branded outputs.
- Consistent methodology.
- Custom coverage lists.

Likely conversion trigger:

- Contact sales / request demo after seeing strong sample reports.

---

## 5. Product Scope

### 5.1 MVP Scope

The MVP should include:

1. Landing page.
2. Company search interface.
3. Free report preview flow.
4. Locked full report sections.
5. Sample report placeholders.
6. Pricing page.
7. Checkout flow placeholder or Stripe integration.
8. Report detail page.
9. PDF download placeholder or implementation hook.
10. Email capture.
11. Analytics event tracking.
12. Admin/analytics requirements specification, even if not fully implemented in the first UI version.
13. Legal disclaimer and methodology page.

### 5.2 Full Product Scope

The full product may eventually include:

1. Live report generation.
2. Pregenerated report library.
3. Dynamic pricing engine.
4. Report credit system.
5. User accounts.
6. Saved reports.
7. Watchlists.
8. Report regeneration when data updates.
9. Payment history.
10. Team accounts.
11. B2B custom plans.
12. Portfolio-level report generation.
13. API access.
14. White-label reports.
15. Human review add-on.
16. Alerts when valuation assumptions change.
17. Sector report bundles.
18. AI report comparison across companies.

---

## 6. Core Product Strategy

### 6.1 The Site Must Sell the Outcome, Not the Technology

Bad positioning:

> AI-powered stock analysis with advanced algorithms.

Better positioning:

> Search any listed company and unlock a professional equity research-style report.

The user does not primarily buy AI. The user buys:

- time saved
- structure
- clarity
- a PDF they can read/share
- a valuation perspective
- a starting point for investment analysis

### 6.2 Free Preview Must Be Useful but Incomplete

The free report preview should be genuinely useful, but it must not remove the need for the paid report.

Free preview should include:

- company name, ticker, market, sector
- basic valuation snapshot
- limited key metrics
- high-level value pool preview
- one short AI-generated insight
- one reverse valuation teaser
- visible locked sections

Free preview should not include full:

- core analysis
- full value pool deep dives
- full reverse valuation path
- risk analysis
- investment summary
- PDF download
- financial statement tables
- sensitivity analysis
- source/methodology appendix

### 6.3 The Locked Sections Should Sell Specific Value

Locked sections should not just say “Upgrade to view more.” They should show exactly what the user is missing.

Example locked section copy:

- “Unlock the full value pool map: see how enterprise value is allocated across business segments and future option pools.”
- “Unlock reverse valuation: see what revenue growth and EBIT margin path the current valuation implies.”
- “Unlock core analysis: read the full investment case, competitive position, risks, catalysts, and valuation reality check.”
- “Unlock PDF download: export the full institutional-style report.”

### 6.4 The Site Should Make Users Curious About Their Own Companies

The main psychological hook is not abstract product education. It is curiosity:

> What does the AI report say about Tesla?
> What does it think UPM’s value really comes from?
> Does it see the same risks I see?
> What does the valuation require?

The search bar should dominate the first screen.

### 6.5 The Product Should Start as Report Commerce, Then Expand into SaaS

Initial business model:

- single paid reports
- report credit packs
- free preview lead capture

Later expansion:

- subscription
- watchlists
- saved reports
- portfolio reporting
- recurring update reports
- B2B plans

This reduces initial complexity and makes early conversion testing easier.

---

## 7. Information Architecture

### 7.1 Required Pages

The website should include the following pages or routes.

#### 7.1.1 Home Page

Route examples:

- `/`
- `/en`

Purpose:

- Drive users into company search.
- Explain the product quickly.
- Showcase sample reports.
- Build trust.
- Present pricing entry points.

Primary CTA:

- “Generate free report”
- “Search company”

Secondary CTA:

- “View sample report”

#### 7.1.2 Company Search Page

Route examples:

- `/search`
- `/reports/search`

Purpose:

- Let users search listed companies.
- Show matching companies.
- Indicate whether report generation is available.

Features:

- Search by company name, ticker, exchange, ISIN if available.
- Autocomplete suggestions.
- Recently searched / trending companies.
- Market filters.
- Loading state.
- Empty state.
- Unsupported company state.

#### 7.1.3 Report Preview Page

Route examples:

- `/reports/[ticker]`
- `/reports/[company-slug]`

Purpose:

- Show the free preview.
- Sell the full report.
- Capture email.
- Trigger purchase.

Features:

- Company header.
- Key metrics.
- Free preview insights.
- Locked sections.
- Pricing CTA.
- Sample snippets.
- PDF preview image.
- Methodology note.
- Disclaimer.

#### 7.1.4 Full Report Page

Route examples:

- `/reports/[ticker]/full`
- `/app/reports/[report-id]`

Purpose:

- Display full purchased report in HTML.
- Allow PDF download.
- Allow regeneration/update if available.
- Allow next report purchase.

Features:

- Full report navigation.
- PDF download button.
- Save/report library if user accounts exist.
- Share/export options if allowed.
- Related reports.

#### 7.1.5 Sample Reports Page

Route examples:

- `/sample-reports`
- `/examples`

Purpose:

- Build trust through strong example reports.
- Let users see quality before buying.
- Provide placeholders where the agent can later add example PDF files.

Important implementation instruction:

- The agent should create clear sample report sections/cards/placeholders that can later be connected to real PDF files or screenshots.
- Do not require final PDF assets immediately.
- The page should look complete even with placeholder sample cards.

Suggested sample report slots:

1. Tesla / option-heavy company.
2. UPM or Stora Enso / asset-heavy company.
3. Nordea / bank or financial company.
4. Novo Nordisk or Kone / quality compounder.
5. Finnish mid-cap / smaller market example.

Each sample card should include:

- company name
- short description
- report type
- preview thumbnail placeholder
- “View sample report” CTA
- “PDF coming soon” or disabled state if no file is attached yet

#### 7.1.6 Pricing Page

Route examples:

- `/pricing`

Purpose:

- Explain free preview, single report, credits, and subscriptions.
- Support dynamic pricing experiments.

Suggested tiers:

1. Free Preview — €0
2. Single Full Report — dynamic, likely €9.90–€19.90
3. 5 Report Credits — €39–€59
4. 20 Report Credits — €129–€199
5. Pro Monthly — €49–€99/month
6. Enterprise — custom

The UI should allow pricing values to be configured easily from data/config.

#### 7.1.7 Methodology Page

Route examples:

- `/methodology`

Purpose:

- Explain the report method.
- Build credibility.
- Reduce AI skepticism.

Sections:

- Data inputs.
- Company value map.
- Enterprise value logic.
- Value pool analysis.
- Reverse valuation.
- Core analysis.
- Source discipline.
- Limitations.
- Not investment advice.

#### 7.1.8 About / Trust Page

Route examples:

- `/about`
- `/trust`

Purpose:

- Explain who is behind the product.
- Explain why users should trust it.
- Clarify limitations.

Sections:

- Built by Valuatum.
- Financial data and valuation background.
- AI-assisted, not human investment advice.
- Designed for research support.
- Transparent methodology.

#### 7.1.9 FAQ Page or Section

Could be on home/pricing/methodology.

Questions:

- Is this investment advice?
- Where does the data come from?
- How accurate are the reports?
- Can I download the report as PDF?
- Can I get a refund?
- Can I generate reports for any listed company?
- How often is data updated?
- Can I use reports commercially?
- Do you support Finnish companies?
- Do you support US companies?
- How does reverse valuation work?

#### 7.1.10 Legal / Disclaimer Page

Route examples:

- `/disclaimer`
- `/terms`
- `/privacy`

Purpose:

- State clearly that the product is not investment advice.
- Explain use of AI-generated content.
- Explain data limitations.
- Include refund/payment terms.
- Include privacy policy.

---

## 8. Homepage Requirements

### 8.1 Homepage Strategic Role

The homepage should behave like a search-driven product entry, not a traditional brochure page.

The top fold must answer:

1. What is this?
2. What can I do now?
3. Why should I trust it?
4. What happens after I search?

### 8.2 Homepage Hero

Hero requirements:

- Large company search input.
- Clear headline.
- Short subheadline.
- Primary CTA attached to search.
- Secondary sample report CTA.
- Trust indicators.

Suggested headline:

> Generate an AI equity research report for any listed company.

Suggested subheadline:

> Search a company, preview the investment case, and unlock a professional report with value pool analysis, reverse valuation, risks, catalysts, and financial tables.

Alternative sharper headline:

> See what the market must believe.

Alternative subheadline:

> Generate an AI equity research report that maps where company value comes from, what valuation implies, and what could break the investment case.

Search placeholder examples:

- “Search company or ticker, e.g. UPM, Tesla, Nordea…”
- “Enter company name or ticker…”

Primary CTA:

- “Generate free preview”

Secondary CTA:

- “View sample reports”

Hero trust indicators:

- “Free preview available”
- “PDF report unlock”
- “Built on financial data + AI analysis”
- “Not investment advice”

### 8.3 Homepage Sections

Recommended homepage order:

1. Hero with search.
2. Sample report cards.
3. What the full report includes.
4. How it works.
5. Why this is different.
6. Preview of report sections.
7. Pricing teaser.
8. Methodology/trust block.
9. FAQ.
10. Final search CTA.

### 8.4 Sample Report Section

Purpose:

- Prove report quality visually.
- Let users inspect examples before purchase.

Requirements:

- Create slots for future PDF thumbnails/screenshots.
- Use cards with placeholder visuals if PDFs are not yet provided.
- Each card must have a strong analytical angle.

Example cards:

#### Tesla

Title:

> Tesla: Option-heavy valuation case

Description:

> Example report showing how value pools such as automotive, software, Robotaxi, and robotics can be separated and tested.

#### UPM

Title:

> UPM: Asset-backed value and profitability case

Description:

> Example report showing how enterprise value, asset-backed businesses, segment economics, and reverse valuation can be analyzed without misleading market cap comparisons.

#### Nordea

Title:

> Nordea: Bank profitability and capital return case

Description:

> Example report showing how financial-sector reports can focus on profitability, capital, credit quality, payout, and valuation.

### 8.5 “What’s Inside the Report” Section

Must include:

1. Company snapshot.
2. Key metrics.
3. Company value map.
4. Value pool analysis.
5. Core investment analysis.
6. Reverse valuation.
7. Risks and catalysts.
8. Investment summary.
9. Financial tables.
10. Sources and methodology.
11. PDF download.

Each item should be concrete.

Bad:

> Advanced AI insights.

Good:

> Reverse valuation shows what revenue growth and EBIT margin path would be needed to justify the implied value.

### 8.6 “How It Works” Section

Three steps:

1. Search a listed company.
2. Generate a free preview.
3. Unlock the full report and download PDF.

Optional fourth step:

4. Compare with other companies or save to your report library.

### 8.7 “Why It’s Different” Section

Key differentiators:

1. Report-first, not dashboard-first.
2. Focus on enterprise value and value pools.
3. Reverse valuation explains what must happen.
4. Designed for professional reading, not just charts.
5. Free preview before purchase.

Potential copy:

> Most tools show more data. This product turns the data into a structured investment case.

### 8.8 Final CTA

End homepage with another search bar.

Final CTA headline:

> Try it with a company you already know.

Subheadline:

> Search a listed company and see the free preview before deciding whether to unlock the full report.

---

## 9. Report Preview Page Requirements

### 9.1 Page Objective

The report preview page is the most important conversion page.

Its purpose is to:

1. Prove that a report exists or can be generated.
2. Give enough value to create trust.
3. Make the locked sections desirable.
4. Convert to purchase.
5. Capture email if user does not buy.

### 9.2 Report Preview Page Structure

Recommended order:

1. Company header.
2. Key metric cards.
3. Free preview summary.
4. Value map teaser.
5. Reverse valuation teaser.
6. Locked full report sections.
7. Pricing/unlock CTA.
8. Sample PDF/report visual.
9. Methodology note.
10. Related companies.

### 9.3 Company Header

Fields:

- Company name
- Ticker
- Exchange
- Country
- Sector/industry
- Share price
- Market cap
- Enterprise value
- Report date
- Data date
- Report status: “Preview generated”, “Full report available”, “Generation pending”, etc.

CTA buttons:

- “Unlock full report”
- “Download sample PDF” if sample available
- “Generate another report”

### 9.4 Key Metrics Preview

Show 4–8 key metrics.

Potential metrics:

- Share price
- Market cap
- Enterprise value
- Net sales
- EBIT
- EBIT margin
- EPS
- P/E
- EV/EBIT
- EV/EBITDA
- Dividend yield

Do not overload the preview with too many metrics.

### 9.5 Free Preview Summary

Include a short preview insight.

Example structure:

> The preview suggests that [Company]’s valuation is primarily driven by [value pool 1] and [value pool 2]. The full report tests whether current profitability, segment economics, and reverse valuation assumptions are sufficient to justify the current enterprise value.

This should be generated dynamically later, but static placeholders are acceptable for the first website implementation.

### 9.6 Value Pool Teaser

Show only a partial value pool map.

Example:

- Show top 2 value pools unlocked.
- Blur or lock remaining value pools.
- Show “Unlock full EV allocation”.

Possible UI:

- partial pie chart
- horizontal allocation bars
- table with locked rows

Important content rule:

- Use enterprise value language.
- Avoid misleading market cap versus NAV comparisons.
- Avoid “free business”, “zero value”, or unsupported negative value language.

### 9.7 Reverse Valuation Teaser

Show a small teaser:

- Current price / implied fair value if available.
- One sentence: “The full report shows what growth and profitability path would be required.”
- Locked chart placeholder.

CTA:

> Unlock reverse valuation path

### 9.8 Locked Section Cards

Locked cards should include:

1. Full Company Value Map
2. Core Analysis
3. Reverse Valuation
4. Risk & Catalyst Analysis
5. Investment Summary
6. Financial Tables
7. PDF Download

Each card should show:

- icon or visual
- short explanation
- blurred preview text or placeholder
- lock icon
- CTA

Example locked card:

Title:

> Core Analysis

Description:

> A full value pool-based analysis of the company’s business model, competitive position, historical performance, valuation tension, scenarios, risks, and catalysts.

CTA:

> Unlock full analysis

### 9.9 Purchase CTA

The purchase CTA should be sticky on desktop and visible after key preview sections on mobile.

CTA content:

- price
- what is included
- PDF download
- instant access
- payment security

Example:

> Unlock full report — €19.90
> Includes full HTML report, PDF download, value pool map, reverse valuation, risks, catalysts, and financial tables.

Secondary:

> Get 5 report credits instead

### 9.10 Email Capture

Email capture should appear:

1. Before PDF sample download.
2. Before saving preview.
3. When user attempts to unlock but does not complete payment.
4. When user searches multiple companies.

Email value proposition:

- “Send me this preview”
- “Notify me when full report is ready”
- “Get a launch discount”
- “Save this report”

Avoid generic newsletter framing at first.

### 9.11 Related Reports

Show related companies:

- same sector
- same country
- popular searches
- competitors

Purpose:

- encourage additional searches
- increase session depth
- discover demand clusters

---

## 10. Full Report Page Requirements

### 10.1 Objective

The full report page should deliver the purchased value and encourage repeat use.

### 10.2 Required Full Report Sections

The full report should eventually include:

1. Cover / report header.
2. Executive summary.
3. Key numbers.
4. Share price development.
5. Company value map.
6. Segment/value pool breakdown.
7. Core analysis.
8. Reverse valuation.
9. Risks and catalysts.
10. Investment summary / recommendation, if included.
11. Financial statements and estimates.
12. Sources and methodology.
13. Disclaimer.

### 10.3 Full Report Navigation

The report should have a sidebar or top navigation with anchors:

- Summary
- Key Metrics
- Value Map
- Core Analysis
- Reverse Valuation
- Risks
- Financials
- Sources

### 10.4 PDF Download

PDF download should be prominent.

Requirements:

- Button near top.
- Button near bottom.
- Clear loading state.
- Indicate report date.
- File naming convention.

Suggested filename:

`Valuatum_AI_Equity_Report_[Ticker]_[YYYY-MM-DD].pdf`

### 10.5 Post-Purchase Upsell

After purchase, show:

- “Generate another report”
- “Buy 5 report credits”
- “Compare with peers”
- “Save to report library”

---

## 11. Pricing and Monetization

### 11.1 Pricing Philosophy

Pricing should be simple at first and dynamic later.

The product must support pricing experiments because the correct price is uncertain. The website should therefore use config-driven pricing rather than hardcoded values.

### 11.2 Initial Pricing Recommendation

Suggested initial visible pricing:

1. Free Preview — €0
2. Single Report — €19.90 standard, possible launch price €9.90
3. 5 Report Credits — €49
4. 20 Report Credits — €149
5. Pro — €79/month
6. Enterprise — custom

### 11.3 Dynamic Pricing Variables

The website should eventually support dynamic pricing based on:

- company popularity
- report complexity
- market/region
- user type
- number of reports generated
- first-time user discount
- abandoned checkout discount
- bundle purchase
- campaign source
- launch promotion
- B2B vs individual user
- report freshness
- whether report is pregenerated or live-generated

### 11.4 Dynamic Pricing Rules: Future Concept

Potential future rules:

1. First report discount:
   - First full report €9.90, normal €19.90.

2. Bundle anchor:
   - Single report €19.90.
   - 5 credits €49.
   - 20 credits €149.

3. Popular company premium:
   - High-demand reports priced at €19.90–€29.90.

4. Long-tail company discount:
   - Less popular companies at €9.90 to increase trial.

5. Email recovery:
   - If user starts checkout but does not pay, offer limited-time discount.

6. Professional plan:
   - Users with high search volume are shown Pro/credits earlier.

### 11.5 Pricing UI Requirements

Pricing UI should:

- Show free preview clearly.
- Make single report easy to buy.
- Use bundles as value anchors.
- Avoid overwhelming the user.
- Include FAQ and refund policy.
- Mention not investment advice.

### 11.6 Payment Requirements

Preferred payment provider:

- Stripe Checkout or equivalent.

Payment features:

- Single report purchase.
- Credit pack purchase.
- Subscription purchase, later.
- Payment success page.
- Payment cancel page.
- Receipt email.
- Report access after payment.

---

## 12. Analytics and Data Collection

### 12.1 Analytics Philosophy

The website is not only a sales channel. It is also a market demand discovery tool.

Every meaningful action should be tracked.

### 12.2 Required Events

Track at minimum:

#### Acquisition

- page_view
- traffic_source
- landing_page
- campaign_id
- referrer

#### Search

- company_search_started
- company_search_query
- company_search_result_clicked
- company_search_no_result
- unsupported_company_requested
- market_filter_used

#### Preview

- preview_generation_started
- preview_generation_completed
- preview_generation_failed
- preview_viewed
- preview_section_expanded
- locked_section_clicked
- sample_report_clicked

#### Lead Capture

- email_capture_shown
- email_submitted
- email_capture_skipped
- preview_sent_to_email

#### Pricing

- pricing_page_viewed
- price_seen
- plan_selected
- discount_seen
- checkout_started
- checkout_abandoned
- checkout_completed

#### Report Usage

- full_report_viewed
- pdf_download_clicked
- pdf_download_completed
- report_saved
- report_shared
- related_report_clicked

#### Retention

- returning_user_detected
- second_report_generated
- second_report_purchased
- credits_purchased
- subscription_started

### 12.3 Important Analytics Dimensions

For each event, include where possible:

- company name
- ticker
- exchange
- country
- sector
- market cap bucket
- user type if known
- price shown
- plan shown
- device type
- traffic source
- user status: anonymous, email captured, paid, subscriber
- report status: pregenerated, live-generated, unavailable

### 12.4 Most Important Dashboards

The admin/analytics dashboard should eventually show:

1. Top searched companies.
2. Top unsupported companies.
3. Preview-to-payment conversion.
4. Search-to-preview conversion.
5. Locked section click rates.
6. Most clicked locked sections.
7. Conversion by company type.
8. Conversion by country/market.
9. Conversion by price point.
10. Checkout abandonment.
11. PDF downloads.
12. Repeat purchases.
13. Email lead conversion.

### 12.5 Highest-Value Data Point

The most important early data point is:

> User searched company X, generated preview, clicked locked section Y, but did not buy at price Z.

This tells the team:

- what users want
- what section creates intent
- whether pricing is too high
- whether preview quality is insufficient
- which companies should be prioritized

---

## 13. Report Generation States

### 13.1 Required States

The website must handle these states gracefully:

1. Report available and pregenerated.
2. Report preview available, full report locked.
3. Report generation in progress.
4. Report generation failed.
5. Company not found.
6. Company found but report unavailable.
7. Financial data insufficient.
8. Payment successful, report unlocking.
9. Payment successful, report generation pending.
10. User has credits.
11. User has no credits.

### 13.2 Pregenerated vs Live-Generated Reports

Initial MVP should preferably support pregenerated reports for sample and high-demand companies.

Why:

- faster UX
- lower cost
- fewer generation failures
- easier quality control
- easier sample showcase

Live generation can be added later.

### 13.3 Generation UX

If generation is live:

- show progress steps
- do not fake precision
- provide fallback email capture
- allow user to leave and receive email

Example progress steps:

1. Loading financial data.
2. Mapping company value pools.
3. Running core analysis.
4. Building reverse valuation section.
5. Preparing report.

Do not show overly technical prompt names to users.

---

## 14. Design Requirements

### 14.1 Design Input

The implementation agent will receive a GitHub repository containing Valuatum’s new website design.

The agent should:

1. Reuse the design language where appropriate.
2. Keep brand consistency with Valuatum.
3. Use typography, spacing, colors, and components that feel connected to the existing site.
4. Be allowed to be creative for this new product.
5. Avoid making the site look like a generic template.
6. Avoid making the report product look like a cheap retail investing tool.

### 14.2 Desired Visual Feel

The product should feel:

- professional
- analytical
- premium
- modern
- trustworthy
- fast
- clean
- slightly AI-native, but not gimmicky

Avoid:

- crypto-style neon UI
- meme-stock visuals
- overly playful illustrations
- excessive gradients
- generic SaaS cards everywhere
- too much dashboard clutter
- too many tiny charts

### 14.3 Visual Metaphors

Useful visual metaphors:

- report pages
- valuation bridge
- value map
- company search
- institutional PDF preview
- financial table preview
- locked premium sections
- analysis layers being unlocked

### 14.4 Report Preview Visuals

The UI should show report previews as tangible assets:

- PDF page mockups
- report cover thumbnail
- blurred full report section
- partial chart previews
- locked tables

This makes the product feel concrete.

### 14.5 Layout Principles

1. Search first.
2. Large readable sections.
3. Use wide charts/tables rather than many small cards.
4. Use professional whitespace.
5. Use strong section hierarchy.
6. Make CTAs obvious but not aggressive.
7. Make locked content visible enough to create desire.
8. Use sticky CTA on report preview pages.

### 14.6 Mobile Requirements

Mobile must support:

- search
- preview reading
- locked section cards
- checkout CTA
- PDF/sample preview CTA

Mobile report pages should not become unusably dense.

---

## 15. Content and Copy Requirements

### 15.1 Tone

The tone should be:

- professional
- clear
- confident
- precise
- not hype-driven
- not investment-advice-like

Avoid:

- “Beat the market with AI”
- “Guaranteed alpha”
- “Buy/sell recommendation engine”
- “The only tool you need”
- “AI knows what stocks will go up”

### 15.2 Core Copy Blocks

#### Hero Copy Option A

Headline:

> Generate a professional AI equity research report.

Subheadline:

> Search a listed company and unlock a structured report covering value pools, reverse valuation, risks, catalysts, financials, and the investment case.

CTA:

> Generate free preview

#### Hero Copy Option B

Headline:

> See what the market must believe.

Subheadline:

> Generate an AI equity report that maps where company value comes from, what valuation implies, and what could break the investment case.

CTA:

> Search company

#### Hero Copy Option C

Headline:

> Equity research reports, generated in minutes.

Subheadline:

> Get a professional report with company value mapping, reverse valuation, full analysis, and PDF download.

CTA:

> Try free preview

### 15.3 Report Section Copy

#### Company Value Map

> See how enterprise value is allocated across the company’s current businesses, assets, and future value pools.

#### Core Analysis

> Read a full value pool-based analysis of business quality, competitive position, valuation tension, risks, scenarios, and catalysts.

#### Reverse Valuation

> Understand what revenue growth, margins, and cash flow path would be required for the valuation to make sense.

#### Risk Analysis

> Identify what could break the investment case, from profitability pressure to execution risk and valuation assumptions.

#### PDF Download

> Export the full report as a professional PDF for reading, sharing, or internal work.

### 15.4 Legal Copy Snippet

Short disclaimer for pages:

> Reports are AI-generated research materials for informational purposes only. They are not investment advice, recommendations, or offers to buy or sell securities. Always perform your own analysis before making investment decisions.

Long disclaimer should live on separate legal page.

---

## 16. Sample PDF / Report Asset Requirements

### 16.1 Current State

The implementation agent will later receive example PDF files of high-quality equity analysis reports.

These files are not available at the beginning of implementation.

### 16.2 Agent Instruction

The agent must create clear, well-designed placeholders for sample PDFs and sample report screenshots.

The implementation should make it easy to later add:

- PDF files
- PDF thumbnails
- report screenshots
- company-specific sample pages
- downloadable sample reports

### 16.3 Required Sample Asset Slots

Create sample report cards for at least:

1. Tesla — option-heavy / future value pools.
2. UPM or Stora Enso — asset-heavy / enterprise value and NAV discipline.
3. Nordea — bank / financial sector.
4. Novo Nordisk, Kone, or similar — quality growth / compounder.
5. Finnish mid-cap — local market relevance.

### 16.4 Sample Card Data Model

Each sample card should support:

- id
- companyName
- ticker
- market
- title
- shortDescription
- reportType
- pdfUrl
- thumbnailUrl
- isAvailable
- tags

Example:

```json
{
  "id": "tesla-sample",
  "companyName": "Tesla",
  "ticker": "TSLA",
  "market": "NASDAQ",
  "title": "Option-heavy valuation case",
  "shortDescription": "A sample report showing how current automotive earnings and future option pools can be separated and tested.",
  "reportType": "AI Equity Report",
  "pdfUrl": null,
  "thumbnailUrl": null,
  "isAvailable": false,
  "tags": ["Option value", "Reverse valuation", "Value pools"]
}
```

---

## 17. Functional Requirements

### 17.1 Company Search

Requirements:

- Search by company name.
- Search by ticker.
- Support exchange suffixes if available.
- Autocomplete results.
- Show company metadata.
- Handle unsupported companies.
- Track searches.

Search result fields:

- company name
- ticker
- exchange
- country
- sector
- report availability status

Availability states:

- “Preview available”
- “Full report available”
- “Can generate”
- “Coming soon”
- “Unsupported”

### 17.2 Report Preview Generation

Requirements:

- User can generate free preview.
- Preview may be mock/static in first version if backend is not connected.
- UI must support future live backend.
- Loading state required.
- Error state required.
- Email fallback required.

### 17.3 Locked Content

Requirements:

- Show locked full sections.
- Make locked sections clickable.
- Track clicks.
- Open purchase modal or scroll to purchase CTA.
- Do not hide all content behind a paywall; show enough to create desire.

### 17.4 Purchase Flow

Requirements:

- Single report purchase CTA.
- Credit pack purchase CTA.
- Future subscription CTA.
- Payment success page.
- Payment cancel page.
- Unlock full report after successful payment.

### 17.5 Email Capture

Requirements:

- Capture email for preview saving.
- Capture email for report notification.
- Capture email for launch discount.
- Track source of email capture.

### 17.6 User Account: Future

Not required for first static MVP, but design should allow later addition.

Future features:

- login
- saved reports
- credit balance
- invoices
- report history
- team accounts

### 17.7 Report Library: Future

Users may eventually have a report library:

- generated reports
- purchased reports
- saved previews
- downloaded PDFs
- watchlist companies

### 17.8 Admin Requirements: Future

Admin should eventually manage:

- available companies
- sample reports
- pricing config
- generated reports
- failed generations
- user searches
- purchases
- PDF assets
- discount campaigns

---

## 18. Non-Functional Requirements

### 18.1 Performance

The site should feel fast.

Targets:

- Landing page loads quickly.
- Search feels instant.
- Preview page should not feel blocked.
- Use skeleton states.
- Defer heavy PDF previews if needed.

### 18.2 SEO

SEO is strategically important.

Requirements:

- Indexable landing page.
- Indexable sample report pages.
- Eventually indexable company report preview pages.
- Dynamic meta titles.
- Structured headings.
- Clean URLs.
- Open Graph images.

SEO title examples:

- “Tesla AI Equity Report | Value Pools, Reverse Valuation & Risks”
- “UPM Equity Analysis Report | AI Research Preview”
- “AI Equity Research Reports | Valuatum”

### 18.3 Accessibility

Requirements:

- Semantic HTML.
- Keyboard-accessible search and buttons.
- Sufficient contrast.
- Screen-reader friendly labels.
- Clear focus states.

### 18.4 Security

Requirements:

- Do not expose paid report content without authorization.
- Protect payment success report access.
- Validate report IDs.
- Avoid leaking user emails.

### 18.5 Compliance

Requirements:

- Clear disclaimer.
- Avoid investment advice claims.
- Avoid guaranteed return language.
- Clarify AI-generated limitations.
- Include data and methodology caveats.

---

## 19. Technical Architecture Assumptions

### 19.1 Frontend

The agent will receive an existing GitHub repository with the new website design.

The implementation should integrate into that design system.

Possible frontend assumptions:

- React / Next.js / Astro / similar depending on repository.
- Component-based structure.
- Config-driven content.
- Reusable report cards and pricing components.

The agent should inspect the repository and follow existing conventions.

### 19.2 Backend/API: Future

The site should be designed to connect later to APIs for:

- company search
- report generation
- report status
- payment
- PDF delivery
- user account
- analytics
- pricing

### 19.3 Suggested Data Objects

#### Company

```json
{
  "id": "upm-he",
  "name": "UPM-Kymmene Oyj",
  "ticker": "UPM.HE",
  "exchange": "Helsinki",
  "country": "Finland",
  "sector": "Materials",
  "industry": "Paper & Forest Products",
  "marketCap": 7720000000,
  "enterpriseValue": 10500000000,
  "currency": "EUR",
  "reportAvailability": "preview_available"
}
```

#### Report Preview

```json
{
  "reportId": "report_upm_he_2026_05_26",
  "companyId": "upm-he",
  "status": "preview_available",
  "reportDate": "2026-05-26",
  "dataDate": "2026-05-25",
  "previewSummary": "...",
  "keyMetrics": [],
  "valuePoolPreview": [],
  "lockedSections": [],
  "price": {
    "currency": "EUR",
    "singleReport": 19.9,
    "launchPrice": 9.9
  }
}
```

#### Pricing Config

```json
{
  "currency": "EUR",
  "singleReport": {
    "basePrice": 19.9,
    "launchPrice": 9.9,
    "enabled": true
  },
  "creditPacks": [
    {
      "credits": 5,
      "price": 49,
      "enabled": true
    },
    {
      "credits": 20,
      "price": 149,
      "enabled": true
    }
  ],
  "subscription": {
    "monthlyPrice": 79,
    "enabled": false
  }
}
```

---

## 20. Conversion Strategy

### 20.1 Primary Conversion Loop

The site’s main loop:

1. User searches a company.
2. User gets free preview.
3. User sees locked sections.
4. User clicks a locked section.
5. User sees price and report contents.
6. User purchases.
7. User downloads report.
8. User is prompted to generate another report.

### 20.2 Trust Before Payment

Do not ask for payment before showing value.

Trust assets:

- sample report cards
- PDF preview images
- methodology page
- visible structured sections
- clear financial metrics
- professional design
- transparent limitations

### 20.3 Curiosity Triggers

The UI should trigger curiosity using:

- “What does the market need to believe?”
- “Unlock full value pool map”
- “See reverse valuation path”
- “See what could break the investment case”
- “Compare with peers”
- “View full PDF report”

### 20.4 Urgency Without Fake Scarcity

Avoid fake countdowns.

Acceptable urgency:

- launch pricing
- first report discount
- limited beta access
- “save this preview”

### 20.5 Repeat Purchase Strategy

After a report purchase:

- suggest peer companies
- suggest credit pack
- show “compare with another company”
- offer discount for next report
- allow user to enter another company immediately

---

## 21. Acceptance Criteria

### 21.1 MVP Acceptance Criteria

The first implementation is acceptable if:

1. Homepage has a strong search-first hero.
2. User can search/select a company, even if mocked.
3. Report preview page exists.
4. Preview page shows unlocked and locked content.
5. Locked content clearly sells the full report.
6. Pricing section exists and is configurable.
7. Sample report placeholders exist and can later accept PDF files.
8. Methodology and disclaimer content exist.
9. CTAs are clear across desktop and mobile.
10. The design feels connected to the provided Valuatum website design but still creatively adapted to this product.
11. The site does not overclaim investment advice.
12. Analytics event points are planned or stubbed.

### 21.2 Conversion Acceptance Criteria

The implementation should make it obvious how a user moves through:

Search → Preview → Locked Section Click → Purchase CTA → Checkout → Full Report/PDF.

### 21.3 Content Acceptance Criteria

The implementation should avoid:

- vague AI hype
- unsupported investment advice claims
- too many generic cards
- copy that sounds like a stock recommendation
- hiding the product behind too much explanation

The implementation should emphasize:

- report quality
- value pool analysis
- reverse valuation
- financial data
- PDF output
- free preview
- professional workflow

---

## 22. Implementation Instructions for the Agent

### 22.1 General Instruction

Use the provided GitHub repository and design system as the basis for the website. Follow existing conventions, component style, typography, spacing, and brand direction where appropriate. However, this product page is allowed to be more creative and conversion-focused than a standard corporate page.

### 22.2 Design Creativity

The agent may introduce:

- report preview mockups
- locked content cards
- search-first hero layout
- pricing cards
- PDF/sample report cards
- value map visuals
- reverse valuation preview visuals
- subtle AI-native details

But should avoid:

- breaking the brand completely
- making the product look like a crypto or consumer trading app
- excessive visual clutter
- overly playful illustrations

### 22.3 Content Placeholders

Where backend/report data is not yet available, use realistic placeholder data and clearly structured mock objects.

Create placeholders for:

- sample PDFs
- report thumbnails
- company search data
- pricing config
- analytics event hooks
- report preview content

### 22.4 Component Suggestions

Potential components:

- `CompanySearchHero`
- `CompanySearchInput`
- `CompanyResultCard`
- `ReportPreviewHeader`
- `KeyMetricGrid`
- `ValuePoolPreview`
- `ReverseValuationTeaser`
- `LockedSectionCard`
- `PricingCards`
- `SampleReportCard`
- `MethodologyBlock`
- `DisclaimerBanner`
- `ReportCTAStickyCard`
- `FAQAccordion`
- `ReportPageNavigation`

### 22.5 Suggested Initial Routes

Depending on framework:

- `/`
- `/reports`
- `/reports/[slug]`
- `/sample-reports`
- `/pricing`
- `/methodology`
- `/disclaimer`
- `/checkout/success`
- `/checkout/cancel`

### 22.6 Backend Independence

The first version should be able to run without the final backend.

Use mock data/config files so the frontend can be reviewed and iterated before final APIs exist.

Suggested mock files:

- `mockCompanies.ts`
- `mockReports.ts`
- `pricingConfig.ts`
- `sampleReports.ts`
- `lockedSections.ts`

---

## 23. Risks and Mitigations

### 23.1 Risk: Free Preview Gives Away Too Much

Mitigation:

- Keep free preview useful but incomplete.
- Lock full analysis, reverse valuation, risks, financial tables, PDF.

### 23.2 Risk: Users Do Not Trust AI-Generated Reports

Mitigation:

- Show sample reports.
- Explain methodology.
- Use professional design.
- Mention sources and limitations.
- Avoid hype.

### 23.3 Risk: Users Think It Is Investment Advice

Mitigation:

- Use clear disclaimers.
- Avoid buy/sell guarantee language.
- Frame as research material.

### 23.4 Risk: Product Looks Like Generic SaaS

Mitigation:

- Make report preview central.
- Use tangible PDF/report visuals.
- Avoid generic “AI insights” cards.

### 23.5 Risk: Pricing Is Wrong

Mitigation:

- Config-driven pricing.
- Track price shown and conversion.
- Test single report vs bundle.

### 23.6 Risk: Report Generation Fails or Is Slow

Mitigation:

- Use pregenerated reports first.
- Show progress states.
- Capture email for completion notification.

### 23.7 Risk: Users Search Unsupported Companies

Mitigation:

- Capture unsupported searches.
- Show “request this report” CTA.
- Prioritize most requested companies.

---

## 24. Future Roadmap

### 24.1 Phase 1: Conversion MVP

- Landing page.
- Search-first hero.
- Mock/pregenerated company reports.
- Free preview page.
- Locked sections.
- Sample report placeholders.
- Pricing.
- Email capture.
- Checkout placeholder or Stripe checkout.

### 24.2 Phase 2: Paid Report Delivery

- Real payment integration.
- Full report unlock.
- PDF download.
- Report access control.
- Basic user email/account state.
- Admin view for purchases and searches.

### 24.3 Phase 3: Live Report Generation

- Connect report generation backend.
- Report generation status.
- Failure handling.
- Email notification.
- Regeneration/update logic.

### 24.4 Phase 4: Credits and Subscriptions

- Credit wallet.
- Credit packs.
- Monthly Pro plan.
- Saved reports.
- Report history.

### 24.5 Phase 5: Advanced Product

- Watchlists.
- Peer comparison.
- Portfolio analysis.
- Alerts.
- Team accounts.
- White-label reports.
- API.
- B2B dashboards.

---

## 25. Final Strategic Guidance

This website should not simply explain that Valuatum has an AI equity report product. It should let users experience the product immediately.

The strongest version of the website is built around this sequence:

> Search a company → Get a free preview → See locked professional sections → Unlock the full report → Download PDF → Generate another report.

The product should feel premium, credible, and useful before payment. The free preview should create trust, while the locked sections create desire.

The website’s job is not only to sell reports. It must also teach Valuatum:

- which companies users care about
- which markets have demand
- which report sections create purchase intent
- what price users tolerate
- whether single reports, bundles, or subscriptions convert best

The implementation should therefore prioritize conversion clarity, analytics readiness, report tangibility, and future extensibility over building a large generic marketing site.

