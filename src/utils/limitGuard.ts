/**
 * Default row-limit guard: a SELECT without its own top-level row cap gets one
 * added, so `SELECT * FROM huge_table` can never stream the whole table by
 * accident. limit = 0 disables the guard.
 *
 * ## Two dialects, because one of them has no LIMIT
 *
 * MySQL, PostgreSQL, SQLite, DuckDB and ClickHouse all take a trailing
 * `LIMIT n`. **T-SQL does not** — SQL Server spells it `SELECT TOP (n)`, at the
 * front, and appending LIMIT there is a syntax error rather than a smaller
 * result. That is not a theoretical difference: the guard ran for every engine
 * with `sql`, so from the day SQL Server shipped, **every unbounded SELECT in
 * the editor came back as "Incorrect syntax near 'LIMIT'"** — including every
 * DBA view, which are review-only and run through the editor.
 *
 * `TOP` is also positional, which makes it the harder of the two to insert: it
 * belongs after the OUTER `SELECT` (past any CTEs) and after `DISTINCT`, not at
 * the end where LIMIT goes.
 */
import { blank } from './sqlAlias.ts';
import { isWriteStatement } from './sqlGuard.ts';

/** Which row-cap syntax this engine speaks. */
export type LimitDialect = 'limit' | 'top';

/** T-SQL is the only `top` dialect; everything else that has SQL takes LIMIT. */
export function limitDialect(engine: string): LimitDialect {
  return engine === 'sqlserver' ? 'top' : 'limit';
}

export function applyDefaultLimit(
  sql: string,
  limit: number,
  dialect: LimitDialect = 'limit',
): { sql: string; applied: boolean } {
  if (limit <= 0) return { sql, applied: false };
  const b = blank(sql);

  // only SELECT / WITH … SELECT / TABLE / VALUES produce unbounded row sets
  const first = /[A-Za-z]+/.exec(b)?.[0].toLowerCase() ?? '';
  if (!['select', 'with', 'table', 'values'].includes(first)) {
    return { sql, applied: false };
  }
  // A `WITH` that actually writes (data-modifying CTE / `WITH … INSERT`) must
  // not get a LIMIT tacked on — that would change how many rows it writes.
  if (first === 'with' && isWriteStatement(sql)) {
    return { sql, applied: false };
  }
  // SELECT … INTO OUTFILE/DUMPFILE — leave alone
  if (/\binto\s+(outfile|dumpfile)\b/i.test(b)) return { sql, applied: false };

  if (dialect === 'top') return applyTop(sql, b, limit);

  // existing top-level LIMIT (outside parens)?
  let depth = 0;
  const re = /[()]|\blimit\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(b)) !== null) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') depth--;
    else if (depth === 0) return { sql, applied: false }; // has own LIMIT
  }

  // insert before a trailing locking clause, else append
  const trimmed = sql.replace(/;\s*$/, '');
  const lock = /\b(for\s+update(\s+(nowait|skip\s+locked))?|for\s+share|lock\s+in\s+share\s+mode)\s*$/i.exec(trimmed);
  // Newline before LIMIT so a trailing `-- comment` / `#` line comment can't
  // swallow it (which would silently defeat the guard).
  if (lock) {
    return {
      sql: `${trimmed.slice(0, lock.index).trimEnd()}\nLIMIT ${limit}\n${trimmed.slice(lock.index)}`,
      applied: true,
    };
  }
  return { sql: `${trimmed}\nLIMIT ${limit}`, applied: true };
}

/**
 * `SELECT TOP (n)` for T-SQL.
 *
 * `b` is the blanked copy — string bodies and comments replaced by spaces of
 * the SAME length — so an offset found there indexes the original text exactly.
 * That is what makes it safe to look for keywords without matching one inside a
 * string literal, then splice the real SQL.
 */
