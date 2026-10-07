import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../js/valuation-workbench.js', import.meta.url), 'utf8');

async function renderWorkbench(rows, sensitivityRows = [{ value: 150, label: 'bridge case', prices: [8] }], controls = {}) {
  const window = { clearTimeout() {}, setTimeout() { return 1; } };
  const context = { window };
  vm.runInNewContext(source, context, { filename: 'js/valuation-workbench.js' });

  const container = {
    html: '',
    classList: { add() {}, remove() {} },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === 'input[data-lever]' ? (controls.inputs || []) : []; },
    prepend() {},
    set innerHTML(html) { this.html = html; },
    get innerHTML() { return this.html; },
  };
  const response = {
    targetPrice: 8,
    currentPrice: 10,
    pricedAsOf: '17 September 2026',
    currency: 'EUR',
    upsidePct: -20,
    rating: 'SELL',
    bands: { buyAbovePct: 15, sellBelowPct: -15 },
    rows,
    issues: [],
    sensitivity: {
      axis: 'metricValue',
      columns: [2],
      rows: sensitivityRows,
    },
  };
  const mounted = window.ValuationWorkbench.mount(container, {
    preview: async () => ({ ok: true, json: async () => response }),
    remainingRounds: 1,
    onLock() {},
  });
  assert.equal(await mounted.start(), true);
  controls.mounted = mounted;
  return container.innerHTML;
}

const roboticsRow = (key, sharePct) => ({
  key, kind: 'option-leg', division: 'Humanoid robotics', scenario: key,
  label: 'Humanoid robotics', metricUsed: 'Sales', metricValue: 50,
  selectedMultiple: 2, contributionPerShare: 1, probabilityPct: 20.14,
  editable: ['sharePct', 'marginPct', 'selectedMultiple'],
  scale: { market: 'Humanoid robotics', marketValue: 1000, sharePct, marginPct: 50.14 },
});

test('editable numbers keep up to six decimals and small market shares use a fine arrow step', async () => {
  const html = await renderWorkbench([
    roboticsRow('neutral', 0.01822916667), roboticsRow('positive', 0.15625),
  ]);
  assert.match(html, /data-row="neutral" data-lever="sharePct" data-value="0\.01822916667" data-shown="0\.018229" value="0\.018229" step="0\.0001"/);
  assert.match(html, /data-row="positive" data-lever="sharePct" data-value="0\.15625" data-shown="0\.15625" value="0\.15625" step="0\.0001"/);
  assert.match(html, /data-lever="probabilityPct"[^>]* value="20\.14" step="1"/);
  assert.match(html, /data-lever="marginPct"[^>]* value="50\.14" step="1"/);
});

test('unchanged rounded market shares create no override, and arrow edits affect only that field', async () => {
  const events = {};
  const input = {
    dataset: { row: 'neutral', lever: 'sharePct', value: '0.01822916667', shown: '0.018229' },
    value: '0.018229', defaultValue: '0.018229',
    addEventListener(type, handler) { events[type] = handler; },
    getAttribute(name) { return name === 'step' ? '0.0001' : null; },
  };
  const controls = { inputs: [input] };
  await renderWorkbench([roboticsRow('neutral', 0.01822916667), roboticsRow('positive', 0.15625)], undefined, controls);
  events.change();
  assert.equal(JSON.stringify(controls.mounted.overrides), '{}');
  events.keydown({ key: 'ArrowUp', preventDefault() {} });
  assert.equal(input.value, '0.018329');
  assert.equal(JSON.stringify(controls.mounted.overrides), '{"neutral":{"sharePct":0.018329}}');
  input.value = input.defaultValue;
  events.change();
  assert.equal(JSON.stringify(controls.mounted.overrides), '{}');
});

