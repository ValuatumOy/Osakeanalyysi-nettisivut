// Pure builders for the members-table quota/entitlement writes. No AWS calls
// here — every function returns command params so tests can assert the exact
// ConditionExpressions. All quota periods are calendar-based (UTC).

const PICK_LIMITS = { free: 2, investor: 5, investor_plus: 15 };
const FREEMIUM_MIN_AGE_DAYS = 30;
const COVERAGE_UPDATES_PER_YEAR = 4;

function monthKey(now) {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

function yearKey(now) {
  return now.toISOString().slice(0, 4); // YYYY
}

function pickLimitForTier(tier) {
  return PICK_LIMITS[tier] ?? 0;
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
            'attribute_not_exists(openObligationId) AND (attribute_not_exists(banned) OR banned = :false) AND #role = :analyst',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':genId': genId, ':false': false, ':analyst': 'analyst' },
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

// Submit-to-publish releases the obligation (next month's generation unlocks).
function buildSubmitTransact({ table, userId, now, genId, promptsText }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
          UpdateExpression: 'REMOVE openObligationId',
          ConditionExpression: 'openObligationId = :genId',
          ExpressionAttributeValues: { ':genId': genId },
        },
      },
      {
        Update: {
          TableName: table,
          Key: { pk: `USER#${userId}`, sk: `PUB#${genId}` },
          UpdateExpression: 'SET #status = :submitted, submittedAt = :at, promptsText = :prompts',
          ConditionExpression: '#status = :generating',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':submitted': 'submitted',
            ':generating': 'generating',
            ':at': now.toISOString(),
            ':prompts': promptsText || '',
          },
        },
      },
    ],
  };
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
  PICK_LIMITS,
  FREEMIUM_MIN_AGE_DAYS,
  COVERAGE_UPDATES_PER_YEAR,
  monthKey,
  yearKey,
  pickLimitForTier,
  freemiumPickEligible,
  buildPickTransact,
  buildReserveGenerationTransact,
  buildSubmitTransact,
  buildCoverageInitialTransact,
  buildCoverageUpdateTransact,
};
