/**
 * Visual table designer.
 *
 * Editing here changes a **draft**, never the database. The right-hand pane
 * shows the change set the draft implies — each entry labelled with what it
 * costs and what it can destroy — and the SQL that would run. Nothing executes
 * until Apply, and Apply still goes through the server-side production guards,
 * which refuse destructive DDL on a prod-tagged connection unless that
 * connection was explicitly unlocked.
 *
 * The safety wording is not decoration. MySQL commits DDL implicitly, so a
 * dropped column has no rollback, and several ordinary-looking edits rewrite
 * every row. `utils/tableDesign.ts` decides those labels; this is the screen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { quoteIdent, sqlLiteral } from '../utils/sqlIdent';
import { useServerFlavor } from '../store/serverFlavors';
import {
  pgCreatePartitionSql, pgAttachPartitionSql, pgDetachPartitionSql, type PgPartitionBound,
} from '../utils/pgObjectSql';
import {
  addPartitionSql, changesToScript, diffTable, dropPartitionSql, reorganizePartitionSql,
  summarise,
  type ColumnDraft, type IndexDraft, type ForeignKeyDraft, type PartitionDef, type SchemaChange, type TableDraft,
} from '../utils/tableDesign';
import { chDiffTable, chParseType, CH_ENGINES } from '../utils/chTableDesign';
import { sqliteDiffTable, sqliteParseTableSql } from '../utils/sqliteTableDesign';

/** The dialects the designer speaks. Redis and Parquet get a refusal, not a coercion. */
type Dialect = 'mysql' | 'postgres' | 'clickhouse' | 'sqlite' | 'sqlserver';
const dialectOf = (engine: string): Dialect | null =>
  engine === 'postgres' ? 'postgres'
  : engine === 'clickhouse' ? 'clickhouse'
  : engine === 'sqlite' ? 'sqlite'
  : engine === 'sqlserver' ? 'sqlserver'
  : engine === 'mysql' ? 'mysql' : null;

interface Props {
  session: Session;
  schema: string;
  /** Existing table to edit, or undefined to design a new one. */
  table?: string;
  onClose: () => void;
  onApplied?: () => void;
}

const BLANK: TableDraft = {
  name: '', columns: [], primaryKey: [], indexes: [], foreignKeys: [],
};

const emptyColumn = (dialect: Dialect = 'mysql'): ColumnDraft => ({
  name: '',
  type: dialect === 'clickhouse' ? 'String' : dialect === 'sqlite' ? 'TEXT'
    // `nvarchar` unlengthed truncates at 30 in a CAST and defaults to 1 in a
    // column — the length is never left implicit.
    : dialect === 'sqlserver' ? 'nvarchar(255)' : 'VARCHAR(255)',
  nullable: true,
  default: null,
});

export function TableDesigner({ session, schema, table, onClose, onApplied }: Props) {
  const dialect = dialectOf(session.engine);
  // Refusing beats coercing: before this, a ClickHouse or SQLite session was
  // silently handed the MySQL dialect and shown SQL its server cannot run.
  if (!dialect) {
    return (
      <div className="proc-panel">
        <div className="proc-toolbar">
          <span className="proc-title">🛠 Table designer</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>
        <div className="db-error" style={{ margin: 16 }}>
          The table designer is not available for {session.engine} —{' '}
          {session.engine === 'redis'
            ? 'Redis has no tables to design.'
            : session.engine === 'duckdb'
              ? 'the designer has no DuckDB dialect yet; CREATE TABLE works from the SQL editor.'
              : 'a Parquet file is read-only; there is nothing to alter.'}
        </div>
      </div>
    );
  }
  return <TableDesignerInner session={session} schema={schema} table={table}
    dialect={dialect} onClose={onClose} onApplied={onApplied} />;
}

