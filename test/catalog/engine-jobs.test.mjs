import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const calls = [];
const clientsId = require.resolve('../../server/aws/clients.js');
require.cache[clientsId] = { id: clientsId, filename: clientsId, loaded: true, exports: {
  dynamo: () => ({ send: async command => {
    calls.push(command.input);
    if (calls.length === 1) return {
      Responses: { Jobs: [{ jobId: 'good', status: 'DONE', username: 'osakeanalyysi-site', snapshotKey: 'snapshot', templateName: 'osakeanalyysi', params: { companyCode: 'NOKIA' } }] },
      UnprocessedKeys: { Jobs: { Keys: [{ jobId: 'old' }] } },
    };
    const ids = command.input.RequestItems.Jobs.Keys.map(key => key.jobId);
    return { Responses: { Jobs: ids.map(jobId => ({ jobId, status: 'DONE', username: 'osakeanalyysi-site',
      ...(jobId === 'good' ? { snapshotKey: 'snapshot' } : {}), templateName: 'osakeanalyysi', params: { companyCode: 'NOKIA' } })) } };
  } }),
} };
process.env.PDF_ENGINE_JOBS_TABLE = 'Jobs';
const { getRevisionJobs, canRevise, isOrderRevisable } = require('../../server/aws/engine-jobs.js');

test('revision availability requires a completed matching job and its saved snapshot', async () => {
  const jobs = await getRevisionJobs(['good', 'old', 'good']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].RequestItems.Jobs.Keys, [{ jobId: 'old' }]);
  assert.equal(canRevise(jobs.get('good')), true);
  assert.equal(canRevise(jobs.get('old')), false);
  assert.equal(canRevise({ ...jobs.get('good'), username: 'another-user' }), false);
  assert.equal(canRevise({ ...jobs.get('good'), status: 'RUNNING' }), false);
  assert.equal(canRevise({ ...jobs.get('good'), templateName: 'another-report' }), false);
});

test('extra revisions are offered only for delivered orders whose engine snapshot remains available', async () => {
  assert.equal(await isOrderRevisable({ status: 'DELIVERED', jobId: 'good' }), true);
  assert.equal(await isOrderRevisable({ status: 'DELIVERED', jobId: 'old' }), false);
  assert.equal(await isOrderRevisable({ status: 'REVISING', jobId: 'good' }), false);
  assert.equal(await isOrderRevisable({ status: 'DELIVERED' }), false);
});
