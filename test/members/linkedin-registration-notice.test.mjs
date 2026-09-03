// The admin gets one email the first time a LinkedIn profile signs in, and
// none on the return visits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.MEMBERS_JWT_SECRET = 'test-secret';
process.env.LINKEDIN_CLIENT_ID = 'test-client-id';
process.env.LINKEDIN_CLIENT_SECRET = 'test-client-secret';
process.env.MEMBERS_API_URL = 'https://members-test.aiequityreports.com';
process.env.MEMBERS_FRONTEND_URLS = 'https://test.aiequityreports.com/members.html';

const auth = require('../../server/members/auth.js');
const store = require('../../server/members/store.js');
const email = require('../../server/email.js');

const USERINFO = { sub: 'li-42', name: 'Anna Analyst', email: 'Anna@Example.com' };

function stubLinkedin() {
  global.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('accessToken')
      ? { access_token: 'token' }
      : USERINFO),
  });
}

// Returns the admin alerts sent by one callback against a store where the
// identity either already exists or does not.
async function signIn({ known }) {
  const alerts = [];
  const seeded = new Map(known ? [['LINKEDIN#li-42', 'user-1']] : []);
  const original = {
    getIdentity: store.getIdentity,
    ensureUser: store.ensureUser,
    getProfile: store.getProfile,
    audit: store.audit,
    sendAdminAlert: email.sendAdminAlert,
  };
  store.getIdentity = async (pk) => seeded.get(pk) || null;
  store.ensureUser = async (pk) => {
    if (!seeded.has(pk)) seeded.set(pk, 'user-1');
    return seeded.get(pk);
  };
  store.getProfile = async (userId) => ({ userId, role: 'analyst', tier: 'none' });
  store.audit = async () => {};
  email.sendAdminAlert = async (subject, lines) => { alerts.push({ subject, lines }); };
  stubLinkedin();
  try {
    const start = new URL(auth.linkedinStartUrl('https://test.aiequityreports.com/members.html'));
    const result = await auth.linkedinCallback('code', start.searchParams.get('state'));
    assert.ok(result.token, 'sign-in succeeded');
  } finally {
    Object.assign(store, {
      getIdentity: original.getIdentity,
      ensureUser: original.ensureUser,
      getProfile: original.getProfile,
      audit: original.audit,
    });
    email.sendAdminAlert = original.sendAdminAlert;
    delete global.fetch;
  }
  return alerts;
}

test('a first LinkedIn sign-in emails the admin', async () => {
  const alerts = await signIn({ known: false });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, /New LinkedIn registration: Anna Analyst/);
  assert.ok(alerts[0].lines.some(line => line.includes('Anna@Example.com')));
  assert.ok(alerts[0].lines.some(line => line.includes('li-42')));
});

test('a returning analyst does not email the admin again', async () => {
  assert.deepEqual(await signIn({ known: true }), []);
});
