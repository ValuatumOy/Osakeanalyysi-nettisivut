// DynamoDB order ledger — the AWS replacement for server/orders.js.
// Same shape and semantics, but async and safe under concurrent
// writers: the API Lambda only ever creates (conditional put, idempotent on
// the Stripe session id) and the worker only ever updates, so no read-modify-
// write of a shared file can lose a paid order.
//
// Table (AiEquityReportsOrders): PK `orderId` (S). Attributes are the order
// row exactly as orders.js defines it. Pending lookup is a Scan with a status
// filter — the table holds tens of rows.

const { PutCommand, GetCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { dynamo } = require('./clients');

const TABLE = () => {
  const name = process.env.ORDERS_TABLE;
  if (!name) throw new Error('ORDERS_TABLE is not set');
  return name;
};

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

function toRow(item) {
  if (!item) return null;
  const { orderId, ...rest } = item;
  return { id: orderId, ...rest };
}

async function scanAll(params = {}) {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await dynamo().send(new ScanCommand({ TableName: TABLE(), ExclusiveStartKey, ...params }));
    for (const item of page.Items || []) rows.push(toRow(item));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

async function list() {
  return scanAll();
}

async function get(id) {
  const res = await dynamo().send(new GetCommand({ TableName: TABLE(), Key: { orderId: id } }));
  return toRow(res.Item);
}

async function listPending() {
  return scanAll({
    FilterExpression: '#s IN (:new, :importing, :rendering, :revising)',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':new': STATUS.NEW,
      ':importing': STATUS.IMPORTING,
      ':rendering': STATUS.RENDERING,
      ':revising': STATUS.REVISING,
    },
  });
}

// Create an order. Idempotent on the Stripe session id: a repeated webhook
// delivery returns the existing row rather than duplicating it.
//
// A fresh order (the default) starts at NEW and the reconciler drives it
// through generation. A ready-report "+ Revisions" purchase instead starts
// directly at DELIVERED, with `jobId`/`pdfFileName` copied from the catalog
// entry it was bought against — there is nothing to generate, only to
// revise later.
async function create(input) {
  if (!input || !input.id) throw new Error('orders.create: id (stripe session id) is required');

  const order = {
    orderId: input.id,
    email: input.email || '',
    companyName: input.companyName || '',
    ticker: String(input.ticker || '').trim().toUpperCase(),
    exchange: input.exchange || '',
    sector: input.sector || '',
    industry: input.industry || '',
    // 'private' keeps the delivered report out of the catalog even when resale
    // is on — membership generations belong to one member, not the shop.
    // Undefined is dropped by the document client, so ordinary orders are
    // stored exactly as before.
    visibility: input.visibility || undefined,
    // The member who owns this generation, for the PDF cover byline on any
    // report they revise. Undefined on shop orders, which stay engine-only.
    analystName: input.analystName || undefined,
    origin: input.origin === 'ready' ? 'ready' : 'fresh',
    // A derived analysis: the genId of the published analysis this one was
    // forked from. The fork revises the parent's engine job but is a separate
    // order, and it deliberately starts with pdfFileName null — the reconciler
    // writes an existing key in place, so inheriting the parent's name would
    // make the forker's first revision overwrite the published report under
    // every reader of it.
    forkedFrom: input.forkedFrom || undefined,
    reportId: input.reportId || null,
    status: input.status || STATUS.NEW,
    jobId: input.jobId || null,
    importStatus: null,
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
    deliveredEmailAt: null,
    error: null,
    attempts: 0,
    revisionAttempts: 0, // same, but scoped to the current revision request only
    polls: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  try {
    await dynamo().send(new PutCommand({
      TableName: TABLE(),
      Item: order,
      ConditionExpression: 'attribute_not_exists(orderId)',
    }));
    return toRow(order);
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return get(input.id);
    throw err;
  }
}

// Claim the right to submit a forecast-revision request: only from DELIVERED,
// and only while the order still has revisions left. A conditional update, so
// a double-click or a second open tab loses the race instead of starting two
// revision jobs. Returns null (not an error) when the claim fails — the
// caller turns that into a 409.
async function claimRevision(id, comment) {
  try {
    const res = await dynamo().send(new UpdateCommand({
      TableName: TABLE(),
      Key: { orderId: id },
      UpdateExpression: 'SET #s = :revising, pendingRevisionComment = :comment, '
        + 'revisionError = :null, revisionAttempts = :zero, polls = :zero, updatedAt = :now',
      ConditionExpression: '#s = :delivered AND revisionsUsed < revisionsAllowed',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':revising': STATUS.REVISING,
        ':delivered': STATUS.DELIVERED,
        ':comment': comment,
        ':null': null,
        ':zero': 0,
        ':now': nowIso(),
      },
      ReturnValues: 'ALL_NEW',
    }));
    return toRow(res.Attributes);
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

// Patch an order in place and bump updatedAt. `id` and `createdAt` are protected.
// Raise the revision allowance by a paid amount. ADD rather than a read and a
// write, so two purchases landing together both count.
async function addRevisionsAllowed(id, rounds) {
  const n = Math.round(Number(rounds) || 0);
  if (n <= 0) return null;
  const res = await dynamo().send(new UpdateCommand({
    TableName: TABLE(),
    Key: { orderId: id },
    UpdateExpression: 'SET revisionsAllowed = if_not_exists(revisionsAllowed, :zero) + :n',
    ConditionExpression: 'attribute_exists(orderId)',
    ExpressionAttributeValues: { ':zero': 0, ':n': n },
    ReturnValues: 'ALL_NEW',
  }));
  return res.Attributes || null;
}

async function update(id, patch = {}) {
  const names = {};
  const values = { ':updatedAt': nowIso() };
  const sets = ['#updatedAt = :updatedAt'];
  names['#updatedAt'] = 'updatedAt';

  let i = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'orderId' || key === 'createdAt' || key === 'updatedAt') continue;
    i += 1;
    names[`#k${i}`] = key;
    values[`:v${i}`] = value === undefined ? null : value;
    sets.push(`#k${i} = :v${i}`);
  }

  try {
    const res = await dynamo().send(new UpdateCommand({
      TableName: TABLE(),
      Key: { orderId: id },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(orderId)',
      ReturnValues: 'ALL_NEW',
    }));
    return toRow(res.Attributes);
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      throw new Error(`orders.update: unknown order ${id}`);
    }
    throw err;
  }
}

module.exports = {
  STATUS,
  PENDING_STATUSES,
  create,
  get,
  list,
  listPending,
  update,
  addRevisionsAllowed,
  claimRevision,
};
