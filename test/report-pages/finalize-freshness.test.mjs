import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pages = ['index.html', 'reports.html', 'pricing.html', 'faq.html', 'methodology.html', 'about.html', 'analysts.html', 'analyst-story.html', 'analyst-terms.html', 'institutions.html', 'blog.html', 'disclaimer.html', 'members.html', 'comparisons.html'];

test('a sync commit stamps changed pages with its own date before push', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshness-commit-'));
  await fs.mkdir(path.join(dir, 'scripts'));
  for (const file of ['build-page-freshness.mjs', 'same-text.mjs', 'finalize-page-freshness.sh']) {
    await fs.copyFile(path.join(root, 'scripts', file), path.join(dir, 'scripts', file));
  }
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (message, date) => execFileSync('git', ['commit', '-qm', message], {
    cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  const build = (...args) => execFileSync(process.execPath, ['scripts/build-page-freshness.mjs', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Freshness Test');
  git('config', 'user.email', 'freshness@example.invalid');
  for (const page of pages) {
    await fs.writeFile(path.join(dir, page), `<!doctype html><html><head><title>${page}</title><link rel="canonical" href="https://example.invalid/${page}"></head><body>Original</body></html>\n`);
  }
  git('add', '.');
  commit('initial', '2026-11-01T12:00:00+00:00');
  build();
  const about = path.join(dir, 'about.html');
  await fs.writeFile(about, (await fs.readFile(about, 'utf8')).replace('2026-11-01', '2025-01-01'));
  git('add', '.');
  commit('generated metadata', '2026-11-01T12:00:00+00:00');

  const reports = path.join(dir, 'reports.html');
  await fs.writeFile(reports, (await fs.readFile(reports, 'utf8')).replace('Original', 'Updated report'));
  assert.match(await fs.readFile(reports, 'utf8'), /"dateModified": "2026-11-01"/);
  git('add', 'reports.html');
  commit('sync pages', '2026-11-13T23:59:59+00:00');
  const timestamp = git('show', '-s', '--format=%cI', 'HEAD');

  execFileSync('bash', ['scripts/finalize-page-freshness.sh'], { cwd: dir, stdio: 'pipe' });
  assert.match(await fs.readFile(reports, 'utf8'), /"dateModified": "2026-11-13"/);
  assert.match(await fs.readFile(about, 'utf8'), /"dateModified": "2026-11-13"/);
  assert.equal(git('show', '-s', '--format=%cI', 'HEAD'), timestamp);
  assert.equal(git('status', '--porcelain'), '');
  build('--check');

  await fs.appendFile(reports, '<!-- uncommitted user content -->\n');
  assert.throws(() => execFileSync('bash', ['scripts/finalize-page-freshness.sh'], { cwd: dir, stdio: 'pipe' }));
  assert.match(await fs.readFile(reports, 'utf8'), /uncommitted user content/);
});
