// Pure builders for the members-table quota/entitlement writes. No AWS calls
// here — every function returns command params so tests can assert the exact
// ConditionExpressions. All quota periods are calendar-based (UTC).

// Allowances live in tiers.js — three tunable numbers per role/tier.
const FREEMIUM_MIN_AGE_DAYS = 30;
const COVERAGE_UPDATES_PER_YEAR = 4;
// An analysis may be given away free for at most a year (Esa, 17.8.2026): the
// analyst sets the decay themselves, and free archive accumulates by itself.
const MAX_FREE_AFTER_DAYS = 365;
const DAY_MS = 24 * 3600 * 1000;

function monthKey(now) {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

function yearKey(now) {
  return now.toISOString().slice(0, 4); // YYYY
}

// Publications are listed per company (company page ordering) and, rarely, all
// of them (admin review). One index partition serves both: the sort key starts
// with the company so a company query is a begins_with, and the whole partition
// is small enough to read and sort in memory for the admin view.
function publicationIndexSk({ companyId, publishedAt, genId }) {
  return `${String(companyId).toUpperCase()}#${publishedAt}#${genId}`;
}

function clampFreeAfterDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return MAX_FREE_AFTER_DAYS;
  return Math.min(Math.round(n), MAX_FREE_AFTER_DAYS);
}

// The prompts published with an analyst's report are the revision comments they
// actually sent the engine, oldest first — not whatever the client posts.
function revisionPrompts(order) {
  return (order?.revisionHistory || [])
    .map((entry) => String(entry.comments || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

// Freemium picks only reports older than 30 days. ageDays comes from the
// server-side catalog (reportDate), never from the client.
function freemiumPickEligible(report) {
  return Number(report?.ageDays) >= FREEMIUM_MIN_AGE_DAYS;
}

// Consume one monthly pick AND grant the entitlement atomically. If two
// concurrent opens race, exactly one transaction commits.
function buildPickTransact({ table, userId, now, limit, reportId, source }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `USAGE#${monthKey(now)}` },
          UpdateExpression: 'SET picks = if_not_exists(picks, :zero) + :one',
          ConditionExpression: 'attribute_not_exists(picks) OR picks < :limit',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':limit': limit },
        },
      },
      {
        Put: {
          TableName: table,
          Item: {
            pk: `USER#${userId}`,
            sk: `ENT#${reportId}`,
            source,
            grantedAt: now.toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(sk)',
        },
      },
    ],
  };
}

// Reserve a paying member's monthly generation (Investor Plus). No publish
// obligation — the report stays private — so the only gate is one per month.
function buildReserveMemberGenerationTransact({ table, userId, now, genId }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `USAGE#${monthKey(now)}` },
          UpdateExpression: 'SET genReserved = :true, genId = :genId',
          ConditionExpression: 'attribute_not_exists(genReserved)',
          ExpressionAttributeValues: { ':true': true, ':genId': genId },
        },
      },
      {
        Put: {
          TableName: table,
          Item: {
            pk: `USER#${userId}`,
            sk: `PUB#${genId}`,
            status: 'generating',
            private: true,
            reservedAt: now.toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(sk)',
        },
      },
    ],
  };
}

// Reserve the analyst's monthly free generation. Two gates in one transaction:
// the publish obligation on PROFILE (spans months by design — no new free run
// until the previous one is submitted) and the one-per-calendar-month flag.
function buildReserveGenerationTransact({ table, userId, now, genId }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
          UpdateExpression: 'SET openObligationId = :genId',
          ConditionExpression:
            'attribute_not_exists(openObligationId) AND (attribute_not_exists(banned) OR banned = :false) '
            + 'AND #role IN (:analyst, :coaching)',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: {
            ':genId': genId, ':false': false, ':analyst': 'analyst', ':coaching': 'coaching',
          },
        },
      },
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `USAGE#${monthKey(now)}` },
          UpdateExpression: 'SET genReserved = :true, genId = :genId',
          ConditionExpression: 'attribute_not_exists(genReserved)',
          ExpressionAttributeValues: { ':true': true, ':genId': genId },
        },
      },
      {
        Put: {
          TableName: table,
          Item: {
            pk: `USER#${userId}`,
            sk: `PUB#${genId}`,
            status: 'generating',
            reservedAt: now.toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(sk)',
        },
      },
    ],
  };
}

