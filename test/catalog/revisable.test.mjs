import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCatalog } = require('../../server/catalog.js');

const now = new Date('2026-07-17T12:00:00Z');

function catalogWith(sidecarsByFile) {
  const scannedFiles = Object.keys(sidecarsByFile).map(fileName => ({
    fileName, uploadedAt: now.toISOString(), size: 12345,
  }));
  return buildCatalog({
    now,
    scannedFiles,
    readSidecar: fileName => sidecarsByFile[fileName],
    manifest: { reports: [] },
    state: { week: null, freeIds: [], purchases: [] },
    persistState: false,
    includeNonPublic: true,
  });
}

test('a reconciler-delivered report with a jobId is revisable', () => {
  const { reports } = catalogWith({
    'Nokia_01072026.pdf': {
      companyName: 'Nokia', forceVisible: true,
      provenance: { sessionId: 'cs_1', jobId: 'job_123' },
    },
  });
  assert.equal(reports.find(r => r.fileName === 'Nokia_01072026.pdf').revisable, true);
});

test('a manually-uploaded report with no provenance is not revisable', () => {
  const { reports } = catalogWith({
    'Tesla_01072026.pdf': { companyName: 'Tesla', forceVisible: true },
  });
  assert.equal(reports.find(r => r.fileName === 'Tesla_01072026.pdf').revisable, false);
});

test('provenance without a jobId is not revisable', () => {
  const { reports } = catalogWith({
    'Nordea_01072026.pdf': {
      companyName: 'Nordea', forceVisible: true,
      provenance: { sessionId: 'cs_2' },
    },
  });
  assert.equal(reports.find(r => r.fileName === 'Nordea_01072026.pdf').revisable, false);
});

test('the raw jobId is never exposed on the report object', () => {
  const { reports } = catalogWith({
    'Nokia_01072026.pdf': {
      companyName: 'Nokia', forceVisible: true,
      provenance: { sessionId: 'cs_1', jobId: 'job_123' },
    },
  });
  const report = reports.find(r => r.fileName === 'Nokia_01072026.pdf');
  assert.equal(report.jobId, undefined);
  assert.equal(report.provenance, undefined);
});
