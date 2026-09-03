/**
 * Table maintenance, and finding what a schema change quietly broke.
 *
 * Two jobs that look unrelated and are not: both answer "is this schema
 * actually healthy", and both are things a DBA does from a GUI in every rival
 * tool and by hand here.
 *
 * **Maintenance** is `CHECK` / `ANALYZE` / `OPTIMIZE` / `REPAIR`. The important
 * part is not building the SQL — it is knowing which of them are *safe*.
 * `OPTIMIZE TABLE` on InnoDB rebuilds the table and locks it for the duration;
 * `REPAIR` only works on MyISAM and does nothing else. A panel that offers all
 * four as equal buttons will get one of them run on a production table by
 * someone who assumed they were all read-only.
 *
 * **Invalid objects** are what a `DROP COLUMN` leaves behind: views selecting a
 * column that no longer exists, routines referencing a dropped table, foreign
 * keys pointing at nothing. None of these fail at the moment you break them.
 * They fail the next time something runs them, which is usually in production
 * and usually not by you.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

import { quoteIdent, sqlLiteral } from './sqlIdent.ts';

export type MaintenanceOp =
  | 'check' | 'analyze' | 'optimize' | 'repair' | 'prewarm' | 'reorganize';

export interface OpSpec {
  id: MaintenanceOp;
  label: string;
  /** Does this rewrite data or take a blocking lock? */
  destructive: boolean;
  /** Engines it applies to at all. */
  engines: Array<'mysql' | 'postgres' | 'sqlserver'>;
  summary: string;
  /** The consequence, stated before it runs. */
  warning?: string;
  /**
   * Per-engine overrides for `summary` and `warning`.
   *
   * The same word means different work on different engines, and the whole
   * point of the warning is that it names *this server's* cost. "On InnoDB this
   * REBUILDS the table" is exactly wrong in front of a SQL Server, where the
   * equivalent is an index rebuild whose blocking depends on the edition. A
   * warning that describes another engine is worse than none: it is read,
   * believed, and inapplicable.
   */
  perEngine?: Partial<Record<string, { summary?: string; warning?: string }>>;
}

/** The summary to show for this op on this engine. */
export function opSummary(spec: OpSpec, engine: string): string {
  return spec.perEngine?.[engine]?.summary ?? spec.summary;
}

/** The warning to show for this op on this engine, or undefined if none. */
export function opWarning(spec: OpSpec, engine: string): string | undefined {
  return spec.perEngine?.[engine]?.warning ?? spec.warning;
}

