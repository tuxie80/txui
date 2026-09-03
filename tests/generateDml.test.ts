import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertTemplate, updateTemplate } from '../src/utils/gridEdits.ts';

const cols = [
  { name: 'id', type: 'int' },
  { name: 'email', type: 'varchar' },
  { name: 'name', type: 'text' },
];

test('insertTemplate lists columns and typed NULL placeholders', () => {
  const s = insertTemplate('app.users', cols, 'postgres');
  assert.match(s, /INSERT INTO "app"\."users" \("id", "email", "name"\)/);
  assert.match(s, /\/\* varchar \*\/ NULL/);
});

test('updateTemplate SETs non-key columns and keys the WHERE by PK', () => {
  const s = updateTemplate('app.users', cols, ['id'], 'postgres');
  assert.match(s, /UPDATE "app"\."users" SET/);
  assert.ok(!/"id" = \/\*/.test(s), 'PK column should not be in SET');
  assert.match(s, /"email" = \/\* varchar \*\/ NULL/);
  assert.match(s, /WHERE "id" = NULL;/);
});

test('updateTemplate falls back to the first column when no PK is known', () => {
  const s = updateTemplate('t', cols, [], 'mysql');
  assert.match(s, /WHERE `id` = NULL;/);
});
