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
          dataset: {
            [name === 'data-open-report' ? 'openReport' : 'reviseReport']: value[1],
            freeOnly: /data-free-only="1"/.test(match[1]) ? '1' : undefined,
          },
          addEventListener: (_, listener) => { button.click = listener; },
        };
        buttons[`${name}:${value[1]}`] = button;
        return [button];
      });
    },
  };
  let opened, freeOnly, checkout;
  const context = {
    window: {
      _entitled: new Set(), SITE_PUBLIC_PRICING_PROMISE: Promise.resolve(),
      _libraryAccess: { activePlan: true, coverage: false, pickLimit: 10, picks: 0 },
    },
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
    openReport: (id, free) => { opened = id; freeOnly = free; },
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
  assert.equal(freeOnly, true);
  buttons['data-open-report:paid'].click();
  assert.equal(freeOnly, false);
  buttons['data-revise-report:upm'].click();
  assert.deepEqual(checkout, { id: 'upm', withRevisions: true });
});

test('library actions respect the account and still offer eligible revisions', async () => {
  const html = readFileSync(new URL('../../members.html', import.meta.url), 'utf8');
  const fn = html.match(/    async function loadReports\(\) \{[\s\S]*?\n    \}\r?\n\r?\n    async function openReport/)[0]
    .replace(/\s+async function openReport$/, '');
  const reports = [
    { id: 'new', companyName: 'New', ticker: 'NEW', isFree: false, freePickEligible: false, revisable: true },
    { id: 'old', companyName: 'Old', ticker: 'OLD', isFree: false, freePickEligible: true },
    { id: 'free', companyName: 'Free', ticker: 'NEW', isFree: true, freePickEligible: false },
    { id: 'owned', companyName: 'Owned', ticker: 'NEW', isFree: false, freePickEligible: false },
  ];
  async function render(access, entitled = []) {
    const table = { innerHTML: '', querySelectorAll: () => [] };
    const context = vm.createContext({
      window: { _entitled: new Set(entitled), _libraryAccess: access },
      document: { getElementById: () => table },
      api: async () => ({ data: { reports } }),
      esc: value => String(value ?? ''),
      getRevisionsChoice: () => ({ available: true, revisionsPrice: 2500 }),
      formatEurAmount: cents => `€${cents / 100}`,
    });
    vm.runInContext(fn, context);
    await context.loadReports();
    return table.innerHTML;
  }
  const analyst = { activePlan: false, coverage: false, pickLimit: 10, picks: 0 };
  let table = await render(analyst, ['owned']);
  assert.match(table, /Available for picks after 30 days/);
  assert.doesNotMatch(table, /data-open-report="new"/);
  assert.match(table, /data-revise-report="new">Revise — €25/);
  assert.match(table, /data-open-report="old">Open \(uses a pick\)/);
  assert.match(table, /data-open-report="free">Open/);
  assert.match(table, /data-open-report="owned">Open again/);

  table = await render({ ...analyst, activePlan: true });
  assert.match(table, /data-open-report="new">Open \(uses a pick\)/);
  table = await render({ ...analyst, pickLimit: 0 });
  assert.match(table, /Purchase required/);
  assert.doesNotMatch(table, /data-open-report="old"/);
  table = await render({ ...analyst, picks: 10 });
  assert.match(table, /No picks left this month/);
  table = await render({ ...analyst, activePlan: true, coverage: true, covered: ['OLD'] });
  assert.match(table, /Not covered by your plan/);
  assert.match(table, /data-open-report="old">Open with coverage/);
});

test('a library report opens even when the browser blocks an asynchronous popup', async () => {
  const html = readFileSync(new URL('../../members.html', import.meta.url), 'utf8');
  const fn = html.slice(html.indexOf('    async function openReport('), html.indexOf('    async function checkout('));
  let resolve;
  let requestBody;
  const tab = { opener: {}, closed: false, close() { this.closed = true; } };
  const context = vm.createContext({
    window: { open: () => tab }, location: { href: '' },
    api: (_method, _path, body) => { requestBody = body; return new Promise(done => { resolve = done; }); },
    loadMe() {}, notice() {},
  });
  vm.runInContext(fn, context);
  const pending = context.openReport('report', true);
  assert.equal(tab.opener, null);
  assert.equal(requestBody.onlyIfFree, true);
  resolve({ status: 200, data: { url: 'https://example.test/report.pdf' } });
  await pending;
  assert.equal(tab.location, 'https://example.test/report.pdf');

  context.window.open = () => null;
  const blocked = context.openReport('report');
  resolve({ status: 200, data: { url: 'https://example.test/report.pdf' } });
  await blocked;
  assert.equal(context.location.href, 'https://example.test/report.pdf');

  context.window.open = () => tab;
  const rejected = context.openReport('report');
  resolve({ status: 403, data: { error: 'No access' } });
  await rejected;
  assert.equal(tab.closed, true);
});

test('a publicly free analyst report shows and opens its free-read button', async () => {
  const script = readFileSync(new URL('../../js/analyst-reports.js', import.meta.url), 'utf8');
  const list = { innerHTML: '', addEventListener: (_, listener) => { list.click = listener; } };
  const mount = {
    getAttribute: name => name === 'data-ticker' ? 'TSLA' : 'Tesla',
    querySelector: selector => selector === '[data-analyst-list]' ? list : null,
  };
  const tab = {};
  const context = {
    document: { querySelector: selector => selector === '[data-analyst-reports]' ? mount : null },
    location: { hostname: 'aiequityreports.com', search: '', origin: 'https://aiequityreports.com', pathname: '/reports/tesla-equity-report.html' },
    window: { localStorage: {}, open: () => tab },
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
  assert.equal(tab.opener, null);
  assert.equal(tab.location, 'https://files.example/tesla.pdf');
  context.window.open = () => null;
  list.click({ target: { closest: selector => selector === '[data-free]' ? button : null } });
  await new Promise(setImmediate);
  assert.equal(context.location.href, 'https://files.example/tesla.pdf');
});
