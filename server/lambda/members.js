// AiEquityReportsMembers Lambda — membership/subscription API (test stack).
// Deliberately separate from server/lambda/api.js: nothing here ships with the
// prod API. Routes: auth (LinkedIn OIDC + email magic link), quota-gated report
// opens (presigned GET), free-generation obligation loop, Stripe subscriptions,
// admin + test utilities. See docs/members-test.md.

const crypto = require('crypto');

const catalogAws = require('../aws/catalog-aws');
const ordersStore = require('../aws/orders-store');
const { searchCompanies } = require('../search');
const auth = require('../members/auth');
const bounty = require('../members/bounty');
const quota = require('../members/quota');
const ranking = require('../members/ranking');
const store = require('../members/store');
const tiers = require('../members/tiers');

const STAGE = process.env.STAGE || 'test';

// ── secrets (own map — the shared server/aws/secrets.js stays untouched) ─────

const { GetParametersCommand } = require('@aws-sdk/client-ssm');
const { ssm } = require('../aws/clients');

const SECRET_ENV_BY_NAME = {
  'linkedin-client-id': 'LINKEDIN_CLIENT_ID',
  'linkedin-client-secret': 'LINKEDIN_CLIENT_SECRET',
  'members-jwt-secret': 'MEMBERS_JWT_SECRET',
  'members-test-utils-secret': 'MEMBERS_TEST_UTILS_SECRET',
  'stripe-webhook-secret-members': 'MEMBERS_STRIPE_WEBHOOK_SECRET',
  'members-stripe-prices': 'MEMBERS_STRIPE_PRICES',
  'stripe-secret-key': 'STRIPE_SECRET_KEY',
  'admin-upload-password': 'ADMIN_UPLOAD_PASSWORD',
  'wisdom-api-token': 'WISDOM_API_TOKEN', // company lookup before a billable run
};

let secretsLoaded = null;
async function ensureSecrets() {
  const prefix = (process.env.SECRETS_SSM_PREFIX || '').replace(/\/$/, '');
  if (!prefix) return;
  if (secretsLoaded) return secretsLoaded;
  secretsLoaded = (async () => {
    const names = Object.keys(SECRET_ENV_BY_NAME).map(name => `${prefix}/${name}`);
    const res = await ssm().send(new GetParametersCommand({ Names: names, WithDecryption: true }));
    for (const parameter of res.Parameters || []) {
      const shortName = parameter.Name.slice(prefix.length + 1);
      const envName = SECRET_ENV_BY_NAME[shortName];
      if (envName && !process.env[envName]) process.env[envName] = parameter.Value;
    }
    if (res.InvalidParameters?.length) {
      console.warn('members secrets: missing SSM parameters', res.InvalidParameters);
    }
  })();
  return secretsLoaded;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function redirect(location) {
  return { statusCode: 302, headers: { location }, body: '' };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return null;
  }
}

function bearerToken(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function secretsMatch(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Test-time clock: `x-test-now` honored only with the test-utils secret AND
// never on prod. Everything downstream takes this `now` — no clock mutation.
function requestNow(event) {
  const header = event.headers?.['x-test-now'] || event.headers?.['X-Test-Now'];
  if (!header || STAGE === 'prod') return new Date();
  const secret = event.headers?.['x-test-secret'] || '';
  if (!secretsMatch(secret, process.env.MEMBERS_TEST_UTILS_SECRET)) return new Date();
  const parsed = new Date(header);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

const activeTier = (profile) =>
  ['active', 'past_due'].includes(profile.tierStatus) ? profile.tier : 'none';

// Monthly and annual plans have different allowances — see server/members/tiers.js.
const billingInterval = (profile) => (profile.billingInterval === 'year' ? 'year' : 'month');

// The three tunable numbers for this member: generations, basePicks,
// analystReads. Role and subscription are merged, larger wins.
const limitsFor = (profile) => tiers.limitsFor({
  role: profile.role,
  tier: activeTier(profile),
  interval: billingInterval(profile),
});

const FRESH_LIST_PRICE = 50;
const FRESH_MEMBER_PRICE = 40;

const freshReportPrice = (profile) =>
  activeTier(profile) !== 'none' ? FRESH_MEMBER_PRICE : FRESH_LIST_PRICE;

// Tickers are not free text: the catalog holds 'NOKIA.HE', a customer types
// 'NOKIA', and a Coverage subscription that matches nothing is a year of
// nothing. Resolve against the catalog and accept the unambiguous match.
function resolveTicker(catalog, input) {
  const wanted = String(input || '').trim().toUpperCase();
  if (!wanted) return null;
  const tickers = [...new Set(catalog.reports.map(r => String(r.ticker || '').toUpperCase()).filter(Boolean))];
  if (tickers.includes(wanted)) return wanted;
  // 'NOKIA' → 'NOKIA.HE', but only when exactly one listing matches.
  const prefixed = tickers.filter(t => t.split('.')[0] === wanted);
  return prefixed.length === 1 ? prefixed[0] : null;
}

// Wake the worker so a new order starts rendering now instead of waiting for
// the 5-minute sweep. Same push the API Lambda does for paid fresh orders.
async function invokeWorkerAsync() {
  const functionName = process.env.WORKER_FUNCTION_NAME;
  if (!functionName) return;
  const { InvokeCommand } = require('@aws-sdk/client-lambda');
  const { lambda } = require('../aws/clients');
  await lambda().send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'Event',
    Payload: JSON.stringify({ action: 'tick', reason: 'member-generation' }),
  }));
}

async function presignPdf(bucket, fileName) {
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { s3 } = require('../aws/clients');
  const prefix = process.env.REPORT_PDF_PREFIX || 'reports/pdfs/';
  const url = await getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${fileName}` }),
    { expiresIn: 300 },
  );
  return { url, expiresIn: 300 };
}

// A catalog report: production's bucket, in every stage (see infra/lib/config.ts).
const presignReport = report => presignPdf(process.env.REPORT_PDF_BUCKET, report.fileName);

// A report this stage generated for a member. It is delivered into this stage's
// own bucket and is deliberately not in the production catalog listing, so the
// order's own pdfFileName is the key — the DELIVERED status is the entitlement.
const presignGenerated = fileName =>
  presignPdf(process.env.GENERATED_PDF_BUCKET || process.env.REPORT_PDF_BUCKET, fileName);

// GET /reports — the member-facing catalog. Unlike the prod public payload
// this NEVER exposes pdfUrl: the presigned /open route is the only door.
async function getReportsList(event) {
  const now = requestNow(event);
  const { catalog } = await catalogAws.buildCatalogAws({ now });
  return json(200, {
    week: catalog.week,
    reports: catalog.reports.map(report => ({
      id: report.id,
      companyName: report.companyName,
      ticker: report.ticker,
      reportDate: report.reportDate,
      reportDateLabel: report.reportDateLabel,
      isFree: report.isFree,
      price: report.price,
      priceLabel: report.priceLabel,
    })),
  }, { 'cache-control': 'public, max-age=300' });
}

// ── auth routes ──────────────────────────────────────────────────────────────

// `returnTo` lets the prod site, the staging site and local dev share one API;
// auth.frontendUrl() rejects anything off the allowlist.
async function getLinkedinStart(event) {
  const returnTo = event.queryStringParameters?.returnTo;
  return redirect(auth.linkedinStartUrl(returnTo, requestNow(event)));
}

async function getLinkedinCallback(event) {
  const q = event.queryStringParameters || {};
  if (!q.code) return redirect(`${auth.frontendUrl()}#error=linkedin_denied`);
  const result = await auth.linkedinCallback(q.code, q.state, requestNow(event));
  if (result.error) return redirect(`${auth.frontendUrl()}#error=${encodeURIComponent(result.error)}`);
  return redirect(`${result.returnTo}#token=${result.token}`);
}

async function postMagicLink(event) {
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });
  try {
    await auth.sendMagicLink(body.email, body.returnTo);
  } catch (err) {
    console.error('magic-link send failed:', err.message); // still 200 — no enumeration
  }
  return json(200, { ok: true });
}

async function getMagicVerify(event) {
  const result = await auth.verifyMagicLink(event.queryStringParameters?.token, requestNow(event));
  if (result.error) return redirect(`${auth.frontendUrl()}#error=${encodeURIComponent(result.error)}`);
  return redirect(`${result.returnTo}#token=${result.token}`);
}

// ── member routes ────────────────────────────────────────────────────────────

async function getMe(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const monthKey = quota.monthKey(now);
  const [usage, yearUsage, entitlements] = await Promise.all([
    store.getUsage(profile.userId, monthKey),
    store.getUsage(profile.userId, `Y#${quota.yearKey(now)}`),
    store.listUserItems(profile.userId, 'ENT#'),
  ]);

  const limits = limitsFor(profile);

  return json(200, {
    userId: profile.userId,
    email: profile.email,
    role: profile.role,
    tier: profile.tier,
    tierStatus: profile.tierStatus,
    billingInterval: profile.billingInterval || null,
    coverageCompanyId: profile.coverageCompanyId || null,
    banned: Boolean(profile.banned),
    month: monthKey,
    freshReportPrice: freshReportPrice(profile),
    hasGeneration: limits.generations > 0,
    publishes: tiers.isPublishingRole(profile.role),
    limits,
    usage: {
      picks: usage?.picks || 0,
      pickLimit: limits.basePicks,
      analystReads: usage?.analystReads || 0,
      analystReadLimit: limits.analystReads,
      genReserved: Boolean(usage?.genReserved),
      genId: usage?.genId || null,
      coverageUpdates: yearUsage?.coverageUpdates || 0,
      coverageUpdateLimit: quota.COVERAGE_UPDATES_PER_YEAR,
    },
    openObligationId: profile.openObligationId || null,
    linkedinUrl: profile.linkedinUrl || null,
    openReviewId: profile.openReviewId || null,
    entitlements: entitlements.map(item => ({
      reportId: item.sk.slice(4),
      source: item.source,
      grantedAt: item.grantedAt,
    })),
  });
}

