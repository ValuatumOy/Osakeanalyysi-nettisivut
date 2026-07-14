import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

// reaper.js is CommonJS and reads its config at module load, so each case has to
// re-require it with a fresh env. createRequire gives us the cache to bust.
const require = createRequire(import.meta.url);
const REAPER_ID = require.resolve('../../server/reaper.js');

const NOW = new Date('2026-07-14T12:00:00Z');
const ENV_KEYS = ['REPORT_PDF_DIR', 'RESALE_ENABLED', 'RESALE_WINDOW_DAYS', 'REAPER_DRY_RUN'];

function loadReaper({ dir, dryRun = true, windowDays = 14, resaleEnabled = true }) {
  delete require.cache[REAPER_ID];
  process.env.REPORT_PDF_DIR = dir;
  process.env.RESALE_ENABLED = String(resaleEnabled);
  process.env.RESALE_WINDOW_DAYS = String(windowDays);
  process.env.REAPER_DRY_RUN = String(dryRun);
  return require(REAPER_ID);
}

function isolate(t) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[REAPER_ID];
  });
  return dir;
}

// A report the reconciler generated: carries provenance back to order + engine job.
function generated(name) {
  return {
    companyName: name,
    ticker: `${name.toUpperCase()}.HE`,
    hidden: false,
    forceVisible: true,
    excludeFromFree: true,
    price: 4.99,
    provenance: { sessionId: 'cs_test', jobId: 'job_test' },
  };
}

function write(dir, company, ageDays, sidecar) {
  const date = new Date(NOW.getTime() - (ageDays * 24 * 60 * 60 * 1000));
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const base = `${company}_${dd}${mm}${date.getUTCFullYear()}`;
  fs.writeFileSync(path.join(dir, `${base}.pdf`), 'PDFDATA');
  if (sidecar) {
    fs.writeFileSync(path.join(dir, `${base}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
  }
  return `${base}.pdf`;
}

// The standard catalog: one of each thing the reaper must distinguish.
function seed(dir) {
  return {
    expired: write(dir, 'Expired', 15, generated('Expired')),
    boundary: write(dir, 'Boundary', 14, generated('Boundary')),
    fresh: write(dir, 'Fresh', 1, generated('Fresh')),
    // Staff-curated free sample, 100 days old, no provenance -> must never be touched.
    curated: write(dir, 'Curated', 100, { companyName: 'Curated', ticker: 'CUR.HE', price: 0 }),
    // Staff-uploaded paid report, no sidecar at all -> must never be touched.
    orphan: write(dir, 'Orphan', 100, null),
  };
}

const exists = (dir, file) => fs.existsSync(path.join(dir, file));
const sidecarOf = file => file.replace(/\.pdf$/, '.json');

test('dry run reports the expired report but deletes nothing', (t) => {
  const dir = isolate(t);
  const files = seed(dir);

  const result = loadReaper({ dir, dryRun: true }).sweep(NOW);

  assert.equal(result.scanned, 5);
  assert.equal(result.eligible, 1, 'only the 15-day-old generated report is past the window');
  assert.equal(result.reaped, 0, 'dry run must not delete');
  for (const file of Object.values(files)) {
    assert.ok(exists(dir, file), `${file} must survive a dry run`);
  }
});

test('armed reaper deletes only the expired generated report', (t) => {
  const dir = isolate(t);
  const files = seed(dir);

  const result = loadReaper({ dir, dryRun: false }).sweep(NOW);

  assert.equal(result.reaped, 1);
  assert.ok(!exists(dir, files.expired), 'expired pdf is deleted');
  assert.ok(!exists(dir, sidecarOf(files.expired)), 'expired sidecar is deleted too');
  assert.ok(exists(dir, files.fresh), 'a fresh report is kept');
});

// The guardrail that protects real inventory. A staff report has no provenance,
// so no matter how old it gets it must never be deleted.
test('never deletes reports it did not generate, however old', (t) => {
  const dir = isolate(t);
  const files = seed(dir);

  loadReaper({ dir, dryRun: false }).sweep(NOW);

  assert.ok(exists(dir, files.curated), '100-day-old curated sample without provenance survives');
  assert.ok(exists(dir, sidecarOf(files.curated)), 'its sidecar survives');
  assert.ok(exists(dir, files.orphan), '100-day-old report with no sidecar survives');
});

test('window boundary: age must exceed the window, equal is kept', (t) => {
  const dir = isolate(t);
  const files = seed(dir);

  loadReaper({ dir, dryRun: false }).sweep(NOW);

  assert.ok(exists(dir, files.boundary), 'exactly 14 days old is still inside the window');
  assert.ok(!exists(dir, files.expired), '15 days old is outside it');
});

test('window is configurable', (t) => {
  const dir = isolate(t);
  const files = seed(dir);

  // At a 7-day window the 14-day report also falls out; the 1-day one does not.
  const result = loadReaper({ dir, dryRun: false, windowDays: 7 }).sweep(NOW);

  assert.equal(result.reaped, 2);
  assert.ok(!exists(dir, files.boundary), '14d is expired under a 7d window');
  assert.ok(exists(dir, files.fresh), '1d is still inside a 7d window');
});

test('start() is a no-op unless resale is enabled', (t) => {
  const dir = isolate(t);
  seed(dir);

  assert.equal(loadReaper({ dir, resaleEnabled: false }).start(), null);

  const timer = loadReaper({ dir, resaleEnabled: true, dryRun: true }).start();
  t.after(() => clearInterval(timer));
  assert.notEqual(timer, null, 'starts when enabled');
});

test('a missing pdf directory is survivable, not a crash', (t) => {
  const dir = isolate(t);
  const missing = path.join(dir, 'does-not-exist');

  const result = loadReaper({ dir: missing, dryRun: false }).sweep(NOW);

  assert.deepEqual(result, { scanned: 0, eligible: 0, reaped: 0 });
});

test('provenance predicate accepts either id, rejects everything else', (t) => {
  const dir = isolate(t);
  const { hasProvenance } = loadReaper({ dir });

  assert.ok(hasProvenance({ provenance: { jobId: 'j' } }));
  assert.ok(hasProvenance({ provenance: { sessionId: 's' } }));
  assert.ok(!hasProvenance({ provenance: {} }));
  assert.ok(!hasProvenance({}));
  assert.ok(!hasProvenance(null), 'a report with no sidecar at all is not ours');
});

test('report date is read from the filename, matching the catalog', (t) => {
  const dir = isolate(t);
  const { parseReportDateFromFileName } = loadReaper({ dir });

  assert.equal(parseReportDateFromFileName('Neste_14072026.pdf'), '2026-07-14');
  assert.equal(parseReportDateFromFileName('StoraEnso_06072026.pdf'), '2026-07-06');
  assert.equal(parseReportDateFromFileName('NoDateHere.pdf'), null);
});
