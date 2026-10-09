import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../js/order-page.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

async function workspace() {
  const elements = new Map();
  const timers = new Map();
  let sequence = 0;
  let reads = 0;
  let onLock;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, dataset: {}, listeners: {}, value: '',
      classList: { add() {}, remove() {} },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      setAttribute() {}, focus() {}, scrollIntoView() {},
    });
    return elements.get(id);
  };
  const original = {
    status: 'DELIVERED', companyName: 'Test company', ticker: 'TEST',
    pdfUrl: 'https://files.example/original.pdf', revisionsAllowed: 2,
    revisionsUsed: 0, revisionHistory: [],
  };
  let state = original;
  const window = {
    location: { search: '?session_id=cs_test', hostname: 'test.example' },
    localStorage: {}, addEventListener() {}, confirm: () => true,
    ValuationWorkbench: {
      mount(_, options) { onLock = options.onLock; return { start: async () => true }; },
    },
  };
  vm.runInNewContext(source, {
    window, location: window.location, URLSearchParams,
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [] },
    fetch: async (_, options = {}) => ({
      ok: true,
      json: async () => options.method === 'POST'
        ? { ok: true, status: 'REVISING' }
        : (reads++, state),
    }),
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  await settle();
  return {
    element, timers, original, reads: () => reads,
    setState(order) { state = order; },
    async poll() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.callback();
      await settle();
    },
    async submit(kind) {
      if (kind === 'assumptions') {
        await element('valuationOpenBtn').listeners.click();
        await settle();
        onLock({ test: { marginPct: 10 } }, [{ label: 'Test', what: 'margin', before: 5, after: 10 }]);
      } else {
        element('revisionText').value = 'Revise the margin';
        await element('revisionSubmit').listeners.click();
      }
      await settle();
    },
  };
}

for (const kind of ['assumptions', 'comments']) {
  test(`${kind}: accepted revision starts polling from its acknowledgement and displays a later failure`, async () => {
    const page = await workspace();
    await page.submit(kind);
    assert.equal(page.reads(), 1, 'do not immediately read a potentially stale original DELIVERED order');
    assert.equal(page.element('stateProgress').style.display, '');
    assert.equal(page.element('stateDelivered').style.display, 'none');
    assert.equal(page.timers.size, 1);
    assert.equal([...page.timers.values()][0].delay, 8000);

    page.setState({ ...page.original, status: 'REVISING' });
    await page.poll();
    assert.equal(page.timers.size, 1);
    page.setState({ ...page.original, revisionError: 'Required bridge checks failed' });
    await page.poll();
    assert.equal(page.timers.size, 0);
    assert.equal(page.element('revisionErrorBanner').style.display, '');
    assert.match(page.element('revisionErrorBanner').textContent, /Required bridge checks failed/);
    assert.equal(page.element('downloadBtn').href, page.original.pdfUrl);
    assert.equal(page.element('revisionSubmit').disabled, false);
  });
}

test('a successful revision still updates the PDF and stops polling', async () => {
  const page = await workspace();
  await page.submit('assumptions');
  page.setState({ ...page.original, pdfUrl: 'https://files.example/revised.pdf', revisionsUsed: 1 });
  await page.poll();
  assert.equal(page.element('downloadBtn').href, 'https://files.example/revised.pdf');
  assert.equal(page.element('revisionErrorBanner').style.display, 'none');
  assert.equal(page.timers.size, 0);
});

test('a revision that fails before the first poll still displays its error', async () => {
  const page = await workspace();
  await page.submit('assumptions');
  page.setState({ ...page.original, revisionError: 'Required bridge checks failed' });
  await page.poll();
  assert.equal(page.element('revisionErrorBanner').style.display, '');
  assert.match(page.element('revisionErrorBanner').textContent, /Required bridge checks failed/);
  assert.equal(page.timers.size, 0);
});
