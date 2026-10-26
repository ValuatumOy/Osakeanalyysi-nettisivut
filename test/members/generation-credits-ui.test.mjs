import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const members = readFileSync(new URL('../../members.html', import.meta.url), 'utf8');
const loadMe = members.slice(members.indexOf('    async function loadMe()'), members.indexOf('    async function loadReports()'));

function page(overrides) {
  const elements = new Map();
  const data = {
    tier: 'none', role: 'subscriber', publishes: false,
    hasGeneration: true, generationAvailable: true, generationCredits: 3,
    limits: { generations: 0 }, usage: { picks: 0, pickLimit: 0, genReserved: false },
    ...overrides,
  };
  const context = vm.createContext({
    window: {}, localStorage: {}, freshReceipt: null, TIER_LABELS: { none: 'No subscription' },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', innerHTML: '' });
      return elements.get(id);
    } },
    api: async () => ({ status: 200, data }),
    offerPendingPlan() {}, renderReviewRow() {}, loadReports() {}, loadEarnings() {}, loadGenerations() {},
    pollGeneration(id) { context.polled = id; },
  });
  vm.runInContext(loadMe, context);
  return { context, elements };
}

test('email member sees gifted balance and can start a private report', async () => {
  const { context, elements } = page();
  await context.loadMe();
  assert.equal(elements.get('genCard').hidden, false);
  assert.equal(elements.get('reserveRow').hidden, false);
  assert.equal(elements.get('genTitle').textContent, 'Your free private report');
  assert.match(elements.get('genStatus').textContent, /3 free generations available/);
  assert.match(elements.get('usageGrid').innerHTML, /Free generations from admin/);
  assert.doesNotMatch(elements.get('usageGrid').innerHTML, /Generation left this month/);
  assert.equal(context.window._publishes, false);
});

test('gifted analyst report is private while an existing publication remains due', async () => {
  const { context, elements } = page({ role: 'analyst', publishes: true, openObligationId: 'old', limits: { generations: 1 } });
  await context.loadMe();
  assert.equal(elements.get('reserveRow').hidden, false);
  assert.equal(elements.get('submitRow').hidden, false);
  assert.equal(elements.get('genCommit').hidden, true);
  assert.equal(context.window._publishes, false);
});

test('monthly entitlement is used before a gift credit', async () => {
  const { context, elements } = page({ role: 'analyst', publishes: true, limits: { generations: 1 } });
  await context.loadMe();
  assert.equal(elements.get('genTitle').textContent, 'Your report this month');
  assert.equal(elements.get('genCommit').hidden, false);
  assert.equal(context.window._publishes, true);
});

test('using the last credit still resumes progress without a monthly entitlement', async () => {
  const { context } = page({ hasGeneration: false, generationAvailable: false, generationCredits: 0 });
  context.localStorage.activeGenId = 'gift-run';
  await context.loadMe();
  assert.equal(context.polled, 'gift-run');
});

test('admin search finds an email subscriber and offers an explicit credit count', () => {
  const source = readFileSync(new URL('../../admin/index.html', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('    function renderUsers()'), source.indexOf("    $('user-rows').addEventListener"));
  const elements = {
    'user-search': { value: 'PANU@' }, 'user-rows': { innerHTML: '' },
  };
  const context = vm.createContext({
    $: id => elements[id], esc: x => String(x), linkedinLink: () => '',
    userRows: [
      { userId: 'panu', email: 'panu@example.com', role: 'subscriber', tier: 'none', generationCredits: 3, usage: {} },
      { userId: 'other', email: 'other@example.com', role: 'analyst', tier: 'none', usage: {} },
    ],
  });
  vm.runInContext(render + '\nrenderUsers();', context);
  assert.match(elements['user-rows'].innerHTML, /panu@example.com/);
  assert.doesNotMatch(elements['user-rows'].innerHTML, /other@example.com/);
  assert.match(elements['user-rows'].innerHTML, /data-uact="credit"/);
  assert.match(elements['user-rows'].innerHTML, /3 free generations/);
  assert.doesNotMatch(elements['user-rows'].innerHTML, /Unlock monthly generation/);
});

test('generation double-click is ignored and an interrupted request keeps its id for retry', async () => {
  const reserve = members.slice(members.indexOf('    let reservingGeneration'), members.indexOf('    async function pollGeneration'));
  const calls = [];
  const elements = { genCompany: { value: 'Example' }, genTicker: { value: 'EXM' }, reserveBtn: { disabled: false } };
  let release;
  let fail = true;
  const context = vm.createContext({
    window: {}, localStorage: {}, crypto: { randomUUID: () => 'same-request-id' },
    document: { getElementById: id => elements[id] },
    notice() {}, loadMe() {},
    api: async (_method, _route, body) => {
      calls.push(body);
      if (fail) {
        await new Promise(resolve => { release = resolve; });
        throw new Error('network interrupted');
      }
      return { status: 200, data: { genId: 'gift', company: 'Example' } };
    },
  });
  vm.runInContext(reserve, context);
  const first = context.reserveGen();
  await context.reserveGen();
  assert.equal(calls.length, 1);
  assert.equal(elements.reserveBtn.disabled, true);
  release();
  await first;
  fail = false;
  await context.reserveGen();
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.equal(context.localStorage.activeGenId, 'gift');
  assert.equal(elements.reserveBtn.disabled, false);
});