// POST /reports/{id}/open — the download gate. Age and quota checks are all
// server-side; the browser only ever sees a 5-minute presigned URL.
async function postReportOpen(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const reportId = event.pathParameters?.id || '';
  const existing = await store.getEntitlement(profile.userId, reportId);

  // A member's own generated report is hidden from the catalog, so it is only
  // reachable through the non-public view — and only by whoever holds the
  // entitlement. Everyone else sees the public catalog exactly as before.
  const { catalog } = await catalogAws.buildCatalogAws({ now, includeNonPublic: Boolean(existing) });
  const report = catalog.reports.find(item => item.id === reportId);
  if (!report) return json(404, { error: 'Report not found' });
  if (!existing && report.isFree) return json(200, await presignReport(report)); // weekly-rotation free reports gate nothing

  const sign = async (source) => {
    await store.audit(profile.userId, 'report-open', { reportId, source });
    return json(200, await presignReport(report));
  };

  // Existing entitlement: one-off purchases and reports the member generated
  // are permanent; subscription- and freemium-sourced access lapses with the
  // subscription/role.
  if (existing) {
    if (existing.source === 'oneoff' || existing.source === 'generation') return sign(existing.source);
    if (existing.source === 'free_pick') {
      return tiers.isLinkedinRole(profile.role) ? sign('free_pick')
        : json(402, { error: 'Freemium access is for LinkedIn members only' });
    }
    return activeTier(profile) !== 'none' ? sign(existing.source)
      : json(402, { error: 'Subscription is not active' });
  }

  const tier = activeTier(profile);
  const table = store.table();

  // Company Coverage: only the covered company; initial report free once,
  // then 4 updates per year.
  if (tier === 'coverage') {
    const covered = String(profile.coverageCompanyId || '').toUpperCase();
    if (String(report.ticker || '').toUpperCase() !== covered) {
      return json(403, { error: 'Company Coverage only includes your covered company' });
    }
    const initial = await store.runTransact(
      quota.buildCoverageInitialTransact({ table, userId: profile.userId, now, reportId }));
    if (initial) return sign('coverage');
    const update = await store.runTransact(
      quota.buildCoverageUpdateTransact({ table, userId: profile.userId, now, reportId }));
    if (update) return sign('coverage');
    if (await store.getEntitlement(profile.userId, reportId)) return sign('coverage'); // lost a benign race
    return json(429, { error: 'Yearly coverage updates used up' });
  }

  // Everyone else spends one of their monthly base picks. How many that is comes
  // from tiers.js — the numbers are demand-tuned, so they are data, not code.
  // Subscribers may pick any report; the free LinkedIn roles only the archive.
  const limits = limitsFor(profile);
  if (limits.basePicks > 0) {
    const paying = tier !== 'none';
    if (!paying && !quota.freemiumPickEligible(report)) {
      return json(403, { error: `Free picks must be older than ${quota.FREEMIUM_MIN_AGE_DAYS} days` });
    }
    const source = paying ? 'pick' : 'free_pick';
    const committed = await store.runTransact(quota.buildPickTransact({
      table, userId: profile.userId, now, limit: limits.basePicks, reportId, source,
    }));
    if (committed) return sign(source);
    if (await store.getEntitlement(profile.userId, reportId)) return sign(source);
    return json(429, { error: 'Monthly report picks used up' });
  }

  return json(402, { error: 'Subscription required' });
}

// A typo costs a full engine run, and on the paid path it would take money for
// a company we cannot generate. Resolve against the same source the site's
// fresh-report search uses and work from the canonical match.
async function resolveGenerationCompany(requestedTicker) {
  let results;
  try {
    results = await searchCompanies(requestedTicker);
  } catch (err) {
    console.error('generation company lookup failed:', err.message);
    return { error: json(503, { error: 'Company lookup is unavailable right now — please try again shortly' }) };
  }
  const match = results.find(item => item.ticker.toUpperCase() === requestedTicker)
    || results.find(item => item.ticker.toUpperCase().split('.')[0] === requestedTicker);
  if (!match) {
    return {
      error: json(400, {
        error: `We couldn't find "${requestedTicker}". Use the ticker as listed, e.g. NOKIA.HE or AMD.`,
      }),
    };
  }
  return { match };
}

// POST /generations/free — reserve the analyst's monthly free generation.
// The real engine run is wired later; the reservation + obligation is the point.
// Analysts get a free generation against a publish obligation; Investor Plus
// members get a private one as part of the subscription. Same monthly slot,
// and both run through the real order pipeline (orders table → worker →
// reconciler → engine), so a reservation spends real engine time.
async function postGenerationsFree(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  // Publishing roles carry the obligation; everyone else's generation is private.
  const isAnalyst = tiers.isPublishingRole(profile.role);
  if (limitsFor(profile).generations < 1) {
    return json(403, { error: 'Your plan does not include a monthly generation' });
  }

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });
  const company = String(body.company || '').trim();
  const requestedTicker = String(body.ticker || '').trim().toUpperCase();
  if (!company) return json(400, { error: 'company is required' });
  if (!requestedTicker) return json(400, { error: 'ticker is required' });
  if (!profile.email) return json(400, { error: 'Your account has no email address for delivery' });

  const resolved = await resolveGenerationCompany(requestedTicker);
  if (resolved.error) return resolved.error;
  const match = resolved.match;
  const ticker = match.ticker;

  // Reserve the quota slot first: a failed reservation must never start a
  // billable engine run.
  const genId = crypto.randomUUID();
  const build = isAnalyst ? quota.buildReserveGenerationTransact : quota.buildReserveMemberGenerationTransact;
  const committed = await store.runTransact(build({
    table: store.table(), userId: profile.userId, now, genId,
  }));
  if (!committed) {
    const fresh = await store.getProfile(profile.userId);
    if (isAnalyst && fresh?.openObligationId) {
      return json(409, {
        error: 'Previous generated report must be submitted for publication first',
        openObligationId: fresh.openObligationId,
      });
    }
    return json(429, { error: 'Monthly generation already used' });
  }

  // Membership reports are always written hidden: an analyst's goes public only
  // once it is submitted and an admin publishes it, and a Plus member's never
  // does.
  await ordersStore.create({
    id: genId,
    email: profile.email,
    companyName: match.companyName || company,
    ticker,
    exchange: String(body.exchange || '').trim(),
    industry: match.industry || '',
    visibility: 'private',
    // LinkedIn sign-in is the analyst path and always yields a name; a
    // magic-link member has none and their report stays engine-bylined. An
    // email address is never printed on a public cover.
    analystName: String(profile.name || '').slice(0, 120),
    // The revision loop on the order page is where the member steers the
    // report toward their own view; each round is a real engine run.
    revisionsAllowed: limitsFor(profile).revisions,
  });
  try {
    await invokeWorkerAsync();
  } catch (err) {
    console.warn('worker push failed (the 5-minute sweep will pick it up):', err.message);
  }

  await store.audit(profile.userId, 'generation-reserved', { genId, ticker, private: !isAnalyst });
  await voidReviewsOnCoverage(profile.userId, ticker, now);
  return json(200, { genId, status: 'NEW', company: match.companyName || company, ticker, private: !isAnalyst });
}

// A generation the engine could not deliver gives the month back. Only a run
// that never delivered: a failed REVISION drives an already-delivered order to
// FAILED, and that member is holding a finished report — they owe the
// publication and must not also get a new generation.
async function restoreIfFailed({ profile, genId, order, publication, now }) {
  if (!order || order.status !== ordersStore.STATUS.FAILED) return false;
  if (!publication || publication.status !== 'generating') return false;
  if (order.originalPdfFileName || order.deliveredEmailAt) return false;

  // Close the run out first: it is over regardless of who holds the month now.
  await store.runTransact(quota.buildFailPublicationTransact({
    table: store.table(), userId: profile.userId, genId, now,
  }));

  // A coverage update is not a monthly slot: it came off the year's four, and
  // there is no reservation row naming this run to check against, so the credit
  // is guarded by the PUB row having been 'generating' until a moment ago.
  if (publication.coverage) {
    const back = await store.runTransact(quota.buildReleaseCoverageTransact({
      table: store.table(), userId: profile.userId, now, reservedAt: publication.reservedAt,
    }));
    if (back) await store.audit(profile.userId, 'coverage-update-restored', { genId, reason: order.error || 'generation failed' });
    return back;
  }

  // Then hand the month back, but only while this run still holds it. An admin
  // who already credited the member by hand, or a newer generation, owns those
  // rows now and must not be overwritten.
  const released = await store.runTransact(quota.buildReleaseReservationTransact({
    table: store.table(),
    userId: profile.userId,
    genId,
    reservedAt: publication.reservedAt,
    now,
  }));
  if (released) {
    await store.audit(profile.userId, 'generation-restored', { genId, reason: order.error || 'generation failed' });
  }
  return released;
}

// POST /generations/coverage — the update a Company Coverage subscription sells.
//
// The subscription promised four report updates a year and nothing in the system
// ever produced one: the yearly counter only ever let a subscriber open a report
// somebody else had already generated. This is the other half — the subscriber
// asks, one of the four is spent, and a real engine run starts on their company.
//
// The company comes from the profile, never the request. It is what they paid to
// have covered, and taking it from the body would be a way to spend a coverage
// update on any company at all.
async function postGenerationCoverage(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  if (activeTier(profile) !== 'coverage') {
    return json(403, { error: 'Report updates are part of Company Coverage' });
  }
  const covered = String(profile.coverageCompanyId || '').toUpperCase();
  if (!covered) return json(409, { error: 'Your subscription has no covered company yet' });
  if (!profile.email) return json(400, { error: 'Your account has no email address for delivery' });

  const resolved = await resolveGenerationCompany(covered);
  if (resolved.error) return resolved.error;
  const match = resolved.match;

  // The quota first: a refused update must never start a billable engine run.
  const genId = crypto.randomUUID();
  const committed = await store.runTransact(quota.buildCoverageGenerationTransact({
    table: store.table(), userId: profile.userId, now, genId,
  }));
  if (!committed) {
    return json(429, {
      error: `All ${quota.COVERAGE_UPDATES_PER_YEAR} coverage updates for this year have been used`,
    });
  }

  await ordersStore.create({
    id: genId,
    email: profile.email,
    companyName: match.companyName || covered,
    ticker: match.ticker,
    exchange: match.exchange || '',
    industry: match.industry || '',
    // A coverage report is the subscriber's own copy, never resold.
    visibility: 'private',
    // An update is the report as the engine writes it. Steering one toward a
    // view is what the generation tiers are for.
    revisionsAllowed: 0,
  });
  try {
    await invokeWorkerAsync();
  } catch (err) {
    console.warn('worker push failed (the 5-minute sweep will pick it up):', err.message);
  }

  await store.audit(profile.userId, 'coverage-update-requested', { genId, ticker: match.ticker });
  // A subscriber who also publishes now covers this company with a running report.
  await voidReviewsOnCoverage(profile.userId, match.ticker, now);
  return json(200, { genId, status: 'NEW', company: match.companyName || covered, ticker: match.ticker });
}

// POST /generations/fresh {sessionId} — turn a paid checkout into a running
// generation. The Stripe session is the receipt: it names the payer, the
// company and the fact that money changed hands, so nothing here trusts the
// caller for any of it. Idempotent by construction — the session id IS the
// order id, and both the order and the PUB row refuse to be created twice.
async function postGenerationFresh(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });
  const sessionId = String(body.sessionId || '').trim();
  if (!sessionId) return json(400, { error: 'sessionId is required' });

  let session;
  try {
    session = await stripe().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    return json(404, { error: 'Unknown purchase' });
  }
  if (session.payment_status !== 'paid') return json(402, { error: 'Payment not completed' });
  if (session.metadata?.isFresh !== 'true') return json(404, { error: 'Unknown purchase' });
  // Someone else's receipt buys them a report, not you one.
  if (session.metadata?.userId !== profile.userId) return json(403, { error: 'This purchase belongs to another member' });
  if (!profile.email) return json(400, { error: 'Your account has no email address for delivery' });

  const genId = session.id;
  const existing = await store.getPublication(profile.userId, genId);
  if (!existing) {
    await store.runTransact(quota.buildPaidGenerationTransact({
      table: store.table(), userId: profile.userId, now, genId,
    }));
  }

  const order = await ordersStore.create({
    id: genId,
    email: profile.email,
    companyName: session.metadata.company || '',
    ticker: session.metadata.ticker || '',
    exchange: session.metadata.exchange || '',
    visibility: 'private',
    revisionsAllowed: limitsFor(profile).revisions,
  });
  try {
    await invokeWorkerAsync();
  } catch (err) {
    console.warn('worker push failed (the 5-minute sweep will pick it up):', err.message);
  }

  if (!existing) {
    await store.audit(profile.userId, 'generation-purchased', {
      genId, ticker: session.metadata.ticker || '', amountTotal: session.amount_total, currency: session.currency,
    });
    await voidReviewsOnCoverage(profile.userId, order.ticker, now);
  }
  return json(200, {
    genId,
    status: order.status,
    company: order.companyName,
    ticker: order.ticker,
    alreadyCollected: Boolean(existing),
  });
}