export const OPS: OpSpec[] = [
  {
    id: 'analyze',
    label: 'Analyze',
    destructive: false,
    engines: ['mysql', 'postgres', 'sqlserver'],
    summary: 'Recompute the statistics the optimiser plans from.',
    perEngine: {
      sqlserver: {
        summary: 'UPDATE STATISTICS — recompute what the optimiser plans from.',
      },
    },
  },
  {
    id: 'check',
    label: 'Check',
    destructive: false,
    engines: ['mysql', 'sqlserver'],
    summary: 'Look for corruption. Read-only.',
    perEngine: {
      sqlserver: {
        summary: 'DBCC CHECKTABLE — verify physical and logical integrity. Read-only.',
        warning: 'Read-only, but not cheap: it reads every page of the table and its '
          + 'indexes, and takes an internal database snapshot to do it without blocking. '
          + 'On a large table that is real I/O against the same disks serving queries.',
      },
    },
  },
  {
    id: 'optimize',
    label: 'Optimize',
    destructive: true,
    engines: ['mysql', 'sqlserver'],
    summary: 'Reclaim space and defragment.',
    warning: 'On InnoDB this REBUILDS the table and holds a lock for the whole '
      + 'operation. On a large table that is minutes of blocked writes, not seconds.',
    perEngine: {
      sqlserver: {
        summary: 'ALTER INDEX ALL … REBUILD — rebuild every index from scratch.',
        warning: 'This REBUILDS every index on the table. Offline on Standard Edition, '
          + 'which holds a schema-modification lock for the whole operation — the table '
          + 'is unreadable, not merely unwritable, until it finishes. It is fully logged, '
          + 'so it can grow the transaction log by the size of the largest index. '
          + 'Reorganize is the online alternative and is usually the one you want.',
      },
    },
  },
  {
    id: 'reorganize',
    label: 'Reorganize',
    // Online, resumable, and minimally logged by comparison — but it still
    // moves pages and writes to the log, so it is not free and not read-only.
    destructive: false,
    engines: ['sqlserver'],
    summary: 'ALTER INDEX ALL … REORGANIZE — defragment in place, online.',
    warning: 'The online half of the pair: it compacts leaf pages without taking a '
      + 'blocking lock, and can be stopped part-way without losing the work already '
      + 'done. It still writes — every page it moves is logged — and it does not '
      + 'update statistics, so pair it with Analyze. It cannot fix fragmentation '
      + 'above roughly 30%; that needs a Rebuild.',
  },
  {
    id: 'repair',
    label: 'Repair',
    destructive: true,
    engines: ['mysql'],
    // Deliberately not offered for SQL Server. Its equivalent is
    // `DBCC CHECKDB … REPAIR_ALLOW_DATA_LOSS`, which requires the database in
    // SINGLE_USER mode — impossible from a pooled application connection, and
    // the last resort after restoring from backup has failed. Offering a button
    // that cannot run, for an operation nobody should reach for first, would be
    // worse than its absence.
    summary: 'Attempt to fix a corrupted table.',
    warning: 'MyISAM and ARCHIVE only — it does nothing on InnoDB. It rewrites the '
      + 'table and can lose rows it cannot recover. Take a backup first.',
  },
  {
    id: 'prewarm',
    label: 'Prewarm',
    destructive: false,
    engines: ['mysql', 'postgres', 'sqlserver'],
    summary: 'Read the selected tables into the buffer pool. Read-only.',
    warning: 'PostgreSQL needs the pg_prewarm extension '
      + '(CREATE EXTENSION IF NOT EXISTS pg_prewarm) — the generated SQL carries that '
      + 'as a comment on the first line. On MySQL there is no built-in prewarm, so it is '
      + 'a COUNT(*) that forces the clustered index through the pool. Only the table is '
      + 'warmed, not its secondary indexes, and reading a large table is real I/O.',
    perEngine: {
      sqlserver: {
        warning: 'SQL Server has no prewarm command either, so this is a COUNT(*) that '
          + 'pulls the clustered index (or the heap) through the buffer pool. Only that '
          + 'structure is warmed, not the nonclustered indexes, and on a table larger '
          + 'than free memory it will evict whatever was cached to make room.',
      },
    },
  },
];

export function findOp(id: string): OpSpec | undefined {
  return OPS.find(o => o.id === id);
}

/** Operations that apply to an engine. */
export function opsFor(engine: string): OpSpec[] {
  return OPS.filter(o => (o.engines as string[]).includes(engine));
}

const q = (name: string, engine: string) => quoteIdent(name, engine);

export interface TableRef { schema: string; name: string }

/**
 * The dials the Analyze op carries, per engine. Everything else takes the
 * statement the engine gives it; ANALYZE has genuine choices — how much of
 * the table to read, and whether the run should replicate.
 */
export interface AnalyzeOpts {
  /** MySQL: `ANALYZE LOCAL TABLE` — the run is not binary-logged, so it does not replicate. */
  local?: boolean;
  /** MySQL: `ALTER TABLE … STATS_SAMPLE_PAGES=N` before the run. Null/undefined keeps the current setting. */
  samplePages?: number | null;
  /** SQL Server: `UPDATE STATISTICS … WITH FULLSCAN` — read every row instead of sampling. */
  fullscan?: boolean;
}

/**
 * SQL for one operation over a set of tables — **one statement per table**,
 * on every engine. MySQL's maintenance statements accept a table list, and an
 * earlier version used it (`CHECK TABLE a, b, c`): it returned one lump with
 * no per-table timing, no progress while it ran, and a cancel that could only
 * land mid-statement. Per-table statements cost nothing (the server does the
 * same work) and buy exactly what a DBA watches a run for: a line per table
 * with its own status and milliseconds, and a queue a cancel can stop at a
 * table boundary.
 */
