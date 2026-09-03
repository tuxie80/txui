/**
 * ClickHouse dialect for the table designer.
 *
 * ClickHouse's DDL is not a smaller MySQL. A table is defined by its storage
 * engine expression, and for the MergeTree family the ORDER BY key *is* the
 * table — there is no heap with indexes bolted on. ALTER TABLE is
 * correspondingly narrow: columns can be added, renamed, modified and dropped
 * (drops and type changes are *mutations*, applied to parts asynchronously in
 * the background, not metadata edits), and TTL can be re-set. The engine, the
 * sorting/partition keys and the primary key of an existing table cannot be
 * altered — changing them means a new table and a data copy, and this module
 * says so (`blocked`) instead of emitting SQL that pretends otherwise.
 *
 * The change-set model and the risk vocabulary are shared with the other
 * dialects (`tableDesign.ts`); only the spelling and the limits live here.
 *
 * Pure and dependency-free, so `node --test` covers it.
 */
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';
import { parseType, type ColumnDraft, type SchemaChange, type TableDraft } from './tableDesign.ts';

/**
 * The engines the designer offers for a new table, in the order they are
 * shown: the MergeTree family that does the real work, then the Log family
 * and Memory for scratch/transient data. Replicated* variants are deliberate
 * omissions — replication is a cluster property (ZooKeeper paths as engine
 * arguments), not something a form field gets right.
 */
export const CH_ENGINES: readonly string[] = [
  'MergeTree()', 'ReplacingMergeTree()', 'SummingMergeTree()', 'AggregatingMergeTree()',
  'Log', 'TinyLog', 'StripeLog', 'Memory',
];

/** The engine name without its argument list: `ReplacingMergeTree(ver)` → `ReplacingMergeTree`. */
export function chEngineName(engine: string): string {
  return engine.trim().replace(/\(.*\)\s*$/s, '').trim();
}

/**
 * Does this engine want the MergeTree clauses (ORDER BY etc.)? Matched on the
 * suffix rather than a list so `ReplicatedMergeTree(...)` and
 * `VersionedCollapsingMergeTree(...)` — which a read-back `engine_full`
 * contains even though the picker never offers them — are answered correctly.
 */
export function chIsMergeTree(engine: string): boolean {
  return chEngineName(engine).toLowerCase().endsWith('mergetree');
}

// ── Types: Nullable / LowCardinality wrappers ────────────────────────────────

export interface ChType {
  base: string;
  nullable: boolean;
  lowCardinality: boolean;
}