test('revenue rows keep editable value and multiple without margin controls or comparisons', async () => {
  const html = await renderWorkbench([{
    key: 'biochemicals',
    kind: 'engine',
    division: 'Biochemicals',
    label: 'Biochemicals',
    metricUsed: 'Sales',
    forecastYear: 2025,
    metricValue: 150,
    selectedMultiple: 2,
    discountFactor: 1,
    contributionPerShare: 1,
    editable: ['metricValue', 'marginPct', 'selectedMultiple'],
    modelledMargin: {
      metric: 'EBIT',
      year: 2025,
      revenue: 150,
      marginPct: -79.3,
      impliedMarginPct: 100,
    },
  }]);

  assert.match(html, /data-lever="metricValue"/);
  assert.match(html, /data-lever="selectedMultiple"/);
  assert.match(html, /aria-label="revenue forecast, Biochemicals"/);
  assert.match(html, /Biochemicals · revenue forecast/);
  assert.match(html, /Biochemicals · multiple/);
  assert.match(html, /The main revenue forecast/);
  assert.doesNotMatch(html, /data-lever="marginPct"/);
  assert.doesNotMatch(html, /Biochemicals · margin/);
  assert.doesNotMatch(html, /report models -79\.3% EBIT margin|modelled EBIT margin -79\.3%/);
  assert.doesNotMatch(html, /profit forecast/);
});

test('profit rows keep their margin comparison and profit forecast labels', async () => {
  const html = await renderWorkbench([{
    key: 'pulp',
    kind: 'engine',
    division: 'Pulp',
    label: 'Pulp',
    metricUsed: 'EBIT',
    forecastYear: 2025,
    metricValue: 20,
    selectedMultiple: 4,
    discountFactor: 1,
    contributionPerShare: 1,
    editable: ['metricValue', 'marginPct', 'selectedMultiple'],
    modelledMargin: {
      metric: 'EBIT',
      year: 2025,
      revenue: 100,
      marginPct: 20,
      impliedMarginPct: 10,
    },
  }]);

  assert.match(html, /data-lever="marginPct"/);
  assert.match(html, /Pulp · profit forecast/);
  assert.match(html, /report models 20% EBIT margin; this bridge implies 10%/);
});

test('only the bridge case is marked now in the sensitivity grid', async () => {
  const html = await renderWorkbench([{
    key: 'pulp',
    kind: 'engine',
    division: 'Pulp',
    label: 'Pulp',
    metricUsed: 'EBIT',
    forecastYear: 2025,
    metricValue: 20,
    selectedMultiple: 4,
    discountFactor: 1,
    contributionPerShare: 1,
    editable: ['metricValue', 'selectedMultiple'],
  }], [
    { value: 80, label: '-20%', prices: [6] },
    { value: 90, label: '-10%', prices: [7] },
    { value: 100, label: 'bridge case', prices: [8] },
    { value: 110, label: '+10%', prices: [9] },
    { value: 120, label: '+20%', prices: [10] },
  ]);

  const sensitivity = html.slice(html.indexOf('<table class="wb-sens-table">'));
  assert.equal((sensitivity.match(/class="is-base"/g) || []).length, 1);
  assert.equal((sensitivity.match(/class="wb-sens-note">now/g) || []).length, 1);
  assert.match(sensitivity, /<tr class="is-base"><th scope="row">100<span class="wb-sens-note">now<\/span><\/th>/);
  assert.match(sensitivity, /<tr><th scope="row">80<\/th>/);
  assert.match(sensitivity, /<tr><th scope="row">90<\/th>/);
  assert.match(sensitivity, /<tr><th scope="row">110<\/th>/);
  assert.match(sensitivity, /<tr><th scope="row">120<\/th>/);
});

test('scaled option rows retain API-authorized margin inputs', async () => {
  const html = await renderWorkbench([{
    key: 'option|bull', kind: 'option-leg', division: 'Option', scenario: 'Bull',
    label: 'OPTION: Option — Bull', metricUsed: 'Sales', forecastYear: 2030,
    metricValue: 50, selectedMultiple: 2, discountFactor: 1, contributionPerShare: 1,
    probabilityPct: 20, editable: ['marketValue', 'sharePct', 'marginPct', 'selectedMultiple'],
    scale: { market: 'market', marketValue: 1000, sharePct: 10, marginPct: 50 },
  }]);
  assert.match(html, /data-lever="marginPct"/);
  assert.match(html, /data-lever="sharePct"/);
});

