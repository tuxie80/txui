/**
 * Bulk table alteration (src/utils/bulkAlter.ts).
 *
 * The most dangerous module in the app. `ALTER TABLE … ENGINE=` or
 * `… CONVERT TO CHARACTER SET` rewrites every row, MySQL commits DDL
 * implicitly so there is nothing to roll back, and doing it across forty
 * tables is an outage rather than a slow operation.
 *
 * Two behaviours carry all the safety, and both are tested here:
 *   1. **Tables already at the target are skipped.** A no-op
 *      `CONVERT TO CHARACTER SET` still rebuilds the table, so including them
 *      turns a five-table change into a forty-table one.
 *   2. **The cost is stated before it runs**, with the row count — "12 tables"
 *      and "12 tables, 400 million rows" are different decisions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELDS, fieldsFor, findField, planBulk, alterClause, charsetOf,
  currentValue, planWarning, suggestionsFor,
} from '../src/utils/bulkAlter.ts';
import type { BulkTable } from '../src/utils/bulkAlter.ts';

const T = (over: Partial<BulkTable> = {}): BulkTable => ({
  schema: 'shop', name: 'orders', engine: 'InnoDB',
  collation: 'utf8mb4_general_ci', charset: 'utf8mb4', comment: '',
  rows: 1000, ...over,
});

// ── cost metadata, which is the safety ──────────────────────────────────────

test('a comment change is metadata-only; everything else rebuilds', () => {
  assert.equal(findField('comment')?.cost, 'metadata');
  for (const id of ['engine', 'charset', 'collation', 'rowFormat']) {
    assert.equal(findField(id)?.cost, 'rebuild', id);
  }
});

test('every rebuilding field states what actually happens', () => {
  for (const f of FIELDS.filter(x => x.cost === 'rebuild')) {
    assert.ok(f.effect.length > 40, `${f.id}'s effect is too vague`);
    assert.match(f.effect, /REBUILD|rewrit/i, f.id);
  }
});

test('the charset warning mentions that values can CHANGE', () => {
  // Converting to a narrower charset silently mangles characters that have no
  // equivalent. That is data loss, not slowness.
  assert.match(findField('charset')!.effect, /CHANGE STORED VALUES/i);
});

test('fields are MySQL-only for now', () => {
  assert.ok(fieldsFor('mysql').length > 0);
  assert.deepEqual(fieldsFor('postgres'), []);
});

// ── the skip rule ───────────────────────────────────────────────────────────

test('a table already at the target is SKIPPED and reported', () => {
  // A no-op CONVERT still rebuilds. Including it is the whole hazard.
  const plan = planBulk(
    [T({ name: 'a', collation: 'utf8mb4_bin' }), T({ name: 'b' })],
    { field: 'collation', value: 'utf8mb4_bin' });
  assert.deepEqual(plan.alters.map(a => a.name), ['b']);
  assert.deepEqual(plan.skipped.map(s => s.name), ['a']);
  assert.match(plan.skipped[0].reason, /already/);
});

test('the skip comparison ignores case and surrounding space', () => {
  const plan = planBulk([T({ engine: 'innodb' })], { field: 'engine', value: '  InnoDB ' });
  assert.equal(plan.alters.length, 0);
});

test('a table whose current value is unknown is NOT skipped', () => {
  // Skipping on missing information would silently drop it from the change.
  const plan = planBulk([T({ engine: undefined })], { field: 'engine', value: 'InnoDB' });
  assert.equal(plan.alters.length, 1);
});

// ── generated SQL ───────────────────────────────────────────────────────────

test('each table gets its own qualified ALTER', () => {
  const plan = planBulk([T({ name: 'orders', engine: 'MyISAM' })],
    { field: 'engine', value: 'InnoDB' });
  assert.equal(plan.alters[0].sql, 'ALTER TABLE `shop`.`orders` ENGINE = InnoDB');
});

test('a collation change CONVERTS rather than setting a default', () => {
  // `ALTER TABLE … DEFAULT COLLATE` changes only NEW columns and leaves the
  // existing ones behind — the trap this avoids.
  const sql = alterClause({ field: 'collation', value: 'utf8mb4_bin' });
  assert.match(sql, /CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin/);
  assert.ok(!/DEFAULT COLLATE/i.test(sql));
});

test('the charset is derived from the collation name', () => {
  assert.equal(charsetOf('utf8mb4_0900_ai_ci'), 'utf8mb4');
  assert.equal(charsetOf('latin1_swedish_ci'), 'latin1');
  assert.equal(charsetOf('binary'), 'binary');
});

test('a comment is quoted and escaped', () => {
  assert.equal(alterClause({ field: 'comment', value: "it's" }), "COMMENT = 'it''s'");
});

test('an identifier-shaped value cannot carry SQL', () => {
  // Engine and row format go in unquoted, so anything but word characters is
  // stripped rather than trusted.
  assert.equal(alterClause({ field: 'engine', value: 'InnoDB; DROP TABLE x' }),
    'ENGINE = InnoDBDROPTABLEx');
  assert.ok(!alterClause({ field: 'collation', value: "a'; DROP" }).includes(';'));
});

test('a table name with a backtick is escaped', () => {
  const plan = planBulk([T({ name: 'we`ird', engine: 'MyISAM' })],
    { field: 'engine', value: 'InnoDB' });
  assert.match(plan.alters[0].sql, /`we``ird`/);
});

// ── the warning ─────────────────────────────────────────────────────────────

test('a rebuilding plan warns, with the table AND row count', () => {
  const plan = planBulk(
    [T({ name: 'a', rows: 4_000_000, engine: 'MyISAM' }),
     T({ name: 'b', rows: 1_000_000, engine: 'MyISAM' })],
    { field: 'engine', value: 'InnoDB' });
  const w = planWarning(plan, findField('engine'));
  assert.ok(w);
  assert.match(w, /2 tables will be REBUILT/);
  assert.match(w, /5,000,000 rows/);
  assert.match(w, /no transaction to roll this back/i);
  assert.match(w, /backup/i);
});

test('a metadata-only plan does not warn', () => {
  // Crying wolf on a comment change is how the real warning stops being read.
  const plan = planBulk([T()], { field: 'comment', value: 'hello' });
  assert.equal(planWarning(plan, findField('comment')), null);
});

test('an empty plan does not warn', () => {
  const plan = planBulk([T({ engine: 'InnoDB' })], { field: 'engine', value: 'InnoDB' });
  assert.equal(plan.alters.length, 0);
  assert.equal(planWarning(plan, findField('engine')), null);
});

test('rowsAffected is only counted for rebuilds', () => {
  const meta = planBulk([T({ rows: 999 })], { field: 'comment', value: 'x' });
  assert.equal(meta.rowsAffected, 0);
  assert.equal(meta.rebuilds, false);
  const heavy = planBulk([T({ rows: 999, engine: 'MyISAM' })], { field: 'engine', value: 'InnoDB' });
  assert.equal(heavy.rowsAffected, 999);
  assert.equal(heavy.rebuilds, true);
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('current values are read per field', () => {
  const t = T({ comment: 'note', rowFormat: 'DYNAMIC' });
  assert.equal(currentValue(t, 'engine'), 'InnoDB');
  assert.equal(currentValue(t, 'comment'), 'note');
  assert.equal(currentValue(t, 'rowFormat'), 'DYNAMIC');
});

test('suggestions exist for the picked fields and not for free text', () => {
  assert.ok(suggestionsFor('engine').includes('InnoDB'));
  assert.ok(suggestionsFor('collation').some(c => c.startsWith('utf8mb4')));
  assert.deepEqual(suggestionsFor('comment'), []);
});
