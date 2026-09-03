/**
 * Comparing the *contents* of two tables, and generating the SQL to reconcile
 * them.
 *
 * Schema compare already exists. This is the other half — "staging and prod
 * disagree about this lookup table" — and it is the more dangerous half by a
 * wide margin, because the output is `INSERT`, `UPDATE` and `DELETE` against a
 * live table rather than a structural change somebody will read carefully.
 *
 * The safety model, in order of importance:
 *
 * 1. **One direction, named explicitly.** There is a source and a target, and
 *    only the target is ever written. A "sync" that decides per row which side
 *    wins is a coin flip with production.
 * 2. **Deletes are opt-in and separate.** A row missing from the source is far
 *    more often an incomplete extract than a row that should be deleted, so
 *    `DELETE` generation is off unless asked for.
 * 3. **Every statement is keyed.** No generated statement can touch more than
 *    the row it names — a `WHERE` is built from the key columns and nothing
 *    else, so there is no path to an unfiltered `UPDATE`.
 * 4. **Comparison is bounded.** Both sides are read into memory; past a cap it
 *    refuses rather than pretending.
 *
 * Pure and dependency-free, so `node --test` covers it.
 */
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';

export type Engine = 'mysql' | 'postgres' | 'sqlserver';

/** A row as the grid delivers it: values positional against `columns`. */
export type Row = unknown[];

export interface CompareInput {
  columns: string[];
  /** Columns forming the identity. Must be non-empty. */
  keyColumns: string[];
  sourceRows: Row[];
  targetRows: Row[];
}

export interface RowDiff {
  key: string[];
  /** Columns whose values differ. Empty for inserts and deletes. */
  changed: string[];
  source?: Row;
  target?: Row;
}

export interface CompareResult {
  onlyInSource: RowDiff[];
  onlyInTarget: RowDiff[];
  different: RowDiff[];
  same: number;
  /** Keys appearing more than once on a side — the comparison cannot be trusted. */
  duplicateKeys: string[];
}

/** Cap on either side. Both are held in memory to be diffed. */
export const MAX_COMPARE_ROWS = 200_000;

/**
 * Normalise a value for comparison.
 *
 * The engines disagree about representation in ways that are not real
 * differences: a `DECIMAL` may arrive as `"10.50"` from one driver and
 * `"10.5"` from another, and a `TINYINT(1)` as `1` or `true`. Comparing raw
 * would report every row as different, which is worse than useless — it is a
 * reconciliation script that rewrites the whole table.
 */
export function normalise(v: unknown): string {
  if (v === null || v === undefined) return '\u0000NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return trimNumber(String(v));
  const s = String(v);
  // Numeric-looking strings compare as numbers, so 10.50 === 10.5.
  if (/^-?\d+(\.\d+)?$/.test(s)) return trimNumber(s);
  return s;
}

function trimNumber(s: string): string {
  if (!s.includes('.')) return s;
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '-0' || t === '' ? '0' : t;
}

/**
 * The key of a row, as a comparable string.
 *
 * Parts are joined with U+001F (unit separator), not with an empty string or
 * a comma: joining `('a','bc')` and `('ab','c')` on nothing makes both `abc`,
 * so two different rows would be treated as one and an UPDATE would hit the
 * wrong record. A comma has the same flaw whenever a value contains one.
 * U+001F is written as an escape rather than a literal byte, so the file
 * stays plain text — a raw control character makes grep treat it as binary.
 */
const KEY_SEP = '\u001F';
function keyOf(row: Row, keyIdx: number[]): string {
  return keyIdx.map(i => normalise(row[i])).join(KEY_SEP);
}

/**
 * Compare two row sets by key.
 *
 * Duplicate keys are collected rather than silently resolved: if a key appears
 * twice, "the row with this key" is not a thing, and any reconciliation built
 * on that assumption would update the wrong one.
 */
export function compareRows(input: CompareInput): CompareResult {
  const { columns, keyColumns, sourceRows, targetRows } = input;
  if (!keyColumns.length) throw new Error('a comparison needs at least one key column');
  const keyIdx = keyColumns.map(k => {
    const i = columns.indexOf(k);
    if (i < 0) throw new Error(`key column ${k} is not in the result`);
    return i;
  });
  const valueIdx = columns.map((_, i) => i).filter(i => !keyIdx.includes(i));

  const dupes = new Set<string>();
  const index = (rows: Row[]) => {
    const m = new Map<string, Row>();
    for (const r of rows) {
      const k = keyOf(r, keyIdx);
      if (m.has(k)) dupes.add(k);
      else m.set(k, r);
    }
    return m;
  };
  const src = index(sourceRows);
  const tgt = index(targetRows);

  const onlyInSource: RowDiff[] = [];
  const onlyInTarget: RowDiff[] = [];
  const different: RowDiff[] = [];
  let same = 0;

  for (const [k, s] of src) {
    const t = tgt.get(k);
    const key = keyIdx.map(i => String(s[i] ?? ''));
    if (!t) { onlyInSource.push({ key, changed: [], source: s }); continue; }
    const changed = valueIdx
      .filter(i => normalise(s[i]) !== normalise(t[i]))
      .map(i => columns[i]);
    if (changed.length) different.push({ key, changed, source: s, target: t });
    else same++;
  }
  for (const [k, t] of tgt) {
    if (src.has(k)) continue;
    onlyInTarget.push({ key: keyIdx.map(i => String(t[i] ?? '')), changed: [], target: t });
  }

  return { onlyInSource, onlyInTarget, different, same, duplicateKeys: [...dupes] };
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export interface ReconcileOptions {
  schema: string;
  table: string;
  columns: string[];
  keyColumns: string[];
  engine: Engine;
  /** Insert rows the target lacks. */
  insert: boolean;
  /** Update rows whose values differ. */
  update: boolean;
  /**
   * Delete rows the source lacks.
   *
   * Off by default everywhere it is offered. A row missing from the source is
   * far more often an incomplete extract — a `LIMIT`, a `WHERE`, a failed page
   * — than a row that should cease to exist.
   */
  delete: boolean;
}

function literal(v: unknown, engine: Engine): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  // **T-SQL has no boolean literals.** `bit` takes 1 and 0, and `SET flag =
  // TRUE` is a syntax error — which in a reconciliation script means the whole
  // batch fails, after the rows before it have already been written.
  if (typeof v === 'boolean') {
    return engine === 'sqlserver' ? (v ? '1' : '0') : (v ? 'TRUE' : 'FALSE');
  }
  return sqlLiteral(String(v), engine);
}

