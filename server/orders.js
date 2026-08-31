// JSON-file order ledger for the fresh-report generation pipeline.
//
// One row per paid fresh purchase (id = Stripe checkout session id). The
// reconciler advances each row NEW → [IMPORTING] → RENDERING → DELIVERED|FAILED.
// Stripe remains the durable source of truth (a lost ledger can be re-derived
// from isFresh sessions), so a JSON file — matching the existing
// catalog-state.json pattern — is enough; no DynamoDB.
//
// All operations are SYNCHRONOUS read-modify-write with an atomic tmp+rename,
// exactly like catalog.js. The Express purchase endpoint and the reconciler run
// in the same single-threaded process, so as long as no `await` sits between a
// read and its write, concurrent calls cannot interleave and clobber the file.
const fs = require('fs');
const path = require('path');

const STATE_PATH = process.env.ORDERS_STATE_PATH || path.join(__dirname, 'data', 'orders.json');

const STATUS = Object.freeze({
  NEW: 'NEW',
  IMPORTING: 'IMPORTING',
  RENDERING: 'RENDERING',
  DELIVERED: 'DELIVERED',
  REVISING: 'REVISING',
  FAILED: 'FAILED',
});

const PENDING_STATUSES = new Set([STATUS.NEW, STATUS.IMPORTING, STATUS.RENDERING, STATUS.REVISING]);

function nowIso() {
  return new Date().toISOString();
}

function readAll(statePath = STATE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(parsed?.orders) ? parsed.orders : [];
  } catch (_) {
    return [];
  }
}

function writeAll(orders, statePath = STATE_PATH) {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ orders }, null, 2));
  fs.renameSync(tmp, statePath);
}

function list(statePath = STATE_PATH) {
  return readAll(statePath);
}

function get(id, statePath = STATE_PATH) {
  return readAll(statePath).find(order => order.id === id) || null;
}

function listPending(statePath = STATE_PATH) {
  return readAll(statePath).filter(order => PENDING_STATUSES.has(order.status));
}

