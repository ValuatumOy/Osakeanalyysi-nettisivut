#!/usr/bin/env node
// One-time ledger import (safe to re-run at cutover):
//   server/data/orders.json         → AiEquityReportsOrders
//   server/data/catalog-state.json  → AiEquityReportsCatalogState
//
// Idempotent: rows are keyed by session id / week, so re-running overwrites
// with the same data. Run with AWS credentials for the target account.
//
// Usage:
//   node infra/scripts/import-ledgers.mjs \
//     --orders /path/to/orders.json \
//     --state /path/to/catalog-state.json \
//     --stage test|prod

import fs from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);

const stage = args.stage;
if (!['prod', 'test'].includes(stage)) {
  console.error('Pass --stage prod|test (plus --orders and/or --state file paths)');
  process.exit(1);
}
const suffix = stage === 'prod' ? '' : `-${stage}`;
const ORDERS_TABLE = `AiEquityReportsOrders${suffix}`;
const STATE_TABLE = `AiEquityReportsCatalogState${suffix}`;
const RETENTION_SECONDS = 366 * 24 * 60 * 60;

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-west-1' }),
  { marshallOptions: { removeUndefinedValues: true } },
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

if (args.orders) {
  const orders = readJson(args.orders).orders || [];
  for (const order of orders) {
    const { id, ...rest } = order;
    await client.send(new PutCommand({ TableName: ORDERS_TABLE, Item: { orderId: id, ...rest } }));
  }
  console.log(`Imported ${orders.length} orders into ${ORDERS_TABLE}.`);
}

if (args.state) {
  const state = readJson(args.state);
  const purchases = state.purchases || [];
  let skippedExpired = 0;
  for (const purchase of purchases) {
    const key = purchase.sessionId || `legacy-${Buffer.from(JSON.stringify(purchase)).toString('base64url').slice(0, 24)}`;
    const purchasedMs = Date.parse(purchase.purchasedAt) || Date.now();
    const expiresAt = Math.floor(purchasedMs / 1000) + RETENTION_SECONDS;
    if (expiresAt <= Math.floor(Date.now() / 1000)) { skippedExpired += 1; continue; }
    await client.send(new PutCommand({
      TableName: STATE_TABLE,
      Item: { pk: `PURCHASE#${key}`, ...purchase, expiresAt },
    }));
  }

  const freeSelections = state.freeSelections || {};
  for (const [week, selectedIds] of Object.entries(freeSelections)) {
    await client.send(new PutCommand({
      TableName: STATE_TABLE,
      Item: { pk: `WEEK#${week}`, selectedIds, recordedAt: new Date().toISOString() },
    }));
  }
  console.log(`Imported ${purchases.length - skippedExpired} purchases (${skippedExpired} already expired) `
    + `and ${Object.keys(freeSelections).length} week selections into ${STATE_TABLE}.`);
}
