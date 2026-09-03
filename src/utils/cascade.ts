/**
 * What a DROP, TRUNCATE or DELETE actually destroys.
 *
 * Referential actions compose, and nothing at the call site shows it. You type
 * `DELETE FROM orders WHERE id = 42`, and two levels down a table you have
 * never opened loses four thousand rows because somebody wrote `ON DELETE
 * CASCADE` in 2019. The database does exactly what it was told; the person
 * running the statement simply could not see it.
 *
 * So the graph is built from **every** foreign key in the schema and walked
 * transitively, and the answer is put in the confirmation dialog — before the
 * statement runs, which is the only moment it changes an outcome.
 *
 * Four findings, and they are genuinely different consequences:
 *
 *   cascade   rows in other tables are **deleted**
 *   set null  the child row **survives with its meaning erased** — which is
 *             worse than deletion in one specific way: nothing is missing, so
 *             nothing looks wrong
 *   restrict  the statement will **fail** (MySQL 1451/3730, PostgreSQL 23503)
 *   depth ≥2  a chain nobody has in their head
 *
 * ## What the numbers are, and are not
 *
 * Row counts are an **upper bound**: the whole child table, not the rows
 * matching your `WHERE`. Computing the real number needs the join, which is
 * the expensive query this exists to avoid running. Every number is therefore
 * labelled "up to", and the caller must not present it otherwise.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

/** A referential action, as the catalog spells it. */
export type RefAction = 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';

export interface FkEdge {
  constraint: string;
  /** The table holding the foreign key. */
  child: string;
  /** The table it points at. */
  parent: string;
  onDelete: RefAction;
  /** Child columns, for display. */
  columns?: string;
}

export interface CascadeRoute {
  /** parent → child → grandchild, starting with the targeted table. */
  chain: string[];
  /** The action on each hop; `actions[i]` takes `chain[i]` to `chain[i + 1]`. */
  actions: RefAction[];
  /** Rows in the table at the end of the chain — an upper bound, may be null. */
  rows: number | null;
}

export type DestructiveKind = 'drop' | 'truncate' | 'delete';

export interface CascadeAnalysis {
  kind: DestructiveKind;
  table: string;
  /** Chains that delete rows. */
  cascades: CascadeRoute[];
  /** Chains that blank a column instead — the row survives, its meaning does not. */
  setNulls: CascadeRoute[];
  /**
   * Foreign keys that will refuse the statement.
   *
   * For DROP and TRUNCATE this is fatal whatever the rows are: PostgreSQL and
   * MySQL both refuse to remove a table another one still references.
   */
  blockers: FkEdge[];
  /** Deepest cascade chain; 2 or more is the case nobody has in their head. */
  maxDepth: number;
  /** Upper bound on rows destroyed, or null when no counts were supplied. */
  totalRows: number | null;
  /** True when the walk hit its limit — the real radius is at least this big. */
  truncated: boolean;
}

/** Hard limits, so a pathological schema cannot hang the confirmation dialog. */
const MAX_DEPTH = 8;
const MAX_ROUTES = 200;

/** Normalise whatever spelling the catalog used. */
export function parseAction(raw: string | null | undefined): RefAction {
  const s = (raw ?? '').trim().toUpperCase().replace(/_/g, ' ');
  if (s === 'CASCADE') return 'CASCADE';
  if (s === 'SET NULL') return 'SET NULL';
  if (s === 'SET DEFAULT') return 'SET DEFAULT';
  if (s === 'RESTRICT') return 'RESTRICT';
  // Unknown spellings fall back to NO ACTION, which is also the SQL default —
  // and the conservative reading, since it blocks rather than destroys.
  return 'NO ACTION';
}

const norm = (t: string) => t.toLowerCase();

/**
 * Walk the graph from `table`.
 *
 * Routes are deduplicated **by table chain**: two foreign keys between the
 * same pair of tables are two constraints but one cascade route, and reporting
 * it twice makes the blast radius look bigger than it is.
 */
