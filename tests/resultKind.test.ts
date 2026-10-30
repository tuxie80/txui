import test from 'node:test';
import assert from 'node:assert/strict';
import { resultKind, resultSummary, resultWallMs, resultOverheadMs } from '../src/utils/resultKind.ts';
import type { QueryResult } from '../src/types/index.ts';

function qr(partial: Partial<QueryResult>): QueryResult {
  return {
    columns: [], rows: [], rows_affected: null,
    execution_ms: 0, fetch_ms: 0, warnings: [],
    ...partial,
  };
}

const col = (name: string) => ({ name, type_name: 'INT', nullable: true });

test('a result set (even 0 rows) is a grid', () => {
  assert.equal(resultKind(qr({ columns: [col('a')], rows: [[1]] }), 'select 1'), 'rows');
  assert.equal(resultKind(qr({ columns: [col('a')] }), 'select a from t where 1=0'), 'rows');
});

test('DML with affected count is "affected", including 0 rows', () => {
  const r = qr({ rows_affected: 3, execution_ms: 12 });
  assert.equal(resultKind(r, "update t set a=1 where id<4"), 'affected');
  assert.equal(resultSummary(r, "update t set a=1 where id<4"), '3 rows affected in 12 ms');

  const zero = qr({ rows_affected: 0, execution_ms: 5 });
  assert.equal(resultKind(zero, "delete from t where id=99"), 'affected');
  assert.equal(resultSummary(zero, "delete from t where id=99"), '0 rows affected in 5 ms');
});

test('singular row wording', () => {
  const r = qr({ rows_affected: 1, execution_ms: 3 });
  assert.equal(resultSummary(r, 'insert into t values (1)'), '1 row affected in 3 ms');
});

test('DDL/SET reporting 0 affected is "ok", not "affected"', () => {
  const ddl = qr({ rows_affected: 0, execution_ms: 1524 });
  assert.equal(resultKind(ddl, 'create table t (id int)'), 'ok');
  assert.equal(resultSummary(ddl, 'create table t (id int)'), 'completed in 1 s 524 ms');

  const set = qr({ rows_affected: null, execution_ms: 2 });
  assert.equal(resultKind(set, 'set sql_mode="STRICT"'), 'ok');
  assert.equal(resultSummary(set, 'set sql_mode="STRICT"'), 'completed in 2 ms');
});

test('data-modifying CTE counts as DML', () => {
  const r = qr({ rows_affected: 0, execution_ms: 7 });
  assert.equal(resultKind(r, 'with x as (delete from t returning *) select 1'), 'affected');
});

test('duration sums execution + fetch', () => {
  const r = qr({ rows_affected: 2, execution_ms: 10, fetch_ms: 5 });
  assert.equal(resultSummary(r, 'update t set a=1'), '2 rows affected in 15 ms');
});

test('result header uses the gutter wall time and exposes only the overhead separately', () => {
  const r = qr({ execution_ms: 7, fetch_ms: 1 });
  assert.equal(resultWallMs(r, { 0: { ms: 14 } }, 0), 14);
  assert.equal(resultOverheadMs(r, 14), 6);
});

test('a later query cannot reuse the first statement duration', () => {
  const r = qr({ execution_ms: 7, fetch_ms: 1 });
  const runs = {
    0: { status: 'ok', ms: 14, startedAt: 100 },
    2: { status: 'ok', ms: 23, startedAt: 200 },
  };
  assert.equal(resultWallMs(r, runs, 2), 23, 'exact run binding wins');
  assert.equal(resultWallMs(r, runs), 23, 'legacy results use the latest completed run');
  assert.equal(resultWallMs(r, runs, 1), 8, 'an unfinished statement never borrows an older time');
});

test('an unfinished marker falls back to backend execution + fetch', () => {
  const r = qr({ execution_ms: 7, fetch_ms: 1 });
  assert.equal(resultWallMs(r, { 0: {} }), 8);
  assert.equal(resultOverheadMs(r, 8), 0);
  assert.equal(resultOverheadMs(r, 2), 0, 'never reports negative overhead');
});
