// DynamoDB access for the members table (single table, pk/sk). Identity
// uniqueness via mapping items + conditional puts — no GSI, every lookup is an
// exact key. Table name from MEMBERS_TABLE (throws if unset, like the other
// aws stores).

const crypto = require('crypto');
const {
  GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand,
  TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { dynamo } = require('../aws/clients');

function table() {
  const name = process.env.MEMBERS_TABLE;
  if (!name) throw new Error('MEMBERS_TABLE is not set');
  return name;
}

const isConditionFailure = (err) =>
  err?.name === 'ConditionalCheckFailedException' ||
  err?.name === 'TransactionCanceledException';

async function getItem(pk, sk) {
  const res = await dynamo().send(new GetCommand({ TableName: table(), Key: { pk, sk } }));
  return res.Item || null;
}

async function getProfile(userId) {
  return getItem(`USER#${userId}`, 'PROFILE');
}

async function updateProfile(userId, patch) {
  const names = {};
  const values = {};
  const sets = [];
  for (const [key, value] of Object.entries(patch)) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }
  await dynamo().send(new UpdateCommand({
    TableName: table(),
    Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// Find-or-create a user for an identity key (`EMAIL#…`, `LINKEDIN#…`,
// `STRIPECUST#…`). First writer wins on the identity item; the loser reads the
// winner's userId.
async function ensureUser(identityPk, profileSeed) {
  const existing = await getItem(identityPk, 'IDENTITY');
  if (existing) return existing.userId;

  const userId = crypto.randomUUID();
  try {
    await dynamo().send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: table(),
            Item: { pk: identityPk, sk: 'IDENTITY', userId },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: table(),
            Item: {
              pk: `USER#${userId}`,
              sk: 'PROFILE',
              userId,
              tier: 'none',
              tierStatus: 'none',
              createdAt: new Date().toISOString(),
              ...profileSeed,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }));
    return userId;
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
    const winner = await getItem(identityPk, 'IDENTITY');
    if (!winner) throw err;
    return winner.userId;
  }
}

// Secondary identity for an existing user (e.g. Stripe customer id).
async function putIdentity(identityPk, userId) {
  await dynamo().send(new PutCommand({
    TableName: table(),
    Item: { pk: identityPk, sk: 'IDENTITY', userId },
  }));
}

async function getIdentity(identityPk) {
  const item = await getItem(identityPk, 'IDENTITY');
  return item ? item.userId : null;
}

// ── magic-link tokens ────────────────────────────────────────────────────────

async function putMagicToken(tokenHash, email, { ttlSeconds = 900, returnTo } = {}) {
  await dynamo().send(new PutCommand({
    TableName: table(),
    Item: {
      pk: `MAGIC#${tokenHash}`,
      sk: 'TOKEN',
      email,
      returnTo,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    },
  }));
}

// Atomic delete-on-use: no returned item ⇒ invalid, expired-and-reaped, or
// already used. TTL reaping lags, so expiry is re-checked here.
async function consumeMagicToken(tokenHash) {
  const res = await dynamo().send(new DeleteCommand({
    TableName: table(),
    Key: { pk: `MAGIC#${tokenHash}`, sk: 'TOKEN' },
    ReturnValues: 'ALL_OLD',
  }));
  const item = res.Attributes;
  if (!item) return null;
  if (item.expiresAt && item.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return item;
}

// ── usage / entitlements / publications ──────────────────────────────────────

async function getUsage(userId, key) {
  return getItem(`USER#${userId}`, `USAGE#${key}`);
}

async function listUserItems(userId, skPrefix) {
  const res = await dynamo().send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': skPrefix },
  }));
  return res.Items || [];
}

async function getEntitlement(userId, reportId) {
  return getItem(`USER#${userId}`, `ENT#${reportId}`);
}

async function putEntitlement(userId, reportId, source, extra = {}) {
  await dynamo().send(new PutCommand({
    TableName: table(),
    Item: { pk: `USER#${userId}`, sk: `ENT#${reportId}`, source, grantedAt: new Date().toISOString(), ...extra },
  }));
}

async function putItem(item) {
  await dynamo().send(new PutCommand({ TableName: table(), Item: item }));
}

async function getPublication(userId, genId) {
  return getItem(`USER#${userId}`, `PUB#${genId}`);
}