export function analyzeCascade(
  table: string,
  edges: readonly FkEdge[],
  rowCounts: ReadonlyMap<string, number | null>,
  kind: DestructiveKind,
): CascadeAnalysis {
  const childrenOf = new Map<string, FkEdge[]>();
  for (const e of edges) {
    const key = norm(e.parent);
    const list = childrenOf.get(key) ?? [];
    list.push(e);
    childrenOf.set(key, list);
  }

  const cascades: CascadeRoute[] = [];
  const setNulls: CascadeRoute[] = [];
  const seenChains = new Set<string>();
  let truncated = false;

  const rowsOf = (t: string): number | null => {
    if (rowCounts.has(t)) return rowCounts.get(t) ?? null;
    // Callers may key by bare or qualified name; try both before giving up.
    for (const [k, v] of rowCounts) if (norm(k) === norm(t)) return v;
    return null;
  };

  /**
   * `visiting` is the current path, not a global seen-set: a table can legally
   * be reached by two different routes, and collapsing them would hide one.
   * It is only the *cycle* — a table already on this path — that must stop.
   */
  const walk = (chain: string[], actions: RefAction[], visiting: Set<string>) => {
    if (cascades.length + setNulls.length >= MAX_ROUTES) { truncated = true; return; }
    if (chain.length > MAX_DEPTH) { truncated = true; return; }

    const current = chain[chain.length - 1];
    for (const e of childrenOf.get(norm(current)) ?? []) {
      if (visiting.has(norm(e.child))) continue;      // cycle — stop, do not report
      const nextChain = [...chain, e.child];
      const nextActions = [...actions, e.onDelete];
      const key = nextChain.map(norm).join('>');

      if (e.onDelete === 'CASCADE') {
        if (!seenChains.has(key)) {
          seenChains.add(key);
          cascades.push({ chain: nextChain, actions: nextActions, rows: rowsOf(e.child) });
        }
        // Only CASCADE propagates. A SET NULL child keeps its row, so nothing
        // below it is touched — walking past it would invent a blast radius.
        walk(nextChain, nextActions, new Set([...visiting, norm(e.child)]));
      } else if (e.onDelete === 'SET NULL' || e.onDelete === 'SET DEFAULT') {
        if (!seenChains.has(key)) {
          seenChains.add(key);
          setNulls.push({ chain: nextChain, actions: nextActions, rows: rowsOf(e.child) });
        }
      }
    }
  };

  walk([table], [], new Set([norm(table)]));

  // RESTRICT / NO ACTION on a direct child refuses the statement outright. Only
  // the first level matters: the statement never gets far enough for the rest.
  const blockers = (childrenOf.get(norm(table)) ?? [])
    .filter(e => e.onDelete === 'RESTRICT' || e.onDelete === 'NO ACTION');

  const counted = cascades.map(r => r.rows).filter((n): n is number => n != null);
  const totalRows = counted.length ? counted.reduce((a, b) => a + b, 0) : null;

  return {
    kind,
    table,
    cascades,
    setNulls,
    blockers,
    maxDepth: cascades.reduce((d, r) => Math.max(d, r.chain.length - 1), 0),
    totalRows,
    truncated,
  };
}

/** `orders --[CASCADE]--> order_lines --[CASCADE]--> line_taxes` */
export function routeText(r: CascadeRoute): string {
  return r.chain
    .map((t, i) => (i === 0 ? t : `--[${r.actions[i - 1]}]--> ${t}`))
    .join(' ');
}

/**
 * Is this worth interrupting someone for?
 *
 * A single-level cascade into an empty table is not news. A chain two levels
 * deep is, whatever the counts — that is the case nobody has in their head.
 */
export function isNotable(a: CascadeAnalysis): boolean {
  if (a.blockers.length > 0) return true;
  if (a.maxDepth >= 2) return true;
  if (a.setNulls.length > 0) return true;
  return (a.totalRows ?? 0) > 0;
}

