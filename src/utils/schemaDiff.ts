/**
 * Schema comparator — every object type: tables (engine/charset/collation/
 * comment), columns (type/null/default/charset/collation/extra/position),
 * indexes, constraints, views, procedures, functions, triggers, events, plus
 * the schema's own defaults. Works across two instances or two schemas on one.
 *
 * Two engines, one model: MySQL is information_schema driven, PostgreSQL is
 * pg_catalog driven (and adds materialized views, sequences and user-defined
 * types). Comparison is only ever meaningful between two snapshots of the
 * SAME engine — the panel enforces that.
 */
import { quoteIdent, safeIdent, escapeLiteral, sqlLiteral } from './sqlIdent.ts';
import type { QueryResult } from '../types';

export type Runner = (sql: string) => Promise<QueryResult>;

// ── Snapshot model ────────────────────────────────────────────────────────────

export interface ColumnInfo {
  pos: number;
  type: string;
  nullable: string;      // YES / NO
  dflt: string;          // rendered default ('' = none)
  charset: string;
  collation: string;
  extra: string;
}

export interface TableInfo {
  /** MySQL storage engine; always '' on PostgreSQL. */
  engine: string;
  /** MySQL row format; always '' on PostgreSQL. */
  rowFormat: string;
  collation: string;
  comment: string;
  /** PostgreSQL partitioning clause, e.g. "RANGE (at)"; '' when not partitioned. */
  partitionBy: string;
  columns: Map<string, ColumnInfo>;
  indexes: Map<string, string>;   // index name → "UNIQUE(a,b)" / normalized CREATE INDEX
  /** PostgreSQL only: verbatim `pg_get_indexdef` output, for migration output.
   *  The normalized form above is lowercased and schema-stripped for
   *  comparison, which is not valid DDL to hand back to a user. */
  indexDdl: Map<string, string>;
  /** MySQL: FKs only. PostgreSQL: every constraint via pg_get_constraintdef. */
  constraints: Map<string, string>;
  /** PostgreSQL only: verbatim `pg_get_constraintdef` output. The normalized
   *  map above is lowercased for comparison, which would corrupt a quoted
   *  identifier inside a CHECK expression if emitted as DDL. */
  constraintDdl: Map<string, string>;
}

export interface RoutineInfo {
  /** Display name without the argument signature. */
  name?: string;
  kind: 'PROCEDURE' | 'FUNCTION' | 'AGGREGATE' | 'WINDOW';
  params: string;
  returns: string;
  bodyNorm: string;
  security: string;
  sqlMode: string;
}

export interface Snapshot {
  engine: 'mysql' | 'postgres';
  schema: string;
  charset: string;
  collation: string;
  tables: Map<string, TableInfo>;
  views: Map<string, string>;          // name → normalized definition
  routines: Map<string, RoutineInfo>;  // key → info (PG: "name(argtypes)")
  triggers: Map<string, string>;       // name → normalized descriptor
  events: Map<string, string>;         // name → normalized descriptor (MySQL only)
  matviews: Map<string, string>;       // PostgreSQL only
  sequences: Map<string, string>;      // PostgreSQL only
  types: Map<string, string>;          // PostgreSQL only (enum/domain/composite/range)
  /** PostgreSQL only: verbatim `CREATE VIEW` text, keyed by view/matview name.
   *  The maps above hold normalized definitions for comparison, which are not
   *  valid DDL. */
  viewDdl: Map<string, string>;
  /** PostgreSQL only: table name → views/matviews that read it. A column type
   *  cannot be altered while a view depends on it, so a migration has to drop
   *  and recreate them around the ALTER. */
  viewDeps: Map<string, string[]>;
}

