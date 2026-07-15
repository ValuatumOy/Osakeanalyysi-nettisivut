const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const READY_REPORT_PRICE = 20;

const DEFAULT_RULES = {
  visibleAfterDays: intEnv('REPORT_VISIBLE_AFTER_DAYS', 5),
  freeCount: intEnv('REPORT_FREE_COUNT', 3),
  freeEligibleAfterDays: intEnv('REPORT_FREE_ELIGIBLE_AFTER_DAYS', 7),
  recentPurchaseCooldownDays: intEnv('REPORT_FREE_PURCHASE_COOLDOWN_DAYS', 7),
  repeatCooldownWeeks: intEnv('REPORT_FREE_REPEAT_COOLDOWN_WEEKS', 8),
  priceTiers: priceTiersEnv(),
};

const DEFAULT_PDF_DIR = process.env.REPORT_PDF_DIR || '/var/www/html/reports/pdfs';
const DEFAULT_PDF_BASE_URL = process.env.REPORT_PDF_BASE_URL || 'https://files.valuatum.com/reports/pdfs';
const DEFAULT_MANIFEST_PATH = process.env.REPORT_CATALOG_MANIFEST_PATH || path.join(__dirname, 'report-manifest.json');
const DEFAULT_STATE_PATH = process.env.REPORT_CATALOG_STATE_PATH || path.join(__dirname, 'data', 'catalog-state.json');

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function priceTiersEnv() {
  if (process.env.REPORT_PRICE_TIERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.REPORT_PRICE_TIERS_JSON);
      if (Array.isArray(parsed) && parsed.length) return normalizePriceTiers(parsed);
    } catch (err) {
      console.warn('REPORT_PRICE_TIERS_JSON ignored:', err.message);
    }
  }

  return normalizePriceTiers([
    { minAgeDays: 0, price: 20, label: 'Ready report' },
  ]);
}

