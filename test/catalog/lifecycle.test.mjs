import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { publicationStatus } = require('../../server/catalog.js');

const now = new Date('2026-07-17T12:00:00Z');
const availableAt = new Date('2026-07-16T12:00:00Z');

test('ready reports become publicly available', () => {
  assert.equal(publicationStatus({}, availableAt, now), 'ready');
});

test('explicit lifecycle states take precedence over ready date', () => {
  assert.equal(publicationStatus({ hidden: true }, availableAt, now), 'hidden');
  assert.equal(publicationStatus({ archived: true }, availableAt, now), 'archived');
  assert.equal(publicationStatus({ expired: true }, availableAt, now), 'expired');
});

test('expiresAt moves an otherwise ready report to expired', () => {
  assert.equal(publicationStatus({ expiresAt: '2026-07-17T11:00:00Z' }, availableAt, now), 'expired');
});
