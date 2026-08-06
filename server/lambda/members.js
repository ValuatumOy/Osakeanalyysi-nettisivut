// AiEquityReportsMembers Lambda — membership/subscription API (test stack).
// Deliberately separate from server/lambda/api.js: nothing here ships with the
// prod API. Routes: auth (LinkedIn OIDC + email magic link), quota-gated report
// opens (presigned GET), free-generation obligation loop, Stripe subscriptions,
// admin + test utilities. See docs/members-test.md.

const crypto = require('crypto');

const catalogAws = require('../aws/catalog-aws');
const ordersStore = require('../aws/orders-store');
const auth = require('../members/auth');
const quota = require('../members/quota');
const store = require('../members/store');

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

// Monthly and annual plans have different allowances — see quota.PICK_LIMITS.
const billingInterval = (profile) => (profile.billingInterval === 'year' ? 'year' : 'month');

const FRESH_LIST_PRICE = 50;
const FRESH_MEMBER_PRICE = 40;

const freshReportPrice = (profile) =>
  activeTier(profile) !== 'none' ? FRESH_MEMBER_PRICE : FRESH_LIST_PRICE;

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

async function presignReport(report) {
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { s3 } = require('../aws/clients');
  const prefix = process.env.REPORT_PDF_PREFIX || 'reports/pdfs/';
  const url = await getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: process.env.REPORT_PDF_BUCKET, Key: `${prefix}${report.fileName}` }),
    { expiresIn: 300 },
  );
  return { url, expiresIn: 300 };
}

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

  const tier = activeTier(profile);
  const interval = billingInterval(profile);
  const pickLimit = tier !== 'none' ? quota.pickLimitForTier(tier, interval)
    : profile.role === 'analyst' ? quota.pickLimitForTier('free') : 0;

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
    hasGeneration: profile.role === 'analyst' || quota.hasMemberGeneration(tier),
    usage: {
      picks: usage?.picks || 0,
      pickLimit,
      genReserved: Boolean(usage?.genReserved),
      genId: usage?.genId || null,
      coverageUpdates: yearUsage?.coverageUpdates || 0,
      coverageUpdateLimit: quota.COVERAGE_UPDATES_PER_YEAR,
    },
    openObligationId: profile.openObligationId || null,
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
      return profile.role === 'analyst' ? sign('free_pick')
        : json(402, { error: 'Freemium access is for analysts only' });
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

  // Investor tiers: N self-picked reports per calendar month (annual plans
  // get more — see quota.PICK_LIMITS).
  if (tier === 'investor' || tier === 'investor_plus') {
    const committed = await store.runTransact(quota.buildPickTransact({
      table,
      userId: profile.userId,
      now,
      limit: quota.pickLimitForTier(tier, billingInterval(profile)),
      reportId,
      source: 'pick',
    }));
    if (committed) return sign('pick');
    if (await store.getEntitlement(profile.userId, reportId)) return sign('pick');
    return json(429, { error: 'Monthly report picks used up' });
  }

  // Freemium (analysts): 2 picks per month, only reports older than 30 days.
  if (profile.role === 'analyst') {
    if (!quota.freemiumPickEligible(report)) {
      return json(403, { error: `Freemium picks must be older than ${quota.FREEMIUM_MIN_AGE_DAYS} days` });
    }
    const committed = await store.runTransact(quota.buildPickTransact({
      table, userId: profile.userId, now, limit: quota.pickLimitForTier('free'), reportId, source: 'free_pick',
    }));
    if (committed) return sign('free_pick');
    if (await store.getEntitlement(profile.userId, reportId)) return sign('free_pick');
    return json(429, { error: 'Monthly free picks used up' });
  }

  return json(402, { error: 'Subscription required' });
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

  const isAnalyst = profile.role === 'analyst';
  const isMember = quota.hasMemberGeneration(activeTier(profile));
  if (!isAnalyst && !isMember) {
    return json(403, { error: 'Your plan does not include a monthly generation' });
  }

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });
  const company = String(body.company || '').trim();
  const ticker = String(body.ticker || '').trim().toUpperCase();
  if (!company) return json(400, { error: 'company is required' });
  if (!ticker) return json(400, { error: 'ticker is required' });
  if (!profile.email) return json(400, { error: 'Your account has no email address for delivery' });

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
    companyName: company,
    ticker,
    exchange: String(body.exchange || '').trim(),
    visibility: 'private',
  });
  try {
    await invokeWorkerAsync();
  } catch (err) {
    console.warn('worker push failed (the 5-minute sweep will pick it up):', err.message);
  }

  await store.audit(profile.userId, 'generation-reserved', { genId, company, ticker, private: !isAnalyst });
  return json(200, { genId, status: 'NEW', company, ticker, private: !isAnalyst });
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
    // The delivered report is hidden, so it needs the non-public catalog view.
    const { catalog } = await catalogAws.buildCatalogAws({ now, includeNonPublic: true });
    const report = catalog.reports.find(item => item.fileName === order.pdfFileName);
    if (report) {
      // Idempotent: the member owns what they generated, no quota involved.
      if (!await store.getEntitlement(profile.userId, report.id)) {
        await store.putEntitlement(profile.userId, report.id, 'generation', { genId });
      }
      result.reportId = report.id;
    }
  }
  return json(200, result);
}

