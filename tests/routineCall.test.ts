/**
 * Building the SQL that INVOKES a routine (src/utils/routineCall.ts).
 *
 * The two things that must be right: OUT/INOUT parameters round-trip through
 * session variables (SET before, SELECT after, the var used in the CALL), and
 * typed values land as the right kind of literal — a number bare, a string
 * escaped, a blank as NULL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutineCall, formatValue } from '../src/utils/routineCall.ts';
import type { RoutineParam } from '../src/utils/routineDdl.ts';

const IN = (name: string, type = 'INT'): RoutineParam => ({ mode: 'IN', name, type });
const OUT = (name: string, type = 'INT'): RoutineParam => ({ mode: 'OUT', name, type });
const INOUT = (name: string, type = 'INT'): RoutineParam => ({ mode: 'INOUT', name, type });

test('function → a single SELECT with the input arguments, aliased result', () => {
  const sql = buildRoutineCall({
    kind: 'function', schema: 'shop', name: 'total_due',
    params: [IN('customer'), IN('rate', 'DECIMAL(4,2)')],
    values: { customer: '7', rate: '1.5' },
    engine: 'mysql',
  });
  assert.deepEqual(sql, ['SELECT `shop`.`total_due`(7, 1.5) AS result;']);
});

test('function with no schema drops the qualifier', () => {
  const sql = buildRoutineCall({
    kind: 'function', name: 'now_plus', params: [IN('days')],
    values: { days: '3' }, engine: 'mysql',
  });
  assert.deepEqual(sql, ['SELECT `now_plus`(3) AS result;']);
});

test('procedure, IN-only → just the CALL, no SET or SELECT', () => {
  const sql = buildRoutineCall({
    kind: 'procedure', schema: 'shop', name: 'reprice',
    params: [IN('sku', 'VARCHAR(32)'), IN('pct')],
    values: { sku: 'A-100', pct: '10' },
    engine: 'mysql',
  });
  assert.deepEqual(sql, ["CALL `shop`.`reprice`('A-100', 10);"]);
});

test('procedure with OUT → SET NULL first, var in the CALL, SELECT it back', () => {
  const sql = buildRoutineCall({
    kind: 'procedure', schema: 'shop', name: 'count_orders',
    params: [IN('customer'), OUT('total')],
    values: { customer: '42' },
    engine: 'mysql',
  });
  assert.deepEqual(sql, [
    'SET @p_total = NULL;',
    'CALL `shop`.`count_orders`(42, @p_total);',
    'SELECT @p_total AS total;',
  ]);
});

test('procedure with INOUT → SET carries the input value in', () => {
  const sql = buildRoutineCall({
    kind: 'procedure', name: 'accumulate',
    params: [INOUT('running'), IN('add')],
    values: { running: '100', add: '5' },
    engine: 'mysql',
  });
  assert.deepEqual(sql, [
    'SET @p_running = 100;',
    'CALL `accumulate`(@p_running, 5);',
    'SELECT @p_running AS running;',
  ]);
});

test('mixed OUT and INOUT → one SET each, both in the trailing SELECT', () => {
  const sql = buildRoutineCall({
    kind: 'procedure', name: 'settle',
    params: [IN('id'), INOUT('bal'), OUT('fee')],
    values: { id: '9', bal: '250' },
    engine: 'mysql',
  });
  assert.deepEqual(sql, [
    'SET @p_bal = 250;',
    'SET @p_fee = NULL;',
    'CALL `settle`(9, @p_bal, @p_fee);',
    'SELECT @p_bal AS bal, @p_fee AS fee;',
  ]);
});

test('no-params procedure → a bare CALL', () => {
  const sql = buildRoutineCall({
    kind: 'procedure', schema: 'ops', name: 'nightly',
    params: [], values: {}, engine: 'mysql',
  });
  assert.deepEqual(sql, ['CALL `ops`.`nightly`();']);
});

test('no-params function → SELECT with empty arg list', () => {
  const sql = buildRoutineCall({
    kind: 'function', name: 'pi', params: [], values: {}, engine: 'mysql',
  });
  assert.deepEqual(sql, ['SELECT `pi`() AS result;']);
});

test('value quoting: number bare, string escaped, blank/missing → NULL', () => {
  const sql = buildRoutineCall({
    kind: 'procedure', name: 'p',
    params: [IN('num'), IN('str'), IN('empty'), IN('absent'), IN('neg'), IN('dec')],
    values: { num: '42', str: "O'Brien", empty: '   ', neg: '-7', dec: '3.14' },
    engine: 'mysql',
  });
  assert.deepEqual(sql, ["CALL `p`(42, 'O''Brien', NULL, NULL, -7, 3.14);"]);
});

test('reserved-word parameter names are quoted where they become identifiers', () => {
  const sql = buildRoutineCall({
    kind: 'procedure', name: 'p',
    params: [OUT('order')],
    values: {}, engine: 'mysql',
  });
  // The session var is a user variable (no quoting needed); the SELECT alias is
  // a real identifier and must be quoted since `order` is reserved.
  assert.deepEqual(sql, [
    'SET @p_order = NULL;',
    'CALL `p`(@p_order);',
    'SELECT @p_order AS `order`;',
  ]);
});

test('PostgreSQL function uses double-quoted identifiers', () => {
  const sql = buildRoutineCall({
    kind: 'function', schema: 'public', name: 'add',
    params: [IN('a'), IN('b')],
    values: { a: '1', b: '2' }, engine: 'postgres',
  });
  assert.deepEqual(sql, ['SELECT "public"."add"(1, 2) AS result;']);
});

test('formatValue is the single source of truth for literalization', () => {
  assert.equal(formatValue('10', 'mysql'), '10');
  assert.equal(formatValue('', 'mysql'), 'NULL');
  assert.equal(formatValue(undefined, 'mysql'), 'NULL');
  assert.equal(formatValue('hi', 'mysql'), "'hi'");
  assert.equal(formatValue('a\\b', 'mysql'), "'a\\\\b'");
  assert.equal(formatValue('a\\b', 'postgres'), "'a\\b'");
});

// ── SQL Server ───────────────────────────────────────────────────────────────

const MS_PARAMS: RoutineParam[] = [
  { mode: 'IN', name: '@older_than_days', type: 'int', defaultValue: '90' },
  { mode: 'OUT', name: '@closed', type: 'int' },
];

test('a T-SQL procedure call is ONE batch — DECLARE does not outlive it', () => {
  const out = buildRoutineCall({
    kind: 'procedure', schema: 'sales', name: 'usp_close_orders',
    params: MS_PARAMS, values: { '@older_than_days': '30' }, engine: 'sqlserver',
  });
  // One entry, because a `;`-splitting runner would otherwise separate the
  // DECLARE from the EXEC that uses it.
  assert.equal(out.length, 1);
  assert.match(out[0], /DECLARE @p_closed int\n/);
  assert.match(out[0], /EXEC \[sales\]\.\[usp_close_orders\] @older_than_days = 30, @closed = @p_closed OUTPUT/);
  // safeIdent quotes only what needs it, so a bare-legal alias stays bare.
  assert.match(out[0], /SELECT @p_closed AS closed;$/);
  // Exactly one semicolon, at the very end.
  assert.equal(out[0].split(';').length - 1, 1);
});

test('the OUT variable is declared with the parameter type, not guessed', () => {
  const out = buildRoutineCall({
    kind: 'procedure', schema: 's', name: 'p',
    params: [{ mode: 'OUT', name: '@t', type: 'decimal(10,2)' }],
    values: {}, engine: 'sqlserver',
  });
  assert.match(out[0], /DECLARE @p_t decimal\(10,2\)/);
  // @p_@t is not an identifier — the leading @ has to come off first.
  assert.ok(!out[0].includes('@p_@'));
});

test('a blank optional argument is omitted so the default applies', () => {
  const out = buildRoutineCall({
    kind: 'procedure', schema: 'sales', name: 'usp_close_orders',
    params: MS_PARAMS, values: {}, engine: 'sqlserver',
  });
  // Passing NULL over a default is a different call, and usually the wrong one.
  assert.ok(!out[0].includes('@older_than_days'));
  assert.match(out[0], /EXEC \[sales\]\.\[usp_close_orders\] @closed = @p_closed OUTPUT/);
});

test('a blank argument with NO default is still passed, as NULL', () => {
  const out = buildRoutineCall({
    kind: 'procedure', schema: 's', name: 'p',
    params: [{ mode: 'IN', name: '@a', type: 'int' }],
    values: {}, engine: 'sqlserver',
  });
  assert.match(out[0], /@a = NULL/);
});

test('a scalar function is selected, a table-valued one is selected FROM', () => {
  const scalar = buildRoutineCall({
    kind: 'function', schema: 'sales', name: 'fn_order_total_with_vat',
    params: [{ mode: 'IN', name: '@order_id', type: 'bigint' }],
    values: { '@order_id': '2' }, engine: 'sqlserver', returns: 'decimal(12,2)',
  });
  assert.deepEqual(scalar, ['SELECT [sales].[fn_order_total_with_vat](2) AS result;']);

  const tvf = buildRoutineCall({
    kind: 'function', schema: 'sales', name: 'tvf_orders_for_customer',
    params: [{ mode: 'IN', name: '@customer_id', type: 'int' }],
    values: { '@customer_id': '1' }, engine: 'sqlserver', returns: 'TABLE',
  });
  // `SELECT tvf(…)` is a syntax error, and so is `SELECT * FROM scalar(…)`.
  assert.deepEqual(tvf, ['SELECT * FROM [sales].[tvf_orders_for_customer](1);']);

  // A multi-statement TVF declares a table variable and must go the same way.
  const mstvf = buildRoutineCall({
    kind: 'function', schema: 's', name: 'f', params: [], values: {},
    engine: 'sqlserver', returns: '@t TABLE (id int)',
  });
  assert.match(mstvf[0], /SELECT \* FROM/);
});

test('an INOUT parameter is seeded before the call and read back after', () => {
  const out = buildRoutineCall({
    kind: 'procedure', schema: 's', name: 'p',
    params: [{ mode: 'INOUT', name: '@n', type: 'int' }],
    values: { '@n': '5' }, engine: 'sqlserver',
  });
  assert.match(out[0], /DECLARE @p_n int\nSET @p_n = 5\n/);
  assert.match(out[0], /@n = @p_n OUTPUT/);
  assert.match(out[0], /SELECT @p_n AS n/);
});

test('a string argument is escaped, not interpolated', () => {
  const out = buildRoutineCall({
    kind: 'procedure', schema: 's', name: 'p',
    params: [{ mode: 'IN', name: '@s', type: 'nvarchar(50)' }],
    values: { '@s': "it's" }, engine: 'sqlserver',
  });
  assert.match(out[0], /@s = 'it''s'/);
});
