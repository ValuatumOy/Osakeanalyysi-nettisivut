import assert from 'node:assert/strict';
import test from 'node:test';
import { FINANCIAL_VARIABLES, WisdomClient } from '../../scripts/company-pages/wisdom-client.mjs';

test('findCompanyByTicker ignores prefix matches and selects the exact ticker', async () => {
  const fetchImpl = async (url, options) => {
    assert.match(url, /\/company\?ticker=NOKIA$/);
    assert.equal(options.headers.Authorization, 'Bearer secret');
    return jsonResponse([
      { companyId: 1, ticker: 'NOKIA-SE', models: [{ followedModelId: 11 }] },
      { companyId: 2, ticker: 'nokia', models: [{ followedModelId: 22 }] },
    ]);
  };
  const client = new WisdomClient({ baseUrl: 'https://example.test/rest/', token: 'secret', fetchImpl });

  const company = await client.findCompanyByTicker(' nokia ');

  assert.equal(company.companyId, 2);
});

test('getLatestActualModels requests only Y-1 actual values for all company models', async () => {
  let requestBody;
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://example.test/rest/modeldata');
    requestBody = JSON.parse(options.body);
    return jsonResponse({
      101: { followedModelId: 101, companyId: 5, orderNo: 2 },
      102: { followedModelId: 102, companyId: 5, orderNo: 1 },
      999: { followedModelId: 999, companyId: 6, orderNo: 1 },
    });
  };
  const client = new WisdomClient({ baseUrl: 'https://example.test/rest', token: 'secret', fetchImpl });

  const models = await client.getLatestActualModels({
    companyId: 5,
    ticker: 'TEST',
    models: [{ followedModelId: 101 }, { followedModelId: 102 }],
  });

  assert.deepEqual(requestBody.fids, [101, 102]);
  assert.equal(requestBody.includeHistoryData, true);
  assert.equal(requestBody.includeEstimates, false);
  assert.deepEqual(
    requestBody.varPoses,
    FINANCIAL_VARIABLES.map((varName) => ({ varName, relPos: 'Y-1' })),
  );
  assert.deepEqual(models.map((model) => model.followedModelId), [101, 102]);
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