/** Strip DEFINER clauses and collapse whitespace so cosmetic diffs vanish. */
export function normalizeDdl(s: string): string {
  return s
    .replace(/DEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+)@(`[^`]*`|'[^']*'|\S+)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ── Snapshot fetch (MySQL) ────────────────────────────────────────────────────

export async function fetchSnapshot(run: Runner, schema: string): Promise<Snapshot> {
  const s = escapeLiteral(schema, 'mysql');

  const [schemaRow, tables, columns, indexes, fks, views, routines, params, triggers, events] =
    await Promise.all([
      run(`SELECT default_character_set_name, default_collation_name FROM information_schema.schemata WHERE schema_name='${s}'`),
      run(`SELECT table_name, COALESCE(engine,''), COALESCE(row_format,''), COALESCE(table_collation,''), COALESCE(table_comment,''), table_type FROM information_schema.tables WHERE table_schema='${s}'`),
      run(`SELECT table_name, column_name, ordinal_position, column_type, is_nullable, COALESCE(column_default,''), COALESCE(character_set_name,''), COALESCE(collation_name,''), COALESCE(extra,'') FROM information_schema.columns WHERE table_schema='${s}' ORDER BY table_name, ordinal_position`),
      // Index fingerprint carries prefix lengths (`col(10)`) and functional key
      // parts (`(expr)`) — losing them made a prefixed index diff as equal AND
      // rebuilt without its prefix. EXPRESSION exists on MySQL 8.0.13+ only,
      // so MariaDB falls back to the SUB_PART-only form.
      run(`SELECT table_name, index_name, non_unique, GROUP_CONCAT(CONCAT(COALESCE(column_name, CONCAT('(', expression, ')')), IF(sub_part IS NULL, '', CONCAT('(', sub_part, ')'))) ORDER BY seq_in_index SEPARATOR ',') FROM information_schema.statistics WHERE table_schema='${s}' GROUP BY table_name, index_name, non_unique`)
        .catch(() => run(`SELECT table_name, index_name, non_unique, GROUP_CONCAT(CONCAT(column_name, IF(sub_part IS NULL, '', CONCAT('(', sub_part, ')'))) ORDER BY seq_in_index SEPARATOR ',') FROM information_schema.statistics WHERE table_schema='${s}' GROUP BY table_name, index_name, non_unique`)),
      run(`SELECT kcu.table_name, kcu.constraint_name, GROUP_CONCAT(kcu.column_name ORDER BY kcu.ordinal_position SEPARATOR ','), kcu.referenced_table_name, GROUP_CONCAT(kcu.referenced_column_name ORDER BY kcu.ordinal_position SEPARATOR ','), rc.update_rule, rc.delete_rule FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_schema=kcu.constraint_schema AND rc.constraint_name=kcu.constraint_name AND rc.table_name=kcu.table_name WHERE kcu.table_schema='${s}' AND kcu.referenced_table_name IS NOT NULL GROUP BY kcu.table_name, kcu.constraint_name, kcu.referenced_table_name, rc.update_rule, rc.delete_rule`),
      run(`SELECT table_name, view_definition FROM information_schema.views WHERE table_schema='${s}'`),
      run(`SELECT routine_name, routine_type, COALESCE(dtd_identifier,''), COALESCE(routine_definition,''), security_type, COALESCE(sql_mode,'') FROM information_schema.routines WHERE routine_schema='${s}'`),
      run(`SELECT specific_name, GROUP_CONCAT(CONCAT(COALESCE(parameter_mode,''),' ',COALESCE(parameter_name,''),' ',dtd_identifier) ORDER BY ordinal_position SEPARATOR ', ') FROM information_schema.parameters WHERE specific_schema='${s}' AND parameter_name IS NOT NULL GROUP BY specific_name`),
      run(`SELECT trigger_name, action_timing, event_manipulation, event_object_table, action_statement FROM information_schema.triggers WHERE trigger_schema='${s}'`),
      run(`SELECT event_name, event_type, COALESCE(execute_at,''), COALESCE(interval_value,''), COALESCE(interval_field,''), status, COALESCE(event_definition,'') FROM information_schema.events WHERE event_schema='${s}'`),
    ]);

  const snap: Snapshot = {
    engine: 'mysql',
    schema,
    charset: String(schemaRow.rows[0]?.[0] ?? ''),
    collation: String(schemaRow.rows[0]?.[1] ?? ''),
    tables: new Map(),
    views: new Map(),
    routines: new Map(),
    triggers: new Map(),
    events: new Map(),
    matviews: new Map(),
    sequences: new Map(),
    types: new Map(),
    viewDdl: new Map(),
    viewDeps: new Map(),
  };

  for (const r of tables.rows) {
    if (String(r[5]) !== 'BASE TABLE') continue; // views handled separately
    snap.tables.set(String(r[0]), {
      engine: String(r[1]),
      rowFormat: String(r[2]),
      collation: String(r[3]),
      comment: String(r[4]),
      columns: new Map(),
      indexes: new Map(),
      partitionBy: '',
      indexDdl: new Map(),
      constraints: new Map(),
      constraintDdl: new Map(),
    });
  }
  for (const r of columns.rows) {
    const t = snap.tables.get(String(r[0]));
    if (!t) continue;
    t.columns.set(String(r[1]), {
      pos: Number(r[2]),
      type: String(r[3]),
      nullable: String(r[4]),
      dflt: String(r[5]),
      charset: String(r[6]),
      collation: String(r[7]),
      extra: String(r[8]),
    });
  }
  for (const r of indexes.rows) {
    const t = snap.tables.get(String(r[0]));
    if (!t) continue;
    const unique = Number(r[2]) === 0 ? 'UNIQUE' : '';
    t.indexes.set(String(r[1]), `${unique}(${r[3]})`);
  }
  for (const r of fks.rows) {
    const t = snap.tables.get(String(r[0]));
    if (!t) continue;
    t.constraints.set(String(r[1]), `(${r[2]}) → ${r[3]}(${r[4]}) ON UPDATE ${r[5]} ON DELETE ${r[6]}`);
  }
  for (const r of views.rows) {
    snap.views.set(String(r[0]), normalizeDdl(String(r[1] ?? '')));
  }
  const paramMap = new Map<string, string>();
  for (const r of params.rows) paramMap.set(String(r[0]), String(r[1]));
  for (const r of routines.rows) {
    const name = String(r[0]);
    snap.routines.set(name.toLowerCase(), {
      kind: String(r[1]) as 'PROCEDURE' | 'FUNCTION',
      params: paramMap.get(name) ?? '',
      returns: String(r[2]),
      bodyNorm: normalizeDdl(String(r[3])),
      security: String(r[4]),
      sqlMode: String(r[5]),
    });
  }
  for (const r of triggers.rows) {
    snap.triggers.set(String(r[0]),
      normalizeDdl(`${r[1]} ${r[2]} ON ${r[3]} ${r[4]}`));
  }
  for (const r of events.rows) {
    snap.events.set(String(r[0]),
      normalizeDdl(`${r[1]} at=${r[2]} every=${r[3]} ${r[4]} status=${r[5]} do ${r[6]}`));
  }
  return snap;
}


// ── Snapshot fetch (PostgreSQL) ───────────────────────────────────────────────

/**
 * Catalog output is schema-qualified (`ON txui_demo.customers`), so comparing
 * two DIFFERENT schemas would report every index, view and trigger as changed.
 * Stripping the owning schema makes the comparison structural.
 */
function schemaStripper(schema: string): (sql: string) => string {
  const q = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bare = new RegExp(`\\b${q}\\.`, 'g');
  const quoted = new RegExp(`"${q}"\\.`, 'g');
  return sql => sql.replace(bare, '').replace(quoted, '');
}

export async function fetchSnapshotPg(run: Runner, schema: string): Promise<Snapshot> {
  const s = escapeLiteral(schema, 'postgres');
  // Compile the strip regexes once per snapshot, not once per column.
  const strip = schemaStripper(schema);
  const norm = (v: unknown) => normalizeDdl(strip(String(v ?? '')));

  // attidentity is PG 10+, attgenerated PG 12+. Naming a column that does not
  // exist fails the whole statement, so the projection is built per version.
  const verRow = await run(`SELECT current_setting('server_version_num')`);
  const verNum = Number(verRow.rows[0]?.[0] ?? 0);
  const identityExpr = verNum >= 100000
    ? `CASE a.attidentity WHEN 'a' THEN 'identity always' WHEN 'd' THEN 'identity by default' ELSE '' END`
    : `''`;
  const generatedExpr = verNum >= 120000
    ? `CASE a.attgenerated WHEN 's' THEN ' generated stored' ELSE '' END`
    : `''`;

  const [dbRow, tables, columns, indexes, constraints, views, matviews, routines, triggers, sequences, viewDeps, types] =
    await Promise.all([
      run(`SELECT pg_encoding_to_char(encoding), datcollate FROM pg_database WHERE datname = current_database()`),
      run(`SELECT c.relname, COALESCE(obj_description(c.oid,'pg_class'),''), COALESCE(pg_get_partkeydef(c.oid),''), c.relkind::text
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname='${s}' AND c.relkind IN ('r','p')`),
      run(`SELECT c.relname, a.attname, a.attnum,
                  pg_catalog.format_type(a.atttypid, a.atttypmod),
                  CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,
                  COALESCE(pg_get_expr(d.adbin, d.adrelid),''),
                  COALESCE((SELECT cl.collname FROM pg_collation cl
                            WHERE cl.oid = a.attcollation AND cl.collname <> 'default'),''),
                  trim(${identityExpr} || ${generatedExpr})
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
           WHERE n.nspname='${s}' AND c.relkind IN ('r','p')
             AND a.attnum > 0 AND NOT a.attisdropped
           ORDER BY c.relname, a.attnum`),
      run(`SELECT c.relname, i.relname, pg_get_indexdef(ix.indexrelid)
           FROM pg_index ix
           JOIN pg_class c ON c.oid = ix.indrelid
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname='${s}'`),
      // contype 'n' is PostgreSQL 18's new catalog entry for NOT NULL. It is
      // already captured per-column via attnotnull, and older servers do not
      // have it — including it would report dozens of phantom differences
      // when comparing a pre-18 schema against an 18 one.
      run(`SELECT c.relname, con.conname, pg_get_constraintdef(con.oid)
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname='${s}' AND con.contype <> 'n'`),
      run(`SELECT c.relname, pg_get_viewdef(c.oid, true) FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname='${s}' AND c.relkind='v'`),
      run(`SELECT c.relname, pg_get_viewdef(c.oid, true) FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname='${s}' AND c.relkind='m'`),
      run(`SELECT p.proname, pg_get_function_identity_arguments(p.oid),
                  CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE'
                                 WHEN 'w' THEN 'WINDOW' ELSE 'FUNCTION' END,
                  pg_get_function_arguments(p.oid), pg_get_function_result(p.oid),
                  COALESCE(p.prosrc,''),
                  CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END, l.lanname
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_language l ON l.oid = p.prolang
           WHERE n.nspname='${s}'`),
      run(`SELECT t.tgname, pg_get_triggerdef(t.oid, true)
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname='${s}' AND NOT t.tgisinternal`),
      run(`SELECT sequencename,
                  format('as %s start %s inc %s min %s max %s cache %s cycle %s',
                         data_type, start_value, increment_by, min_value, max_value, cache_size, cycle)
           FROM pg_sequences WHERE schemaname='${s}'`),
      run(`SELECT DISTINCT t.relname, v.relname
           FROM pg_depend d
           JOIN pg_rewrite r ON r.oid = d.objid
           JOIN pg_class v ON v.oid = r.ev_class
           JOIN pg_class t ON t.oid = d.refobjid
           JOIN pg_namespace n ON n.oid = v.relnamespace
           WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
             AND v.relkind IN ('v','m') AND t.relkind IN ('r','p') AND v.oid <> t.oid
             AND n.nspname='${s}'`),
      run(`SELECT t.typname, t.typtype::text,
                  COALESCE((SELECT string_agg(quote_literal(e.enumlabel), ',' ORDER BY e.enumsortorder)
                            FROM pg_enum e WHERE e.enumtypid = t.oid),''),
                  COALESCE(pg_catalog.format_type(t.typbasetype, t.typtypmod),'')
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname='${s}' AND t.typtype IN ('e','d','c','r')
             AND (t.typrelid = 0 OR (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c')
             AND NOT EXISTS (SELECT 1 FROM pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid)`),
    ]);

  const snap: Snapshot = {
    engine: 'postgres',
    schema,
    // PostgreSQL has no per-schema charset; encoding and collation are
    // database-wide, which is still the meaningful thing to compare.
    charset: String(dbRow.rows[0]?.[0] ?? ''),
    collation: String(dbRow.rows[0]?.[1] ?? ''),
    tables: new Map(),
    views: new Map(),
    routines: new Map(),
    triggers: new Map(),
    events: new Map(),
    matviews: new Map(),
    sequences: new Map(),
    types: new Map(),
    viewDdl: new Map(),
    viewDeps: new Map(),
  };

  for (const r of tables.rows) {
    snap.tables.set(String(r[0]), {
      engine: '',
      rowFormat: '',
      collation: '',
      comment: String(r[1] ?? ''),
      partitionBy: String(r[2] ?? ''),
      columns: new Map(),
      indexes: new Map(),
      indexDdl: new Map(),
      constraints: new Map(),
      constraintDdl: new Map(),
    });
  }
  for (const r of columns.rows) {
    const t = snap.tables.get(String(r[0]));
    if (!t) continue;
    t.columns.set(String(r[1]), {
      pos: Number(r[2]),
      type: strip(String(r[3])),
      nullable: String(r[4]),
      dflt: strip(String(r[5] ?? '')),
      charset: '',
      collation: String(r[6] ?? ''),
      extra: String(r[7] ?? ''),
    });
  }
  for (const r of indexes.rows) {
    const t = snap.tables.get(String(r[0]));
    if (!t) continue;
    t.indexes.set(String(r[1]), norm(r[2]));
    t.indexDdl.set(String(r[1]), String(r[2] ?? '').trim());
  }
  for (const r of constraints.rows) {
    const t = snap.tables.get(String(r[0]));
    if (!t) continue;
    t.constraints.set(String(r[1]), norm(r[2]));
    t.constraintDdl.set(String(r[1]), String(r[2] ?? '').trim());
  }
  for (const r of views.rows) {
    snap.views.set(String(r[0]), norm(r[1]));
    snap.viewDdl.set(String(r[0]),
      `CREATE OR REPLACE VIEW ${pq(schema)}.${pq(String(r[0]))} AS\n${String(r[1] ?? '').trim()}`);
  }
  for (const r of matviews.rows) {
    snap.matviews.set(String(r[0]), norm(r[1]));
    snap.viewDdl.set(String(r[0]),
      `CREATE MATERIALIZED VIEW ${pq(schema)}.${pq(String(r[0]))} AS\n${String(r[1] ?? '').trim()}`);
  }
  for (const r of viewDeps.rows) {
    const table = String(r[0]);
    const view = String(r[1]);
    const deps = snap.viewDeps.get(table);
    if (deps) deps.push(view); else snap.viewDeps.set(table, [view]);
  }
  for (const r of triggers.rows) snap.triggers.set(String(r[0]), norm(r[1]));
  for (const r of sequences.rows) snap.sequences.set(String(r[0]), String(r[1] ?? ''));

  for (const r of routines.rows) {
    const name = String(r[0]);
    const identityArgs = String(r[1] ?? '');
    // Overloads are distinct objects, so the key carries the signature.
    snap.routines.set(`${name}(${strip(identityArgs)})`, {
      name,
      kind: String(r[2]) as RoutineInfo['kind'],
      params: strip(String(r[3] ?? '')),
      returns: strip(String(r[4] ?? '')),
      bodyNorm: normalizeDdl(String(r[5] ?? '')),
      security: String(r[6] ?? ''),
      sqlMode: String(r[7] ?? ''),   // language on PostgreSQL
    });
  }

  for (const r of types.rows) {
    const kind = String(r[1]);
    const label = kind === 'e' ? `ENUM(${r[2]})`
      : kind === 'd' ? `DOMAIN ${r[3]}`
      : kind === 'r' ? 'RANGE'
      : 'COMPOSITE';
    snap.types.set(String(r[0]), label);
  }

  return snap;
}

/** Dispatch on engine — the only place a caller needs to know the difference. */
export function fetchSnapshotFor(
  run: Runner, schema: string, engine: 'mysql' | 'postgres',
): Promise<Snapshot> {
  return engine === 'postgres' ? fetchSnapshotPg(run, schema) : fetchSnapshot(run, schema);
}

// ── Diff ──────────────────────────────────────────────────────────────────────

export type ObjectKind =
  | 'schema' | 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'event'
  | 'matview' | 'sequence' | 'type';

export type DiffStatus = 'only_left' | 'only_right' | 'different' | 'same';

export interface DiffEntry {
  kind: ObjectKind;
  name: string;
  status: DiffStatus;
  /** property-level explanations for 'different' entries */
  details: string[];
}

function diffMaps<T>(
  kind: ObjectKind,
  left: Map<string, T>,
  right: Map<string, T>,
  compare: (name: string, l: T, r: T) => string[],
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const names = new Set([...left.keys(), ...right.keys()]);
  for (const name of [...names].sort()) {
    const l = left.get(name);
    const r = right.get(name);
    if (l === undefined) out.push({ kind, name, status: 'only_right', details: [] });
    else if (r === undefined) out.push({ kind, name, status: 'only_left', details: [] });
    else {
      const details = compare(name, l, r);
      out.push({ kind, name, status: details.length ? 'different' : 'same', details });
    }
  }
  return out;
}

function compareColumn(name: string, l: ColumnInfo, r: ColumnInfo, isPg = false): string[] {
  const d: string[] = [];
  if (l.type !== r.type) d.push(`column ${name}: type ${l.type} ↔ ${r.type}`);
  if (l.nullable !== r.nullable) d.push(`column ${name}: nullable ${l.nullable} ↔ ${r.nullable}`);
  if (l.dflt !== r.dflt) d.push(`column ${name}: default '${l.dflt}' ↔ '${r.dflt}'`);
  if (l.charset !== r.charset) d.push(`column ${name}: charset ${l.charset || '—'} ↔ ${r.charset || '—'}`);
  else if (l.collation !== r.collation) d.push(`column ${name}: collation ${l.collation || '—'} ↔ ${r.collation || '—'}`);
  if (l.extra !== r.extra) d.push(`column ${name}: extra '${l.extra}' ↔ '${r.extra}'`);
  // Column ORDER is deliberately ignored on PostgreSQL. ADD COLUMN always
  // appends and there is no way to reposition a column, so a schema that has
  // just been migrated successfully would still report drift forever — which
  // makes the comparator useless for verifying a migration landed. MySQL can
  // reorder (MODIFY … AFTER), so there it stays a real, fixable difference.
  if (!isPg && l.pos !== r.pos) d.push(`column ${name}: position ${l.pos} ↔ ${r.pos}`);
  return d;
}

function compareTable(_name: string, l: TableInfo, r: TableInfo, isPg = false): string[] {
  const d: string[] = [];
  // engine/rowFormat are MySQL concepts and stay '' on PostgreSQL, so these
  // comparisons are naturally inert there rather than needing an engine flag.
  if (l.engine !== r.engine) d.push(`engine ${l.engine} ↔ ${r.engine}`);
  if (l.collation !== r.collation) d.push(`table collation ${l.collation} ↔ ${r.collation}`);
  if (l.rowFormat !== r.rowFormat) d.push(`row_format ${l.rowFormat} ↔ ${r.rowFormat}`);
  if (l.partitionBy !== r.partitionBy) {
    d.push(`partitioning ${l.partitionBy || 'none'} ↔ ${r.partitionBy || 'none'}`);
  }
  if (l.comment !== r.comment) d.push(`comment differs`);

  const colNames = new Set([...l.columns.keys(), ...r.columns.keys()]);
  for (const c of [...colNames].sort()) {
    const lc = l.columns.get(c);
    const rc = r.columns.get(c);
    if (!lc) d.push(`column ${c}: only RIGHT`);
    else if (!rc) d.push(`column ${c}: only LEFT`);
    else d.push(...compareColumn(c, lc, rc, isPg));
  }
  const idxNames = new Set([...l.indexes.keys(), ...r.indexes.keys()]);
  for (const i of [...idxNames].sort()) {
    const li = l.indexes.get(i);
    const ri = r.indexes.get(i);
    if (li === undefined) d.push(`index ${i}: only RIGHT ${ri}`);
    else if (ri === undefined) d.push(`index ${i}: only LEFT ${li}`);
    else if (li !== ri) d.push(`index ${i}: ${li} ↔ ${ri}`);
  }
  const fkNames = new Set([...l.constraints.keys(), ...r.constraints.keys()]);
  for (const f of [...fkNames].sort()) {
    const lf = l.constraints.get(f);
    const rf = r.constraints.get(f);
    if (lf === undefined) d.push(`constraint ${f}: only RIGHT ${rf}`);
    else if (rf === undefined) d.push(`constraint ${f}: only LEFT ${lf}`);
    else if (lf !== rf) d.push(`constraint ${f}: ${lf} ↔ ${rf}`);
  }
  return d;
}

export function diffSnapshots(left: Snapshot, right: Snapshot): DiffEntry[] {
  const out: DiffEntry[] = [];

  const schemaDetails: string[] = [];
  if (left.charset !== right.charset) schemaDetails.push(`default charset ${left.charset} ↔ ${right.charset}`);
  if (left.collation !== right.collation) schemaDetails.push(`default collation ${left.collation} ↔ ${right.collation}`);
  out.push({
    kind: 'schema',
    name: `${left.schema} ↔ ${right.schema}`,
    status: schemaDetails.length ? 'different' : 'same',
    details: schemaDetails,
  });

  const isPg = left.engine === 'postgres';
  out.push(...diffMaps('table', left.tables, right.tables,
    (n, l, r) => compareTable(n, l, r, isPg)));
  out.push(...diffMaps('view', left.views, right.views,
    (_n, l, r) => (l !== r ? ['definition differs'] : [])));
  // routines split by kind
  const routineEntries = diffMaps('procedure', left.routines, right.routines, (_n, l, r) => {
    const d: string[] = [];
    if (l.kind !== r.kind) d.push(`kind ${l.kind} ↔ ${r.kind}`);
    if (l.params !== r.params) d.push(`parameters: (${l.params}) ↔ (${r.params})`);
    if (l.returns !== r.returns) d.push(`returns ${l.returns || '—'} ↔ ${r.returns || '—'}`);
    if (l.bodyNorm !== r.bodyNorm) d.push('body differs');
    if (l.security !== r.security) d.push(`security ${l.security} ↔ ${r.security}`);
    if (l.sqlMode !== r.sqlMode) d.push(`sql_mode/language ${l.sqlMode} ↔ ${r.sqlMode}`);
    return d;
  }).map(e => {
    const info = left.routines.get(e.name) ?? right.routines.get(e.name);
    // AGGREGATE/WINDOW are function-shaped for display purposes.
    return { ...e, kind: (info?.kind === 'PROCEDURE' ? 'procedure' : 'function') as ObjectKind };
  });
  out.push(...routineEntries);
  out.push(...diffMaps('trigger', left.triggers, right.triggers,
    (_n, l, r) => (l !== r ? ['definition differs'] : [])));
  out.push(...diffMaps('event', left.events, right.events,
    (_n, l, r) => (l !== r ? ['definition differs'] : [])));

  // PostgreSQL-only families. Both maps are empty on MySQL, so diffMaps
  // returns nothing and no MySQL comparison grows spurious rows.
  out.push(...diffMaps('matview', left.matviews, right.matviews,
    (_n, l, r) => (l !== r ? ['definition differs'] : [])));
  out.push(...diffMaps('sequence', left.sequences, right.sequences,
    (_n, l, r) => (l !== r ? [`${l} ↔ ${r}`] : [])));
  out.push(...diffMaps('type', left.types, right.types,
    (_n, l, r) => (l !== r ? [`${l} ↔ ${r}`] : [])));

  return out;
}

// ── Migration script ──────────────────────────────────────────────────────────

const q = (s: string) => quoteIdent(s, 'mysql');


/**
 * Render an index fingerprint's key list back to DDL, quoting every column.
 * A part is `col`, `col(10)` (prefix length) or `(expr)` (functional key
 * part, kept verbatim — MySQL requires the parens). Splitting happens at
 * paren depth 0 only: a functional part's expression may itself contain
 * commas.
 */
function indexKeyParts(fingerprint: string): string {
  const list = fingerprint.replace(/^UNIQUE/, '').slice(1, -1);
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map(part => {
    const t = part.trim();
    if (t.startsWith('(')) return t;                        // functional key part
    const m = /^(.*?)\((\d+)\)$/.exec(t);
    if (m) return `${quoteIdent(m[1], 'mysql')}(${m[2]})`;  // prefix length
    return quoteIdent(t, 'mysql');
  }).join(', ');
}

function columnDdl(name: string, c: ColumnInfo): string {
  const parts = [q(name), c.type];
  if (c.charset) parts.push(`CHARACTER SET ${c.charset} COLLATE ${c.collation}`);
  parts.push(c.nullable === 'YES' ? 'NULL' : 'NOT NULL');
  if (c.dflt !== '') {
    // information_schema.columns stores plain STRING defaults unquoted, so
    // "letter-leading ⇒ raw expression" emitted `DEFAULT active` — a syntax
    // error (or worse, the wrong thing) for every letter-leading string
    // default. Allowlist instead: only known expression forms pass raw —
    // CURRENT_TIMESTAMP (optional precision), NULL, and expression defaults
    // MySQL flags via extra containing DEFAULT_GENERATED (emitted
    // parenthesized, MySQL 8's required spelling). Everything else is a
    // literal and goes through sqlLiteral.
    const isKeywordExpr = /^current_timestamp(\(\d*\))?$/i.test(c.dflt) || /^null$/i.test(c.dflt);
    const isGenerated = /default_generated/i.test(c.extra);
    parts.push(`DEFAULT ${
      isKeywordExpr ? c.dflt
        : isGenerated ? (c.dflt.startsWith('(') ? c.dflt : `(${c.dflt})`)
          : sqlLiteral(c.dflt, 'mysql')}`);
  }
  // DEFAULT_GENERATED is information_schema metadata, not DDL — it marks the
  // default as an expression (consumed above) and must not be re-emitted.
  const extra = c.extra.replace(/default_generated/ig, '').trim();
  if (extra) parts.push(extra.toUpperCase());
  return parts.join(' ');
}

/** PostgreSQL identifier quoting. */
const pq = (s: string) => quoteIdent(s, 'postgres');

/** Quote the name half of `name(argtypes)` — the signature stays verbatim. */
function quoteRoutineSig(sig: string): string {
  const i = sig.indexOf('(');
  return i >= 0 ? `${pq(sig.slice(0, i))}${sig.slice(i)}` : pq(sig);
}

/** Rewrite `from.` → `to.` in catalog DDL so it applies to the target schema.
 *  Local regexes (this module is documented pure — no mutable module state);
 *  the bare form quotes the target only when PG would fold or reject it bare
 *  (safeIdent), the quoted form always re-quotes. */
function retargetSchema(ddl: string, from: string, to: string): string {
  const q = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bare = new RegExp(`\\b${q}\\.`, 'g');
  const quoted = new RegExp(`"${q}"\\.`, 'g');
  return ddl
    .replace(bare, `${safeIdent(to, 'postgres')}.`)
    .replace(quoted, `${pq(to)}.`);
}

/**
 * PostgreSQL migration. Deliberately separate from the MySQL generator rather
 * than a set of branches: the two dialects differ in almost every statement —
 * ALTER COLUMN instead of MODIFY COLUMN, indexes as standalone statements
 * rather than inline clauses, constraints named explicitly, no DELIMITER, and
 * DROP FUNCTION requiring the argument signature to resolve an overload.
 *
 * Reviewed by a human, never auto-executed.
 */
async function generateMigrationPg(
  diff: DiffEntry[],
  left: Snapshot,
  right: Snapshot,
  getLeftDdl: (name: string) => Promise<string>,
): Promise<string> {
  const out: string[] = [
    `-- Migration: make ${right.schema} match ${left.schema}`,
    `-- Generated by dbgui — REVIEW BEFORE RUNNING. Order may need adjustment (FKs, types).`,
    `-- Target schema: ${right.schema}`,
    '',
  ];
  const target = (name: string) => `${pq(right.schema)}.${pq(name)}`;
  // Views recreated as collateral of a table ALTER — skipped in their own pass.
  const recreated: string[] = [];

  // Types and sequences first: a table may depend on them.
  for (const e of diff) {
    if (e.status === 'same') continue;
    if (e.kind !== 'type' && e.kind !== 'sequence') continue;
    if (e.status === 'only_left') {
      try {
        out.push(`-- ${e.kind} ${e.name} missing on target`, (await getLeftDdl(e.name)).replace(/;?\s*$/, ';'), '');
      } catch {
        out.push(`-- ${e.kind} ${e.name} missing on target (DDL lookup failed)`, '');
      }
    } else if (e.status === 'only_right') {
      out.push(`DROP ${e.kind === 'type' ? 'TYPE' : 'SEQUENCE'} IF EXISTS ${target(e.name)};`, '');
    } else {
      // Altering an enum in place is version- and order-sensitive; changing a
      // sequence's type may not be possible at all. Flag, do not guess.
      out.push(`-- ${e.kind} ${e.name} differs (${e.details.join('; ')}) — no automatic change generated`, '');
    }
  }

  for (const e of diff) {
    if (e.status === 'same') continue;

    if (e.kind === 'schema') {
      if (e.status === 'different') {
        out.push(`-- database encoding/collation differ: ${e.details.join('; ')}`,
                 `-- Not alterable in place — this is fixed at CREATE DATABASE time.`, '');
      }
      continue;
    }

    if (e.kind === 'table') {
      if (e.status === 'only_left') {
        try {
          out.push(`-- table ${e.name} missing on target`, (await getLeftDdl(e.name)).replace(/;?\s*$/, ';'), '');
        } catch {
          out.push(`-- table ${e.name} missing on target (DDL lookup failed)`, '');
        }
      } else if (e.status === 'only_right') {
        out.push(`-- table ${e.name} exists only on target`, `DROP TABLE ${target(e.name)};`, '');
      } else {
        const lt = left.tables.get(e.name)!;
        const rt = right.tables.get(e.name)!;
        const alters: string[] = [];
        const after: string[] = [];
        let retypes = false;

        for (const [c, lc] of lt.columns) {
          const rc = rt.columns.get(c);
          if (!rc) {
            const nn = lc.nullable === 'NO' ? ' NOT NULL' : '';
            const df = lc.dflt ? ` DEFAULT ${lc.dflt}` : '';
            alters.push(`ADD COLUMN ${pq(c)} ${lc.type}${df}${nn}`);
            continue;
          }
          // Each property is its own ALTER COLUMN action in PostgreSQL.
          if (lc.type !== rc.type) {
            alters.push(`ALTER COLUMN ${pq(c)} TYPE ${lc.type} /* USING ${pq(c)}::${lc.type} */`);
            retypes = true;
          }
          if (lc.nullable !== rc.nullable) {
            alters.push(`ALTER COLUMN ${pq(c)} ${lc.nullable === 'NO' ? 'SET' : 'DROP'} NOT NULL`);
          }
          if (lc.dflt !== rc.dflt) {
            alters.push(lc.dflt
              ? `ALTER COLUMN ${pq(c)} SET DEFAULT ${lc.dflt}`
              : `ALTER COLUMN ${pq(c)} DROP DEFAULT`);
          }
        }
        for (const c of rt.columns.keys()) {
          if (!lt.columns.has(c)) alters.push(`DROP COLUMN ${pq(c)}`);
        }

        // Constraints ride along in the same ALTER; pg_get_constraintdef output
        // is already a valid ADD CONSTRAINT body.
        for (const [n, lc] of lt.constraints) {
          const rc = rt.constraints.get(n);
          const def = lt.constraintDdl.get(n) ?? lc;
          if (!rc) alters.push(`ADD CONSTRAINT ${pq(n)} ${def}`);
          else if (rc !== lc) {
            alters.push(`DROP CONSTRAINT ${pq(n)}`, `ADD CONSTRAINT ${pq(n)} ${def}`);
          }
        }
        for (const n of rt.constraints.keys()) {
          if (!lt.constraints.has(n)) alters.push(`DROP CONSTRAINT ${pq(n)}`);
        }

        // Indexes are standalone statements, and CONCURRENTLY cannot run
        // inside the same transaction as the ALTER — so they follow it.
        for (const [i, li] of lt.indexes) {
          if (lt.constraints.has(i)) continue; // constraint-backed: handled above
          const ri = rt.indexes.get(i);
          if (!ri || ri !== li) {
            if (ri) after.push(`DROP INDEX IF EXISTS ${pq(right.schema)}.${pq(i)};`);
            const ddl = lt.indexDdl.get(i);
            after.push(ddl
              // Retarget the source schema at the destination.
              ? `${retargetSchema(ddl, left.schema, right.schema)};`
              : `-- could not render CREATE INDEX ${i}`);
          }
        }
        for (const i of rt.indexes.keys()) {
          if (!lt.indexes.has(i) && !rt.constraints.has(i)) {
            after.push(`DROP INDEX IF EXISTS ${pq(right.schema)}.${pq(i)};`);
          }
        }

        // PostgreSQL refuses `ALTER COLUMN … TYPE` while a view reads that
        // column ("cannot alter type of a column used by a view or rule"), so
        // dependent views are dropped first and recreated afterwards. Only a
        // type change triggers this — SET NOT NULL and friends are fine.
        const deps = retypes ? (right.viewDeps.get(e.name) ?? []) : [];
        if (deps.length) {
          out.push(`-- ${e.name}: dropping ${deps.length} dependent view(s) so the column type can change`);
          for (const v of deps) {
            const isMat = right.matviews.has(v);
            out.push(`DROP ${isMat ? 'MATERIALIZED VIEW' : 'VIEW'} IF EXISTS ${target(v)};`);
          }
        }

        if (alters.length) {
          out.push(`-- ${e.name}: ${e.details.length} difference${e.details.length === 1 ? '' : 's'}`);
          out.push(`ALTER TABLE ${target(e.name)}`);
          out.push('  ' + alters.join(',\n  ') + ';');
        }
        if (after.length) out.push(...after);

        for (const v of deps) {
          // Recreate from the SOURCE definition — that is the shape being
          // migrated to. Falls back to a note when the DDL is unavailable.
          const ddl = left.viewDdl.get(v);
          out.push(ddl
            ? `${retargetSchema(ddl, left.schema, right.schema).replace(/;?\s*$/, '')};`
            : `-- recreate view ${v} manually (definition unavailable)`);
        }
        if (deps.length) recreated.push(...deps);
        if (!alters.length && !after.length && e.details.length) {
          out.push(`-- ${e.name}: differs (${e.details.join('; ')}) — no automatic change generated`);
        }
        out.push('');
      }
      continue;
    }

    if ((e.kind === 'view' || e.kind === 'matview') && recreated.includes(e.name)) {
      out.push(`-- ${e.kind} ${e.name}: already recreated above with its table's ALTER`, '');
      continue;
    }

    // views / matviews / routines / triggers
    const kw = e.kind === 'matview' ? 'MATERIALIZED VIEW'
      : e.kind === 'procedure' ? 'PROCEDURE'
      : e.kind === 'function' ? 'FUNCTION'
      : e.kind.toUpperCase();

    if (e.status === 'only_right') {
      if (e.kind === 'trigger') {
        out.push(`-- trigger ${e.name} exists only on target; needs its table name:`,
                 `-- DROP TRIGGER IF EXISTS ${pq(e.name)} ON <table>;`, '');
      } else {
        // A routine key already carries its signature, which DROP requires.
        // A routine key carries its signature (`name(args)`), which DROP
        // requires — but the NAME half still needs quoting (mixed case /
        // reserved word), only the parenthesized argument list is verbatim.
        out.push(`DROP ${kw} IF EXISTS ${pq(right.schema)}.${
          e.kind === 'function' || e.kind === 'procedure' ? quoteRoutineSig(e.name) : pq(e.name)};`, '');
      }
      continue;
    }

    try {
      const own = (e.kind === 'view' || e.kind === 'matview') ? left.viewDdl.get(e.name) : undefined;
      const ddl = own ? retargetSchema(own, left.schema, right.schema) : await getLeftDdl(e.name);
      out.push(`-- ${e.kind} ${e.name}: ${e.status === 'only_left' ? 'missing on target' : e.details.join('; ')}`,
               ddl.replace(/;?\s*$/, ';'), '');
    } catch {
      out.push(`-- ${e.kind} ${e.name}: ${e.status === 'only_left' ? 'missing on target' : 'differs'} (DDL lookup failed)`, '');
    }
  }

  return out.join('\n') + '\n';
}

