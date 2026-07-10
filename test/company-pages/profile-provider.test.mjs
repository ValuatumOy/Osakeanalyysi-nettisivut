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
