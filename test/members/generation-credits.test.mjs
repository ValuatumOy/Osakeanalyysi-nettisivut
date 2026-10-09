import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const quota = require('../../server/members/quota.js');
const now = new Date('2026-10-09T09:00:00Z');
const base = { table: 'Members', userId: 'u1', genId: 'g1', now };
const state = {};
const copy = value => value ? structuredClone(value) : null;
function reset(patch = {}) {
  Object.assign(state, {
    profile: { pk: 'USER#u1', sk: 'PROFILE', userId: 'u1', role: 'subscriber', tier: 'none', email: 'panu@example.com', ...patch },
    usage: null, pubs: new Map(), receipts: new Map(), orders: new Map(),
    transactions: [], creates: [], workers: [], audits: [], reads: [], race: null,
    restoreFailures: 0, createError: false, usageSnapshot: undefined,
  });
}
function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
process.env.ADMIN_UPLOAD_PASSWORD = 'admin-secret';
process.env.MEMBERS_TEST_UTILS_SECRET = 'clock-secret';
process.env.WORKER_FUNCTION_NAME = 'stub-worker';
delete process.env.SECRETS_SSM_PREFIX;
delete process.env.MEMBERS_LIMITS_JSON;

stub('../../server/aws/clients.js', {
  lambda: () => ({ send: async command => state.workers.push(command.input) }),
});
stub('../../server/search.js', {
  searchCompanies: async () => [{ ticker: 'NOKIA.HE', companyName: 'Nokia Oyj', industry: 'Technology' }],
});
stub('../../server/members/auth.js', {
  requireUser: async () => ({ profile: copy(state.profile), deny: null }),
});
stub('../../server/email.js', { reportError: async () => {} });
stub('../../server/aws/catalog-aws.js', {});
stub('../../server/aws/orders-store.js', {
  STATUS: { FAILED: 'FAILED' },
  create: async order => {
    state.creates.push(copy(order));
    if (state.createError) throw new Error('Simulated order-write interruption');
    if (state.orders.has(order.id)) return copy(state.orders.get(order.id));
    state.orders.set(order.id, { ...order, status: 'NEW' });
  },
  get: async id => copy(state.orders.get(id)),
  update: async () => { throw new Error('Private gift must not reach publication side effects'); },
});
stub('../../server/members/store.js', {
  table: () => 'Members',
  getProfile: async (id, consistent) => {
    state.reads.push({ id, consistent });
    return copy(state.profile?.userId === id ? state.profile : null);
  },
  getUsage: async () => copy(state.usageSnapshot === undefined ? state.usage : state.usageSnapshot),
  getPublication: async (id, genId) => copy(state.pubs.get(genId)),
  getItem: async (pk, sk) => copy(sk.startsWith('PUB#') ? state.pubs.get(sk.slice(4)) : state.receipts.get(sk)),
  listProfiles: async () => state.profile ? [copy(state.profile)] : [],
  listPublicationIndex: async () => [],
  listUserItems: async (id, prefix) => prefix === 'PUB#' ? [...state.pubs.values()].map(copy) : [],
  audit: async (id, type, detail) => state.audits.push({ id, type, detail }),
  runTransact: async params => {
    state.transactions.push(copy(params));
    if (state.race) {
      const race = state.race;
      state.race = null;
      race();
    }
    const items = params.TransactItems;
    const first = items[0].Update;
    const expr = first.UpdateExpression;
    if (expr.includes('ADD generationCredits :count')) {
      const receipt = items[1]?.Put.Item;
      if (!state.profile || state.profile.banned || (receipt && state.receipts.has(receipt.sk))) return false;
      state.profile.generationCredits = (state.profile.generationCredits || 0) + first.ExpressionAttributeValues[':count'];
      if (receipt) state.receipts.set(receipt.sk, copy(receipt));
      return true;
    }
    if (expr === 'ADD generationCredits :minusOne') {
      const pub = items[1].Put.Item;
      if (!state.profile || state.profile.banned || !(state.profile.generationCredits >= 1) || state.pubs.has(pub.sk.slice(4))) return false;
      state.profile.generationCredits -= 1;
      state.pubs.set(pub.sk.slice(4), copy(pub));
      return true;
    }
    if (expr === 'ADD generationCredits :one') {
      if (state.restoreFailures) { state.restoreFailures -= 1; return false; }
      const pub = state.pubs.get(items[1].Update.Key.sk.slice(4));
      if (!state.profile || !pub?.generationCredit || pub.status !== 'failed' || pub.creditRestoredAt) return false;
      state.profile.generationCredits = (state.profile.generationCredits || 0) + 1;
      pub.creditRestoredAt = items[1].Update.ExpressionAttributeValues[':at'];
      return true;
    }
    if (expr === 'SET #status = :failed, failedAt = :at') {
      const pub = state.pubs.get(first.Key.sk.slice(4));
      if (!pub || pub.status !== 'generating') return false;
      pub.status = 'failed';
      return true;
    }
    if (expr === 'REMOVE openObligationId SET generationGrantedAt = :at') {
      if (!state.profile || state.profile.banned) return false;
      delete state.profile.openObligationId;
      state.usage = {};
      return true;
    }
    if (expr === 'REMOVE openObligationId') {
      if (items[1].Update.Key.sk.startsWith('PUB#')) {
        const pub = state.pubs.get(items[1].Update.Key.sk.slice(4));
        return Boolean(pub && !pub.generationCredit && pub.status === 'generating');
      }
      const genId = first.ExpressionAttributeValues[':genId'];
      if (state.usage?.genId !== genId || (state.profile.openObligationId && state.profile.openObligationId !== genId)) return false;
      state.usage = {};
      delete state.profile.openObligationId;
      return true;
    }
    // Existing monthly builders: analyst adds the obligation; reader only reserves usage.
    if (expr === 'SET openObligationId = :genId' || expr === 'SET genReserved = :true, genId = :genId') {
      if (state.usage?.genReserved || state.profile.openObligationId) return false;
      const analyst = expr === 'SET openObligationId = :genId';
      const pub = items.find(item => item.Put).Put.Item;
      if (state.pubs.has(pub.sk.slice(4))) return false;
      state.usage = { genReserved: true, genId: pub.sk.slice(4) };
      if (analyst) state.profile.openObligationId = pub.sk.slice(4);
      state.pubs.set(pub.sk.slice(4), copy(pub));
      return true;
    }
    throw new Error(`Unexpected transaction: ${expr}`);
  },
});
const { handler } = require('../../server/lambda/members.js');
async function request(routeKey, body, extra = {}) {
  const res = await handler({
    routeKey,
    headers: { authorization: 'Bearer admin-secret', 'x-test-now': now.toISOString(), 'x-test-secret': 'clock-secret' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const grant = body => request('POST /admin/members/grant-generation', { userId: 'u1', ...body });
const generate = (extra = {}) => request('POST /generations/free', { company: 'Nokia', ticker: 'NOKIA.HE', ...extra });
const poll = id => request('GET /generations/{genId}', undefined, { pathParameters: { genId: id } });
const requestId = '12345678-1234-4321-8123-123456789abc';

test('credit builders are atomic, bounded by the balance, and independent of monthly gates', () => {
  const reserve = quota.buildReserveGenerationCreditTransact(base).TransactItems;
  assert.equal(reserve.length, 2);
  assert.equal(reserve[0].Update.UpdateExpression, 'ADD generationCredits :minusOne');
  assert.equal(reserve[0].Update.ExpressionAttributeValues[':minusOne'], -1);
  assert.match(reserve[0].Update.ConditionExpression, /attribute_exists\(pk\).*generationCredits >= :one.*banned/);
  assert.equal(reserve[1].Put.Item.private, true);
  assert.equal(reserve[1].Put.Item.generationCredit, true);
  assert.equal(reserve[1].Put.ConditionExpression, 'attribute_not_exists(sk)');
  assert.ok(reserve.every(item => !(item.Update?.Key.sk || '').startsWith('USAGE#')));
  const gift = quota.buildGrantGenerationCreditsTransact({ ...base, count: 3, requestId }).TransactItems;
  assert.equal(gift[0].Update.ExpressionAttributeValues[':count'], 3);
  assert.match(gift[0].Update.ConditionExpression, /attribute_exists\(pk\).*banned/);
  assert.equal(gift[1].Put.Item.sk, `GENERATIONGRANT#${requestId}`);
  assert.equal(gift[1].Put.ConditionExpression, 'attribute_not_exists(sk)');
});

test('refund guards the failed credit source and stamps restoration in the same transaction', () => {
  const items = quota.buildRestoreGenerationCreditTransact(base).TransactItems;
  assert.equal(items[0].Update.UpdateExpression, 'ADD generationCredits :one');
  assert.equal(items[0].Update.ConditionExpression, 'attribute_exists(pk)');
  assert.equal(items[1].Update.ConditionExpression,
    'generationCredit = :true AND #status = :failed AND attribute_not_exists(creditRestoredAt)');
  assert.equal(items[1].Update.UpdateExpression, 'SET creditRestoredAt = :at');
  assert.ok(items.every(item => !item.Update.Key.sk.startsWith('USAGE#')));
});

test('an ungifted email subscriber cannot reserve a run or invoke the worker', async () => {
  reset();
  assert.equal((await generate()).status, 403);
  assert.equal(state.transactions.length, 0);
  assert.equal(state.creates.length, 0);
  assert.equal(state.workers.length, 0);
});

test('gifted subscriber reserves a private run with reader revisions, then exhausts credits', async () => {
  reset();
  const gifted = await grant({ count: 1, note: 'For Panu', requestId });
  assert.deepEqual(gifted.body, { ok: true, userId: 'u1', generationCredits: 1, granted: 1 });
  assert.ok(state.reads.every(read => read.consistent === true));
  const generated = await generate();
  assert.equal(generated.status, 200);
  assert.equal(generated.body.private, true);
  assert.equal(state.profile.generationCredits, 0);
  assert.equal(state.usage, null);
  assert.equal(state.profile.openObligationId, undefined);
  const pub = state.pubs.get(generated.body.genId);
  assert.equal(pub.generationCredit, true);
  assert.equal(pub.private, true);
  assert.equal(state.creates[0].visibility, 'private');
  assert.equal(state.creates[0].revisionsAllowed, 2);
  assert.equal(state.workers.length, 1);
  assert.equal((await generate()).status, 403);
  assert.equal(state.creates.length, 1);
  assert.equal(state.workers.length, 1);
  assert.equal(state.audits[0].detail.count, 1);
});

test('a concurrent credit spend cannot start an order or worker', async () => {
  reset({ generationCredits: 1 });
  state.race = () => { state.profile.generationCredits = 0; };
  assert.equal((await generate()).status, 429);
  assert.equal(state.profile.generationCredits, 0);
  assert.equal(state.pubs.size, 0);
  assert.equal(state.creates.length, 0);
  assert.equal(state.workers.length, 0);
});

test('admin gifts validate count, member existence, bans, request id and authorization', async () => {
  reset();
  for (const count of [0, -1, 101, 1.5, '2', null, true]) {
    assert.equal((await grant({ count })).status, 400, String(count));
  }
  assert.equal((await grant({ requestId: 'bad' })).status, 400);
  for (const authorization of [undefined, 'Bearer wrong']) {
    assert.equal((await request('POST /admin/members/grant-generation', { userId: 'u1', count: 2 },
      { headers: { authorization } })).status, 401);
  }
  assert.equal(state.transactions.length, 0);
  assert.equal((await grant({ userId: 'unknown', count: 1 })).status, 404);
  state.profile.banned = true;
  assert.equal((await grant({ count: 1 })).status, 409);
  assert.equal(state.transactions.length, 0);
  reset();
  state.race = () => { state.profile.banned = true; };
  assert.equal((await grant({ count: 1 })).status, 409);
  assert.equal(state.profile.generationCredits, undefined);
  assert.equal(state.audits.length, 0);
});

test('gifts add to the persistent balance and a duplicate receipt does not add twice', async () => {
  reset({ generationCredits: 2 });
  assert.equal((await grant({ count: 3, requestId })).body.generationCredits, 5);
  const duplicate = await grant({ count: 3, requestId });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.alreadyGranted, true);
  assert.equal(duplicate.body.generationCredits, 5);
  assert.equal(state.audits.length, 1);
  assert.equal((await grant({ count: 4, requestId })).status, 409);
  assert.equal(state.profile.generationCredits, 5);
  assert.equal((await grant({ count: 100 })).body.generationCredits, 105);
});

test('no-count subscriber grant defaults to one credit; monthly member grant preserves legacy unlock', async () => {
  reset();
  assert.equal((await grant({})).body.granted, 1);
  assert.equal(state.profile.generationCredits, 1);
  reset({ role: 'analyst', openObligationId: 'old', generationCredits: 3 });
  state.usage = { genReserved: true, genId: 'old' };
  assert.equal((await grant({})).status, 200);
  assert.equal(state.profile.openObligationId, undefined);
  assert.deepEqual(state.usage, {});
  assert.equal(state.profile.generationCredits, 3);
  state.profile.openObligationId = 'old';
  state.usage = { genReserved: true, genId: 'old' };
  await grant({ count: 2 });
  assert.equal(state.profile.openObligationId, 'old');
  assert.equal(state.usage.genId, 'old');
  assert.equal(state.profile.generationCredits, 5);
});

test('/me and admin users expose balance and actual generation availability', async () => {
  reset();
  let me = (await request('GET /me')).body;
  assert.equal(me.generationCredits, 0);
  assert.equal(me.hasGeneration, false);
  assert.equal(me.generationAvailable, false);
  await grant({ count: 2 });
  me = (await request('GET /me')).body;
  assert.equal(me.generationCredits, 2);
  assert.equal(me.hasGeneration, true);
  assert.equal(me.generationAvailable, true);
  assert.equal(me.limits.generations, 0);
  const admin = (await request('GET /admin/members/users')).body.users[0];
  assert.equal(admin.generationCredits, 2);
  assert.equal(admin.usage.generationLimit, 0);
  reset({ role: 'analyst', openObligationId: 'old' });
  state.usage = { genReserved: true };
  assert.equal((await request('GET /me')).body.generationAvailable, false);
  state.profile.generationCredits = 1;
  assert.equal((await request('GET /me')).body.generationAvailable, true);
  reset({ role: 'reader' });
  assert.equal((await request('GET /me')).body.generationAvailable, true);
});

test('monthly allowance is used before gifted credits and keeps its existing publication rules', async () => {
  for (const role of ['analyst', 'reader']) {
    reset({ role, generationCredits: 2 });
    const generated = await generate();
    assert.equal(generated.status, 200);
    assert.equal(state.profile.generationCredits, 2);
    assert.equal(state.usage.genReserved, true);
    assert.equal(generated.body.private, role === 'reader');
    assert.equal(state.pubs.get(generated.body.genId).generationCredit, undefined);
    assert.equal(state.profile.openObligationId, role === 'analyst' ? generated.body.genId : undefined);
  }
});

test('gift credit bypasses a used monthly slot and old obligation but cannot be submitted', async () => {
  reset({ role: 'analyst', generationCredits: 1, openObligationId: 'old' });
  state.usage = { genReserved: true, genId: 'old' };
  const generated = await generate();
  assert.equal(generated.status, 200);
  assert.equal(generated.body.private, true);
  assert.equal(state.profile.openObligationId, 'old');
  assert.equal(state.usage.genId, 'old');
  state.orders.get(generated.body.genId).status = 'DELIVERED';
  const submitted = await request('POST /generations/{genId}/submit', {}, { pathParameters: { genId: generated.body.genId } });
  assert.equal(submitted.status, 409);
  const transaction = state.transactions.at(-1);
  assert.match(transaction.TransactItems[1].Update.ConditionExpression, /attribute_not_exists\(generationCredit\)/);
  assert.equal(state.profile.openObligationId, 'old');
});

test('monthly reservation race falls back to an available credit', async () => {
  reset({ role: 'reader', generationCredits: 1 });
  state.race = () => { state.usage = { genReserved: true, genId: 'other' }; };
  const generated = await generate();
  assert.equal(generated.status, 200);
  assert.equal(state.profile.generationCredits, 0);
  assert.equal(state.usage.genId, 'other');
  assert.equal(state.pubs.get(generated.body.genId).generationCredit, true);
});

test('a stale used monthly snapshot does not consume a gifted credit after an unlock', async () => {
  reset({ role: 'reader', generationCredits: 1 });
  state.usageSnapshot = { genReserved: true, genId: 'old' };
  const generated = await generate();
  assert.equal(generated.status, 200);
  assert.equal(state.profile.generationCredits, 1);
  assert.equal(state.usage.genId, generated.body.genId);
  assert.equal(state.pubs.get(generated.body.genId).generationCredit, undefined);
});

test('failed gifted run restores once; interruption between failure and refund can recover', async () => {
  reset({ generationCredits: 1, openObligationId: 'old' });
  state.usage = { genReserved: true, genId: 'old' };
  const id = (await generate()).body.genId;
  state.orders.get(id).status = 'FAILED';
  state.restoreFailures = 1;
  assert.equal((await poll(id)).body.generationRestored, false);
  assert.equal(state.pubs.get(id).status, 'failed');
  assert.equal(state.profile.generationCredits, 0);
  assert.equal((await poll(id)).body.generationRestored, true);
  assert.equal(state.profile.generationCredits, 1);
  assert.equal((await poll(id)).body.generationRestored, false);
  assert.equal(state.profile.generationCredits, 1);
  assert.equal(state.profile.openObligationId, 'old');
  assert.equal(state.usage.genId, 'old');
  assert.equal(state.audits.filter(a => a.type === 'generation-credit-restored').length, 1);
});

test('a failed revision of a delivered gift does not restore its spent credit', async () => {
  for (const delivery of [{ originalPdfFileName: 'first.pdf' }, { deliveredEmailAt: now.toISOString() }]) {
    reset({ generationCredits: 1 });
    const id = (await generate()).body.genId;
    Object.assign(state.orders.get(id), { status: 'FAILED', ...delivery });
    const before = state.transactions.length;
    assert.equal((await poll(id)).body.generationRestored, false);
    assert.equal(state.profile.generationCredits, 0);
    assert.equal(state.transactions.length, before);
  }
});

test('failed monthly run restores its monthly reservation without adding a gift credit', async () => {
  reset({ role: 'analyst', generationCredits: 2 });
  const id = (await generate()).body.genId;
  state.orders.get(id).status = 'FAILED';
  assert.equal((await poll(id)).body.generationRestored, true);
  assert.equal(state.profile.generationCredits, 2);
  assert.equal(state.profile.openObligationId, undefined);
  assert.deepEqual(state.usage, {});
  assert.equal((await poll(id)).body.generationRestored, false);
});

test('generation retry with the same requestId returns the original order without spending or waking twice', async () => {
  for (const role of ['subscriber', 'reader', 'analyst']) {
    reset({ role, generationCredits: 1 });
    const first = await generate({ requestId });
    assert.match(first.body.genId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const credits = state.profile.generationCredits;
    const transactions = state.transactions.length;
    const second = await generate({ requestId });
    assert.equal(second.status, 200);
    assert.equal(second.body.genId, first.body.genId);
    assert.equal(state.profile.generationCredits, credits);
    assert.equal(state.transactions.length, transactions);
    assert.equal(state.creates.length, 1);
    assert.equal(state.workers.length, 1);
    assert.equal((await generate({ requestId, ticker: 'AMD' })).status, 409);
  }
  reset({ generationCredits: 1 });
  assert.equal((await generate({ requestId: 'invalid' })).status, 400);
  assert.equal(state.transactions.length, 0);
});

test('a duplicate request racing the reservation returns its existing order without spending again', async () => {
  reset({ generationCredits: 2 });
  state.race = () => {
    const pub = state.transactions.at(-1).TransactItems[1].Put.Item;
    state.pubs.set(pub.sk.slice(4), copy(pub));
    state.profile.generationCredits = 1;
    state.orders.set(pub.sk.slice(4), { status: 'NEW', ticker: pub.ticker, companyName: 'Nokia Oyj' });
  };
  const result = await generate({ requestId });
  assert.equal(result.status, 200);
  assert.equal(state.profile.generationCredits, 1);
  assert.equal(state.creates.length, 0);
  assert.equal(state.workers.length, 0);
});

test('the same client requestId cannot share an order across members', async () => {
  reset({ generationCredits: 1 });
  const first = await generate({ requestId });
  reset({ userId: 'u2', pk: 'USER#u2', generationCredits: 1 });
  const second = await generate({ requestId });
  assert.notEqual(first.body.genId, second.body.genId);
});

test('an interrupted order write can resume the reserved request with no second credit spend', async () => {
  reset({ generationCredits: 1 });
  state.createError = true;
  assert.equal((await generate({ requestId })).status, 500);
  assert.equal(state.profile.generationCredits, 0);
  assert.equal(state.pubs.size, 1);
  assert.equal(state.workers.length, 0);
  state.createError = false;
  const resumed = await generate({ requestId });
  assert.equal(resumed.status, 200);
  assert.equal(state.profile.generationCredits, 0);
  assert.equal(state.pubs.size, 1);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.orders.size, 1);
  assert.equal(state.workers.length, 1);
});

test('a restored failed requestId remains failed and cannot restart the old reservation', async () => {
  reset({ generationCredits: 1 });
  const id = (await generate({ requestId })).body.genId;
  state.orders.get(id).status = 'FAILED';
  assert.equal((await poll(id)).body.generationRestored, true);
  state.orders.delete(id);
  const retried = await generate({ requestId });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.status, 'failed');
  assert.equal(state.profile.generationCredits, 1);
  assert.equal(state.creates.length, 1);
  assert.equal(state.workers.length, 1);
});
