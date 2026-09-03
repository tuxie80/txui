/**
 * Per-connection metadata cache powering editor hints.
 * Bulk-loads EVERY object name across ALL schemas in one sweep — tables,
 * views, materialized views, procedures, functions, aggregates, triggers,
 * events. MySQL reads information_schema; PostgreSQL reads pg_catalog, because
 * information_schema omits materialized views and reports no routine_type for
 * aggregates. ClickHouse reads system.tables / system.functions; SQLite reads
 * sqlite_master and the PRAGMA table-valued functions.
 *
 * Hinting rules:
 * - MySQL — default DB chosen (roulette) → hints come strictly from that
 *   schema, inserted unqualified; no default DB → every schema's objects hint,
 *   inserted QUALIFIED ("or…" → completes to shop.orders).
 * - ClickHouse — a database is a flat namespace like MySQL's, so the same rule
 *   applies: default database chosen → its objects hint bare; none chosen →
 *   everything hints qualified. Functions are global (no database) and always
 *   hint bare.
 * - PostgreSQL — `search_path` is an ORDERED LIST, so anything on the path
 *   hints unqualified, everything else hints qualified, and an object shadowed
 *   by an earlier schema on the path is ALSO qualified (its bare name resolves
 *   to the other one). See utils/searchPath.ts. Picking a schema in the
 *   roulette makes the path exactly that schema, matching what execution
 *   injects (`SET search_path TO "<db>"`).
 * - Every object entry also carries `scopeRank` — its schema's position in the
 *   resolution order — so table contexts (FROM/JOIN/INTO/…) can hint only what
 *   a bare name resolves to. Off-path objects stay reachable via `schema.`.
 *
 * Columns stay lazy per table (fetched on `alias.` / `table.`), cached.
 * Refreshes on the 'dbgui:schema-changed' event (object-explorer ↺, DDL
 * panels) — cache cleared and re-swept.
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import type { SchemaCompletion } from '../components/SqlEditor';
import type { FkEdge } from '../utils/sqlComplete';
import { SchemaStore } from '../store/schema';
import { virtualFksFor } from '../store/virtualFks';
import { safeIdent, safePath, quoteIdent, sqlLiteral, escapeLiteral } from '../utils/sqlIdent';
import { buildResolution, isShadowed, pickCandidate, resolvesBare } from '../utils/searchPath';
import { clickhouseObjectKind } from '../utils/clickhouseMeta';

export type ColumnProvider = (table: string) => Promise<SchemaCompletion[]>;
export type FkProvider = (table: string) => Promise<FkEdge[]>;

type ObjectKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'event';

interface ObjectMeta {
  schema: string;
  name: string;
  kind: ObjectKind;
}

const MYSQL_EXCLUDE = "('information_schema','performance_schema','mysql')";
const SWEEP_CAP = 20000;   // hard row cap — a huge server must never freeze the UI
const PG_EXCLUDE = "('pg_catalog','information_schema')";
// ClickHouse exposes its catalog as ordinary databases; INFORMATION_SCHEMA is
// present under both spellings.
const CH_EXCLUDE = "('system','INFORMATION_SCHEMA','information_schema')";

/**
 * The schemas an UNQUALIFIED name actually resolves against, in resolution
 * order.
 *
 * PostgreSQL is not MySQL: `search_path` is a LIST, so several schemas can be
 * reachable without qualification at once, and the first match wins. Hinting
 * from `current_schema()` alone (the first entry) hides every object in the
 * rest of the path even though typing its bare name works.
 *
 * When the editor has a default schema selected, execution injects
 * `SET search_path TO "<db>"` before each statement, so THAT is the effective
 * path and the server's own setting is irrelevant.
 */
