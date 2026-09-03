/**
 * Turning staged grid edits into reviewable SQL.
 *
 * The data browser is read-only by design; this is the other half of the plan's
 * "review-only DML builder" (§6.2). The user edits cells / marks rows in the
 * grid, and those edits are collected here — never written. The output is
 * `UPDATE` / `DELETE` / `INSERT` **text**, dropped into the editor wrapped in a
 * transaction, for the user to read and run themselves. Nothing in this module
 * executes anything.
 *
 * The safety model mirrors `dataCompare`:
 *  - **Every statement is keyed.** An UPDATE or DELETE's `WHERE` is built from
 *    the primary key and nothing else, so there is no path to an unfiltered
 *    write. A table without a primary key cannot be edited (the builder throws)
 *    rather than emit a `WHERE`-less statement.
 *  - **One row per statement.** No `IN (…)` batching that could widen a mistake.
 *  - **Values are typed.** Numbers and NULLs are emitted bare/`NULL`; everything
 *    else is quoted and escaped per engine, so a stray quote can't break out.
 *
 * Pure and dependency-light — `node --test` covers it.
 */
import { quoteIdent, escapeLiteral } from './sqlIdent.ts';

export type Engine = string;

/** An edit to an existing row: its primary key, and the columns to set. */
export interface RowUpdate {
  pk: Record<string, unknown>;
  set: Record<string, unknown>;
}

export interface EditSet {
  /** Raw table reference, e.g. `db.table` or `table` — quoted here per engine. */
  table: string;
  pkColumns: string[];
  /** Column name → SQL type, so a value is quoted (or not) correctly. */
  types: Record<string, string>;
  updates: RowUpdate[];
  /** New rows to insert: column → value. */
  inserts: Record<string, unknown>[];
  /** Rows to delete, by their primary key. */
  deletes: Record<string, unknown>[];
}

function isNumericType(t: string): boolean {
  return /\b(INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|DECIMAL|NUMERIC|FIXED|FLOAT|DOUBLE|REAL|SERIAL)\b/i.test(t)
    && !/TINYINT\(1\)/i.test(t);
}
function isBoolType(t: string): boolean {
  return /\b(BOOL|BOOLEAN)\b/i.test(t) || /TINYINT\(1\)/i.test(t);
}

/** A value as a SQL literal, quoted only when it must be. */
export function literal(value: unknown, colType: string, engine: Engine): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return engine === 'postgres' ? (value ? 'TRUE' : 'FALSE') : (value ? '1' : '0');
  const s = String(value);
  if (s === '') return 'NULL';
  if (isBoolType(colType)) {
    const b = /^(1|true|t|yes|on)$/i.test(s.trim());
    return engine === 'postgres' ? (b ? 'TRUE' : 'FALSE') : (b ? '1' : '0');
  }
  if (isNumericType(colType) && /^-?\d+(\.\d+)?$/.test(s.trim())) return s.trim();
  return `'${escapeLiteral(s, engine)}'`;
}

function qtable(table: string, engine: Engine): string {
  return table.split('.').map(p => quoteIdent(p, engine)).join('.');
}

/** The keyed `WHERE`. Throws when there is no key — never a `WHERE`-less write. */
function whereClause(pk: Record<string, unknown>, pkColumns: string[], types: Record<string, string>, engine: Engine): string {
  if (!pkColumns.length) throw new Error('this table has no primary key, so a row cannot be safely identified to edit');
  return pkColumns.map(c => {
    const v = pk[c];
    return v === null || v === undefined
      ? `${quoteIdent(c, engine)} IS NULL`
      : `${quoteIdent(c, engine)} = ${literal(v, types[c] ?? '', engine)}`;
  }).join(' AND ');
}