async function typingWorkbench(rows = [roboticsRow('neutral', 0.01822916667)]) {
  const timers = new Map(), requests = [], locked = [];
  let timerId = 0;
  const document = { activeElement: null };
  const controls = new Map();
  let inputs = [];
  function element() {
    return {
      dataset: {}, listeners: {}, disabled: false, innerHTML: '',
      addEventListener(type, handler) { this.listeners[type] = handler; },
      setAttribute(name, value) { this[name] = value; },
      getAttribute(name) { return this[name]; },
      focus() { document.activeElement = this; },
      setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
      querySelector(id) { return controls.get(id) || null; },
    };
  }
  function parseInputs(html) {
    inputs = [...html.matchAll(/<input[^>]*data-lever="[^"]+"[^>]*>/g)].map(match => {
      const input = element();
      for (const [, name, value] of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) {
        if (name.startsWith('data-')) input.dataset[name.slice(5)] = value;
        else input[name] = value;
      }
      input.defaultValue = input.value;
      return input;
    });
  }
  const summary = { markup: '', set outerHTML(html) { this.markup = html; } };
  const wrap = { set innerHTML(html) {
    const active = document.activeElement;
    if (active && active.dataset.lever) active.listeners.blur();
    parseInputs(html);
  } };
  const footer = { set outerHTML(html) { parseButtons(html); } };
  const solve = { set outerHTML(html) { parseButtons(html); } };
  function parseButtons(html) {
    for (const id of ['wbLock', 'wbReset', 'wbSolveBtn', 'wbSolveAllBtn']) {
      if (html.includes('id="' + id + '"')) controls.set('#' + id, element());
    }
    if (!controls.has('#wbSolveResult')) controls.set('#wbSolveResult', element());
    const aim = html.match(/id="wbAimPrice"[^>]*value="([^"]*)"/);
    if (aim) controls.set('#wbAimPrice', Object.assign(element(), { id: 'wbAimPrice', value: aim[1] }));
  }
  const container = {
    classList: { add() {}, remove() {} },
    set innerHTML(html) { parseInputs(html); parseButtons(html); },
    querySelector(selector) {
      if (selector === '.wb-summary') return summary;
      if (selector === '.wb-table-wrap') return wrap;
      if (selector === '.wb-footer') return footer;
      if (selector === '.wb-solve') return solve;
      if (selector.startsWith('input[data-row=')) {
        const [, key, lever] = selector.match(/data-row="([^"]+)"\]\[data-lever="([^"]+)"/);
        return inputs.find(input => input.dataset.row === key && input.dataset.lever === lever);
      }
      return controls.get(selector) || null;
    },
    querySelectorAll(selector) { return selector === 'input[data-lever]' ? inputs : []; },
  };
  const baseline = {
    targetPrice: 8, currentPrice: 10, currency: 'EUR', upsidePct: -20, rating: 'SELL',
    bands: { buyAbovePct: 15, sellBelowPct: -15 }, rows, issues: [], sensitivity: { rows: [] },
  };
  const window = {
    clearTimeout(id) { timers.delete(id); },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
  };
  vm.runInNewContext(source, { window, document, CSS: { escape: text => text } });
  let first = true;
  const mounted = window.ValuationWorkbench.mount(container, {
    remainingRounds: 1,
    onLock(overrides) { locked.push(JSON.parse(JSON.stringify(overrides))); },
    preview(body) {
      if (first) { first = false; return Promise.resolve({ ok: true, json: async () => baseline }); }
      return new Promise(resolve => requests.push({ body: JSON.parse(JSON.stringify(body)), resolve }));
    },
  });
  await mounted.start();
  const tick = () => new Promise(setImmediate);
  return {
    mounted, requests, locked, summary, controls,
    input: (lever = 'sharePct', key = 'neutral') => inputs.find(input => input.dataset.row === key && input.dataset.lever === lever),
    fire: (input, type, event = {}) => input.listeners[type]({ preventDefault() {}, ...event }),
    async timers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); await tick(); },
    async respond(index, extra = {}) {
      const request = requests[index];
      const result = JSON.parse(JSON.stringify(baseline));
      for (const row of result.rows) for (const [lever, value] of Object.entries(request.body.overrides[row.key] || {})) {
        if (lever === 'sharePct' || lever === 'marginPct' || lever === 'marketValue') row.scale[lever] = value;
        else row[lever] = value;
      }
      request.resolve({ ok: true, json: async () => ({ ...result, ...extra }) });
      await tick();
    },
  };
}

