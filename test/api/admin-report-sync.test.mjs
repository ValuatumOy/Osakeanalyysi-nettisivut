import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const state = {};
function reset() {
  Object.assign(state, { events: [], dispatchResult: { dispatched: true }, failWrite: false });
}
function stub(path, exports) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
process.env.ADMIN_UPLOAD_PASSWORD = 'test-admin';
delete process.env.SECRETS_SSM_PREFIX;
stub('../../server/aws/secrets.js', { ensureSecrets: async () => {} });
stub('../../server/aws/pdf-store.js', {
  pdfExists: async name => name === 'Report_28102026.pdf',
  readSidecar: async () => ({ companyName: 'Report' }),
  writeSidecar: async () => {
    if (state.failWrite) throw new Error('write failed');
    state.events.push('write');
  },
  deleteReport: async () => { state.events.push('delete'); },
});
stub('../../server/report-page-dispatch.js', {
  dispatchReportPages: async () => {
    state.events.push('dispatch');
    if (state.dispatchResult instanceof Error) throw state.dispatchResult;
    return state.dispatchResult;
  },
});
stub('../../server/email.js', { reportError: async () => {} });
const { handler } = require('../../server/lambda/api.js');
const post = (path, body, password = 'test-admin') => handler({
  routeKey: `POST /api/admin/${path}`,
  headers: { authorization: `Bearer ${password}` },
  body: JSON.stringify(body),
});

test('publish, update and delete wake the page sync after the catalog change', async () => {
  for (const [path, body, write] of [
    ['publish', { fileName: 'Report_28102026.pdf', companyName: 'Report', visibleNow: true }, 'write'],
    ['update', { fileName: 'Report_28102026.pdf', patch: { hidden: true } }, 'write'],
    ['delete', { fileName: 'Report_28102026.pdf' }, 'delete'],
  ]) {
    reset();
    const response = await post(path, body);
    assert.equal(response.statusCode, 200, path);
    assert.deepEqual(state.events, [write, 'dispatch'], path);
    assert.equal(JSON.parse(response.body).pageSyncStarted, true, path);
  }
});

test('a missing token or failed dispatch does not undo a saved admin change', async () => {
  for (const result of [{ dispatched: false, reason: 'missing-token' }, new Error('dispatch unavailable')]) {
    reset();
    state.dispatchResult = result;
    const response = await post('update', { fileName: 'Report_28102026.pdf', patch: { forceFree: true } });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).pageSyncStarted, false);
    assert.deepEqual(state.events, ['write', 'dispatch']);
  }
});

test('unauthorized, invalid and failed changes never dispatch a page sync', async () => {
  reset();
  assert.equal((await post('delete', { fileName: 'Report_28102026.pdf' }, 'wrong')).statusCode, 401);
  assert.equal((await post('update', { fileName: 'missing.pdf', patch: {} })).statusCode, 404);
  state.failWrite = true;
  assert.equal((await post('publish', { fileName: 'Report_28102026.pdf', companyName: 'Report' })).statusCode, 500);
  assert.deepEqual(state.events, []);
});
