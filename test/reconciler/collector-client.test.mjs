import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// collector-client.js against a fake DynamoDB and a fake Wisdom search: which
// request row belongs to our invoke, and what state its groups put it in.
const require = createRequire(import.meta.url);

const CLIENT_ID = require.resolve('../../server/collector-client.js');
const CLIENTS_ID = require.resolve('../../server/aws/clients.js');
const SEARCH_ID = require.resolve('../../server/search.js');

const ISIN = 'US0378331005';
const REQUESTED_AT = '2026-11-03T09:14:20.000Z';

function load(t, { rows = [], groups = {}, wisdom = [] } = {}) {
  const env = ['COLLECTOR_IMPORTER_FUNCTION', 'COLLECTOR_REPORT_IMPORT_TABLE', 'COLLECTOR_IMPORT_GROUPS_TABLE'];
  const saved = Object.fromEntries(env.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of env) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const id of [CLIENT_ID, CLIENTS_ID, SEARCH_ID]) delete require.cache[id];
  });
  process.env.COLLECTOR_IMPORTER_FUNCTION = 'report-importer-prod';
  process.env.COLLECTOR_REPORT_IMPORT_TABLE = 'report-import';
  process.env.COLLECTOR_IMPORT_GROUPS_TABLE = 'groups';

  const queries = [];
  const dynamo = {
    async send(command) {
      const input = command.input;
      if (input.KeyConditionExpression) {
        queries.push(input);
        const from = input.ExpressionAttributeValues[':from'];
        return { Items: rows.filter(row => row.sk >= from) };
      }
      return { Item: groups[input.Key.importGroupId] };
    },
  };
  const inject = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
  inject(CLIENTS_ID, { dynamo: () => dynamo });
  inject(SEARCH_ID, { async fetchWisdom() { return wisdom; } });
  delete require.cache[CLIENT_ID];
  return { client: require(CLIENT_ID), queries };
}

const req = (startedAt, fields) => ({ pk: `I#${ISIN}`, sk: `REQ#${startedAt}`, run_mode: 'execute', ...fields });

test('the payload is the one Trunk sends, without the ticker', () => {
  const { payloadFor } = require(CLIENT_ID);
  assert.deepEqual(payloadFor({ isin: ISIN, name: 'Apple Inc.' }), {
    backfill: { companies: [{ isin: ISIN, name: 'Apple Inc.' }] },
    scope: { enable: [ISIN] },
  });
  delete require.cache[CLIENT_ID];
});

test('no request row yet is waiting', async (t) => {
  const { client, queries } = load(t);
  assert.deepEqual(await client.checkGapFill(ISIN, REQUESTED_AT), { state: 'waiting' });
  assert.equal(queries[0].ExpressionAttributeValues[':pk'], `I#${ISIN}`);
  assert.equal(queries[0].ExpressionAttributeValues[':from'], 'REQ#2026-11-03T09:12:20.000Z', 'two minutes of clock skew');
});

test('our row is the earliest execute row; previews and older rows are not', async (t) => {
  const { client } = load(t, {
    rows: [
      req('2026-11-01T10:00:00.000000Z', { request_status: 'submitted' }),
      req('2026-11-03T09:14:30.000000Z', { run_mode: 'dry_run', request_status: 'planned' }),
      req('2026-11-03T09:16:00.000000Z', { request_status: 'deferred' }),
      req('2026-11-03T09:14:40.000000Z', { request_status: 'satisfied', request_detail: 'nothing missing' }),
    ],
  });
  assert.deepEqual(await client.checkGapFill(ISIN, REQUESTED_AT), { state: 'nothing_missing', detail: 'nothing missing' });
});

test('a running request is running until it has gone quiet for 15 minutes', async (t) => {
  const { client } = load(t, {
    rows: [req('2026-11-03T09:14:40Z', { request_status: 'executing', updated_at: '2026-11-03T09:15:00Z' })],
  });
  const at = Date.parse('2026-11-03T09:20:00Z');
  assert.equal((await client.checkGapFill(ISIN, REQUESTED_AT, at)).state, 'running');
  assert.equal((await client.checkGapFill(ISIN, REQUESTED_AT, at + 15 * 60 * 1000)).state, 'unavailable');
});

test('a submitted request waits for every group, then is imported if one was delivered', async (t) => {
  const rows = [req('2026-11-03T09:14:40Z', { request_status: 'submitted', import_group_ids: ['g1', 'g2'] })];
  const groups = { g1: { processingStatus: 'MERGED', deliveryStatus: 'DELIVERED' } };

  let { client } = load(t, { rows, groups });
  let result = await client.checkGapFill(ISIN, REQUESTED_AT);
  assert.equal(result.state, 'importing', 'g2 has no row yet');
  assert.deepEqual(result.groups, [{ id: 'g1', outcome: 'delivered' }, { id: 'g2', outcome: 'pending' }]);

  ({ client } = load(t, { rows, groups: { ...groups, g2: { processingStatus: 'FAILED' } } }));
  assert.equal((await client.checkGapFill(ISIN, REQUESTED_AT)).state, 'imported');

  ({ client } = load(t, { rows, groups: { g1: { deliveryStatus: 'DELIVERY_FAILED' }, g2: { processingStatus: 'FAILED' } } }));
  assert.equal((await client.checkGapFill(ISIN, REQUESTED_AT)).state, 'unavailable');
});

test('statuses that end a request', async (t) => {
  const cases = {
    choose: 'nothing_missing',
    deferred: 'deferred',
    exhausted: 'unavailable',
    no_documents: 'unavailable',
    rejected: 'unavailable',
    something_new: 'unavailable',
  };
  for (const [status, state] of Object.entries(cases)) {
    const { client } = load(t, { rows: [req('2026-11-03T09:14:40Z', { request_status: status })] });
    assert.equal((await client.checkGapFill(ISIN, REQUESTED_AT)).state, state, status);
  }
});

test('the ISIN comes from an exact ticker match, preferring the ValuatumData model', async (t) => {
  const { client } = load(t, {
    wisdom: [
      { ticker: 'AAPLX', companyCode: 'US0000000001', companyName: 'Not Apple' },
      { ticker: 'AAPL', companyCode: 'US0378331005', companyName: 'Apple (FMP)', models: [{ analystName: 'ValuatumDataSources' }] },
      { ticker: 'aapl', companyCode: 'us0378331005', companyName: 'Apple Inc.', models: [{ analystName: 'ValuatumData' }] },
    ],
  });
  assert.deepEqual(await client.resolveCompany('AAPL'), { isin: ISIN, name: 'Apple Inc.' });
  assert.equal(await client.resolveCompany('MSFT'), null);
});

test('a row without a valid ISIN does not resolve', async (t) => {
  const { client } = load(t, { wisdom: [{ ticker: 'AAPL', companyCode: '12345' }] });
  assert.equal(await client.resolveCompany('AAPL'), null);
});
