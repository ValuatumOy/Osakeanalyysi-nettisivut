import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getCompanyProfile } from '../../scripts/company-pages/profile-provider.mjs';

test('company profile is generated once and then read from cache', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-cache-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  let calls = 0;
  const provider = {
    name: 'test',
    model: 'test-model',
    async generate() {
      calls += 1;
      return 'Example designs and manufactures industrial equipment for business customers across Europe. Its main activities include production systems, maintenance services, spare parts, and software used to monitor installed machinery. The company serves manufacturing and infrastructure operators through direct sales and local service teams, generating revenue from both new equipment and recurring aftermarket support.';
    },
  };
  const company = { ticker: 'EXAMPLE', companyName: 'Example Oyj', background: null };

  const generated = await getCompanyProfile({ company, cacheDir, provider });
  const cached = await getCompanyProfile({ company, cacheDir, provider });

  assert.equal(generated.source, 'generated');
  assert.equal(cached.source, 'cache');
  assert.equal(calls, 1);
  const cacheEntry = JSON.parse(await fs.readFile(path.join(cacheDir, 'example.json'), 'utf8'));
  assert.equal(cacheEntry.provider, 'test');
  assert.equal(cacheEntry.model, 'test-model');
});

test('a profile that describes the source excerpt is rejected', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-cache-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const provider = {
    async generate() {
      return 'The provided excerpt describes the company and its products but does not give enough information to explain its business. It refers to customers and suppliers, together with several activities, but does not specify the main products or services. A company profile cannot be written from the excerpt without additional evidence.';
    },
  };
  await assert.rejects(
    getCompanyProfile({ company: { ticker: 'EX', companyName: 'Example' }, cacheDir, provider }),
    /refers to its source or generation process/,
  );
  await assert.rejects(fs.access(path.join(cacheDir, 'ex.json')), { code: 'ENOENT' });
});
