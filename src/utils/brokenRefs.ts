/**
 * Why is this view broken? — the drill-down behind the Maintenance panel's
 * invalid-objects scan.
 *
 * The scan (utils/tableMaintenance) answers *that* an object is broken: the
 * server cannot expand the view, `CHECK TABLE … FOR UPGRADE` says "references
 * invalid table(s) or column(s) or function(s) or definer/invoker of view lack
 * rights to use them". That message names four different causes and none of
 * them. This module answers *which one*: it parses the object's definition,
 * extracts every table and column it references, and checks each against the
 * live catalog — so the finding reads "column `o.cancelled_at` is gone (did
 * you mean `o.canceled_at`?)" instead of "something is wrong, good luck".
 *
 * The reference extraction is the editor's own — `diagnose` from
 * utils/sqlDiagnostics, fed a `DiagContext` built from a whole-server catalog
 * sweep — so the checker flags exactly what the editor would squiggle, CTEs
 * and derived tables included, and stays quiet about what it cannot prove.
 * A reference qualified with a schema the sweep covers verifies properly;
 * nothing is guessed.
 *
 * When the analysis finds nothing missing, that is itself the answer: the
 * definition's references all resolve, so the breakage is the remaining cause
 * in the server message — the definer is gone or lacks the rights.
 *
 * Pure and dependency-free — driven by `node --test`. The panel owns `invoke`.
 */
import { diagnose, type DiagContext } from './sqlDiagnostics.ts';
import { findVirtualTables } from './sqlContext.ts';
import { findAliases } from './sqlAlias.ts';
import type { Engine } from '../types';

// ── the catalog ─────────────────────────────────────────────────────────────

/**
 * What the checker knows about the server: every object name (bare and
 * `schema.name`, lower-cased) and every table's columns (keyed the same way).
 */
export interface RefCatalog {
  objects: Set<string>;
  columns: Map<string, Set<string>>;
}

export interface CatalogQuery {
  /** Rows of (schema, name) — tables AND views, every user schema. */
  objects: string;
  /** Rows of (schema, table, column) — every user schema. */
  columns: string;
}

/**
 * The two sweeps that build a catalog. Both cover **every user schema**, not
 * the selected one — a reporting view that selects from `sales.orders` must
 * verify against `sales`, not be guessed at. These are catalog reads only:
 * no sizes, no statistics, no row counts, so they cost the same on a server
 * with ten schemas as on one.
 *
 * Returns null for engines without a queryable catalog of this shape (the
 * scan itself only probes MySQL, PostgreSQL and SQL Server).
 */
export function catalogSql(engine: string): CatalogQuery | null {
  switch (engine) {
    case 'mysql':
      return {
        objects: `SELECT TABLE_SCHEMA, TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')`,
        columns: `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')`,
      };
    case 'postgres':
      return {
        // relkind r/p/v/m — a view's columns are as checkable as a table's,
        // and views reference other views constantly.
        objects: `SELECT n.nspname, c.relname
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','v','m')
  AND n.nspname NOT IN ('pg_catalog','information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%'`,
        columns: `SELECT n.nspname, c.relname, a.attname
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','v','m')
  AND n.nspname NOT IN ('pg_catalog','information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%'
  AND a.attnum > 0 AND NOT a.attisdropped`,
      };
    case 'sqlserver':
      // sys.* is per-database, so the sweep is the connected database — all of
      // its schemas. A cross-database reference ([other].[dbo].[t]) cannot be
      // verified from here and is left alone rather than guessed at.
      return {
        objects: `SELECT s.name, o.name
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('U','V')`,
        columns: `SELECT s.name, o.name, c.name
FROM sys.columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('U','V')`,
      };
    default:
      return null;
  }
}

/**
 * Fold the two sweep grids into a catalog. Every name is registered twice —
 * bare and `schema.name`, lower-cased — because a definition may qualify or
 * not, and the checker must find it either way. A bare name that exists in
 * two schemas collides; that is deliberate (tolerant beats a false alarm).
 */
export function buildCatalog(objectRows: unknown[][], columnRows: unknown[][]): RefCatalog {
  const objects = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const low = (v: unknown) => String(v ?? '').toLowerCase();

  for (const r of objectRows) {
    const schema = low(r[0]);
    const name = low(r[1]);
    if (!name) continue;
    objects.add(name);
    if (schema) objects.add(`${schema}.${name}`);
  }
  for (const r of columnRows) {
    const schema = low(r[0]);
    const table = low(r[1]);
    const col = low(r[2]);
    if (!table || !col) continue;
    for (const key of schema ? [table, `${schema}.${table}`] : [table]) {
      let set = columns.get(key);
      if (!set) { set = new Set(); columns.set(key, set); }
      set.add(col);
    }
  }
  return { objects, columns };
}

