// DynamoDB catalog state — the AWS replacement for catalog-state.json.
// One table (AiEquityReportsCatalogState), PK `pk` (S), two item
// kinds:
//
//   PURCHASE#<sessionId>  — one purchase row, TTL (`expiresAt`, epoch seconds)
//                           at purchasedAt + 366 days. Replaces the manual
//                           prune-and-cap in catalog.recordCatalogPurchase.
//   WEEK#<isoWeek>        — the week's free-selection report ids. Written once
//                           with attribute_not_exists (first writer wins; the
//                           selection is deterministic so every writer computes
//                           the same value anyway).
//
// loadState() returns the same { purchases, freeSelections } shape
// catalog.loadState() produces, so catalog.buildCatalog consumes it unchanged.

const crypto = require('crypto');
const { PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { dynamo } = require('./clients');
const { normalizePurchase } = require('../catalog');

const RETENTION_DAYS = 366;

const TABLE = () => {
  const name = process.env.CATALOG_STATE_TABLE;
  if (!name) throw new Error('CATALOG_STATE_TABLE is not set');
  return name;
};

async function scanAll() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await dynamo().send(new ScanCommand({ TableName: TABLE(), ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function loadState() {
  const items = await scanAll();
  const purchases = [];
  const freeSelections = {};
  const nowEpoch = Math.floor(Date.now() / 1000);

  for (const item of items) {
    const pk = String(item.pk || '');
    if (pk.startsWith('PURCHASE#')) {
      // TTL deletion lags by up to ~48h; filter expired rows on read too.
      if (item.expiresAt && item.expiresAt <= nowEpoch) continue;
      const { pk: _pk, expiresAt: _ttl, ...purchase } = item;
      purchases.push(purchase);
    } else if (pk.startsWith('WEEK#')) {
      freeSelections[pk.slice('WEEK#'.length)] = Array.isArray(item.selectedIds) ? item.selectedIds : [];
    }
  }

  purchases.sort((a, b) => String(b.purchasedAt || '').localeCompare(String(a.purchasedAt || '')));
  return { purchases, freeSelections };
}

// Record (or overwrite, keyed by session id) one purchase.
async function recordPurchase(purchase) {
  const normalized = normalizePurchase(purchase);
  const key = normalized.sessionId || crypto.randomUUID();
  const purchasedMs = Date.parse(normalized.purchasedAt) || Date.now();

  await dynamo().send(new PutCommand({
    TableName: TABLE(),
    Item: {
      pk: `PURCHASE#${key}`,
      ...normalized,
      expiresAt: Math.floor(purchasedMs / 1000) + RETENTION_DAYS * 24 * 60 * 60,
    },
  }));
  return normalized;
}

// Persist one week's free selection. First writer wins; losing the race is
// fine (the value is deterministic) and reported as recorded=false.
async function recordWeekSelection(week, selectedIds) {
  try {
    await dynamo().send(new PutCommand({
      TableName: TABLE(),
      Item: { pk: `WEEK#${week}`, selectedIds: selectedIds || [], recordedAt: new Date().toISOString() },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

module.exports = { loadState, recordPurchase, recordWeekSelection };