/**
 * One line for the confirmation dialog, or null when there is nothing to say.
 *
 * Deliberately short and deliberately hedged: "up to" is not padding, it is
 * the difference between a number that is true and one that is merely large.
 */
export function summarize(a: CascadeAnalysis): string | null {
  const parts: string[] = [];

  if (a.blockers.length > 0 && a.kind !== 'delete') {
    const names = a.blockers.slice(0, 3).map(b => b.child).join(', ');
    parts.push(`${a.blockers.length} foreign key${a.blockers.length === 1 ? '' : 's'} still `
      + `reference${a.blockers.length === 1 ? 's' : ''} this table (${names}`
      + `${a.blockers.length > 3 ? ', …' : ''}) — the statement will fail`);
  }

  if (a.cascades.length > 0) {
    const tables = new Set(a.cascades.map(r => r.chain[r.chain.length - 1]));
    const rows = a.totalRows != null && a.totalRows > 0
      ? `, up to ${a.totalRows.toLocaleString()} rows`
      : '';
    parts.push(`cascades into ${tables.size} table${tables.size === 1 ? '' : 's'}${rows}`
      + (a.maxDepth >= 2 ? `, ${a.maxDepth} levels deep` : ''));
  }

  if (a.setNulls.length > 0) {
    const tables = new Set(a.setNulls.map(r => r.chain[r.chain.length - 1]));
    parts.push(`blanks the reference in ${tables.size} table${tables.size === 1 ? '' : 's'} `
      + '(the rows survive, their meaning does not)');
  }

  if (parts.length === 0) return null;
  if (a.truncated) parts.push('and more — the graph was larger than the walk');
  return parts.join('; ');
}

// ── which statements need this ──────────────────────────────────────────────

const IDENT = String.raw`(?:\`[^\`]*\`|"[^"]*"|[\w$]+)`;
const TABLE_REF = String.raw`(${IDENT}(?:\.${IDENT})*)`;

/**
 * The table a destructive statement targets, or null.
 *
 * `countPlanFor` (utils/writePreview) already covers UPDATE and DELETE row
 * counts; this covers the two statements that have no row count because they
 * take the whole table, and reports DELETE too so its cascade can be shown
 * alongside its count.
 */
export function destructiveTarget(sql: string): { kind: DestructiveKind; table: string } | null {
  const s = sql.trim();
  const drop = new RegExp(String.raw`^\s*drop\s+(?:temporary\s+)?table\s+(?:if\s+exists\s+)?` + TABLE_REF, 'i').exec(s);
  if (drop) return { kind: 'drop', table: unquote(drop[1]) };

  const trunc = new RegExp(String.raw`^\s*truncate\s+(?:table\s+)?` + TABLE_REF, 'i').exec(s);
  if (trunc) return { kind: 'truncate', table: unquote(trunc[1]) };

  const del = new RegExp(String.raw`^\s*delete\s+(?:quick\s+|low_priority\s+|ignore\s+)*from\s+` + TABLE_REF, 'i').exec(s);
  if (del) return { kind: 'delete', table: unquote(del[1]) };

  return null;
}