function applyTop(sql: string, b: string, limit: number): { sql: string; applied: boolean } {
  // `TABLE t` / `VALUES (…)` are not T-SQL, and a query with no depth-0 SELECT
  // has nothing to cap.
  const at = topInsertPoint(b);
  if (at < 0) return { sql, applied: false };
  let m: RegExpExecArray | null;

  // Already bounded by OFFSET … FETCH at the top level? That is T-SQL's other
  // limiter, and adding TOP as well would silently change the answer.
  let d2 = 0;
  const off = /[()]|\boffset\b/gi;
  while ((m = off.exec(b)) !== null) {
    if (m[0] === '(') d2++;
    else if (m[0] === ')') d2--;
    else if (d2 === 0) return { sql, applied: false };
  }

  // ── a top-level UNION / EXCEPT / INTERSECT cannot be capped at all ──
  //
  // This is where T-SQL and the LIMIT dialects genuinely part company. A
  // trailing `LIMIT n` after a union applies to the WHOLE union; `TOP (n)`
  // binds to the **first SELECT only**. So capping a union by prefixing TOP
  // does not merely fail to cap it — it silently returns a DIFFERENT RESULT:
  // n rows of the first branch and every row of the rest. Measured on SQL
  // Server 2022, `SELECT TOP (7) id FROM orders UNION ALL SELECT id FROM
  // customers` returned 2007 rows, having dropped 33,327 rows from the first
  // branch while keeping all 2,000 of the second.
  //
  // There is no safe rewrite. The alternatives were tried against the server
  // and each fails on legal SQL:
  //   · `ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT n ROWS ONLY`
  //     → Msg 104, "ORDER BY items must appear in the select list if the
  //       statement contains a UNION, INTERSECT or EXCEPT operator".
  //   · wrapping as `SELECT TOP (n) * FROM (…) x`
  //     → Msg 8155 on an unnamed expression column, Msg 8156 on a duplicated
  //       column name — both ordinary in ad-hoc SQL.
  //
  // So the honest answer is to leave the statement alone and report that no
  // cap was applied. The row ceiling still holds: the backend fetches at most
  // `max_rows` and flags the result truncated, so an uncapped union costs the
  // server more work but cannot flood the grid. A wrong answer would have
  // been much more expensive than a slow one.
  let d3 = 0;
  const setOp = /[()]|\b(union|except|intersect)\b/gi;
  while ((m = setOp.exec(b)) !== null) {
    if (m[0] === '(') d3++;
    else if (m[0] === ')') d3--;
    else if (d3 === 0) return { sql, applied: false };
  }

  // The user's own TOP wins — including `TOP 5 PERCENT` and `WITH TIES`.
  if (/^top\b/i.test(b.slice(at))) return { sql, applied: false };

  return { sql: `${sql.slice(0, at)}TOP (${limit}) ${sql.slice(at)}`, applied: true };
}

/**
 * Where `TOP (n)` belongs in a T-SQL statement, as an offset into the ORIGINAL
 * text: after the OUTER `SELECT` — the first one at paren depth 0, so a
 * parenthesised CTE body is skipped, which is the whole reason for scanning
 * rather than taking the first match — and after any `DISTINCT` / `ALL`,
 * because `SELECT TOP (5) DISTINCT` is a syntax error while
 * `SELECT DISTINCT TOP (5)` is correct.
 *
 * `b` is the blanked copy. -1 when there is no depth-0 SELECT: `TABLE t`,
 * `VALUES (…)`, or something that is not SQL at all.
 */
function topInsertPoint(b: string): number {
  let depth = 0;
  let outer = -1;
  const tok = /[()]|\bselect\b/gi;
  let m: RegExpExecArray | null;
  while ((m = tok.exec(b)) !== null) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') depth--;
    else if (depth === 0) { outer = m.index; break; }
  }
  if (outer < 0) return -1;
  const lead = /^\s*(distinct|all)?\s*/i.exec(b.slice(outer + 'select'.length))?.[0] ?? ' ';
  return outer + 'select'.length + lead.length;
}

/**
 * Remove a row cap the statement already carries — a trailing `LIMIT n`, or a
 * plain `TOP n` / `TOP (n)` on the outer SELECT. Only the shapes this module
 * would itself have written are removed.
 *
 * `TOP n PERCENT` and `WITH TIES` are deliberately left in place: a percentage
 * is not interchangeable with a row count, and `WITH TIES` is bound to the
 * query's ORDER BY. Both then read as "the user's own TOP" to applyDefaultLimit,
 * which leaves such a statement alone.
 */
export function stripRowCap(sql: string, dialect: LimitDialect = 'limit'): string {
  if (dialect === 'limit') return sql.replace(/\s+limit\s+\d+\s*$/i, '').trimEnd();

  const b = blank(sql);
  const at = topInsertPoint(b);
  if (at < 0) return sql;
  // Matched on the blanked copy so a `TOP` inside a string body cannot be hit,
  // then spliced out of the original at the same offsets.
  const cap = /^top\s*(?:\(\s*\d+\s*\)|\d+)\s*/i.exec(b.slice(at));
  if (!cap) return sql;
  if (/^(?:percent\b|with\s+ties\b)/i.test(b.slice(at + cap[0].length))) return sql;
  return sql.slice(0, at) + sql.slice(at + cap[0].length);
}

/**
 * REPLACE whatever cap a statement carries with `limit` rows (0 = uncap it).
 *
 * This is the primitive for a caller that owns the row count rather than
 * merely defending against an unbounded one: the DBA Views panel's Limit
 * buttons, over curated SQL that ships with its own `LIMIT 200` / `TOP 200`.
 * Strip-then-apply through this function rather than by hand, because "apply"
 * is the part that is dialect-specific and refuses in cases hand-written
 * string concatenation gets wrong — T-SQL's positional TOP, a top-level UNION
 * that TOP would answer differently, an OFFSET … FETCH already present, or a
 * statement that is not SQL at all (Redis speaks commands, not SELECTs).
 *
 * When no cap can be applied the ORIGINAL is handed back, cap included: the
 * author's own cap is a better answer than silently having none.
 */
export function replaceRowCap(sql: string, limit: number, dialect: LimitDialect = 'limit'): string {
  const base = stripRowCap(sql, dialect);
  if (limit <= 0) return base;
  const r = applyDefaultLimit(base, limit, dialect);
  return r.applied ? r.sql : sql;
}
