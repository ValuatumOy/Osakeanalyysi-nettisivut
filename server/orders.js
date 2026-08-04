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
  FAILED: 'FAILED',
});

const PENDING_STATUSES = new Set([STATUS.NEW, STATUS.IMPORTING, STATUS.RENDERING]);

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

// Create a NEW order. Idempotent on the Stripe session id: a repeated webhook
// delivery returns the existing row rather than duplicating it.
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
    status: STATUS.NEW,
    jobId: null,
    importStatus: null, // SUCCESS | SKIPPED | FAILED (Task E FMP import)
    pdfFileName: null,
    error: null,
    attempts: 0, // transient-error retries (network); terminal failures set FAILED
    polls: 0, // engine getJob poll count while RENDERING
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  writeAll([order, ...orders], statePath);
  return order;
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
  STATE_PATH,
};