export function maintenanceSql(
  op: MaintenanceOp, tables: TableRef[], engine: string, opts?: AnalyzeOpts,
): string[] {
  if (tables.length === 0) return [];
  const qualified = tables.map(t => `${q(t.schema, engine)}.${q(t.name, engine)}`);

  // Buffer-pool warming has no shared statement between the engines: PostgreSQL
  // has a purpose-built function, MySQL has to be tricked into a full read. It
  // also does not exist at all on the other engines, so it is gated here rather
  // than falling through to the MySQL `PREWARM TABLE`, which is not a thing.
  if (op === 'prewarm') {
    if (engine === 'postgres') {
      // pg_prewarm takes the relation as a regclass literal. The first line is
      // a review-only reminder that the function lives in an extension that may
      // not be installed — it is a comment, so running the statement anyway
      // still just warms the table.
      return qualified.map((t, i) =>
        (i === 0 ? '-- requires: CREATE EXTENSION IF NOT EXISTS pg_prewarm;\n' : '')
        + `SELECT pg_prewarm(${sqlLiteral(t, engine)})`);
    }
    if (engine === 'mysql' || engine === 'sqlserver') {
      // No built-in prewarm on either — a full COUNT(*) forces the clustered
      // index (or the heap) through the buffer pool. Read-only, one statement
      // per table.
      return qualified.map(t => `SELECT COUNT(*) FROM ${t}`);
    }
    return [];
  }

  if (engine === 'sqlserver') {
    switch (op) {
      case 'analyze':
        // FULLSCAN reads every row rather than sampling — the honest
        // equivalent of "do it properly", and a full scan of each table.
        return qualified.map(t => `UPDATE STATISTICS ${t}${opts?.fullscan ? ' WITH FULLSCAN' : ''}`);
      case 'check':
        // The object name goes in as a *string literal*, not an identifier —
        // DBCC takes `('schema.table')`. NO_INFOMSGS drops the "0 pages in 0
        // extents" noise; TABLERESULTS turns the findings into a result set the
        // panel can render, instead of print output the driver discards. Clean
        // tables therefore return no rows, which the caller reads as success.
        return qualified.map(t =>
          `DBCC CHECKTABLE (${sqlLiteral(t, engine)}) WITH NO_INFOMSGS, TABLERESULTS`);
      case 'optimize':
        return qualified.map(t => `ALTER INDEX ALL ON ${t} REBUILD`);
      case 'reorganize':
        return qualified.map(t => `ALTER INDEX ALL ON ${t} REORGANIZE`);
      default:
        // REPAIR has no offerable equivalent — see the note on its OpSpec.
        return [];
    }
  }

  if (engine === 'postgres') {
    if (op !== 'analyze') return [];
    return qualified.map(t => `ANALYZE ${t}`);
  }
  // MySQL ANALYZE has the dials: LOCAL keeps the run out of the binlog, and a
  // sample-pages change is a per-table ALTER, so the run becomes ALTER+ANALYZE
  // pairs.
  if (engine === 'mysql' && op === 'analyze') {
    const keyword = `ANALYZE${opts?.local ? ' LOCAL' : ''} TABLE`;
    const pages = opts?.samplePages;
    if (pages) {
      return qualified.flatMap(t => [
        `ALTER TABLE ${t} STATS_SAMPLE_PAGES=${pages}`,
        `${keyword} ${t}`,
      ]);
    }
    return qualified.map(t => `${keyword} ${t}`);
  }
  // MySQL's maintenance statements share one shape, but only for the four
  // keywords that exist. Uppercasing whatever arrived would emit
  // `REORGANIZE TABLE …` — a SQL Server operation, spelled as MySQL syntax
  // that no MySQL has ever accepted.
  const spec = findOp(op);
  if (engine !== 'mysql' || !spec || !(spec.engines as string[]).includes('mysql')) return [];
  const keyword = op.toUpperCase();
  return qualified.map(t => `${keyword} TABLE ${t}`);
}

/**
 * The table a generated maintenance statement works on — for the progress
 * line ("3 / 47 · analyzing `reporting.orders`…"). Covers every shape
 * `maintenanceSql` emits; returns the statement itself when nothing matches
 * (a label, never a lie).
 */
export function statementSubject(sql: string): string {
  let m = /^(?:analyze|check|optimize|repair)(?:\s+local)?\s+table\s+(\S+)/i.exec(sql);
  if (m) return m[1];
  m = /^analyze\s+(\S+)$/i.exec(sql);                       // PostgreSQL ANALYZE t
  if (m) return m[1];
  m = /^alter\s+table\s+(\S+)/i.exec(sql);                  // … STATS_SAMPLE_PAGES
  if (m) return m[1];
  m = /^update\s+statistics\s+(\S+)/i.exec(sql);
  if (m) return m[1];
  m = /^alter\s+index\s+all\s+on\s+(\S+)/i.exec(sql);
  if (m) return m[1];
  m = /\bfrom\s+(\S+)$/i.exec(sql);                         // SELECT COUNT(*) FROM t
  if (m) return m[1];
  m = /'([^']+)'/.exec(sql);                                // DBCC ('t') / pg_prewarm('t')
  if (m) return m[1];
  return sql;
}