// POST /generations/{genId}/revisions-checkout — buy more revision rounds on a
// report you already own.
//
// revisionsAllowed is fixed when an order is created, so an analyst or a buyer
// who runs out has no way forward but to start again. This tops it up; the
// webhook is what actually raises the number, so an abandoned return trip
// cannot lose rounds that were paid for.
const EXTRA_REVISION_EUR = Number(process.env.EXTRA_REVISION_EUR || '') || 5;

async function postGenerationRevisionsCheckout(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const genId = event.pathParameters?.genId || '';
  const publication = await store.getPublication(profile.userId, genId);
  if (!publication) return json(404, { error: 'Unknown generation' });
  // A published analysis is frozen — its PDF can no longer change, so more
  // rounds would buy nothing. Same rule as the revision endpoint itself.
  if (publication.status === 'published') {
    return json(409, { error: 'This report is published — its PDF can no longer change' });
  }

  const order = await ordersStore.get(genId);
  if (!order) return json(404, { error: 'Unknown generation' });

  const body = parseBody(event) || {};
  const rounds = Math.min(10, Math.max(1, Math.round(Number(body.rounds) || 1)));
  const returnTo = auth.frontendUrl(body.returnTo);

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    allow_promotion_codes: true,
    ...(profile.email ? { customer_email: profile.email } : {}),
    line_items: [{
      quantity: rounds,
      price_data: {
        currency: 'eur',
        unit_amount: Math.round(EXTRA_REVISION_EUR * 100),
        product_data: {
          name: `Extra revision round — ${order.companyName || order.ticker || 'report'}`,
          description: 'One more round of steering on a report you already have.',
        },
      },
    }],
    metadata: {
      extraRevisions: String(rounds),
      generationId: genId,
      userId: profile.userId,
    },
    success_url: `${returnTo}?revisions=added&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnTo}?revisions=cancelled`,
  });
  return json(200, { url: session.url, rounds, priceEur: rounds * EXTRA_REVISION_EUR });
}

// GET /reviews/mine — the reviews this member has written, newest first.
//
// A review used to be write-once and invisible afterwards, so a misclicked
// score was permanent and unfindable. This is how a reviewer finds one again.
async function getMyReviews(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const index = await store.listPublicationIndex({});
  const mine = [];
  for (const item of index) {
    if (!item.genId || !item.userId) continue;
    const rows = await store.listReviews(item.userId, item.genId);
    const own = rows.find((r) => r.reviewerId === profile.userId);
    if (!own) continue;
    mine.push({
      genId: item.genId,
      companyId: item.companyId,
      analyst: item.analystName || 'Analyst',
      score: own.score,
      comment: own.comment || '',
      reviewedAt: own.reviewedAt || null,
      edits: Array.isArray(own.history) ? own.history.length : 0,
      history: Array.isArray(own.history) ? own.history : [],
      // Withdrawn from the analysis's totals because the reviewer now covers the
      // company. Shown rather than hidden: the reviewer should see why it stopped
      // counting.
      voided: Boolean(own.voided),
    });
  }
  mine.sort((a, b) => String(b.reviewedAt || '').localeCompare(String(a.reviewedAt || '')));
  return json(200, { reviews: mine });
}

// POST /analyses/{genId}/review/edit — correct a review already written.
async function postAnalysisReviewEdit(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const genId = event.pathParameters?.genId || '';
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  const raw = Number(body.score);
  if (!Number.isFinite(raw) || raw < 1 || raw > 5) {
    return json(400, { error: 'score must be a number between 1 and 5, decimals allowed' });
  }
  const score = Math.round(raw * 10) / 10;
  const comment = String(body.comment || '').trim();
  if (comment.length < 40) {
    return json(400, { error: 'A written comparison of at least 40 characters is required' });
  }

  const index = await store.findPublicationIndex(genId);
  if (!index) return json(404, { error: 'Unknown analysis' });
  // Same rule as opening one, stated where the review is actually written: the
  // open path is what makes a review possible, so this is unreachable today,
  // and it stops a later change to that path from quietly allowing self-review.
  if (index.userId === profile.userId) {
    return json(403, { error: 'You cannot review your own analysis' });
  }

  // Started covering the company since writing the review: editing now would be
  // marking a rival down. The review already written stands as it is.
  if (await coversCompany(profile.userId, index.companyId)) {
    return json(403, {
      error: 'You cover this company yourself now, so this review can no longer be changed',
      covers: index.companyId,
    });
  }

  const rows = await store.listReviews(index.userId, genId);
  const own = rows.find((r) => r.reviewerId === profile.userId);
  if (!own) return json(404, { error: 'You have not reviewed this analysis' });
  // A voided review no longer contributes to the totals, so editing it would move
  // a number it is not part of. Unreachable while the coverage check above stands.
  if (own.voided) return json(403, { error: 'This review was withdrawn when you took up coverage of the company' });

  const committed = await store.runTransact(quota.buildReviewEditTransact({
    table: store.table(),
    ownerId: index.userId,
    reviewerId: profile.userId,
    now, genId, indexSk: index.sk,
    oldScore: Number(own.score),
    oldComment: own.comment || '',
    score,
    comment: comment.slice(0, 4000),
    history: Array.isArray(own.history) ? own.history : [],
  }));
  // The condition is on the old score, so a failure means someone else's edit
  // landed first and the caller is working from a stale number.
  if (!committed) return json(409, { error: 'That review changed while you were editing it — reload and try again' });

  await store.audit(profile.userId, 'analysis-review-edited', { genId, from: own.score, to: score });
  return json(200, { ok: true, genId, score, previousScore: Number(own.score) });
}

// POST /me/linkedin — the analyst's public profile link.
//
// LinkedIn's OIDC scope ("openid profile email") returns sub, name and email
// and no public profile URL — the vanity name needs partner access we do not
// have. So the analyst supplies it, which also means they choose whether to be
// linked at all.
const LINKEDIN_PROFILE_RE = /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[^\s/?#]+\/?$/i;

async function postMeLinkedin(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  const raw = String(body.linkedinUrl || '').trim();
  if (raw && !LINKEDIN_PROFILE_RE.test(raw)) {
    return json(400, { error: 'Give the address of your LinkedIn profile, e.g. https://www.linkedin.com/in/your-name' });
  }
  const url = raw.replace(/\/$/, '');

  await store.putProfileFields(profile.userId, { linkedinUrl: url || null });

  // Publications carry a copy so the public listing needs no per-analyst
  // lookup. Backfilling the analyst's own rows keeps the link from being
  // something only future publications get.
  const pubs = await store.listUserItems(profile.userId, 'PUB#');
  let updated = 0;
  for (const pub of pubs.filter((x) => x.status === 'published')) {
    const genId = String(pub.sk || '').replace(/^PUB#/, '');
    const index = await store.findPublicationIndex(genId);
    if (!index?.sk) continue;
    await store.putIndexFields(index.sk, { analystLinkedin: url || null });
    updated += 1;
  }

  await store.audit(profile.userId, 'linkedin-url-set', { present: Boolean(url), publications: updated });
  return json(200, { ok: true, linkedinUrl: url || null, publications: updated });
}

// POST /generations/{genId}/price — reprice a live analysis.
//
// The analyst sets the price at publication and, until now, was stuck with it.
// It matters more since forking: the price is what a derivative pays them, so
// guessing wrong once shouldn't be permanent.
async function postGenerationPrice(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const genId = event.pathParameters?.genId || '';
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  const publication = await store.getPublication(profile.userId, genId);
  if (!publication) return json(404, { error: 'Unknown analysis' });
  if (publication.status !== 'published') {
    return json(409, { error: 'Only a published analysis has a price to change', status: publication.status });
  }

  const index = await store.findPublicationIndex(genId);
  const committed = await store.runTransact(quota.buildRepriceTransact({
    table: store.table(),
    userId: profile.userId,
    genId,
    indexSk: index?.sk,
    priceEur: body.priceEur,
    freeAfterDays: body.freeAfterDays === undefined ? publication.freeAfterDays : body.freeAfterDays,
    publishedAt: publication.publishedAt,
  }));
  if (!committed) return json(409, { error: 'The price could not be changed right now' });

  await store.audit(profile.userId, 'analysis-repriced', {
    genId, priceEur: Number(body.priceEur) || 0,
  });
  return json(200, { ok: true, genId, priceEur: Math.max(0, Math.round(Number(body.priceEur) || 0)) });
}

// GET /generations/{genId} — order progress, and the entitlement handover once
// the reconciler has delivered the PDF.
async function getGeneration(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const genId = event.pathParameters?.genId || '';
  const publication = await store.getPublication(profile.userId, genId);
  if (!publication) return json(404, { error: 'Unknown generation' });

  const order = await ordersStore.get(genId);
  if (!order) return json(200, { genId, status: publication.status, publication: publication.status });

  const result = {
    genId,
    status: order.status,
    publication: publication.status,
    private: Boolean(publication.private),
    company: order.companyName,
    ticker: order.ticker,
    error: order.error || null,
  };

  if (order.status === 'DELIVERED' && order.pdfFileName) {
    // The member owns what they generated — no quota, no entitlement row.
    Object.assign(result, await presignGenerated(order.pdfFileName));
  }
  result.generationRestored = await restoreIfFailed({ profile, genId, order, publication, now });
  return json(200, result);
}

// The order page is the revision workspace, and it authenticates a paying
// buyer by their Stripe session id. A member generation has no session — it was
// never bought — so these two routes are the member's door into the same order:
// the member JWT proves who they are, and the PUB# row proves the generation is
// theirs. Payload shape matches GET /api/orders/{id} so the order page can read
// either without knowing which one it is talking to.
// Long enough that no one writing instructions by hand will meet it: 4,000
// characters was about 600 words, which a single detailed objection can use
// up. Not unbounded — comments accumulate in the order item across the
// revision chain, and DynamoDB refuses an item over 400 KB, so an
// unbounded field trades a clear error for a confusing write failure.
const REVISION_COMMENT_MAX = 40000;
const REVISION_CONTROL_CHARS = /[\x00-\x09\x0B-\x1F\x7F]/;

async function ownedOrder(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return { deny };

  const genId = event.pathParameters?.genId || '';
  const publication = await store.getPublication(profile.userId, genId);
  if (!publication) return { deny: json(404, { error: 'Unknown generation' }) };

  const order = await ordersStore.get(genId);
  if (!order) return { deny: json(404, { error: 'Order not found' }) };
  return { profile, genId, order, publication };
}

// GET /generations/{genId}/order — order-page state for a member's own run.
async function getGenerationOrder(event) {
  const { deny, order, publication } = await ownedOrder(event);
  if (deny) return deny;

  const payload = {
    status: order.status,
    origin: order.origin,
    companyName: order.companyName,
    ticker: order.ticker,
    reportId: order.reportId,
    revisionsAllowed: order.revisionsAllowed || 0,
    revisionsUsed: order.revisionsUsed || 0,
    revisionError: order.revisionError || null,
    error: order.status === ordersStore.STATUS.FAILED ? order.error : null,
    // Publishing freezes the PDF, so the order page must stop offering revisions.
    publication: publication.status,
  };

  // The order page reads `pdfUrl`; presignGenerated answers { url, expiresIn }.
  if (order.status === ordersStore.STATUS.DELIVERED && order.pdfFileName) {
    payload.pdfUrl = (await presignGenerated(order.pdfFileName)).url;
  }

  payload.revisionHistory = await Promise.all(
    (order.revisionHistory || []).slice().reverse().map(async (entry) => ({
      version: entry.version,
      comments: entry.comments || '',
      completedAt: entry.completedAt,
      changes: entry.changes || null,
      pdfUrl: entry.pdfFileName ? (await presignGenerated(entry.pdfFileName)).url : null,
    })),
  );
  if (payload.revisionHistory.length && order.originalPdfFileName) {
    payload.revisionHistory.push({
      version: 1,
      original: true,
      completedAt: order.deliveredEmailAt || null,
      pdfUrl: (await presignGenerated(order.originalPdfFileName)).url,
    });
  }

  return json(200, payload, { 'cache-control': 'no-store' });
}

// POST /generations/{genId}/revisions — steer a delivered generation.
async function postGenerationRevision(event) {
  const { deny, genId, order, profile, publication } = await ownedOrder(event);
  if (deny) return deny;

  // Published means frozen: buyers must not find the PDF changed under them.
  if (publication.status === 'published') {
    return json(409, { error: 'This report is published — its PDF can no longer change' });
  }

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });
  const comments = String(body.comments || '').trim();
  if (!comments) return json(400, { error: 'comments is required' });
  if (comments.length > REVISION_COMMENT_MAX) {
    return json(400, { error: `comments must be ${REVISION_COMMENT_MAX} characters or fewer` });
  }
  if (REVISION_CONTROL_CHARS.test(comments)) {
    return json(400, { error: 'comments contains invalid control characters' });
  }

  const claimed = await ordersStore.claimRevision(genId, comments);
  if (!claimed) {
    return json(409, {
      error: order.revisionsUsed >= order.revisionsAllowed
        ? 'You have used every revision on this generation'
        : 'This generation cannot take a revision right now',
      status: order.status,
    });
  }

  try {
    await invokeWorkerAsync();
  } catch (err) {
    console.warn('worker push failed (the 5-minute sweep will pick it up):', err.message);
  }

  await store.audit(profile.userId, 'generation-revised', { genId, version: (order.revisionsUsed || 0) + 2 });
  return json(200, { ok: true, status: claimed.status });
}