// Submit publishes straight away (auto-publish + post-moderation) and releases
// the obligation, so next month's generation unlocks. companyId and jobId are
// required: the bounty ledger keys on the company, and jobId is the provenance
// link back to the engine job the published PDF came from.
function buildSubmitTransact({
  table, userId, now, genId, promptsText, companyId, jobId,
  priceEur = 0, freeAfterDays, analystName = '',
}) {
  const at = now.toISOString();
  const company = String(companyId).toUpperCase();
  const days = clampFreeAfterDays(freeAfterDays);
  // The analyst sets both the price and how long until the analysis falls free.
  const freeFrom = new Date(now.getTime() + days * DAY_MS).toISOString();
  const price = Math.max(0, Math.round(Number(priceEur) || 0));
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
          UpdateExpression: 'REMOVE openObligationId',
          // Tolerates an admin having already cleared the obligation to unblock
          // the next generation (buildGrantGenerationTransact) — the report
          // still gets published.
          ConditionExpression: 'attribute_not_exists(openObligationId) OR openObligationId = :genId',
          ExpressionAttributeValues: { ':genId': genId },
        },
      },
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `PUB#${genId}` },
          UpdateExpression: 'SET #status = :published, publishedAt = :at, promptsText = :prompts, '
            + 'companyId = :company, jobId = :job, priceEur = :price, freeAfterDays = :days, '
            + 'freeFrom = :freeFrom',
          ConditionExpression: '#status = :generating',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':published': 'published',
            ':generating': 'generating',
            ':at': at,
            ':prompts': promptsText || '',
            ':company': company,
            ':job': jobId || '',
            ':price': price,
            ':days': days,
            ':freeFrom': freeFrom,
          },
        },
      },
      {
        Put: {
          TableName: table,
          Item: {
            pk: 'PUBINDEX',
            sk: publicationIndexSk({ companyId: company, publishedAt: at, genId }),
            userId,
            genId,
            companyId: company,
            analystName,
            jobId: jobId || '',
            publishedAt: at,
            status: 'published',
            priceEur: price,
            freeFrom,
            reviewCount: 0,
            scoreSum: 0,
          },
        },
      },
    ],
  };
}

// Admin: release the analyst so they can generate again immediately, without
// waiting for the calendar (Esa, 17.8.2026 — a good analyst is free labour and
// should not be throttled). Unconditional on purpose: it must work whether the
// analyst is blocked by the obligation, by the month's slot, or by both.
// A generation the member paid for. It touches neither the monthly flag nor
// the publish obligation — those govern the free run, and a bought report is
// private and owes nothing. The PUB row is what makes it theirs: the member
// area lists it, and the revision workspace checks ownership through it.
// Idempotent, because the same Stripe receipt may be presented twice.
function buildPaidGenerationTransact({ table, userId, now, genId }) {
  return {
    TransactItems: [
      {
        Put: {
          TableName: table,
          Item: {
            pk: `USER#${userId}`,
            sk: `PUB#${genId}`,
            status: 'generating',
            private: true,
            paid: true,
            reservedAt: now.toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(sk)',
        },
      },
    ],
  };
}

// A generation the engine could not deliver must not cost the member their
// month. Two steps, because they answer different questions.
//
// The publication row is closed out on its own: that run is over whatever else
// has happened since, and leaving it 'generating' would show a dead run as
// still working in the member's list.
function buildFailPublicationTransact({ table, userId, genId, now }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `PUB#${genId}` },
          UpdateExpression: 'SET #status = :failed, failedAt = :at',
          ConditionExpression: '#status = :generating',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':failed': 'failed', ':generating': 'generating', ':at': now.toISOString() },
        },
      },
    ],
  };
}

