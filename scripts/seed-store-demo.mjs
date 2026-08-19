#!/usr/bin/env node
// Fills the TEST members stack with a store worth looking at: named analysts,
// several takes per company, a spread of peer scores, one hand-picked free
// window, and two publications backed by real delivered PDFs from this stage.
//
//   MEMBERS_TEST_SECRET=... node scripts/seed-store-demo.mjs
//
// Idempotent enough to re-run: it adds, it never deletes. Test stack only.

const MEMBERS_API = (process.env.MEMBERS_API || 'https://members-test.aiequityreports.com').replace(/\/$/, '');
const SECRET = process.env.MEMBERS_TEST_SECRET;
if (!SECRET) {
  console.error('Set MEMBERS_TEST_SECRET (SSM /aiequityreports/test/members-test-utils-secret)');
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${MEMBERS_API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const daysAhead = (n) => new Date(Date.now() + n * 86400000).toISOString();

const ANALYSTS = [
  { name: 'Mikko Virtanen', email: 'mikko.virtanen@example.com' },
  { name: 'Sanna Koskinen', email: 'sanna.koskinen@example.com' },
  { name: 'Tuomas Lehtinen', email: 'tuomas.lehtinen@example.com' },
  { name: 'Elina Nieminen', email: 'elina.nieminen@example.com' },
  { name: 'Jonas Bergström', email: 'jonas.bergstrom@example.com' },
];

// reviewCount/scoreSum are the ranking inputs: peer score is the mean with a
// neutral prior, so these produce a visible spread rather than a flat list.
const PUBLICATIONS = [
  // Nokia — a clear leader, a middling take, one nobody has reviewed yet.
  { analyst: 0, companyId: 'NOKIA.HE', days: 26, reviews: 6, sum: 28.4, price: 12,
    genId: 'cs_test_migration_001', jobId: '01KYSCY39RHA7FVFJYDG1GFDRQ',
    prompts: 'Rebuilt the network-infrastructure segment on flat 2027 capex instead of the 4% recovery, and pushed the mobile-networks margin assumption down to the 2024 realised level. Kept the licensing line untouched — it is the one part of the base report I could not fault.' },
  { analyst: 1, companyId: 'NOKIA.HE', days: 19, reviews: 4, sum: 15.2, price: 8,
    prompts: 'Argued the peer set should exclude Ericsson on mix grounds and re-ran the multiples on the three remaining comparables.' },
  { analyst: 2, companyId: 'NOKIA.HE', days: 5, reviews: 0, sum: 0, price: 0,
    prompts: 'Reweighted the India exposure after the Q2 disclosure and left everything else as generated.' },

  // Kesko — two takes, one of them the hand-picked free one.
  { analyst: 3, companyId: 'KESKOB.HE', days: 31, reviews: 5, sum: 22.5, price: 0,
    freeUntil: daysAhead(21),
    prompts: 'Split the building-and-technical trade forecast from grocery, which the base report models as one line, and showed the two cycles pulling in opposite directions through 2027.' },
  { analyst: 1, companyId: 'KESKOB.HE', days: 12, reviews: 3, sum: 9.3, price: 6,
    prompts: 'Challenged the working-capital assumption and raised the maintenance-capex floor.' },

  // UPM — a weak take and a strong one, so the ordering is obvious.
  { analyst: 4, companyId: 'UPM.HE', days: 22, reviews: 4, sum: 7.6, price: 5,
    prompts: 'Applied a flat 10% haircut to pulp pricing across the forecast period.' },
  { analyst: 0, companyId: 'UPM.HE', days: 14, reviews: 5, sum: 23.0, price: 15,
    prompts: 'Reverse-valued the share price into an implied pulp price and showed the market is already paying for a recovery the base report treats as upside. Rebuilt the energy segment separately.' },

  // Two companies whose PDFs this stage actually generated today.
  { analyst: 2, companyId: 'ELISA.HE', days: 1, reviews: 2, sum: 9.0, price: 10,
    genId: 'cs_test_b1GuSj2Q5gRPoVGr5DmHCTJR6f5h5FUnnyVk3sIEEUrWGEGqs6KFDr8Qgr',
    jobId: '01M0CMVZV4JHGZBFDC0WZCDB2H', freeUntil: daysAhead(14),
    prompts: 'Modelled the fixed-broadband ARPU decline the base report smooths over, and separated the Estonian business, which is growing on a different curve.' },
  { analyst: 3, companyId: 'PIHLIS.HE', days: 0, reviews: 1, sum: 4.5, price: 9,
    genId: 'cs_test_b1jK9lPN4AqEJoHkSykNg7tSvCbgV2WAzeavrncRYAkTbCYIeixGbpgjrH',
    jobId: '01M0CS69VAA1DJX5J707B8RVH1',
    prompts: 'Re-ran the public-sector outsourcing pipeline on the slower award schedule and flagged the wellbeing-services-county payment terms as the real risk.' },
];

async function main() {
  const users = [];
  for (const a of ANALYSTS) {
    const { status, data } = await api('POST', '/test/users', { ...a, role: 'analyst' });
    if (status !== 200) throw new Error(`could not seed ${a.name}: ${status} ${JSON.stringify(data)}`);
    users.push({ ...a, userId: data.userId });
    console.log(`analyst  ${a.name}  ${data.userId}`);
  }

  for (const p of PUBLICATIONS) {
    const owner = users[p.analyst];
    const { status, data } = await api('POST', '/test/publications', {
      userId: owner.userId,
      analystName: owner.name,
      companyId: p.companyId,
      publishedAt: daysAgo(p.days),
      genId: p.genId,
      jobId: p.jobId,
      promptsText: p.prompts,
      priceEur: p.price,
      reviewCount: p.reviews,
      scoreSum: p.sum,
      freeUntil: p.freeUntil,
    });
    if (status !== 200) throw new Error(`could not seed ${p.companyId}: ${status} ${JSON.stringify(data)}`);
    console.log(`publish  ${p.companyId.padEnd(11)} ${owner.name.padEnd(18)} ` +
      `${p.reviews ? (p.sum / p.reviews).toFixed(2) + '/5' : 'unreviewed'}` +
      `${p.freeUntil ? '  [free window]' : ''}${p.genId ? '  [real PDF]' : ''}`);
  }

  const { data } = await api('GET', '/analyses');
  console.log(`\n${data.analyses.length} analyses in the store across ` +
    `${new Set(data.analyses.map(a => a.companyId)).size} companies`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
