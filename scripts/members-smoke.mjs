#!/usr/bin/env node
// Smoke test for the deployed members TEST stack. Creates throwaway users via
// the test-utils endpoint and walks the quota rules end to end.
//
//   MEMBERS_TEST_SECRET=... node scripts/members-smoke.mjs
//
// Optional: MEMBERS_API (default members-test).

const MEMBERS_API = (process.env.MEMBERS_API || 'https://members-test.aiequityreports.com').replace(/\/$/, '');
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
    const payout = await adminApi('POST', '/admin/members/payout', { userId: analyst.userId });
    check('payout: pays only the eligible one', payout.status === 200 && payout.data?.paid?.length === 1,
      JSON.stringify(payout.data));

    const afterPay = (await api('GET', '/me/earnings', { token: analyst.token })).data;
    check('ledger after payout: that entry is paid',
      afterPay.entries.filter(e => e.state === 'paid').length === 1,
      JSON.stringify(afterPay.totals));

    const again = await adminApi('POST', '/admin/members/payout', { userId: analyst.userId });
    check('payout is not repeatable → 409', again.status === 409, `got ${again.status}`);

    const down = await adminApi('POST', '/admin/members/takedown',
      { userId: analyst.userId, genId: matured, reason: 'smoke test' });
    check('takedown of a published analysis', down.status === 200, JSON.stringify(down.data));

    const afterDown = (await api('GET', '/me/earnings', { token: analyst.token })).data;
    check('takedown claws back a paid bounty',
      afterDown.entries.some(e => e.genId === matured && e.state === 'clawback'),
      JSON.stringify(afterDown.totals));
  } else {
    console.log('· skip: payout/takedown checks (set ADMIN_PASSWORD to include them)');
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