// The reservation is released only while it still belongs to this run. An
// admin who already credited the member by hand, or a member who has since
// started another generation, owns those two rows now — cancelling the
// transaction is the correct outcome there, not a failure to handle.
// The USAGE row is the month the generation was RESERVED in: a run that starts
// in August and fails in September must clear August's flag.
function buildReleaseReservationTransact({ table, userId, genId, reservedAt, now }) {
  const reservedMonth = monthKey(reservedAt ? new Date(reservedAt) : now);
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          // A private generation (reader, Investor Plus) carries no obligation,
          // so "no obligation" is a pass, not a reason to abort the release.
          Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
          UpdateExpression: 'REMOVE openObligationId',
          ConditionExpression: 'attribute_not_exists(openObligationId) OR openObligationId = :genId',
          ExpressionAttributeValues: { ':genId': genId },
        },
      },
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `USAGE#${reservedMonth}` },
          UpdateExpression: 'REMOVE genReserved, genId',
          ConditionExpression: 'genId = :genId',
          ExpressionAttributeValues: { ':genId': genId },
        },
      },
    ],
  };
}

function buildGrantGenerationTransact({ table, userId, now }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
          UpdateExpression: 'REMOVE openObligationId SET generationGrantedAt = :at',
          ExpressionAttributeValues: { ':at': now.toISOString() },
        },
      },
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `USAGE#${monthKey(now)}` },
          UpdateExpression: 'REMOVE genReserved, genId',
        },
      },
    ],
  };
}

// Self-service role change, downward only (analyst → reader). Blocked while an
// obligation is open: otherwise an analyst generates a report, drops the role,
// and walks away with it unpublished.
function buildRoleChangeTransact({ table, userId, role }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
          UpdateExpression: 'SET #role = :role',
          ConditionExpression: 'attribute_not_exists(openObligationId)',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':role': role },
        },
      },
    ],
  };
}

// Opening another analyst's analysis costs one monthly read AND leaves a review
// obligation: the next one stays locked until this one has been scored and
// commented (Esa, 17.8.2026). Same shape as the publish obligation.
function buildOpenAnalysisTransact({ table, userId, now, limit, genId, ownerId }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `USAGE#${monthKey(now)}` },
          UpdateExpression: 'SET analystReads = if_not_exists(analystReads, :zero) + :one',
          ConditionExpression: 'attribute_not_exists(analystReads) OR analystReads < :limit',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':limit': limit },
        },
      },
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
          UpdateExpression: 'SET openReviewId = :genId',
          ConditionExpression: 'attribute_not_exists(openReviewId)',
          ExpressionAttributeValues: { ':genId': genId },
        },
      },
      {
        Put: {
          TableName: table,
          Item: {
            pk: `USER#${userId}`,
            sk: `READ#${genId}`,
            ownerId,
            openedAt: now.toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(sk)',
        },
      },
    ],
  };
}

// The review that pays for the read: a score plus a written comparison. Counters
// on the index item are what orders the analyses on a company page.
function buildReviewTransact({ table, userId, now, genId, ownerId, indexSk, score, comment }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
          UpdateExpression: 'REMOVE openReviewId',
          ConditionExpression: 'openReviewId = :genId',
          ExpressionAttributeValues: { ':genId': genId },
        },
      },
      {
        Put: {
          TableName: table,
          Item: {
            pk: `USER#${ownerId}`,
            sk: `REVIEW#${genId}#${userId}`,
            genId,
            reviewerId: userId,
            score,
            comment,
            reviewedAt: now.toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(sk)',
        },
      },
      {
        Update: {
          TableName: table,
          Key: { pk: 'PUBINDEX', sk: indexSk },
          UpdateExpression: 'ADD reviewCount :one, scoreSum :score',
          ConditionExpression: 'attribute_exists(sk)',
          ExpressionAttributeValues: { ':one': 1, ':score': score },
        },
      },
    ],
  };
}

