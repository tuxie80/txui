/**
 * The default row-limit guard, in both dialects.
 *
 * This module had no test file, and that is how the bug below shipped:
 * `applyDefaultLimit` appended `LIMIT n` for every engine with SQL, but
 * **T-SQL has no LIMIT**. From the day SQL Server shipped, every unbounded
 * SELECT in the editor came back as *"Incorrect syntax near 'LIMIT'"* — and
 * because the DBA views are review-only (they emit SQL into the editor), all
 * 29 of them failed too.
 *
 * `TOP` is positional, which makes it the harder half: it belongs after the
 * OUTER SELECT — past any CTEs — and after DISTINCT.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyDefaultLimit, limitDialect, stripRowCap, replaceRowCap } from '../src/utils/limitGuard.ts';

const top = (sql: string, n = 100) => applyDefaultLimit(sql, n, 'top');
const lim = (sql: string, n = 100) => applyDefaultLimit(sql, n, 'limit');

describe('dialect selection', () => {
  test('SQL Server is the only TOP dialect', () => {
    assert.equal(limitDialect('sqlserver'), 'top');
    for (const e of ['mysql', 'postgres', 'sqlite', 'duckdb', 'clickhouse', 'parquet']) {
      assert.equal(limitDialect(e), 'limit', e);
    }
  });

  test('the default is LIMIT, so existing callers are unchanged', () => {
    assert.equal(applyDefaultLimit('SELECT * FROM t', 10).sql, 'SELECT * FROM t\nLIMIT 10');
  });
});

describe('LIMIT dialect', () => {
  test('appends to an unbounded SELECT', () => {
    assert.deepEqual(lim('SELECT * FROM t', 5), { sql: 'SELECT * FROM t\nLIMIT 5', applied: true });
  });
  test('leaves a query that limits itself', () => {
    assert.equal(lim('SELECT * FROM t LIMIT 3').applied, false);
  });
  test('a LIMIT inside a subquery does not count as the caller having one', () => {
    assert.equal(lim('SELECT * FROM (SELECT * FROM t LIMIT 3) x').applied, true);
  });
  test('writes are never capped', () => {
    for (const s of ['UPDATE t SET a = 1', 'DELETE FROM t', 'INSERT INTO t VALUES (1)']) {
      assert.equal(lim(s).applied, false, s);
    }
  });
});

describe('TOP dialect (T-SQL)', () => {
  test('a plain SELECT gets TOP after the keyword, not LIMIT at the end', () => {
    const r = top('SELECT * FROM orders', 100);
    assert.equal(r.applied, true);
    assert.equal(r.sql, 'SELECT TOP (100) * FROM orders');
    assert.ok(!/LIMIT/i.test(r.sql), 'LIMIT is a syntax error in T-SQL');
  });

  test('DISTINCT comes before TOP', () => {
    // `SELECT TOP (n) DISTINCT` is a syntax error; the other order is correct.
    assert.equal(top('SELECT DISTINCT country FROM customers', 50).sql,
      'SELECT DISTINCT TOP (50) country FROM customers');
  });

  test('a CTE is capped on the OUTER select, never inside the CTE body', () => {
    const r = top('WITH c AS (SELECT * FROM orders) SELECT * FROM c', 20);
    assert.equal(r.sql, 'WITH c AS (SELECT * FROM orders) SELECT TOP (20) * FROM c');
  });

  test('the user\'s own TOP wins', () => {
    for (const s of ['SELECT TOP 5 * FROM t',
                     'SELECT TOP (5) * FROM t',
                     'SELECT TOP 5 PERCENT * FROM t',
                     'SELECT DISTINCT TOP 5 * FROM t']) {
      assert.equal(top(s).applied, false, s);
    }
  });

  test('OFFSET … FETCH already bounds the query', () => {
    // T-SQL's other limiter. Adding TOP as well would change the answer.
    assert.equal(
      top('SELECT * FROM t ORDER BY id OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY').applied, false);
  });

  test('a keyword inside a string literal is not mistaken for the real one', () => {
    // blank() replaces string bodies with same-length spaces, so offsets still
    // index the original text — this is what makes splicing safe.
    const r = top("SELECT 'select x' AS s FROM t", 10);
    assert.equal(r.sql, "SELECT TOP (10) 'select x' AS s FROM t");
  });

  test('writes are never capped here either', () => {
    for (const s of ['UPDATE t SET a = 1', 'DELETE FROM t', 'INSERT INTO t VALUES (1)']) {
      assert.equal(top(s).applied, false, s);
    }
  });

  test('limit 0 disables the guard in both dialects', () => {
    assert.equal(top('SELECT * FROM t', 0).applied, false);
    assert.equal(lim('SELECT * FROM t', 0).applied, false);
  });

  test('a real DBA view survives the guard as valid T-SQL', () => {
    // The shape that was failing: a multi-line view with a CTE.
    const view = `WITH cols AS (
        SELECT ic.object_id FROM sys.index_columns ic
    )
    SELECT SCHEMA_NAME(o.schema_id), o.name
    FROM cols a JOIN sys.objects o ON o.object_id = a.object_id`;
    const r = top(view, 500);
    assert.equal(r.applied, true);
    assert.match(r.sql, /SELECT TOP \(500\) SCHEMA_NAME/);
    assert.ok(!/LIMIT/i.test(r.sql));
  });
});

// ── T-SQL set operations ─────────────────────────────────────────────────────

test('a top-level UNION is left alone — TOP would change the ANSWER, not just the cap', () => {
  // Measured on SQL Server 2022: `SELECT TOP (7) id FROM orders UNION ALL
  // SELECT id FROM customers` returned 2007 rows — 7 from the first branch and
  // all 2,000 of the second, silently dropping 33,327 rows from the first.
  // A trailing LIMIT after a union applies to the whole union; TOP binds to the
  // first SELECT only, and that difference makes the result WRONG rather than
  // merely uncapped.
  for (const op of ['UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT']) {
    const sql = `SELECT id FROM a ${op} SELECT id FROM b`;
    const r = applyDefaultLimit(sql, 7, 'top');
    assert.equal(r.applied, false, op);
    assert.equal(r.sql, sql, op);
  }
});

test('a UNION inside a subquery does not stop the OUTER select being capped', () => {
  // Only a TOP-LEVEL set operator is a problem; nested, the outer SELECT owns
  // the row count and TOP means exactly what it says.
  const r = applyDefaultLimit(
    'SELECT id FROM (SELECT id FROM a UNION ALL SELECT id FROM b) x', 7, 'top');
  assert.equal(r.applied, true);
  assert.match(r.sql, /^SELECT TOP \(7\) id FROM \(/);
});

test('the WORD union in a string or an identifier is not a set operator', () => {
  const inString = applyDefaultLimit("SELECT id, 'union all' AS note FROM t", 7, 'top');
  assert.equal(inString.applied, true);
  const inName = applyDefaultLimit('SELECT union_id, intersects FROM t', 7, 'top');
  assert.equal(inName.applied, true);
});

test('the LIMIT dialect still caps a union, because a trailing LIMIT applies to it', () => {
  // The asymmetry is the whole point: this is correct on MySQL and PostgreSQL
  // and has no T-SQL equivalent.
  const r = applyDefaultLimit('SELECT id FROM a UNION ALL SELECT id FROM b', 7, 'limit');
  assert.equal(r.applied, true);
  assert.match(r.sql, /LIMIT 7$/);
});

/**
 * `replaceRowCap` — for a caller that OWNS the row count rather than merely
 * defending against an unbounded query. The DBA Views panel is the one such
 * caller: its curated SQL ships with a cap (`LIMIT 200`, `SELECT TOP 200`) and
 * its Limit buttons replace that with the user's choice.
 *
 * The panel used to do this by hand — strip a trailing LIMIT, concatenate
 * ` LIMIT n` — with no idea which engine it was talking to. So the T-SQL bug
 * this file was written for survived in a second place: every SQL Server DBA
 * view came back "Incorrect syntax near 'LIMIT'", and every Redis view had
 * ` LIMIT 1000` glued onto a command like `INFO memory`.
 */
