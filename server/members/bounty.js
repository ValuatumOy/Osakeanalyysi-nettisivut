// Per-published-report analyst bounty. Pure — no AWS calls, no clock of its own.
//
// Eligibility is DERIVED from the analyst's own PUB#/PAYOUT# items, never stored:
// publish time, company, takedown and payout are all already on those items, so
// one Dynamo query plus this function is the whole ledger. No sweep job, no
// accrual transactions, nothing to race. See docs/analyst-publishing.md.

// Publish is automatic, so the moderation window is the quality gate: a bounty
// only matures once the analysis has survived MATURITY_DAYS without takedown.
// A sale waits the same window, which doubles as the refund/dispute window.
const MATURITY_DAYS = 14;

// The analyst's half of every sale of their analysis (decision 21.8.2026,
// replacing the flat fee as the headline). Share of gross: what the reader paid,
// before Stripe's cut, so the number in the member area matches the price the
// analyst set.
const REVENUE_SHARE = 0.5;
// Bounds worst-case spend, and one company per quarter kills "same company,
// five takes" farming.
const MONTHLY_CAP = 4;

const DAY_MS = 24 * 3600 * 1000;

function quarterKey(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

function monthKey(iso) {
  return String(iso).slice(0, 7); // YYYY-MM
}

function amountEur() {
  return Number(process.env.BOUNTY_EUR_PER_REPORT || 0);
}

function shareOf(grossEur, share) {
  return Math.round(Number(grossEur || 0) * share * 100) / 100;
}

/**
 * @param pubs  PUB# items: { sk, status, publishedAt, companyId, takenDownAt }
 * @param opts  { now: Date, paidGenIds: Set|Array, paidAmounts, maturityDays, monthlyCap, amount }
 *              paidAmounts (genId → €) is what was actually paid; without it a
 *              later fee change would retroactively rewrite past payouts.
 * @returns { entries, totals } — entries in publish order, state one of
 *          pending | eligible | paid | clawback | void
 */
function ledger(pubs, {
  now,
  sales = [],
  paidGenIds = [],
  paidAmounts = {},
  maturityDays = MATURITY_DAYS,
  monthlyCap = MONTHLY_CAP,
  amount = amountEur(),
  share = REVENUE_SHARE,
} = {}) {
  const paid = paidGenIds instanceof Set ? paidGenIds : new Set(paidGenIds);
  const paidAmount = (genId) => (paidAmounts[genId] === undefined ? amount : paidAmounts[genId]);
  const nowMs = now.getTime();

  // Earliest publish wins a contested quarter slot or cap slot, so the ledger is
  // stable: a later publication can never demote one already counted.
  const rows = pubs
    .filter((p) => p.publishedAt && p.companyId
      && (p.status === 'published' || p.status === 'takendown'))
    .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));

  const claimedQuarters = new Set();
  const monthCounts = new Map();
  const entries = [];

  for (const p of rows) {
    const genId = String(p.sk || '').replace(/^PUB#/, '');
    const isPaid = paid.has(genId);
    const entry = {
      genId,
      companyId: p.companyId,
      publishedAt: p.publishedAt,
      amount: 0,
      state: 'void',
      reason: null,
    };
    entries.push(entry);

    if (p.status === 'takendown') {
      entry.state = isPaid ? 'clawback' : 'void';
      entry.reason = 'takendown';
      if (isPaid) entry.amount = -paidAmount(genId);
      continue;
    }

    const quarter = `${p.companyId}#${quarterKey(p.publishedAt)}`;
    if (claimedQuarters.has(quarter)) {
      entry.reason = 'same-company-this-quarter';
      continue;
    }

    const month = monthKey(p.publishedAt);
    const used = monthCounts.get(month) || 0;
    if (used >= monthlyCap) {
      entry.reason = 'monthly-cap';
      continue;
    }

    claimedQuarters.add(quarter);
    monthCounts.set(month, used + 1);
    entry.amount = isPaid ? paidAmount(genId) : amount;

    const maturesAt = new Date(new Date(p.publishedAt).getTime() + maturityDays * DAY_MS);
    entry.maturesAt = maturesAt.toISOString();
    if (isPaid) entry.state = 'paid';
    else if (nowMs < maturesAt.getTime()) entry.state = 'pending';
    else entry.state = 'eligible';
  }

  // Sales of the analyst's own analyses. No quarter or month cap here: those
  // bound flat-fee spam, and a share is self-funding — no sale, no payout.
  const statusOf = new Map(rows.map((p) => [String(p.sk || '').replace(/^PUB#/, ''), p.status]));
  const saleEntries = sales
    .filter((s) => s.soldAt && s.genId)
    .sort((a, b) => String(a.soldAt).localeCompare(String(b.soldAt)))
    .map((s) => {
      const saleId = String(s.sk || '').replace(/^SALE#/, '') || `${s.genId}#${s.sessionId || ''}`;
      const payoutId = `SALE#${saleId}`;
      const isPaid = paid.has(payoutId);
      const gross = Number(s.grossEur || 0);
      const entry = {
        saleId,
        payoutId,
        genId: s.genId,
        companyId: s.companyId || null,
        soldAt: s.soldAt,
        grossEur: gross,
        amount: 0,
        state: 'void',
        reason: null,
      };
      const share_ = paidAmounts[payoutId] === undefined ? shareOf(gross, share) : paidAmounts[payoutId];

      if (statusOf.get(s.genId) === 'takendown') {
        entry.state = isPaid ? 'clawback' : 'void';
        entry.reason = 'takendown';
        if (isPaid) entry.amount = -share_;
        return entry;
      }

      entry.amount = share_;
      const maturesAt = new Date(new Date(s.soldAt).getTime() + maturityDays * DAY_MS);
      entry.maturesAt = maturesAt.toISOString();
      if (isPaid) entry.state = 'paid';
      else if (nowMs < maturesAt.getTime()) entry.state = 'pending';
      else entry.state = 'eligible';
      return entry;
    });

  const sumOf = (list, state) => Math.round(list.filter((e) => e.state === state)
    .reduce((acc, e) => acc + e.amount, 0) * 100) / 100;
  const sum = (state) => sumOf(entries, state);

  return {
    entries,
    saleEntries,
    totals: {
      amount,
      share,
      pending: sum('pending'),
      eligible: sum('eligible'),
      paid: sum('paid'),
      clawback: sum('clawback'),
      salesCount: saleEntries.filter((e) => e.state !== 'void').length,
      grossSales: Math.round(saleEntries
        .filter((e) => e.state !== 'void' && e.state !== 'clawback')
        .reduce((acc, e) => acc + e.grossEur, 0) * 100) / 100,
      sharePending: sumOf(saleEntries, 'pending'),
      shareEligible: sumOf(saleEntries, 'eligible'),
      sharePaid: sumOf(saleEntries, 'paid'),
      shareClawback: sumOf(saleEntries, 'clawback'),
    },
  };
}

/** genIds that may be paid out right now. */
function payableGenIds(pubs, opts) {
  return ledger(pubs, opts).entries.filter((e) => e.state === 'eligible').map((e) => e.genId);
}

/** Everything payable right now, fee and revenue share alike, with its amount. */
function payableItems(pubs, opts) {
  const { entries, saleEntries } = ledger(pubs, opts);
  return [
    // The flat fee is off by default, and a €0 payout row is not a payment.
    ...entries.filter((e) => e.state === 'eligible' && e.amount > 0)
      .map((e) => ({ id: e.genId, kind: 'fee', amount: e.amount })),
    ...saleEntries.filter((e) => e.state === 'eligible')
      .map((e) => ({ id: e.payoutId, kind: 'share', amount: e.amount })),
  ];
}

module.exports = {
  MATURITY_DAYS, MONTHLY_CAP, REVENUE_SHARE, quarterKey, ledger, payableGenIds, payableItems,
};