/** UPDATE / INSERT / DELETE statements (no trailing semicolons — the caller adds them). */
export function buildEditSql(set: EditSet, engine: Engine): string[] {
  const t = qtable(set.table, engine);
  const out: string[] = [];
  for (const u of set.updates) {
    const cols = Object.keys(u.set);
    if (!cols.length) continue;
    const assigns = cols.map(c => `${quoteIdent(c, engine)} = ${literal(u.set[c], set.types[c] ?? '', engine)}`).join(', ');
    out.push(`UPDATE ${t} SET ${assigns} WHERE ${whereClause(u.pk, set.pkColumns, set.types, engine)}`);
  }
  for (const ins of set.inserts) {
    const cols = Object.keys(ins).filter(c => ins[c] !== undefined);
    if (!cols.length) continue;
    const colList = cols.map(c => quoteIdent(c, engine)).join(', ');
    const vals = cols.map(c => literal(ins[c], set.types[c] ?? '', engine)).join(', ');
    out.push(`INSERT INTO ${t} (${colList}) VALUES (${vals})`);
  }
  for (const d of set.deletes) {
    out.push(`DELETE FROM ${t} WHERE ${whereClause(d, set.pkColumns, set.types, engine)}`);
  }
  return out;
}

/** How many statements a set will produce (for the UI's "N changes" count). */
export function editCount(set: Pick<EditSet, 'updates' | 'inserts' | 'deletes'>): number {
  return set.updates.filter(u => Object.keys(u.set).length).length + set.inserts.length + set.deletes.length;
}

/**
 * Assemble the statements into an editor block, with a header that tells the
 * truth about what running them will do — which depends entirely on the
 * session's transaction mode.
 *
 * txui splits a multi-statement script and runs each statement in turn; only a
 * **pinned** connection (autocommit-off, or an open ⛁ TX) keeps them in one
 * transaction. So a `START TRANSACTION … COMMIT` wrapper is NOT added — under
 * autocommit the split runner would spread it across pooled connections and it
 * would not be atomic, and when a transaction is already held a nested
 * `START TRANSACTION` would implicitly commit it. Instead:
 *
 *  - **`txHeld` (autocommit off / ⛁ TX open):** the statements run inside the
 *    session's open transaction — Commit/Rollback decide their fate.
 *  - **autocommit on:** each statement commits the instant it runs; the header
 *    says so and points at ⛁ TX for a review-before-commit workflow.
 */
export function assembleEditSql(statements: string[], txHeld: boolean): string {
  if (!statements.length) return '';
  const body = statements.map(s => `${s};`).join('\n');
  const header = txHeld
    ? ['-- ⛁ A transaction is open on this session — these run inside it.',
       '-- Nothing is final until you Commit; Rollback discards them.']
    : ['-- ⚠ Autocommit is ON: each statement below commits the moment it runs.',
       '-- To review before committing, turn on ⛁ TX (transaction mode) first,',
       '-- then run these and Commit or Rollback.'];
  return [...header, body].join('\n');
}

/** A blank INSERT skeleton for a new row — placeholders the user fills in. */
export function insertTemplate(table: string, columns: { name: string; type: string }[], engine: Engine): string {
  const t = qtable(table, engine);
  const cols = columns.map(c => quoteIdent(c.name, engine)).join(', ');
  const vals = columns.map(c => `/* ${c.type} */ NULL`).join(', ');
  return `INSERT INTO ${t} (${cols})\nVALUES (${vals});`;
}

/**
 * A skeleton UPDATE: SET every non-key column, keyed by the primary key in the
 * WHERE (so it can't accidentally touch the whole table). Falls back to all
 * columns / the first column when no PK is known. Inserted for the user to
 * fill in — never run.
 */
export function updateTemplate(
  table: string,
  columns: { name: string; type: string }[],
  pkColumns: string[],
  engine: Engine,
): string {
  const t = qtable(table, engine);
  const pk = new Set(pkColumns);
  const setCols = columns.filter(c => !pk.has(c.name));
  const sets = (setCols.length ? setCols : columns)
    .map(c => `${quoteIdent(c.name, engine)} = /* ${c.type} */ NULL`)
    .join(',\n  ');
  const keyCols = pkColumns.length ? pkColumns : columns.slice(0, 1).map(c => c.name);
  const where = keyCols.map(c => `${quoteIdent(c, engine)} = NULL`).join(' AND ') || '/* condition */';
  return `UPDATE ${t} SET\n  ${sets}\nWHERE ${where};`;
}