function normalizePriceTiers(tiers) {
  return tiers
    .map(tier => ({
      minAgeDays: Number(tier.minAgeDays) || 0,
      price: Number(tier.price),
      label: tier.label || null,
    }))
    .filter(tier => Number.isFinite(tier.price) && tier.price >= 0)
    .sort((a, b) => a.minAgeDays - b.minAgeDays);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function normalizeManifest(raw) {
  const reports = Array.isArray(raw?.reports)
    ? raw.reports
    : Array.isArray(raw)
      ? raw
      : Object.entries(raw || {}).map(([fileName, meta]) => ({ fileName, ...meta }));

  const byFileName = new Map();
  for (const report of reports) {
    if (!report?.fileName) continue;
    byFileName.set(report.fileName, report);
  }
  return { reports, byFileName };
}

function scanPdfDir(pdfDir) {
  try {
    return fs.readdirSync(pdfDir)
      .filter(fileName => /\.pdf$/i.test(fileName))
      .map(fileName => {
        const fullPath = path.join(pdfDir, fileName);
        const stat = fs.statSync(fullPath);
        return {
          fileName,
          uploadedAt: stat.mtime.toISOString(),
          size: stat.size,
        };
      });
  } catch (_) {
    return [];
  }
}

function readSidecarMeta(pdfDir, fileName) {
  const sidecarPath = path.join(pdfDir, fileName.replace(/\.pdf$/i, '.json'));
  const sidecar = readJson(sidecarPath, null);
  return sidecar && typeof sidecar === 'object' ? sidecar : {};
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseReportDateFromFileName(fileName) {
  const match = String(fileName || '').match(/(\d{8})(?=\.pdf$|[^0-9])/i);
  if (!match) return null;

  const raw = match[1];
  const first = Number(raw.slice(0, 2));
  const second = Number(raw.slice(2, 4));

  if (first >= 1 && first <= 31 && second >= 1 && second <= 12) {
    return `${raw.slice(4, 8)}-${raw.slice(2, 4)}-${raw.slice(0, 2)}`;
  }

  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoDate(value, fallback = new Date()) {
  const date = parseDate(value) || fallback;
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function daysSince(dateValue, now = new Date()) {
  const date = parseDate(dateValue);
  if (!date) return 0;
  return Math.max(0, Math.floor((startOfUtcDay(now) - startOfUtcDay(date)) / MS_PER_DAY));
}

function addDays(dateValue, days) {
  const date = parseDate(dateValue) || new Date();
  return new Date(date.getTime() + (days * MS_PER_DAY));
}

function maxDate(...values) {
  const dates = values.map(parseDate).filter(Boolean);
  if (!dates.length) return new Date();
  return new Date(Math.max(...dates.map(date => date.getTime())));
}

function formatDateLabel(dateValue) {
  const date = parseDate(dateValue);
  if (!date) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function calculatePrice(ageDays, rules = DEFAULT_RULES) {
  const tier = [...rules.priceTiers].reverse().find(item => ageDays >= item.minAgeDays) || rules.priceTiers[0];
  return {
    price: tier?.price ?? 20,
    priceLabel: tier?.label || null,
  };
}

function weekKey(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / MS_PER_DAY) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function previousWeekKeys(currentWeekKey, count) {
  const [yearPart, weekPart] = currentWeekKey.split('-W');
  const keys = [];
  let year = Number(yearPart);
  let week = Number(weekPart);
  for (let i = 0; i < count; i += 1) {
    week -= 1;
    if (week < 1) {
      year -= 1;
      week = 52;
    }
    keys.push(`${year}-W${String(week).padStart(2, '0')}`);
  }
  return keys;
}

function seededScore(seed, id) {
  const hash = crypto.createHash('sha256').update(`${seed}:${id}`).digest('hex').slice(0, 12);
  return Number.parseInt(hash, 16);
}

function recentPurchaseMatches(report, purchase) {
  if (purchase.reportId && purchase.reportId === report.id) return true;
  if (purchase.fileName && purchase.fileName === report.fileName) return true;
  if (purchase.ticker && report.ticker && normalizeTicker(purchase.ticker) === normalizeTicker(report.ticker)) return true;
  if (purchase.companyName && normalizeName(purchase.companyName) === normalizeName(report.companyName)) return true;
  return false;
}

function hasRecentPurchase(report, state, rules, now) {
  const cutoff = now.getTime() - (rules.recentPurchaseCooldownDays * MS_PER_DAY);
  return (state.purchases || []).some(purchase => {
    const purchasedAt = parseDate(purchase.purchasedAt);
    return purchasedAt && purchasedAt.getTime() >= cutoff && recentPurchaseMatches(report, purchase);
  });
}

function selectWeeklyFreeIds(reports, state, rules, now) {
  const currentWeek = weekKey(now);
  state.freeSelections = state.freeSelections || {};

  const existing = Array.isArray(state.freeSelections[currentWeek])
    ? state.freeSelections[currentWeek]
    : [];

  const existingValid = existing.filter(id => reports.some(report => report.id === id));
  if (existingValid.length >= rules.freeCount) return existingValid.slice(0, rules.freeCount);

  const previousIds = new Set(
    previousWeekKeys(currentWeek, rules.repeatCooldownWeeks)
      .flatMap(key => state.freeSelections[key] || [])
  );

  const eligible = reports.filter(report =>
    report.availability === 'available' &&
    !report.forceFree &&
    !report.excludeFromFree &&
    report.ageDays >= rules.freeEligibleAfterDays &&
    !hasRecentPurchase(report, state, rules, now)
  );

  const preferred = eligible.filter(report => !previousIds.has(report.id));
  const pool = preferred.length >= rules.freeCount ? preferred : eligible;
  const selected = pool
    .sort((a, b) => seededScore(currentWeek, a.id) - seededScore(currentWeek, b.id))
    .slice(0, rules.freeCount)
    .map(report => report.id);

  state.freeSelections[currentWeek] = selected;
  return selected;
}

function buildRawReports(options = {}) {
  const now = options.now || new Date();
  const rules = options.rules || DEFAULT_RULES;
  const manifestPath = options.manifestPath || DEFAULT_MANIFEST_PATH;
  const pdfDir = options.pdfDir || DEFAULT_PDF_DIR;
  const pdfBaseUrl = options.pdfBaseUrl || DEFAULT_PDF_BASE_URL;

  const manifest = normalizeManifest(readJson(manifestPath, { reports: [] }));
  const scanned = scanPdfDir(pdfDir);
  const byFileName = new Map(scanned.map(file => [file.fileName, file]));

  for (const meta of manifest.reports) {
    if (meta.fileName && !byFileName.has(meta.fileName)) {
      byFileName.set(meta.fileName, {
        fileName: meta.fileName,
        uploadedAt: meta.uploadedAt || meta.reportDate || parseReportDateFromFileName(meta.fileName) || now.toISOString(),
        size: null,
      });
    }
  }

  return Array.from(byFileName.values()).filter(file => file.size !== null).map(file => {
    const sidecarMeta = readSidecarMeta(pdfDir, file.fileName);
    const meta = {
      ...(manifest.byFileName.get(file.fileName) || {}),
      ...sidecarMeta,
    };
    const parsedDate = parseReportDateFromFileName(file.fileName);
    const reportDate = toIsoDate(meta.reportDate || parsedDate || file.uploadedAt, now);
    const uploadedAt = (parseDate(meta.uploadedAt || file.uploadedAt || reportDate) || now).toISOString();
    const availabilityBaseDate = maxDate(reportDate, uploadedAt);
    const availableAt = meta.availableAt
      ? (parseDate(meta.availableAt) || availabilityBaseDate)
      : addDays(availabilityBaseDate, rules.visibleAfterDays);
    const forceVisible = Boolean(meta.forceVisible);
    const availability = meta.hidden
      ? 'hidden'
      : forceVisible || now >= availableAt
        ? 'available'
        : 'hidden';
    const ageDays = daysSince(reportDate, now);
    const pricing = meta.price != null
      ? { price: Number(meta.price), priceLabel: meta.priceLabel || null }
      : calculatePrice(ageDays, rules);
    const baseCompany = meta.companyName || meta.name || file.fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
    const fileSlug = slugify(file.fileName.replace(/\.pdf$/i, ''));
    const id = meta.id || fileSlug || slugify(`${baseCompany}-${reportDate.replace(/-/g, '')}`);

    return {
      id,
      companyName: baseCompany,
      name: baseCompany,
      ticker: normalizeTicker(meta.ticker || ''),
      exchange: meta.exchange || 'Unknown',
      country: meta.country || '',
      sector: meta.sector || 'Unclassified',
      reportDate,
      reportDateLabel: formatDateLabel(reportDate),
      uploadedAt,
      availableAt: availableAt.toISOString(),
      fileName: file.fileName,
      pdfUrl: meta.pdfUrl || `${pdfBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(file.fileName)}`,
      availability,
      price: pricing.price,
      priceLabel: pricing.priceLabel,
      forceFree: Boolean(meta.forceFree),
      excludeFromFree: Boolean(meta.excludeFromFree),
      description: meta.description || `AI equity report for ${baseCompany}.`,
      tags: Array.isArray(meta.tags) && meta.tags.length ? meta.tags : ['AI Equity Report', 'PDF'],
      ageDays,
    };
  });
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  const state = readJson(statePath, {});
  return {
    purchases: Array.isArray(state.purchases) ? state.purchases : [],
    freeSelections: state.freeSelections || {},
  };
}

function saveState(state, statePath = DEFAULT_STATE_PATH) {
  try {
    writeJson(statePath, state);
  } catch (err) {
    console.warn('Report catalog state was not written:', err.message);
  }
}

function buildCatalog(options = {}) {
  const now = options.now || new Date();
  const rules = options.rules || DEFAULT_RULES;
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const state = options.state || loadState(statePath);
  const rawReports = buildRawReports({ ...options, now, rules })
    .filter(report => report.availability === 'available');

  const forcedFreeCount = rawReports.filter(report => report.forceFree).length;
  const rotationRules = {
    ...rules,
    freeCount: Math.max(0, rules.freeCount - forcedFreeCount),
  };
  const freeIds = new Set(selectWeeklyFreeIds(rawReports, state, rotationRules, now));
  const reports = rawReports.map(report => {
    const isFree = report.forceFree || freeIds.has(report.id);
    return {
      ...report,
      reportType: isFree ? 'free' : 'existing',
      isFree,
      price: isFree ? 0 : READY_REPORT_PRICE,
      priceLabel: isFree ? report.priceLabel : 'Ready report',
      creditCost: isFree ? 0 : 2,
    };
  });

  if (options.persistState !== false) saveState(state, statePath);

  return {
    generatedAt: now.toISOString(),
    week: weekKey(now),
    rules,
    reports,
  };
}

function getPublicReportsSync(options = {}) {
  return buildCatalog(options).reports;
}

function getReportByIdSync(reportId, options = {}) {
  return getPublicReportsSync(options).find(report => report.id === reportId) || null;
}

function getReportMapSync(options = {}) {
  return Object.fromEntries(getPublicReportsSync(options).map(report => [
    report.id,
    {
      name: report.companyName,
      companyName: report.companyName,
      ticker: report.ticker,
      exchange: report.exchange,
      reportDate: report.reportDateLabel || report.reportDate,
      reportDateIso: report.reportDate,
      pdfUrl: report.pdfUrl,
      price: report.price,
      isFree: report.isFree,
      fileName: report.fileName,
    },
  ]));
}

function recordCatalogPurchase(purchase, options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const state = loadState(statePath);
  const purchasedAt = purchase.purchasedAt || new Date().toISOString();
  const normalized = {
    type: purchase.type || 'existing',
    reportId: purchase.reportId || '',
    fileName: purchase.fileName || '',
    ticker: normalizeTicker(purchase.ticker || ''),
    companyName: purchase.companyName || purchase.reportName || purchase.company || '',
    sessionId: purchase.sessionId || '',
    customerEmail: purchase.customerEmail || purchase.email || '',
    purchasedAt,
  };

  if (normalized.sessionId) {
    state.purchases = state.purchases.filter(item => item.sessionId !== normalized.sessionId);
  }

  const cutoff = Date.now() - (366 * MS_PER_DAY);
  state.purchases = [normalized, ...(state.purchases || [])]
    .filter(item => {
      const date = parseDate(item.purchasedAt);
      return !date || date.getTime() >= cutoff;
    })
    .slice(0, 2000);

  saveState(state, statePath);
  return normalized;
}

module.exports = {
  DEFAULT_RULES,
  buildCatalog,
  getPublicReportsSync,
  getReportByIdSync,
  getReportMapSync,
  recordCatalogPurchase,
  weekKey,
};
