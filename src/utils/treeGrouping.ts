import type { SchemaNode } from '../types';

// ── Object-type grouping for the schema tree ─────────────────────────────────
//
// list_schema() returns a FLAT list (tables + views + routines + triggers +
// events) when a database (MySQL) or schema (PG) node expands. The tree shows
// a virtual group level — "Tables (n)", "Views (n)", … — built client-side
// from that flat list. Group nodes are visual only: they never appear in the
// "ns.object" parent paths the backend expects (see parentPath).

export type GroupKind =
  | 'tables' | 'partitions' | 'foreign_tables' | 'distributed' | 'views' | 'matviews'
  | 'functions' | 'procedures' | 'macros'
  | 'aggregates' | 'triggers' | 'events' | 'sequences' | 'types' | 'keyspaces'
  | 'policies' | 'extensions'
  // PostgreSQL cluster-global objects — grouped at the connection root.
  | 'publications' | 'event_triggers' | 'tablespaces' | 'foreign_servers';

/** routine_type values that belong in the Aggregates group. */
const AGGREGATE_TYPES = new Set(['AGGREGATE', 'WINDOW']);

/** Virtual tree entry: an object-type group header. */
export interface GroupNode {
  kind: 'group';
  group: GroupKind;
  /** Display label, e.g. "Tables" */
  name: string;
  count: number;
}

export type TreeEntry = SchemaNode | GroupNode;

export function isGroupNode(entry: TreeEntry): entry is GroupNode {
  return entry.kind === 'group';
}

interface GroupDef {
  kind: GroupKind;
  label: string;
  matches: (n: SchemaNode) => boolean;
}

// Fixed display order — tables first (the main object), then the other
// relation-like objects, then code, then the PG-only declarative objects.
// Groups with no members are dropped, so a MySQL connection never shows
// "Materialized views" and a PostgreSQL one never shows "Events".
const GROUP_DEFS: GroupDef[] = [
  // Partitions are tables too, but listing them together buries the real
  // ones — a monthly-partitioned table alone contributes dozens.
  { kind: 'tables',     label: 'Tables',             matches: n => n.kind === 'table' && !n.partition_of },
  { kind: 'partitions', label: 'Partitions',         matches: n => n.kind === 'table' && !!n.partition_of },
  { kind: 'foreign_tables', label: 'Foreign tables', matches: n => n.kind === 'foreign_table' },
  // ClickHouse Distributed tables: proxies over per-shard local tables. Kept
  // apart from real tables so a cluster's fan-out proxies do not read as
  // ordinary storage.
  { kind: 'distributed', label: 'Distributed tables', matches: n => n.kind === 'distributed' },
  { kind: 'views',      label: 'Views',              matches: n => n.kind === 'view' },
  { kind: 'matviews',   label: 'Materialized views', matches: n => n.kind === 'mat_view' },
  { kind: 'functions',  label: 'Functions',          matches: n => n.kind === 'routine' && n.routine_type.toUpperCase() === 'FUNCTION' },
  // PROCEDURE is the only remaining routine_type once functions and
  // aggregates/window functions are claimed — matching on "not FUNCTION"
  // would otherwise swallow PostgreSQL aggregates into Procedures.
  { kind: 'procedures', label: 'Procedures',         matches: n => n.kind === 'routine' && n.routine_type.toUpperCase() === 'PROCEDURE' },
  { kind: 'aggregates', label: 'Aggregates',         matches: n => n.kind === 'routine' && AGGREGATE_TYPES.has(n.routine_type.toUpperCase()) },
  // DuckDB user macros — a macro-heavy file would otherwise scatter them,
  // ungrouped, between the relations. routine_type is MACRO / TABLE_MACRO.
  { kind: 'macros',     label: 'Macros',             matches: n => n.kind === 'routine'
    && (n.routine_type.toUpperCase() === 'MACRO' || n.routine_type.toUpperCase() === 'TABLE_MACRO') },
  { kind: 'triggers',   label: 'Triggers',           matches: n => n.kind === 'trigger' },
  { kind: 'events',     label: 'Events',             matches: n => n.kind === 'event' },
  { kind: 'sequences',  label: 'Sequences',          matches: n => n.kind === 'sequence' },
  { kind: 'types',      label: 'Types',              matches: n => n.kind === 'type' },
  // PostgreSQL-only, and both previously invisible: a policy decides what rows
  // a role can see at all, and an extension decides what the server can do.
  { kind: 'policies',   label: 'RLS policies',       matches: n => n.kind === 'policy' },
  { kind: 'extensions', label: 'Extensions',         matches: n => n.kind === 'extension' },
  // PostgreSQL cluster-global objects. These never appear inside a schema
  // listing (only at the connection root, beside the schemas), so sharing one
  // ordered GROUP_DEFS list with the per-schema kinds is unambiguous.
  { kind: 'publications',   label: 'Publications',    matches: n => n.kind === 'publication' },
  { kind: 'event_triggers', label: 'Event triggers',  matches: n => n.kind === 'event_trigger' },
  { kind: 'tablespaces',    label: 'Tablespaces',     matches: n => n.kind === 'tablespace' },
  { kind: 'foreign_servers', label: 'Foreign servers', matches: n => n.kind === 'foreign_server' },
  // Redis-only: key namespaces, not a SQL concept.
  { kind: 'keyspaces',  label: 'Key namespaces',     matches: n => n.kind === 'key_prefix' },
];

export interface SchemaGroup {
  node: GroupNode;
  items: SchemaNode[];
}

/**
 * Bucket a flat list_schema() result into non-empty type groups, in fixed
 * display order. Anything matching no group (not expected for object lists —
 * e.g. a stray column node) comes back in `ungrouped` and should be rendered
 * flat after the groups.
 */
export function groupSchemaObjects(nodes: SchemaNode[]): { groups: SchemaGroup[]; ungrouped: SchemaNode[] } {
  const buckets = new Map<GroupKind, SchemaNode[]>();
  const ungrouped: SchemaNode[] = [];

  for (const n of nodes) {
    const def = GROUP_DEFS.find(d => d.matches(n));
    if (!def) {
      ungrouped.push(n);
      continue;
    }
    const arr = buckets.get(def.kind);
    if (arr) arr.push(n);
    else buckets.set(def.kind, [n]);
  }

  const groups: SchemaGroup[] = [];
  for (const def of GROUP_DEFS) {
    const items = buckets.get(def.kind);
    if (items && items.length > 0) {
      groups.push({
        node: { kind: 'group', group: def.kind, name: def.label, count: items.length },
        items,
      });
    }
  }
  return { groups, ungrouped };
}

// ── Parent paths ──────────────────────────────────────────────────────────────

export interface PathNode {
  kind: string;
  name: string;
}

/**
 * Build the "ns.object" string the backend expects (list_columns / get_ddl /
 * browse) from a leaf→root chain (leaf first). Group nodes are skipped —
 * they add a visual level only, so a table's path is still "db.table"
 * (MySQL) or "schema.table" (PG). Only the nearest real ancestor joins the
 * path, matching the pre-grouping one-parent semantics (e.g. a column's path
 * is "table.column", not "db.table.column").
 */
export function parentPath(chain: PathNode[]): string {
  const real = chain.filter(n => n.kind !== 'group');
  if (real.length === 0) return '';
  if (real.length === 1) return real[0].name;
  return `${real[1].name}.${real[0].name}`;
}
