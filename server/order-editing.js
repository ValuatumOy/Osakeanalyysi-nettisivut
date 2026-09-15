// What the order page needs to know about a report's versions and text
// editing, shared by the shop API Lambda (server/lambda/api.js) and the
// members Lambda (server/lambda/members.js) so both doors describe an order
// the same way.
const engine = require('./engine-client');

// One revisionHistory entry as the order page sees it. `pdfUrl` is added by
// the caller, which knows which bucket to presign against.
//
// `kind` / `authorship` label who wrote the version: an entry written before
// edits existed has neither and is an AI revision from the customer's
// instructions, which is what the defaults say.
function historyEntryPayload(entry) {
  const kind = entry.kind || 'revision';
  return {
    version: entry.version,
    kind,
    authorship: entry.authorship || (kind === 'edit' ? 'analyst' : 'ai'),
    comments: entry.comments || '',
    completedAt: entry.completedAt,
    changes: entry.changes || null,
    ...(entry.fit ? { fit: entry.fit } : {}),
    ...(entry.reportQuality ? { reportQuality: entry.reportQuality } : {}),
    ...(kind === 'edit' ? {
      editedBy: entry.editedBy || '',
      editedFrom: entry.editedFrom ?? null,
      edits: Array.isArray(entry.edits) ? entry.edits : [],
      editWarnings: entry.editWarnings || null,
    } : {}),
  };
}

// What a REVISING order is busy with, so the page can say "applying your
// edits" (seconds) rather than "regenerating" (tens of minutes).
function activityOf(order) {
  if (order.status !== 'REVISING') return null;
  return order.pendingEdit || order.activeEdit ? 'editing' : 'revising';
}

// Whether the page should offer text editing on this order's current version.
// hasPreview is recorded at delivery; an order delivered before it was
// recorded gets the benefit of the doubt, and the preview route answers
// honestly when the engine has nothing to show.
function editableNow(order) {
  return order.status === 'DELIVERED' && Boolean(order.jobId) && order.hasPreview !== false;
}

// The current version's number: v1 is the original delivery, every history
// entry after it adds one.
function currentVersion(order) {
  return (order.revisionHistory || []).length + 1;
}

// The engine's rendered HTML of the order's current version, for the editor.
// Fetched here rather than in the browser so the presigned URL never leaves
// the server and the browser needs no cross-origin access to the engine's
// bucket. Returns { status, html } or { status, error }.
async function loadPreviewHtml(order) {
  if (order.status !== 'DELIVERED' || !order.jobId) {
    return { status: 409, error: 'The report is not ready to edit right now.' };
  }
  const job = await engine.getJob(order.jobId);
  if (job.status !== 'DONE') {
    return { status: 409, error: `The report's engine job is ${job.status}; it cannot be edited.` };
  }
  if (!job.previewUrl) {
    return {
      status: 409,
      error: 'This report was generated before text editing was supported, so it cannot be edited. '
        + 'Request a revision or generate a new report instead.',
    };
  }
  try {
    const html = await engine.fetchPreviewHtml(job.previewUrl);
    return { status: 200, html };
  } catch (err) {
    return { status: 502, error: `Could not load the report for editing: ${err.message}` };
  }
}

// The what-if calculator on the order's current version. `body` is
// `{ overrides?, solve? }` straight from the browser; the engine validates
// it (400 on a malformed lever, 409 on a report that predates the
// calculator). Returns { status, result } or { status, error }.
async function previewValuation(order, body) {
  if (order.status !== 'DELIVERED' || !order.jobId) {
    return { status: 409, error: 'The report is not ready right now.' };
  }
  const overrides = body && typeof body.overrides === 'object' && body.overrides ? body.overrides : undefined;
  const solve = body && typeof body.solve === 'object' && body.solve ? body.solve : undefined;
  try {
    // `engineUsername` is set only on orders whose job was submitted outside
    // the shop (a verification run attached by hand); the engine refuses a
    // preview from anyone but the job's owner.
    const result = await engine.previewValuation({ jobId: order.jobId, overrides, solve, ...(order.engineUsername ? { username: order.engineUsername } : {}) });
    return { status: 200, result };
  } catch (err) {
    if (err.status === 400 || err.status === 409 || err.status === 413) return { status: err.status, error: err.message };
    return { status: 502, error: `Could not compute the valuation: ${err.message}` };
  }
}

// The QA verdict of the version the customer currently holds: the newest
// revision's when there is one, else the original delivery's. Null on orders
// delivered before the engine reported one.
function currentReportQuality(order) {
  const last = (order.revisionHistory || []).slice(-1)[0];
  if (last) return last.reportQuality || null;
  return order.reportQuality || null;
}

// The what-if the customer locked: `{ rowKey: { lever: number } }`, at most
// 50 rows. Shape only — the engine validates it against the report's rows and
// answers 400 with the row and field, which the reconciler surfaces as the
// revision error. Returns null when absent, an Error when malformed.
function parseValuationOverrides(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Error('valuationOverrides must be an object keyed by bridge row');
  const keys = Object.keys(raw);
  if (!keys.length) return new Error('valuationOverrides is empty');
  if (keys.length > 50) return new Error('valuationOverrides names too many rows');
  for (const key of keys) {
    const row = raw[key];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return new Error(`valuationOverrides[${key}] must be an object`);
    for (const [lever, value] of Object.entries(row)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return new Error(`valuationOverrides[${key}].${lever} must be a finite number`);
    }
  }
  return raw;
}

module.exports = { historyEntryPayload, activityOf, editableNow, currentVersion, loadPreviewHtml, previewValuation, currentReportQuality, parseValuationOverrides };