// ── analyze pre-flight ───────────────────────────────────────────────────────

/**
 * The probe that answers "will this server accept the write ANALYZE is?"
 * before N doomed statements find out one at a time (MySQL's error 1290).
 * Each engine reports it differently; null means the engine has no such probe.
 */
export function readOnlyProbeSql(engine: string): string | null {
  switch (engine) {
    case 'mysql':
      return 'SELECT @@GLOBAL.super_read_only AS sro, @@GLOBAL.read_only AS ro';
    case 'sqlserver':
      // A readable secondary in an availability group, or a database set
      // READ_ONLY, both refuse UPDATE STATISTICS — and the error a user would
      // otherwise see names neither.
      return "SELECT CAST(DATABASEPROPERTYEX(DB_NAME(), 'Updateability') AS varchar(30))";
    case 'postgres':
      return 'SELECT pg_is_in_recovery()';
    default:
      return null;
  }
}

/**
 * Interpret a `readOnlyProbeSql` row: a human reason the server will not
 * accept writes, or null if it will. An empty/missing row is not a reason.
 */
export function readOnlyReason(engine: string, row: unknown[]): string | null {
  if (engine === 'mysql') {
    const on = (v: unknown) => String(v) === '1' || String(v).toLowerCase() === 'true';
    if (on(row[0])) return 'super_read_only=ON';
    if (on(row[1])) return 'read_only=ON';
    return null;
  }
  if (engine === 'sqlserver') {
    const v = row[0] == null ? '' : String(row[0]).toUpperCase();
    return v && v !== 'READ_WRITE' ? `database is ${v}` : null;
  }
  if (engine === 'postgres') {
    const v = String(row[0] ?? '').toLowerCase();
    return v === 'true' || v === 't' || v === '1' ? 'standby server (in recovery)' : null;
  }
  return null;
}

/**
 * The sample-pages field: empty means "keep the table's current setting",
 * anything else must be a positive integer. Returns the literal `'invalid'`
 * rather than throwing, so the caller can put the message next to the field.
 */
export function parseSamplePages(raw: string): number | null | 'invalid' {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 ? n : 'invalid';
}

// ── invalid objects ──────────────────────────────────────────────────────────

export type InvalidKind =
  | 'view' | 'routine' | 'trigger' | 'foreign-key'
  // SQL Server enforces referential integrity too well for a foreign key to
  // point at nothing, but it has two failure modes the others do not: an object
  // that still exists and has been switched *off*, and a constraint the
  // optimiser no longer trusts. Both are silent, and both are what a bulk load
  // or a hurried migration leaves behind.
  | 'index' | 'constraint';

export interface InvalidObject {
  kind: InvalidKind;
  schema: string;
  name: string;
  /** What is missing or broken. */
  problem: string;
  /** What to do about it. */
  action: string;
}

/**
 * The probe for each kind of breakage.
 *
 * Views are checked by *asking the server*, not by parsing their SQL: a view
 * over a dropped column is only detectable by trying it, and every engine has
 * a cheap way to try. Routines cannot be checked that way — running one has
 * side effects — so those are matched textually against the catalog, which
 * finds the common case (a referenced table that no longer exists) and is
 * honest that it is a heuristic.
 */
export interface InvalidProbe {
  kind: InvalidKind;
  /** Human description, shown while it runs. */
  label: string;
  sql: string;
  /** Columns the probe returns, in order. */
  columns: string[];
}

