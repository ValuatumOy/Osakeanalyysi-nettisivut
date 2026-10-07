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

test('small market shares keep six-decimal precision while other percentages stay unchanged', async () => {
  const html = await renderWorkbench([
    roboticsRow('neutral', 0.01822916667), roboticsRow('positive', 0.15625),
  ]);
  assert.match(html, /data-row="neutral" data-lever="sharePct" data-value="0\.01822916667" value="0\.018229" step="0\.0001"/);
  assert.match(html, /data-row="positive" data-lever="sharePct" data-value="0\.15625" value="0\.15625" step="0\.0001"/);
  assert.match(html, /data-lever="probabilityPct" value="20\.1" step="1"/);
  assert.match(html, /data-lever="marginPct" value="50\.1" step="1"/);
});

test('unchanged rounded market shares create no override, and arrow edits affect only that field', async () => {
  const events = {};
  const input = {
    dataset: { row: 'neutral', lever: 'sharePct', value: '0.01822916667' },
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
