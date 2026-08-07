// Minimal HMAC bearer token for the members API. base64url(payload).sig where
// sig = HMAC-SHA256 over the payload string. Claims: { uid, role, tier, exp }.
// Tier/ban are re-read from the PROFILE item on every consuming route, so a
// stale tier claim is harmless.

const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(claims, secret, { now = new Date(), ttlSeconds = 7 * 24 * 3600 } = {}) {
  if (!secret) throw new Error('MEMBERS_JWT_SECRET is not configured');
  const payload = b64url(JSON.stringify({
    ...claims,
    exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
  }));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verify(token, secret, { now = new Date() } = {}) {
  if (!secret || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!claims || typeof claims.exp !== 'number') return null;
  if (claims.exp <= Math.floor(now.getTime() / 1000)) return null;
  return claims;
}

module.exports = { sign, verify };
