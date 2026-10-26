import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../members.html', import.meta.url), 'utf8');
const loadMe = source.slice(source.indexOf('    async function loadMe()'), source.indexOf('    async function loadReports()'));
const loadGenerations = source.slice(source.indexOf('    async function loadGenerations()'), source.indexOf("    // LinkedIn's basic scope"));

function page({ hasGeneration = false, generations = [], publishes = false } = {}) {
  const elements = new Map();
  const requests = [];
  const context = vm.createContext({
    window: {}, localStorage: {}, freshReceipt: null,
    TIER_LABELS: { none: 'No subscription' }, GEN_ROW_STATUS: { DELIVERED: 'Ready' },
    document: { getElementById: id => {
      if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', innerHTML: '' });
      return elements.get(id);
    } },
    api: async (method, route) => {
      requests.push(route);
      return route === '/me'
        ? { status: 200, data: { tier: 'none', role: 'subscriber', hasGeneration, publishes, usage: { picks: 0, pickLimit: 0, genReserved: false } } }
        : { status: 200, data: { generations } };
    },
    offerPendingPlan() {}, renderReviewRow() {}, loadReports() {}, loadEarnings() {},
    esc: text => String(text), workspaceUrl: id => '/order/?session_id=' + id,
  });
  vm.runInContext(loadMe + '\n' + loadGenerations, context);
  return { context, elements, requests };
}

test('a member without generation entitlement can open an owned private report', async () => {
  const { context, elements, requests } = page({ generations: [{
    genId: 'tesla', companyName: 'Tesla', companyId: 'TSLA', status: 'DELIVERED',
    publication: 'private', private: true, revisionsAllowed: 3, revisionsUsed: 0,
  }] });
  await context.loadMe();
  await new Promise(setImmediate);
  assert.ok(requests.includes('/generations'));
  assert.equal(elements.get('genCard').hidden, false);
  assert.equal(elements.get('genTitle').textContent, 'Your reports');
  assert.match(elements.get('generationsTable').innerHTML, /Tesla/);
  assert.match(elements.get('generationsTable').innerHTML, /Open and revise/);
  assert.match(elements.get('generationsTable').innerHTML, /Private/);
  for (const id of ['genCommit', 'genPath', 'reserveRow', 'submitRow']) {
    assert.equal(elements.get(id).hidden, true, id);
  }
});

test('no entitlement and no historical reports keeps the generation card hidden', async () => {
  const { context, elements } = page();
  await context.loadMe();
  await new Promise(setImmediate);
  assert.equal(elements.get('genCard').hidden, true);
  assert.equal(elements.get('reserveRow').hidden, true);
  assert.equal(elements.get('submitRow').hidden, true);
});

test('a current private-generation entitlement still shows the reservation controls', async () => {
  const { context, elements } = page({ hasGeneration: true });
  await context.loadMe();
  await new Promise(setImmediate);
  assert.equal(elements.get('genCard').hidden, false);
  assert.equal(elements.get('reserveRow').hidden, false);
  assert.equal(elements.get('genTitle').textContent, 'Your private report this month');
  for (const id of ['genCommit', 'genPath', 'submitRow']) assert.equal(elements.get(id).hidden, true, id);
});