/** ClickHouse rendering of a draft column's type, wrappers applied. */
export function chRenderType(c: ColumnDraft): string {
  let t = c.type.trim();
  if (c.nullable && !/^nullable\s*\(/i.test(t)) t = `Nullable(${t})`;
  // Nullable inside LowCardinality — the only nesting ClickHouse accepts.
  if (c.lowCardinality && !/^lowcardinality\s*\(/i.test(t)) t = `LowCardinality(${t})`;
  return t;
}

/**
 * Split a type read back from `system.columns` into its wrappers and base —
 * `LowCardinality(Nullable(String))` → `{ base: 'String', nullable: true,
 * lowCardinality: true }` — so a round trip through the designer does not
 * grow a second set of wrappers.
 */
export function chParseType(t: string): ChType {
  let s = t.trim();
  let lowCardinality = false;
  let nullable = false;
  const unwrap = (re: RegExp): boolean => {
    const m = re.exec(s);
    if (!m) return false;
    s = m[1].trim();
    return true;
  };
  // Either nesting order is tolerated on input; only one is legal on output.
  for (let i = 0; i < 2; i++) {
    if (unwrap(/^LowCardinality\s*\((.*)\)$/is)) { lowCardinality = true; continue; }
    if (unwrap(/^Nullable\s*\((.*)\)$/is)) { nullable = true; continue; }
    break;
  }
  return { base: s, nullable, lowCardinality };
}

// ── Widening, for the risk label on MODIFY COLUMN ────────────────────────────

/** Narrowest first — widening within a family is safe. */
const CH_UINT = ['uint8', 'uint16', 'uint32', 'uint64', 'uint128', 'uint256'];
const CH_SINT = ['int8', 'int16', 'int32', 'int64', 'int128', 'int256'];
const CH_FLOAT = ['float32', 'float64'];

/**
 * Same contract as `isWidening` in tableDesign.ts, over ClickHouse's type
 * names: anything this cannot prove safe is lossy. Signed and unsigned are
 * separate ladders — `Int32 → UInt32` is not widening (negative values do not
 * fit), and neither is the reverse (large unsigned values do not fit).
 */
export function chIsWidening(from: string, to: string): boolean {
  const a = parseType(from);
  const b = parseType(to);
  if (a.base === b.base) {
    if (a.args.length !== b.args.length) return b.args.length === 0 ? false : a.args.length === 0;
    return a.args.every((n, i) => b.args[i] >= n);
  }
  for (const ladder of [CH_UINT, CH_SINT, CH_FLOAT]) {
    const ai = ladder.indexOf(a.base), bi = ladder.indexOf(b.base);
    if (ai >= 0 && bi >= 0) return bi >= ai;
  }
  return false;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** One column definition, ClickHouse spelling. */
export function chColumnClause(c: ColumnDraft): string {
  const parts = [quoteIdent(c.name, 'clickhouse'), chRenderType(c)];
  if (c.generated && c.generated.trim()) {
    // DEFAULT/MATERIALIZED/ALIAS are mutually exclusive with a plain DEFAULT.
    parts.push(`${c.chExprKind === 'alias' ? 'ALIAS' : 'MATERIALIZED'} ${c.generated}`);
  } else if (c.default !== null && c.default !== undefined && c.default !== '') {
    parts.push(`DEFAULT ${c.default}`);
  }
  if (c.codec && c.codec.trim()) parts.push(`CODEC(${c.codec.trim()})`);
  if (c.comment) parts.push(`COMMENT ${sqlLiteral(c.comment, 'clickhouse')}`);
  return parts.join(' ');
}

/**
 * Why this draft cannot become a CREATE TABLE, in plain language. Empty when
 * it can. Checked separately from rendering so the designer can refuse
 * *before* showing SQL — a statement that the server would reject reads as
 * though the user mistyped something.
 */
export function chCreateProblems(draft: TableDraft): string[] {
  const problems: string[] = [];
  const engine = (draft.engine ?? '').trim();
  if (!engine) {
    problems.push('ClickHouse has no default table engine — pick one (MergeTree() is the usual choice).');
    return problems;
  }
  const keyClauses = [
    draft.orderBy?.trim() ? 'ORDER BY' : '',
    draft.partitionBy?.trim() ? 'PARTITION BY' : '',
    draft.primaryKey.length ? 'PRIMARY KEY' : '',
    draft.ttl?.trim() ? 'TTL' : '',
  ].filter(Boolean);
  if (chIsMergeTree(engine)) {
    if (!draft.orderBy?.trim()) {
      problems.push(`${chEngineName(engine)} needs an ORDER BY expression — it is the table's `
        + 'sorting key, not an optional index. Use `tuple()` for an unsorted table.');
    }
  } else if (keyClauses.length) {
    problems.push(`${chEngineName(engine)} takes no ${keyClauses.join('/')} clause — `
      + 'those belong to the MergeTree family.');
  }
  return problems;
}

export function chCreateTableSql(draft: TableDraft, db: string): string {
  const q = (s: string) => quoteIdent(s, 'clickhouse');
  const lines = draft.columns.map(c => `  ${chColumnClause(c)}`);
  let sql = `CREATE TABLE ${q(db)}.${q(draft.name)} (\n${lines.join(',\n')}\n)`
    + `\nENGINE = ${(draft.engine ?? '').trim()}`;
  if (chIsMergeTree(draft.engine ?? '')) {
    if (draft.partitionBy?.trim()) sql += `\nPARTITION BY ${draft.partitionBy.trim()}`;
    if (draft.orderBy?.trim()) sql += `\nORDER BY ${draft.orderBy.trim()}`;
    if (draft.primaryKey.length) {
      sql += `\nPRIMARY KEY (${draft.primaryKey.map(q).join(', ')})`;
    }
    if (draft.ttl?.trim()) sql += `\nTTL ${draft.ttl.trim()}`;
  }
  return sql;
}

// ── The diff ─────────────────────────────────────────────────────────────────

/** What changing a structural clause of an existing table would take. */
function blockedStructural(kind: SchemaChange['kind'], subject: string, what: string): SchemaChange {
  return {
    kind, subject, risk: 'safe', cost: 'metadata', sql: '',
    blocked: `ClickHouse cannot alter the ${what} of an existing table. The honest path is a new `
      + 'table with the changed definition, `INSERT INTO new SELECT … FROM old`, then '
      + '`RENAME TABLE`/`EXCHANGE TABLES` to swap them — deliberately not generated here, because '
      + 'a silent copy of a large MergeTree table is an outage.',
    warning: `ClickHouse cannot alter the ${what} of an existing table — see the explanation below.`,
  };
}

/**
 * Every change needed to turn `current` into `draft` on ClickHouse.
 *
 * Supported: ADD / DROP / RENAME / MODIFY COLUMN, MODIFY TTL, RENAME TABLE.
 * Everything structural — engine, ORDER BY, PARTITION BY, PRIMARY KEY — comes
 * back `blocked` with the reason and no SQL. There is no silent rebuild: that
 * is exactly the failure the blocked entry exists to prevent.
 */
export function chDiffTable(
  current: TableDraft | null,
  draft: TableDraft,
  db: string,
): SchemaChange[] {
  const q = (s: string) => quoteIdent(s, 'clickhouse');
  const table = `${q(db)}.${q(draft.originalName ?? draft.name)}`;
  const out: SchemaChange[] = [];

  if (!current) {
    out.push({
      kind: 'create-table', subject: draft.name, risk: 'safe', cost: 'metadata',
      sql: chCreateProblems(draft).length ? '' : chCreateTableSql(draft, db),
      blocked: chCreateProblems(draft).join(' ') || undefined,
    });
    return out;
  }

  // ── Renames first: everything after refers to the new name.
  if (draft.originalName && draft.originalName !== draft.name) {
    out.push({
      kind: 'rename-table', subject: draft.name, risk: 'safe', cost: 'metadata',
      warning: 'Anything referring to the old name — views, code, materialized views '
        + 'targeting it — keeps referring to it.',
      sql: `RENAME TABLE ${table} TO ${q(db)}.${q(draft.name)}`,
    });
  }

  // ── The structural clauses are CREATE-time facts on ClickHouse.
  const norm = (s?: string) => (s ?? '').trim().replace(/\s+/g, ' ');
  if (norm(draft.engine) && norm(draft.engine).toLowerCase() !== norm(current.engine).toLowerCase()) {
    out.push(blockedStructural('change-engine', draft.engine ?? '', 'table engine'));
  }
  if (norm(draft.orderBy) !== norm(current.orderBy)) {
    out.push(blockedStructural('table-option', 'ORDER BY', 'sorting key (ORDER BY)'));
  }
  if (norm(draft.partitionBy) !== norm(current.partitionBy)) {
    out.push(blockedStructural('table-option', 'PARTITION BY', 'partition key'));
  }
  if (draft.primaryKey.join(',') !== current.primaryKey.join(',')) {
    out.push(blockedStructural('table-option', 'PRIMARY KEY', 'primary key'));
  }
  if (norm(draft.ttl) !== norm(current.ttl)) {
    if (norm(draft.ttl) && chIsMergeTree(current.engine ?? draft.engine ?? '')) {
      // MODIFY TTL is real ALTER — metadata, picked up by new parts at once and
      // by old ones as they merge.
      out.push({
        kind: 'table-option', subject: 'TTL', risk: 'safe', cost: 'metadata',
        warning: 'Applies to new parts immediately and to existing parts as they merge — '
          + 'rows the new TTL expires are not deleted until then. Run `ALTER TABLE … '
          + 'MATERIALIZE TTL` by hand if you need it now.',
        sql: `ALTER TABLE ${table} MODIFY TTL ${norm(draft.ttl)}`,
      });
    } else if (norm(draft.ttl)) {
      out.push(blockedStructural('table-option', 'TTL', 'TTL on a non-MergeTree table'));
    } else {
      out.push(blockedStructural('table-option', 'TTL', 'TTL (removal needs a manual ALTER)'));
    }
  }

  // ── Columns.
  const byOriginal = new Map(current.columns.map(c => [c.name, c]));
  const keptOriginals = new Set<string>();

  for (const c of draft.columns) {
    const prev = c.originalName ? byOriginal.get(c.originalName) : byOriginal.get(c.name);
    if (!prev) {
      const backfills = !!(c.generated?.trim() || (c.default ?? '').trim());
      out.push({
        kind: 'add-column', subject: c.name, risk: 'safe', cost: 'metadata',
        warning: backfills
          ? 'The DEFAULT/MATERIALIZED expression applies to new inserts; existing parts are '
            + 'not backfilled (they read as the type default) unless you run '
            + '`ALTER TABLE … MATERIALIZE COLUMN` by hand.'
          : undefined,
        sql: `ALTER TABLE ${table} ADD COLUMN ${chColumnClause(c)}`,
      });
      continue;
    }
    keptOriginals.add(prev.name);

    if (c.originalName && c.originalName !== c.name) {
      out.push({
        kind: 'rename-column', subject: c.name, risk: 'safe', cost: 'metadata',
        warning: 'Queries and code using the old column name will break.',
        sql: `ALTER TABLE ${table} RENAME COLUMN ${q(c.originalName)} TO ${q(c.name)}`,
      });
    }

    const typeChanged =
      norm(prev.type).toLowerCase() !== norm(c.type).toLowerCase()
      || prev.nullable !== c.nullable
      || !!prev.lowCardinality !== !!c.lowCardinality;
    const defChanged = (prev.default ?? '') !== (c.default ?? '')
      || (prev.generated ?? '') !== (c.generated ?? '')
      || (prev.chExprKind ?? 'materialized') !== (c.chExprKind ?? 'materialized');
    const codecChanged = norm(prev.codec) !== norm(c.codec);
    if (typeChanged || defChanged || codecChanged) {
      const narrowing = norm(prev.type).toLowerCase() !== norm(c.type).toLowerCase()
        && !chIsWidening(prev.type, c.type);
      const tightening = prev.nullable !== c.nullable && !c.nullable;
      const reasons: string[] = [];
      if (narrowing) {
        reasons.push(`${prev.type} → ${c.type} is not a widening change — values that do not fit`
          + ' become garbage or an exception.');
      }
      if (tightening) {
        reasons.push('Dropping Nullable turns existing NULLs into the type default (0 / empty '
          + 'string), silently.');
      }
      reasons.push('MODIFY COLUMN is a mutation: ClickHouse rewrites the affected parts in the '
        + 'background, so on a large table this is heavy and finishes asynchronously.');
      out.push({
        kind: 'modify-column', subject: c.name,
        risk: narrowing || tightening ? 'lossy' : 'safe',
        cost: 'rebuild',
        warning: reasons.join(' '),
        sql: `ALTER TABLE ${table} MODIFY COLUMN ${chColumnClause({ ...c, name: c.name })}`,
      });
    }
  }

  // ── Drops last, so nothing is deleted before the rest has been reviewed.
  for (const prev of current.columns) {
    if (keptOriginals.has(prev.name)) continue;
    out.push({
      kind: 'drop-column', subject: prev.name,
      risk: 'destructive', cost: 'rebuild',
      warning: `Every value in ${prev.name} is deleted, as a background mutation that rewrites `
        + 'the affected parts — there is no transaction to roll back.',
      sql: `ALTER TABLE ${table} DROP COLUMN ${q(prev.name)}`,
    });
  }

  return out;
}
