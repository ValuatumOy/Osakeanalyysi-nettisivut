// A company page showed the analyst's name, peer score and price, and not one
// word of why — the reasoning was entirely behind the paywall, so a published
// call read as an unsupported opinion. The first steering prompt is the reason
// to buy; the call and target price it produced are what is being bought, and
// are no longer shown for free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const quota = require('../../server/members/quota.js');

test('the opening paragraph only, and the round count as given', () => {
  const t = quota.promptTeaser('Flat 2027 capex.\n\nPush mobile margin to 2024.\n\nCut the terminal growth.', 3);
  assert.equal(t.text, 'Flat 2027 capex.');
  assert.equal(t.rounds, 3, 'effort is part of the pitch');
  assert.equal(t.truncated, true, 'there is more behind the paywall and the reader should know');
});

// revisionPrompts() joins rounds with a blank line and a single comment has
// blank lines of its own, so counting them from the stored text reported 188
// rounds on a two-round analysis. The count is passed in or it is not shown.
test('the round count is never guessed from the text', () => {
  const oneRoundManyParagraphs = 'Recalculate the valuation.\n\nKeep the structure.\n\nShow your work.';
  assert.equal(quota.promptTeaser(oneRoundManyParagraphs, 1).rounds, 1);
  assert.equal(quota.promptTeaser(oneRoundManyParagraphs).rounds, null);
  assert.equal(quota.promptTeaser(oneRoundManyParagraphs, 0).rounds, null);
});

test('a long first round is cut on a word boundary', () => {
  const long = 'a'.repeat(80) + ' ' + 'b'.repeat(80) + ' ' + 'c'.repeat(120);
  const t = quota.promptTeaser(long, 1);
  assert.ok(t.text.length <= quota.PROMPT_TEASER_CHARS + 1, t.text.length);
  assert.match(t.text, /…$/);
  assert.ok(!t.text.includes('ccc'), 'the cut must not land mid-word');
});

test('no prompts, no teaser — never an empty quote box', () => {
  assert.equal(quota.promptTeaser(''), null);
  assert.equal(quota.promptTeaser(null), null);
  assert.equal(quota.promptTeaser('   \n\n  '), null);
});

test('public unless the analyst said otherwise', () => {
  assert.equal(quota.promptsArePublic({}), true, 'absent means yes for everything published from here');
  assert.equal(quota.promptsArePublic({ promptsPublic: true }), true);
  assert.equal(quota.promptsArePublic({ promptsPublic: false }), false);
  assert.equal(quota.promptsArePublic(null), true);
});

test('the free listing sells the input and withholds the conclusion', () => {
  const src = readFileSync(new URL('../../server/lambda/members.js', import.meta.url), 'utf8');
  const listing = src.slice(src.indexOf('async function getAnalyses'), src.indexOf('async function getAnalysisFree'));
  assert.match(listing, /promptTeaser: teasers\.get\(item\.genId\)/);
  assert.doesNotMatch(listing, /recommendation: item\.recommendation/,
    'the call is what a reader pays for');
  assert.doesNotMatch(listing, /targetPrice: item\.targetPrice/);

  const page = readFileSync(new URL('../../js/analyst-reports.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /a\.recommendation/);
  assert.match(page, /esc\(t\.text\)/, 'analyst free text is escaped like any other');
});
