// Every parameter a checkout hands back must be read by something.
//
// A buyer paid for an analyst analysis and received nothing: the Lambda's
// success_url appended ?bought=&session_id=, and the page they landed on had no
// code that looked at either. Nothing failed loudly — the parameters simply sat
// in the address bar. This test is the cheap, browserless guard against that
// whole class: it reads every success_url and cancel_url the backends build,
// collects the parameter names in them, and insists each one is read somewhere
// in the pages we ship.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const BACKENDS = [
  'server/index.js',
  'server/lambda/members.js',
  'api/create-checkout.js',
  'api/create-fresh-checkout.js',
];

// Every page and script a buyer can land on. Anything under these roots counts
// as a reader — which page handles which parameter is not this test's business.
function frontendSources() {
  const out = [];
  const walk = (dir, depth) => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const rel = path.join(dir, name);
      const full = path.join(ROOT, rel);
      if (statSync(full).isDirectory()) {
        if (depth > 0) walk(rel, depth - 1);
      } else if (name.endsWith('.html') || name.endsWith('.js')) {
        out.push(readFileSync(full, 'utf8'));
      }
    }
  };
  walk('.', 0);
  for (const dir of ['js', 'order', 'checkout']) walk(dir, 0);
  return out;
}

// ?a=1&b=2 and #c=3 alike: the fragment is how the subscription flows come back.
function returnParams(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:success_url|cancel_url):\s*`([^`]+)`/g)) {
    const url = m[1];
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
    const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
    for (const part of [...query.split('&'), ...hash.split('&')]) {
      // A bare fragment is a scroll target on the page, not something to read.
      if (!part.includes('=')) continue;
      const name = part.split('=')[0].trim();
      // ${...} interpolations are values, not names, and an empty segment is
      // just a URL with no parameters at all.
      if (name && !name.includes('$') && !name.includes('{')) names.add(name);
    }
  }
  return names;
}

test('every checkout return parameter is read by a page we ship', () => {
  const pages = frontendSources();
  const isRead = (name) => pages.some((src) =>
    src.includes(`get('${name}')`) || src.includes(`get("${name}")`)
    || src.includes(`params.${name}`) || src.includes(`['${name}']`));

  // `type=fresh` rides along on the one-off report checkout for legibility in
  // the address bar; checkout/success.html branches on the API's answer instead,
  // so nothing reads it and nothing should.
  const DECORATIVE = new Set(['type']);

  const orphans = [];
  for (const file of BACKENDS) {
    for (const name of returnParams(readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (DECORATIVE.has(name)) continue;
      if (!isRead(name)) orphans.push(`${file} returns ?${name}= and nothing reads it`);
    }
  }
  assert.deepEqual(orphans, [], orphans.join('\n'));
});

test('the parameter names actually got extracted — a silent empty set would pass anything', () => {
  const found = returnParams(readFileSync(path.join(ROOT, 'server/lambda/members.js'), 'utf8'));
  for (const expected of ['bought', 'forked', 'session_id', 'revisions', 'checkout', 'fresh']) {
    assert.ok(found.has(expected), `${expected} was not extracted from the members Lambda`);
  }
});