// The cross-analyst view of publications: one partition, sort key
// `<companyId>#<publishedAt>#<genId>`. A company page is a begins_with query; the
// admin list reads the partition and sorts in memory.
// ponytail: fine while the partition is small (a page is 1 MB). If publications
// outgrow that, this is where a GSI on publishedAt goes.
async function listPublicationIndex({ companyId, limit = 200 } = {}) {
  const prefix = companyId ? `${String(companyId).toUpperCase()}#` : '';
  const res = await dynamo().send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :prefix)' : 'pk = :pk',
    ExpressionAttributeValues: prefix ? { ':pk': 'PUBINDEX', ':prefix': prefix } : { ':pk': 'PUBINDEX' },
    Limit: limit,
  }));
  return res.Items || [];
}

async function findPublicationIndex(genId) {
  const items = await listPublicationIndex({ limit: 1000 });
  return items.find((item) => item.genId === genId) || null;
}

async function listReviews(ownerId, genId) {
  return listUserItems(ownerId, `REVIEW#${genId}#`);
}

// One row per paid-out bounty. Existence is what makes bounty.ledger() call a
// publication 'paid', so the write is conditional — never pay the same one twice.
// Set or clear a handful of named fields on one item. Null clears, which is how
// an analyst removes their LinkedIn link rather than being stuck with it.
async function setFields(pk, sk, fields) {
  const names = {};
  const values = {};
  const sets = [];
  const removes = [];
  Object.entries(fields).forEach(([key, value], i) => {
    names[`#f${i}`] = key;
    if (value === null || value === undefined) {
      removes.push(`#f${i}`);
    } else {
      values[`:v${i}`] = value;
      sets.push(`#f${i} = :v${i}`);
    }
  });
  if (!sets.length && !removes.length) return;
  const expression = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : '']
    .filter(Boolean).join(' ');
  await dynamo().send(new UpdateCommand({
    TableName: table(),
    Key: { pk, sk },
    UpdateExpression: expression,
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
  }));
}

const putProfileFields = (userId, fields) => setFields(`USER#${userId}`, 'PROFILE', fields);
const putIndexFields = (indexSk, fields) => setFields('PUBINDEX', indexSk, fields);

async function putPayout(userId, genId, fields) {
  try {
    await dynamo().send(new PutCommand({
      TableName: table(),
      Item: { pk: `USER#${userId}`, sk: `PAYOUT#${genId}`, ...fields },
      ConditionExpression: 'attribute_not_exists(sk)',
    }));
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

// One row per sale of an analyst's analysis, under the analyst's own pk so the
// earnings ledger is a single query. This is money, so unlike audit() it is
// durable, has no TTL, and is written from the Stripe webhook rather than from
// the buyer's return trip — a buyer who never comes back still owes the analyst
// their share. Conditional, so a replayed event cannot pay twice.
async function putSale(userId, saleId, fields) {
  try {
    await dynamo().send(new PutCommand({
      TableName: table(),
      Item: { pk: `USER#${userId}`, sk: `SALE#${saleId}`, ...fields },
      ConditionExpression: 'attribute_not_exists(sk)',
    }));
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

// Runs a builder result from server/members/quota.js. Returns true on commit,
// false on a condition failure (quota exhausted / already reserved / raced).
async function runTransact(params) {
  try {
    await dynamo().send(new TransactWriteCommand(params));
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

// ── stripe webhook idempotency ───────────────────────────────────────────────

async function claimStripeEvent(eventId) {
  try {
    await dynamo().send(new PutCommand({
      TableName: table(),
      Item: {
        pk: `STRIPEEVT#${eventId}`,
        sk: 'EVT',
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

// ── audit trail ──────────────────────────────────────────────────────────────

async function audit(userId, type, detail) {
  try {
    await dynamo().send(new PutCommand({
      TableName: table(),
      Item: {
        pk: `USER#${userId}`,
        sk: `AUDIT#${new Date().toISOString()}#${crypto.randomBytes(2).toString('hex')}`,
        type,
        detail,
        expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
      },
    }));
  } catch (err) {
    console.warn('members audit write failed:', err.message); // never blocks the request
  }
}

module.exports = {
  table,
  getItem,
  getProfile,
  updateProfile,
  ensureUser,
  putIdentity,
  getIdentity,
  putMagicToken,
  consumeMagicToken,
  getUsage,
  listUserItems,
  getEntitlement,
  putEntitlement,
  putItem,
  getPublication,
  listPublicationIndex,
  findPublicationIndex,
  listReviews,
  putPayout,
  setFields,
  putProfileFields,
  putIndexFields,
  putSale,
  runTransact,
  claimStripeEvent,
  audit,
};