// Hand-picked free window: every fifth or tenth analysis goes free to everyone
// for a while (Esa, 17.8.2026). Hand-picked now, randomised later.
function buildFeatureTransact({ table, userId, now, genId, indexSk, days = 14 }) {
  const until = new Date(now.getTime() + Math.max(1, Math.round(days)) * DAY_MS).toISOString();
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `PUB#${genId}` },
          UpdateExpression: 'SET freeUntil = :until',
          ConditionExpression: '#status = :published',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':until': until, ':published': 'published' },
        },
      },
      {
        Update: {
          TableName: table,
          Key: { pk: 'PUBINDEX', sk: indexSk },
          UpdateExpression: 'SET freeUntil = :until',
          ConditionExpression: 'attribute_exists(sk)',
          ExpressionAttributeValues: { ':until': until },
        },
      },
    ],
  };
}

// Admin takedown: the post-moderation half of auto-publish. Voids the bounty by
// construction — bounty.ledger() reads the status.
function buildTakedownTransact({ table, userId, now, genId, reason, indexSk }) {
  const items = [
    {
      Update: {
        TableName: table,
        Key: { pk: `USER#${userId}`, sk: `PUB#${genId}` },
        UpdateExpression: 'SET #status = :down, takenDownAt = :at, takedownReason = :reason',
        ConditionExpression: '#status = :published',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':down': 'takendown',
          ':published': 'published',
          ':at': now.toISOString(),
          ':reason': reason || '',
        },
      },
    },
  ];
  // A taken-down analysis must leave the company-page listing too. Publications
  // from before the index existed have no row, hence the conditional builder.
  if (indexSk) {
    items.push({
      Update: {
        TableName: table,
        Key: { pk: 'PUBINDEX', sk: indexSk },
        UpdateExpression: 'SET #status = :down',
        ConditionExpression: 'attribute_exists(sk)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':down': 'takendown' },
      },
    });
  }
  return { TransactItems: items };
}

// Company Coverage: the initial report is free once per subscription
// (coverageInitialGranted flag on PROFILE); after that each new report of the
// covered company consumes one of the 4 yearly updates.
function buildCoverageInitialTransact({ table, userId, now, reportId }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
          UpdateExpression: 'SET coverageInitialGranted = :true',
          ConditionExpression: 'attribute_not_exists(coverageInitialGranted)',
          ExpressionAttributeValues: { ':true': true },
        },
      },
      {
        Put: {
          TableName: table,
          Item: { pk: `USER#${userId}`, sk: `ENT#${reportId}`, source: 'coverage', grantedAt: now.toISOString() },
          ConditionExpression: 'attribute_not_exists(sk)',
        },
      },
    ],
  };
}

function buildCoverageUpdateTransact({ table, userId, now, reportId }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `USAGE#Y#${yearKey(now)}` },
          UpdateExpression: 'SET coverageUpdates = if_not_exists(coverageUpdates, :zero) + :one',
          ConditionExpression: 'attribute_not_exists(coverageUpdates) OR coverageUpdates < :max',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':max': COVERAGE_UPDATES_PER_YEAR },
        },
      },
      {
        Put: {
          TableName: table,
          Item: { pk: `USER#${userId}`, sk: `ENT#${reportId}`, source: 'coverage', grantedAt: now.toISOString() },
          ConditionExpression: 'attribute_not_exists(sk)',
        },
      },
    ],
  };
}

module.exports = {
  FREEMIUM_MIN_AGE_DAYS,
  COVERAGE_UPDATES_PER_YEAR,
  MAX_FREE_AFTER_DAYS,
  monthKey,
  yearKey,
  publicationIndexSk,
  clampFreeAfterDays,
  revisionPrompts,
  freemiumPickEligible,
  buildPickTransact,
  buildReserveGenerationTransact,
  buildReserveMemberGenerationTransact,
  buildSubmitTransact,
  buildTakedownTransact,
  buildGrantGenerationTransact,
  buildPaidGenerationTransact,
  buildFailPublicationTransact,
  buildReleaseReservationTransact,
  buildRoleChangeTransact,
  buildOpenAnalysisTransact,
  buildReviewTransact,
  buildFeatureTransact,
  buildCoverageInitialTransact,
  buildCoverageUpdateTransact,
};