describe('stripRowCap', () => {
  test('removes a trailing LIMIT so the caller can substitute its own', () => {
    assert.equal(stripRowCap('SELECT * FROM t ORDER BY a LIMIT 200'), 'SELECT * FROM t ORDER BY a');
  });

  test('removes TOP from the outer SELECT, with or without parens', () => {
    assert.equal(stripRowCap('SELECT TOP 200 a, b FROM t', 'top'), 'SELECT a, b FROM t');
    assert.equal(stripRowCap('SELECT TOP (200) a FROM t', 'top'), 'SELECT a FROM t');
    assert.equal(stripRowCap('SELECT DISTINCT TOP 50 a FROM t', 'top'), 'SELECT DISTINCT a FROM t');
  });

  test('PERCENT and WITH TIES are not row counts, so they stay', () => {
    // Swapping `TOP 5 PERCENT` for `TOP (100)` would answer a different
    // question; WITH TIES is bound to the query's ORDER BY.
    assert.equal(stripRowCap('SELECT TOP 5 PERCENT a FROM t', 'top'), 'SELECT TOP 5 PERCENT a FROM t');
    assert.equal(stripRowCap('SELECT TOP 5 WITH TIES a FROM t ORDER BY a', 'top'),
      'SELECT TOP 5 WITH TIES a FROM t ORDER BY a');
  });

  test('a cap inside a CTE body or a string literal is not the outer one', () => {
    const cte = 'WITH c AS (SELECT TOP 10 a FROM t) SELECT TOP 200 a FROM c';
    assert.equal(stripRowCap(cte, 'top'), 'WITH c AS (SELECT TOP 10 a FROM t) SELECT a FROM c');
    const str = "SELECT 'TOP 5' AS note FROM t";
    assert.equal(stripRowCap(str, 'top'), str);
  });
});

