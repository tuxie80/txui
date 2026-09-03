/**
 * App-wide input policy (src/utils/inputBehaviour.ts).
 *
 * The bug this prevents: a silently autocorrected or autofilled hostname,
 * identifier or password. Annotating inputs by hand does not scale — there are
 * ~150 of them — so the policy is applied to the document and must cover
 * fields mounted long after startup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suppressionAttrs, isTextFieldType } from '../src/utils/inputBehaviour.ts';

test('every free-text input type is covered', () => {
  for (const t of ['', 'text', 'search', 'url', 'tel', 'email', 'password',
                   'number', 'date', 'time', 'datetime-local', 'month', 'week']) {
    assert.equal(isTextFieldType('input', t), true, `type="${t}" must be stamped`);
  }
  assert.equal(isTextFieldType('textarea'), true);
});

test('inputs with nothing to fill are left alone', () => {
  // Stamping these is harmless but pointless, and touching <input type="range">
  // or type="color" risks confusing their native UI.
  for (const t of ['checkbox', 'radio', 'button', 'submit', 'reset', 'file',
                   'color', 'range', 'hidden', 'image']) {
    assert.equal(isTextFieldType('input', t), false, `type="${t}" must be skipped`);
  }
});

test('input type matching is case-insensitive', () => {
  // React normalises, but hand-written HTML and pasted markup may not.
  assert.equal(isTextFieldType('input', 'TEXT'), true);
  assert.equal(isTextFieldType('input', 'Password'), true);
  assert.equal(isTextFieldType('input', 'CHECKBOX'), false);
});

test('the suppression set covers the browser AND the password managers', () => {
  const a = suppressionAttrs();
  // Browser / WebKit side. autocorrect and autocapitalize are the two that
  // actually rewrite characters — a capitalised identifier is a broken one.
  assert.equal(a.autocomplete, 'off');
  assert.equal(a.autocorrect, 'off');
  assert.equal(a.autocapitalize, 'off');
  // Password managers ignore `autocomplete` entirely and need their own opt-out.
  assert.ok('data-1p-ignore' in a, '1Password');
  assert.equal(a['data-lpignore'], 'true', 'LastPass');
  assert.ok('data-bwignore' in a, 'Bitwarden');
  assert.equal(a['data-form-type'], 'other', 'Dashlane');
});
