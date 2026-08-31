// Validation for a customer's hand edits to a report's text, shared by the
// shop API Lambda and the members Lambda so the two doors accept exactly the
// same thing.
//
// An edit request is `{ pointer: text }` for only the fields the customer
// touched, where a pointer is the id the rendered report carries on each
// editable element (`recommendation/prose/0`, or `chrome:<id>/<attr>` for a
// heading). An empty string deletes that paragraph. `originals` carries the
// text those fields had before, so the order page can show a before/after
// comparison later; it is display-only and never sent to the engine.

// A path into the report data joined by `/`, optionally prefixed `chrome:` for
// a template heading. Same shape the engine stamps as data-pointer.
const POINTER_RE = /^(chrome:)?[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
// No ASCII control characters except \n — the engine's own rule for text.
const CONTROL_CHARS = /[\x00-\x09\x0B-\x1F\x7F]/;

const MAX_EDIT_FIELDS = 200;
const MAX_EDIT_TEXT_CHARS = 20000;
// The whole request, edits and originals together. An order row lives in one
// DynamoDB item (400 KB), and every delivered edit is kept on it for the
// history, so a single request cannot be allowed to fill that on its own.
const MAX_EDIT_TOTAL_CHARS = 120000;
const MAX_EDITED_BY_CHARS = 120;

class EditValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function normaliseText(value) {
  // Windows newlines and stray carriage returns become plain newlines; the
  // element being edited is one paragraph, so a newline is the only control
  // character that means anything.
  return String(value).replace(/\r\n?/g, '\n');
}

function validateTextMap(raw, name, { allowUnknownKeys = null } = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EditValidationError(`${name} must be an object of { pointer: text }`);
  }
  const out = {};
  let total = 0;
  for (const [pointer, value] of Object.entries(raw)) {
    if (!POINTER_RE.test(pointer)) throw new EditValidationError(`invalid pointer ${JSON.stringify(pointer)}`);
    if (allowUnknownKeys && !allowUnknownKeys.has(pointer)) continue; // originals for fields not edited: ignored
    if (typeof value !== 'string') throw new EditValidationError(`${name}[${JSON.stringify(pointer)}] must be a string`);
    const text = normaliseText(value);
    if (CONTROL_CHARS.test(text)) {
      throw new EditValidationError(`${name}[${JSON.stringify(pointer)}] contains invalid control characters`);
    }
    if (text.length > MAX_EDIT_TEXT_CHARS) {
      throw new EditValidationError(`${name}[${JSON.stringify(pointer)}] exceeds ${MAX_EDIT_TEXT_CHARS} characters`);
    }
    // Whitespace-only is a deletion, and is sent to the engine as ''.
    out[pointer] = text.trim() === '' ? '' : text;
    total += out[pointer].length;
  }
  return { map: out, total };
}

// Returns { edits, originals, editedBy } or throws an EditValidationError
// (status 400) with a message safe to show the customer.
function validateEditRequest(body) {
  if (!body || typeof body !== 'object') throw new EditValidationError('Invalid JSON body');

  const { map: edits, total: editChars } = validateTextMap(body.edits, 'edits');
  const pointers = Object.keys(edits);
  if (pointers.length === 0) throw new EditValidationError('edits is empty — change at least one paragraph');
  if (pointers.length > MAX_EDIT_FIELDS) throw new EditValidationError(`edits has more than ${MAX_EDIT_FIELDS} fields`);

  let originals = {};
  let originalChars = 0;
  if (body.originals !== undefined && body.originals !== null) {
    ({ map: originals, total: originalChars } = validateTextMap(body.originals, 'originals', {
      allowUnknownKeys: new Set(pointers),
    }));
  }
  if (editChars + originalChars > MAX_EDIT_TOTAL_CHARS) {
    throw new EditValidationError(`edits exceed ${MAX_EDIT_TOTAL_CHARS} characters in total`);
  }

  let editedBy = '';
  if (body.editedBy !== undefined && body.editedBy !== null) {
    if (typeof body.editedBy !== 'string') throw new EditValidationError('editedBy must be a string');
    editedBy = body.editedBy.replace(/\s+/g, ' ').trim().slice(0, MAX_EDITED_BY_CHARS);
    if (CONTROL_CHARS.test(editedBy)) throw new EditValidationError('editedBy contains invalid characters');
  }

  return { edits, originals, editedBy };
}

module.exports = {
  validateEditRequest,
  EditValidationError,
  POINTER_RE,
  MAX_EDIT_FIELDS,
  MAX_EDIT_TEXT_CHARS,
  MAX_EDIT_TOTAL_CHARS,
};