async function fetchSearchPath(sessionId: string, engine: string, currentDb: string): Promise<string[]> {
  if (engine !== 'postgres') return currentDb ? [currentDb] : [];
  if (currentDb) return [currentDb];
  try {
    // current_schemas(false) = the search_path entries that actually exist,
    // in order, without the implicit pg_catalog.
    const r = await invoke<QueryResult>('monitor_query', {
      sessionId, sql: 'SELECT unnest(current_schemas(false))',
    });
    return r.rows.map(row => String(row[0])).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Every schema NAME on the server — including the system ones excluded from
 * the object sweep — so `mysql.` / `pg_catalog.` etc. still hint (their
 * tables are fetched lazily on first use, see getSchemaTables).
 */
async function sweepSchemas(sessionId: string, engine: string): Promise<string[]> {
  const sql = engine === 'mysql'
    ? 'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name LIMIT 5000'
    : engine === 'postgres'
      ? "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast%' ORDER BY nspname LIMIT 5000"
      : engine === 'clickhouse'
        ? 'SELECT name FROM system.databases ORDER BY name LIMIT 5000'
        : engine === 'sqlite'
          // `main`, `temp`, and anything ATTACHed. There is no other catalog.
          ? 'SELECT name FROM pragma_database_list ORDER BY seq'
          : engine === 'duckdb'
            // information_schema.schemata, as on PG — but per current catalog;
            // the object sweep below covers every attached database at once.
            ? 'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name LIMIT 5000'
            : engine === 'sqlserver'
              // Schemas of the session's current database — there is no
              // default-DB roulette for SQL Server, so the session database
              // is the whole namespace.
              ? 'SELECT name FROM sys.schemas ORDER BY name'
              : '';
  if (!sql) return [];
  try {
    const r = await invoke<QueryResult>('monitor_query', { sessionId, sql });
    return r.rows.map(row => String(row[0]));
  } catch {
    return [];
  }
}

async function sweep(sessionId: string, engine: string): Promise<ObjectMeta[]> {
  const run = (sql: string) =>
    invoke<QueryResult>('monitor_query', { sessionId, sql });

  const out: ObjectMeta[] = [];
  const push = (r: QueryResult, kind: (row: unknown[]) => ObjectKind) => {
    for (const row of r.rows) {
      out.push({ schema: String(row[0]), name: String(row[1]), kind: kind(row) });
    }
  };

  if (engine === 'mysql') {
    const [tables, routines, triggers, events] = await Promise.all([
      run(`SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ${MYSQL_EXCLUDE} LIMIT ${SWEEP_CAP}`),
      run(`SELECT routine_schema, routine_name, routine_type FROM information_schema.routines WHERE routine_schema NOT IN ${MYSQL_EXCLUDE} LIMIT ${SWEEP_CAP}`),
      run(`SELECT trigger_schema, trigger_name FROM information_schema.triggers WHERE trigger_schema NOT IN ${MYSQL_EXCLUDE} LIMIT ${SWEEP_CAP}`),
      run(`SELECT event_schema, event_name FROM information_schema.events LIMIT ${SWEEP_CAP}`).catch(() => null),
    ]);
    push(tables, row => String(row[2]) === 'VIEW' ? 'view' : 'table');
    push(routines, row => String(row[2]) === 'FUNCTION' ? 'function' : 'procedure');
    push(triggers, () => 'trigger');
    if (events) push(events, () => 'event');
  } else if (engine === 'postgres') {
    // pg_catalog rather than information_schema: the latter omits
    // MATERIALIZED VIEWS entirely (they are queried exactly like tables, so
    // not hinting them is a real hole) and reports an empty routine_type for
    // aggregates. relkind covers ordinary + partitioned + foreign tables,
    // views and matviews in one pass.
    const [tables, routines, triggers] = await Promise.all([
      run(`SELECT n.nspname, c.relname,
                  CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'VIEW' ELSE 'BASE TABLE' END
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname NOT IN ${PG_EXCLUDE} AND n.nspname NOT LIKE 'pg\\_temp%'
             AND c.relkind IN ('r','p','v','m','f')
           LIMIT ${SWEEP_CAP}`),
      run(`SELECT n.nspname, p.proname,
                  CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname NOT IN ${PG_EXCLUDE} AND p.prokind IN ('f','p','a','w')
           LIMIT ${SWEEP_CAP}`).catch(() => null),
      run(`SELECT trigger_schema, trigger_name FROM information_schema.triggers WHERE trigger_schema NOT IN ${PG_EXCLUDE} LIMIT ${SWEEP_CAP}`).catch(() => null),
    ]);
    push(tables, row => String(row[2]) === 'VIEW' ? 'view' : 'table');
    if (routines) push(routines, row => String(row[2]) === 'FUNCTION' ? 'function' : 'procedure');
    if (triggers) push(triggers, () => 'trigger');
  } else if (engine === 'clickhouse') {
    // Everything selectable lives in system.tables — ordinary tables, the four
    // View engines, and Dictionary-engine tables (which are queried exactly
    // like tables, so omitting them would be a hole).
    const [tables, functions] = await Promise.all([
      run(`SELECT database, name, engine FROM system.tables
           WHERE database NOT IN ${CH_EXCLUDE} AND NOT is_temporary
           LIMIT ${SWEEP_CAP}`),
      // Functions are global — no database — and there are ~1500 of them, which
      // is exactly why typing them by hand is miserable. Aliases are skipped:
      // they duplicate a name that is already in the list.
      run(`SELECT '' AS db, name, if(is_aggregate, 'AGGREGATE', 'FUNCTION') AS kind
           FROM system.functions WHERE alias_to = '' ORDER BY name LIMIT ${SWEEP_CAP}`)
        .catch(() => null),
    ]);
    // MaterializedView / View / LiveView / WindowView all end in "View".
    push(tables, row => clickhouseObjectKind(String(row[2])));
    if (functions) push(functions, () => 'function');
  } else if (engine === 'sqlite') {
    // sqlite_master is PER DATABASE — there is no cross-database catalog — so
    // the attached list is read first and one UNION covers all of them.
    // Usually that is just `main`, but an ATTACHed file is invisible otherwise.
    const dbs = await sweepSchemas(sessionId, engine);
    const names = dbs.length > 0 ? dbs : ['main'];
    const union = names
      .map(d => {
        const lit = escapeLiteral(d, 'sqlite');
        const ident = quoteIdent(d, 'sqlite');
        return `SELECT '${lit}' AS db, name, type FROM ${ident}.sqlite_master
                WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'`;
      })
      .join(' UNION ALL ');
    const objs = await run(`${union} LIMIT ${SWEEP_CAP}`).catch(() => null);
    if (objs) {
      push(objs, row => {
        const t = String(row[2]);
        return t === 'view' ? 'view' : t === 'trigger' ? 'trigger' : 'table';
      });
    }
  } else if (engine === 'duckdb') {
    // The catalog table functions already span every attached database, so one
    // UNION covers tables, views and user macros. The schema is the completion
    // namespace; the catalog name is NOT folded in (names insert schema-qualified,
    // matching the tree's "main.orders" — the current catalog resolves it).
    const objs = await run(
      `SELECT schema_name, table_name, 'BASE TABLE' FROM duckdb_tables() WHERE NOT internal
       UNION ALL
       SELECT schema_name, view_name, 'VIEW' FROM duckdb_views() WHERE NOT internal
       UNION ALL
       SELECT schema_name, function_name, 'MACRO' FROM duckdb_functions()
         WHERE NOT internal AND function_type IN ('macro','table_macro')
       LIMIT ${SWEEP_CAP}`).catch(() => null);
    if (objs) {
      push(objs, row => String(row[2]) === 'VIEW' ? 'view'
        : String(row[2]) === 'MACRO' ? 'function' : 'table');
    }
  } else if (engine === 'sqlserver') {
    // Three-level engine folded into the two-level tree: the sweep covers the
    // session's current database (sys catalogs are per-database), and the
    // schema stays the completion namespace — with no default-DB roulette
    // every name inserts schema-qualified, matching the tree's folded
    // "schema.object" form. o.type: U table, V view, P procedure,
    // FN/IF/TF functions, TR trigger. is_ms_shipped keeps system objects out.
    const objs = await run(
      `SELECT TOP ${SWEEP_CAP} s.name, o.name, o.type
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.type IN ('U','V','P','FN','IF','TF','TR') AND o.is_ms_shipped = 0
       ORDER BY s.name, o.name`).catch(() => null);
    if (objs) {
      push(objs, row => {
        const t = String(row[2]);
        return t === 'V' ? 'view'
          : t === 'P' ? 'procedure'
          : t === 'TR' ? 'trigger'
          : t === 'U' ? 'table' : 'function';
      });
    }
  }
  return out;
}

const KIND_TYPE: Record<ObjectKind, SchemaCompletion['type']> = {
  table: 'table', view: 'view',
  procedure: 'keyword', function: 'keyword', trigger: 'keyword', event: 'keyword',
};

export function useSchemaCompletions(
  session: Session,
  currentDb?: string,
): {
  completions: SchemaCompletion[];
  refresh: () => void;
  getColumns: ColumnProvider;
  getFks: FkProvider;
  getSchemaTables: (schema: string) => Promise<SchemaCompletion[]>;
  /** `@@variable` completion — SHOW VARIABLES / pg_settings, fetched once */
  getServerVariables: () => Promise<{ name: string; value: string }[]>;
  /** columns some index STARTS with, per table — powers the "no index" hint */
  getIndexedColumns: (table: string) => Promise<Set<string>>;
  /** parameter list of a stored routine — powers signature help for CALL */
  getRoutineSignature: (name: string) => Promise<string | null>;
} {
  const engine = session.engine;
  const [objects, setObjects] = useState<ObjectMeta[]>([]);
  const [allSchemas, setAllSchemas] = useState<string[]>([]);
  /** Schemas an unqualified name resolves against, in resolution order. */
  const [searchPath, setSearchPath] = useState<string[]>([]);
  const searchPathRef = useRef<string[]>([]);
  useEffect(() => { searchPathRef.current = searchPath; }, [searchPath]);
  const columnCache = useRef<Map<string, SchemaCompletion[]>>(new Map());
  const fkCache = useRef<Map<string, FkEdge[]>>(new Map());
  /** Lazily-fetched tables of schemas outside the object sweep (mysql, pg_catalog, …). */
  const schemaTablesCache = useRef<Map<string, SchemaCompletion[]>>(new Map());
  const objectsRef = useRef<ObjectMeta[]>([]);
  useEffect(() => { objectsRef.current = objects; }, [objects]);
  const dbRef = useRef(currentDb ?? '');
  useEffect(() => { dbRef.current = currentDb ?? ''; }, [currentDb]);

  const refresh = useCallback(async () => {
    try {
      columnCache.current.clear();
      fkCache.current.clear();
      schemaTablesCache.current.clear();
      const [objs, schemas, path] = await Promise.all([
        sweep(session.sessionId, session.engine),
        sweepSchemas(session.sessionId, session.engine),
        fetchSearchPath(session.sessionId, session.engine, dbRef.current),
      ]);
      setObjects(objs);
      setAllSchemas(schemas);
      setSearchPath(path);
    } catch {
      // best-effort — hints simply stay stale
    }
  }, [session.sessionId, session.engine]);

  useEffect(() => {
    // sweep() is async — no synchronous setState in the effect body
    refresh();
    window.addEventListener('dbgui:schema-changed', refresh);
    return () => window.removeEventListener('dbgui:schema-changed', refresh);
  }, [refresh]);

  // Picking a schema in the roulette changes what resolves unqualified, and
  // execution injects `SET search_path TO "<db>"`, so the effective path must
  // be re-resolved without re-sweeping every object name.
  useEffect(() => {
    let cancelled = false;
    fetchSearchPath(session.sessionId, engine, currentDb ?? '')
      .then(p => { if (!cancelled) setSearchPath(p); });
    return () => { cancelled = true; };
  }, [session.sessionId, engine, currentDb]);

  // Recompute the completion list when objects or the chosen DB change
  const completions = useMemo<SchemaCompletion[]>(() => {
    const db = (currentDb ?? '').toLowerCase();
    const isPg = engine === 'postgres';
    // Resolution order + shadowing live in utils/searchPath.ts.
    const res = buildResolution(objects, searchPath);
    /**
     * The entry's position in the resolution order, riding along so the
     * completion source can scope table contexts (FROM/JOIN/INTO/…) to what a
     * bare name actually resolves to, in path order. Shadowed objects keep
     * their rank (their schema IS on the path — only the bare name is taken).
     * Engines without a multi-schema catalog (SQLite/DuckDB/Parquet) stay
     * untagged: single-catalog behavior is unchanged.
     */
    const scopedEngine = isPg || engine === 'mysql' || engine === 'clickhouse';
    const scopeRank = (o: ObjectMeta): number | undefined =>
      scopedEngine ? res.rank.get(o.schema.toLowerCase()) : undefined;
    // Some objects have no namespace at all — ClickHouse functions are global.
    // They can only ever be written bare, whatever the default database is.
    const bare = (o: ObjectMeta): boolean =>
      o.schema === '' ? true
        : isPg ? resolvesBare(o, res) : o.schema.toLowerCase() === db;
    const items: SchemaCompletion[] = [];
    // ALL schema names hint — including system ones the object sweep skips,
    // so `mysql` / `pg_catalog` complete and their `.` serves tables lazily.
    const schemas = new Set<string>(allSchemas);
    const CAP = 15000;   // bound the built list so CodeMirror/⌘K stay snappy
    for (const o of objects) {
      if (o.schema !== '') schemas.add(o.schema);
      if (items.length >= CAP) continue;   // keep collecting schema names, stop objects
      // The label is the plain name (that is what you type and filter on); the
      // INSERTED text is quoted when the bare form would not resolve — a
      // camelCase table on PG, or anything called `order`. See utils/sqlIdent.
      // A chosen database narrows the list — but never hides schema-less
      // objects, which belong to no database and are always in scope.
      if (!isPg && db && o.schema !== '' && o.schema.toLowerCase() !== db) continue;

      if (bare(o)) {
        // Reachable unqualified — insert the bare (quoted if needed) name.
        const bare = safeIdent(o.name, engine);
        items.push({
          label: o.name,
          apply: bare === o.name ? undefined : bare,
          type: KIND_TYPE[o.kind],
          kind: o.kind,
          scopeRank: scopeRank(o),
          detail: o.kind === 'table' || o.kind === 'view'
            ? (isPg && searchPath.length > 1 ? o.schema : undefined)
            : o.kind,
          info: o.schema === ''
            ? `${o.kind} · ${o.name}`
            : `${o.kind} · ${o.schema}.${o.name}${isPg ? ' · on search_path' : ''}`,
        });
      } else {
        // Not on the path, or shadowed by an earlier schema — must qualify.
        const shadowed = isPg && isShadowed(o, res);
        items.push({
          label: o.name,
          apply: safePath([o.schema, o.name], engine),
          type: KIND_TYPE[o.kind],
          kind: o.kind,
          scopeRank: scopeRank(o),
          detail: o.kind === 'table' || o.kind === 'view' ? o.schema : `${o.kind} · ${o.schema}`,
          info: `${o.kind} · ${o.schema}.${o.name}`
            + (shadowed ? ' · shadowed on search_path — must be qualified' : ''),
        });
      }
    }
    for (const s of schemas) {
      const bare = safeIdent(s, engine);
      items.push({
        label: s, type: 'database', kind: 'schema',
        apply: bare === s ? undefined : bare,
      });
    }
    return items;
  }, [objects, allSchemas, currentDb, engine, searchPath]);

  /**
   * Resolve a possibly-bare table to "schema.table" via the metadata cache:
   * prefer the chosen DB's schema, else the first schema that has the object.
   */
  const qualify = useCallback((table: string): { schema: string; name: string } | null => {
    if (table.includes('.')) {
      const [schema, ...rest] = table.split('.');
      return { schema, name: rest.join('.') };
    }
    const t = table.toLowerCase();
    const candidates = objectsRef.current.filter(o =>
      (o.kind === 'table' || o.kind === 'view') && o.name.toLowerCase() === t);
    // Same resolution rule as the completion list.
    const preferred = pickCandidate(candidates, searchPathRef.current, dbRef.current);
    return preferred ? { schema: preferred.schema, name: preferred.name } : null;
  }, []);

  // ── extra lazy providers, each cached for the session ─────────────────────
  const varsCache = useRef<Promise<{ name: string; value: string }[]> | null>(null);
  const getServerVariables = useCallback(() => {
    if (!varsCache.current) {
      // SQLite has no server variables and no `@@name` syntax at all.
      if (engine === 'sqlite') { varsCache.current = Promise.resolve([]); return varsCache.current; }
      const sql = engine === 'mysql'
        ? "SHOW VARIABLES"
        : engine === 'clickhouse'
          ? "SELECT name, value FROM system.settings ORDER BY name"
          : engine === 'duckdb'
            ? "SELECT name, value FROM duckdb_settings() ORDER BY name"
            : engine === 'sqlserver'
              ? "SELECT name, CAST(value_in_use AS nvarchar(256)) FROM sys.configurations ORDER BY name"
              : "SELECT name, setting FROM pg_settings ORDER BY name";
      varsCache.current = invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql })
        .then(r => r.rows.map(row => ({ name: String(row[0] ?? ''), value: String(row[1] ?? '') })))
        .catch(() => []);
    }
    return varsCache.current;
  }, [session.sessionId, engine]);

  const indexCache = useRef<Map<string, Promise<Set<string>>>>(new Map());
  const getIndexedColumns = useCallback((table: string) => {
    const q = qualify(table);
    const parent = q ? `${q.schema}.${q.name}` : table;
    const key = parent.toLowerCase();
    const hit = indexCache.current.get(key);
    if (hit) return hit;
    const [schema, name] = [q?.schema ?? '', q?.name ?? table];
    // Only the FIRST column of each index (plus every PK column): a predicate on
    // a later column of a composite index cannot drive a lookup.
    // ClickHouse has no B-tree indexes. What prunes data is the PRIMARY KEY
    // (a sorted prefix — only a predicate on its first column prunes granules
    // reliably), the partition key, and skip indexes over a bare column.
    // SQLite: the first column of each index (a later one cannot drive a
    // lookup), plus every PRIMARY KEY column.
    const sql = engine === 'sqlite'
      ? `SELECT x.name FROM pragma_index_list(${sqlLiteral(name, 'sqlite')}) i
         JOIN pragma_index_xinfo(i.name) x ON x.key = 1 AND x.seqno = 0
         UNION SELECT p.name FROM pragma_table_info(${sqlLiteral(name, 'sqlite')}) p
         WHERE p.pk > 0`
      : engine === 'duckdb'
      // PK columns from the constraint record. duckdb_indexes() has no column
      // list (the CREATE INDEX text would have to be parsed), and DuckDB's real
      // pruning mechanism is the zonemap, not the ART index — so secondary
      // indexes are deliberately absent rather than half-parsed.
      ? `SELECT unnest(constraint_column_names) FROM duckdb_constraints()
         WHERE schema_name = ${sqlLiteral(schema, 'duckdb')}
           AND table_name = ${sqlLiteral(name, 'duckdb')}
           AND constraint_type = 'PRIMARY KEY'`
      : engine === 'clickhouse'
      ? `SELECT name FROM system.columns
         WHERE database = ${sqlLiteral(schema, 'clickhouse')}
           AND table = ${sqlLiteral(name, 'clickhouse')}
           AND (is_in_partition_key OR (is_in_primary_key AND position = 1))
         UNION DISTINCT
         SELECT expr FROM system.data_skipping_indices
         WHERE database = ${sqlLiteral(schema, 'clickhouse')}
           AND table = ${sqlLiteral(name, 'clickhouse')}`
      : engine === 'mysql'
      ? `SELECT COLUMN_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ${sqlLiteral(schema, 'mysql')}
           AND TABLE_NAME = ${sqlLiteral(name, 'mysql')} AND SEQ_IN_INDEX = 1`
      : engine === 'sqlserver'
      // First key column of every index (a later one cannot drive a lookup),
      // plus every PRIMARY KEY column — the same contract as the other engines.
      ? `SELECT c.name FROM sys.indexes i
         JOIN sys.tables t ON t.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE s.name = ${sqlLiteral(schema, 'sqlserver')}
           AND t.name = ${sqlLiteral(name, 'sqlserver')}
           AND i.is_hypothetical = 0 AND (ic.key_ordinal = 1 OR i.is_primary_key = 1)`
      : `SELECT a.attname FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
         WHERE n.nspname = ${sqlLiteral(schema, 'postgres')} AND c.relname = ${sqlLiteral(name, 'postgres')}`;
    const p = invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql })
      .then(r => new Set(r.rows.map(row => String(row[0] ?? '').toLowerCase())))
      .catch(() => new Set<string>());
    indexCache.current.set(key, p);
    return p;
  }, [session.sessionId, engine, qualify]);

  const routineCache = useRef<Map<string, Promise<string | null>>>(new Map());
  const getRoutineSignature = useCallback((name: string) => {
    const bare = name.split('.').pop() ?? name;
    const key = bare.toLowerCase();
    const hit = routineCache.current.get(key);
    if (hit) return hit;
    const esc = escapeLiteral(bare, engine);
    // Prefer the chosen database: two schemas can hold routines of one name, and
    // showing the wrong one's parameters is worse than showing none.
    const dbFilter = dbRef.current && engine !== 'clickhouse'
      ? engine === 'mysql'
        ? ` AND r.ROUTINE_SCHEMA = ${sqlLiteral(dbRef.current, 'mysql')}`
        : ` AND n.nspname = ${sqlLiteral(dbRef.current, 'postgres')}`
      : '';
    // `syntax` is already the full call form ("toYYYYMM(datetime[, timezone])").
    // `arguments` next to it is a markdown blob — useless in a one-line hint.
    // SQLite has no stored procedures or user functions to describe; the SQL
    // Server signature query (sys.parameters) is not wired in v1 — no hint
    // beats a wrong one.
    if (engine === 'sqlite' || engine === 'sqlserver') { routineCache.current.set(key, Promise.resolve(null)); return Promise.resolve(null); }
    const sql = engine === 'clickhouse'
      ? `SELECT name, syntax FROM system.functions
         WHERE name = '${esc.replace(/\\/g, "\\\\")}' LIMIT 1`
      : engine === 'duckdb'
      // User macros: `parameters` is a LIST of the argument names.
      ? `SELECT function_name, array_to_string(parameters, ', ') FROM duckdb_functions()
         WHERE function_name = '${esc}' AND function_type IN ('macro','table_macro') LIMIT 1`
      : engine === 'mysql'
      ? `SELECT r.ROUTINE_NAME,
                GROUP_CONCAT(CONCAT(IFNULL(p.PARAMETER_MODE,''), ' ', IFNULL(p.PARAMETER_NAME,''),
                             ' ', p.DTD_IDENTIFIER) ORDER BY p.ORDINAL_POSITION SEPARATOR ', ')
         FROM information_schema.ROUTINES r
         LEFT JOIN information_schema.PARAMETERS p
           ON p.SPECIFIC_NAME = r.SPECIFIC_NAME AND p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA
              AND p.ORDINAL_POSITION > 0
         WHERE r.ROUTINE_NAME = '${esc}'${dbFilter}
         GROUP BY r.ROUTINE_NAME, r.SPECIFIC_NAME LIMIT 1`
      : `SELECT p.proname, pg_get_function_arguments(p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = '${esc}'${dbFilter} LIMIT 1`;
    const promise = invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql })
      .then(r => {
        const row = r.rows[0];
        if (!row) return null;
        const args = String(row[1] ?? '').replace(/\s+/g, ' ').trim();
        // ClickHouse's `syntax` is the whole signature, not just the arguments.
        if (engine === 'clickhouse') return args || `${row[0]}()`;
        return `${row[0]}(${args})`;
      })
      .catch(() => null);
    routineCache.current.set(key, promise);
    return promise;
  }, [session.sessionId, engine]);

  // The default-DB choice participates in bare-name resolution, so cached
  // entries keyed under an old DB's resolution must not survive a switch.
  useEffect(() => {
    columnCache.current.clear();
    fkCache.current.clear();
  }, [currentDb]);

  /** Lazy, cached column lookup for alias-aware completion (`alias.` → columns). */
  const getColumns = useCallback<ColumnProvider>(async (table: string) => {
    // Qualify FIRST and cache under the resolved name — a bare-name key would
    // serve one schema's columns after the default DB switched to another.
    const q = qualify(table);
    const parent = q ? `${q.schema}.${q.name}` : table;
    const key = parent.toLowerCase();
    const hit = columnCache.current.get(key);
    if (hit) return hit;

    try {
      const nodes = await SchemaStore.listColumns(session.sessionId, parent);
      const cols: SchemaCompletion[] = [];
      for (const n of nodes) {
        if (n.kind === 'column') {
          const bare = safeIdent(n.name, engine);
          cols.push({
            label: n.name, type: 'column', detail: n.type_name, pk: n.primary_key,
            apply: bare === n.name ? undefined : bare,
            info: [
              `${parent}.${n.name}`,
              n.type_name,
              n.nullable === false ? 'NOT NULL' : 'nullable',
              n.primary_key ? 'PRIMARY KEY' : '',
            ].filter(Boolean).join(' · '),
          });
        }
      }
      columnCache.current.set(key, cols);
      return cols;
    } catch {
      // Do NOT cache the failure (WP-13 13.4): the diagnostics layer treats a
      // cached empty set as "known to have no columns" (QueryTabs relies on
      // an empty answer only ever coming from a real one), so caching [] on a
      // transient fetch error silently disabled column completion and
      // unknown-column squiggles for this table until a manual refresh. The
      // next request simply retries.
      return [];
    }
  }, [session.sessionId, qualify, engine]);

  /**
   * Tables & views of one schema — powers `db.` → table completion.
   * Swept schemas answer from the in-memory cache; anything else (system
   * schemas like `mysql`/`pg_catalog`, or schemas created after the sweep)
   * is fetched lazily from information_schema and cached.
   */
  const getSchemaTables = useCallback(async (schema: string): Promise<SchemaCompletion[]> => {
    const s = schema.toLowerCase();
    const swept = objectsRef.current
      .filter(o => (o.kind === 'table' || o.kind === 'view') && o.schema.toLowerCase() === s)
      .map(o => ({ label: o.name, type: KIND_TYPE[o.kind], kind: o.kind } as SchemaCompletion));
    if (swept.length > 0) return swept;

    const hit = schemaTablesCache.current.get(s);
    if (hit) return hit;
    if (session.engine === 'redis') return [];

    const esc = (x: string) => escapeLiteral(x, session.engine);
    // Same reason as the bulk sweep: information_schema.tables omits
    // materialized views, so `someschema.` would silently not offer them.
    const sql = session.engine === 'sqlite'
      ? `SELECT name, upper(type) FROM ${quoteIdent(schema, 'sqlite')}.sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`
      : session.engine === 'duckdb'
      ? `SELECT table_name, 'BASE TABLE' FROM duckdb_tables()
         WHERE schema_name = '${esc(schema)}' AND NOT internal
         UNION ALL SELECT view_name, 'VIEW' FROM duckdb_views()
         WHERE schema_name = '${esc(schema)}' AND NOT internal
         ORDER BY 1`
      : session.engine === 'clickhouse'
      ? `SELECT name, if(engine LIKE '%View', 'VIEW', 'BASE TABLE') FROM system.tables
         WHERE database = '${esc(schema)}' ORDER BY name`
      : session.engine === 'postgres'
      ? `SELECT c.relname, CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'VIEW' ELSE 'BASE TABLE' END
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = '${esc(schema)}' AND c.relkind IN ('r','p','v','m','f')
         ORDER BY c.relname`
      : `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = '${esc(schema)}' ORDER BY table_name`;
    try {
      const r = await invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql });
      const items: SchemaCompletion[] = r.rows.map(row => {
        const view = String(row[1]).toUpperCase().includes('VIEW');
        return { label: String(row[0]), type: view ? 'view' : 'table', kind: view ? 'view' : 'table' };
      });
      schemaTablesCache.current.set(s, items);
      return items;
    } catch {
      // Transient failure — never cached as "schema known empty" (13.4).
      return [];
    }
  }, [session.sessionId, session.engine]);

  /**
   * FKs touching a table, both directions, lazily fetched and cached —
   * powers JOIN-clause and ON-clause suggestions.
   */
  const getFks = useCallback<FkProvider>(async (table: string) => {
    const q = qualify(table);
    if (!q) return [];
    const key = `${q.schema}.${q.name}`.toLowerCase();
    const hit = fkCache.current.get(key);
    if (hit) return hit;

    // Per-engine rules — see `escapeLiteral`. This block used to spell them
    // out inline, which is how the other call sites came to spell them out
    // differently, and wrongly.
    const esc = (v: string) => escapeLiteral(v, session.engine);
    let sql: string;
    if (session.engine === 'mysql') {
      sql = `SELECT CONSTRAINT_NAME,
                    CONCAT(TABLE_SCHEMA, '.', TABLE_NAME),
                    COLUMN_NAME,
                    CONCAT(REFERENCED_TABLE_SCHEMA, '.', REFERENCED_TABLE_NAME),
                    REFERENCED_COLUMN_NAME
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE REFERENCED_TABLE_NAME IS NOT NULL
               AND ((TABLE_SCHEMA = '${esc(q.schema)}' AND TABLE_NAME = '${esc(q.name)}')
                 OR (REFERENCED_TABLE_SCHEMA = '${esc(q.schema)}' AND REFERENCED_TABLE_NAME = '${esc(q.name)}'))
             ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`;
    } else if (session.engine === 'postgres') {
      // Quote the identifiers inside the literal — bare to_regclass('public.Users')
      // case-folds to public.users and silently misses mixed-case tables.
      const qident = (s: string) => quoteIdent(s, 'sqlite');
      const rel = esc(`${qident(q.schema)}.${qident(q.name)}`);
      sql = `SELECT c.conname,
                    c.conrelid::regclass::text,
                    (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                       FROM unnest(c.conkey) WITH ORDINALITY AS x(attnum, ord)
                       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum),
                    c.confrelid::regclass::text,
                    (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                       FROM unnest(c.confkey) WITH ORDINALITY AS x(attnum, ord)
                       JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = x.attnum)
             FROM pg_constraint c
             WHERE c.contype = 'f'
               AND (c.conrelid = to_regclass('${rel}') OR c.confrelid = to_regclass('${rel}'))`;
    } else if (session.engine === 'sqlite') {
      // Declared FKs, which SQLite records whether or not enforcement is on —
      // and enforcement defaults to OFF, so the declaration is the only thing
      // that describes the relationship. Only the child side is queryable
      // per-table, so parents are found by scanning sqlite_master.
      const lit = esc(q.name);
      const dbLit = esc(q.schema);
      const dbIdent = quoteIdent(q.schema, 'sqlite');
      // `f.id` groups the columns of one composite FK and `f.seq` orders them,
      // so the constraint key is (table, id) — SQLite gives FKs no names.
      // Table names are qualified to match what every other engine returns.
      sql = `SELECT m.name || '#' || f.id AS con,
                    '${dbLit}' || '.' || m.name AS from_t, f."from" AS from_c,
                    '${dbLit}' || '.' || f."table" AS to_t, f."to" AS to_c
             FROM ${dbIdent}.sqlite_master m JOIN pragma_foreign_key_list(m.name) f
             WHERE m.type = 'table'
               AND (m.name = '${lit}' COLLATE NOCASE
                 OR f."table" = '${lit}' COLLATE NOCASE)
             ORDER BY m.name, f.id, f.seq`;
    } else if (session.engine === 'sqlserver') {
      // One row per FK column, both directions — the mysql-style grouping path
      // below pairs the columns of composite keys. Table names are qualified
      // schema.table to match what every other engine returns.
      sql = `SELECT fk.name,
                    ps.name + '.' + pt.name,
                    pc.name,
                    rs.name + '.' + rt.name,
                    rc.name
             FROM sys.foreign_keys fk
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
             JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
             JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
             JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
             JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
             JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
             JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
             WHERE (ps.name = '${esc(q.schema)}' AND pt.name = '${esc(q.name)}')
                OR (rs.name = '${esc(q.schema)}' AND rt.name = '${esc(q.name)}')
             ORDER BY fk.name, fkc.constraint_column_id`;
    } else if (session.engine === 'duckdb') {      // FKs live in duckdb_constraints(); the column lists are LIST values,
      // joined to comma text so the rows decode like PostgreSQL's string_agg
      // form below. referenced_table is bare (same-catalog), as it resolves
      // through the search path when used.
      sql = `SELECT constraint_name,
                    schema_name || '.' || table_name,
                    array_to_string(constraint_column_names, ','),
                    referenced_table,
                    array_to_string(referenced_column_names, ',')
             FROM duckdb_constraints()
             WHERE constraint_type = 'FOREIGN KEY' AND schema_name = '${esc(q.schema)}'
               AND (table_name = '${esc(q.name)}' OR referenced_table = '${esc(q.name)}')
             ORDER BY constraint_name`;
    } else {
      return [];
    }

    try {
      const r = await invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql });
      const edges: FkEdge[] = [];
      if (session.engine === 'mysql' || session.engine === 'sqlite' || session.engine === 'sqlserver') {
        // One row per column. Constraint names are only unique per schema, so
        // key by (constraint, child table) — same-named composite FKs from two
        // schemas interleave under the ORDER BY and would mispair otherwise.
        const byCon = new Map<string, FkEdge>();
        for (const row of r.rows) {
          const [con, fromT, fromC, toT, toC] = row.map(String);
          const conKey = `${con}|${fromT}`;
          const cur = byCon.get(conKey);
          if (cur) {
            cur.fromCols.push(fromC);
            cur.toCols.push(toC);
          } else {
            const e = { fromTable: fromT, fromCols: [fromC], toTable: toT, toCols: [toC] };
            byCon.set(conKey, e);
            edges.push(e);
          }
        }
      } else {
        for (const row of r.rows) {
          edges.push({
            fromTable: String(row[1]),
            fromCols: String(row[2]).split(','),
            toTable: String(row[3]),
            toCols: String(row[4]).split(','),
          });
        }
      }
      // Virtual FKs (user-declared, local) merge in as regular edges — they
      // power the same JOIN/ON suggestions as real constraints.
      for (const v of virtualFksFor(session.connectionId, key)) {
        edges.push({ fromTable: v.fromTable, fromCols: [v.fromColumn], toTable: v.toTable, toCols: [v.toColumn] });
      }
      fkCache.current.set(key, edges);
      return edges;
    } catch {
      // Transient failure — answer with the local virtual FKs but do not
      // cache, so the real constraints are retried next time (13.4).
      const virt = virtualFksFor(session.connectionId, key).map(v => (
        { fromTable: v.fromTable, fromCols: [v.fromColumn], toTable: v.toTable, toCols: [v.toColumn] }));
      return virt;
    }
  }, [session.sessionId, session.engine, session.connectionId, qualify]);

  return {
    completions, refresh, getColumns, getFks, getSchemaTables,
    getServerVariables, getIndexedColumns, getRoutineSignature,
  };
}
