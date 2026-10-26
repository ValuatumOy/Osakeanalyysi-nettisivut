// Which site the report-page sync builds. Production by default. REPORT_PAGES_STAGE=test builds
// test.aiequityreports.com's pages from the test catalog and the test PDFs into test-site/,
// which only the test host sends readers to (docs/report-page-automation.md, "The test site").
export const IS_TEST = process.env.REPORT_PAGES_STAGE === 'test';