export function invalidProbes(engine: string, schema: string): InvalidProbe[] {
  const lit = sqlLiteral(schema, engine);

  if (engine === 'sqlserver') {
    return [
      {
        kind: 'view',
        label: 'Views and routines referencing something that is gone',
        // sys.sql_expression_dependencies resolves every name a module uses at
        // creation time and re-resolves it on demand; a null referenced_id is
        // the server saying "I looked and it is not there". Two legitimate
        // nulls have to be excluded or every trigger and every procedure using
        // a temp table is reported as broken: the `inserted`/`deleted` pseudo-
        // tables, which exist only while a trigger runs, and `#temp` names,
        // which exist only inside a session.
        sql: `SELECT OBJECT_SCHEMA_NAME(d.referencing_id),
                     OBJECT_NAME(d.referencing_id),
                     ISNULL(d.referenced_schema_name + '.', '') + d.referenced_entity_name
              FROM sys.sql_expression_dependencies d
              JOIN sys.objects o ON o.object_id = d.referencing_id
              WHERE d.referenced_id IS NULL
                AND d.is_ambiguous = 0
                AND d.referenced_server_name IS NULL
                AND d.referenced_database_name IS NULL
                AND d.referenced_entity_name NOT LIKE '#%'
                AND NOT (o.type = 'TR' AND d.referenced_entity_name IN ('inserted', 'deleted'))
                AND OBJECT_SCHEMA_NAME(d.referencing_id) = ${lit}
              ORDER BY 1, 2`,
        columns: ['schema', 'name', 'missing'],
      },
      {
        kind: 'constraint',
        label: 'Constraints the optimiser no longer trusts',
        // is_not_trusted means the constraint was added or re-enabled WITH
        // NOCHECK: it applies to new rows, existing rows were never verified,
        // and the optimiser stops using it to eliminate work. The data can
        // already violate it. is_disabled means it is not even applied.
        sql: `SELECT s.name, OBJECT_NAME(c.parent_object_id),
                     c.name + CASE WHEN c.is_disabled = 1 THEN ' (disabled)' ELSE ' (untrusted)' END
              FROM sys.check_constraints c
              JOIN sys.schemas s ON s.schema_id = c.schema_id
              WHERE s.name = ${lit} AND (c.is_not_trusted = 1 OR c.is_disabled = 1)
              UNION ALL
              SELECT s.name, OBJECT_NAME(f.parent_object_id),
                     f.name + CASE WHEN f.is_disabled = 1 THEN ' (disabled)' ELSE ' (untrusted)' END
              FROM sys.foreign_keys f
              JOIN sys.schemas s ON s.schema_id = f.schema_id
              WHERE s.name = ${lit} AND (f.is_not_trusted = 1 OR f.is_disabled = 1)
              ORDER BY 1, 2`,
        columns: ['schema', 'table', 'constraint'],
      },
      {
        kind: 'index',
        label: 'Disabled indexes',
        // A disabled index keeps its definition and loses its data. Queries
        // that used to seek now scan, and a disabled *clustered* index takes
        // the whole table offline — SELECT fails until it is rebuilt.
        sql: `SELECT s.name, t.name,
                     i.name + CASE WHEN i.type = 1 THEN ' (CLUSTERED — table is offline)' ELSE '' END
              FROM sys.indexes i
              JOIN sys.tables t ON t.object_id = i.object_id
              JOIN sys.schemas s ON s.schema_id = t.schema_id
              WHERE i.is_disabled = 1 AND s.name = ${lit}
              ORDER BY 1, 2`,
        columns: ['schema', 'table', 'index'],
      },
      {
        kind: 'trigger',
        label: 'Disabled triggers',
        sql: `SELECT OBJECT_SCHEMA_NAME(tr.object_id), tr.name, OBJECT_NAME(tr.parent_id)
              FROM sys.triggers tr
              WHERE tr.is_disabled = 1 AND tr.parent_class = 1
                AND OBJECT_SCHEMA_NAME(tr.object_id) = ${lit}
              ORDER BY 1, 2`,
        columns: ['schema', 'name', 'table'],
      },
    ];
  }

  if (engine === 'postgres') {
    return [
      {
        kind: 'foreign-key',
        label: 'Foreign keys whose target is gone',
        // A constraint whose referenced relation no longer exists cannot
        // normally survive, but a restore or a catalog edit can leave one.
        sql: `SELECT n.nspname, c.relname, con.conname
              FROM pg_constraint con
              JOIN pg_class c ON c.oid = con.conrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE con.contype = 'f' AND n.nspname = ${lit}
                AND NOT EXISTS (SELECT 1 FROM pg_class t WHERE t.oid = con.confrelid)`,
        columns: ['schema', 'table', 'constraint'],
      },
      {
        kind: 'routine',
        label: 'Functions in a language that is no longer installed',
        sql: `SELECT n.nspname, p.proname, COALESCE(l.lanname, '(missing)')
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
              LEFT JOIN pg_language l ON l.oid = p.prolang
              WHERE n.nspname = ${lit} AND l.oid IS NULL`,
        columns: ['schema', 'name', 'language'],
      },
    ];
  }

  return [
    {
      kind: 'view',
      label: 'Views the server cannot expand',
      // information_schema.VIEWS blanks the definition of a view whose
      // dependencies are missing — which is exactly the broken ones.
      sql: `SELECT TABLE_SCHEMA, TABLE_NAME, 'definition unavailable'
            FROM information_schema.VIEWS
            WHERE TABLE_SCHEMA = ${lit} AND (VIEW_DEFINITION IS NULL OR VIEW_DEFINITION = '')`,
      columns: ['schema', 'name', 'problem'],
    },
    {
      kind: 'foreign-key',
      label: 'Foreign keys pointing at a table that no longer exists',
      sql: `SELECT k.CONSTRAINT_SCHEMA, k.TABLE_NAME, k.REFERENCED_TABLE_NAME
            FROM information_schema.KEY_COLUMN_USAGE k
            WHERE k.CONSTRAINT_SCHEMA = ${lit}
              AND k.REFERENCED_TABLE_NAME IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM information_schema.TABLES t
                WHERE t.TABLE_SCHEMA = k.REFERENCED_TABLE_SCHEMA
                  AND t.TABLE_NAME = k.REFERENCED_TABLE_NAME)`,
      columns: ['schema', 'table', 'missing target'],
    },
    {
      kind: 'trigger',
      label: 'Triggers on a table that no longer exists',
      sql: `SELECT t.TRIGGER_SCHEMA, t.TRIGGER_NAME, t.EVENT_OBJECT_TABLE
            FROM information_schema.TRIGGERS t
            WHERE t.TRIGGER_SCHEMA = ${lit}
              AND NOT EXISTS (
                SELECT 1 FROM information_schema.TABLES x
                WHERE x.TABLE_SCHEMA = t.EVENT_OBJECT_SCHEMA
                  AND x.TABLE_NAME = t.EVENT_OBJECT_TABLE)`,
      columns: ['schema', 'name', 'missing table'],
    },
  ];
}

