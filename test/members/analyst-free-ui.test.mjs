import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('free analyst reports stay readable without disturbing an existing review', async () => {
  const html = readFileSync(new URL('../../members.html', import.meta.url), 'utf8');
  const list = html.slice(html.indexOf('    async function loadAnalyses()'), html.indexOf('    // Reading someone'));
  const open = html.slice(html.indexOf('    async function openAnalysis('), html.indexOf('    async function submitReview()'));
  const purchase = html.slice(html.indexOf('    async function buyOrFork('), html.indexOf('    function focusReview()'));
  const analyses = [
    { genId: 'public', companyId: 'RIVAL', analystId: 'other', analyst: 'Other', publishedAt: '2026-01-01', free: true, publicFree: true },
    { genId: 'member-free', companyId: 'RIVAL', analystId: 'other', analyst: 'Other', publishedAt: '2026-01-01', free: true, publicFree: false },
    { genId: 'paid', companyId: 'OTHER', analystId: 'other', analyst: 'Other', publishedAt: '2026-01-01', free: false },
    { genId: 'mine', companyId: 'RIVAL', analystId: 'me', analyst: 'Me', publishedAt: '2026-01-01', free: true },
  ];
  const elements = { analysesTicker: { value: '' }, analysesTable: { innerHTML: '' } };
  const calls = [];
  const tabs = [];
  let focused = 0;
  let purchasePrompt = '';
  const context = vm.createContext({
    window: {
      _memberUserId: 'me', _myCompanies: new Set(['RIVAL']), _openReviewId: 'pending',
      _openPrompts: 'pending prompts', _openOriginalUrl: 'pending original',
      open() { const tab = {}; tabs.push(tab); return tab; },
    },
    document: { getElementById: id => elements[id] },
    esc: value => String(value ?? ''),
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      return method === 'GET' ? { status: 200, data: { analyses, forkFeeEur: 10 } }
        : { status: 200, data: { free: true, url: 'https://example.test/free.pdf', promptsText: 'different', originalUrl: 'different' } };
    },
    confirm: () => { throw new Error('a free report should not ask to spend a read'); },
    prompt: message => { purchasePrompt = message; return null; },
    focusReview: () => { focused++; }, notice() {}, loadMe() {}, renderReviewRow() {},
  });
  vm.runInContext(list + open + purchase, context);
  await context.loadAnalyses();
  const rows = elements.analysesTable.innerHTML.split('</tr>');
  assert.match(rows.find(row => row.includes('RIVAL') && row.includes("openAnalysis('public')")), /Free for everyone/);
  assert.match(rows.find(row => row.includes("openAnalysis('public')")), /Build on this — €10/);
  assert.doesNotMatch(rows.find(row => row.includes("openAnalysis('public')")), /Buy or build on/);
  assert.match(rows.find(row => row.includes("openAnalysis('member-free')")), /Free for you/);
  assert.match(rows.find(row => row.includes('OTHER')), /Locked/);
  assert.match(rows.find(row => row.includes('>Me<')), /Your report/);

  await context.openAnalysis('public');
  await context.openAnalysis('member-free');
  assert.equal(calls.filter(call => call.method === 'POST').length, 2);
  assert.ok(calls.filter(call => call.method === 'POST').every(call => call.body.onlyIfFree === true));
  assert.equal(tabs[0].location, 'https://example.test/free.pdf');
  assert.equal(context.window._openReviewId, 'pending');
  assert.equal(context.window._openPrompts, 'pending prompts');
  assert.equal(context.window._openOriginalUrl, 'pending original');
  assert.equal(focused, 0);
  await context.openAnalysis('paid');
  assert.equal(focused, 1);
  assert.equal(calls.filter(call => call.method === 'POST').length, 2);
  await context.buyOrFork('paid', 12);
  assert.match(purchasePrompt, /report only \(12 €\)/);
  assert.match(purchasePrompt, /steer \(22 €\)/);
});