// Create an order. Idempotent on the Stripe session id: a repeated webhook
// delivery returns the existing row rather than duplicating it.
//
// A fresh order (the default) starts at NEW and the reconciler drives it
// through generation. A ready-report "+ Revisions" purchase instead starts
// directly at DELIVERED, with `jobId`/`pdfFileName` copied from the catalog
// entry it was bought against — there is nothing to generate, only to
// revise later.
function create(input, statePath = STATE_PATH) {
  if (!input || !input.id) throw new Error('orders.create: id (stripe session id) is required');

  const orders = readAll(statePath);
  const existing = orders.find(order => order.id === input.id);
  if (existing) return existing;

  const order = {
    id: input.id,
    email: input.email || '',
    companyName: input.companyName || '',
    ticker: String(input.ticker || '').trim().toUpperCase(),
    // Carried onto the row so Task D can write a rich sidecar and Task E can
    // record the import outcome — populated from the Wisdom search result.
    exchange: input.exchange || '',
    sector: input.sector || '',
    industry: input.industry || '',
    // Member generations carry the analyst's name for the PDF cover byline.
    analystName: input.analystName || '',
    origin: input.origin === 'ready' ? 'ready' : 'fresh',
    // The published analysis this one derives from. Never carries the
    // parent's pdfFileName: the reconciler overwrites an existing key in
    // place and readers resolve a published PDF live, so a shared key would
    // republish the parent under its readers on the fork's first revision.
    forkedFrom: input.forkedFrom || null,
    reportId: input.reportId || null, // catalog entry id, origin: 'ready' only
    status: input.status || STATUS.NEW,
    jobId: input.jobId || null,
    // The engine job behind version 1. `jobId` moves on with every delivered
    // revision or edit, so this is the only place the original's job survives
    // (needed to edit or revise the original again later). Stamped here for
    // an order that starts delivered, by deliver() for a fresh one.
    originalJobId: input.jobId || null,
    importStatus: null, // SUCCESS | SKIPPED | FAILED (Task E FMP import)
    pdfFileName: input.pdfFileName || null,
    // Set once, on first delivery, and never touched again — pdfFileName itself
    // gets overwritten by every later revision, so this is the only place the
    // original PDF's name survives for a re-download link. See reconciler.js deliver().
    originalPdfFileName: null,
    revisionsAllowed: Number(input.revisionsAllowed || 0),
    revisionsUsed: 0,
    // The in-flight revision's engine job id, distinct from `jobId` (the last
    // *delivered* job): a revision that fails must not lose the still-good
    // base to revise from next time.
    revisionJobId: null,
    pendingRevisionComment: null,
    // The comment behind the in-flight revisionJobId, kept until delivery
    // labels the resulting revisionHistory entry (pendingRevisionComment is
    // cleared as soon as it's submitted to the engine).
    activeRevisionComment: null,
    // Delivered revisions, oldest first; v1 (the original delivery) is never
    // appended here — see originalPdfFileName above instead.
    revisionHistory: [],
    revisionError: null,
    // A hand edit in flight, `{ edits, originals, editedBy, fromVersion }`:
    // pendingEdit until the worker has submitted it to the engine, activeEdit
    // from then until delivery labels the resulting revisionHistory entry.
    // Edits are free and unlimited, so they have no allowance; editsUsed only
    // counts them (a forked analysis must add something before it publishes).
    pendingEdit: null,
    activeEdit: null,
    editsUsed: 0,
    error: null,
    attempts: 0, // transient-error retries (network); terminal failures set FAILED
    revisionAttempts: 0, // same, but scoped to the current revision request only
    polls: 0, // engine getJob poll count while RENDERING/REVISING
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  writeAll([order, ...orders], statePath);
  return order;
}

// Claim the right to submit a forecast-revision request: only from DELIVERED,
// and only while the order still has revisions left. A conditional
// check-then-write, so a double-click or a second open tab loses the race
// instead of starting two revision jobs. Returns null (not an error) when the
// claim fails — the caller turns that into a 409.
function claimRevision(id, comment, statePath = STATE_PATH) {
  const orders = readAll(statePath);
  const idx = orders.findIndex(order => order.id === id);
  if (idx === -1) return null;

  const current = orders[idx];
  if (current.status !== STATUS.DELIVERED) return null;
  if ((current.revisionsUsed || 0) >= (current.revisionsAllowed || 0)) return null;

  orders[idx] = {
    ...current,
    status: STATUS.REVISING,
    pendingRevisionComment: comment,
    revisionError: null,
    revisionAttempts: 0,
    polls: 0,
    updatedAt: nowIso(),
  };
  writeAll(orders, statePath);
  return orders[idx];
}

// Claim the right to apply hand edits: only from DELIVERED. Edits are free
// and unlimited, so unlike claimRevision there is no allowance to check —
// only the status, so two tabs cannot start two edit jobs on the same base.
// Returns null when the claim fails; the caller turns that into a 409.
function claimEdit(id, edit, statePath = STATE_PATH) {
  const orders = readAll(statePath);
  const idx = orders.findIndex(order => order.id === id);
  if (idx === -1) return null;

  const current = orders[idx];
  if (current.status !== STATUS.DELIVERED) return null;

  orders[idx] = {
    ...current,
    status: STATUS.REVISING,
    pendingEdit: edit,
    pendingRevisionComment: null,
    revisionError: null,
    revisionAttempts: 0,
    polls: 0,
    updatedAt: nowIso(),
  };
  writeAll(orders, statePath);
  return orders[idx];
}

// Patch an order in place and bump updatedAt. `id` and `createdAt` are protected.
function update(id, patch = {}, statePath = STATE_PATH) {
  const orders = readAll(statePath);
  const idx = orders.findIndex(order => order.id === id);
  if (idx === -1) throw new Error(`orders.update: unknown order ${id}`);

  const current = orders[idx];
  orders[idx] = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  };
  writeAll(orders, statePath);
  return orders[idx];
}

module.exports = {
  STATUS,
  PENDING_STATUSES,
  create,
  get,
  list,
  listPending,
  update,
  claimRevision,
  claimEdit,
  STATE_PATH,
};
