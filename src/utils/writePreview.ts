/**
 * Blast radius — "how many rows will this actually touch?"
 *
 * `isUnfilteredWrite` already catches the WHERE-less UPDATE/DELETE. The
 * dangerous case is the *filtered* one: a predicate you believe matches three
 * rows and actually matches three hundred thousand. This turns the statement
 * into the equivalent COUNT so the confirmation can state the number instead of
 * asking you to trust yourself.
 *
 * Pure and conservative: when the shape is anything it does not fully
 * understand (multi-table UPDATE, a CTE, RETURNING, …) it returns null and the
 * caller simply does not offer a count. A wrong number would be worse than none.
 */
import { blank } from './sqlAlias.ts';

/**
 * A table reference, quoted or not. Written out rather than using a character
 * class because `blank()` replaces the CONTENT of a quoted identifier with
 * spaces (preserving length), so `` `order` `` arrives as `` ` ` `` — a class
 * like ``[`"\w.]+`` would stop at the first space and capture just the quote.
 */
const IDENT = String.raw`(?:\`[^\`]*\`|"[^"]*"|[\w$]+)`;
const TABLE_REF = String.raw`(${IDENT}(?:\.${IDENT})*)`;

export interface CountPlan {
  /** SELECT COUNT(*) … equivalent to the write's row set */
  sql: string;
  /** the table the write targets, for display */
  table: string;
  /** what the write does, for wording */
  kind: 'update' | 'delete';
  /** true when the statement has no WHERE at all (every row) */
  wholeTable: boolean;
}

/**
 * Build the COUNT equivalent of a single UPDATE/DELETE statement, or null when
 * the statement is not one, or is too complex to translate safely.
 */
export function countPlanFor(sql: string): CountPlan | null {
  const b = blank(sql);                       // offsets preserved, literals blanked
  const lower = b.toLowerCase();

  // one statement only (the caller splits scripts)
  if (/;\s*\S/.test(b.trim())) return null;
  // anything with a CTE, a RETURNING clause or a sub-statement: not our business
  if (/^\s*with\b/i.test(b)) return null;
  if (/\breturning\b/i.test(lower)) return null;

  const del = new RegExp(
    String.raw`^\s*delete\s+(?:quick\s+|low_priority\s+|ignore\s+)*from\s+` + TABLE_REF, 'i').exec(b);
  if (del) {
    // `blank()` blanks the CONTENTS of quoted identifiers (same length), so the
    // name is read from the original text at the matched offset.
    const table = sliceAt(sql, del, 1);
    // multi-table DELETE (`DELETE a FROM a JOIN b`) or USING: too complex
    if (/\bdelete\b[\s\S]*?\bfrom\b[\s\S]*?\b(join|using)\b/i.test(lower)) return null;
    const where = whereClause(sql, b);
    return {
      sql: `SELECT COUNT(*) FROM ${table}${where ? ` WHERE ${where}` : ''}`,
      table, kind: 'delete', wholeTable: !where,
    };
  }

  const upd = new RegExp(
    String.raw`^\s*update\s+(?:low_priority\s+|ignore\s+)*` + TABLE_REF, 'i').exec(b);
  if (upd) {
    const table = sliceAt(sql, upd, 1);
    const afterTable = lower.slice((upd.index ?? 0) + upd[0].length);
    // a JOIN/comma-joined multi-table UPDATE cannot be counted this simply
    if (/^\s*(,|\bjoin\b|\bleft\b|\bright\b|\binner\b|\bstraight_join\b)/.test(afterTable)) return null;
    const where = whereClause(sql, b);
    return {
      sql: `SELECT COUNT(*) FROM ${table}${where ? ` WHERE ${where}` : ''}`,
      table, kind: 'update', wholeTable: !where,
    };
  }
  return null;
}

/** Text of a trailing capture group, taken from the ORIGINAL (unblanked) sql. */
function sliceAt(sql: string, m: RegExpExecArray, group: number): string {
  const g = m[group];
  const off = m.index + m[0].length - g.length;
  return sql.slice(off, off + g.length);
}

/**
 * The WHERE clause text (from the ORIGINAL sql, so literals survive), stopping
 * before ORDER BY / LIMIT, which change the row set for MySQL's single-table
 * form and must therefore NOT be dropped silently — their presence makes the
 * count an upper bound, so we keep them out and flag it via `limited`.
 */
function whereClause(sql: string, blanked: string): string | null {
  const m = /\bwhere\b/i.exec(blanked);
  if (!m) return null;
  const start = m.index + m[0].length;
  const tail = blanked.slice(start);
  const stop = /\b(order\s+by|limit)\b/i.exec(tail);
  const end = stop ? start + stop.index : blanked.length;
  const text = sql.slice(start, end).trim();
  return text.replace(/;\s*$/, '') || null;
}

/** Does the statement cap its own row count (MySQL `UPDATE … LIMIT n`)? */
export function hasRowLimit(sql: string): boolean {
  return /\blimit\b/i.test(blank(sql));
}

/** Human wording for the confirmation. */
export function describeBlastRadius(plan: CountPlan, rows: number | null): string {
  if (rows === null) return `${plan.kind.toUpperCase()} on ${plan.table} — row count unavailable.`;
  if (rows === 0) return `Matches no rows — this ${plan.kind.toUpperCase()} would change nothing.`;
  const n = rows.toLocaleString();
  return plan.wholeTable
    ? `Affects EVERY row of ${plan.table}: ${n}.`
    : `Affects ${n} row${rows === 1 ? '' : 's'} of ${plan.table}.`;
}
