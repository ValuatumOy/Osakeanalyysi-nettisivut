import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { jsonResponse, stubFetch } from './helpers.mjs';

const require = createRequire(import.meta.url);
const {
  interpretEstimateRequest,
  magnitudeNotes,
  interpreterConfigured,
  EstimateInterpretError,
  MAX_REQUEST_CHARS,
} = require('../../server/estimate-interpreter.js');

const ESTIMATES = {
  fid: 10377,
  currency: 'EUR',
  firstEstimateYear: 2025,
  historyYears: [2023, 2024],
  estimateYears: [2025, 2026, 2027],
  series: {
    ns: { 2023: 22926, 2024: 20635, 2025: 18487, 2026: 19586, 2027: 20761 },
    ebit: { 2023: 1682, 2024: 25, 2025: 1017, 2026: 524, 2027: 645 },
  },
};

const KEY = { OPENROUTER_API_KEY: 'sk-test' };

/** Wrap a proposal in the OpenRouter chat-completions envelope. */
function completion(content) {
  return jsonResponse(200, {
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  });
}

const GOOD = {
  edits: [{ varname: 'ns', year: 2027, value: 24913 }],
  summary: 'Grows 2027 net sales by 20% from 20761.',
  notes: ['Assumes the growth applies to net sales only.'],
};

test('parses a well-formed proposal', async (t) => {
  stubFetch(t, () => completion(GOOD), KEY);
  const proposal = await interpretEstimateRequest('Grow revenue 20% in 2027', ESTIMATES);

  assert.deepEqual(proposal.edits, GOOD.edits);
  assert.equal(proposal.summary, GOOD.summary);
  assert.deepEqual(proposal.notes, GOOD.notes);
});

test('sends only the forecast rows, years and currency — no company identity', async (t) => {
  const calls = stubFetch(t, () => completion(GOOD), KEY);
  await interpretEstimateRequest('Grow revenue 20% in 2027', ESTIMATES);

  const body = JSON.parse(calls[0].init.body);
  const prompt = body.messages[0].content;

  assert.match(prompt, /millions of EUR/);
  assert.match(prompt, /"varname":"ns","year":2027,"currentValue":20761/);
  assert.match(prompt, /<user_request>Grow revenue 20% in 2027<\/user_request>/);
  // History years are read-only context and are not offered to the model.
  assert.equal(prompt.includes('22926'), false);
  assert.equal(/Neste|NESTE|@/.test(prompt), false);

  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
});

test('honours the configured model and reasoning effort, and rejects an unknown effort', async (t) => {
  const calls = stubFetch(t, () => completion(GOOD), {
    ...KEY,
    ESTIMATE_INTERPRET_MODEL: 'some/model',
    ESTIMATE_INTERPRET_REASONING_EFFORT: 'nonsense',
  });
  await interpretEstimateRequest('anything', ESTIMATES);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'some/model');
  assert.deepEqual(body.reasoning, { effort: 'medium' });
});

test('accepts a proposal wrapped in a code fence', async (t) => {
  stubFetch(t, () => completion('```json\n' + JSON.stringify(GOOD) + '\n```'), KEY);
  const proposal = await interpretEstimateRequest('anything', ESTIMATES);
  assert.deepEqual(proposal.edits, GOOD.edits);
});

test('an empty edits list is a valid proposal', async (t) => {
  stubFetch(t, () => completion({ edits: [], summary: 'No forecast change requested.', notes: [] }), KEY);
  const proposal = await interpretEstimateRequest('make the report shorter', ESTIMATES);
  assert.deepEqual(proposal.edits, []);
  assert.equal(proposal.summary, 'No forecast change requested.');
});

test('a single note string is normalised to a list, and blanks are dropped', async (t) => {
  stubFetch(t, () => completion({ edits: [], summary: '', notes: '  just one  ' }), KEY);
  const first = await interpretEstimateRequest('anything', ESTIMATES);
  assert.deepEqual(first.notes, ['just one']);
});

test('missing summary and notes default to empty', async (t) => {
  stubFetch(t, () => completion({ edits: [] }), KEY);
  const proposal = await interpretEstimateRequest('anything', ESTIMATES);
  assert.equal(proposal.summary, '');
  assert.deepEqual(proposal.notes, []);
});

// ── malformed proposals are rejected, never repaired ─────────────────────────

const REJECTIONS = [
  ['unparseable text', 'not json at all', 'did not return a JSON proposal'],
  ['a JSON array', [1, 2, 3], 'did not return a proposal object'],
  ['a proposal with no edits list', { summary: 'ok' }, 'did not include an edits list'],
  ['a non-object edit', { edits: ['ns 2027'] }, 'invalid estimate edit'],
  ['an edit missing its value', { edits: [{ varname: 'ns', year: 2027 }] }, 'incomplete estimate edit'],
  ['a stringified value', { edits: [{ varname: 'ns', year: 2027, value: '24913' }] }, 'incomplete estimate edit'],
  ['a stringified year', { edits: [{ varname: 'ns', year: '2027', value: 24913 }] }, 'incomplete estimate edit'],
  [
    'the same cell twice',
    { edits: [{ varname: 'ns', year: 2027, value: 1 }, { varname: 'ns', year: 2027, value: 2 }] },
    'changes the same estimate twice',
  ],
];