/**
 * The statements that would make the target match the source.
 *
 * Order is deliberate: inserts, then updates, then deletes. A delete that runs
 * before an insert leaves a window where a row exists on neither side, and if
 * the script is interrupted it stays that way.
 */
export function reconcileSql(diff: CompareResult, o: ReconcileOptions): string[] {
  const q = (s: string) => quoteIdent(s, o.engine);
  const target = `${q(o.schema)}.${q(o.table)}`;
  // Map lookup, not indexOf per column per row — at the 200k-row cap the
  // indexOf version was O(rows × cols²) string comparisons.
  const colIdx = new Map(o.columns.map((c, i) => [c, i]));
  const idx = (c: string) => colIdx.get(c) ?? -1;
  // The WHERE is built only from key columns, so no generated statement can
  // reach a row it does not name.
  const whereFor = (row: Row) =>
    o.keyColumns.map(k => `${q(k)} = ${literal(row[idx(k)], o.engine)}`).join(' AND ');

  const out: string[] = [];

  if (o.insert) {
    for (const d of diff.onlyInSource) {
      const row = d.source!;
      out.push(`INSERT INTO ${target} (${o.columns.map(q).join(', ')}) VALUES (`
        + `${o.columns.map(c => literal(row[idx(c)], o.engine)).join(', ')});`);
    }
  }
  if (o.update) {
    for (const d of diff.different) {
      const row = d.source!;
      const sets = d.changed.map(c => `${q(c)} = ${literal(row[idx(c)], o.engine)}`).join(', ');
      out.push(`UPDATE ${target} SET ${sets} WHERE ${whereFor(row)};`);
    }
  }
  if (o.delete) {
    for (const d of diff.onlyInTarget) {
      out.push(`DELETE FROM ${target} WHERE ${whereFor(d.target!)};`);
    }
  }
  return out;
}

export interface ReconcileSummary {
  inserts: number;
  updates: number;
  deletes: number;
  total: number;
  /** The sentence on the confirm button. Null when nothing would run. */
  headline: string | null;
  /** Reasons the comparison itself should not be trusted. */
  blockers: string[];
}

export function summariseReconcile(
  diff: CompareResult, o: ReconcileOptions,
): ReconcileSummary {
  const inserts = o.insert ? diff.onlyInSource.length : 0;
  const updates = o.update ? diff.different.length : 0;
  const deletes = o.delete ? diff.onlyInTarget.length : 0;
  const total = inserts + updates + deletes;

  const blockers: string[] = [];
  if (diff.duplicateKeys.length) {
    blockers.push(
      `${diff.duplicateKeys.length} duplicate key${diff.duplicateKeys.length === 1 ? '' : 's'} — `
      + 'with a repeated key there is no single "the row with this key", so a generated '
      + 'UPDATE would change an arbitrary one. Choose key columns that are actually unique.');
  }
  if (!o.keyColumns.length) blockers.push('No key columns chosen.');

  let headline: string | null = null;
  if (total > 0) {
    const bits = [
      inserts && `${inserts} insert${inserts === 1 ? '' : 's'}`,
      updates && `${updates} update${updates === 1 ? '' : 's'}`,
      deletes && `${deletes} delete${deletes === 1 ? '' : 's'}`,
    ].filter(Boolean);
    headline = `${bits.join(', ')} against ${o.schema}.${o.table}`;
  }
  return { inserts, updates, deletes, total, headline, blockers };
}

/**
 * A bounded `SELECT` for one side of the comparison.
 *
 * Ordered by the key so two large reads line up, and capped one past the limit
 * so the caller can tell "exactly at the cap" from "more than the cap" instead
 * of silently comparing a truncated set.
 */
export function fetchSql(
  schema: string, table: string, columns: string[], keyColumns: string[],
  limit: number, engine: Engine,
): string {
  const q = (s: string) => quoteIdent(s, engine);
  const n = Math.floor(limit) + 1;
  // T-SQL caps with TOP at the front. The ORDER BY still applies — TOP without
  // one is nondeterministic, and comparing two nondeterministic samples would
  // report differences that are only row order.
  const head = engine === 'sqlserver' ? `SELECT TOP (${n}) ` : 'SELECT ';
  const tail = engine === 'sqlserver' ? '' : ` LIMIT ${n}`;
  return `${head}${columns.map(q).join(', ')} FROM ${q(schema)}.${q(table)}`
    + ` ORDER BY ${keyColumns.map(q).join(', ')}${tail}`;
}