/**
 * Generate the script that makes RIGHT look like LEFT (source = left).
 * Reviewed by a human, never auto-executed.
 */
export async function generateMigration(
  diff: DiffEntry[],
  left: Snapshot,
  right: Snapshot,
  getLeftDdl: (name: string) => Promise<string>,
): Promise<string> {
  if (left.engine === 'postgres') return generateMigrationPg(diff, left, right, getLeftDdl);

  const out: string[] = [
    `-- Migration: make ${right.schema} match ${left.schema}`,
    `-- Generated by dbgui — REVIEW BEFORE RUNNING. Order may need adjustment (FKs).`,
    `-- Target: ${right.schema}`,
    '',
  ];

  for (const e of diff) {
    if (e.status === 'same') continue;
    switch (e.kind) {
      case 'schema':
        if (e.status === 'different') {
          out.push(`-- schema defaults differ: ${e.details.join('; ')}`);
          if (left.charset !== right.charset || left.collation !== right.collation) {
            out.push(`ALTER DATABASE ${q(right.schema)} CHARACTER SET ${left.charset} COLLATE ${left.collation};`, '');
          }
        }
        break;

      case 'table': {
        if (e.status === 'only_left') {
          try {
            const ddl = await getLeftDdl(e.name);
            out.push(`-- table ${e.name} missing on target`, ddl.replace(/;?\s*$/, ';'), '');
          } catch {
            out.push(`-- table ${e.name} missing on target (SHOW CREATE failed)`, '');
          }
        } else if (e.status === 'only_right') {
          out.push(`-- table ${e.name} exists only on target`, `DROP TABLE ${q(e.name)};`, '');
        } else {
          const lt = left.tables.get(e.name)!;
          const rt = right.tables.get(e.name)!;
          const alters: string[] = [];
          if (lt.engine !== rt.engine) alters.push(`ENGINE=${lt.engine}`);
          if (lt.collation !== rt.collation) {
            const cs = lt.collation.split('_')[0];
            alters.push(`CONVERT TO CHARACTER SET ${cs} COLLATE ${lt.collation}`);
          }
          for (const [c, lc] of lt.columns) {
            const rc = rt.columns.get(c);
            if (!rc) alters.push(`ADD COLUMN ${columnDdl(c, lc)}`);
            else if (compareColumn(c, lc, rc).some(d => !d.includes('position'))) {
              alters.push(`MODIFY COLUMN ${columnDdl(c, lc)}`);
            }
          }
          for (const c of rt.columns.keys()) {
            if (!lt.columns.has(c)) alters.push(`DROP COLUMN ${q(c)}`);
          }
          for (const [i, li] of lt.indexes) {
            if (i === 'PRIMARY') continue;
            const ri = rt.indexes.get(i);
            const spec = `${li.startsWith('UNIQUE') ? 'UNIQUE ' : ''}INDEX ${q(i)} (${indexKeyParts(li)})`;
            if (!ri) alters.push(`ADD ${spec}`);
            else if (ri !== li) alters.push(`DROP INDEX ${q(i)}`, `ADD ${spec}`);
          }
          for (const i of rt.indexes.keys()) {
            if (i !== 'PRIMARY' && !lt.indexes.has(i)) alters.push(`DROP INDEX ${q(i)}`);
          }
          if (alters.length) {
            out.push(`-- ${e.name}: ${e.details.length} difference${e.details.length === 1 ? '' : 's'}`);
            out.push(`ALTER TABLE ${q(e.name)}`);
            out.push('  ' + alters.join(',\n  ') + ';', '');
          } else if (e.details.length) {
            out.push(`-- ${e.name}: differs (${e.details.join('; ')}) — no automatic ALTER generated`, '');
          }
        }
        break;
      }

      case 'view':
      case 'procedure':
      case 'function':
      case 'trigger':
      case 'event': {
        const kw = e.kind.toUpperCase();
        if (e.status === 'only_right') {
          out.push(`DROP ${kw} IF EXISTS ${q(e.name)};`, '');
        } else {
          try {
            const ddl = await getLeftDdl(e.name);
            out.push(
              `-- ${e.kind} ${e.name}: ${e.status === 'only_left' ? 'missing on target' : e.details.join('; ')}`,
              `DROP ${kw} IF EXISTS ${q(e.name)};`,
              'DELIMITER $$',
              ddl.replace(/;?\s*$/, () => '$$'),
              'DELIMITER ;',
              '');
          } catch {
            out.push(`-- ${e.kind} ${e.name}: differs (SHOW CREATE failed)`, '');
          }
        }
        break;
      }
    }
  }
  return out.join('\n') + '\n';
}