// GET /generations — every run this member has started, newest first. Without
// it the order page was reachable only from the delivery email.
async function listGenerations(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const pubs = await store.listUserItems(profile.userId, 'PUB#');
  const rows = await Promise.all(pubs.map(async (pub) => {
    const genId = String(pub.sk || '').replace(/^PUB#/, '');
    const order = await ordersStore.get(genId);
    // Seeing the list is enough to get a failed month back — the member does
    // not have to open the run that broke.
    const restored = await restoreIfFailed({ profile, genId, order, publication: pub, now });
    return {
      genId,
      publication: restored ? 'failed' : pub.status,
      companyId: pub.companyId || order?.ticker || '',
      companyName: order?.companyName || pub.companyName || '',
      startedAt: pub.reservedAt || pub.createdAt || order?.createdAt || null,
      publishedAt: pub.publishedAt || null,
      priceEur: Number(pub.priceEur) || 0,
      status: order?.status || pub.status,
      revisionsAllowed: order?.revisionsAllowed || 0,
      revisionsUsed: order?.revisionsUsed || 0,
      private: Boolean(pub.private),
    };
  }));
  rows.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return json(200, { generations: rows });
}

async function postGenerationSubmit(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const genId = event.pathParameters?.genId || '';
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  // The company comes from the order the reservation resolved, never from the
  // request: the bounty keys on it, so a client-supplied ticker would be a way
  // to farm one bounty per spelling of the same company.
  // DELIVERED is also what makes the report exist at all: without this an
  // analyst could reserve, publish an empty shell and start a bounty maturing.
  const order = await ordersStore.get(genId);
  if (!order?.ticker) return json(409, { error: 'No generated report to publish for this id' });
  if (order.status !== 'DELIVERED') {
    return json(409, { error: 'The report is still generating', status: order.status });
  }
  // A fork with no revision on it is somebody else's analysis with a new name on
  // the cover. The whole point of deriving is what you add, so at least one
  // revision has to have landed before it can be published.
  if (order.forkedFrom && !(order.revisionsUsed > 0)) {
    return json(409, {
      error: 'Revise this analysis at least once before publishing it — a fork with no revision is the analysis you derived it from',
    });
  }

  // The analyst prices their own analysis and decides how long until it falls
  // free (max a year, quota.clampFreeAfterDays). Both are recorded now; the
  // surface that sells an analysis is not built yet.
  const committed = await store.runTransact(quota.buildSubmitTransact({
    table: store.table(), userId: profile.userId, now, genId,
    // The comments the analyst sent the revision pipeline ARE the prompts;
    // the client's promptsText only fills in for an unrevised publication.
    promptsText: quota.revisionPrompts(order) || String(body.promptsText || ''),
    companyId: order.ticker,
    jobId: order.jobId || '',
    priceEur: body.priceEur,
    freeAfterDays: body.freeAfterDays,
    analystName: String(profile.name || profile.email || '').slice(0, 120),
    analystLinkedin: profile.linkedinUrl || null,
    // From the delivered order, never the request body — same rule as companyId above.
    recommendation: order.recommendation || null,
    targetPrice: order.targetPrice || null,
  }));
  if (!committed) return json(409, { error: 'Nothing to submit for this generation id' });
  // Published means frozen: a revision after this would change the PDF under
  // readers who already opened or bought it.
  await ordersStore.update(genId, { revisionsAllowed: order.revisionsUsed || 0 });
  await store.audit(profile.userId, 'generation-published', { genId, companyId: order.ticker });
  return json(200, {
    ok: true, genId, status: 'published',
    freeAfterDays: quota.clampFreeAfterDays(body.freeAfterDays),
  });
}

// PAYOUT# items → what bounty.ledger() needs. The amount comes from the item, not
// from the current env: a later fee change must not rewrite past payouts.
function paidFrom(payouts) {
  const paidAmounts = {};
  const paidGenIds = payouts.map((p) => {
    const genId = String(p.sk).replace(/^PAYOUT#/, '');
    if (p.amount !== undefined) paidAmounts[genId] = Number(p.amount);
    return genId;
  });
  return { paidGenIds, paidAmounts };
}

// GET /me/earnings — the analyst's bounty ledger, derived from their own items.
async function getMeEarnings(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;
  if (!tiers.isPublishingRole(profile.role)) return json(403, { error: 'Analysts only' });

  const [pubs, payouts, sales, reads] = await Promise.all([
    store.listUserItems(profile.userId, 'PUB#'),
    store.listUserItems(profile.userId, 'PAYOUT#'),
    store.listUserItems(profile.userId, 'SALE#'),
    store.listUserItems(profile.userId, 'SUBREAD#'),
  ]);
  const { paidGenIds, paidAmounts } = paidFrom(payouts);
  return json(200, bounty.ledger(pubs, { now, sales, reads, paidGenIds, paidAmounts }));
}

// ── billing ──────────────────────────────────────────────────────────────────

let stripeClient;
function stripe() {
  if (!stripeClient) {
    const Stripe = require('stripe');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// { investor: { month, year }, investor_plus: { month, year }, coverage: { year } }
function memberPrices() {
  try {
    return JSON.parse(process.env.MEMBERS_STRIPE_PRICES || '{}');
  } catch (_) {
    return {};
  }
}

async function postBillingCheckout(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });
  const plan = String(body.plan || '');
  const interval = plan === 'coverage' ? 'year' : (String(body.interval || 'month'));
  const priceId = memberPrices()[plan]?.[interval];
  if (!priceId) return json(400, { error: `Unknown plan/interval: ${plan}/${interval}` });

  // Coverage is a year of one company: refuse the sale rather than take money
  // for a ticker nothing in the catalog will ever match.
  let coverageCompanyId = '';
  if (plan === 'coverage') {
    const requested = String(body.coverageCompanyId || '').trim();
    if (!requested) return json(400, { error: 'coverageCompanyId is required for coverage' });
    const { catalog } = await catalogAws.buildCatalogAws({ now });
    coverageCompanyId = resolveTicker(catalog, requested);
    if (!coverageCompanyId) {
      return json(400, {
        error: `We don't cover "${requested}" yet — pick a company from the reports page or request coverage.`,
      });
    }
  }

  let customerId = profile.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe().customers.create({
      email: profile.email || undefined,
      metadata: { userId: profile.userId, stage: STAGE },
    });
    customerId = customer.id;
    await store.putIdentity(`STRIPECUST#${customerId}`, profile.userId);
    await store.updateProfile(profile.userId, { stripeCustomerId: customerId });
  }

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    allow_promotion_codes: true,
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: profile.userId,
    subscription_data: {
      metadata: { userId: profile.userId, plan, coverageCompanyId },
    },
    // Come back to whichever site started the checkout (prod / staging / dev);
    // frontendUrl falls back to this stage's own members page.
    success_url: `${auth.frontendUrl(body.returnTo)}#checkout=success`,
    cancel_url: `${auth.frontendUrl(body.returnTo)}#checkout=cancel`,
  });
  return json(200, { url: session.url });
}

// POST /billing/fresh-checkout — a fresh report at the member price. The
// discount is applied server-side from the live subscription status; the client
// never picks the price.
async function postFreshCheckout(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });
  const company = String(body.company || '').trim();
  if (!company) return json(400, { error: 'company is required' });
  const requestedTicker = String(body.ticker || '').trim().toUpperCase();
  if (!requestedTicker) return json(400, { error: 'ticker is required' });

  // Resolve before charging: money must never be taken for a company the
  // engine cannot be pointed at.
  const resolved = await resolveGenerationCompany(requestedTicker);
  if (resolved.error) return resolved.error;
  const match = resolved.match;

  const isMember = activeTier(profile) !== 'none';
  const priceId = memberPrices().fresh?.[isMember ? 'member' : 'list'];
  if (!priceId) return json(503, { error: 'Fresh report pricing is not configured' });

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    allow_promotion_codes: true,
    customer: profile.stripeCustomerId || undefined,
    customer_email: profile.stripeCustomerId ? undefined : (profile.email || undefined),
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: profile.userId,
    metadata: {
      isFresh: 'true',
      userId: profile.userId,
      company: match.companyName || company,
      ticker: match.ticker,
      exchange: String(body.exchange || ''),
      memberPrice: String(isMember),
    },
    // The session id is the receipt the member comes back with: POST
    // /generations/fresh turns it into the order. A payment-mode checkout is
    // not a subscription, so the webhook deliberately ignores it.
    success_url: `${auth.frontendUrl(body.returnTo)}#fresh={CHECKOUT_SESSION_ID}`,
    cancel_url: `${auth.frontendUrl(body.returnTo)}#fresh=cancel`,
  });
  await store.audit(profile.userId, 'fresh-checkout', { company, memberPrice: isMember });
  return json(200, { url: session.url, price: freshReportPrice(profile) });
}

