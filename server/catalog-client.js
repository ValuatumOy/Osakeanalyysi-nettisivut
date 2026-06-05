const { getReportByIdSync, getPublicReportsSync, recordCatalogPurchase: recordLocalPurchase } = require('./catalog');

function catalogBaseUrl() {
  return (process.env.CATALOG_API_URL || '').replace(/\/$/, '');
}

function toBackendReport(report) {
  if (!report) return null;
  return {
    id: report.id,
    name: report.name || report.companyName,
    companyName: report.companyName || report.name,
    ticker: report.ticker || '',
    exchange: report.exchange || '',
    reportDate: report.reportDateLabel || report.reportDate,
    reportDateIso: report.reportDate,
    pdfUrl: report.pdfUrl,
    price: Number(report.price),
    isFree: Boolean(report.isFree),
    reportType: report.reportType,
    fileName: report.fileName,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Catalog API failed with ${response.status}`);
  }
  return data;
}

async function getCatalogReport(reportId) {
  const base = catalogBaseUrl();

  if (base) {
    try {
      const data = await fetchJson(`${base}/api/reports/${encodeURIComponent(reportId)}`);
      return toBackendReport(data.report || data);
    } catch (err) {
      console.warn('Catalog API report lookup failed, using local fallback:', err.message);
    }
  }

  return toBackendReport(getReportByIdSync(reportId, { persistState: false }));
}

async function getCatalogReports() {
  const base = catalogBaseUrl();

  if (base) {
    try {
      const data = await fetchJson(`${base}/api/reports`);
      return Array.isArray(data.reports) ? data.reports : [];
    } catch (err) {
      console.warn('Catalog API list failed, using local fallback:', err.message);
    }
  }

  return getPublicReportsSync({ persistState: false });
}

async function recordCatalogPurchase(purchase) {
  const base = catalogBaseUrl();
  const secret = process.env.CATALOG_SYNC_SECRET || '';

  if (base && secret) {
    try {
      await fetchJson(`${base}/api/report-purchases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(purchase),
      });
      return;
    } catch (err) {
      console.warn('Catalog purchase sync failed, using local fallback:', err.message);
    }
  }

  recordLocalPurchase(purchase);
}

module.exports = {
  getCatalogReport,
  getCatalogReports,
  recordCatalogPurchase,
  toBackendReport,
};