/** Strip quoting and any schema qualifier — the graph is keyed by bare name. */
export function unquote(ref: string): string {
  const last = ref.split('.').pop() ?? ref;
  return last.replace(/^[`"]|[`"]$/g, '');
}

// ── reading the graph out of a server ───────────────────────────────────────

/**
 * Every foreign key in a schema, with its delete rule.
 *
 * The ER diagram's own query deliberately does not fetch referential actions —
 * it draws relationships, not consequences. This one exists for the
 * consequences, so `delete_rule` is the point of it.
 */
export function fkGraphSql(engine: string, schema: string): string {
  const lit = schema.replace(/'/g, "''");
  if (engine === 'sqlserver') {
    // `information_schema.referential_constraints` exists on SQL Server but has
    // **no `table_name` or `referenced_table_name`** — the MySQL shape below
    // fails outright with "Invalid column name 'table_name'". A failed query
    // here shows the delete confirmation NO cascade consequences at all, which
    // is the most dangerous way for this to break: the dialog looks like it
    // checked and found nothing.
    return `SELECT fk.name AS constraint_name,
       OBJECT_NAME(fk.parent_object_id) AS child_table,
       OBJECT_NAME(fk.referenced_object_id) AS parent_table,
       REPLACE(fk.delete_referential_action_desc, '_', ' ') AS delete_rule,
       STUFF((SELECT ', ' + c.name
              FROM sys.foreign_key_columns fkc
              JOIN sys.columns c ON c.object_id = fkc.parent_object_id
                                AND c.column_id = fkc.parent_column_id
              WHERE fkc.constraint_object_id = fk.object_id
              ORDER BY fkc.constraint_column_id
              FOR XML PATH(''), TYPE).value('.', 'nvarchar(400)'), 1, 2, '') AS child_columns
FROM sys.foreign_keys fk
JOIN sys.schemas s ON s.schema_id = fk.schema_id
WHERE s.name = '${lit}'`;
  }
  if (engine === 'postgres') {
    return `SELECT con.conname AS constraint_name,
       child.relname AS child_table,
       parent.relname AS parent_table,
       CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                            WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                            WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule,
       (SELECT string_agg(a.attname, ', ' ORDER BY u.ord)
        FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum) AS child_columns
FROM pg_constraint con
JOIN pg_class child ON child.oid = con.conrelid
JOIN pg_class parent ON parent.oid = con.confrelid
JOIN pg_namespace n ON n.oid = child.relnamespace
WHERE con.contype = 'f' AND n.nspname = '${lit}'`;
  }
  return `SELECT rc.constraint_name, rc.table_name AS child_table,
       rc.referenced_table_name AS parent_table, rc.delete_rule,
       (SELECT GROUP_CONCAT(k.column_name ORDER BY k.ordinal_position)
        FROM information_schema.key_column_usage k
        WHERE k.constraint_schema = rc.constraint_schema
          AND k.constraint_name = rc.constraint_name
          AND k.table_name = rc.table_name) AS child_columns
FROM information_schema.referential_constraints rc
WHERE rc.constraint_schema = '${lit}'`;
}

/** Estimated rows per table — from statistics, never `COUNT(*)`. */
export function rowCountSql(engine: string, schema: string): string {
  const lit = schema.replace(/'/g, "''");
  if (engine === 'sqlserver') {
    // `information_schema.tables` has no `table_rows` here either. Partition
    // stats are the estimate SQL Server keeps, and reading them opens no table.
    return `SELECT t.name, ISNULL(SUM(p.row_count), 0)
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
LEFT JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
WHERE s.name = '${lit}'
GROUP BY t.name`;
  }
  if (engine === 'postgres') {
    return `SELECT c.relname, GREATEST(c.reltuples, 0)::bigint
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = '${lit}'`;
  }
  // information_schema.TABLES is an estimate too, and the one place MySQL
  // exposes it without opening the table.
  return `SELECT table_name, COALESCE(table_rows, 0)
FROM information_schema.tables
WHERE table_schema = '${lit}' AND table_type = 'BASE TABLE'`;
}

/** Rows of `fkGraphSql` into edges. */
export function edgesFromRows(rows: readonly unknown[][]): FkEdge[] {
  return rows
    .filter(r => r[1] != null && r[2] != null)
    .map(r => ({
      constraint: String(r[0] ?? ''),
      child: String(r[1]),
      parent: String(r[2]),
      onDelete: parseAction(r[3] == null ? null : String(r[3])),
      columns: r[4] == null ? undefined : String(r[4]),
    }));
}