describe('replaceRowCap', () => {
  test('a DBA view keeps its cap shape and takes the new number', () => {
    assert.equal(replaceRowCap('SELECT a FROM t LIMIT 200', 1000, 'limit'),
      'SELECT a FROM t\nLIMIT 1000');
    const ms = replaceRowCap('SELECT TOP 200 a FROM t', 1000, 'top');
    assert.equal(ms, 'SELECT TOP (1000) a FROM t');
    assert.ok(!/LIMIT/i.test(ms), "T-SQL must never receive LIMIT — this is the reported bug");
  });

  test('the real "Sessions & requests" view survives as valid T-SQL', () => {
    const view = `SELECT TOP 200 s.session_id, r.status, r.wait_type
            FROM sys.dm_exec_sessions s
            LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
            ORDER BY r.total_elapsed_time DESC`;
    const out = replaceRowCap(view, 100, 'top');
    assert.ok(!/\bLIMIT\b/i.test(out), 'Msg 102, Level 15: Incorrect syntax near \'LIMIT\'');
    assert.match(out, /^SELECT TOP \(100\) s\.session_id/);
  });

  test('∞ (limit 0) uncaps in both dialects', () => {
    assert.equal(replaceRowCap('SELECT a FROM t LIMIT 200', 0, 'limit'), 'SELECT a FROM t');
    assert.equal(replaceRowCap('SELECT TOP 200 a FROM t', 0, 'top'), 'SELECT a FROM t');
  });

  test('a Redis command is left exactly as written', () => {
    // The panel runs these through the same path; they are not SELECTs, so
    // there is nothing to cap and nothing to append.
    for (const cmd of ['INFO memory', 'CLIENT LIST', 'SLOWLOG GET 128', 'CONFIG GET *']) {
      assert.equal(replaceRowCap(cmd, 1000, 'limit'), cmd, cmd);
    }
  });

  test('when no cap can be applied the ORIGINAL is returned, cap included', () => {
    // A top-level UNION cannot take TOP (it would bind to the first branch
    // only). Stripping the author's cap and failing to re-add it would leave
    // the view UNCAPPED — worse than ignoring the button.
    const union = 'SELECT TOP 200 a FROM x UNION ALL SELECT a FROM y';
    assert.equal(replaceRowCap(union, 100, 'top'), union);
    // Same for a view that limits itself with OFFSET … FETCH.
    const fetch = 'SELECT a FROM t ORDER BY a OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY';
    assert.equal(replaceRowCap(fetch, 100, 'top'), fetch);
  });
});
