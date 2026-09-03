/**
 * TxShell pipeline stages (src/utils/txShellPipeline.ts).
 *
 * The claim these tests exist to defend: **a pipe carries typed rows, not
 * text.** `where total > 100` must compare numbers when the column holds
 * numbers, and must NOT quietly compare them as strings — where "9" is greater
 * than "100" and the filter returns a wrong answer that looks right.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStage, runPipeline, coerce, compareValues, matches, likeToRegex,
  columnIndex, formatForFile, parseDelimited, delimitedToResult,
  matchesPattern, unionResults,
} from '../src/utils/txShellPipeline.ts';
import type { QueryResult, ColumnInfo } from '../src/types/index.ts';

const cols = (...spec: Array<[string, string]>): ColumnInfo[] =>
  spec.map(([name, type_name]) => ({ name, type_name, nullable: true }));

const res = (columns: ColumnInfo[], rows: unknown[][]): QueryResult => ({
  columns, rows, rows_affected: null, execution_ms: 0, fetch_ms: 0, warnings: [],
});

const stage = (raw: string) => {
  const [name, ...args] = raw.split(/\s+/);
  return { name, args, raw };
};

const ORDERS = res(
  cols(['id', 'int'], ['email', 'text'], ['total', 'numeric']),
  [
    [1, 'a@x.com', 9],
    [2, 'b@y.com', 100],
    [3, 'c@x.com', 250],
    [4, 'd@z.com', null],
  ],
);

const ok = (o: ReturnType<typeof applyStage>) => {
  assert.ok(!('error' in o), 'error' in o ? o.error : '');
  return (o as { result: QueryResult }).result;
};

// ── the whole point: typed comparison ───────────────────────────────────────

test('a numeric column compares as numbers, not as text', () => {
  // The bug this exists to prevent: as strings, "9" > "100".
  const r = ok(applyStage(ORDERS, stage('where total > 100')));
  assert.deepEqual(r.rows.map(x => x[0]), [3]);
});

test('the same filter on a TEXT column compares as text', () => {
  // Honest, not clever: if the database would compare strings, so do we.
  const t = res(cols(['v', 'text']), [['9'], ['100'], ['250']]);
  const r = ok(applyStage(t, stage('where v > 100')));
  assert.deepEqual(r.rows.map(x => x[0]), ['9', '250']);
});

test('an explicitly quoted value is a string even on a numeric column', () => {
  const r = ok(applyStage(ORDERS, stage("where total = '100'")));
  assert.equal(r.rows.length, 1);
});

test('NULL compares as less than everything and never crashes', () => {
  assert.equal(compareValues(null, 5), -1);
  assert.equal(compareValues(5, null), 1);
  assert.equal(compareValues(null, null), 0);
  const r = ok(applyStage(ORDERS, stage('where total > 0')));
  assert.ok(!r.rows.some(x => x[2] === null), 'a NULL row passed a > filter');
});

test('`is null` finds the null rows', () => {
  const r = ok(applyStage(ORDERS, stage('where total is null')));
  assert.deepEqual(r.rows.map(x => x[0]), [4]);
});

test('!= keeps NULL rows rather than silently dropping them', () => {
  // SQL's three-valued logic would drop them; in a shell filter that is a
  // surprise, not a feature — the grid shows the row, so the filter should too.
  const r = ok(applyStage(ORDERS, stage('where total != 100')));
  assert.ok(r.rows.some(x => x[0] === 4), 'the NULL row was dropped');
});

test('like and ilike honour SQL wildcards', () => {
  const r = ok(applyStage(ORDERS, stage('where email like %@x.com')));
  assert.deepEqual(r.rows.map(x => x[0]), [1, 3]);
  assert.ok(likeToRegex('a_c', false).test('abc'));
  assert.ok(!likeToRegex('a_c', false).test('abbc'));
  assert.ok(likeToRegex('A%', true).test('abc'), 'ilike should ignore case');
});

test('a regex metacharacter in a like pattern is literal', () => {
  const t = res(cols(['v', 'text']), [['a.c'], ['abc']]);
  const r = ok(applyStage(t, stage('where v like a.c')));
  assert.deepEqual(r.rows.map(x => x[0]), ['a.c']);
});

test('in matches any of a comma list', () => {
  const r = ok(applyStage(ORDERS, stage('where id in 1,3')));
  assert.deepEqual(r.rows.map(x => x[0]), [1, 3]);
});

test('coerce resolves against the data before the declared type', () => {
  const c = cols(['n', 'text'])[0];
  assert.equal(coerce('5', c, 42), 5, 'numeric data wins over a text declaration');
  assert.equal(coerce('null', c, 42), null);
  assert.equal(coerce('true', c, false), true);
});

test('matches covers every documented operator', () => {
  for (const op of ['=', '!=', '<>', '<', '<=', '>', '>=', 'is', 'like', 'ilike', 'in'] as const) {
    assert.doesNotThrow(() => matches(1, op, 1), op);
  }
});

// ── shaping ─────────────────────────────────────────────────────────────────

test('select projects and reorders columns', () => {
  const r = ok(applyStage(ORDERS, stage('select total id')));
  assert.deepEqual(r.columns.map(c => c.name), ['total', 'id']);
  assert.deepEqual(r.rows[0], [9, 1]);
});

test('sort orders by a typed column, both directions', () => {
  const asc = ok(applyStage(ORDERS, stage('sort total')));
  assert.deepEqual(asc.rows.map(x => x[2]), [null, 9, 100, 250]);
  const desc = ok(applyStage(ORDERS, stage('sort total desc')));
  assert.deepEqual(desc.rows.map(x => x[2]), [250, 100, 9, null]);
});

test('sort does not mutate its input', () => {
  const before = ORDERS.rows.map(r => r[0]);
  applyStage(ORDERS, stage('sort total desc'));
  assert.deepEqual(ORDERS.rows.map(r => r[0]), before,
    'an earlier transcript entry would change under the user');
});

test('a column can be addressed by position when its name is unusable', () => {
  // Aggregates arrive as `count(*)` or `?column?`.
  const agg = res(cols(['count(*)', 'bigint']), [[7]]);
  assert.equal(columnIndex(agg, '1'), 0);
  assert.deepEqual(ok(applyStage(agg, stage('sort 1'))).rows, [[7]]);
});

test('head and tail slice, and 0 means none', () => {
  assert.equal(ok(applyStage(ORDERS, stage('head 2'))).rows.length, 2);
  assert.deepEqual(ok(applyStage(ORDERS, stage('tail 1'))).rows.map(r => r[0]), [4]);
  assert.equal(ok(applyStage(ORDERS, stage('head 0'))).rows.length, 0);
});

test('count replaces the rows with their number', () => {
  const r = ok(applyStage(ORDERS, stage('count')));
  assert.deepEqual(r.columns.map(c => c.name), ['count']);
  assert.deepEqual(r.rows, [[4]]);
});

test('distinct dedupes whole rows or named columns', () => {
  const dup = res(cols(['a', 'text'], ['b', 'int']), [['x', 1], ['x', 1], ['x', 2]]);
  assert.equal(ok(applyStage(dup, stage('distinct'))).rows.length, 2);
  assert.equal(ok(applyStage(dup, stage('distinct a'))).rows.length, 1);
});

test('stats summarises numeric columns and counts nulls', () => {
  const r = ok(applyStage(ORDERS, stage('stats total')));
  const [col, count, nulls, sum, avg, min, max] = r.rows[0];
  assert.equal(col, 'total');
  assert.equal(count, 4);
  assert.equal(nulls, 1);
  assert.equal(sum, 359);
  assert.ok(Math.abs(Number(avg) - 359 / 3) < 1e-9, 'avg must ignore nulls');
  assert.equal(min, 9);
  assert.equal(max, 250);
});

test('stats with no numeric column says so instead of returning nothing', () => {
  const t = res(cols(['v', 'text']), [['a']]);
  const o = applyStage(t, stage('stats'));
  assert.ok('error' in o && /numeric/.test(o.error));
});

// ── errors that help ────────────────────────────────────────────────────────

test('an unknown column lists the ones that exist', () => {
  const o = applyStage(ORDERS, stage('where totl > 1'));
  assert.ok('error' in o);
  assert.match(o.error, /No column `totl`/);
  assert.match(o.error, /id, email, total/);
});

test('a pipeline failure names which stage failed', () => {
  const o = runPipeline(ORDERS, [stage('head 2'), stage('where nope = 1')]);
  assert.ok('error' in o);
  assert.match(o.error, /stage 2/);
  assert.match(o.error, /where nope = 1/);
});

test('a bad sort direction is refused', () => {
  const o = applyStage(ORDERS, stage('sort total sideways'));
  assert.ok('error' in o && /asc or desc/.test(o.error));
});

// ── sinks ───────────────────────────────────────────────────────────────────

test('save infers its format from the extension', () => {
  assert.equal(formatForFile('report.csv'), 'csv');
  assert.equal(formatForFile('a/b/report.JSON'), 'json');
  assert.equal(formatForFile('dump.sql'), 'inserts');
  assert.equal(formatForFile('book.xlsx'), 'xlsx');
  assert.equal(formatForFile('noext'), null);
});

test('save returns a description of the write rather than performing it', () => {
  // Keeping IO out of the pure layer is what lets all of this be tested.
  const o = applyStage(ORDERS, stage('save out.csv'));
  assert.ok(!('error' in o));
  assert.deepEqual((o as { sink: unknown }).sink,
    { kind: 'save', file: 'out.csv', format: 'csv' });
});

test('an unrecognised extension is refused with the list', () => {
  const o = applyStage(ORDERS, stage('save report.docx'));
  assert.ok('error' in o && /Cannot tell the format/.test(o.error));
});

test('`to xlsx` is refused because xlsx is binary', () => {
  const o = applyStage(ORDERS, stage('to xlsx'));
  assert.ok('error' in o && /save report\.xlsx/.test(o.error));
});

test('a full pipeline runs in order and carries its sink', () => {
  const o = runPipeline(ORDERS, [
    stage('where total > 5'), stage('sort total desc'), stage('head 2'), stage('save out.csv'),
  ]);
  assert.ok(!('error' in o));
  const r = o as { result: QueryResult; sink?: { file?: string } };
  assert.deepEqual(r.result.rows.map(x => x[2]), [250, 100]);
  assert.equal(r.sink?.file, 'out.csv');
});

// ── CSV in ──────────────────────────────────────────────────────────────────

test('delimited parsing survives quotes, commas and newlines in fields', () => {
  // A naive split(',') mangles all three, silently.
  const g = parseDelimited('a,b\n"x,y","line\nbreak"\n"say ""hi""",2');
  assert.deepEqual(g[0], ['a', 'b']);
  assert.deepEqual(g[1], ['x,y', 'line\nbreak']);
  assert.deepEqual(g[2], ['say "hi"', '2']);
});

test('a CSV column of numbers becomes numeric so filters compare correctly', () => {
  const r = delimitedToResult('id,total\n1,9\n2,100\n3,250\n');
  assert.equal(r.columns[1].type_name, 'numeric');
  const filtered = ok(applyStage(r, stage('where total > 100')));
  assert.deepEqual(filtered.rows.map(x => x[0]), [3]);
});

test('one non-numeric value keeps the whole column text', () => {
  // A half-typed column is worse than an honestly untyped one.
  const r = delimitedToResult('v\n1\n2\nn/a\n');
  assert.equal(r.columns[0].type_name, 'text');
});

test('empty CSV cells become NULL, not empty strings', () => {
  const r = delimitedToResult('a,b\n1,\n');
  assert.equal(r.rows[0][1], null);
});

test('an empty file yields an empty result rather than throwing', () => {
  assert.deepEqual(delimitedToResult('').rows, []);
});

// ── fan-out ─────────────────────────────────────────────────────────────────

test('patterns glob rather than regex', () => {
  assert.ok(matchesPattern('prod-eu', 'prod-*'));
  assert.ok(matchesPattern('prod-eu', '*'));
  assert.ok(!matchesPattern('dev-eu', 'prod-*'));
  // A regex `.` would match everything — on a command that then runs there.
  assert.ok(!matchesPattern('prodxeu', 'prod.eu'));
  assert.ok(matchesPattern('PROD-EU', 'prod-*'), 'matching should ignore case');
  assert.ok(!matchesPattern('anything', ''));
});

test('fan-out stacks results and names the server', () => {
  const a = res(cols(['n', 'int']), [[1]]);
  const b = res(cols(['n', 'int']), [[2]]);
  const u = unionResults([{ name: 'eu', result: a }, { name: 'us', result: b }]);
  assert.deepEqual(u.columns.map(c => c.name), ['connection', 'n']);
  assert.deepEqual(u.rows, [['eu', 1], ['us', 2]]);
});

test('servers returning columns in a different order are aligned by NAME', () => {
  // Stacking positionally would silently mix values between columns.
  const a = res(cols(['x', 'int'], ['y', 'int']), [[1, 2]]);
  const b = res(cols(['y', 'int'], ['x', 'int']), [[20, 10]]);
  const u = unionResults([{ name: 'a', result: a }, { name: 'b', result: b }]);
  assert.deepEqual(u.rows, [['a', 1, 2], ['b', 10, 20]]);
});

test('a server that returned no columns is skipped, not stacked as nulls', () => {
  const a = res(cols(['n', 'int']), [[1]]);
  const none = res([], []);
  const u = unionResults([{ name: 'a', result: a }, { name: 'dead', result: none }]);
  assert.equal(u.rows.length, 1);
});

// ── cross-server insert ─────────────────────────────────────────────────────

test('insert defaults to the current session', () => {
  const o = applyStage(ORDERS, stage('insert into staging.t'));
  assert.ok(!('error' in o));
  assert.deepEqual((o as { sink: unknown }).sink,
    { kind: 'insert', table: 'staging.t', destination: undefined });
});

test('insert can name a different connection', () => {
  // The server-to-server case: read from one, write to another, types intact.
  const o = applyStage(ORDERS, stage('insert into staging.t @dev'));
  assert.equal((o as { sink: { destination?: string } }).sink.destination, 'dev');
});

test('a destination without @ is refused rather than treated as a table', () => {
  const o = applyStage(ORDERS, stage('insert into staging.t dev'));
  assert.ok('error' in o && /must be written `@dev`/.test(o.error));
});