// ── rename suggestions ───────────────────────────────────────────────────────

/** Classic Levenshtein — small inputs (identifiers), clarity over cleverness. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * The names a missing identifier was probably renamed to, nearest first.
 * The bar scales with length — a one-letter typo in `qty` is as plausible as
 * three in `order_cancelled_at` — and a candidate must share at least a third
 * of the characters, so `x` is never "suggested" for `customer_id`.
 */
export function closest(name: string, candidates: Iterable<string>, max = 3): string[] {
  const n = name.toLowerCase();
  const bar = Math.max(2, Math.floor(n.length / 3));
  const scored: Array<[number, string]> = [];
  for (const raw of candidates) {
    const c = raw.toLowerCase();
    if (c === n) continue;
    const d = editDistance(n, c);
    if (d <= bar && d < n.length) scored.push([d, raw]);
  }
  return scored
    .sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]))
    .slice(0, max)
    .map(([, c]) => c);
}

// ── the analysis ─────────────────────────────────────────────────────────────

export interface BrokenRef {
  kind: 'table' | 'column';
  /** The identifier as written in the definition. */
  name: string;
  /** For a column: the table it was resolved against (alias-aware). */
  table?: string;
  /** What it was probably renamed to, nearest first. Empty when nothing is close. */
  suggestions: string[];
}

export interface DefReport {
  broken: BrokenRef[];
}

/**
 * Check every table and column a definition references against the catalog.
 *
 * The heavy lifting is the editor diagnostics engine: `unknown-table` and
 * `unknown-column` are exactly the two findings wanted here, and they arrive
 * alias-aware and offset-precise. Every other diagnostic code is noise for
 * this purpose and is filtered out.
 */
export function analyzeDefinition(sql: string, catalog: RefCatalog, engine?: string): DefReport {
  const ctx: DiagContext = {
    objects: catalog.objects,
    columns: catalog.columns,
    indexed: new Map(),
    hasDefaultDb: true,
    // CTEs and derived tables of the definition itself are not in the catalog
    // and never broken — the same exemption the editor gives the buffer.
    virtual: new Set([...findVirtualTables(sql).keys()]),
    engine: engine as Engine | undefined,
  };
  const diags = diagnose(sql, ctx, ';', engine as Engine | undefined)
    .filter(d => d.code === 'unknown-table' || d.code === 'unknown-column');

  const aliases = findAliases(sql);
  // Candidates for table suggestions are the bare names; a schema-qualified
  // suggestion would name a schema the user did not write.
  const bareObjects = new Set<string>();
  for (const o of catalog.objects) {
    if (!o.includes('.')) bareObjects.add(o);
  }

  const broken: BrokenRef[] = [];
  const seen = new Set<string>();
  for (const d of diags) {
    const written = sql.slice(d.from, d.to).replace(/[`"[\]]/g, '');
    if (d.code === 'unknown-table') {
      const key = `t:${written.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      broken.push({
        kind: 'table', name: written,
        suggestions: closest(written.split('.').pop() ?? written, bareObjects),
      });
      continue;
    }
    // unknown-column: the qualifier sits immediately before the offset as
    // `alias.` — resolve it through the definition's aliases to the table.
    const head = /([A-Za-z_][\w$]*)\.\s*$/.exec(sql.slice(0, d.from));
    const qualifier = head?.[1];
    const table = qualifier
      ? aliases.get(qualifier.toLowerCase()) ?? qualifier
      : undefined;
    const tableKey = table?.replace(/[`"[\]]/g, '').toLowerCase();
    const key = `c:${tableKey ?? ''}.${written.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const known = tableKey ? catalog.columns.get(tableKey) : undefined;
    broken.push({
      kind: 'column', name: written, table,
      suggestions: known ? closest(written, known) : [],
    });
  }
  return { broken };
}

/** The one-line verdict for the finding card. */
export function reportSummary(report: DefReport): string {
  if (report.broken.length === 0) {
    return 'Every table and column it references still exists — so the cause is '
      + 'the other half of the server message: the definer is gone or lacks rights.';
  }
  const tables = report.broken.filter(r => r.kind === 'table').length;
  const columns = report.broken.length - tables;
  const parts: string[] = [];
  if (tables) parts.push(`${tables} missing table${tables === 1 ? '' : 's'}`);
  if (columns) parts.push(`${columns} missing column${columns === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
