import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('library buttons open the selected report and revise only eligible reports at the displayed price', async () => {
  const html = readFileSync(new URL('../../members.html', import.meta.url), 'utf8');
  const fn = html.match(/    async function loadReports\(\) \{[\s\S]*?\n    \}\r?\n\r?\n    async function openReport/)[0]
    .replace(/\s+async function openReport$/, '');
  const buttons = {};
  const table = {
    innerHTML: '',
    querySelectorAll(selector) {
      const name = selector.slice(1, -1);
      return [...this.innerHTML.matchAll(/<button\b([^>]*)>/g)].flatMap((match) => {
        const value = match[1].match(new RegExp(`${name}="([^"]+)"`));
        if (!value) return [];
        const button = {
          dataset: { [name === 'data-open-report' ? 'openReport' : 'reviseReport']: value[1] },
          addEventListener: (_, listener) => { button.click = listener; },
        };
        buttons[`${name}:${value[1]}`] = button;
        return [button];
      });
    },
  };
  let opened, checkout;
  const context = {
    window: { _entitled: new Set(), SITE_PUBLIC_PRICING_PROMISE: Promise.resolve() },
    document: { getElementById: () => table },
    api: async () => ({ data: { reports: [
      { id: 'upm', companyName: 'UPM', ticker: 'UPM.HE', isFree: true, revisable: true },
      { id: 'old', companyName: 'Old', isFree: true, revisable: false },
      { id: 'unknown', companyName: 'Unknown', isFree: true },
      { id: 'paid', companyName: 'Paid', isFree: false, revisable: true, price: 20 },
    ] } }),
    esc: value => String(value ?? ''),
    getRevisionsChoice: kind => ({ available: true, revisionsPrice: kind === 'free' ? 1000 : 2500 }),
    formatEurAmount: cents => `€${cents / 100}`,
    openReport: id => { opened = id; },
    submitReadyReportCheckout: (button, id, withRevisions) => { checkout = { id, withRevisions }; },
  };
  vm.createContext(context);
  vm.runInContext(fn, context);
  await context.loadReports();
  assert.match(table.innerHTML, /data-revise-report="upm">Revise — €10/);
  assert.match(table.innerHTML, /data-revise-report="paid">Revise — €25/);
  assert.doesNotMatch(table.innerHTML, /data-revise-report="(?:old|unknown)"/);
  buttons['data-open-report:upm'].click();
  assert.equal(opened, 'upm');
  buttons['data-revise-report:upm'].click();
  assert.deepEqual(checkout, { id: 'upm', withRevisions: true });
});

test('a publicly free analyst report shows and opens its free-read button', async () => {
  const script = readFileSync(new URL('../../js/analyst-reports.js', import.meta.url), 'utf8');
  const list = { innerHTML: '', addEventListener: (_, listener) => { list.click = listener; } };
  const mount = {
    getAttribute: name => name === 'data-ticker' ? 'TSLA' : 'Tesla',
    querySelector: selector => selector === '[data-analyst-list]' ? list : null,
  };
  let opened;
  const context = {
    document: { querySelector: selector => selector === '[data-analyst-reports]' ? mount : null },
    location: { hostname: 'aiequityreports.com', search: '', origin: 'https://aiequityreports.com', pathname: '/reports/tesla-equity-report.html' },
    window: { localStorage: {}, open: url => { opened = url; } },
    URLSearchParams,
    fetch: async url => ({ ok: true, json: async () => url.includes('/free')
      ? { url: 'https://files.example/tesla.pdf' }
      : { forkFeeEur: 10, analyses: [{ genId: 'tesla', companyId: 'TSLA', analyst: 'Lauri', priceEur: 0, publicFree: true }] } }),
  };
  vm.runInNewContext(script, context);
  await new Promise(setImmediate);
  assert.match(list.innerHTML, /Free to read/);
  assert.match(list.innerHTML, /data-free="tesla">Read free/);
  const button = { textContent: 'Read free', getAttribute: () => 'tesla' };
  list.click({ target: { closest: selector => selector === '[data-free]' ? button : null } });
  await new Promise(setImmediate);
  assert.equal(opened, 'https://files.example/tesla.pdf');
});