const SUB_STATUS_MAP = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'canceled',
  incomplete: 'none',
  incomplete_expired: 'none',
};

async function applySubscription(userId, subscription) {
  const status = SUB_STATUS_MAP[subscription.status] || 'none';
  const plan = subscription.metadata?.plan || 'investor';
  // Annual plans carry a larger monthly allowance, so the interval is part of
  // the entitlement, not just billing trivia.
  const interval = subscription.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'year' : 'month';
  const patch = {
    tierStatus: status,
    tier: status === 'canceled' || status === 'none' ? 'none' : plan,
    billingInterval: interval,
    stripeSubscriptionId: subscription.id,
    currentPeriodEnd: subscription.current_period_end || 0,
  };
  if (plan === 'coverage' && subscription.metadata?.coverageCompanyId) {
    patch.coverageCompanyId = subscription.metadata.coverageCompanyId;
  }
  await store.updateProfile(userId, patch);
  await store.audit(userId, 'subscription-status', { status: subscription.status, plan });
}

async function userIdForCustomer(customerId) {
  return customerId ? store.getIdentity(`STRIPECUST#${customerId}`) : null;
}

// Writes the SALE# row the earnings ledger reads. Gross is what the reader paid,
// which is the price the analyst set; Stripe's cut comes off our half.
async function recordAnalysisSale(session) {
  const genId = session.metadata.analysisGenId;
  const ownerId = session.metadata.ownerId
    || (await store.findPublicationIndex(genId))?.userId;
  if (!ownerId) return;
  const wrote = await store.putSale(ownerId, `${genId}#${session.id}`, {
    genId,
    companyId: session.metadata.companyId || null,
    sessionId: session.id,
    // Refund events carry the payment intent, not the session, so a later
    // charge.refunded handler can find this row without a migration.
    paymentIntent: session.payment_intent || null,
    // A fork session also carries a derivation fee, which is ours and not the
    // author's, so it names the author's share explicitly. A plain purchase has
    // no such field and stays the whole session total.
    grossEur: Number(session.metadata.saleGrossEur)
      || Math.round(Number(session.amount_total || 0)) / 100,
    currency: session.currency || 'eur',
    soldAt: new Date((session.created || 0) * 1000 || Date.now()).toISOString(),
  });
  if (wrote) await store.audit(ownerId, 'analysis-sold', { genId, sessionId: session.id });
}

// The buyer's copy, sent the moment Stripe says it is paid. Nothing is generated
// for an analyst analysis — the PDF already exists — so waiting for the buyer to
// land back on the site was the only delivery, and a lost return trip meant a
// paid-for report nobody ever received (Lauri, 27.8.2026).
//
// The link is the receipt, not the document: the session id re-verifies against
// Stripe on every visit and the page presigns the PDF again, so this works for
// as long as the analysis stands rather than for the five minutes a presigned
// URL lasts.
async function sendAnalysisReceipt(session) {
  const to = session.customer_details?.email || session.customer_email || '';
  const genId = session.metadata?.analysisGenId || '';
  if (!to || !genId) return;
  const base = auth.frontendUrl('');
  const isFork = session.metadata?.fork === 'true';
  const link = `${base}?${isFork ? 'forked' : 'bought'}=${encodeURIComponent(genId)}&session_id=${encodeURIComponent(session.id)}`;
  const company = session.metadata?.companyId || 'the company';
  try {
    const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
    const ses = new SESv2Client({ region: process.env.AWS_REGION || 'eu-west-1' });
    await ses.send(new SendEmailCommand({
      FromEmailAddress: process.env.FROM_EMAIL || 'reports@valuatum.com',
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: `Your analyst analysis of ${company}`, Charset: 'UTF-8' },
          Body: {
            Html: {
              Data: `<p>Thank you — your purchase is complete.</p>`
                + `<p><a href="${link}">Open your analyst analysis of ${company}</a></p>`
                + `<p>This link stays valid: it re-checks your purchase and opens the PDF each time.</p>`,
              Charset: 'UTF-8',
            },
          },
        },
      },
    }));
  } catch (err) {
    // Stripe retries the whole event on a non-200, which would re-record the
    // sale; a mail that did not go out is not worth that.
    console.error('analysis receipt email failed:', err);
  }
}

async function postBillingWebhook(event) {
  const secret = process.env.MEMBERS_STRIPE_WEBHOOK_SECRET;
  if (!secret) return json(503, { error: 'Webhook secret not configured' });

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const signature = event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe().webhooks.constructEvent(raw, signature, secret);
  } catch (err) {
    console.error('members webhook signature verify failed:', err.message);
    return json(400, { error: 'Invalid signature' });
  }

  if (!await store.claimStripeEvent(stripeEvent.id)) return json(200, { ok: true, duplicate: true });

  const object = stripeEvent.data.object;
  switch (stripeEvent.type) {
    case 'checkout.session.completed': {
      // A sale of one analyst's analysis. The webhook, not the buyer's return
      // trip, is what records it: the analyst's half is owed whether or not the
      // buyer ever lands back on the site.
      if (object.metadata?.analysisGenId) {
        if (object.payment_status !== 'paid') break;
        await recordAnalysisSale(object);
        if (object.metadata.fork === 'true') await createForkOrder(object);
        await sendAnalysisReceipt(object);
        break;
      }
      if (object.metadata?.extraRevisions) {
        if (object.payment_status !== 'paid') break;
        await addRevisionRounds(object);
        break;
      }
      if (object.mode !== 'subscription') break;
      const userId = object.client_reference_id || await userIdForCustomer(object.customer);
      if (!userId) break;
      const subscription = await stripe().subscriptions.retrieve(object.subscription);
      await applySubscription(userId, subscription);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const userId = object.metadata?.userId || await userIdForCustomer(object.customer);
      if (!userId) break;
      await applySubscription(userId, stripeEvent.type.endsWith('deleted')
        ? { ...object, status: 'canceled' } : object);
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const userId = await userIdForCustomer(object.customer);
      if (!userId) break;
      if (stripeEvent.type === 'invoice.payment_failed') {
        await store.updateProfile(userId, { tierStatus: 'past_due' });
      } else if (object.subscription) {
        const subscription = await stripe().subscriptions.retrieve(object.subscription);
        await applySubscription(userId, subscription);
      }
      break;
    }
    default:
      break;
  }
  return json(200, { ok: true });
}

// ── analyst analyses: the layer on top of the engine report ─────────────────

// GET /analyses?companyId=NOKIA.HE — what sits above the engine's own report on
// a company page: every published analyst take, best first (server/members/
// ranking.js). Public metadata only; opening one is a separate, quota'd call.
async function getAnalyses(event) {
  const now = requestNow(event);
  const companyId = event.queryStringParameters?.companyId || '';
  const items = await store.listPublicationIndex({ companyId });
  return json(200, {
    companyId: companyId ? String(companyId).toUpperCase() : null,
    // What deriving adds on top of an analysis's own price. The buttons that
    // offer it are on 1,232 static pages, so the fee cannot be a constant
    // duplicated there — a reader must see the real total before Stripe does.
    forkFeeEur: FORK_FEE_EUR,
    analyses: ranking.orderAnalyses(items, now).map((item) => ({
      genId: item.genId,
      companyId: item.companyId,
      // The store filters by analyst, and two analysts can share a display name.
      analystId: item.userId,
      analyst: item.analystName || 'Analyst',
      analystLinkedin: item.analystLinkedin || null,
      publishedAt: item.publishedAt,
      priceEur: item.priceEur || 0,
      reviewCount: item.reviewCount || 0,
      peerScore: Math.round(item.peerScore * 100) / 100,
      // What reviewers gave. peerScore is the ranking number, pulled toward
      // the neutral prior, and is not what a reader should be shown.
      averageScore: ranking.averageScore(item) === null ? null : Math.round(ranking.averageScore(item) * 100) / 100,
      // `free` costs a member no read; `publicFree` is the administrator's
      // hand-picked window, the only one a logged-out visitor may open.
      free: ranking.isFreeNow(item, now),
      publicFree: ranking.isPublicFreeNow(item, now),
      // The analyst's own call, as the engine issued it for their job. Null for anything
      // published before the engine surfaced it, so consumers must handle null rather than
      // assume a rating exists.
      recommendation: item.recommendation || null,
      targetPrice: item.targetPrice || null,
    })),
  });
}

