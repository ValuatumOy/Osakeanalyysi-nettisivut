// Auth for the members API: LinkedIn OIDC (analysts) + email magic link
// (subscribers), both minting the same HMAC bearer token (server/members/jwt.js).

const crypto = require('crypto');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const jwt = require('./jwt');
const store = require('./store');

const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

const membersApiUrl = () => (process.env.MEMBERS_API_URL || '').replace(/\/$/, '');
const redirectUri = () => `${membersApiUrl()}/auth/linkedin/callback`;

// Where the browser lands with the token. Token travels in the URL fragment —
// fragments never reach servers/logs. The same API serves the prod site, the
// staging site and local dev, so the caller says where it wants to come back
// to; anything not on the allowlist falls back to the default (open-redirect
// guard — never echo an arbitrary URL here).
function allowedFrontends() {
  const configured = (process.env.MEMBERS_FRONTEND_URLS || '')
    .split(',').map(url => url.trim()).filter(Boolean);
  return configured.length ? configured : ['http://localhost:3100/members.html'];
}

// A return URL is accepted whole when it is one of the configured pages, and on
// its origin otherwise — the 1,232 company report pages each sell the analyst
// analyses on them and cannot all be listed. Falling back to the first allowed
// page is what sent buyers to a page that could not hand over what they bought.
// Only our own origins are ever accepted, so this is not an open redirect.
function frontendUrl(requested) {
  const allowed = allowedFrontends();
  const raw = String(requested || '');
  if (allowed.includes(raw)) return raw;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return allowed[0];
    const origins = new Set(allowed.map((a) => new URL(a).origin));
    if (!origins.has(url.origin)) return allowed[0];
    // The caller often passes the page it is on, which may already carry the
    // parameters of an earlier round trip. Stacking more onto them breaks the
    // reader that parses them.
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (err) {
    return allowed[0];
  }
}

function jwtSecret() {
  const secret = process.env.MEMBERS_JWT_SECRET;
  if (!secret) throw new Error('MEMBERS_JWT_SECRET is not configured');
  return secret;
}

function mintToken(profile, now) {
  return jwt.sign({ uid: profile.userId, role: profile.role || '', tier: profile.tier || 'none' }, jwtSecret(), { now });
}

// ── LinkedIn OIDC ────────────────────────────────────────────────────────────

// Stateless CSRF state: <ts>~<returnTo>.<sig>, HMAC-signed, valid 10 min.
// The return URL rides along so the callback knows which site started the flow.
function makeState(returnTo, now = new Date()) {
  const payload = `${now.getTime()}~${returnTo}`;
  const sig = crypto.createHmac('sha256', jwtSecret()).update(`state:${payload}`).digest('base64url');
  return `${payload}.${sig}`;
}

// Returns the verified returnTo, or null when the state is bad/expired.
function readState(state, now = new Date()) {
  const raw = String(state || '');
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const expected = crypto.createHmac('sha256', jwtSecret()).update(`state:${payload}`).digest('base64url');
  const given = Buffer.from(raw.slice(dot + 1));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  const [ts, ...rest] = payload.split('~');
  if (now.getTime() - Number(ts) >= 10 * 60 * 1000) return null;
  return frontendUrl(rest.join('~'));
}

function linkedinStartUrl(returnTo, now = new Date()) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) throw new Error('LINKEDIN_CLIENT_ID is not configured');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri(),
    scope: 'openid profile email',
    state: makeState(frontendUrl(returnTo), now),
  });
  return `${LINKEDIN_AUTH_URL}?${params}`;
}

async function linkedinCallback(code, state, now = new Date()) {
  const returnTo = readState(state, now);
  if (!returnTo) return { error: 'Invalid state' };

  const tokenRes = await fetch(LINKEDIN_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.LINKEDIN_CLIENT_ID,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      redirect_uri: redirectUri(),
    }),
  });
  if (!tokenRes.ok) {
    console.error('linkedin token exchange failed:', tokenRes.status, await tokenRes.text());
    return { error: 'LinkedIn sign-in failed' };
  }
  const { access_token: accessToken } = await tokenRes.json();

  const userRes = await fetch(LINKEDIN_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) {
    console.error('linkedin userinfo failed:', userRes.status);
    return { error: 'LinkedIn sign-in failed' };
  }
  const info = await userRes.json(); // { sub, email, name, ... }
  if (!info.sub) return { error: 'LinkedIn sign-in failed' };

  const userId = await store.ensureUser(`LINKEDIN#${info.sub}`, {
    role: 'analyst',
    email: String(info.email || '').toLowerCase(),
    name: info.name || '',
    linkedinSub: info.sub,
  });
  const profile = await store.getProfile(userId);
  await store.audit(userId, 'login', { method: 'linkedin' });
  return { token: mintToken(profile, now), userId, returnTo };
}

// ── email magic link ─────────────────────────────────────────────────────────

let sesClient;
function ses() {
  if (!sesClient) sesClient = new SESv2Client({ region: process.env.AWS_REGION || 'eu-west-1' });
  return sesClient;
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function sendMagicLink(email, returnTo) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return; // caller always answers 200
  const token = crypto.randomBytes(32).toString('base64url');
  await store.putMagicToken(hashToken(token), normalized, { returnTo: frontendUrl(returnTo) });
  const link = `${membersApiUrl()}/auth/magic/verify?token=${token}`;
  await ses().send(new SendEmailCommand({
    FromEmailAddress: process.env.FROM_EMAIL || 'reports@valuatum.com',
    Destination: { ToAddresses: [normalized] },
    Content: {
      Simple: {
        Subject: { Data: 'Your AI Equity Reports sign-in link', Charset: 'UTF-8' },
        Body: {
          Html: {
            Data: `<p>Click to sign in (valid 15 minutes):</p><p><a href="${link}">Sign in to AI Equity Reports</a></p>`,
            Charset: 'UTF-8',
          },
        },
      },
    },
  }));
}

async function verifyMagicLink(token, now = new Date()) {
  const item = await store.consumeMagicToken(hashToken(String(token || '')));
  if (!item) return { error: 'Invalid or expired link' };
  const userId = await store.ensureUser(`EMAIL#${item.email}`, {
    role: 'subscriber',
    email: item.email,
  });
  const profile = await store.getProfile(userId);
  await store.audit(userId, 'login', { method: 'magic-link' });
  return { token: mintToken(profile, now), userId, returnTo: frontendUrl(item.returnTo) };
}

// ── request auth ─────────────────────────────────────────────────────────────

// Verifies the bearer token and loads the live PROFILE (tier/ban always
// current). Returns { profile } or { deny: <lambda response> }.
// Token expiry is always checked against the real clock — the x-test-now
// time-travel clock only moves quota periods, not session validity.
async function requireUser(event, { bearerToken, json }) {
  const claims = jwt.verify(bearerToken(event), process.env.MEMBERS_JWT_SECRET, { now: new Date() });
  if (!claims) return { deny: json(401, { error: 'Unauthorized' }) };
  const profile = await store.getProfile(claims.uid);
  if (!profile) return { deny: json(401, { error: 'Unauthorized' }) };
  if (profile.banned) return { deny: json(403, { error: 'Account is suspended' }) };
  return { profile };
}

module.exports = {
  linkedinStartUrl,
  linkedinCallback,
  sendMagicLink,
  verifyMagicLink,
  requireUser,
  mintToken,
  frontendUrl,
};
