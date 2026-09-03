/**
 * SQLite dialect for the table designer.
 *
 * SQLite's ALTER TABLE is deliberately tiny: rename the table, rename a
 * column, add a column, and (since 3.35 — TxUI bundles 3.51.3) drop a column.
 * There is no ALTER COLUMN of any kind — changing a type, a default,
 * nullability, a generated expression, the primary key, a foreign key, or the
 * STRICT/WITHOUT ROWID options means building a new table and copying the
 * rows, the "12-step" procedure from the SQLite manual. This module emits that
 * rebuild as one explicit, labelled script — never as a silent stand-in for an
 * ALTER that does not exist.
 *
 * The rebuild script follows the manual's safe pattern: foreign keys off, new
 * table under a scratch name, copy, drop the original, rename into place,
 * recreate indexes, foreign keys back on. It runs as one multi-statement
 * string so the whole thing happens on a single pooled connection — the
 * PRAGMA would otherwise be set on one connection and the DROP executed on
 * another. `sqlguard` still sees the DROP/ALTER/RENAME words, so read-only
 * and prod guards apply to the script as a whole.
 *
 * The change-set model and the risk vocabulary are shared with the other
 * dialects (`tableDesign.ts`); only the spelling and the limits live here.
 *
 * Pure and dependency-free, so `node --test` covers it.
 */
import { quoteIdent } from './sqlIdent.ts';
import { parseType, type ColumnDraft, type SchemaChange, type TableDraft } from './tableDesign.ts';

/** The only type names a STRICT table accepts (case-insensitive). */
export const SQLITE_STRICT_TYPES: readonly string[] = ['INT', 'INTEGER', 'REAL', 'TEXT', 'BLOB', 'ANY'];

/** Scratch name the rebuild creates before swapping it into place. */
const rebuildName = (name: string) => `__txui_rebuild_${name}`;

// ── Rendering ────────────────────────────────────────────────────────────────

/** One column definition, SQLite spelling. */
export function sqliteColumnClause(c: ColumnDraft): string {
  const parts = [quoteIdent(c.name, 'sqlite'), c.type.trim()].filter(Boolean);
  if (c.generated && c.generated.trim()) {
    // Both kinds exist in SQLite; VIRTUAL is the default when neither is said.
    parts.push(`GENERATED ALWAYS AS (${c.generated}) ${c.generatedStored ? 'STORED' : 'VIRTUAL'}`);
    if (!c.nullable) parts.push('NOT NULL');
    return parts.join(' ');
  }
  if (!c.nullable) parts.push('NOT NULL');
  if (c.default !== null && c.default !== undefined && c.default !== '') {
    parts.push(`DEFAULT ${c.default}`);
  }
  return parts.join(' ');
}

/**
 * Why this draft cannot become a CREATE TABLE, in plain language. Empty when
 * it can — checked separately from rendering so the designer refuses before
 * showing SQL the server would reject.
 */
export function sqliteCreateProblems(draft: TableDraft): string[] {
  const problems: string[] = [];
  if (draft.withoutRowid && draft.primaryKey.length === 0) {
    problems.push('A WITHOUT ROWID table stores rows by its primary key — it must have one.');
  }
  if (draft.strict) {
    for (const c of draft.columns) {
      const base = parseType(c.type).base.toUpperCase();
      if (!SQLITE_STRICT_TYPES.includes(base)) {
        problems.push(`STRICT tables accept only ${SQLITE_STRICT_TYPES.join('/')} — `
          + `${c.name || '?'} is declared ${c.type || '(no type)'}.`);
      }
    }
  }
  return problems;
}

