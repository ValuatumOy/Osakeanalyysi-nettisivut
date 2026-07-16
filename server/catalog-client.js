const { getReportByIdSync, getPublicReportsSync, recordCatalogPurchase: recordLocalPurchase } = require('./catalog');
const { REPORTS_CATALOG = [] } = require('../js/reportsData');
const READY_REPORT_PRICE = 20;

function catalogBaseUrl() {
  return (process.env.CATALOG_API_URL || '').replace(/\/$/, '');
}

function toBackendReport(report) {
  const normalized = normalizeCatalogReport(report);
  if (!normalized) return null;
  return {
    id: normalized.id,
    name: normalized.name || normalized.companyName,
    companyName: normalized.companyName || normalized.name,
    ticker: normalized.ticker || '',
    exchange: normalized.exchange || '',
    reportDate: normalized.reportDateLabel || normalized.reportDate,
    reportDateIso: normalized.reportDate,
    pdfUrl: normalized.pdfUrl,
    price: normalized.price,
    isFree: normalized.isFree,
    reportType: normalized.reportType,
    fileName: normalized.fileName,
  };
}

function normalizeCatalogReport(report) {
  if (!report) return null;
  const isFree = Boolean(report.isFree) || report.reportType === 'free' || Number(report.price) === 0;
  return {
    ...report,
    isFree,
    reportType: isFree ? 'free' : (report.reportType || 'existing'),
    price: isFree ? 0 : READY_REPORT_PRICE,
    priceLabel: isFree ? (report.priceLabel || 'Free report') : 'Ready report',
    creditCost: isFree ? 0 : (report.creditCost || 2),
  };
}

function getStaticCatalogReport(reportId) {
  return REPORTS_CATALOG.find(report => report.id === reportId) || null;
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
  const staticReport = getStaticCatalogReport(reportId);
  if (staticReport) return toBackendReport(staticReport);
  if (REPORTS_CATALOG.length) return null;

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
  if (REPORTS_CATALOG.length) {
    return REPORTS_CATALOG.map(normalizeCatalogReport).filter(Boolean);
  }

  const base = catalogBaseUrl();

  if (base) {
    try {
      const data = await fetchJson(`${base}/api/reports`);
      return Array.isArray(data.reports) ? data.reports.map(normalizeCatalogReport).filter(Boolean) : [];
    } catch (err) {
      console.warn('Catalog API list failed, using local fallback:', err.message);
    }
  }

  return getPublicReportsSync({ persistState: false }).map(normalizeCatalogReport).filter(Boolean);
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
