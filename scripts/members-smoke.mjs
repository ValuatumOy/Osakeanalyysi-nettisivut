#!/usr/bin/env node
// Smoke test for the deployed members TEST stack. Creates throwaway users via
// the test-utils endpoint and walks the quota rules end to end.
//
//   MEMBERS_TEST_SECRET=... node scripts/members-smoke.mjs
//
// Optional: MEMBERS_API (default members-test), CATALOG_API (default api-test).

const MEMBERS_API = (process.env.MEMBERS_API || 'https://members-test.aiequityreports.com').replace(/\/$/, '');
const CATALOG_API = (process.env.CATALOG_API || 'https://api-test.aiequityreports.com').replace(/\/$/, '');
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

async function catalogReports() {
  const res = await fetch(`${CATALOG_API}/api/reports`);
  if (!res.ok) return [];
  const { reports } = await res.json();
  return reports || [];
}

// ── scenarios ────────────────────────────────────────────────────────────────

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
  check('analyst /me: pickLimit 2', me.data?.usage?.pickLimit === 2, JSON.stringify(me.data?.usage));

  if (oldPaid.length >= 4) {
    const [r1, r2, r3] = oldPaid;
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
    const open3 = await api('POST', `/reports/${r3.id}/open`, { token: analyst.token });
    check('freemium pick 3 → 429', open3.status === 429, `got ${open3.status}`);

    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 2, 1); // +2 keeps genId month distinct too
    const timeTravel = await api('POST', `/reports/${r3.id}/open`, {
      token: analyst.token, testNow: nextMonth.toISOString(),
    });
    check('next month (x-test-now): pick works again', timeTravel.status === 200, `got ${timeTravel.status}`);
  } else {
    check('freemium pick scenarios', false, 'not enough >30d paid reports in the test catalog');
  }

  if (newPaid.length) {
    const tooNew = await api('POST', `/reports/${newPaid[0].id}/open`, { token: analyst.token });
    check('freemium: report under 30 days → 403', tooNew.status === 403, `got ${tooNew.status}`);
  } else {
    console.log('· skip: no fresh paid report in the test catalog for the age-gate check');
  }

  // — generation obligation loop —
  const gen1 = await api('POST', '/generations/free', { token: analyst.token });
  check('reserve free generation', gen1.status === 200 && gen1.data?.genId, JSON.stringify(gen1.data));
  const gen2 = await api('POST', '/generations/free', { token: analyst.token });
  check('second reserve blocked by obligation → 409', gen2.status === 409, `got ${gen2.status}`);

  const submit = await api('POST', `/generations/${gen1.data?.genId}/submit`, {
    token: analyst.token, body: { promptsText: 'smoke-test prompts' },
  });
  check('submit for publication', submit.status === 200, JSON.stringify(submit.data));

  const gen3 = await api('POST', '/generations/free', { token: analyst.token });
  check('same month after submit: still 429 (one per month)', gen3.status === 429, `got ${gen3.status}`);

  const nextMonth = new Date();
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  const gen4 = await api('POST', '/generations/free', {
    token: analyst.token, testNow: nextMonth.toISOString(),
  });
  check('next month after submit: reserve works', gen4.status === 200, `got ${gen4.status}`);

  // — investor tier —
  if (oldPaid.length + newPaid.length >= 6) {
    const investor = (await testApi('POST', '/test/users', {
      role: 'subscriber', tier: 'investor', tierStatus: 'active',
    })).data;
    check('create investor test user', Boolean(investor?.token));
    const candidates = [...oldPaid, ...newPaid].slice(0, 6);
    let opened = 0;
    for (const report of candidates.slice(0, 5)) {
      const res = await api('POST', `/reports/${report.id}/open`, { token: investor.token });
      if (res.status === 200) opened++;
    }
    check('investor: 5 picks succeed (incl. fresh reports)', opened === 5, `${opened}/5`);
    const sixth = await api('POST', `/reports/${candidates[5].id}/open`, { token: investor.token });
    check('investor: 6th pick → 429', sixth.status === 429, `got ${sixth.status}`);

    // concurrency: fresh user, burn 4 picks, then race 2 opens for the last slot
    const racer = (await testApi('POST', '/test/users', {
      role: 'subscriber', tier: 'investor', tierStatus: 'active',
    })).data;
    for (const report of candidates.slice(0, 4)) {
      await api('POST', `/reports/${report.id}/open`, { token: racer.token });
    }
    const [a, b] = await Promise.all([
      api('POST', `/reports/${candidates[4].id}/open`, { token: racer.token }),
      api('POST', `/reports/${candidates[5].id}/open`, { token: racer.token }),
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