export function sqliteCreateTableSql(draft: TableDraft, schema: string): string {
  const q = (s: string) => quoteIdent(s, 'sqlite');
  const lines = draft.columns.map(c => `  ${sqliteColumnClause(c)}`);
  if (draft.primaryKey.length) {
    lines.push(`  PRIMARY KEY (${draft.primaryKey.map(q).join(', ')})`);
  }
  for (const f of draft.foreignKeys) {
    lines.push(`  CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')})`
      + ` REFERENCES ${q(f.refTable)} (${f.refColumns.map(q).join(', ')})`
      + (f.onDelete ? ` ON DELETE ${f.onDelete}` : '')
      + (f.onUpdate ? ` ON UPDATE ${f.onUpdate}` : ''));
  }
  const options = [draft.strict ? 'STRICT' : '', draft.withoutRowid ? 'WITHOUT ROWID' : '']
    .filter(Boolean).join(', ');
  return `CREATE TABLE ${q(schema)}.${q(draft.name)} (\n${lines.join(',\n')}\n)`
    + (options ? ` ${options}` : '');
}

// ── Reading a table's CREATE SQL back ────────────────────────────────────────

export interface SqliteTableSqlInfo {
  /** Generated-column expressions by column name — only in sqlite_master.sql. */
  generated: Record<string, { expr: string; stored: boolean }>;
  strict: boolean;
  withoutRowid: boolean;
}

/**
 * Best-effort parse of the `sql` column of `sqlite_master` — the one place
 * that records generated-column expressions and the STRICT / WITHOUT ROWID
 * options (`pragma_table_xinfo` says a column IS generated but not how).
 *
 * This is not a general SQL parser and does not try to be: it walks the
 * top-level comma split of the column list with balanced parens and reads the
 * `AS (…)` of each generated column. Anything it cannot read simply yields no
 * entry, which is the safe direction — the designer then treats the column as
 * ordinary and a rebuild triggered by something else would refuse rather than
 * guess (see `sqliteDiffTable`).
 */