test('decimal comma draft and the entire selection survive a preview response', async () => {
  const w = await typingWorkbench();
  const input = w.input();
  input.focus(); input.value = '0,25'; input.setSelectionRange(1, 4, 'backward');
  w.fire(input, 'input');
  assert.equal(w.controls.get('#wbLock').disabled, true);
  await w.timers();
  assert.equal(w.requests[0].body.overrides.neutral.sharePct, 0.25);
  await w.respond(0, { targetPrice: 12 });
  assert.equal(w.input().value, '0,25');
  assert.equal(w.input().selectionStart, 1);
  assert.equal(w.input().selectionEnd, 4);
  assert.equal(w.input().selectionDirection, 'backward');
  assert.equal(w.controls.get('#wbLock').disabled, false);
  w.fire(w.input(), 'blur');
  assert.equal(w.input().value, '0.25');
  assert.equal(w.controls.get('#wbLock').disabled, false, 'unchanged blur must not require a second lock click');
  w.fire(w.controls.get('#wbLock'), 'click');
  assert.deepEqual(w.locked, [{ neutral: { sharePct: 0.25 } }]);
});

test('incomplete drafts keep the last valid override and invalidate an older response before debounce', async () => {
  for (const raw of ['', '-', '0.', '0,', '1,2,3', '1.234.56']) {
    const w = await typingWorkbench();
    const input = w.input();
    input.value = '0.5'; w.fire(input, 'input'); await w.timers();
    input.value = raw; w.fire(input, 'input');
    assert.equal(w.mounted.overrides.neutral.sharePct, 0.5, raw);
    await w.respond(0, { targetPrice: 123 });
    assert.doesNotMatch(w.summary.markup, /123/);
    assert.equal(w.controls.get('#wbLock').disabled, true, raw);
    w.fire(w.controls.get('#wbLock'), 'click');
    assert.equal(w.locked.length, 0);
    await w.timers();
    assert.equal(w.requests.length, 1, 'invalid draft must not request zero or reuse the last value');
  }
});

test('a newer valid keystroke supersedes the in-flight preview immediately', async () => {
  const w = await typingWorkbench();
  let input = w.input();
  input.value = '0.25'; w.fire(input, 'input'); await w.timers();
  input.value = '0,75'; w.fire(input, 'input');
  await w.respond(0, { targetPrice: 999 });
  assert.doesNotMatch(w.summary.markup, /999/);
  assert.equal(w.controls.get('#wbLock').disabled, true);
  await w.timers(); await w.respond(1, { targetPrice: 15 });
  assert.equal(w.controls.get('#wbLock').disabled, false);
  assert.equal(w.mounted.overrides.neutral.sharePct, 0.75);
});

test('probability decimals remain raw until commit, which keeps the whole-percent rule', async () => {
  const w = await typingWorkbench();
  const input = w.input('probabilityPct');
  input.value = '12,7'; w.fire(input, 'input');
  assert.equal(input.value, '12,7');
  assert.equal(w.mounted.overrides.neutral.probabilityPct, 12.7);
  w.fire(input, 'keydown', { key: 'Enter' });
  assert.equal(input.value, '13');
  assert.equal(w.mounted.overrides.neutral.probabilityPct, 13);
  await w.timers();
  assert.equal(w.requests[0].body.overrides.neutral.probabilityPct, 13);
});

test('probability still rounds on blur after its fractional preview has already completed', async () => {
  const w = await typingWorkbench();
  const input = w.input('probabilityPct');
  input.focus(); input.value = '12,7'; w.fire(input, 'input');
  await w.timers(); await w.respond(0);
  assert.equal(w.input('probabilityPct').value, '12,7');
  w.fire(w.input('probabilityPct'), 'blur');
  assert.equal(w.input('probabilityPct').value, '13');
  assert.equal(w.mounted.overrides.neutral.probabilityPct, 13);
  assert.equal(w.controls.get('#wbLock').disabled, true);
});

test('starting a solve cancels the typed timer and typing invalidates the solver response', async () => {
  const w = await typingWorkbench();
  const input = w.input(); input.value = '0.25'; w.fire(input, 'input');
  const solving = w.fire(w.controls.get('#wbSolveBtn'), 'click');
  assert.equal(w.requests.length, 1);
  await w.timers();
  assert.equal(w.requests.length, 1, 'solver validation replaces the typed debounce');
  await w.respond(0);
  assert.equal(w.requests.length, 2);
  assert.equal(w.requests[1].body.solve.for, 'sharePct');
  w.input().value = '0.75'; w.fire(w.input(), 'input');
  await w.respond(1, { solve: { reached: true, value: 99, targetAtValue: 10 } });
  await solving;
  assert.equal(w.mounted.overrides.neutral.sharePct, 0.75);
  assert.doesNotMatch(w.controls.get('#wbSolveResult').innerHTML, /99|Set it and see/);
  assert.equal(w.controls.get('#wbLock').disabled, true);
});

