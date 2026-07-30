// Async catalog builder for the Lambda runtime: prefetches the PDF listing +
// sidecars from S3 and the state from DynamoDB, then runs the exact same
// (sync, pure) catalog logic as the box via injection (catalog.js
// buildRawReports options). Reads never persist state (plan §2.2 item 1) —
// the worker tick is the single writer of the weekly free selection.

const catalog = require('../catalog');
const pdfStore = require('./pdf-store');
const stateStore = require('./catalog-state-store');

// The legacy report-manifest.json is deliberately NOT consumed here: sidecars
// are the sole metadata source in AWS. The manifest's hand-edited entries
// carried stale flags that leaked through the merge (a stale `hidden: true`
// hid a live report during migration) and its last real metadata was folded
// into the sidecars. The box's fs path still reads it; Phase 4 deletes it.
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
