// Fetches the public report catalog that the static-page generators bake
// into their output. Always the live API — building from a stale local
// snapshot is the failure mode that once let the site serve outdated pages
// for weeks, so there is deliberately no file fallback, and any fetch
// problem is a hard error.
export const CATALOG_API_URL = 'https://www.aiequityreports.com/api/reports';

export async function fetchLiveCatalog() {
  const res = await fetch(CATALOG_API_URL);
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
