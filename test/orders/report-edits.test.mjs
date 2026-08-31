import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateEditRequest, EditValidationError, MAX_EDIT_TEXT_CHARS, MAX_EDIT_TOTAL_CHARS } = require('../../server/report-edits.js');

const rejects = (body, pattern) => assert.throws(() => validateEditRequest(body), (err) => err instanceof EditValidationError && err.status === 400 && pattern.test(err.message));

test('accepts a pointer map, normalises newlines, and keeps a blank edit as a deletion', () => {
  const out = validateEditRequest({
    edits: { 'recommendation/prose/0': 'First line\r\nsecond', 'recommendation/prose/3': '   ', 'chrome:thesis/title': 'Our view' },
    originals: { 'recommendation/prose/0': 'Old text', 'not/edited': 'ignored' },
    editedBy: '  Maija   Analyst ',
  });
  assert.deepEqual(out.edits, { 'recommendation/prose/0': 'First line\nsecond', 'recommendation/prose/3': '', 'chrome:thesis/title': 'Our view' });
  assert.deepEqual(out.originals, { 'recommendation/prose/0': 'Old text' }); // originals for untouched fields are dropped
  assert.equal(out.editedBy, 'Maija Analyst');
});

test('rejects what the engine would reject: bad pointers, non-strings, control characters, nothing at all', () => {
  rejects({ edits: {} }, /empty/);
  rejects({ edits: [] }, /object/);
  rejects({ edits: { 'has space/0': 'x' } }, /invalid pointer/);
  rejects({ edits: { '../etc': 'x' } }, /invalid pointer/);
  rejects({ edits: { 'a/b': 42 } }, /must be a string/);
  rejects({ edits: { 'a/b': 'bell\x07' } }, /control characters/);
  rejects({ edits: { 'a/b': 'x' }, editedBy: ['no'] }, /editedBy/);
});

test('caps a single field and the whole request, so one save cannot fill the order row', () => {
  rejects({ edits: { 'a/b': 'x'.repeat(MAX_EDIT_TEXT_CHARS + 1) } }, /exceeds/);
  const many = {};
  for (let i = 0; i < 10; i += 1) many[`a/${i}`] = 'x'.repeat(MAX_EDIT_TEXT_CHARS);
  rejects({ edits: many }, /in total/);
  // Originals count towards the same total.
  const half = {};
  for (let i = 0; i < 4; i += 1) half[`a/${i}`] = 'x'.repeat(MAX_EDIT_TEXT_CHARS);
  assert.ok(Object.values(half).join('').length < MAX_EDIT_TOTAL_CHARS);
  assert.ok(validateEditRequest({ edits: half }));
  rejects({ edits: half, originals: half }, /in total/);
});