test('untouched rounded values in every lever keep the exact baseline on blur', async () => {
  const row = roboticsRow('neutral', 0.01822916667);
  row.scale.marginPct = 50.123456789; row.selectedMultiple = 2.123456789;
  row.probabilityPct = 20.123456789; row.scale.marketValue = 1000.123456789;
  row.editable.push('metricValue', 'marketValue');
  const engine = { key: 'engine', kind: 'engine', division: 'Auto', label: 'Auto', metricUsed: 'Sales', metricValue: 123.456789123, selectedMultiple: 2, editable: ['metricValue'] };
  const w = await typingWorkbench([row, engine]);
  for (const lever of ['sharePct', 'marginPct', 'selectedMultiple', 'probabilityPct', 'marketValue']) {
    w.fire(w.input(lever), 'blur');
    assert.equal(JSON.stringify(w.mounted.overrides), '{}', lever);
  }
  w.fire(w.input('metricValue', 'engine'), 'blur');
  assert.equal(JSON.stringify(w.mounted.overrides), '{}', 'metricValue');
});

test('fractional multiple, margin and metric values agree between the committed field and its override', async () => {
  const engine = { key: 'engine', kind: 'engine', division: 'Auto', label: 'Auto', metricUsed: 'Sales', metricValue: 20000, selectedMultiple: 2, editable: ['metricValue'] };
  for (const [lever, key, raw, value] of [['selectedMultiple', 'neutral', '12,34', 12.34], ['marginPct', 'neutral', '20.12', 20.12], ['metricValue', 'engine', '21500,5', 21500.5]]) {
    const w = await typingWorkbench([roboticsRow('neutral', 0.01822916667), engine]);
    const input = w.input(lever, key); input.value = raw; w.fire(input, 'input');
    w.fire(input, 'blur');
    assert.equal(input.value, String(value));
    assert.equal(w.mounted.overrides[key][lever], value);
    await w.timers(); await w.respond(0);
    assert.equal(w.input(lever, key).value, String(value));
  }
});

test('target-price text and selection also survive a pending bridge preview', async () => {
  const w = await typingWorkbench();
  const share = w.input(); share.value = '0,25'; w.fire(share, 'input'); await w.timers();
  const aim = w.controls.get('#wbAimPrice');
  aim.focus(); aim.value = '123,45'; aim.setSelectionRange(2, 5, 'backward');
  w.fire(aim, 'input');
  await w.respond(0);
  const restored = w.controls.get('#wbAimPrice');
  assert.equal(restored.value, '123,45');
  assert.equal(restored.selectionStart, 2);
  assert.equal(restored.selectionEnd, 5);
  assert.equal(restored.selectionDirection, 'backward');
});

test('plain editable numbers accept both decimal styles and unambiguous grouped pastes', async () => {
  for (const [raw, expected] of [['0,25', 0.25], ['0.25', 0.25], ['1 234,56', 1234.56], ['1,234.56', 1234.56], ['1.234,56', 1234.56], ['1,234,567', 1234567]]) {
    const w = await typingWorkbench();
    const input = w.input(); input.value = raw; w.fire(input, 'input');
    assert.equal(w.mounted.overrides.neutral.sharePct, expected, raw);
  }
});

test('reset cancels the typed timer and prevents its stale response from restoring overrides', async () => {
  const w = await typingWorkbench();
  const input = w.input(); input.value = '0.25'; w.fire(input, 'input'); await w.timers();
  input.value = '0.75'; w.fire(input, 'input');
  w.fire(w.controls.get('#wbReset'), 'click');
  assert.equal(JSON.stringify(w.mounted.overrides), '{}');
  assert.equal(w.requests.length, 2);
  await w.timers();
  assert.equal(w.requests.length, 2, 'cancelled typed timer must not fire after reset');
  await w.respond(0, { targetPrice: 999 });
  assert.equal(w.controls.get('#wbLock').disabled, true);
  await w.respond(1);
  assert.equal(JSON.stringify(w.mounted.overrides), '{}');
});
