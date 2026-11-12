// Gap fill before rendering: asks wisdom-data-collector to import the
// company's missing report periods into Trunk, then reports when that is done.
//
// Replaces the FMP fresh import (fmp-client.js), which has been off in prod
// since 29 October 2026: Wisdom's statements now come from the PDF data import
// (the `ValuatumData` analyst), and an FMP import would create a second model
// under the FMP analyst instead of updating the one the engine reads. The
// collector only imports new releases on its own schedule, so a company that
// has not reported since then can still have a model that is a year old. This
// fills those gaps for the company being ordered.
//
// The protocol is the one Trunk's "Valuatum data import" page uses
// (valubuild-trunk PdfDataImportTriggerService / PdfDataImportStatusReader;
// wisdom-data-collector docs/report-import.md §17.15):
//
//  1. Invoke the lane's report-importer Lambda ASYNCHRONOUSLY with
//     {"backfill": {"companies": [{isin, name}]}, "scope": {"enable": [isin]}}.
//     A synchronous call can time out on the client and be retried, which runs
//     the import twice (the collector's landmine 38), so retries are off too.
//  2. The invoke returns only 202. The collector writes a request row to its
//     report-import table at pk=I#<isin>, sk=REQ#<run started_at>; this
//     request's row is the earliest one with run_mode "execute" that started
//     after the invoke (minus clock skew).
//  3. A "submitted" request names its import groups; each group's row in
//     pdf-dataimport-equity-import-groups-<env> says when it has been
//     processed and delivered to Trunk.
//
// The ticker is not sent: a gap fill needs only the ISIN, and the collector
// refuses an entry whose ticker is not in Yahoo form (e.g. BRK.B).

// The AWS SDK is required lazily, as in server/aws/clients.js, so loading this
// module never needs it (the local Express server runs without the SDK).
const { fetchWisdom } = require('./search');

const IMPORTER_FUNCTION = () => process.env.COLLECTOR_IMPORTER_FUNCTION || '';
const REPORT_IMPORT_TABLE = () => process.env.COLLECTOR_REPORT_IMPORT_TABLE || '';
const IMPORT_GROUPS_TABLE = () => process.env.COLLECTOR_IMPORT_GROUPS_TABLE || '';

// How much earlier than our invoke the collector's clock may put the run start
// (Trunk uses the same 2 minutes).
const CLOCK_SKEW_MS = 2 * 60 * 1000;
// A request row still "running" this long after its last update belongs to a
// run that died (Lambda timeout is 5 minutes; Trunk uses 15).
const REQUEST_DIED_AFTER_MS = 15 * 60 * 1000;

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

// Request statuses that end the request without anything to wait for.
const NOTHING_MISSING = new Set(['satisfied', 'choose']);
const NOT_FILLABLE = new Set(['exhausted', 'no_documents', 'skipped', 'rejected', 'failed']);

let lambdaClient;
function lambda() {
  if (!lambdaClient) {
    const { LambdaClient } = require('@aws-sdk/client-lambda');
    // Never retry: if a timed-out invoke was in fact accepted, a retry is a second import run.
    lambdaClient = new LambdaClient({ maxAttempts: 1 });
  }
  return lambdaClient;
}

function isConfigured() {
  return Boolean(IMPORTER_FUNCTION() && REPORT_IMPORT_TABLE() && IMPORT_GROUPS_TABLE());
}

// The order's ticker -> { isin, name } from Wisdom (companyCode is the ISIN).
// Only an exact ticker match counts (the endpoint prefix-matches); when several
// companies share it, the one with a `ValuatumData` model wins, as in the engine.
// Returns null when Wisdom has no such company or no valid ISIN for it.
async function resolveCompany(ticker) {
  const wanted = String(ticker || '').trim().toUpperCase();
  if (!wanted) return null;
  const rows = (await fetchWisdom('ticker', wanted))
    .filter(row => String(row.ticker || '').trim().toUpperCase() === wanted)
    .filter(row => ISIN_RE.test(String(row.companyCode || '').trim().toUpperCase()));
  if (rows.length === 0) return null;
  const preferred = rows.find(row => (row.models || []).some(m => m.analystName === 'ValuatumData')) || rows[0];
  return {
    isin: String(preferred.companyCode).trim().toUpperCase(),
    name: String(preferred.companyName || '').trim(),
  };
}