function TableDesignerInner({ session, schema: schemaProp, table, dialect, onClose, onApplied }:
  Props & { dialect: Dialect }) {
  // A menu-opened designer can arrive with no current database (SQLite has no
  // `current_schema()`), which would emit `"."."name"` — fall back to the
  // built-in database these engines always have.
  const schema = schemaProp
    || (dialect === 'sqlite' ? 'main' : dialect === 'clickhouse' ? 'default'
        // Unqualified names in T-SQL resolve against the caller's default
        // schema, which is not necessarily where the table is.
        : dialect === 'sqlserver' ? 'dbo' : '');
  // The MySQL/PostgreSQL spelling of the shared diffTable; the ClickHouse and
  // SQLite dialects have their own modules. `engine` stays so the existing
  // MySQL/PG branches below keep reading the way they did.
  const engine: 'mysql' | 'postgres' | 'sqlserver' =
    dialect === 'postgres' ? 'postgres'
    : dialect === 'sqlserver' ? 'sqlserver'
    : 'mysql';
  const isMaria = useServerFlavor(session.sessionId, session.engine).flavor === 'mariadb';
  const [current, setCurrent] = useState<TableDraft | null>(null);
  const [draft, setDraft] = useState<TableDraft>(BLANK);
  const [loading, setLoading] = useState(!!table);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  /**
   * Partition operations the user has explicitly proposed (MySQL only).
   *
   * Unlike column/index/FK changes — which `diffTable` derives from the draft —
   * a partition edit is not something a table shape can imply, so it is staged
   * here and merged into the change set. It still only becomes a *proposal*:
   * nothing runs until Apply, and DROP PARTITION carries its destructive label
   * through the same review and confirm-word flow as everything else.
   */
  const [partitionChanges, setPartitionChanges] = useState<SchemaChange[]>([]);
  const [addName, setAddName] = useState('');
  const [addBound, setAddBound] = useState('');
  const [dropName, setDropName] = useState('');
  const [reorgFrom, setReorgFrom] = useState('');
  const [reorgInto, setReorgInto] = useState('');
  // PostgreSQL declarative partitioning
  const [pgChild, setPgChild] = useState('');
  const [pgStrategy, setPgStrategy] = useState<'range' | 'list' | 'hash' | 'default'>('range');
  const [pgBoundA, setPgBoundA] = useState('');
  const [pgBoundB, setPgBoundB] = useState('');

  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql }),
    [session.sessionId]);

  // ── Read the table as it is now ─────────────────────────────────────────
  useEffect(() => {
    if (!table) {
      setDraft({
        ...BLANK, columns: [emptyColumn(dialect)],
        // ClickHouse has no server-default engine; MergeTree() is the usual
        // starting point and pre-filling it beats an immediate refusal.
        ...(dialect === 'clickhouse' ? { engine: 'MergeTree()' } : {}),
      });
      return;
    }
    let gone = false;
    setLoading(true);
    const lit = (v: string) => sqlLiteral(v, dialect);
    const finish = (shape: TableDraft) => {
      if (gone) return;
      setCurrent(shape);
      // A deep copy, so editing the draft cannot mutate the recorded reality —
      // the diff is only meaningful while `current` stays what the server said.
      setDraft(JSON.parse(JSON.stringify(shape)));
      setError(null);
    };
    const fail = (e: unknown) => { if (!gone) setError(errorDisplay(e)); };
    const done = () => { if (!gone) setLoading(false); };

    // ClickHouse: system.columns carries the full declared type (wrappers
    // included) and the default kind; system.tables carries the engine
    // expression and the MergeTree keys.
    if (dialect === 'clickhouse') {
      Promise.all([
        run(`SELECT name, type, default_kind, default_expression FROM system.columns`
          + ` WHERE database = ${lit(schema)} AND table = ${lit(table)} ORDER BY position`),
        run(`SELECT engine_full, partition_key, sorting_key, primary_key FROM system.tables`
          + ` WHERE database = ${lit(schema)} AND name = ${lit(table)}`),
      ]).then(([colsR, tblR]) => {
        const columns: ColumnDraft[] = colsR.rows.map(r => {
          const parsed = chParseType(String(r[1]));
          const kind = String(r[2] ?? '');
          const expr = r[3] === null ? '' : String(r[3]);
          const c: ColumnDraft = {
            name: String(r[0]), type: parsed.base,
            nullable: parsed.nullable, lowCardinality: parsed.lowCardinality || undefined,
            default: null, originalName: String(r[0]),
          };
          if (kind === 'DEFAULT') c.default = expr;
          if (kind === 'MATERIALIZED' || kind === 'ALIAS') {
            c.generated = expr;
            c.chExprKind = kind === 'ALIAS' ? 'alias' : 'materialized';
          }
          return c;
        });
        const t = tblR.rows[0];
        finish({
          name: table, originalName: table, columns,
          primaryKey: t && t[3] ? String(t[3]).split(',').map(s => s.trim()).filter(Boolean) : [],
          indexes: [], foreignKeys: [],
          engine: t ? String(t[0]) : undefined,
          partitionBy: t && t[1] ? String(t[1]) : undefined,
          orderBy: t && t[2] ? String(t[2]) : undefined,
        });
      }).catch(fail).finally(done);
      return () => { gone = true; };
    }

    // SQL Server: `sys.columns` alone does not give a declared type — a
    // varchar(50) reads back as `varchar` with a max_length of 50, and an
    // nvarchar's max_length is in BYTES, so it has to be halved. Reconstructing
    // the declaration is the only way a round trip through the designer does
    // not quietly drop every length and precision, which is the same problem
    // PostgreSQL's `format_type` solves there.
    //
    // Three things no other dialect needs: the DEFAULT constraint's NAME (it is
    // a separate object, and an unnamed one is called `DF__t__c__3E52440B`,
    // which nothing can reconstruct), `is_identity`, and the computed-column
    // definition with its PERSISTED flag.
    if (dialect === 'sqlserver') {
      const declared =
        "TYPE_NAME(c.user_type_id) + CASE"
        + " WHEN TYPE_NAME(c.user_type_id) IN ('varchar','char','varbinary','binary')"
        + "   THEN '(' + CASE WHEN c.max_length = -1 THEN 'max'"
        + "                   ELSE CONVERT(varchar(10), c.max_length) END + ')'"
        // nvarchar/nchar store two bytes per character.
        + " WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar')"
        + "   THEN '(' + CASE WHEN c.max_length = -1 THEN 'max'"
        + "                   ELSE CONVERT(varchar(10), c.max_length / 2) END + ')'"
        + " WHEN TYPE_NAME(c.user_type_id) IN ('decimal','numeric')"
        + "   THEN '(' + CONVERT(varchar(10), c.precision) + ','"
        + "            + CONVERT(varchar(10), c.scale) + ')'"
        + " WHEN TYPE_NAME(c.user_type_id) IN ('datetime2','time','datetimeoffset')"
        + "   THEN '(' + CONVERT(varchar(10), c.scale) + ')'"
        + " ELSE '' END";
      Promise.all([
        run(`SELECT c.name, ${declared},`
          + ` CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END,`
          + ` dc.definition, dc.name, CONVERT(int, c.is_identity),`
          + ` cc.definition, CONVERT(int, ISNULL(cc.is_persisted, 0))`
          + ` FROM sys.columns c`
          + ` LEFT JOIN sys.default_constraints dc`
          + `   ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id`
          + ` LEFT JOIN sys.computed_columns cc`
          + `   ON cc.object_id = c.object_id AND cc.column_id = c.column_id`
          + ` WHERE c.object_id = OBJECT_ID(${lit(`${schema}.${table}`)})`
          + ` ORDER BY c.column_id`),
        run(`SELECT c.name FROM sys.indexes i`
          + ` JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id`
          + ` JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id`
          + ` WHERE i.object_id = OBJECT_ID(${lit(`${schema}.${table}`)}) AND i.is_primary_key = 1`
          + ` ORDER BY ic.key_ordinal`),
        // The primary key's own index is excluded — it is the PK, shown above.
        // `is_included_column = 0` keeps INCLUDE columns out of the key list,
        // where they would round-trip as key columns and change the index.
        run(`SELECT i.name, c.name, CASE WHEN i.is_unique = 1 THEN 0 ELSE 1 END`
          + ` FROM sys.indexes i`
          + ` JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id`
          + ` JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id`
          + ` WHERE i.object_id = OBJECT_ID(${lit(`${schema}.${table}`)})`
          + `   AND i.is_primary_key = 0 AND i.name IS NOT NULL AND ic.is_included_column = 0`
          + ` ORDER BY i.name, ic.key_ordinal`),
        run(`SELECT fk.name, pc.name, OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.'`
          + `   + OBJECT_NAME(fk.referenced_object_id), rc.name,`
          + ` fk.delete_referential_action_desc, fk.update_referential_action_desc`
          + ` FROM sys.foreign_keys fk`
          + ` JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id`
          + ` JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id`
          + `   AND pc.column_id = fkc.parent_column_id`
          + ` JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id`
          + `   AND rc.column_id = fkc.referenced_column_id`
          + ` WHERE fk.parent_object_id = OBJECT_ID(${lit(`${schema}.${table}`)})`
          + ` ORDER BY fk.name, fkc.constraint_column_id`),
      ]).then(([colsR, pkR, idxR, fkR]) => {
        if (gone) return;
        const columns: ColumnDraft[] = colsR.rows.map(r => {
          const computed = r[6] === null ? '' : String(r[6]);
          const c: ColumnDraft = {
            name: String(r[0]), type: String(r[1]),
            nullable: String(r[2]).toUpperCase() === 'YES',
            default: r[3] === null ? null : String(r[3]),
            defaultConstraint: r[4] === null ? undefined : String(r[4]),
            autoIncrement: String(r[5]) === '1' || undefined,
            originalName: String(r[0]),
          };
          if (computed) {
            c.generated = computed;
            c.generatedStored = String(r[7]) === '1';
            c.default = null;
            c.defaultConstraint = undefined;
          }
          return c;
        });
        const idxMap = new Map<string, IndexDraft>();
        for (const r of idxR.rows) {
          const nm = String(r[0]);
          const existing = idxMap.get(nm);
          if (existing) existing.columns.push(String(r[1]));
          else idxMap.set(nm, { name: nm, columns: [String(r[1])], unique: String(r[2]) === '0' });
        }
        const fkMap = new Map<string, ForeignKeyDraft>();
        for (const r of fkR.rows) {
          const nm = String(r[0]);
          const existing = fkMap.get(nm);
          if (existing) {
            existing.columns.push(String(r[1]));
            existing.refColumns.push(String(r[3]));
            continue;
          }
          // NO_ACTION is the default and is what the server reports when no
          // clause was written; emitting it back would add a clause the user
          // never asked for and turn an unchanged FK into a diff.
          const del = String(r[4] ?? '').replace(/_/g, ' ');
          const upd = String(r[5] ?? '').replace(/_/g, ' ');
          fkMap.set(nm, {
            name: nm, columns: [String(r[1])],
            refTable: String(r[2]), refColumns: [String(r[3])],
            onDelete: del && del !== 'NO ACTION' ? del : undefined,
            onUpdate: upd && upd !== 'NO ACTION' ? upd : undefined,
          });
        }
        finish({
          name: table, originalName: table, columns,
          primaryKey: pkR.rows.map(r => String(r[0])),
          indexes: [...idxMap.values()],
          foreignKeys: [...fkMap.values()],
        });
      }).catch(fail).finally(done);
      return () => { gone = true; };
    }

    // SQLite: pragma_table_xinfo for the columns (it alone says which columns
    // are generated and whether they are STORED), sqlite_master.sql for the
    // generated expressions and the STRICT / WITHOUT ROWID options, and
    // index_list + index_info for the secondary indexes.
    if (dialect === 'sqlite') {
      const qi = (v: string) => quoteIdent(v, 'sqlite');
      run(`SELECT name, type, "notnull", dflt_value, pk, hidden`
        + ` FROM ${qi(schema)}.pragma_table_xinfo(${lit(table)}) ORDER BY cid`)
        .then(async colsR => {
          const [sqlR, idxR] = await Promise.all([
            run(`SELECT sql FROM ${qi(schema)}.sqlite_master WHERE type = 'table' AND name = ${lit(table)}`),
            run(`SELECT name, "unique", origin FROM ${qi(schema)}.pragma_index_list(${lit(table)})`),
          ]);
          const parsed = sqliteParseTableSql(String(sqlR.rows[0]?.[0] ?? ''));
          const idxDefs = idxR.rows
            .filter(r => String(r[2]) === 'c') // 'c' = created by CREATE INDEX
            .map(r => ({ name: String(r[0]), unique: String(r[1]) === '1' }));
          const idxCols = await Promise.all(idxDefs.map(d =>
            run(`SELECT name FROM ${qi(schema)}.pragma_index_info(${lit(d.name)}) ORDER BY seqno`)));
          if (gone) return;
          const columns: ColumnDraft[] = colsR.rows
            .filter(r => Number(r[5]) !== 1) // hidden=1 is a virtual-table implementation detail
            .map(r => {
              const gen = parsed.generated[String(r[0])];
              const c: ColumnDraft = {
                name: String(r[0]), type: String(r[1]),
                nullable: !Number(r[3]) && !Number(r[4]),
                default: r[3] === null ? null : String(r[3]),
                originalName: String(r[0]),
              };
              if (gen) { c.generated = gen.expr; c.generatedStored = gen.stored; c.default = null; }
              return c;
            });
          finish({
            name: table, originalName: table, columns,
            primaryKey: colsR.rows.filter(r => Number(r[4]) > 0)
              .sort((a, b) => Number(a[4]) - Number(b[4])).map(r => String(r[0])),
            indexes: idxDefs.map((d, i) => ({
              name: d.name, columns: idxCols[i].rows.map(r => String(r[0])), unique: d.unique,
            })),
            foreignKeys: [],
            strict: parsed.strict || undefined,
            withoutRowid: parsed.withoutRowid || undefined,
          });
        }).catch(fail).finally(done);
      return () => { gone = true; };
    }

    Promise.all([
      // MySQL's `column_type` carries the declared type in full. PostgreSQL's
      // `information_schema.data_type` does not — a varchar(50) reads back as
      // `character varying` and a numeric(10,2) as `numeric`, so a round trip
      // through the designer would quietly drop every length and precision.
      // `format_type` is the only thing that reproduces the declaration.
      run(engine === 'mysql'
        ? `SELECT column_name, column_type, is_nullable, column_default`
          + ` FROM information_schema.columns WHERE table_schema = ${lit(schema)}`
          + ` AND table_name = ${lit(table)} ORDER BY ordinal_position`
        : `SELECT a.attname, format_type(a.atttypid, a.atttypmod),`
          + ` CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,`
          + ` pg_get_expr(d.adbin, d.adrelid)`
          + ` FROM pg_attribute a`
          + ` LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum`
          + ` WHERE a.attrelid = to_regclass(quote_ident(${lit(schema)})`
          + ` || '.' || quote_ident(${lit(table)}))`
          + ` AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`),
      run(`SELECT kcu.column_name FROM information_schema.table_constraints tc`
        + ` JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name`
        + ` AND tc.table_schema = kcu.table_schema`
        + ` WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = ${lit(schema)}`
        + ` AND tc.table_name = ${lit(table)} ORDER BY kcu.ordinal_position`),
      // The storage engine, for the MySQL family only. PostgreSQL has one.
      engine === 'mysql'
        ? run(`SELECT engine FROM information_schema.tables WHERE table_schema = ${lit(schema)}`
            + ` AND table_name = ${lit(table)}`)
        : Promise.resolve(null),
      // Secondary indexes (PRIMARY excluded — it's the PK). Grouped client-side
      // by name into IndexDraft. Visibility is not read back (assumed visible),
      // so an already-invisible index shows visible until toggled.
      run(engine === 'mysql'
        ? `SELECT index_name, column_name, non_unique, seq_in_index`
          + ` FROM information_schema.statistics WHERE table_schema = ${lit(schema)}`
          + ` AND table_name = ${lit(table)} AND index_name <> 'PRIMARY'`
          + ` ORDER BY index_name, seq_in_index`
        : `SELECT c.relname, a.attname, CASE WHEN ix.indisunique THEN 0 ELSE 1 END,`
          + ` array_position(ix.indkey, a.attnum)`
          + ` FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid`
          + ` JOIN pg_class t ON t.oid = ix.indrelid`
          + ` JOIN pg_namespace n ON n.oid = t.relnamespace`
          + ` JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)`
          + ` WHERE n.nspname = ${lit(schema)} AND t.relname = ${lit(table)}`
          + ` AND NOT ix.indisprimary`
          + ` ORDER BY c.relname, array_position(ix.indkey, a.attnum)`),
    ]).then(([colsR, pkR, engR, idxR]) => {
      if (gone) return;
      const columns: ColumnDraft[] = colsR.rows.map(r => ({
        name: String(r[0]),
        type: String(r[1]),
        nullable: String(r[2]).toUpperCase() === 'YES',
        default: r[3] === null ? null : String(r[3]),
        originalName: String(r[0]),
      }));
      // Group the flat (index_name, column, non_unique) rows into IndexDraft[].
      const idxMap = new Map<string, IndexDraft>();
      for (const r of idxR.rows) {
        const nm = String(r[0]);
        const existing = idxMap.get(nm);
        if (existing) existing.columns.push(String(r[1]));
        else idxMap.set(nm, { name: nm, columns: [String(r[1])], unique: String(r[2]) === '0' });
      }
      const shape: TableDraft = {
        name: table, originalName: table, columns,
        primaryKey: pkR.rows.map(r => String(r[0])),
        indexes: [...idxMap.values()], foreignKeys: [],
        engine: engR?.rows[0]?.[0] ? String(engR.rows[0][0]) : undefined,
      };
      setCurrent(shape);
      // A deep copy, so editing the draft cannot mutate the recorded reality —
      // the diff is only meaningful while `current` stays what the server said.
      setDraft(JSON.parse(JSON.stringify(shape)));
      setError(null);
    }).catch(e => { if (!gone) setError(errorDisplay(e)); })
      .finally(() => { if (!gone) setLoading(false); });
    return () => { gone = true; };
  }, [table, schema, run, engine, dialect]);

  /**
   * Storage engines the connected server reports.
   *
   * Read from the server rather than hardcoded: the list genuinely differs —
   * MariaDB offers Aria and SEQUENCE, MySQL offers ARCHIVE and BLACKHOLE — and
   * a fixed list would offer engines the server would refuse.
   */
  const [engines, setEngines] = useState<string[]>([]);
  useEffect(() => {
    if (dialect !== 'mysql') { setEngines([]); return; }
    run("SELECT engine FROM information_schema.engines WHERE support IN ('YES','DEFAULT')"
        + " AND engine NOT IN ('PERFORMANCE_SCHEMA') ORDER BY engine")
      .then(r => setEngines(r.rows.map(x => String(x[0]))))
      .catch(() => setEngines([]));
  }, [run, dialect]);

  const changes: SchemaChange[] = useMemo(
    () => [
      ...(draft.name.trim()
        ? dialect === 'clickhouse' ? chDiffTable(current, draft, schema)
        : dialect === 'sqlite' ? sqliteDiffTable(current, draft, schema)
        : diffTable(current, draft, schema, engine, isMaria ? 'mariadb' : 'mysql')
        : []),
      ...partitionChanges,
    ],
    [current, draft, schema, engine, dialect, isMaria, partitionChanges]);
  const summary = useMemo(() => summarise(changes), [changes]);
  const script = useMemo(() => changesToScript(changes), [changes]);
  /**
   * A blocked change means the draft asks for something this dialect cannot
   * express. Apply is then disabled entirely: running the rest would apply
   * less than was asked while claiming otherwise.
   */
  const blockedCount = changes.filter(c => c.blocked).length;

  const isProd = session.environment === 'prod';
  const needsTyping = summary.destructive > 0 || isProd;
  /** The exact word required to arm Apply. Longer on prod, on purpose. */
  const requiredWord = isProd ? 'PRODUCTION' : 'DELETE';
  const armed = !needsTyping || confirmText === requiredWord;

  const patch = (fn: (d: TableDraft) => TableDraft) => setDraft(d => fn({ ...d }));
  const setCol = (i: number, over: Partial<ColumnDraft>) =>
    patch(d => ({ ...d, columns: d.columns.map((c, j) => (j === i ? { ...c, ...over } : c)) }));

  // ── Partition management (MySQL family, existing table only) ────────────
  // Built against the same qualified, quoted reference `diffTable` uses so the
  // staged statements read identically to the rest of the change set.
  const partitioningAvailable = dialect === 'mysql' && !!current;
  const tableRef = `${quoteIdent(schema, engine)}.${quoteIdent(draft.originalName ?? draft.name, engine)}`;
  const stage = (c: SchemaChange) => setPartitionChanges(cs => [...cs, c]);
  /** `p1:100, p2:MAXVALUE` → PartitionDef[]. Bounds are raw SQL, kept verbatim. */
  const parsePartitionDefs = (spec: string): PartitionDef[] =>
    spec.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const i = s.indexOf(':');
      return i < 0
        ? { name: s, valuesLessThan: '' }
        : { name: s.slice(0, i).trim(), valuesLessThan: s.slice(i + 1).trim() };
    });

  const apply = useCallback(async () => {
    if (!changes.length) return;
    setApplying(true);
    setError(null);
    try {
      // One statement at a time, in the order the change set lists them —
      // drops last. A failure part-way leaves the earlier ones applied, which
      // is unavoidable for MySQL DDL and is why the preview exists.
      for (const c of changes) {
        // Unreachable — Apply is disabled while any change is blocked — but
        // applying less than the draft asked for must fail loudly, not skip.
        if (c.blocked || !c.sql.trim()) throw new Error(`cannot apply: ${c.subject} is blocked`);
        await invoke('execute_query', {
          sessionId: session.sessionId,
          connectionId: session.connectionId,
          engine: session.engine,
          sql: c.sql,
          tabId: -1,
        });
      }
      onApplied?.();
      window.dispatchEvent(new CustomEvent('dbgui:schema-changed'));
      onClose();
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setApplying(false);
    }
  }, [changes, session, onApplied, onClose]);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🛠 {table ? `Design ${table}` : 'New table'}</span>
        <label className="dg-field-inline">
          <span>Name</span>
          <input value={draft.name} onChange={e => patch(d => ({ ...d, name: e.target.value }))}
            placeholder="table_name" />
        </label>
        {/* MySQL family only — PostgreSQL has a single storage engine. The
            options come from the server, so MariaDB shows Aria and SEQUENCE
            and MySQL shows ARCHIVE and BLACKHOLE without either being
            hardcoded here. */}
        {dialect === 'mysql' && engines.length > 0 && (
          <label className="dg-field-inline">
            <span>Engine</span>
            <select
              value={draft.engine ?? ''}
              onChange={e => patch(d => ({ ...d, engine: e.target.value || undefined }))}
            >
              <option value="">server default</option>
              {engines.map(en => <option key={en} value={en}>{en}</option>)}
            </select>
          </label>
        )}
        {/* MariaDB-only DDL: system-versioned (temporal) tables and the atomic
            CREATE OR REPLACE. Offered only when creating a new table — both are
            CREATE-time clauses, not ALTERs. */}
        {isMaria && dialect === 'mysql' && !table && (
          <>
            <label className="dg-field-inline" title="Append WITH SYSTEM VERSIONING — MariaDB keeps every historical row for AS OF queries">
              <input type="checkbox" checked={!!draft.systemVersioning}
                onChange={e => patch(d => ({ ...d, systemVersioning: e.target.checked }))} />
              <span>System versioning</span>
            </label>
            <label className="dg-field-inline" title="Emit CREATE OR REPLACE TABLE — atomically drops an existing table of the same name first (destructive)">
              <input type="checkbox" checked={!!draft.orReplace}
                onChange={e => patch(d => ({ ...d, orReplace: e.target.checked }))} />
              <span>OR REPLACE</span>
            </label>
          </>
        )}
        <span className="dv-desc">{schema}</span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {/* ClickHouse: the engine expression and the MergeTree clauses are the
          table. On an existing table they are read-back facts — editing one
          produces a blocked change with the explanation, because ClickHouse
          cannot alter them in place. */}
      {dialect === 'clickhouse' && (
        <div className="proc-toolbar">
          <label className="dg-field-inline">
            <span>Engine</span>
            <select value={draft.engine ?? ''}
              onChange={e => patch(d => ({ ...d, engine: e.target.value || undefined }))}>
              <option value="">— pick one —</option>
              {CH_ENGINES.map(en => <option key={en} value={en}>{en}</option>)}
            </select>
          </label>
          <label className="dg-field-inline" title="The sorting key — mandatory for the MergeTree family, forbidden elsewhere">
            <span>ORDER BY</span>
            <input className="td-in td-type" value={draft.orderBy ?? ''} placeholder="ts, user_id"
              onChange={e => patch(d => ({ ...d, orderBy: e.target.value || undefined }))} />
          </label>
          <label className="dg-field-inline">
            <span>PARTITION BY</span>
            <input className="td-in td-type" value={draft.partitionBy ?? ''} placeholder="toYYYYMM(ts)"
              onChange={e => patch(d => ({ ...d, partitionBy: e.target.value || undefined }))} />
          </label>
          <label className="dg-field-inline" title="Row lifetime, e.g. ts + INTERVAL 90 DAY — picked up by parts as they merge">
            <span>TTL</span>
            <input className="td-in td-type" value={draft.ttl ?? ''} placeholder="ts + INTERVAL 90 DAY"
              onChange={e => patch(d => ({ ...d, ttl: e.target.value || undefined }))} />
          </label>
        </div>
      )}

      {/* SQLite: both are CREATE-time options. Toggling one on an existing
          table triggers the labelled 12-step rebuild in the change set. */}
      {dialect === 'sqlite' && (
        <div className="proc-toolbar">
          <label className="dg-field-inline" title="STRICT table — column types restricted to INT/INTEGER/REAL/TEXT/BLOB/ANY, enforced on write">
            <input type="checkbox" checked={!!draft.strict}
              onChange={e => patch(d => ({ ...d, strict: e.target.checked || undefined }))} />
            <span>STRICT</span>
          </label>
          <label className="dg-field-inline" title="WITHOUT ROWID — the primary key IS the storage; requires a primary key">
            <input type="checkbox" checked={!!draft.withoutRowid}
              onChange={e => patch(d => ({ ...d, withoutRowid: e.target.checked || undefined }))} />
            <span>WITHOUT ROWID</span>
          </label>
        </div>
      )}

      {error && <div className="proc-error-bar">{error}</div>}
      {loading && <div className="db-error">Reading the table…</div>}

      {isProd && (
        <div className="td-prod-bar">
          ⚠ This connection is tagged <strong>production</strong>. Destructive DDL is refused
          server-side unless <em>Allow destructive DDL</em> is enabled on the connection — and
          applying anything here needs the word <code>PRODUCTION</code> typed below.
        </div>
      )}

      <div className="td-split">
        {/* ── Left: the draft ─────────────────────────────────────────── */}
        <div className="td-editor">
          <div className="td-section">Columns</div>
          <table className="cp-table">
            <thead>
              <tr>
                <th>Name</th><th>Type</th>{dialect === 'clickhouse' && <th>LC</th>}<th>Null</th>
                <th>Default</th><th>Generated</th>{dialect === 'clickhouse' && <th>Codec</th>}
                <th>PK</th><th></th>
              </tr>
            </thead>
            <tbody>
              {draft.columns.map((c, i) => (
                <tr key={i} className={c.originalName ? '' : 'td-new-row'}>
                  <td><input className="td-in" value={c.name}
                    onChange={e => setCol(i, { name: e.target.value })} /></td>
                  <td><input className="td-in td-type" value={c.type}
                    onChange={e => setCol(i, { type: e.target.value })} /></td>
                  {/* ClickHouse: LowCardinality wraps the type (outside
                      Nullable — the only nesting the server accepts). */}
                  {dialect === 'clickhouse' && (
                    <td style={{ textAlign: 'center' }}
                      title="LowCardinality(…) — dictionary encoding for low-cardinality columns">
                      <input type="checkbox" checked={!!c.lowCardinality}
                        onChange={e => setCol(i, { lowCardinality: e.target.checked || undefined })} />
                    </td>
                  )}
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={c.nullable}
                      onChange={e => setCol(i, { nullable: e.target.checked })} />
                  </td>
                  <td><input className="td-in" value={c.default ?? ''}
                    placeholder={c.generated ? 'n/a' : '—'}
                    disabled={!!c.generated}
                    onChange={e => setCol(i, { default: e.target.value || null })} /></td>
                  {/* Generated / computed column: expression + STORED/VIRTUAL
                      (PostgreSQL is always STORED). Setting an expression makes
                      the column GENERATED ALWAYS AS (…) and disables Default.
                      On ClickHouse the same field is the MATERIALIZED / ALIAS
                      expression — computed on insert, or on read. */}
                  <td>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <input className="td-in" value={c.generated ?? ''}
                        placeholder="expr, e.g. price*qty"
                        onChange={e => setCol(i, { generated: e.target.value || undefined })} />
                      {c.generated && (dialect === 'mysql' || dialect === 'sqlite') && (
                        <select className="td-in" style={{ flex: '0 0 auto' }}
                          value={c.generatedStored ? 'stored' : 'virtual'}
                          onChange={e => setCol(i, { generatedStored: e.target.value === 'stored' })}>
                          <option value="virtual">VIRTUAL</option>
                          <option value="stored">STORED</option>
                        </select>
                      )}
                      {/* PERSISTED is T-SQL's STORED: the value is computed on
                          write and kept, which is also what makes the column
                          indexable and what lets it be NOT NULL. */}
                      {c.generated && dialect === 'sqlserver' && (
                        <select className="td-in" style={{ flex: '0 0 auto' }}
                          value={c.generatedStored ? 'stored' : 'virtual'}
                          onChange={e => setCol(i, { generatedStored: e.target.value === 'stored' })}>
                          <option value="virtual">computed</option>
                          <option value="stored">PERSISTED</option>
                        </select>
                      )}
                      {c.generated && dialect === 'clickhouse' && (
                        <select className="td-in" style={{ flex: '0 0 auto' }}
                          value={c.chExprKind === 'alias' ? 'alias' : 'materialized'}
                          onChange={e => setCol(i, { chExprKind: e.target.value === 'alias' ? 'alias' : 'materialized' })}>
                          <option value="materialized">MATERIALIZED</option>
                          <option value="alias">ALIAS</option>
                        </select>
                      )}
                    </div>
                  </td>
                  {/* ClickHouse: the compression codec list, written into
                      CODEC(…) verbatim. */}
                  {dialect === 'clickhouse' && (
                    <td><input className="td-in" value={c.codec ?? ''}
                      placeholder="ZSTD(3)"
                      onChange={e => setCol(i, { codec: e.target.value || undefined })} /></td>
                  )}
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={draft.primaryKey.includes(c.name)}
                      onChange={e => patch(d => ({
                        ...d,
                        primaryKey: e.target.checked
                          ? [...d.primaryKey, c.name]
                          : d.primaryKey.filter(n => n !== c.name),
                      }))} />
                  </td>
                  <td>
                    <button className="toolbar-btn" title="Remove this column from the design"
                      onClick={() => patch(d => ({
                        ...d,
                        columns: d.columns.filter((_, j) => j !== i),
                        primaryKey: d.primaryKey.filter(n => n !== c.name),
                      }))}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="toolbar-btn" style={{ margin: 8 }}
            onClick={() => patch(d => ({ ...d, columns: [...d.columns, emptyColumn(dialect)] }))}>
            + Add column
          </button>

          {/* ── Secondary indexes ───────────────────────────────────────
              Name, comma-separated columns, UNIQUE, and (MySQL 8 / MariaDB
              10.6+) INVISIBLE — the "soft-drop before you really drop" toggle:
              hide an index from the optimizer to test impact, without a
              rebuild. Emits ALTER INDEX … INVISIBLE/IGNORED, not a drop. */}
          {dialect === 'clickhouse' ? (
            <p className="dv-desc" style={{ padding: '4px 8px 8px' }}>
              ClickHouse data-skipping indexes (<code>minmax</code>, <code>set</code>,
              <code> bloom_filter</code>) are not modelled here — the ORDER BY key above is the
              table's real index. Manage skip indexes by hand if you need them.
            </p>
          ) : (
          <>
          <div className="td-section" style={{ padding: '4px 8px' }}>Indexes</div>
          <table className="td-table">
            <thead>
              <tr><th>Name</th><th>Columns</th><th>Unique</th>{dialect === 'mysql' && <th>Invisible</th>}<th></th></tr>
            </thead>
            <tbody>
              {draft.indexes.map((ix, i) => {
                const setIdx = (over: Partial<IndexDraft>) =>
                  patch(d => ({ ...d, indexes: d.indexes.map((x, j) => (j === i ? { ...x, ...over } : x)) }));
                return (
                  <tr key={i}>
                    <td><input className="td-in" value={ix.name}
                      onChange={e => setIdx({ name: e.target.value })} /></td>
                    <td><input className="td-in" value={ix.columns.join(', ')}
                      placeholder="col_a, col_b"
                      onChange={e => setIdx({ columns: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /></td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={ix.unique}
                        onChange={e => setIdx({ unique: e.target.checked })} /></td>
                    {dialect === 'mysql' && (
                      <td style={{ textAlign: 'center' }}
                        title="Hide from the optimizer but keep maintaining it (MySQL INVISIBLE / MariaDB IGNORED)">
                        <input type="checkbox" checked={!!ix.invisible}
                          onChange={e => setIdx({ invisible: e.target.checked })} /></td>
                    )}
                    <td><button className="toolbar-btn" title="Remove this index from the design"
                      onClick={() => patch(d => ({ ...d, indexes: d.indexes.filter((_, j) => j !== i) }))}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="toolbar-btn" style={{ margin: 8 }}
            onClick={() => patch(d => ({ ...d, indexes: [...d.indexes, { name: `idx_${d.name || 'new'}_${d.indexes.length + 1}`, columns: [], unique: false }] }))}>
            + Add index
          </button>
          </>
          )}

          {/* ── Partitions ──────────────────────────────────────────────
              MySQL/MariaDB only, and only for a table that already exists —
              PostgreSQL partitions through a different mechanism, and these
              statements alter partitioning that is already there. Each button
              stages a proposal into the change set on the right; nothing runs
              until Apply, and DROP PARTITION goes through the destructive
              confirm-word flow like any other data-deleting change. */}
          {partitioningAvailable && (
            <div className="td-partitions">
              <div className="td-section">Partitions</div>
              <p className="dv-desc" style={{ padding: '0 8px 8px' }}>
                RANGE partition changes for <code>{table}</code>. Bounds are raw SQL
                (a number, <code>MAXVALUE</code>, or an expression) — written into
                <code> VALUES LESS THAN (…)</code> verbatim. These are proposed for review,
                not applied here.
              </p>

              <div className="td-part-row">
                <label className="dg-field-inline"><span>Add</span>
                  <input className="td-in" value={addName} placeholder="partition name"
                    onChange={e => setAddName(e.target.value)} /></label>
                <label className="dg-field-inline"><span>less than</span>
                  <input className="td-in" value={addBound} placeholder="2025 / MAXVALUE"
                    onChange={e => setAddBound(e.target.value)} /></label>
                <button className="toolbar-btn" disabled={!addName.trim() || !addBound.trim()}
                  onClick={() => {
                    stage(addPartitionSql(tableRef,
                      { name: addName.trim(), valuesLessThan: addBound.trim() }, engine));
                    setAddName(''); setAddBound('');
                  }}>+ Add partition</button>
              </div>

              <div className="td-part-row">
                <label className="dg-field-inline"><span>Drop</span>
                  <input className="td-in" value={dropName} placeholder="partition name"
                    onChange={e => setDropName(e.target.value)} /></label>
                <button className="toolbar-btn td-danger" disabled={!dropName.trim()}
                  title="Deletes every row in the partition — reviewed and confirmed like any destructive change"
                  onClick={() => {
                    stage(dropPartitionSql(tableRef, dropName.trim(), engine));
                    setDropName('');
                  }}>Drop partition</button>
              </div>

              <div className="td-part-row">
                <label className="dg-field-inline"><span>Reorganize</span>
                  <input className="td-in" value={reorgFrom} placeholder="p1, p2"
                    onChange={e => setReorgFrom(e.target.value)} /></label>
                <label className="dg-field-inline"><span>into</span>
                  <input className="td-in td-type" value={reorgInto} placeholder="p1:2025, pmax:MAXVALUE"
                    onChange={e => setReorgInto(e.target.value)} /></label>
                <button className="toolbar-btn"
                  disabled={!reorgFrom.trim() || parsePartitionDefs(reorgInto).length === 0}
                  onClick={() => {
                    const from = reorgFrom.split(',').map(s => s.trim()).filter(Boolean);
                    stage(reorganizePartitionSql(tableRef, from, parsePartitionDefs(reorgInto), engine));
                    setReorgFrom(''); setReorgInto('');
                  }}>Reorganize</button>
              </div>

              {partitionChanges.length > 0 && (
                <button className="toolbar-btn" style={{ margin: 8 }}
                  onClick={() => setPartitionChanges([])}>
                  Clear {partitionChanges.length} staged partition change{partitionChanges.length === 1 ? '' : 's'}
                </button>
              )}
            </div>
          )}

          {/* PostgreSQL declarative partitions — create a fresh partition, adopt
              an existing table (ATTACH), or split one off (DETACH, non-destructive).
              Bounds are raw SQL, written verbatim. Proposed for review. */}
          {dialect === 'postgres' && !!current && (() => {
            const parent = schema ? `${schema}.${draft.originalName ?? draft.name}` : (draft.originalName ?? draft.name);
            const bound = (): PgPartitionBound =>
              pgStrategy === 'range' ? { kind: 'range', from: pgBoundA.trim(), to: pgBoundB.trim() }
              : pgStrategy === 'list' ? { kind: 'list', values: pgBoundA.trim() }
              : pgStrategy === 'hash' ? { kind: 'hash', modulus: Number(pgBoundA) || 0, remainder: Number(pgBoundB) || 0 }
              : { kind: 'default' };
            const boundValid = pgStrategy === 'default'
              || (pgStrategy === 'range' ? pgBoundA.trim() && pgBoundB.trim()
                 : pgStrategy === 'hash' ? pgBoundA.trim() && pgBoundB.trim()
                 : pgBoundA.trim());
            return (
              <div className="td-partitions">
                <div className="td-section">Partitions</div>
                <p className="dv-desc" style={{ padding: '0 8px 8px' }}>
                  Declarative partitions of <code>{parent}</code>. Bounds are raw SQL, written
                  verbatim; proposed for review, not run here.
                </p>
                <div className="td-part-row">
                  <label className="dg-field-inline"><span>Partition</span>
                    <input className="td-in" value={pgChild} placeholder="child table name"
                      onChange={e => setPgChild(e.target.value)} /></label>
                  <label className="dg-field-inline"><span>By</span>
                    <select value={pgStrategy} onChange={e => setPgStrategy(e.target.value as typeof pgStrategy)}>
                      <option value="range">RANGE</option><option value="list">LIST</option>
                      <option value="hash">HASH</option><option value="default">DEFAULT</option>
                    </select></label>
                  {pgStrategy === 'range' && <>
                    <input className="td-in" value={pgBoundA} placeholder="from" onChange={e => setPgBoundA(e.target.value)} />
                    <input className="td-in" value={pgBoundB} placeholder="to" onChange={e => setPgBoundB(e.target.value)} />
                  </>}
                  {pgStrategy === 'list' && <input className="td-in" value={pgBoundA}
                    placeholder="'DE', 'FR'" onChange={e => setPgBoundA(e.target.value)} />}
                  {pgStrategy === 'hash' && <>
                    <input className="td-in" value={pgBoundA} placeholder="modulus" onChange={e => setPgBoundA(e.target.value)} />
                    <input className="td-in" value={pgBoundB} placeholder="remainder" onChange={e => setPgBoundB(e.target.value)} />
                  </>}
                </div>
                <div className="td-part-row">
                  <button className="toolbar-btn" disabled={!pgChild.trim() || !boundValid}
                    onClick={() => stage({ kind: 'add-partition', subject: pgChild.trim(), risk: 'safe', cost: 'metadata',
                      sql: pgCreatePartitionSql(parent, pgChild.trim(), bound()) })}>+ Create partition</button>
                  <button className="toolbar-btn" disabled={!pgChild.trim() || !boundValid}
                    title="Adopt an existing table as a partition (scans it to validate the bound)"
                    onClick={() => stage({ kind: 'add-partition', subject: pgChild.trim(), risk: 'safe', cost: 'rebuild',
                      sql: pgAttachPartitionSql(parent, pgChild.trim(), bound()) })}>Attach existing</button>
                  <button className="toolbar-btn" disabled={!pgChild.trim()}
                    title="Split a partition off — its rows stay in the now-standalone table (non-destructive)"
                    onClick={() => stage({ kind: 'drop-partition', subject: pgChild.trim(), risk: 'safe', cost: 'metadata',
                      warning: 'DETACH keeps the data in the standalone table — nothing is deleted.',
                      sql: pgDetachPartitionSql(parent, pgChild.trim()) })}>Detach</button>
                </div>
                {partitionChanges.length > 0 && (
                  <button className="toolbar-btn" style={{ margin: 8 }}
                    onClick={() => setPartitionChanges([])}>
                    Clear {partitionChanges.length} staged partition change{partitionChanges.length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            );
          })()}
        </div>

        {/* ── Right: what it would do ─────────────────────────────────── */}
        <div className="td-preview">
          <div className="td-section">
            Changes
            {summary.total > 0 && <span className="td-count">{summary.total}</span>}
          </div>

          {summary.total === 0 && (
            <p className="dv-desc" style={{ padding: 12 }}>
              {draft.name.trim() ? 'The draft matches the table — nothing to apply.' : 'Name the table to begin.'}
            </p>
          )}

          {summary.headline && (
            <div className={`td-headline td-risk-${summary.destructive ? 'destructive' : summary.lossy ? 'lossy' : 'safe'}`}>
              {summary.headline}
            </div>
          )}

          <div className="td-changes">
            {changes.map((c, i) => (
              <div key={i} className={`td-change td-risk-${c.risk}${c.blocked ? ' td-blocked' : ''}`}>
                <div className="td-change-head">
                  <span className="td-kind">{c.kind.replace(/-/g, ' ')}</span>
                  <span className="td-subject">{c.subject}</span>
                  {c.blocked
                    ? <span className="td-badge td-blocked-badge">cannot alter</span>
                    : <span className={`td-badge td-risk-${c.risk}`}>{c.risk}</span>}
                  {!c.blocked && c.cost === 'rebuild'
                    && <span className="td-badge td-rebuild">rewrites rows</span>}
                </div>
                {c.blocked && <div className="td-warning">{c.blocked}</div>}
                {!c.blocked && c.warning && <div className="td-warning">{c.warning}</div>}
                {c.sql.trim() && <code className="td-sql">{c.sql}</code>}
              </div>
            ))}
          </div>

          {summary.total > 0 && (
            <div className="td-apply">
              {blockedCount > 0 && (
                <div className="td-warning" style={{ margin: '0 8px 8px' }}>
                  {blockedCount} change{blockedCount === 1 ? '' : 's'} cannot be expressed on this
                  engine — nothing is applied until the draft no longer asks for them.
                </div>
              )}
              {needsTyping && blockedCount === 0 && (
                <label className="td-confirm">
                  <span>
                    Type <code>{requiredWord}</code> to enable Apply
                    {summary.destructive > 0 && ' — this deletes data and cannot be undone'}
                  </span>
                  <input value={confirmText} onChange={e => setConfirmText(e.target.value)}
                    placeholder={requiredWord} />
                </label>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="toolbar-btn" disabled={applying || blockedCount > 0}
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: script } }));
                  }}
                  title={blockedCount > 0
                    ? 'The script is incomplete while a blocked change exists — resolve those first'
                    : 'Put the script in the editor instead of running it'}>
                  Copy to editor
                </button>
                <button
                  className={`toolbar-btn${armed && !blockedCount ? ' td-danger' : ''}`}
                  disabled={!armed || applying || blockedCount > 0}
                  title={blockedCount > 0 ? 'Resolve the blocked changes above first' : undefined}
                  onClick={() => void apply()}
                >
                  {applying ? 'Applying…' : `Apply ${summary.total} change${summary.total === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