// An analyst who covers a company must not grade the rivals covering it: the
// cheapest way up the ranking would be to mark down everyone else on Tesla
// (Lauri, 27.8.2026). Buying their analysis stays open — reading is not the
// problem, scoring is.
async function coversCompany(userId, companyId) {
  const target = String(companyId || '').toUpperCase();
  if (!target) return false;
  const pubs = await store.listUserItems(userId, 'PUB#');
  for (const pub of pubs) {
    // A run the engine never delivered produced no coverage and no rival.
    if (pub.status === 'failed') continue;
    const own = String(pub.companyId || '').toUpperCase();
    if (own) {
      if (own === target) return true;
      continue;
    }
    // Still generating: the company lives on the order until publication.
    const order = await ordersStore.get(String(pub.sk || '').replace(/^PUB#/, ''));
    if (String(order?.ticker || '').toUpperCase() === target) return true;
  }
  return false;
}

// Taking up coverage of a company takes back every score this member gave the
// rivals covering it. coversCompany() stops the reverse order; this closes the
// one it cannot — lowball everyone on Tesla first, start your own Tesla report
// afterwards. Best-effort: it runs after the generation exists, so a failure
// here must not cost the member the run they just started.
async function voidReviewsOnCoverage(userId, companyId, now) {
  const target = String(companyId || '').toUpperCase();
  if (!target) return 0;
  let voided = 0;
  try {
    const rivals = await store.listPublicationIndex({ companyId: target });
    for (const index of rivals) {
      if (!index.genId || !index.userId || index.userId === userId) continue;
      const review = await store.getItem(`USER#${index.userId}`, `REVIEW#${index.genId}#${userId}`);
      if (!review || review.voided) continue;
      const committed = await store.runTransact(quota.buildVoidReviewTransact({
        table: store.table(), ownerId: index.userId, reviewerId: userId, now,
        genId: index.genId, indexSk: index.sk, score: Number(review.score) || 0,
      }));
      if (!committed) continue;
      voided += 1;
      await store.audit(userId, 'review-voided', { genId: index.genId, companyId: target, score: review.score });
    }
  } catch (err) {
    console.error('voidReviewsOnCoverage failed:', err);
  }
  return voided;
}

// GET /analyses/{genId}/free — no account, no allowance, no review owed. The
// only analyst analysis a logged-out visitor can open is one an administrator
// hand-picked into a free window (Esa, 19.8.2026). The analyst's own decay time
// deliberately does NOT open this door: it only stops costing members a read.
async function getAnalysisFree(event) {
  const now = requestNow(event);
  const genId = event.pathParameters?.genId || '';
  const index = await store.findPublicationIndex(genId);
  // Same 404 for missing and taken-down: a takedown should not be discoverable.
  if (!index || index.status !== 'published') return json(404, { error: 'Unknown analysis' });
  if (!ranking.isPublicFreeNow(index, now)) {
    return json(403, { error: 'This analysis is not in a free window' });
  }
  const document = await analysisDocument(genId);
  if (!document.url) return json(404, { error: 'No document for this analysis' });
  await store.audit(index.userId, 'analysis-opened-free', { genId });
  return json(200, {
    genId,
    analyst: index.analystName || 'Analyst',
    companyId: index.companyId,
    url: document.url,
    expiresIn: document.expiresIn,
  });
}

// POST /analyses/{genId}/open — spend one of the monthly analyst reads. The read
// leaves a review obligation behind: the next one stays locked until this
// analysis has been scored and commented (Esa, 17.8.2026).
async function postAnalysisOpen(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const genId = event.pathParameters?.genId || '';
  const index = await store.findPublicationIndex(genId);
  if (!index || index.status !== 'published') return json(404, { error: 'Unknown analysis' });
  if (index.userId === profile.userId) return json(400, { error: 'That is your own analysis' });

  // The revision prompts come with the document: a reviewer is asked to grade what
  // the analyst added on top of the engine, and the prompts are that addition.
  const deliver = async (extra) => {
    const pub = await store.getPublication(index.userId, genId);
    return json(200, {
      ok: true, genId, ownerId: index.userId, promptsText: pub?.promptsText || '',
      ...(await analysisDocument(genId)), ...extra,
    });
  };

  // Inside a hand-picked free window, or past the analyst's own decay time, the
  // analysis is free for everyone — no read spent, no review owed. Removing the
  // gate is the whole point of the free window.
  if (ranking.isFreeNow(index, now)) return deliver({ free: true });

  // Re-opening something already paid for comes first, so an analyst who opened
  // a rival and only afterwards started covering the company can still read what
  // they owe a review on.
  if (await store.getItem(`USER#${profile.userId}`, `READ#${genId}`)) {
    return deliver({ alreadyOpen: true });
  }
  if (await coversCompany(profile.userId, index.companyId)) {
    return json(403, {
      error: 'You cover this company yourself, so you cannot read and score a rival analysis on it — buy it instead',
      covers: index.companyId,
    });
  }

  const limit = limitsFor(profile).analystReads;
  if (limit < 1) return json(403, { error: 'Your plan does not include reading other analysts' });

  // A subscriber's read is the only one anybody paid us for, so it is the only
  // one that pays the analyst. An analyst or reader spending their own free
  // allowance passes rate 0 and writes no payable row.
  const readRateEur = activeTier(profile) === 'none' ? 0 : bounty.readRateEur();
  const committed = await store.runTransact(quota.buildOpenAnalysisTransact({
    table: store.table(), userId: profile.userId, now, limit, genId, ownerId: index.userId,
    readRateEur, companyId: index.companyId,
  }));
  if (!committed) {
    const fresh = await store.getProfile(profile.userId);
    if (fresh?.openReviewId && fresh.openReviewId !== genId) {
      return json(409, {
        error: 'Score and comment the analysis you opened last before opening another',
        openReviewId: fresh.openReviewId,
      });
    }
    // Already paid for: re-opening never charges twice.
    if (await store.getItem(`USER#${profile.userId}`, `READ#${genId}`)) {
      return deliver({ alreadyOpen: true });
    }
    return json(429, { error: 'Monthly analyst reads used up' });
  }
  await store.audit(profile.userId, 'analysis-opened', { genId, ownerId: index.userId });
  return deliver({});
}

// The published analysis itself: the engine PDF the generation delivered, behind
// a 5-minute presigned GET like every other download here. Seeded/test
// publications have no order behind them and simply come back without a url.
async function analysisDocument(genId) {
  const order = await ordersStore.get(genId);
  if (order?.status !== 'DELIVERED' || !order.pdfFileName) return { url: null, jobId: order?.jobId || null };
  return {
    ...(await presignGenerated(order.pdfFileName)),
    jobId: order.jobId || null,
    company: order.companyName,
  };
}

// POST /analyses/{genId}/buy-checkout — a reader with no account buying one
// analyst's analysis at the price that analyst set. Members spend a monthly read
// instead; this is the door for everyone else, so it takes no token. The Stripe
// checkout session id is the receipt, exactly as the ready-report flow on the
// main site works (api/report-download.js).
async function postAnalysisBuyCheckout(event) {
  const now = requestNow(event);
  const genId = event.pathParameters?.genId || '';
  const index = await store.findPublicationIndex(genId);
  if (!index || index.status !== 'published') return json(404, { error: 'Unknown analysis' });

  const price = Number(index.priceEur) || 0;
  if (price <= 0) return json(400, { error: 'This analysis is not for sale' });
  if (ranking.isPublicFreeNow(index, now)) {
    return json(400, { error: 'This analysis is free to read right now' });
  }
  // Never take money for a document that cannot be handed over afterwards.
  const document = await analysisDocument(genId);
  if (!document.url) return json(409, { error: 'This analysis has no document to deliver' });

  const body = parseBody(event) || {};
  const returnTo = auth.frontendUrl(body.returnTo);
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    allow_promotion_codes: true,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'eur',
        unit_amount: Math.round(price * 100),
        product_data: {
          name: `${index.companyId} — analyst analysis by ${index.analystName || 'Analyst'}`,
          description: 'One analyst\'s re-run of the Valuatum AI equity report, with the prompts used to steer it.',
        },
      },
    }],
    metadata: { analysisGenId: genId, ownerId: index.userId, companyId: index.companyId },
    success_url: `${returnTo}?bought=${genId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnTo}?bought=cancelled`,
  });
  return json(200, { url: session.url, priceEur: price });
}

// Extra revision rounds, applied from the webhook so they survive a buyer who
// never returns. claimStripeEvent already makes the webhook idempotent, which
// is what keeps a Stripe retry from granting the rounds twice.
async function addRevisionRounds(session) {
  const genId = session.metadata.generationId;
  const rounds = Math.round(Number(session.metadata.extraRevisions) || 0);
  if (!genId || rounds <= 0) return;

  const updated = await ordersStore.addRevisionsAllowed(genId, rounds);
  if (!updated) {
    console.error('extra revisions: no order to credit', { genId, rounds });
    return;
  }
  if (session.metadata.userId) {
    await store.audit(session.metadata.userId, 'revisions-purchased', {
      genId, rounds, revisionsAllowed: updated.revisionsAllowed,
    });
  }
}

// The paid fork itself, created from the webhook so it exists whether or not
// the buyer returns to the site. The order revises the parent's engine job —
// the engine's ownership key is one site-wide username, so branching another
// member's job needs no engine change — but it is a separate order with its own
// revision budget and, critically, no pdfFileName. The reconciler writes an
// existing key in place, so inheriting the parent's would make the first
// revision overwrite the published report under everyone reading it.
async function createForkOrder(session) {
  const parentGenId = session.metadata.analysisGenId;
  const genId = session.id;
  if (await ordersStore.get(genId)) return;

  const parent = await ordersStore.get(parentGenId);
  if (!parent?.jobId) {
    console.error('fork: parent has no job to build on', { parentGenId, genId });
    return;
  }

  const forkUserId = session.metadata.forkUserId || '';
  const profile = forkUserId ? await store.getProfile(forkUserId) : null;
  const publishes = Boolean(profile && tiers.isPublishingRole(profile.role));

  // An analyst's fork is publishable and owes a publication; anyone else's is
  // theirs alone. buildForkTransact refuses when another publication is already
  // owed, and then the fork stays private rather than being lost.
  let obligation = false;
  if (publishes) {
    obligation = await store.runTransact(quota.buildForkTransact({
      table: store.table(),
      userId: profile.userId,
      now: new Date((session.created || 0) * 1000 || Date.now()),
      genId,
      parentGenId,
      parentUserId: session.metadata.ownerId || null,
      companyId: session.metadata.companyId || parent.ticker || '',
    }));
  }

  await ordersStore.create({
    id: genId,
    email: profile?.email || session.customer_details?.email || session.customer_email || '',
    companyName: parent.companyName || '',
    ticker: parent.ticker || '',
    exchange: parent.exchange || '',
    status: ordersStore.STATUS.DELIVERED,
    jobId: parent.jobId,
    forkedFrom: parentGenId,
    analystName: profile?.name || undefined,
    ...(obligation ? {} : { visibility: 'private' }),
    revisionsAllowed: publishes
      ? limitsFor(profile).revisions
      : (Number.parseInt(process.env.REPORT_REVISIONS_INCLUDED || '', 10) || 3),
  });

  if (profile) {
    await store.audit(profile.userId, 'analysis-forked', {
      genId, parentGenId, publishable: obligation,
    });
    // A publishable fork is coverage of the parent's company — including of the
    // parent itself, which the forker may well have reviewed on the way in.
    if (obligation) await voidReviewsOnCoverage(profile.userId, parent.ticker, new Date());
  }
}

// POST /analyses/{genId}/fork-checkout — pay to build on a published analysis.
//
// One session, two things in it: the analysis at its own price, which reaches
// its author as an ordinary SALE row with the usual 50/50 and 14-day hold, and
// a derivation fee which is ours. Routing the author's half through the sale
// machinery means a later takedown of the parent claws these back like any
// other sale, with no separate accounting.
//
// Signed in as an analyst, the fork becomes a publishable generation carrying
// the publish obligation. Signed out, or as a reader, it is a private report
// that owes nothing — the same split the paid generation already makes.
const FORK_FEE_EUR = Number(process.env.FORK_FEE_EUR || '') || 10;

async function postAnalysisForkCheckout(event) {
  const now = requestNow(event);
  const genId = event.pathParameters?.genId || '';
  const index = await store.findPublicationIndex(genId);
  // Only a live publication can be derived from. A taken-down one is a 404
  // everywhere else, and a reopened one is mid-edit by its own author.
  if (!index || index.status !== 'published') return json(404, { error: 'Unknown analysis' });

  const parentOrder = await ordersStore.get(genId);
  if (!parentOrder?.jobId || parentOrder.status !== 'DELIVERED') {
    return json(409, { error: 'This analysis has no report to build on' });
  }

  const body = parseBody(event) || {};
  const returnTo = auth.frontendUrl(body.returnTo);
  const analysisPrice = Number(index.priceEur) || 0;

  // Signed in is optional here: a reader without an account can still buy a
  // fork, exactly as they can buy an analysis. requireUser denies rather than
  // throwing, so an anonymous caller just comes back without a profile.
  const { profile } = await auth.requireUser(event, { bearerToken, json, now });

  const lineItems = [{
    quantity: 1,
    price_data: {
      currency: 'eur',
      unit_amount: Math.round(FORK_FEE_EUR * 100),
      product_data: {
        name: `Build on ${index.companyId} — derivation`,
        description: 'Revision rounds on top of a published analyst analysis, delivered as your own report.',
      },
    },
  }];
  if (analysisPrice > 0 && !ranking.isPublicFreeNow(index, now)) {
    lineItems.unshift({
      quantity: 1,
      price_data: {
        currency: 'eur',
        unit_amount: Math.round(analysisPrice * 100),
        product_data: {
          name: `${index.companyId} — analyst analysis by ${index.analystName || 'Analyst'}`,
          description: 'The analysis you are building on. Half of this reaches its author.',
        },
      },
    });
  }

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    allow_promotion_codes: true,
    line_items: lineItems,
    ...(profile?.email ? { customer_email: profile.email } : {}),
    metadata: {
      analysisGenId: genId,
      ownerId: index.userId,
      companyId: index.companyId,
      fork: 'true',
      // Only the author's half of the session is their sale; the rest is the
      // derivation fee. recordAnalysisSale reads this.
      saleGrossEur: String(analysisPrice),
      forkUserId: profile?.userId || '',
    },
    success_url: `${returnTo}?forked=${genId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnTo}?forked=cancelled`,
  });
  return json(200, { url: session.url, priceEur: analysisPrice + FORK_FEE_EUR });
}

