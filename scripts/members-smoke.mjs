#!/usr/bin/env node
// Smoke test for the deployed members TEST stack. Creates throwaway users via
// the test-utils endpoint and walks the quota rules end to end.
//
//   MEMBERS_TEST_SECRET=... node scripts/members-smoke.mjs
//
// Optional: MEMBERS_API (default members-test).
// Optional: STRIPE_TEST_SECRET_KEY (sk_test_…) — lets the purchase scenario read
//   the created checkout session back and assert its success_url. Without it the
//   scenario still runs, minus that one readback.
// Optional: SMOKE_SITE_ORIGIN (default https://test.aiequityreports.com) — the
//   site the buyer is returned to.

const MEMBERS_API = (process.env.MEMBERS_API || 'https://members-test.aiequityreports.com').replace(/\/$/, '');
const SITE_ORIGIN = (process.env.SMOKE_SITE_ORIGIN || 'https://test.aiequityreports.com').replace(/\/$/, '');
const TEST_SECRET = process.env.MEMBERS_TEST_SECRET;
if (!TEST_SECRET) {
  console.error('Set MEMBERS_TEST_SECRET (SSM /aiequityreports/test/members-test-utils-secret)');
  process.exit(1);
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function api(method, path, { token, body, testNow } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (testNow) {
    headers['x-test-now'] = testNow;
    headers['x-test-secret'] = TEST_SECRET;
  }
  const res = await fetch(`${MEMBERS_API}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, data };
}

const testApi = (method, path, body) => api(method, path, {
  body, token: TEST_SECRET,
});

// ── pick candidate reports from the test catalog ─────────────────────────────

const daysOld = (report) => (Date.now() - new Date(report.reportDate).getTime()) / 86400000;

// The members API's own catalog, not the stage's public API. Since the members
// stack reads production's catalog in every stage, any other source hands the
// smoke report ids the API it is testing has never heard of.
async function catalogReports() {
  const res = await fetch(`${MEMBERS_API}/reports`);
  if (!res.ok) return [];
  const { reports } = await res.json();
  return reports || [];
}

// ── scenarios ────────────────────────────────────────────────────────────────

const adminApi = (method, path, body) => api(method, path, { body, token: process.env.ADMIN_PASSWORD });

// The API hands back the hosted checkout URL and never the session it built, so
// the only way to see where a buyer would be sent afterwards is to ask Stripe.
// The session id is in the hosted URL. Test-mode key, and optional: without it
// the purchase scenario runs, minus this one readback.
const STRIPE_KEY = process.env.STRIPE_TEST_SECRET_KEY;
let stripeClient = null;
async function checkoutSession(url) {
  const id = String(url || '').match(/cs_(?:test|live)_[A-Za-z0-9]+/)?.[0];
  if (!id || !STRIPE_KEY) return null;
  if (!stripeClient) {
    const { default: Stripe } = await import('stripe');
    stripeClient = new Stripe(STRIPE_KEY);
  }
  return stripeClient.checkout.sessions.retrieve(id);
}

async function main() {
  const health = await api('GET', '/health');
  check('health', health.status === 200 && health.data?.ok, JSON.stringify(health.data));

  const reports = await catalogReports();
  const paid = reports.filter(r => !r.isFree);
  const oldPaid = paid.filter(r => daysOld(r) >= 31);
  const newPaid = paid.filter(r => daysOld(r) < 29);
  console.log(`catalog: ${reports.length} reports, ${oldPaid.length} old paid, ${newPaid.length} fresh paid`);

  // — freemium analyst —
  const analyst = (await testApi('POST', '/test/users', { role: 'analyst' })).data;
  check('create analyst test user', Boolean(analyst?.token), analyst?.userId);

  const me = await api('GET', '/me', { token: analyst.token });
  // The three numbers are demand-tuned (MEMBERS_LIMITS_JSON), so the smoke reads
  // them instead of asserting a constant.
  const pickLimit = me.data?.usage?.pickLimit || 0;
  check('analyst /me: three allowances present',
    pickLimit > 0 && me.data?.usage?.analystReadLimit > 0 && me.data?.limits?.generations === 1,
    JSON.stringify(me.data?.usage));
  check('analyst /me: publishing role', me.data?.publishes === true, String(me.data?.role));

  if (oldPaid.length >= 2) {
    const [r1, r2] = oldPaid;
    const open1 = await api('POST', `/reports/${r1.id}/open`, { token: analyst.token });
    check('freemium pick 1 → signed URL', open1.status === 200 && open1.data?.url?.includes('X-Amz-Signature'));
    if (open1.status === 200) {
      const pdf = await fetch(open1.data.url);
      check('signed URL returns PDF bytes', pdf.ok && (pdf.headers.get('content-type') || '').includes('pdf'),
        `status ${pdf.status}`);
    }
    const reopen = await api('POST', `/reports/${r1.id}/open`, { token: analyst.token });
    check('re-open same report: no extra quota', reopen.status === 200);
    const open2 = await api('POST', `/reports/${r2.id}/open`, { token: analyst.token });
    check('freemium pick 2', open2.status === 200);
  } else {
    check('freemium pick scenarios', false,
      'need 2 paid reports older than 30 days in the test catalog');
  }

  // Exhausting the allowance needs one distinct report per slot plus one over.
  // The analyst allowance is now 10, which is more than the test catalog holds,
  // so this is a catalog limit rather than a failure — the same 429 and the
  // month reset are covered by the investor block below and by
  // test/members/quota.test.mjs.
  if (oldPaid.length >= pickLimit + 2) {
    const overLimitReport = oldPaid[pickLimit];
    // Burn the rest of the month's allowance, then one over it.
    for (const report of oldPaid.slice(2, pickLimit)) {
      await api('POST', `/reports/${report.id}/open`, { token: analyst.token });
    }
    const overLimit = await api('POST', `/reports/${overLimitReport.id}/open`, { token: analyst.token });
    check(`freemium pick ${pickLimit + 1} → 429`, overLimit.status === 429, `got ${overLimit.status}`);

    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 2, 1); // +2 keeps genId month distinct too
    const timeTravel = await api('POST', `/reports/${overLimitReport.id}/open`, {
      token: analyst.token, testNow: nextMonth.toISOString(),
    });
    check('next month (x-test-now): pick works again', timeTravel.status === 200, `got ${timeTravel.status}`);
  } else {
    console.log(`· skip: analyst allowance exhaustion — test catalog has ${oldPaid.length} paid reports over 30 days, needs ${pickLimit + 2}`);
  }

  if (newPaid.length) {
    const tooNew = await api('POST', `/reports/${newPaid[0].id}/open`, { token: analyst.token });
    check('freemium: report under 30 days → 403', tooNew.status === 403, `got ${tooNew.status}`);
  } else {
    console.log('· skip: no fresh paid report in the test catalog for the age-gate check');
  }

  // — generation obligation loop —
  // A reservation creates a real order and spends a real engine run (~20 min),
  // so this block is opt-in. Everything else in the smoke is free.
  const genBody = { company: 'Nokia Oyj', ticker: 'NOKIA.HE' };
  const missing = await api('POST', '/generations/free', { token: analyst.token, body: {} });
  check('reserve without a company → 400', missing.status === 400, `got ${missing.status}`);

  const emptyEarnings = await api('GET', '/me/earnings', { token: analyst.token });
  check('earnings endpoint answers for an analyst', emptyEarnings.status === 200,
    JSON.stringify(emptyEarnings.data));

  if (!process.env.SMOKE_ENGINE) {
    console.log('· skip: generation + publication loop (set SMOKE_ENGINE=1 — costs one engine run)');
  } else {
    const gen1 = await api('POST', '/generations/free', { token: analyst.token, body: genBody });
    check('reserve free generation', gen1.status === 200 && gen1.data?.genId, JSON.stringify(gen1.data));
    const gen2 = await api('POST', '/generations/free', { token: analyst.token, body: genBody });
    check('second reserve blocked by obligation → 409', gen2.status === 409, `got ${gen2.status}`);

    const submit = await api('POST', `/generations/${gen1.data?.genId}/submit`, {
      token: analyst.token, body: { promptsText: 'smoke-test prompts' },
    });
    check('submit publishes', submit.status === 200 && submit.data?.status === 'published',
      JSON.stringify(submit.data));

    // Published today, so the 14-day moderation window is still open.
    const earnings = await api('GET', '/me/earnings', { token: analyst.token });
    const entry = earnings.data?.entries?.[0];
    check('earnings ledger: freshly published bounty is pending',
      earnings.status === 200 && entry?.state === 'pending' && entry?.companyId === 'NOKIA.HE',
      JSON.stringify(earnings.data));

    const gen3 = await api('POST', '/generations/free', { token: analyst.token, body: genBody });
    check('same month after publishing: still 429 (one per month)', gen3.status === 429, `got ${gen3.status}`);

    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
    const gen4 = await api('POST', '/generations/free', {
      token: analyst.token, body: genBody, testNow: nextMonth.toISOString(),
    });
    check('next month after publication: reserve works', gen4.status === 200, `got ${gen4.status}`);
  }

  // — bounty ledger (seeded publications, no engine run) —
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const seed = (userId, companyId, publishedAt) =>
    testApi('POST', '/test/publications', { userId, companyId, publishedAt });

  const matured = (await seed(analyst.userId, 'UPM.HE', ago(20))).data?.genId;
  await seed(analyst.userId, 'FORTUM.HE', ago(2));            // still in the window
  await seed(analyst.userId, 'UPM.HE', ago(19));              // same company, same quarter

  const ledger = (await api('GET', '/me/earnings', { token: analyst.token })).data;
  const byState = (state) => ledger.entries.filter(e => e.state === state).length;
  check('ledger: matured → eligible, fresh → pending, repeat company → void',
    byState('eligible') === 1 && byState('pending') === 1 && byState('void') === 1,
    JSON.stringify(ledger.entries.map(e => [e.companyId, e.state, e.reason])));

  if (process.env.ADMIN_PASSWORD) {
    // The flat fee is off by default (BOUNTY_EUR_PER_REPORT=0) and nothing pays
    // out €0, so the payout path is only assertable when a fee is configured.
    const feeOn = Number(ledger.totals?.amount) > 0;
    const payout = await adminApi('POST', '/admin/members/payout', { userId: analyst.userId });
    if (feeOn) {
      check('payout: pays only the eligible one', payout.status === 200 && payout.data?.paid?.length === 1,
        JSON.stringify(payout.data));

      const afterPay = (await api('GET', '/me/earnings', { token: analyst.token })).data;
      check('ledger after payout: that entry is paid',
        afterPay.entries.filter(e => e.state === 'paid').length === 1,
        JSON.stringify(afterPay.totals));

      const again = await adminApi('POST', '/admin/members/payout', { userId: analyst.userId });
      check('payout is not repeatable → 409', again.status === 409, `got ${again.status}`);
    } else {
      check('payout: nothing owed while the flat fee is 0 → 409', payout.status === 409,
        `got ${payout.status}: ${JSON.stringify(payout.data)}`);
    }

    const down = await adminApi('POST', '/admin/members/takedown',
      { userId: analyst.userId, genId: matured, reason: 'smoke test' });
    check('takedown of a published analysis', down.status === 200, JSON.stringify(down.data));

    const afterDown = (await api('GET', '/me/earnings', { token: analyst.token })).data;
    check('takedown voids the entry, and claws it back if it had been paid',
      afterDown.entries.some(e => e.genId === matured
        && e.state === (feeOn ? 'clawback' : 'void')),
      JSON.stringify(afterDown.totals));
  } else {
    console.log('· skip: payout/takedown checks (set ADMIN_PASSWORD to include them)');
  }

  // — the income an analyst actually sees: half of every sale of their work —
  {
    const seller = (await testApi('POST', '/test/users', { role: 'analyst' })).data;
    const soldGen = (await seed(seller.userId, 'SALES.HE', ago(30))).data?.genId;
    const seedSale = (grossEur, soldAt) => testApi('POST', '/test/sales',
      { userId: seller.userId, genId: soldGen, companyId: 'SALES.HE', grossEur, soldAt });

    const first = await seedSale(20, ago(20));   // matured
    await seedSale(35, ago(2));                  // still inside the 14-day window
    check('a sale can be recorded against a publication', first.status === 200 && first.data?.wrote,
      JSON.stringify(first.data));

    const dup = await testApi('POST', '/test/sales', {
      userId: seller.userId, genId: soldGen, companyId: 'SALES.HE', grossEur: 20,
      soldAt: ago(20), sessionId: first.data.sessionId,
    });
    check('the same checkout session never pays twice', dup.status === 200 && dup.data?.wrote === false,
      JSON.stringify(dup.data));

    const income = (await api('GET', '/me/earnings', { token: seller.token })).data;
    check('the analyst sees half of each sale: €10 payable, €17.50 maturing',
      income?.totals?.shareEligible === 10 && income?.totals?.sharePending === 17.5
        && income?.totals?.grossSales === 55,
      JSON.stringify(income?.totals));
    check('each sale is its own row, with what the reader paid',
      income?.saleEntries?.length === 2 && income.saleEntries[0].grossEur === 20
        && income.saleEntries[0].amount === 10,
      JSON.stringify(income?.saleEntries));

    const readerOfSales = (await testApi('POST', '/test/users', { role: 'reader' })).data;
    const denied = await api('GET', '/me/earnings', { token: readerOfSales.token });
    check('a reader has no earnings ledger → 403', denied.status === 403, `got ${denied.status}`);

    if (process.env.ADMIN_PASSWORD) {
      const pay = await adminApi('POST', '/admin/members/payout', { userId: seller.userId });
      check('the payable half settles, and only that half',
        pay.status === 200 && pay.data?.total === 10 && pay.data?.paid?.length === 1
          && pay.data.paid[0].kind === 'share',
        JSON.stringify(pay.data));

      const afterPay = (await api('GET', '/me/earnings', { token: seller.token })).data;
      check('a settled sale reads as paid, not payable',
        afterPay?.totals?.sharePaid === 10 && afterPay?.totals?.shareEligible === 0,
        JSON.stringify(afterPay?.totals));

      // Before the takedown, so the row shows the state an arriving invoice is
      // checked against: one sale settled, one still held.
      const owed = await adminApi('GET', '/admin/members/earnings');
      const row = owed.data?.analysts?.find(a => a.userId === seller.userId);
      check('admin sees what each analyst is owed, against an arriving invoice',
        owed.status === 200 && row && row.paid === 10 && row.readyToInvoice === 0
          && row.held === 17.5 && row.grossSales === 55,
        JSON.stringify(row || owed.data));

      const down = await adminApi('POST', '/admin/members/takedown',
        { userId: seller.userId, genId: soldGen, reason: 'smoke test' });
      check('takedown of a sold analysis', down.status === 200, JSON.stringify(down.data));

      const afterDown = (await api('GET', '/me/earnings', { token: seller.token })).data;
      check('a takedown claws the paid share back and voids the held one',
        afterDown?.totals?.shareClawback === -10 && afterDown?.totals?.sharePending === 0,
        JSON.stringify(afterDown?.totals));


    }
  }

  // — reader role, analyst reads and the review obligation —
  const reader = (await testApi('POST', '/test/users', { role: 'reader' })).data;
  const readerMe = await api('GET', '/me', { token: reader.token });
  check('reader: no publish obligation, roughly half the picks',
    readerMe.data?.publishes === false && readerMe.data?.usage?.pickLimit < pickLimit,
    JSON.stringify(readerMe.data?.usage));
  const readerGen = await api('POST', '/generations/free', { token: reader.token, body: {} });
  check('reader still has a generation (400 for the missing company, not 403)',
    readerGen.status === 400, `got ${readerGen.status}`);

  const seedForReads = (userId, companyId, publishedAt) =>
    testApi('POST', '/test/publications', { userId, companyId, publishedAt });
  const readable = (await seedForReads(analyst.userId, 'KESKOB.HE', new Date().toISOString())).data?.genId;

  const listed = await api('GET', '/analyses?companyId=KESKOB.HE');
  check('company analyses are listed publicly, best first',
    listed.status === 200 && listed.data?.analyses?.some(a => a.genId === readable),
    JSON.stringify(listed.data?.analyses?.slice(0, 2)));

  const ownOpen = await api('POST', `/analyses/${readable}/open`, { token: analyst.token });
  check('an analyst cannot spend a read on their own analysis → 400', ownOpen.status === 400,
    `got ${ownOpen.status}`);

  const open = await api('POST', `/analyses/${readable}/open`, { token: reader.token });
  check('opening another analyst\'s analysis', open.status === 200, JSON.stringify(open.data));

  const second = await api('POST', `/analyses/${readable}/open`, { token: reader.token });
  check('re-opening the same analysis does not double-charge', second.status === 200,
    `got ${second.status}`);

  const shortComment = await api('POST', `/analyses/${readable}/review`, {
    token: reader.token, body: { score: 4, comment: 'good' },
  });
  check('a review without a real comparison → 400', shortComment.status === 400,
    `got ${shortComment.status}`);

  for (const [label, score] of [['0.5', 0.5], ['5.5', 5.5], ['not a number', 'good']]) {
    const bad = await api('POST', `/analyses/${readable}/review`, {
      token: reader.token,
      body: { score, comment: 'A long enough comparison to clear the forty-character minimum.' },
    });
    check(`a score of ${label} is refused → 400`, bad.status === 400, `got ${bad.status}`);
  }

  const review = await api('POST', `/analyses/${readable}/review`, {
    token: reader.token,
    body: { score: 4.5, comment: 'Adds a genuine argument over the base report on the margin outlook.' },
  });
  check('a decimal score is accepted and stored as given', review.status === 200 && review.data?.score === 4.5,
    JSON.stringify(review.data));

  const afterReview = await api('GET', '/analyses?companyId=KESKOB.HE');
  check('the review counts towards the company ordering',
    afterReview.data?.analyses?.find(a => a.genId === readable)?.reviewCount === 1,
    JSON.stringify(afterReview.data?.analyses?.[0]));

  // — buying an analysis, and landing back on the page it was bought from —
  //
  // The buyer's copy is handed over by the return trip alone, so the return page
  // is the delivery mechanism. frontendUrl() used to swap any page it did not
  // recognise for the members page, and the company report pages that sell these
  // analyses are far too many to list, so buyers were returned to a page that
  // could not hand over what they had paid for. What follows asserts a report
  // page survives the round trip whole, receipt and all.
  {
    const returnTo = `${SITE_ORIGIN}/reports/tesla-equity-report.html`;

    const seeded = (await testApi('POST', '/test/publications', {
      userId: analyst.userId, companyId: 'BUYME.HE', priceEur: 12,
    })).data?.genId;
    check('seed a priced publication to buy', Boolean(seeded), String(seeded));

    // A seeded publication has no engine order behind it, which is the
    // undeliverable case: priced, published, and still not payable for.
    const undeliverable = await api('POST', `/analyses/${seeded}/buy-checkout`, { body: { returnTo } });
    check('a priced analysis with no document to hand over → 409', undeliverable.status === 409,
      `got ${undeliverable.status} ${JSON.stringify(undeliverable.data)}`);
    const forkUndeliverable = await api('POST', `/analyses/${seeded}/fork-checkout`, { body: { returnTo } });
    check('an analysis with no report to build on cannot be forked → 409', forkUndeliverable.status === 409,
      `got ${forkUndeliverable.status} ${JSON.stringify(forkUndeliverable.data)}`);

    // The collection endpoint the return page calls, refusing on its own terms.
    const noSession = await api('GET', `/analyses/${seeded}/purchased`);
    check('collecting a purchase without a session id → 400', noSession.status === 400,
      `got ${noSession.status}`);
    const madeUp = await api('GET', `/analyses/${seeded}/purchased?session_id=cs_test_madeup`);
    check('collecting with a made-up session id → 404', madeUp.status === 404, `got ${madeUp.status}`);

    // A real session needs a delivered engine report behind the publication, and
    // no test-utils route seeds one — so the success_url checks ride on whatever
    // the stage has genuinely published rather than on a seed.
    const listed = (await api('GET', '/analyses')).data?.analyses || [];
    let sellable = null;
    let buyUrl = null;
    for (const candidate of listed.filter(a => a.priceEur > 0 && !a.publicFree).slice(0, 8)) {
      const buy = await api('POST', `/analyses/${candidate.genId}/buy-checkout`, { body: { returnTo } });
      if (buy.status === 200 && String(buy.data?.url || '').startsWith('https://checkout.stripe.com/')) {
        sellable = candidate;
        buyUrl = buy.data.url;
        break;
      }
    }

    if (!sellable) {
      console.log('· skip: buy/fork return-page checks — no deliverable priced analysis published on this stage');
    } else {
      check('buying an analysis returns a hosted checkout link', Boolean(buyUrl), sellable.genId);

      const fork = await api('POST', `/analyses/${sellable.genId}/fork-checkout`, { body: { returnTo } });
      check('forking the same analysis returns a hosted checkout link',
        fork.status === 200 && String(fork.data?.url || '').startsWith('https://checkout.stripe.com/'),
        `got ${fork.status} ${JSON.stringify(fork.data)}`);

      const buySession = await checkoutSession(buyUrl);
      const forkSession = await checkoutSession(fork.data?.url);
      if (!buySession) {
        console.log('· skip: where the buyer is returned to (set STRIPE_TEST_SECRET_KEY to include it)');
      } else {
        // An exact string: frontendUrl() strips query and fragment off the
        // caller's page, so the whole success_url is predictable, and anything
        // else means the buyer lands somewhere that cannot deliver. This also
        // fails when the stage's MEMBERS_FRONTEND_URLS does not carry this
        // origin — which is the same bug wearing a config hat.
        check('the buyer comes back to the report page they bought from, carrying the receipt',
          buySession.success_url === `${returnTo}?bought=${sellable.genId}&session_id={CHECKOUT_SESSION_ID}`,
          buySession.success_url);
        check('a fork comes back to the caller\'s own page, marked as a fork',
          forkSession?.success_url === `${returnTo}?forked=${sellable.genId}&session_id={CHECKOUT_SESSION_ID}`,
          forkSession?.success_url);
      }
    }
  }

  // — the funnel: self-downgrade, admin role change —
  const stepDown = (await testApi('POST', '/test/users', { role: 'analyst' })).data;
  const downgraded = await api('POST', '/me/role', { token: stepDown.token, body: { role: 'reader' } });
  check('an analyst can step down to reader', downgraded.status === 200, JSON.stringify(downgraded.data));
  const upgradeSelf = await api('POST', '/me/role', { token: stepDown.token, body: { role: 'analyst' } });
  check('self-service upgrade is refused → 400', upgradeSelf.status === 400, `got ${upgradeSelf.status}`);

  if (process.env.ADMIN_PASSWORD) {
    const publications = await adminApi('GET', '/admin/members/publications');
    check('admin sees what analysts published, with their prompts',
      publications.status === 200 && publications.data?.publications?.some(p => p.genId === readable),
      `count ${publications.data?.count}`);

    const featured = await adminApi('POST', '/admin/members/feature',
      { userId: analyst.userId, genId: readable, days: 7 });
    check('an analysis can be handed out free for a period', featured.status === 200,
      JSON.stringify(featured.data));
    const freeNow = await api('GET', '/analyses?companyId=KESKOB.HE');
    const featuredRow = freeNow.data?.analyses?.find(a => a.genId === readable);
    check('a featured analysis shows as free', featuredRow?.free === true, JSON.stringify(featuredRow));
    check('a featured analysis is public-free', featuredRow?.publicFree === true, JSON.stringify(featuredRow));

    // The whole point of the rule: no token at all on these two calls.
    const anonFeatured = await api('GET', `/analyses/${readable}/free`);
    check('a logged-out visitor may open a featured analysis',
      anonFeatured.status === 200 || anonFeatured.status === 404,
      `got ${anonFeatured.status} ${JSON.stringify(anonFeatured.data)}`);

    const notFeatured = freeNow.data?.analyses?.find(a => a.genId !== readable && !a.publicFree);
    if (notFeatured) {
      const anonDenied = await api('GET', `/analyses/${notFeatured.genId}/free`);
      check('a logged-out visitor may not open an analysis outside a free window',
        anonDenied.status === 403, `got ${anonDenied.status}`);
    } else {
      console.log('· skip: no un-featured analysis in the index to check the anonymous refusal against');
    }

    const anonUnknown = await api('GET', '/analyses/00000000-0000-0000-0000-000000000000/free');
    check('an unknown analysis is a 404 to a logged-out visitor', anonUnknown.status === 404,
      `got ${anonUnknown.status}`);

    // Buying: a checkout session is created, never driven. The hosted page and
    // the card belong to a human.
    const sale = freeNow.data?.analyses?.find(a => a.priceEur > 0 && !a.publicFree);
    if (sale) {
      const buy = await api('POST', `/analyses/${sale.genId}/buy-checkout`, { body: {} });
      // 409 when the seeded analysis has no delivered order behind it. The point
      // is that it never returns a payable link for an undeliverable document.
      check('a priced analysis returns a checkout link, or refuses to sell what it cannot deliver',
        (buy.status === 200 && String(buy.data?.url || '').startsWith('https://checkout.stripe.com/'))
          || buy.status === 409,
        `got ${buy.status} ${JSON.stringify(buy.data)}`);
    } else {
      console.log('· skip: no priced analysis in the index to check the buy path against');
    }

    const buyFree = await api('POST', `/analyses/${readable}/buy-checkout`, { body: {} });
    check('an analysis inside its free window is not for sale → 400', buyFree.status === 400,
      `got ${buyFree.status}`);

    const noSession = await api('GET', `/analyses/${readable}/purchased`);
    check('collecting a purchase on a free analysis without a session id → 400', noSession.status === 400,
      `got ${noSession.status}`);

    const badSession = await api('GET', `/analyses/${readable}/purchased?session_id=cs_test_nope`);
    check('an unknown checkout session is a 404', badSession.status === 404, `got ${badSession.status}`);

    const coach = await adminApi('POST', '/admin/members/role',
      { userId: stepDown.userId, role: 'coaching' });
    check('admin can promote to coaching analyst', coach.status === 200, JSON.stringify(coach.data));

    const grant = await adminApi('POST', '/admin/members/grant-generation', { userId: analyst.userId });
    check('admin can clear the gates for the next generation', grant.status === 200,
      JSON.stringify(grant.data));
  } else {
    console.log('· skip: admin publications/feature/role/grant checks (set ADMIN_PASSWORD)');
  }

  // — investor tier —
  if (oldPaid.length + newPaid.length >= 6) {
    const investor = (await testApi('POST', '/test/users', {
      role: 'subscriber', tier: 'investor', tierStatus: 'active',
    })).data;
    check('create investor test user', Boolean(investor?.token));
    const candidates = [...oldPaid, ...newPaid].slice(0, 6);
    // A test user has no billing interval, so it gets the monthly allowance.
    const LIMIT = 3;
    let opened = 0;
    for (const report of candidates.slice(0, LIMIT)) {
      const res = await api('POST', `/reports/${report.id}/open`, { token: investor.token });
      if (res.status === 200) opened++;
    }
    check(`investor: ${LIMIT} monthly picks succeed (incl. fresh reports)`, opened === LIMIT, `${opened}/${LIMIT}`);
    const overLimit = await api('POST', `/reports/${candidates[LIMIT].id}/open`, { token: investor.token });
    check('investor: one pick over the limit → 429', overLimit.status === 429, `got ${overLimit.status}`);

    // concurrency: fresh user, burn all but one pick, then race 2 opens for the last slot
    const racer = (await testApi('POST', '/test/users', {
      role: 'subscriber', tier: 'investor', tierStatus: 'active',
    })).data;
    for (const report of candidates.slice(0, LIMIT - 1)) {
      await api('POST', `/reports/${report.id}/open`, { token: racer.token });
    }
    const [a, b] = await Promise.all([
      api('POST', `/reports/${candidates[LIMIT - 1].id}/open`, { token: racer.token }),
      api('POST', `/reports/${candidates[LIMIT].id}/open`, { token: racer.token }),
    ]);
    const successes = [a, b].filter(r => r.status === 200).length;
    check('race on last pick: exactly 1 succeeds', successes === 1, `${successes} succeeded (${a.status}, ${b.status})`);
  } else {
    check('investor scenarios', false, 'not enough paid reports in the test catalog');
  }

  // — subscriber with no subscription —
  const nobody = (await testApi('POST', '/test/users', { role: 'subscriber' })).data;
  if (oldPaid.length) {
    const denied = await api('POST', `/reports/${oldPaid[0].id}/open`, { token: nobody.token });
    check('subscriber without subscription → 402', denied.status === 402, `got ${denied.status}`);
  }
  const genDenied = await api('POST', '/generations/free', { token: nobody.token });
  check('non-analyst free generation → 403', genDenied.status === 403, `got ${genDenied.status}`);

  console.log(failures ? `\n${failures} FAILURES` : '\nall good');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
