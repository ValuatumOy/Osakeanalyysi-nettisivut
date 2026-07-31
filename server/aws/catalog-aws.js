// Async catalog builder for the Lambda runtime: prefetches the PDF listing +
// sidecars from S3 and the state from DynamoDB, then runs the exact same
// sync catalog logic as the legacy Express server, via injection
// (catalog.js buildRawReports options). Reads never persist state —
// the worker tick is the single writer of the weekly free selection.

const catalog = require('../catalog');
const pdfStore = require('./pdf-store');
const stateStore = require('./catalog-state-store');

// report-manifest.json is deliberately NOT consumed here: the sidecar JSONs
// next to the PDFs are the only metadata source. The manifest's hand-edited
// entries carried stale flags (a stale `hidden: true` once hid a live
// report), and everything useful in it has been copied into the sidecars.
const manifest = { reports: [] };

async function buildCatalogAws(options = {}) {
  const [scannedFiles, state] = await Promise.all([
    pdfStore.listPdfs(),
    stateStore.loadState(),
  ]);
  const sidecars = await pdfStore.readSidecars(scannedFiles.map(file => file.fileName));

  const built = catalog.buildCatalog({
    now: options.now,
    includeNonPublic: Boolean(options.includeNonPublic),
    scannedFiles,
    readSidecar: fileName => sidecars.get(fileName) || {},
    manifest,
    state,
    persistState: false,
    pdfBaseUrl: process.env.REPORT_PDF_BASE_URL,
  });

  return { catalog: built, state, sidecars };
}

async function getReportById(reportId, options = {}) {
  const { catalog: built } = await buildCatalogAws(options);
  return built.reports.find(report => report.id === reportId) || null;
}

// Called from the worker tick (single writer): record this week's computed
// free selection so the repeat-cooldown history accumulates.
async function persistWeekSelection(builtCatalog, state) {
  const week = builtCatalog.week;
  const selected = state.freeSelections?.[week];
  if (!Array.isArray(selected)) return false;
  return stateStore.recordWeekSelection(week, selected);
}

module.exports = { buildCatalogAws, getReportById, persistWeekSelection };