// GET /analyses/{genId}/purchased?session_id=… — the buyer's way in. The session
// id is long, unguessable and only ever handed to the person who paid, which is
// the same trust model the ready-report download already uses.
async function getAnalysisPurchased(event) {
  const genId = event.pathParameters?.genId || '';
  const sessionId = event.queryStringParameters?.session_id || '';
  if (!sessionId) return json(400, { error: 'session_id is required' });

  let session;
  try {
    session = await stripe().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    return json(404, { error: 'Unknown purchase' });
  }
  if (session.payment_status !== 'paid') return json(402, { error: 'Payment not completed' });
  if (session.metadata?.analysisGenId !== genId) return json(404, { error: 'Unknown purchase' });

  const index = await store.findPublicationIndex(genId);
  if (!index || index.status !== 'published') return json(404, { error: 'Unknown analysis' });
  const document = await analysisDocument(genId);
  if (!document.url) return json(404, { error: 'No document for this analysis' });

  // Normally the webhook has already recorded this sale; doing it here too costs
  // one conditional write and keeps the ledger right if the webhook is not
  // configured on this stage.
  await recordAnalysisSale(session);
  return json(200, {
    genId,
    analyst: index.analystName || 'Analyst',
    companyId: index.companyId,
    url: document.url,
    expiresIn: document.expiresIn,
  });
}

// POST /analyses/{genId}/review {score, comment} — the price of the read. The
// comment must compare: does this add value over the base report, or over the
// other takes on the same company? A score with no reasoning is noise.
async function postAnalysisReview(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const genId = event.pathParameters?.genId || '';
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });
  // Decimals are the point: an analysis is rarely a whole number better than
  // the one before it. Rounded to one place so the stored sum stays exact.
  const raw = Number(body.score);
  if (!Number.isFinite(raw) || raw < 1 || raw > 5) {
    return json(400, { error: 'score must be a number between 1 and 5, decimals allowed' });
  }
  const score = Math.round(raw * 10) / 10;
  const comment = String(body.comment || '').trim();
  if (comment.length < 40) {
    return json(400, { error: 'A written comparison of at least 40 characters is required' });
  }

  const index = await store.findPublicationIndex(genId);
  if (!index) return json(404, { error: 'Unknown analysis' });
  // Same rule as opening one, stated where the review is actually written: the
  // open path is what makes a review possible, so this is unreachable today,
  // and it stops a later change to that path from quietly allowing self-review.
  if (index.userId === profile.userId) {
    return json(403, { error: 'You cannot review your own analysis' });
  }

  const committed = await store.runTransact(quota.buildReviewTransact({
    table: store.table(), userId: profile.userId, now, genId,
    ownerId: index.userId, indexSk: index.sk, score, comment: comment.slice(0, 4000),
  }));
  if (!committed) return json(409, { error: 'No open review for that analysis' });
  await store.audit(profile.userId, 'analysis-reviewed', { genId, score });
  return json(200, { ok: true, genId, score });
}

// POST /me/role {role:'reader'} — an analyst who does not want the publish
// obligation steps down to a reader. Downward only, and never while a report is
// waiting to be published.
async function postMeRole(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;
  const body = parseBody(event);
  if (body?.role !== 'reader') return json(400, { error: 'Only role "reader" can be selected' });
  if (!tiers.isLinkedinRole(profile.role)) return json(403, { error: 'LinkedIn members only' });

  const committed = await store.runTransact(quota.buildRoleChangeTransact({
    table: store.table(), userId: profile.userId, role: 'reader',
  }));
  if (!committed) {
    return json(409, { error: 'Publish your generated report before changing role' });
  }
  await store.audit(profile.userId, 'role-changed', { role: 'reader', by: 'self' });
  return json(200, { ok: true, role: 'reader' });
}

// ── admin ────────────────────────────────────────────────────────────────────

// Post-moderation: publication is automatic, so this is how a bad analysis comes
// down. Also voids (or claws back) its bounty — bounty.ledger() reads the status.
async function postAdminReopen(event) {
  const body = parseBody(event);
  if (!body?.userId || !body?.genId) return json(400, { error: 'userId and genId are required' });
  const index = await store.findPublicationIndex(body.genId);
  const committed = await store.runTransact(quota.buildReopenTransact({
    table: store.table(), userId: body.userId, now: requestNow(event), genId: body.genId,
    indexSk: index?.sk,
  }));
  // Two conditions can fail: the publication is not taken down, or the analyst
  // already owes a different generation. Say which, because the second one is
  // fixed by publishing that other report rather than by retrying this.
  if (!committed) {
    const profile = await store.getProfile(body.userId);
    if (profile?.openObligationId && profile.openObligationId !== body.genId) {
      return json(409, {
        error: 'This analyst already has another generation open — it has to be published first',
        openObligationId: profile.openObligationId,
      });
    }
    return json(409, { error: 'No taken-down publication with that id' });
  }
  await store.audit(body.userId, 'publication-reopened', { genId: body.genId, note: String(body.note || '') });
  return json(200, { ok: true, status: 'generating', genId: body.genId });
}

async function postAdminTakedown(event) {
  const body = parseBody(event);
  if (!body?.userId || !body?.genId) return json(400, { error: 'userId and genId are required' });
  const index = await store.findPublicationIndex(body.genId);
  const committed = await store.runTransact(quota.buildTakedownTransact({
    table: store.table(), userId: body.userId, now: requestNow(event), genId: body.genId,
    reason: String(body.reason || ''), indexSk: index?.sk,
  }));
  if (!committed) return json(409, { error: 'No published publication with that id' });
  await store.audit(body.userId, 'publication-takendown', { genId: body.genId, reason: body.reason || '' });
  return json(200, { ok: true, status: 'takendown' });
}

// Records a manual payout. No payment rails on purpose — Stripe Connect means
// KYC and tax; the ledger is the deliverable, the transfer happens by hand.
async function postAdminPayout(event) {
  const now = requestNow(event);
  const body = parseBody(event);
  if (!body?.userId) return json(400, { error: 'userId is required' });

  const [pubs, payouts, sales, reads] = await Promise.all([
    store.listUserItems(body.userId, 'PUB#'),
    store.listUserItems(body.userId, 'PAYOUT#'),
    store.listUserItems(body.userId, 'SALE#'),
    store.listUserItems(body.userId, 'SUBREAD#'),
  ]);
  const { paidGenIds, paidAmounts } = paidFrom(payouts);
  // Fees and revenue shares settle through the same call and the same PAYOUT#
  // rows; a share's id carries its own SALE# prefix, so the two never collide.
  const payable = bounty.payableItems(pubs, { now, sales, reads, paidGenIds, paidAmounts });
  const requested = Array.isArray(body.ids) ? body.ids
    : (Array.isArray(body.genIds) ? body.genIds : payable.map((p) => p.id));
  const toPay = payable.filter((p) => requested.includes(p.id));
  if (!toPay.length) {
    return json(409, { error: 'Nothing payable', payable: payable.map((p) => p.id) });
  }

  for (const item of toPay) {
    await store.putPayout(body.userId, item.id, {
      amount: item.amount, kind: item.kind, paidAt: now.toISOString(), note: String(body.note || ''),
    });
  }
  const total = Math.round(toPay.reduce((acc, p) => acc + p.amount, 0) * 100) / 100;
  await store.audit(body.userId, 'bounty-paid', { ids: toPay.map((p) => p.id), total });
  return json(200, { ok: true, paid: toPay, total });
}

// GET /admin/members/earnings — who is owed what, in one call. An analyst
// invoices us for their "ready to invoice" balance, so the question this answers
// is the one an arriving invoice asks: is that number right, and what is behind
// it? Derived from the same ledger the analyst sees, so the two cannot disagree.
async function getAdminEarnings(event) {
  const now = requestNow(event);
  const index = await store.listPublicationIndex({});
  const userIds = [...new Set(index.map((item) => item.userId).filter(Boolean))];
  const nameOf = new Map();
  for (const item of index) {
    if (item.userId && item.analystName && !nameOf.has(item.userId)) {
      nameOf.set(item.userId, item.analystName);
    }
  }

  const analysts = await Promise.all(userIds.map(async (userId) => {
    const [pubs, payouts, sales, reads] = await Promise.all([
      store.listUserItems(userId, 'PUB#'),
      store.listUserItems(userId, 'PAYOUT#'),
      store.listUserItems(userId, 'SALE#'),
      store.listUserItems(userId, 'SUBREAD#'),
    ]);
    const { paidGenIds, paidAmounts } = paidFrom(payouts);
    const led = bounty.ledger(pubs, { now, sales, reads, paidGenIds, paidAmounts });
    const profile = await store.getProfile(userId);
    return {
      userId,
      analyst: nameOf.get(userId) || profile?.name || profile?.email || null,
      email: profile?.email || null,
      published: led.entries.length,
      salesCount: led.totals.salesCount,
      grossSales: led.totals.grossSales,
      readsCount: led.totals.readsCount,
      readyToInvoice: Math.round((led.totals.shareEligible + led.totals.eligible + led.totals.readEligible) * 100) / 100,
      held: Math.round((led.totals.sharePending + led.totals.pending + led.totals.readPending) * 100) / 100,
      paid: Math.round((led.totals.sharePaid + led.totals.paid + led.totals.readPaid) * 100) / 100,
      clawback: Math.round((led.totals.shareClawback + led.totals.clawback + led.totals.readClawback) * 100) / 100,
      payable: bounty.payableItems(pubs, { now, sales, reads, paidGenIds, paidAmounts }),
    };
  }));

  const owed = analysts.filter((a) => a.readyToInvoice > 0 || a.held > 0 || a.salesCount > 0)
    .sort((a, b) => b.readyToInvoice - a.readyToInvoice);
  return json(200, {
    now: now.toISOString(),
    share: bounty.REVENUE_SHARE,
    totalReadyToInvoice: Math.round(owed.reduce((acc, a) => acc + a.readyToInvoice, 0) * 100) / 100,
    totalHeld: Math.round(owed.reduce((acc, a) => acc + a.held, 0) * 100) / 100,
    analysts: owed,
  });
}

// GET /admin/members/publications — what each analyst actually produced, newest
// first, with their prompts and the peer scores. Judging that is the gate for
// granting the next generation, so it has to be one call (Esa, 17.8.2026).
async function getAdminPublications(event) {
  const now = requestNow(event);
  const companyId = event.queryStringParameters?.companyId || '';
  const limit = Math.min(200, Math.max(1, Number(event.queryStringParameters?.limit) || 50));
  const items = await store.listPublicationIndex({ companyId });
  const recent = items
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .slice(0, limit);

  const publications = await Promise.all(recent.map(async (item) => {
    const pub = await store.getPublication(item.userId, item.genId);
    return {
      userId: item.userId,
      genId: item.genId,
      companyId: item.companyId,
      analyst: item.analystName || null,
      publishedAt: item.publishedAt,
      status: item.status,
      priceEur: item.priceEur || 0,
      freeFrom: item.freeFrom || null,
      freeUntil: item.freeUntil || null,
      reviewCount: item.reviewCount || 0,
      peerScore: Math.round(ranking.peerScore(item) * 100) / 100,
      averageScore: ranking.averageScore(item) === null ? null : Math.round(ranking.averageScore(item) * 100) / 100,
      jobId: pub?.jobId || null,
      promptsText: pub?.promptsText || '',
      takedownReason: pub?.takedownReason || null,
    };
  }));
  return json(200, { now: now.toISOString(), count: publications.length, publications });
}

