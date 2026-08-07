import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jwt = require('../../server/members/jwt.js');

const SECRET = 'test-secret';
const NOW = new Date('2026-08-06T12:00:00Z');

test('round-trip: sign then verify returns the claims', () => {
  const token = jwt.sign({ uid: 'u1', role: 'analyst', tier: 'none' }, SECRET, { now: NOW });
  const claims = jwt.verify(token, SECRET, { now: NOW });
  assert.equal(claims.uid, 'u1');
  assert.equal(claims.role, 'analyst');
});

test('expired token is rejected', () => {
  const token = jwt.sign({ uid: 'u1' }, SECRET, { now: NOW, ttlSeconds: 60 });
  const later = new Date(NOW.getTime() + 61 * 1000);
  assert.equal(jwt.verify(token, SECRET, { now: later }), null);
});

test('token valid just before expiry', () => {
  const token = jwt.sign({ uid: 'u1' }, SECRET, { now: NOW, ttlSeconds: 60 });
  const almost = new Date(NOW.getTime() + 59 * 1000);
  assert.ok(jwt.verify(token, SECRET, { now: almost }));
});

test('tampered payload is rejected', () => {
  const token = jwt.sign({ uid: 'u1', role: 'analyst' }, SECRET, { now: NOW });
  const [payload, sig] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)];
  const forged = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(payload, 'base64url').toString()), role: 'admin',
  })).toString('base64url');
  assert.equal(jwt.verify(`${forged}.${sig}`, SECRET, { now: NOW }), null);
});

test('wrong secret is rejected', () => {
  const token = jwt.sign({ uid: 'u1' }, SECRET, { now: NOW });
  assert.equal(jwt.verify(token, 'other-secret', { now: NOW }), null);
});

test('garbage input is rejected, not thrown', () => {
  for (const bad of [null, undefined, '', 'x', 'a.b.c', '..']) {
    assert.equal(jwt.verify(bad, SECRET, { now: NOW }), null);
  }
});
