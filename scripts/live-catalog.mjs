// Fetches the public report catalog that the static-page generators bake
// into their output. Always the live API — building from a stale local
// snapshot is the failure mode that once let the site serve outdated pages
// for weeks, so there is deliberately no file fallback, and any fetch
// problem is a hard error. REPORT_PAGES_STAGE=test reads the test site's
// catalog instead (scripts/report-pages/stage.mjs).
import { randomUUID } from 'node:crypto';

export const CATALOG_API_URL = process.env.REPORT_PAGES_STAGE === 'test'
  ? 'https://test.aiequityreports.com/api/reports'
  : 'https://www.aiequityreports.com/api/reports';

export async function fetchLiveCatalog() {
  // A unique query bypasses Vercel's s-maxage=300 cache after a delivery wake-up.
  const url = new URL(CATALOG_API_URL);
  url.searchParams.set('_report_pages_fresh', randomUUID());
  const res = await fetch(url.href, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Catalog fetch failed (HTTP ${res.status}) from ${CATALOG_API_URL}`);
  }
  const data = await res.json();
  const reports = Array.isArray(data) ? data : data && data.reports;
  if (!Array.isArray(reports)) {
    throw new Error(`Unexpected catalog payload from ${CATALOG_API_URL}`);
  }
  return reports;
}