// POST /admin/members/grant-generation {userId} — "the last one was good, go
// again". Clears the publish obligation and the month's used slot.
async function postAdminGrantGeneration(event) {
  const body = parseBody(event);
  if (!body?.userId) return json(400, { error: 'userId is required' });
  await store.runTransact(quota.buildGrantGenerationTransact({
    table: store.table(), userId: body.userId, now: requestNow(event),
  }));
  await store.audit(body.userId, 'generation-granted', { note: String(body.note || '') });
  return json(200, { ok: true, userId: body.userId });
}

// POST /admin/members/role {userId, role} — the funnel: analysts whose work adds
// nothing go back to being readers, the best move up to coaching.
async function postAdminRole(event) {
  const body = parseBody(event);
  if (!body?.userId) return json(400, { error: 'userId is required' });
  if (!tiers.ROLES.includes(body.role)) {
    return json(400, { error: `role must be one of ${tiers.ROLES.join(', ')}` });
  }
  await store.updateProfile(body.userId, { role: body.role });
  await store.audit(body.userId, 'role-changed', { role: body.role, by: 'admin' });
  return json(200, { ok: true, userId: body.userId, role: body.role });
}

// POST /admin/members/feature {userId, genId, days} — hand-pick an analysis to
// be free for everyone for a while. Randomisation comes later; picking the good
// ones by hand is how it starts.
async function postAdminFeature(event) {
  const body = parseBody(event);
  if (!body?.userId || !body?.genId) return json(400, { error: 'userId and genId are required' });
  const index = await store.findPublicationIndex(body.genId);
  if (!index) return json(404, { error: 'Unknown analysis' });
  const committed = await store.runTransact(quota.buildFeatureTransact({
    table: store.table(), userId: body.userId, now: requestNow(event), genId: body.genId,
    indexSk: index.sk, days: Number(body.days) || 14,
  }));
  if (!committed) return json(409, { error: 'No published analysis with that id' });
  await store.audit(body.userId, 'analysis-featured', { genId: body.genId, days: Number(body.days) || 14 });
  return json(200, { ok: true, genId: body.genId });
}

async function postAdminBan(event) {
  const body = parseBody(event);
  if (!body?.userId) return json(400, { error: 'userId is required' });
  const banned = body.banned !== false;
  await store.updateProfile(body.userId, { banned });
  await store.audit(body.userId, banned ? 'banned' : 'unbanned', {});
  return json(200, { ok: true, banned });
}

// ── test utilities (never on prod) ───────────────────────────────────────────

async function postTestUsers(event) {
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });
  const email = String(body.email || `test-${crypto.randomUUID()}@example.com`).toLowerCase();
  const userId = await store.ensureUser(`EMAIL#${email}`, {
    role: body.role || 'subscriber',
    email,
  });
  const patch = {};
  for (const key of ['role', 'tier', 'tierStatus', 'coverageCompanyId', 'name']) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (Object.keys(patch).length) await store.updateProfile(userId, patch);
  const profile = await store.getProfile(userId);
  return json(200, { userId, email, token: auth.mintToken(profile, requestNow(event)) });
}

async function postTestForcePublish(event) {
  const body = parseBody(event);
  if (!body?.userId || !body?.genId) return json(400, { error: 'userId and genId are required' });
  const committed = await store.runTransact(quota.buildSubmitTransact({
    table: store.table(), userId: body.userId, now: requestNow(event), genId: body.genId,
    promptsText: '[test force-publish]',
    companyId: body.companyId || 'TEST.HE',
    jobId: body.jobId || 'test-job',
  }));
  return json(200, { ok: true, committed });
}

// Seeds a published PUB item directly, with a backdatable publishedAt. The real
// route to one is a reservation, which spends a full engine run — the bounty
// rules (maturity, quarter, cap, takedown) need none of that to be exercised.
async function postTestPublication(event) {
  const body = parseBody(event);
  if (!body?.userId) return json(400, { error: 'userId is required' });
  const genId = body.genId || crypto.randomUUID();
  const publishedAt = body.publishedAt || requestNow(event).toISOString();
  const companyId = String(body.companyId || 'TEST.HE').toUpperCase();
  const seeded = await store.getProfile(body.userId);
  const analystName = body.analystName || seeded?.name || seeded?.email || '[test seed]';
  await store.putItem({
    pk: `USER#${body.userId}`,
    sk: `PUB#${genId}`,
    status: 'published',
    publishedAt,
    companyId,
    jobId: body.jobId || 'test-job',
    promptsText: body.promptsText || '[test seed]',
    ...(body.freeUntil ? { freeUntil: body.freeUntil } : {}),
  });
  // Same index row a real submit writes, so the analyses list and the review
  // loop can be exercised without spending an engine run.
  await store.putItem({
    pk: 'PUBINDEX',
    sk: quota.publicationIndexSk({ companyId, publishedAt, genId }),
    userId: body.userId,
    genId,
    companyId,
    analystName,
    jobId: body.jobId || 'test-job',
    publishedAt,
    status: 'published',
    priceEur: Number(body.priceEur) || 0,
    // A store demo needs a spread: a clear leader, an unreviewed one, a weak one.
    reviewCount: Number(body.reviewCount) || 0,
    scoreSum: Number(body.scoreSum) || 0,
    recommendation: body.recommendation || null,
    targetPrice: body.targetPrice || null,
    ...(body.freeUntil ? { freeUntil: body.freeUntil } : {}),
  });
  return json(200, { ok: true, genId });
}

// POST /test/sales {userId, genId, companyId, grossEur, soldAt} — a sale without
// Stripe. The webhook is the only thing that writes these in real life, and its
// signature cannot be forged from a test, so this is how the earnings chain is
// exercised end to end.
async function postTestSale(event) {
  const body = parseBody(event);
  if (!body?.userId || !body?.genId) return json(400, { error: 'userId and genId are required' });
  const soldAt = body.soldAt || requestNow(event).toISOString();
  const sessionId = body.sessionId || `cs_test_${crypto.randomUUID()}`;
  const wrote = await store.putSale(body.userId, `${body.genId}#${sessionId}`, {
    genId: body.genId,
    companyId: String(body.companyId || 'TEST.HE').toUpperCase(),
    sessionId,
    paymentIntent: body.paymentIntent || null,
    grossEur: Number(body.grossEur) || 0,
    currency: 'eur',
    soldAt,
  });
  return json(200, { ok: true, genId: body.genId, sessionId, wrote });
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const PUBLIC_ROUTES = {
  'GET /health': async () => json(200, { ok: true, stage: STAGE }),
  'GET /reports': getReportsList,
  'GET /analyses': getAnalyses,
  'GET /analyses/{genId}/free': getAnalysisFree,
  'POST /analyses/{genId}/buy-checkout': postAnalysisBuyCheckout,
  'POST /analyses/{genId}/fork-checkout': postAnalysisForkCheckout,
  'GET /analyses/{genId}/purchased': getAnalysisPurchased,
  'GET /auth/linkedin/start': getLinkedinStart,
  'GET /auth/linkedin/callback': getLinkedinCallback,
  'POST /auth/magic-link': postMagicLink,
  'GET /auth/magic/verify': getMagicVerify,
  'POST /billing/webhook': postBillingWebhook,
};

const AUTHED_ROUTES = {
  'GET /me': getMe,
  'GET /me/earnings': getMeEarnings,
  'POST /me/role': postMeRole,
  'POST /me/linkedin': postMeLinkedin,
  'POST /analyses/{genId}/open': postAnalysisOpen,
  'POST /analyses/{genId}/review': postAnalysisReview,
  'POST /analyses/{genId}/review/edit': postAnalysisReviewEdit,
  'GET /reviews/mine': getMyReviews,
  'POST /reports/{id}/open': postReportOpen,
  'POST /generations/free': postGenerationsFree,
  'POST /generations/fresh': postGenerationFresh,
  'POST /generations/coverage': postGenerationCoverage,
  'GET /generations': listGenerations,
  'GET /generations/{genId}': getGeneration,
  'GET /generations/{genId}/order': getGenerationOrder,
  'POST /generations/{genId}/revisions': postGenerationRevision,
  'POST /generations/{genId}/submit': postGenerationSubmit,
  'POST /generations/{genId}/price': postGenerationPrice,
  'POST /generations/{genId}/revisions-checkout': postGenerationRevisionsCheckout,
  'POST /billing/checkout': postBillingCheckout,
  'POST /billing/fresh-checkout': postFreshCheckout,
};

const ADMIN_ROUTES = {
  'GET /admin/members/publications': getAdminPublications,
  'GET /admin/members/earnings': getAdminEarnings,
  'POST /admin/members/grant-generation': postAdminGrantGeneration,
  'POST /admin/members/role': postAdminRole,
  'POST /admin/members/feature': postAdminFeature,
  'POST /admin/members/takedown': postAdminTakedown,
  'POST /admin/members/reopen': postAdminReopen,
  'POST /admin/members/payout': postAdminPayout,
  'POST /admin/members/ban': postAdminBan,
};

const TEST_ROUTES = {
  'POST /test/users': postTestUsers,
  'POST /test/force-publish': postTestForcePublish,
  'POST /test/publications': postTestPublication,
  'POST /test/sales': postTestSale,
};

function requireAdmin(event) {
  const expected = process.env.ADMIN_UPLOAD_PASSWORD;
  if (!expected) return json(503, { error: 'ADMIN_UPLOAD_PASSWORD is not configured' });
  if (!secretsMatch(bearerToken(event), expected)) return json(401, { error: 'Unauthorized' });
  return null;
}

function requireTestUtils(event) {
  if (STAGE === 'prod') return json(404, { error: 'Not found' }); // hard refusal, never on prod
  const expected = process.env.MEMBERS_TEST_UTILS_SECRET;
  if (!expected) return json(503, { error: 'MEMBERS_TEST_UTILS_SECRET is not configured' });
  if (!secretsMatch(bearerToken(event), expected)) return json(401, { error: 'Unauthorized' });
  return null;
}

exports.handler = async (event) => {
  await ensureSecrets();

  const routeKey = event.routeKey || `${event.requestContext?.http?.method} ${event.rawPath}`;
  try {
    if (PUBLIC_ROUTES[routeKey]) return await PUBLIC_ROUTES[routeKey](event);
    if (AUTHED_ROUTES[routeKey]) return await AUTHED_ROUTES[routeKey](event);
    if (ADMIN_ROUTES[routeKey]) {
      const denied = requireAdmin(event);
      if (denied) return denied;
      return await ADMIN_ROUTES[routeKey](event);
    }
    if (TEST_ROUTES[routeKey]) {
      const denied = requireTestUtils(event);
      if (denied) return denied;
      return await TEST_ROUTES[routeKey](event);
    }
    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error(`${routeKey}:`, err);
    return json(500, { error: 'Internal error' });
  }
};