for (const [label, payload, fragment] of REJECTIONS) {
  test(`rejects ${label}`, async (t) => {
    stubFetch(t, () => completion(payload), KEY);
    await assert.rejects(
      interpretEstimateRequest('anything', ESTIMATES),
      err => err instanceof EstimateInterpretError && err.message.includes(fragment),
    );
  });
}

test('rejects an empty completion', async (t) => {
  stubFetch(t, () => jsonResponse(200, { choices: [{ message: { content: '   ' } }] }), KEY);
  await assert.rejects(
    interpretEstimateRequest('anything', ESTIMATES),
    err => err instanceof EstimateInterpretError && err.message.includes('empty estimate proposal'),
  );
});

test('rejects an unreadable envelope', async (t) => {
  stubFetch(t, () => jsonResponse(200, 'not json'), KEY);
  await assert.rejects(
    interpretEstimateRequest('anything', ESTIMATES),
    err => err instanceof EstimateInterpretError && err.message.includes('unreadable response'),
  );
});

// ── transport ────────────────────────────────────────────────────────────────

test('an upstream failure reports the status without echoing the body', async (t) => {
  stubFetch(t, () => jsonResponse(429, { error: { message: 'rate limited' } }), KEY);
  await assert.rejects(
    interpretEstimateRequest('anything', ESTIMATES),
    err => err instanceof EstimateInterpretError
      && err.message.includes('(429)')
      && !err.message.includes('rate limited'),
  );
});

test('a timeout is a user-actionable error', async (t) => {
  stubFetch(t, () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }, KEY);
  await assert.rejects(
    interpretEstimateRequest('anything', ESTIMATES),
    err => err instanceof EstimateInterpretError && err.message.includes('timed out'),
  );
});

test('a transport failure is wrapped rather than thrown raw', async (t) => {
  stubFetch(t, () => { throw new Error('ECONNRESET'); }, KEY);
  await assert.rejects(
    interpretEstimateRequest('anything', ESTIMATES),
    err => err instanceof EstimateInterpretError && err.message.includes('ECONNRESET'),
  );
});

test('without an API key nothing is called', async (t) => {
  const calls = stubFetch(t, () => completion(GOOD));
  assert.equal(interpreterConfigured(), false);
  await assert.rejects(
    interpretEstimateRequest('anything', ESTIMATES),
    err => err instanceof EstimateInterpretError && err.message.includes('not configured'),
  );
  assert.equal(calls.length, 0);
});

// ── magnitude warnings ───────────────────────────────────────────────────────

test('warns on a tenfold-plus jump — the millions/thousands mix-up', async () => {
  // 20761 million read as thousands and "corrected" to 20,761,000.
  const notes = magnitudeNotes(ESTIMATES, [{ varname: 'ns', year: 2027, value: 20761000 }]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Net sales 2027 differs from the current estimate by more than tenfold/);
});

test('warns on a tenfold collapse too', async () => {
  const notes = magnitudeNotes(ESTIMATES, [{ varname: 'ebit', year: 2026, value: 20 }]);
  assert.match(notes[0], /^EBIT 2026 differs/);
});

test('stays quiet on plausible changes, including a swing to a loss', async () => {
  assert.deepEqual(magnitudeNotes(ESTIMATES, [
    { varname: 'ns', year: 2027, value: 24913 },
    { varname: 'ebit', year: 2027, value: -300 },
  ]), []);
});

test('flags a change away from zero, where no ratio exists', async () => {
  const zeroed = { ...ESTIMATES, series: { ...ESTIMATES.series, ebit: { ...ESTIMATES.series.ebit, 2026: 0 } } };
  const notes = magnitudeNotes(zeroed, [{ varname: 'ebit', year: 2026, value: 500 }]);
  assert.match(notes[0], /currently zero; please check the proposed scale/);

  // Leaving a zero at zero needs no warning.
  assert.deepEqual(magnitudeNotes(zeroed, [{ varname: 'ebit', year: 2026, value: 0 }]), []);
});

test('says nothing about a year the model has no value for', async () => {
  const missing = { ...ESTIMATES, series: { ...ESTIMATES.series, ns: { ...ESTIMATES.series.ns, 2027: null } } };
  assert.deepEqual(magnitudeNotes(missing, [{ varname: 'ns', year: 2027, value: 999999 }]), []);
});

test('repeats the same warning only once', async () => {
  const notes = magnitudeNotes(ESTIMATES, [
    { varname: 'ns', year: 2027, value: 20761000 },
    { varname: 'ns', year: 2027, value: 20761000 },
  ]);
  assert.equal(notes.length, 1);
});

test('the customer-facing request cap is 10,000 characters', async () => {
  assert.equal(MAX_REQUEST_CHARS, 10000);
});
