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

module.exports = { historyEntryPayload, activityOf, editableNow, currentVersion, loadPreviewHtml };