function payloadFor({ isin, name }) {
  const entry = name ? { isin, name } : { isin };
  return { backfill: { companies: [entry] }, scope: { enable: [isin] } };
}

// Starts a gap fill. Returns the ISO time taken just before the invoke; the
// collector's run starts after it, which is what readRequest() matches on.
async function requestGapFill(company) {
  if (!isConfigured()) throw new Error('gap fill is not configured (COLLECTOR_* env vars)');
  const requestedAt = new Date().toISOString();
  const { InvokeCommand } = require('@aws-sdk/client-lambda');
  const res = await lambda().send(new InvokeCommand({
    FunctionName: IMPORTER_FUNCTION(),
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify(payloadFor(company))),
  }));
  if (res.StatusCode !== 202) {
    throw new Error(`gap fill invoke returned ${res.StatusCode}, expected 202`);
  }
  return requestedAt;
}

// This request's REQ# row: the earliest execute-mode row that started no more
// than CLOCK_SKEW_MS before the invoke. Null until the importer has picked the
// request up (it may be busy with a scheduled run first).
async function readRequest(isin, requestedAt) {
  const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
  const { dynamo } = require('./aws/clients');
  const from = new Date(Date.parse(requestedAt) - CLOCK_SKEW_MS).toISOString();
  const res = await dynamo().send(new QueryCommand({
    TableName: REPORT_IMPORT_TABLE(),
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: { ':pk': `I#${isin}`, ':from': `REQ#${from}`, ':to': 'REQ#~' },
  }));
  const rows = (res.Items || [])
    .filter(row => (row.run_mode || 'execute') === 'execute')
    .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
  return rows[0] || null;
}

async function readGroup(importGroupId) {
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const { dynamo } = require('./aws/clients');
  const res = await dynamo().send(new GetCommand({
    TableName: IMPORT_GROUPS_TABLE(),
    Key: { importGroupId },
  }));
  return res.Item || null;
}

// Where a group is: done once processing failed or delivery ended. The
// consumer writes the row only when it starts, so a missing row is in progress.
function groupOutcome(group) {
  if (!group) return 'pending';
  if (group.processingStatus === 'FAILED') return 'failed';
  if (group.deliveryStatus === 'DELIVERED') return 'delivered';
  if (group.deliveryStatus === 'DELIVERY_FAILED') return 'failed';
  return 'pending';
}

// The state of the gap fill started at `requestedAt`:
//   waiting         no request row yet (the importer has not started it)
//   running         the importer is planning or fetching
//   importing       groups submitted, not all finished
//   imported        every group finished and at least one was delivered to Trunk
//   nothing_missing Trunk already has every period the planner targets
//   deferred        another import of the company is in flight; re-send later
//   unavailable     nothing could be imported (no documents, skipped, failed, ...)
// plus `detail` (the collector's words) and `groups` when there are any.
async function checkGapFill(isin, requestedAt, now = Date.now()) {
  const request = await readRequest(isin, requestedAt);
  if (!request) return { state: 'waiting' };

  const status = request.request_status;
  const detail = request.request_detail || '';
  if (status === 'running' || status === 'executing') {
    const last = Date.parse(request.updated_at || request.started_at || '') || now;
    if (now - last > REQUEST_DIED_AFTER_MS) {
      return { state: 'unavailable', detail: `the importer run died while ${status}` };
    }
    return { state: 'running', detail };
  }
  if (NOTHING_MISSING.has(status)) return { state: 'nothing_missing', detail };
  if (status === 'deferred') return { state: 'deferred', detail };
  if (status === 'submitted') {
    const groupIds = request.import_group_ids || [];
    const outcomes = await Promise.all(groupIds.map(async id => groupOutcome(await readGroup(id))));
    const groups = groupIds.map((id, i) => ({ id, outcome: outcomes[i] }));
    if (outcomes.length === 0 || outcomes.includes('pending')) return { state: 'importing', detail, groups };
    if (outcomes.includes('delivered')) return { state: 'imported', detail, groups };
    return { state: 'unavailable', detail, groups };
  }
  if (NOT_FILLABLE.has(status)) return { state: 'unavailable', detail: `${status}: ${detail}` };
  // A status this client does not know (a newer collector): do not wait on it.
  return { state: 'unavailable', detail: `unknown request status ${status}: ${detail}` };
}

module.exports = {
  isConfigured, resolveCompany, requestGapFill, checkGapFill,
  // for tests
  payloadFor, groupOutcome,
};