export function sqliteParseTableSql(sql: string): SqliteTableSqlInfo {
  const info: SqliteTableSqlInfo = { generated: {}, strict: false, withoutRowid: false };
  const open = sql.indexOf('(');
  if (open < 0) return info;
  // Balanced scan for the body between the first '(' and its match.
  let depth = 0, end = -1;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
    else if ((ch === '\'' || ch === '"' || ch === '`') && depth >= 1) {
      // Skip a quoted run so parens inside strings/identifiers do not count.
      let j = i + 1;
      while (j < sql.length && sql[j] !== ch) j++;
      i = j;
    }
  }
  if (end < 0) return info;
  const body = sql.slice(open + 1, end);
  const tail = sql.slice(end + 1);
  info.strict = /\bSTRICT\b/i.test(tail);
  info.withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(tail);

  // Split the body on top-level commas (strings and nested parens protected).
  const parts: string[] = [];
  let cur = '', d = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < body.length && body[j] !== ch) j++;
      cur += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  const unquote = (s: string) =>
    s.replace(/^["`[]/, '').replace(/["`\]]$/, '').replace(/""/g, '"');
  for (const part of parts) {
    const seg = part.trim();
    // Table-level constraints are not column definitions.
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(seg)) continue;
    const nameM = /^("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)\s*/.exec(seg);
    if (!nameM) continue;
    const asM = /\bAS\s*\(/i.exec(seg);
    if (!asM) continue;
    // The expression is the balanced parenthesised run starting at AS (.
    const exprStart = asM.index + asM[0].length;
    let pd = 1, exprEnd = -1;
    for (let i = exprStart; i < seg.length; i++) {
      if (seg[i] === '(') pd++;
      else if (seg[i] === ')') { pd--; if (pd === 0) { exprEnd = i; break; } }
    }
    if (exprEnd < 0) continue;
    const rest = seg.slice(exprEnd + 1);
    info.generated[unquote(nameM[1])] = {
      expr: seg.slice(exprStart, exprEnd).trim(),
      stored: /\bSTORED\b/i.test(rest),
    };
  }
  return info;
}

/**
 * `CREATE [UNIQUE] INDEX "schema"."ix" ON "table" (…)`.
 *
 * The index name is schema-qualified but the table name is deliberately NOT:
 * SQLite's grammar takes `[schema.]index ON table` — qualifying the table is
 * a syntax error (caught by executing the generated script, not by reading
 * it).
 */
export function sqliteCreateIndexSql(
  schema: string, table: string, i: TableDraft['indexes'][number],
): string {
  const q = (s: string) => quoteIdent(s, 'sqlite');
  return `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(schema)}.${q(i.name)} `
    + `ON ${q(table)} (${i.columns.map(q).join(', ')})`;
}

// ── The rebuild ──────────────────────────────────────────────────────────────

/** A stable serialization for "did this set change" comparisons. */
const fkKey = (f: TableDraft['foreignKeys'][number]) =>
  [f.name, f.columns.join(','), f.refTable, f.refColumns.join(','), f.onDelete ?? '', f.onUpdate ?? '']
    .join('|');

/**
 * The 12-step rebuild as one multi-statement script.
 *
 * `INSERT` copies only the columns that exist on both sides — a genuinely new
 * column is left out and picks up its DEFAULT. Column identity follows
 * `originalName`, so a rename folded into the rebuild still maps the data.
 */
export function sqliteRebuildScript(current: TableDraft, draft: TableDraft, schema: string): string {
  const q = (s: string) => quoteIdent(s, 'sqlite');
  const oldRef = `${q(schema)}.${q(current.name)}`;
  const newRef = `${q(schema)}.${q(rebuildName(current.name))}`;
  const currentNames = new Set(current.columns.map(c => c.name));

  const copyPairs: { to: string; from: string }[] = [];
  for (const c of draft.columns) {
    const from = c.originalName && currentNames.has(c.originalName)
      ? c.originalName
      : currentNames.has(c.name) ? c.name : null;
    if (from) copyPairs.push({ to: c.name, from });
  }
  const createSql = sqliteCreateTableSql(
    { ...draft, name: rebuildName(current.name), originalName: undefined }, schema);
  const statements = [
    'PRAGMA foreign_keys=OFF',
    createSql,
    `INSERT INTO ${newRef} (${copyPairs.map(p => q(p.to)).join(', ')})\n`
      + `  SELECT ${copyPairs.map(p => q(p.from)).join(', ')} FROM ${oldRef}`,
    `DROP TABLE ${oldRef}`,
    // RENAME TO takes the bare new name — a schema-qualified target is a
    // syntax error in SQLite.
    `ALTER TABLE ${newRef} RENAME TO ${q(draft.name)}`,
    // DROP TABLE took the old indexes with it; the draft's are recreated here.
    ...draft.indexes.map(i => sqliteCreateIndexSql(schema, draft.name, i)),
    'PRAGMA foreign_keys=ON',
  ];
  return statements.join(';\n');
}

// ── The diff ─────────────────────────────────────────────────────────────────

/**
 * Every change needed to turn `current` into `draft` on SQLite.
 *
 * Incremental when the edits stay inside what ALTER TABLE can do (rename
 * table/column, add column, drop column, index create/drop). One labelled
 * `rebuild-table` change — the full 12-step script — when anything else
 * moved. `blocked` when even the rebuild cannot honour the draft (a new NOT
 * NULL column with no default has nothing to copy from).
 */
export function sqliteDiffTable(
  current: TableDraft | null,
  draft: TableDraft,
  schema: string,
): SchemaChange[] {
  const q = (s: string) => quoteIdent(s, 'sqlite');
  const table = `${q(schema)}.${q(draft.originalName ?? draft.name)}`;
  const out: SchemaChange[] = [];

  if (!current) {
    const problems = sqliteCreateProblems(draft);
    out.push({
      kind: 'create-table', subject: draft.name, risk: 'safe', cost: 'metadata',
      sql: problems.length ? '' : sqliteCreateTableSql(draft, schema),
      blocked: problems.join(' ') || undefined,
    });
    // Indexes are schema-level objects in SQLite — separate statements, as on
    // PostgreSQL.
    if (!problems.length) {
      for (const i of draft.indexes) {
        out.push({
          kind: 'add-index', subject: i.name, risk: 'safe', cost: 'rebuild',
          sql: sqliteCreateIndexSql(schema, draft.name, i),
        });
      }
    }
    return out;
  }

  // ── Does anything require the rebuild?
  const rebuildReasons: string[] = [];
  if (draft.primaryKey.join(',') !== current.primaryKey.join(',')) {
    rebuildReasons.push('the primary key cannot be altered');
  }
  const curFks = current.foreignKeys.map(fkKey).sort().join(';\n');
  const draftFks = draft.foreignKeys.map(fkKey).sort().join(';\n');
  if (curFks !== draftFks) rebuildReasons.push('foreign keys cannot be added or dropped');
  if (!!draft.strict !== !!current.strict) rebuildReasons.push('STRICT is a CREATE-time option');
  if (!!draft.withoutRowid !== !!current.withoutRowid) {
    rebuildReasons.push('WITHOUT ROWID is a CREATE-time option');
  }
  const byOriginal = new Map(current.columns.map(c => [c.name, c]));
  for (const c of draft.columns) {
    const prev = c.originalName ? byOriginal.get(c.originalName) : byOriginal.get(c.name);
    if (!prev) {
      // A STORED generated column cannot be added with ALTER TABLE at all.
      if (c.generated?.trim() && c.generatedStored) {
        rebuildReasons.push(`adding ${c.name} as STORED generated needs the table rewritten`);
      }
      continue;
    }
    const typeChanged = parseType(prev.type).base !== parseType(c.type).base
      || parseType(prev.type).args.join(',') !== parseType(c.type).args.join(',');
    const changed = typeChanged
      || prev.nullable !== c.nullable
      || (prev.default ?? '') !== (c.default ?? '')
      || (prev.generated ?? '') !== (c.generated ?? '')
      || !!prev.generatedStored !== !!c.generatedStored;
    if (changed) {
      rebuildReasons.push(`SQLite has no ALTER COLUMN — changing ${c.name} means a new table`);
    }
  }

  if (rebuildReasons.length) {
    // The rebuild covers the rename too: the new table is renamed straight to
    // the draft's name, so no separate RENAME statement is staged.
    const newFixed = draft.columns.filter(c => {
      const src = c.originalName ?? c.name;
      return !current.columns.some(p => p.name === src)
        && !(c.generated?.trim()) && !c.nullable && !(c.default ?? '').trim();
    });
    if (newFixed.length) {
      out.push({
        kind: 'rebuild-table', subject: draft.name, risk: 'lossy', cost: 'rebuild', sql: '',
        blocked: `This edit needs a table rebuild (${rebuildReasons[0]}), but `
          + `${newFixed.map(c => c.name).join(', ')} ${newFixed.length === 1 ? 'is' : 'are'} new, `
          + 'NOT NULL and defaultless — the copy would have nothing to put there. Give '
          + 'the column a DEFAULT or make it nullable first.',
        warning: 'Rebuild impossible as drafted — see the explanation below.',
      });
      return out;
    }
    out.push({
      kind: 'rebuild-table', subject: draft.name, risk: 'destructive', cost: 'rebuild',
      warning: `SQLite cannot make this edit in place (${[...new Set(rebuildReasons)].join('; ')}). `
        + 'This is the manual\'s 12-step rebuild: foreign keys are switched OFF, the rows are '
        + 'copied into a new table, the original is DROPPED and the copy renamed into place. '
        + 'If it fails part-way both tables remain — the scratch table is named '
        + `__txui_rebuild_*. Views, triggers and other tables' foreign keys follow the rename `
        + 'automatically (legacy_alter_table stays off). Foreign-key enforcement is restored by '
        + 'the final statement; if the script aborts, reconnect before relying on it.',
      sql: sqliteRebuildScript(current, draft, schema),
    });
    return out;
  }

  // ── Incremental: everything left is inside ALTER TABLE's reach.

  if (draft.originalName && draft.originalName !== draft.name) {
    out.push({
      kind: 'rename-table', subject: draft.name, risk: 'safe', cost: 'metadata',
      warning: 'Views, triggers and foreign keys that reference the old name are updated by '
        + 'SQLite itself (legacy_alter_table stays off).',
      sql: `ALTER TABLE ${table} RENAME TO ${q(draft.name)}`,
    });
  }

  const keptOriginals = new Set<string>();
  for (const c of draft.columns) {
    const prev = c.originalName ? byOriginal.get(c.originalName) : byOriginal.get(c.name);
    if (!prev) {
      const refuses = !c.nullable && !(c.default ?? '').trim();
      out.push({
        kind: 'add-column', subject: c.name,
        risk: refuses ? 'lossy' : 'safe',
        cost: 'metadata',
        warning: refuses
          ? 'SQLite refuses ADD COLUMN … NOT NULL with no non-null DEFAULT — give it one first.'
          : undefined,
        sql: `ALTER TABLE ${table} ADD COLUMN ${sqliteColumnClause(c)}`,
      });
      continue;
    }
    keptOriginals.add(prev.name);
    if (c.originalName && c.originalName !== c.name) {
      out.push({
        kind: 'rename-column', subject: c.name, risk: 'safe', cost: 'metadata',
        warning: 'Views, triggers and code using the old column name — SQLite updates its own '
          + 'references; yours it cannot see.',
        sql: `ALTER TABLE ${table} RENAME COLUMN ${q(c.originalName)} TO ${q(c.name)}`,
      });
    }
  }

  // ── Indexes, before the column drops: SQLite refuses to drop a column an
  // index still uses, so a dropped index must go first.
  const curIdx = new Map(current.indexes.map(i => [i.name, i]));
  const draftIdx = new Map(draft.indexes.map(i => [i.name, i]));
  for (const [name] of curIdx) {
    if (draftIdx.has(name)) continue;
    out.push({
      kind: 'drop-index', subject: name, risk: 'safe', cost: 'metadata',
      warning: 'Queries that relied on this index will scan instead.',
      sql: `DROP INDEX ${q(schema)}.${q(name)}`,
    });
  }
  for (const [name, i] of draftIdx) {
    const prev = curIdx.get(name);
    if (prev && prev.unique === i.unique && prev.columns.join() === i.columns.join()) continue;
    if (prev) {
      out.push({
        kind: 'drop-index', subject: name, risk: 'safe', cost: 'metadata',
        warning: 'Dropped and recreated because its definition changed. Queries relying on it '
          + 'are unindexed in between.',
        sql: `DROP INDEX ${q(schema)}.${q(name)}`,
      });
    }
    out.push({
      kind: 'add-index', subject: name, risk: 'safe', cost: 'rebuild',
      // The draft's name, not the original: a rename, if any, is applied first.
      sql: sqliteCreateIndexSql(schema, draft.name, i),
      warning: i.unique
        ? 'A UNIQUE index fails to build if the column already holds duplicates.'
        : undefined,
    });
  }

  // ── Column drops last, so nothing is deleted before the rest is reviewed.
  for (const prev of current.columns) {
    if (keptOriginals.has(prev.name)) continue;
    out.push({
      kind: 'drop-column', subject: prev.name,
      risk: 'destructive', cost: 'metadata',
      warning: `Every value in ${prev.name} is deleted. Needs SQLite ≥ 3.35 (TxUI bundles `
        + '3.51.3), and the server refuses outright if the column is a primary key, is indexed, '
        + 'or appears in a constraint — drop those first.',
      sql: `ALTER TABLE ${table} DROP COLUMN ${q(prev.name)}`,
    });
  }

  return out;
}