async function postGenerationSubmit(event) {
  const now = requestNow(event);
  const { profile, deny } = await auth.requireUser(event, { bearerToken, json, now });
  if (deny) return deny;

  const genId = event.pathParameters?.genId || '';
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  const committed = await store.runTransact(quota.buildSubmitTransact({
    table: store.table(), userId: profile.userId, now, genId, promptsText: String(body.promptsText || ''),
  }));
  if (!committed) return json(409, { error: 'Nothing to submit for this generation id' });
  await store.audit(profile.userId, 'generation-submitted', { genId });
  return json(200, { ok: true, genId, status: 'submitted' });
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
  if (plan === 'coverage' && !String(body.coverageCompanyId || '').trim()) {
    return json(400, { error: 'coverageCompanyId is required for coverage' });
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
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: profile.userId,
    subscription_data: {
      metadata: {
        userId: profile.userId,
        plan,
        coverageCompanyId: String(body.coverageCompanyId || '').toUpperCase(),
      },
    },
    success_url: `${auth.frontendUrl()}#checkout=success`,
    cancel_url: `${auth.frontendUrl()}#checkout=cancel`,
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

  const isMember = activeTier(profile) !== 'none';
  const priceId = memberPrices().fresh?.[isMember ? 'member' : 'list'];
  if (!priceId) return json(503, { error: 'Fresh report pricing is not configured' });

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer: profile.stripeCustomerId || undefined,
    customer_email: profile.stripeCustomerId ? undefined : (profile.email || undefined),
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: profile.userId,
    metadata: {
      isFresh: 'true',
      userId: profile.userId,
      company,
      ticker: String(body.ticker || '').toUpperCase(),
      exchange: String(body.exchange || ''),
      memberPrice: String(isMember),
    },
    success_url: `${auth.frontendUrl(body.returnTo)}#fresh=ordered`,
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

// ── admin ────────────────────────────────────────────────────────────────────

async function postAdminRejectPublication(event) {
  const body = parseBody(event);
  if (!body?.userId || !body?.genId) return json(400, { error: 'userId and genId are required' });
  await store.updatePublicationStatus(body.userId, body.genId, 'rejected');
  await store.audit(body.userId, 'publication-rejected', { genId: body.genId });
  return json(200, { ok: true });
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
  for (const key of ['role', 'tier', 'tierStatus', 'coverageCompanyId']) {
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
  }));
  return json(200, { ok: true, committed });
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const PUBLIC_ROUTES = {
  'GET /health': async () => json(200, { ok: true, stage: STAGE }),
  'GET /reports': getReportsList,
  'GET /auth/linkedin/start': getLinkedinStart,
  'GET /auth/linkedin/callback': getLinkedinCallback,
  'POST /auth/magic-link': postMagicLink,
  'GET /auth/magic/verify': getMagicVerify,
  'POST /billing/webhook': postBillingWebhook,
};

const AUTHED_ROUTES = {
  'GET /me': getMe,
  'POST /reports/{id}/open': postReportOpen,
  'POST /generations/free': postGenerationsFree,
  'GET /generations/{genId}': getGeneration,
  'POST /generations/{genId}/submit': postGenerationSubmit,
  'POST /billing/checkout': postBillingCheckout,
  'POST /billing/fresh-checkout': postFreshCheckout,
};

const ADMIN_ROUTES = {
  'POST /admin/members/reject-publication': postAdminRejectPublication,
  'POST /admin/members/ban': postAdminBan,
};

const TEST_ROUTES = {
  'POST /test/users': postTestUsers,
  'POST /test/force-publish': postTestForcePublish,
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