/** Turn a probe row into a finding with an action. */
export function describeInvalid(
  probe: InvalidProbe, row: string[],
): InvalidObject {
  const [schema, name, detail] = row;
  const base = { kind: probe.kind, schema, name };
  switch (probe.kind) {
    case 'view':
      return {
        ...base,
        problem: 'The server cannot expand this view — something it selects from is gone.',
        action: 'Open it in the routine editor and repoint it, or drop it. It will fail '
          + 'the next time anything queries it, which is usually not you.',
      };
    case 'foreign-key':
      return {
        ...base,
        problem: `References \`${detail}\`, which does not exist.`,
        action: 'Drop the constraint or restore the target table. Until then the '
          + 'relationship it documents is fiction.',
      };
    case 'trigger':
      // Two different findings share this kind. MySQL's probe finds a trigger
      // whose table is gone; SQL Server's finds one that is switched off. The
      // detail column says which table either way, so the wording is chosen by
      // which probe asked.
      return {
        ...base,
        problem: probe.label.startsWith('Disabled')
          ? `Disabled on \`${detail}\` — it exists and does not fire.`
          : `Attached to \`${detail}\`, which does not exist.`,
        action: probe.label.startsWith('Disabled')
          ? 'Re-enable it (ENABLE TRIGGER) or drop it. Until then every row written to '
            + 'that table skips whatever it was there to do — usually an audit trail.'
          : 'Drop the trigger — it can never fire.',
      };
    case 'index':
      return {
        ...base,
        problem: `\`${detail}\` is disabled — the definition is there, the data is not.`,
        action: 'ALTER INDEX … REBUILD brings it back (the Optimize operation above does '
          + 'this for every index on a table), or drop it. A disabled clustered index '
          + 'makes the table unreadable, not merely slower.',
      };
    case 'constraint':
      return {
        ...base,
        problem: `\`${detail}\` — it is not enforcing what it claims to.`,
        action: 'An untrusted constraint applies to new rows only; existing rows were '
          + 'never checked and the optimiser has stopped believing it. Verify and re-trust '
          + 'with ALTER TABLE … WITH CHECK CHECK CONSTRAINT — which will fail if the data '
          + 'already violates it, which is the point.',
      };
    case 'routine':
      return {
        ...base,
        problem: `Declared in language \`${detail}\`, which is not installed.`,
        action: 'Install the language extension, or drop the routine. Calling it now '
          + 'raises rather than running.',
      };
  }
}

/** A one-line summary for the header. */
export function invalidSummary(found: InvalidObject[]): string {
  if (found.length === 0) return 'Nothing broken.';
  const byKind = new Map<InvalidKind, number>();
  for (const f of found) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  return [...byKind.entries()]
    .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
    .join(' · ');
}
