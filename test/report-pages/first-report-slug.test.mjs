import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlug } from '../../scripts/report-pages/extract.mjs';

test('a company’s first report reuses its existing overview URL', () => {
  assert.equal(resolveSlug('remedy-28102026', 'Remedy Entertainment Plc', 'REMEDY.HE'), 'remedy-equity-report');
});

test('an unknown company still receives a deterministic report URL', () => {
  assert.equal(resolveSlug('example-28102026', 'Example Systems Plc', 'EXAMPLE.UNKNOWN'), 'example-systems-equity-report');
});
