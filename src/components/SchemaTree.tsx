import { errorDisplay } from '../utils/appError';
import { confirmDialog, promptDialog } from '../utils/appDialog';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { SchemaNode, Session } from '../types';
import { SchemaStore } from '../store/schema';
import { publishSchemaScan, clearSchemaScan } from '../store/schemaScan';
import { preserveExpansion, openDescendantIds } from '../utils/treeMerge';
import { DdlModal } from './DdlModal';
import { VirtualFkModal } from './VirtualFkModal';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { historySql } from '../utils/temporalSql';
import { duplicateTableSql } from '../utils/duplicateTable';
import { insertTemplate, updateTemplate } from '../utils/gridEdits';
import { quoteIdent } from '../utils/sqlIdent';
import { formatBytes } from '../utils/datagenSql';
import { extensionCreateSql, extensionDropSql, AVAILABLE_EXTENSIONS_SQL, type AvailableExtension } from '../utils/pgObjectSql';
import { createSchemaSql, dropSchemaSql, createDatabaseSql, dropDatabaseSql } from '../utils/schemaObjSql';
import { QueryStore } from '../store/query';
import { can } from '../utils/engineCaps';
import { groupSchemaObjects, isGroupNode, parentPath, type PathNode, type TreeEntry } from '../utils/treeGrouping';
import { splitQualifiedName, nameMatches, qualifierCandidates, REVEALABLE_KINDS } from '../utils/revealObject';
import { ChevronIcon, ObjectIcon, SpinnerIcon } from './treeIcons';

// ── Tree node state ───────────────────────────────────────────────────────────

interface TreeNode {
  id: string;          // unique key
  node: TreeEntry;     // SchemaNode, or a virtual group node (Tables / Views / …)
  depth: number;
  expanded: boolean;
  loading: boolean;
  children: TreeNode[] | null; // null = not yet loaded
  parent: string | null;       // parent id
}

type Action =
  | { type: 'SET_ROOT'; nodes: SchemaNode[]; merge: boolean }
  | { type: 'SET_LOADING'; id: string }
  | { type: 'SET_ERROR'; id: string }
  | { type: 'SET_CHILDREN'; id: string; children: SchemaNode[] }
  | { type: 'TOGGLE'; id: string }
  | { type: 'COLLAPSE'; id: string };

function nodeId(node: TreeEntry, prefix: string): string {
  return `${prefix}::${node.kind}::${'name' in node ? node.name : ''}`;
}

function makeTreeNodes(nodes: SchemaNode[], depth: number, parentId: string | null, prefix: string): TreeNode[] {
  return nodes.map(n => ({
    id: nodeId(n, prefix),
    node: n,
    depth,
    expanded: false,
    loading: false,
    children: null,
    parent: parentId,
  }));
}

/**
 * Children of a database (MySQL) or schema (PG) node arrive FLAT from
 * list_schema() and get a virtual group level here: Tables / Views /
 * Functions / Procedures / Triggers / Events — non-empty groups only. Group
 * nodes carry their items pre-loaded, so expanding a group is always instant.
 */
function childTreeNodes(parent: TreeNode, children: SchemaNode[]): TreeNode[] {
  if (parent.node.kind !== 'database' && parent.node.kind !== 'schema') {
    return makeTreeNodes(children, parent.depth + 1, parent.id, parent.id);
  }
  const { groups, ungrouped } = groupSchemaObjects(children);
  const groupNodes: TreeNode[] = groups.map(g => {
    const id = `${parent.id}::group::${g.node.group}`;
    return {
      id,
      node: g.node,
      depth: parent.depth + 1,
      expanded: false,
      loading: false,
      children: makeTreeNodes(g.items, parent.depth + 2, id, id),
      parent: parent.id,
    };
  });
  return [...groupNodes, ...makeTreeNodes(ungrouped, parent.depth + 1, parent.id, parent.id)];
}

/**
 * Root-level nodes get a virtual group level too, but only for the PG
 * cluster-global kinds (publications / event triggers / tablespaces / foreign
 * servers). Databases (MySQL) and schemas (PG) match no group def, so they
 * fall through to `ungrouped` and stay flat at the top exactly as before; the
 * global-object groups are appended after them.
 */
function rootTreeNodes(nodes: SchemaNode[]): TreeNode[] {
  const { groups, ungrouped } = groupSchemaObjects(nodes);
  const flat = makeTreeNodes(ungrouped, 0, null, 'root');
  const groupNodes: TreeNode[] = groups.map(g => {
    const id = `root::group::${g.node.group}`;
    return {
      id,
      node: g.node,
      depth: 0,
      expanded: false,
      loading: false,
      children: makeTreeNodes(g.items, 1, id, id),
      parent: null,
    };
  });
  return [...flat, ...groupNodes];
}

/** Objects whose children are columns + indexes (fetched via list_columns). */
function isRelation(node: TreeEntry): boolean {
  // A ClickHouse Distributed table is relation-like: it has columns, browses,
  // and has DDL — only its storage is remote. It rides this path so it inherits
  // browse / show-columns / DDL / select-top for free; kind-specific items
  // (edit view, design table, …) stay gated to their own kinds.
  return node.kind === 'table' || node.kind === 'view' || node.kind === 'mat_view'
    || node.kind === 'distributed';
}

/**
 * PostgreSQL cluster-global object kinds (rendered at the connection root, not
 * inside a schema). They have no schema, so their "View DDL" is routed through
 * the `pg_global.<name>` sentinel the backend understands.
 */
const PG_GLOBAL_KINDS = new Set(['publication', 'event_trigger', 'tablespace', 'foreign_server']);
function isPgGlobal(node: TreeEntry): boolean {
  return PG_GLOBAL_KINDS.has(node.kind);
}

/** Objects whose only meaningful action is showing their DDL. */
function isDdlOnly(node: TreeEntry): boolean {
  return node.kind === 'routine' || node.kind === 'trigger' || node.kind === 'event'
    || node.kind === 'sequence' || node.kind === 'type' || node.kind === 'foreign_table'
    || isPgGlobal(node);
}

function isExpandable(node: TreeEntry): boolean {
  return node.kind === 'database' || node.kind === 'schema' || node.kind === 'group'
    || node.kind === 'struct_column'   // Parquet nested column → its child fields
    || isRelation(node);
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.expanded && n.children) {
      out.push(...flatten(n.children));
    }
  }
  return out;
}

function applyAction(roots: TreeNode[], action: Action): TreeNode[] {
  switch (action.type) {
    case 'SET_ROOT': {
      const fresh = rootTreeNodes(action.nodes);
      // The ↺ button re-reads the whole tree; merging keeps whatever the user
      // had open instead of snapping the explorer shut. A *different session*
      // must never merge: node ids are name-based, so a same-named database on
      // another server would inherit the old one's expansion and children.
      return action.merge ? preserveExpansion(roots, fresh) : fresh;
    }

    case 'SET_LOADING':
      return updateNode(roots, action.id, n => ({ ...n, loading: true }));

    case 'SET_ERROR':
      return updateNode(roots, action.id, n => ({ ...n, loading: false }));

    case 'SET_CHILDREN':
      return updateNode(roots, action.id, n => {
        const fresh = childTreeNodes(n, action.children);
        return {
          ...n,
          loading: false,
          expanded: true,
          // A first expansion has nothing to preserve; a refresh has the old
          // subtree, and its expansion state must survive the new list.
          children: preserveExpansion(n.children, fresh),
        };
      });

    case 'TOGGLE':
      return updateNode(roots, action.id, n => ({
        ...n,
        expanded: n.children !== null ? !n.expanded : n.expanded,
      }));

    case 'COLLAPSE':
      return updateNode(roots, action.id, n => ({ ...n, expanded: false }));

    default:
      return roots;
  }
}

function updateNode(nodes: TreeNode[], id: string, fn: (n: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map(n => {
    if (n.id === id) return fn(n);
    if (n.children) return { ...n, children: updateNode(n.children, id, fn) };
    return n;
  });
}

// ── Labels ────────────────────────────────────────────────────────────────────

function nodeName(node: TreeEntry): string {
  return 'name' in node ? node.name : '';
}

function nodeSubtext(node: TreeEntry): string | null {
  if (isGroupNode(node)) return `(${node.count})`;
  if (node.kind === 'column') return node.type_name + (node.nullable ? '' : ' NN');
  if (node.kind === 'struct_column') return node.type_name + (node.nullable ? '' : ' NN');
  if (node.kind === 'index')  return node.columns.join(', ');
  if (node.kind === 'routine') return node.routine_type.toLowerCase();
  if (node.kind === 'type')    return node.type_kind.toLowerCase();
  // A policy is meaningless without the table it guards and the command it
  // covers — those are the two things you look for.
  if (node.kind === 'policy')  return `${node.table} · ${node.command}`;
  // An installed version that is behind the available one is an
  // ALTER EXTENSION … UPDATE nobody has run; say so rather than just the number.
  if (node.kind === 'extension') {
    return node.default_version && node.default_version !== node.version
      ? `${node.version} → ${node.default_version} available`
      : node.version;
  }
  // Global PG objects: the one fact you look for on each.
  if (node.kind === 'publication')   return node.all_tables ? 'all tables' : `${node.table_count} tables`;
  if (node.kind === 'event_trigger') return `${node.event}${node.enabled ? '' : ' · disabled'}`;
  if (node.kind === 'tablespace')    return node.location || node.owner;
  if (node.kind === 'foreign_server') return node.fdw;
  if (node.kind === 'foreign_table')  return `→ ${node.server}`;
  if (node.kind === 'trigger' && node.table) return `on ${node.table}`;
  if (node.kind === 'table' && node.partition_of) return `of ${node.partition_of}`;
  // Says the table keeps history. Worth a permanent marker rather than a
  // tooltip: it changes what DELETE means, and it is invisible everywhere else.
  if (node.kind === 'table' && node.temporal) return 'versioned';
  if (node.kind === 'key_prefix') return `${node.count.toLocaleString()}${node.sampled ? '+ (sampled)' : ''}`;
  // Distributed table: the cluster it fans out over is the one fact that
  // separates it from a plain table; the local target lives in the tooltip.
  if (node.kind === 'distributed') return `⇄ ${node.cluster}`;
  // MV storage target: the backing table, plus its real on-disk size when the
  // target is a MergeTree (bytes/parts) — that is the MV's actual footprint.
  if (node.kind === 'mat_view_target') {
    const where = node.schema ? `${node.schema}.${node.name}` : node.name;
    const size = node.bytes != null
      ? ` · ${formatBytes(node.bytes)}${node.parts != null ? ` · ${node.parts} parts` : ''}`
      : '';
    return `→ ${where}${size}`;
  }
  return null;
}

/** Row tooltip — richer than the bare name for the CH proxy kinds. */
function nodeTitle(node: TreeEntry): string {
  if (node.kind === 'distributed') {
    return `Distributed table on cluster '${node.cluster}' → local table ${node.target_db}.${node.target_table}`;
  }
  if (node.kind === 'mat_view_target') {
    return `Storage table this materialized view writes into: ${node.schema ? `${node.schema}.` : ''}${node.name}`;
  }
  return nodeName(node);
}

// ── Parent path for API calls ─────────────────────────────────────────────────

/**
 * Walk the leaf→root chain and build "ns.object". Virtual group nodes are
 * skipped by parentPath — a table's chain is table → group → database[/schema],
 * and its path stays "db.table" / "schema.table" exactly as before grouping.
 */
function buildParent(tn: TreeNode, allNodes: TreeNode[]): string {
  const chain: PathNode[] = [];
  let cur: TreeNode | null = tn;
  let guard = 0;
  while (cur && guard++ < 32) {
    chain.push({ kind: cur.node.kind, name: nodeName(cur.node) });
    cur = cur.parent ? findNode(allNodes, cur.parent) : null;
  }
  return parentPath(chain);
}

/** "reporting.orders" for a relation, "reporting" for a container — the
 *  one-line scan readout the status bar shows while the fetch runs. */
function scanLabel(tn: TreeNode, allNodes: TreeNode[]): string {
  // Parquet nested column: the dotted path is its qualified name.
  return tn.node.kind === 'struct_column' ? tn.node.path : buildParent(tn, allNodes);
}

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** First node in the subtree (pre-loaded group children included) matching. */
function findMatching(nodes: TreeNode[], pred: (n: TreeNode) => boolean): TreeNode | null {
  for (const n of nodes) {
    if (pred(n)) return n;
    if (n.children) {
      const found = findMatching(n.children, pred);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Poll a condition until it holds (each reducer dispatch re-renders and the
 * caller re-reads its mirror ref), capped so a missing target never hangs.
 * Shared by the reveal paths, which expand a level, wait for the fetch, then
 * look inside it.
 */
async function pollUntil<T>(pred: () => T | null, tries = 120): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const v = pred();
    if (v) return v;
    await new Promise(r => setTimeout(r, 16));
  }
  return null;
}

/** Nearest ancestor that is NOT a virtual group node (database or schema). */
function nearestRealAncestor(tn: TreeNode, allNodes: TreeNode[]): TreeNode | null {
  let cur = tn.parent ? findNode(allNodes, tn.parent) : null;
  let guard = 0;
  while (cur && isGroupNode(cur.node) && guard++ < 8) {
    cur = cur.parent ? findNode(allNodes, cur.parent) : null;
  }
  return cur;
}

// ── Drop ──────────────────────────────────────────────────────────────────────

/**
 * The DROP statement for a tree object, or null when the kind has none (group
 * nodes, MV storage targets, PG cluster-global objects). Used by the context
 * menu's Drop item, which executes it after one explicit confirmation.
 *
 * Dialect notes: PG triggers drop ON their table (the node carries it); a CH
 * materialized view drops with plain DROP VIEW; a PG domain is DROP DOMAIN,
 * every other type kind DROP TYPE; a CH dictionary is a Routine node but drops
 * as DROP DICTIONARY. PG functions can be overloaded — the bare form errors on
 * an ambiguous name, and that error is shown as-is.
 */
function dropSql(tn: TreeNode, flat: TreeNode[], engine: string): { sql: string; label: string; what: string } | null {
  const node = tn.node;
  const name = nodeName(node);
  const qualified = () => buildParent(tn, flat).split('.').map(p => quoteIdent(p, engine)).join('.');
  switch (node.kind) {
    case 'table':
    case 'distributed':
      return { sql: `DROP TABLE ${qualified()};`, label: 'Drop table', what: `table ${name}` };
    case 'foreign_table':
      return { sql: `DROP FOREIGN TABLE ${qualified()};`, label: 'Drop foreign table', what: `foreign table ${name}` };
    case 'view':
      return { sql: `DROP VIEW ${qualified()};`, label: 'Drop view', what: `view ${name}` };
    case 'mat_view':
      return {
        sql: engine === 'postgres' ? `DROP MATERIALIZED VIEW ${qualified()};` : `DROP VIEW ${qualified()};`,
        label: 'Drop materialized view', what: `materialized view ${name}`,
      };
    case 'sequence':
      return { sql: `DROP SEQUENCE ${qualified()};`, label: 'Drop sequence', what: `sequence ${name}` };
    case 'event':
      return { sql: `DROP EVENT ${qualified()};`, label: 'Drop event', what: `event ${name}` };
    case 'routine': {
      if (node.routine_type === 'DICTIONARY')
        return { sql: `DROP DICTIONARY ${qualified()};`, label: 'Drop dictionary', what: `dictionary ${name}` };
      // DuckDB macros drop with their own verbs, not DROP FUNCTION.
      if (node.routine_type === 'TABLE_MACRO')
        return { sql: `DROP MACRO TABLE ${qualified()};`, label: 'Drop table macro', what: `table macro ${name}` };
      if (node.routine_type === 'MACRO')
        return { sql: `DROP MACRO ${qualified()};`, label: 'Drop macro', what: `macro ${name}` };
      const kw = node.routine_type === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION';
      return { sql: `DROP ${kw} ${qualified()};`, label: `Drop ${kw.toLowerCase()}`, what: `${kw.toLowerCase()} ${name}` };
    }
    case 'type': {
      const kw = node.type_kind.toUpperCase() === 'DOMAIN' ? 'DOMAIN' : 'TYPE';
      return { sql: `DROP ${kw} ${qualified()};`, label: `Drop ${kw.toLowerCase()}`, what: `${kw.toLowerCase()} ${name}` };
    }
    case 'trigger': {
      if (engine === 'postgres') {
        if (!node.table) return null;
        const schemaParts = buildParent(tn, flat).split('.');
        schemaParts.pop();
        const on = [...schemaParts, node.table].filter(Boolean).map(p => quoteIdent(p, engine)).join('.');
        return { sql: `DROP TRIGGER ${quoteIdent(name, engine)} ON ${on};`, label: 'Drop trigger', what: `trigger ${name}` };
      }
      return { sql: `DROP TRIGGER ${qualified()};`, label: 'Drop trigger', what: `trigger ${name}` };
    }
    case 'extension':
      return { sql: extensionDropSql(name), label: 'Drop extension', what: `extension ${name}` };
    case 'database':
      return { sql: dropDatabaseSql({ engine, name }), label: 'Drop database', what: `database ${name} — and everything in it` };
    case 'schema':
      // Plain form; the menu handler asks about CASCADE first.
      return { sql: dropSchemaSql({ engine, name, cascade: false }), label: 'Drop schema', what: `schema ${name}` };
    default:
      return null;
  }
}

// ── Slow-expand hint ──────────────────────────────────────────────────────────

/** Renders "(still working…)" once a row has been loading for >3 s. */
/** Per-row callbacks, identity-stable so TreeRow's memo holds. */
interface RowApi {
  click(tn: TreeNode): void;
  chevron(tn: TreeNode): void;
  open(tn: TreeNode): void;
  ctx(e: React.MouseEvent, tn: TreeNode): void;
}

/**
 * One tree row, memoized (WP-14 14.2): unchanged nodes keep their TreeNode
 * identity across flattens, so a spinner tick or highlight flash reconciles
 * the handful of rows that changed instead of every visible node. Absolutely
 * positioned by the host's windowing math.
 */
const TreeRow = memo(function TreeRow({ tn, highlighted, top, api }: {
  tn: TreeNode; highlighted: boolean; top: number; api: RowApi;
}) {
  const expandable = isExpandable(tn.node);
  const sub = nodeSubtext(tn.node);
  return (
    <div
      id={tn.id}
      className={`tree-row depth-${Math.min(tn.depth, 6)}${tn.loading ? ' loading' : ''}`}
      // One indent step per level (--tree-indent, 8px) on top of the fixed
      // 8px gutter. Depth is capped so a deep chain cannot push labels out
      // of a narrow sidebar.
      style={{
        position: 'absolute', top, left: 0, right: 0,
        paddingLeft: `calc(8px + ${Math.min(tn.depth, 8)} * var(--tree-indent))`,
        // Brief landing flash after a "Go to … table" jump.
        ...(highlighted
          ? { background: 'var(--accent-muted, rgba(120,160,255,0.22))' }
          : {}),
      }}
      onClick={() => api.click(tn)}
      onDoubleClick={() => api.open(tn)}
      onContextMenu={e => api.ctx(e, tn)}
      // No hover tooltip on ordinary rows — it only ever repeated the label.
      // The two kinds whose title carries real information (where a
      // Distributed / MV storage table actually lives) keep it.
      title={(tn.node.kind === 'distributed' || tn.node.kind === 'mat_view_target')
        ? nodeTitle(tn.node)
        : undefined}
    >
      {expandable && (
        <span
          className={`tree-chevron${tn.expanded && !tn.loading ? ' open' : ''}`}
          onClick={e => { e.stopPropagation(); api.chevron(tn); }}
        >
          {tn.loading ? <SpinnerIcon className="tree-spinner" /> : <ChevronIcon />}
        </span>
      )}
      {!expandable && <span className="tree-chevron-spacer" />}
      <ObjectIcon entry={tn.node} />
      <span className="tree-label">{nodeName(tn.node)}</span>
      {tn.loading && <SlowHint />}
      {sub && <span className="tree-sub">{sub}</span>}
    </div>
  );
});

function SlowHint() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, []);
  return slow ? <span className="tree-slow-hint">(still working…)</span> : null;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  session:        Session;
  refreshKey?:    number;    // increment to force a schema reload
  onInsertText?:  (text: string) => void;
  onBrowseTable?: (table: string, kind: 'table' | 'view') => void;
  onCollapse?:    () => void;
}

export function SchemaTree({ session, refreshKey, onInsertText, onBrowseTable, onCollapse }: Props) {
  const [roots, dispatch] = useReducer(applyAction, []);
  // Key of the root list that finished loading — the root is "loading" whenever
  // the current session/refreshKey has no completed load yet (derived, so the
  // effect below never needs a synchronous setState).
  const rootKey = `${session.sessionId}:${refreshKey ?? 0}`;
  const [rootLoadedKey, setRootLoadedKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const rootLoading = rootLoadedKey !== rootKey && !loadError;
  const [refreshing, setRefreshing] = useState(false);
  /** Unique token per drop, so a running drop can be addressed by cancel maps. */
  const dropSeq = useRef(0);
  /** The pending drop the in-DOM confirmation modal is showing (null = closed). */
  const [dropConfirm, setDropConfirm] = useState<{ tn: TreeNode; sql: string; what: string } | null>(null);
  // Memoized (WP-14 14.2): flatten used to run on EVERY render — thousands
  // of expanded tables paid O(n) per spinner tick / highlight flash.
  const flat = useMemo(() => flatten(roots), [roots]);
  const flatRef2 = useRef(flat);
  useEffect(() => { flatRef2.current = flat; }, [flat]);

  // ── Row windowing (FastGrid's row-window math, fixed-height rows) ────────
  const listRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listViewH, setListViewH] = useState(600);
  // Measured from a probe row so the font-size stepper cannot desync the math.
  const [treeRowH, setTreeRowH] = useState(19);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      setListViewH(el.clientHeight);
      const h = probeRef.current?.offsetHeight;
      if (h && h > 0) setTreeRowH(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Center a row (by node id) in the list — windowing means off-screen rows
   *  have no DOM element to scrollIntoView, so scrolling is index-based. */
  const scrollRowIntoView = useCallback((id: string) => {
    const el = listRef.current;
    if (!el) return;
    const idx = flatRef2.current.findIndex(t => t.id === id);
    if (idx < 0) return;
    const rowH = probeRef.current?.offsetHeight || 19;
    el.scrollTo({ top: Math.max(0, idx * rowH - el.clientHeight / 2), behavior: 'smooth' });
  }, []);


  /** CASCADE checkbox of the drop modal — only rendered for schema drops. */
  const [dropCascade, setDropCascade] = useState(false);
  const [ddl, setDdl] = useState<{ title: string; sql: string } | null>(null);
  const [vfkTable, setVfkTable] = useState<string | null>(null);
  // "Go to local/storage table" navigation briefly tints the row it lands on so
  // the jump is visible; `rootsRef` mirrors the reducer state so the async
  // reveal can read the freshly-expanded tree between dispatches.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const rootsRef = useRef<TreeNode[]>([]);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number; y: number; tn: TreeNode;
  } | null>(null);
  // "Create extension…" picker — loaded on demand from pg_available_extensions.
  const [extPicker, setExtPicker] = useState<
    { loading: boolean; error: string | null; items: AvailableExtension[] } | null
  >(null);
  // "Create schema/database…" dialog — a small name (+ owner/charset) form that
  // emits CREATE … into the editor for review, never runs it. `objType` picks
  // which builder and which optional fields the form shows.
  const [objDialog, setObjDialog] = useState<
    { objType: 'schema' | 'database'; name: string; owner: string; charset: string; collate: string } | null
  >(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const openExtensionPicker = useCallback(async () => {
    setExtPicker({ loading: true, error: null, items: [] });
    try {
      const res = await QueryStore.execute(session.sessionId, AVAILABLE_EXTENSIONS_SQL);
      const items: AvailableExtension[] = res.rows.map(r => ({
        name: String(r[0]),
        version: r[1] == null ? null : String(r[1]),
        comment: r[2] == null ? null : String(r[2]),
      }));
      setExtPicker({ loading: false, error: null, items });
    } catch (e) {
      setExtPicker({ loading: false, error: errorDisplay(e), items: [] });
    }
  }, [session.sessionId]);

  // Load root nodes when session opens or refreshKey changes
  const loadedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    // Same session (a ↺ refresh) → keep the expansion. New session → start clean.
    const sameSession = loadedSessionRef.current === session.sessionId;
    SchemaStore.listSchema(session.sessionId)
      .then(nodes => {
        setLoadError(null);
        setRootLoadedKey(`${session.sessionId}:${refreshKey ?? 0}`);
        loadedSessionRef.current = session.sessionId;
        dispatch({ type: 'SET_ROOT', nodes, merge: sameSession });
      })
      .catch(e => setLoadError(errorDisplay(e)));
  }, [session.sessionId, refreshKey]);

  const handleExpand = useCallback(async (tn: TreeNode, allFlat: TreeNode[]) => {
    if (!isExpandable(tn.node)) return;
    if (tn.loading) return;

    // Already loaded → just toggle visibility. Group nodes always have their
    // items pre-loaded, so they take this instant path on every click.
    if (tn.children !== null) {
      dispatch({ type: 'TOGGLE', id: tn.id });
      return;
    }

    dispatch({ type: 'SET_LOADING', id: tn.id });

    try {
      let children: SchemaNode[];
      const name = nodeName(tn.node);

      if (tn.node.kind === 'database' || tn.node.kind === 'schema') {
        children = await SchemaStore.listSchema(session.sessionId, name);
      } else {
        // table or view → fetch columns + indexes
        const parent = buildParent(tn, allFlat);
        children = await SchemaStore.listColumns(session.sessionId, parent);
      }

      dispatch({ type: 'SET_CHILDREN', id: tn.id, children });
    } catch (e) {
      dispatch({ type: 'SET_ERROR', id: tn.id }); // clear spinner, keep collapsed
      setLoadError(errorDisplay(e));
    }
  }, [session.sessionId]);

  // "Go to … table" navigation. Imperative and async (not an effect) so it can
  // await the reducer settling between steps: expand the database, open the
  // group that holds the target, then highlight and scroll to it. Reads the
  // live tree through `rootsRef`, and gives up quietly if the target's database
  // is not in this catalog.
  const revealTable = useCallback(async (db: string, table: string) => {
    setCtxMenu(null);
    const dbId = `root::database::${db}`;
    // Poll the mirror ref until a condition holds (each dispatch re-renders and
    // updates the ref), capped so a missing target can never hang.
    const settle = async <T,>(pred: () => T | null, tries = 120): Promise<T | null> => {
      for (let i = 0; i < tries; i++) {
        const v = pred();
        if (v) return v;
        await new Promise(r => setTimeout(r, 16));
      }
      return null;
    };

    const dbNode = findNode(rootsRef.current, dbId);
    if (!dbNode) return;                                     // db not in this tree
    if (dbNode.children === null) {
      if (!dbNode.loading) handleExpand(dbNode, flatten(rootsRef.current));
    } else if (!dbNode.expanded) {
      dispatch({ type: 'TOGGLE', id: dbId });
    }

    // Wait for the database to be loaded + expanded.
    const loaded = await settle(() => {
      const d = findNode(rootsRef.current, dbId);
      return d && d.children && d.expanded ? d : null;
    });
    if (!loaded) return;

    // Group children are pre-loaded even while collapsed, so search the whole
    // subtree for the target relation.
    const target = findMatching(loaded.children!, n =>
      'name' in n.node && n.node.name === table
      && ['table', 'distributed', 'view', 'mat_view'].includes(n.node.kind));
    if (!target) return;                                     // not found — give up

    // Open the group that holds it so the row actually renders.
    const grp = target.parent && target.parent !== dbId ? findNode(rootsRef.current, target.parent) : null;
    if (grp && isGroupNode(grp.node) && !grp.expanded) {
      dispatch({ type: 'TOGGLE', id: grp.id });
    }
    // Windowed list: an off-screen row has no DOM element — wait for the id
    // to appear in the flattened order, then scroll by index.
    await settle(() => (flatten(rootsRef.current).some(t => t.id === target.id) ? true : null), 40);
    setHighlightId(target.id);
    scrollRowIntoView(target.id);
  }, [handleExpand, scrollRowIntoView]);

  /**
   * "Reveal in database tree" (dbgui:reveal-object) — the F12 go-to-object's
   * mirror: the editor resolves the identifier under the caret and hands the
   * name here; the tree finds it, expands the path, scrolls and flashes it.
   *
   * The name arrives bare (`orders`) or qualified (`public.orders`, DuckDB's
   * `db.schema.table`), possibly quoted. Qualified names search the matching
   * database/schema containers only; a bare name searches them all, after a
   * free check of the root level (SQLite / Parquet / DuckDB keep relations at
   * the root). Like revealTable, a name that is not in this catalog gives up
   * quietly — every mounted session's tree hears the event.
   */
  const revealObject = useCallback(async (raw: string) => {
    setCtxMenu(null);
    const parts = splitQualifiedName(raw);
    if (parts.length === 0) return;
    const name = parts[parts.length - 1];

    const isContainer = (n: TreeNode) => n.node.kind === 'database' || n.node.kind === 'schema';
    const isTarget = (n: TreeNode) => 'name' in n.node && REVEALABLE_KINDS.has(n.node.kind);

    const flash = async (tn: TreeNode) => {
      // Open the group that holds the target so the row actually renders.
      const grp = tn.parent ? findNode(rootsRef.current, tn.parent) : null;
      if (grp && isGroupNode(grp.node) && !grp.expanded) {
        dispatch({ type: 'TOGGLE', id: grp.id });
      }
      await pollUntil(() => (flatten(rootsRef.current).some(t => t.id === tn.id) ? true : null), 40);
      setHighlightId(tn.id);
      scrollRowIntoView(tn.id);
    };

    // Root-level relations need no fetching at all — try them first for bare
    // names, and as the fallback when a qualifier matched no container.
    const rootHit = () => findMatching(rootsRef.current, n =>
      !isContainer(n) && isTarget(n) && nameMatches(nodeName(n.node), name));
    const quals = qualifierCandidates(parts);
    if (quals.length === 0) {
      const hit = rootHit();
      if (hit) { await flash(hit); return; }
    }

    const containers = rootsRef.current.filter(isContainer);
    const ordered = quals.length > 0
      ? containers.filter(c => quals.some(q => nameMatches(nodeName(c.node), q)))
      : containers;
    // A bare name on a wide server expands databases one at a time, capped —
    // revealing an object is not worth listing a 200-database catalog.
    for (const c of ordered.slice(0, 16)) {
      if (c.children === null) {
        if (!c.loading) void handleExpand(c, flatten(rootsRef.current));
      } else if (!c.expanded) {
        dispatch({ type: 'TOGGLE', id: c.id });
      }
      const loaded = await pollUntil(() => {
        const d = findNode(rootsRef.current, c.id);
        return d && d.children && d.expanded ? d : null;
      });
      if (!loaded) continue;
      // Group children are pre-loaded even while collapsed, so the whole
      // subtree is searchable; exact case first, folded as the fallback.
      const target = findMatching(loaded.children!, n => isTarget(n) && nodeName(n.node) === name)
        ?? findMatching(loaded.children!, n => isTarget(n) && nameMatches(nodeName(n.node), name));
      if (!target) continue;
      await flash(target);
      return;
    }
    if (quals.length > 0) {
      const hit = rootHit();
      if (hit) await flash(hit);
    }
  }, [handleExpand, scrollRowIntoView]);

  // The editor (or the command palette) asks by event so neither imports the
  // other. `sessionId` in the detail scopes the reveal to one session's tree;
  // without it every mounted tree tries and only the one holding the object
  // flashes anything.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const d = (e as CustomEvent<{ name?: string; sessionId?: string }>).detail;
      if (!d?.name) return;
      if (d.sessionId && d.sessionId !== session.sessionId) return;
      void revealObject(d.name);
    };
    window.addEventListener('dbgui:reveal-object', onReveal);
    return () => window.removeEventListener('dbgui:reveal-object', onReveal);
  }, [revealObject, session.sessionId]);

  // Mirror the reducer state into a ref so the async reveal can read the
  // freshly-expanded tree it polls for between dispatches.
  useEffect(() => { rootsRef.current = roots; }, [roots]);

  // Clear the landing highlight after a moment — it is a "here it is" flash,
  // not a persistent selection.
  useEffect(() => {
    if (!highlightId) return;
    const t = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(t);
  }, [highlightId]);

  const handleContextMenu = useCallback((e: React.MouseEvent, tn: TreeNode) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, tn });
  }, []);

  // Force a fresh re-fetch of a node's children (bypasses the cache) so a
  // table's columns / a schema's tables re-sync with the server.
  /** Re-read one node's children from the server. */
  const loadChildren = useCallback(async (tn: TreeNode, allFlat: TreeNode[]) => {
    if (tn.node.kind === 'database' || tn.node.kind === 'schema')
      return SchemaStore.listSchema(session.sessionId, nodeName(tn.node));
    // Parquet nested column: fetch by its dotted path, not the 2-level parent.
    if (tn.node.kind === 'struct_column')
      return SchemaStore.listParquetStruct(session.sessionId, tn.node.path);
    return SchemaStore.listColumns(session.sessionId, buildParent(tn, allFlat));
  }, [session.sessionId]);

  /**
   * Re-fetch a set of open, lazily loaded nodes in parallel, publishing each
   * one's name to the status bar as its fetch starts. Shared by the per-node
   * refresh (below) and the ↻ whole-tree refresh, so both leave everything
   * visible actually fresh, not just the level that was clicked.
   */
  const refetchOpenNodes = useCallback(async (ids: string[], allFlat: TreeNode[]) => {
    await Promise.all(ids.map(async id => {
      const node = allFlat.find(n => n.id === id);
      if (!node || node.node.kind === 'group') return;
      publishSchemaScan(session.sessionId, `scanning ${scanLabel(node, allFlat)}…`);
      try {
        dispatch({ type: 'SET_CHILDREN', id, children: await loadChildren(node, allFlat) });
      } catch {
        // A table dropped between the two fetches is not an error — the parent
        // refresh has already removed it from the tree.
      }
    }));
  }, [loadChildren, session.sessionId]);

  const refreshNode = useCallback(async (tn: TreeNode, allFlat: TreeNode[]) => {
    dispatch({ type: 'SET_LOADING', id: tn.id });
    publishSchemaScan(session.sessionId, `scanning ${scanLabel(tn, allFlat)}…`);
    try {
      dispatch({ type: 'SET_CHILDREN', id: tn.id, children: await loadChildren(tn, allFlat) });
      window.dispatchEvent(new CustomEvent('dbgui:schema-changed'));
    } catch (e) {
      dispatch({ type: 'SET_ERROR', id: tn.id });
      setLoadError(errorDisplay(e));
      clearSchemaScan(session.sessionId);
      return;
    }
    // Everything below stays open (preserveExpansion), so everything below
    // must also be current — otherwise a refresh would leave visibly stale
    // columns behind the freshly refreshed table list. Group nodes carry their
    // items inline and need no fetch; only lazily loaded levels do.
    const stale = openDescendantIds(allFlat, tn.id);
    try {
      await refetchOpenNodes(stale, allFlat);
    } finally {
      clearSchemaScan(session.sessionId);
    }
  }, [loadChildren, refetchOpenNodes, session.sessionId]);

  /**
   * The ↻ button: re-list the root, then re-fetch everything open on screen
   * (bounded by exactly what's expanded — the same rule refreshNode applies
   * below its node), so a refresh no longer leaves open subtrees stale. The
   * status bar follows along ("scanning reporting.orders…"); the treeFresh
   * detail tells App the tree is already current, so schema-changed only
   * re-sweeps the completion cache instead of listing the root a second time.
   */
  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    publishSchemaScan(session.sessionId, `Refreshing ${session.connectionName}…`);
    const allFlat = flatRef2.current;
    try {
      const nodes = await SchemaStore.listSchema(session.sessionId);
      setLoadError(null);
      dispatch({ type: 'SET_ROOT', nodes, merge: true });
      // Node ids are name-paths, so the merge keeps every open id valid; a
      // node gone from the server simply isn't found and is skipped.
      const open = allFlat.filter(n => n.expanded && n.children !== null).map(n => n.id);
      await refetchOpenNodes(open, allFlat);
    } catch (e) {
      setLoadError(errorDisplay(e));
    } finally {
      clearSchemaScan(session.sessionId);
      setTimeout(() => setRefreshing(false), 350);
    }
    window.dispatchEvent(new CustomEvent('dbgui:schema-changed', { detail: { treeFresh: true } }));
  }, [refetchOpenNodes, session.sessionId, session.connectionName]);

  async function showDdl(tn: TreeNode, allFlat: TreeNode[]) {
    // Cluster-global objects have no schema in the tree; route their DDL lookup
    // through the sentinel namespace the backend resolves by name.
    const parent = isPgGlobal(tn.node)
      ? `pg_global.${nodeName(tn.node)}`
      : buildParent(tn, allFlat);
    try {
      const sql = await SchemaStore.getDdl(session.sessionId, parent);
      setDdl({ title: nodeName(tn.node), sql });
    } catch (e) {
      setLoadError(errorDisplay(e));
    }
    setCtxMenu(null);
  }

  /**
   * Open the drop confirmation modal. This is an in-DOM modal, never
   * window.confirm: on WebKitGTK an unhandled script dialog resolves as if
   * ACCEPTED, so a window.confirm here would drop the object with no prompt
   * at all (verified live — the drop ran with no dialog on screen).
   */
  function askDrop(tn: TreeNode, sql: string, what: string) {
    setCtxMenu(null);
    setDropCascade(false);
    setDropConfirm({ tn, sql, what });
  }

  /**
   * Execute the drop the modal confirmed, then refresh the level the object
   * lived at so the tree immediately shows what survived. Runs through
   * `panel_query`, so the server-side write guard and prod hard limits apply
   * exactly as they do to editor SQL: a read-only connection refuses, and
   * prod refuses destructive DDL unless the connection opted out. The error
   * is surfaced in the tree, not swallowed.
   */
  async function execDrop() {
    const d = dropConfirm;
    if (!d) return;
    setDropConfirm(null);
    const sql = d.tn.node.kind === 'schema'
      ? dropSchemaSql({ engine: session.engine, name: nodeName(d.tn.node), cascade: dropCascade })
      : d.sql;
    try {
      await invoke('panel_query', { sessionId: session.sessionId, sql, token: `drop-${++dropSeq.current}` });
    } catch (e) {
      setLoadError(errorDisplay(e));
      return;
    }
    if (d.tn.node.kind === 'database' || d.tn.node.kind === 'schema') {
      // Root-level objects: re-list the root, same path as the ↻ button.
      try {
        const nodes = await SchemaStore.listSchema(session.sessionId);
        setLoadError(null);
        dispatch({ type: 'SET_ROOT', nodes, merge: true });
      } catch (e) {
        setLoadError(errorDisplay(e));
      }
    } else {
      const owner = nearestRealAncestor(d.tn, flat);
      if (owner) await refreshNode(owner, flat);
    }
    window.dispatchEvent(new CustomEvent('dbgui:schema-changed'));
  }

  // Stable per-row API: TreeRow is memoized, so its props must not change
  // identity per render — the methods read the CURRENT handlers through a ref.
  const rowApiRef = useRef<RowApi>(null as unknown as RowApi);
  // Assigned in an effect (never during render — react-hooks/refs); the
  // methods are only ever invoked from event handlers, which run later still.
  useEffect(() => {
  rowApiRef.current = {
    click: tn => {
      if (tn.node.kind === 'database' || tn.node.kind === 'schema' || tn.node.kind === 'group') {
        handleExpand(tn, flatRef2.current);
      }
    },
    chevron: tn => { void handleExpand(tn, flatRef2.current); },
    open: tn => {
      if (isRelation(tn.node) && onBrowseTable) {
        onBrowseTable(buildParent(tn, flatRef2.current), tn.node.kind === 'table' ? 'table' : 'view');
      } else if (tn.node.kind === 'mat_view_target') {
        revealTable(tn.node.schema ?? '', tn.node.name);
      } else if (isDdlOnly(tn.node)) {
        showDdl(tn, flatRef2.current);
      }
    },
    ctx: (e, tn) => handleContextMenu(e, tn),
  };
  });
  const rowApi = useMemo<RowApi>(() => ({
    click: tn => rowApiRef.current.click(tn),
    chevron: tn => rowApiRef.current.chevron(tn),
    open: tn => rowApiRef.current.open(tn),
    ctx: (e, tn) => rowApiRef.current.ctx(e, tn),
  }), []);

  // SQLite: ATTACH another database file. The pool is single-connection, so the
  // attachment holds for the session and its tables appear under the new alias.
  const attachDatabase = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [
          { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (!picked || Array.isArray(picked)) return;
      const base = picked.split(/[\\/]/).pop() ?? 'attached';
      let alias = base.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_');
      if (!alias || /^[0-9]/.test(alias)) alias = `db_${alias}`;
      await invoke('sqlite_attach', { sessionId: session.sessionId, path: picked, alias });
      SchemaStore.listSchema(session.sessionId)
        .then(nodes => { setLoadError(null); dispatch({ type: 'SET_ROOT', nodes, merge: true }); })
        .catch(e => setLoadError(errorDisplay(e)));
      window.dispatchEvent(new CustomEvent('dbgui:schema-changed'));
    } catch (e) {
      setLoadError(errorDisplay(e));
    }
  }, [session.sessionId]);

  return (
    <div className="schema-tree" ref={containerRef}>
      <div className="schema-tree-header">
        <span className="schema-tree-title">{session.connectionName}</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {session.engine === 'sqlite' && (
            <button className="icon-btn" title="Attach another SQLite database file"
              onClick={attachDatabase}>⊕</button>
          )}
          <button
            className={`icon-btn ${refreshing ? 'spinning' : ''}`}
            title="Refresh objects + hint cache"
            disabled={refreshing}
            onClick={() => { void refreshAll(); }}
          >↻</button>
          {onCollapse && (
            <button className="icon-btn" title="Hide object explorer" onClick={onCollapse}>◂</button>
          )}
        </div>
      </div>

      {loadError && <div className="tree-error">{loadError}</div>}

      <div
        className="tree-list"
        ref={listRef}
        onScroll={e => setListScrollTop(e.currentTarget.scrollTop)}
        style={{ position: 'relative' }}
      >
        {/* Invisible probe row: its measured height drives the windowing. */}
        <div ref={probeRef} className="tree-row" aria-hidden
          style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', left: 0, right: 0 }}>
          <span className="tree-chevron-spacer" />
          <span className="tree-label">probe</span>
        </div>
        {flat.length > 0 && (
          <div style={{ position: 'relative', height: flat.length * treeRowH }}>
            {(() => {
              // Window: only the visible slice (plus overscan) becomes DOM —
              // thousands of expanded tables used to be fully reconciled on
              // every render (WP-14 14.2).
              const OVERSCAN = 12;
              const first = Math.max(0, Math.floor(listScrollTop / treeRowH) - OVERSCAN);
              const last = Math.min(flat.length, Math.ceil((listScrollTop + listViewH) / treeRowH) + OVERSCAN);
              const out = [];
              for (let i = first; i < last; i++) {
                const tn = flat[i];
                out.push(
                  <TreeRow
                    key={tn.id}
                    tn={tn}
                    top={i * treeRowH}
                    highlighted={highlightId === tn.id}
                    api={rowApi}
                  />,
                );
              }
              return out;
            })()}
          </div>
        )}

        {flat.length === 0 && !loadError && (
          rootLoading ? (
            <div className="tree-empty tree-empty-loading">
              <SpinnerIcon className="tree-spinner" />
              <span>Loading schemas…</span>
            </div>
          ) : (
            <div className="tree-empty">No objects found</div>
          )
        )}
      </div>

      {/* Full-width, labelled — same pattern as the connections sidebar's
          Hide row (`.sidebar-hide`); the slim rail App.tsx swaps in is the
          way back. */}
      {onCollapse && (
        <button className="pane-hide" title="Hide object explorer" onClick={onCollapse}>
          ◂ Hide
        </button>
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        >
          {isGroupNode(ctxMenu.tn.node) ? (
            <>
              {/* The Extensions group is the natural home for "create": a picker
                  over pg_available_extensions → CREATE EXTENSION into the editor. */}
              {ctxMenu.tn.node.group === 'extensions' && session.engine === 'postgres' && onInsertText && (
                <ContextMenuItem
                  label="Create extension…"
                  onClick={() => { openExtensionPicker(); setCtxMenu(null); }}
                />
              )}
              {/* Virtual group: the only meaningful action is refreshing the
                  owning database/schema (re-fetches the whole object list). */}
              <ContextMenuItem
                label="Refresh"
                onClick={() => {
                  const owner = nearestRealAncestor(ctxMenu.tn, flat);
                  if (owner) refreshNode(owner, flat);
                  setCtxMenu(null);
                }}
              />
            </>
          ) : (
            <>
              <ContextMenuItem
                label="Copy name"
                onClick={() => {
                  navigator.clipboard.writeText(quoteIdent(nodeName(ctxMenu.tn.node), session.engine));
                  setCtxMenu(null);
                }}
              />
              {onInsertText && (
                <ContextMenuItem
                  label="Insert into editor"
                  onClick={() => {
                    onInsertText(quoteIdent(nodeName(ctxMenu.tn.node), session.engine));
                    setCtxMenu(null);
                  }}
                />
              )}
              {(isRelation(ctxMenu.tn.node)
                || ctxMenu.tn.node.kind === 'database' || ctxMenu.tn.node.kind === 'schema') && (
                <ContextMenuItem
                  label="Refresh"
                  onClick={() => { refreshNode(ctxMenu.tn, flat); setCtxMenu(null); }}
                />
              )}
              {/* Create the container this node sits in — a PG schema or a
                  MySQL/PG database. Review-only: CREATE opens a small name form
                  emitting SQL into the editor. DROP lives in the generic item
                  at the bottom — it executes after confirmation. Both are gated
                  to the sqlDba engines (MySQL/PG), exactly where these
                  statements apply. */}
              {ctxMenu.tn.node.kind === 'schema' && can(session.engine, 'namespaceDdl') && onInsertText && (
                <>
                  <ContextMenuItem
                    label="Create schema…"
                    onClick={() => { setObjDialog({ objType: 'schema', name: '', owner: '', charset: '', collate: '' }); setCtxMenu(null); }}
                  />
                  <ContextMenuItem
                    label="Create database…"
                    onClick={() => { setObjDialog({ objType: 'database', name: '', owner: '', charset: '', collate: '' }); setCtxMenu(null); }}
                  />
                </>
              )}
              {ctxMenu.tn.node.kind === 'database' && can(session.engine, 'namespaceDdl') && onInsertText && (
                <ContextMenuItem
                  label="Create database…"
                  onClick={() => { setObjDialog({ objType: 'database', name: '', owner: '', charset: '', collate: '' }); setCtxMenu(null); }}
                />
              )}
              {isDdlOnly(ctxMenu.tn.node) && (
                <ContextMenuItem
                  label="View DDL"
                  onClick={() => showDdl(ctxMenu.tn, flat)}
                />
              )}
              {/* MV storage target (a CH materialized view's backing table).
                  Its tree path is under the MV, not its real database, so every
                  action here uses the target's own `schema.name` directly rather
                  than buildParent. */}
              {ctxMenu.tn.node.kind === 'mat_view_target' && (
                <>
                  <ContextMenuItem
                    label="Go to storage table"
                    onClick={() => {
                      const node = ctxMenu.tn.node;
                      if (node.kind !== 'mat_view_target') return;
                      revealTable(node.schema ?? '', node.name);
                      setCtxMenu(null);
                    }}
                  />
                  {onBrowseTable && (
                    <ContextMenuItem
                      label="Browse table"
                      onClick={() => {
                        const node = ctxMenu.tn.node;
                        if (node.kind !== 'mat_view_target') return;
                        onBrowseTable(node.schema ? `${node.schema}.${node.name}` : node.name, 'table');
                        setCtxMenu(null);
                      }}
                    />
                  )}
                  <ContextMenuItem
                    label="View DDL"
                    onClick={async () => {
                      const node = ctxMenu.tn.node;
                      if (node.kind !== 'mat_view_target') return;
                      const path = node.schema ? `${node.schema}.${node.name}` : node.name;
                      try {
                        setDdl({ title: node.name, sql: await SchemaStore.getDdl(session.sessionId, path) });
                      } catch (e) { setLoadError(errorDisplay(e)); }
                      setCtxMenu(null);
                    }}
                  />
                </>
              )}
              {/* Jump straight into the routine editor for this routine.
                  Mirrors the ER diagram's "Design table…" path: a window event
                  the panel host listens for and targets the panel with. A
                  routine node only exists on engines that have routines, so no
                  further engine gate is needed. */}
              {ctxMenu.tn.node.kind === 'routine'
                // A ClickHouse dictionary is a Routine node too, but it has its
                // own editor (below) — don't also offer the generic routine one.
                && !(session.engine === 'clickhouse' && ctxMenu.tn.node.routine_type === 'DICTIONARY')
                // DuckDB's routines are macros; the routine editor speaks
                // MySQL/PG catalogs and could not address one anyway.
                && session.engine !== 'duckdb' && (
                <ContextMenuItem
                  label="Edit routine"
                  onClick={() => {
                    const node = ctxMenu.tn.node;
                    if (node.kind !== 'routine') return;
                    const parts = buildParent(ctxMenu.tn, flat).split('.');
                    const name = parts.pop()!;
                    const schema = parts.join('.');
                    window.dispatchEvent(new CustomEvent('dbgui:edit-routine', {
                      detail: { schema, name, kind: node.routine_type.toLowerCase() },
                    }));
                    setCtxMenu(null);
                  }}
                />
              )}
              {/* Open the dictionary editor (Agent CH-editors' panel listens for
                  `dbgui:edit-dictionary`). Dictionaries surface as DICTIONARY
                  Routine nodes; gate to ClickHouse, and derive schema/name via
                  buildParent exactly like the edit-type / edit-view items. */}
              {ctxMenu.tn.node.kind === 'routine'
                && ctxMenu.tn.node.routine_type === 'DICTIONARY'
                && session.engine === 'clickhouse' && (
                <ContextMenuItem
                  label="Edit dictionary…"
                  onClick={() => {
                    const parts = buildParent(ctxMenu.tn, flat).split('.');
                    const name = parts.pop()!;
                    const schema = parts.join('.');
                    window.dispatchEvent(new CustomEvent('dbgui:edit-dictionary', {
                      detail: { schema, name },
                    }));
                    setCtxMenu(null);
                  }}
                />
              )}
              {/* Same pattern for sequences. Only PG/MariaDB expose sequence
                  nodes, so the node's mere presence is the engine gate. */}
              {ctxMenu.tn.node.kind === 'sequence' && (
                <ContextMenuItem
                  label="Edit sequence"
                  onClick={() => {
                    const parts = buildParent(ctxMenu.tn, flat).split('.');
                    const name = parts.pop()!;
                    const schema = parts.join('.');
                    window.dispatchEvent(new CustomEvent('dbgui:edit-sequence', {
                      detail: { schema, name },
                    }));
                    setCtxMenu(null);
                  }}
                />
              )}
              {ctxMenu.tn.node.kind === 'sequence' && onInsertText && (
                <ContextMenuItem
                  label="Select current value"
                  onClick={() => {
                    const p = buildParent(ctxMenu.tn, flat).split('.').map(n => quoteIdent(n, session.engine)).join('.');
                    onInsertText(`SELECT last_value, is_called FROM ${p};`);
                    setCtxMenu(null);
                  }}
                />
              )}
              {ctxMenu.tn.node.kind === 'mat_view' && onInsertText && (
                <ContextMenuItem
                  label="Refresh materialized view…"
                  onClick={() => {
                    const p = buildParent(ctxMenu.tn, flat).split('.').map(n => quoteIdent(n, session.engine)).join('.');
                    // Inserted, never auto-run: REFRESH takes a lock and can be
                    // long — the user decides when to execute it.
                    onInsertText(`REFRESH MATERIALIZED VIEW ${p};`);
                    setCtxMenu(null);
                  }}
                />
              )}
              {/* Extensions: create via a picker over pg_available_extensions
                  (emitted into the editor for review). Drop is the generic
                  item at the bottom — it executes after confirmation. */}
              {ctxMenu.tn.node.kind === 'extension' && session.engine === 'postgres' && onInsertText && (
                <ContextMenuItem
                  label="Create extension…"
                  onClick={() => { openExtensionPicker(); setCtxMenu(null); }}
                />
              )}
              {/* Open the type/domain/enum editor (Agent E's panel listens for
                  `dbgui:edit-type`). User-defined types are PG-only in this tree. */}
              {ctxMenu.tn.node.kind === 'type' && (
                <ContextMenuItem
                  label="Edit type…"
                  onClick={() => {
                    const node = ctxMenu.tn.node;
                    if (node.kind !== 'type') return;
                    const parts = buildParent(ctxMenu.tn, flat).split('.');
                    const name = parts.pop()!;
                    const schema = parts.join('.');
                    // Map the pg catalog subtype to the editor's kind vocabulary.
                    const tk = node.type_kind.toUpperCase();
                    const kind = tk === 'ENUM' ? 'enum' : tk === 'DOMAIN' ? 'domain'
                      : tk === 'COMPOSITE' ? 'composite' : 'type';
                    window.dispatchEvent(new CustomEvent('dbgui:edit-type', {
                      detail: { schema, name, kind },
                    }));
                    setCtxMenu(null);
                  }}
                />
              )}
              {/* Open the trigger editor (`dbgui:edit-trigger`). Triggers exist
                  on MySQL + PG; the editor agent handles the engine. The table
                  the trigger guards rides on the node (triggers list schema-flat). */}
              {ctxMenu.tn.node.kind === 'trigger' && (
                <ContextMenuItem
                  label="Edit trigger…"
                  onClick={() => {
                    const node = ctxMenu.tn.node;
                    if (node.kind !== 'trigger') return;
                    const parts = buildParent(ctxMenu.tn, flat).split('.');
                    const name = parts.pop()!;
                    const schema = parts.join('.');
                    window.dispatchEvent(new CustomEvent('dbgui:edit-trigger', {
                      detail: { schema, table: node.table ?? '', name },
                    }));
                    setCtxMenu(null);
                  }}
                />
              )}
              {isRelation(ctxMenu.tn.node) && (
                <>
                  {/* A Distributed table is a proxy — its rows live in the local
                      target table. Jump straight to it in the tree. */}
                  {ctxMenu.tn.node.kind === 'distributed' && (
                    <ContextMenuItem
                      label="Go to local table"
                      onClick={() => {
                        const node = ctxMenu.tn.node;
                        if (node.kind !== 'distributed') return;
                        revealTable(node.target_db, node.target_table);
                        setCtxMenu(null);
                      }}
                    />
                  )}
                  {/* Open the table designer on this existing table — the same
                      `dbgui:design-table` event the ER diagram fires. Only for
                      real tables (not views/matviews) on engines the designer
                      has a dialect for (MySQL/PG/ClickHouse/SQLite). */}
                  {ctxMenu.tn.node.kind === 'table' && can(session.engine, 'tableDesigner') && (
                    <ContextMenuItem
                      label="Design/Edit table"
                      onClick={() => {
                        const parts = buildParent(ctxMenu.tn, flat).split('.');
                        const table = parts.pop()!;
                        const schema = parts.join('.');
                        window.dispatchEvent(new CustomEvent('dbgui:design-table', {
                          detail: { schema, table },
                        }));
                        setCtxMenu(null);
                      }}
                    />
                  )}
                  {/* Open the view editor (Agent V's panel listens for
                      `dbgui:edit-view`). Ordinary views exist on every SQL
                      engine that has them; the editor handles the dialect —
                      except DuckDB, whose three-level names (db.schema.view)
                      the panel cannot address yet. */}
                  {ctxMenu.tn.node.kind === 'view' && session.engine !== 'duckdb' && (
                    <ContextMenuItem
                      label="Edit view…"
                      onClick={() => {
                        const parts = buildParent(ctxMenu.tn, flat).split('.');
                        const name = parts.pop()!;
                        const schema = parts.join('.');
                        window.dispatchEvent(new CustomEvent('dbgui:edit-view', {
                          detail: { schema, name, kind: 'view' },
                        }));
                        setCtxMenu(null);
                      }}
                    />
                  )}
                  {/* Same panel, materialized flavour. Matviews only exist on
                      PostgreSQL and ClickHouse, so gate to those engines. */}
                  {ctxMenu.tn.node.kind === 'mat_view'
                    && (session.engine === 'postgres' || session.engine === 'clickhouse') && (
                    <ContextMenuItem
                      label="Edit materialized view…"
                      onClick={() => {
                        const parts = buildParent(ctxMenu.tn, flat).split('.');
                        const name = parts.pop()!;
                        const schema = parts.join('.');
                        window.dispatchEvent(new CustomEvent('dbgui:edit-view', {
                          detail: { schema, name, kind: 'matview' },
                        }));
                        setCtxMenu(null);
                      }}
                    />
                  )}
                  {onBrowseTable && (
                    <ContextMenuItem
                      label="Browse table"
                      onClick={() => {
                        const parent = buildParent(ctxMenu.tn, flat);
                        onBrowseTable(parent, ctxMenu.tn.node.kind === 'table' ? 'table' : 'view');
                        setCtxMenu(null);
                      }}
                    />
                  )}
                  <ContextMenuItem
                    label={ctxMenu.tn.node.kind === 'view' ? 'Show columns' : 'Show columns & indexes'}
                    // matview keeps "& indexes" — it can carry real indexes
                    onClick={() => { handleExpand(ctxMenu.tn, flat); setCtxMenu(null); }}
                  />
                  <ContextMenuItem
                    label="View DDL"
                    onClick={() => showDdl(ctxMenu.tn, flat)}
                  />
                  {can(session.engine, 'sql') && (
                  <ContextMenuItem
                    label="Virtual foreign keys…"
                    onClick={() => { setVfkTable(buildParent(ctxMenu.tn, flat)); setCtxMenu(null); }}
                  />
                  )}
                  {can(session.engine, 'sql') && (
                  <ContextMenuItem
                    label="Select top 100"
                    onClick={() => {
                      onInsertText?.(`SELECT * FROM ${buildParent(ctxMenu.tn, flat).split('.').map(n => quoteIdent(n, session.engine)).join('.')} LIMIT 100;`);
                      setCtxMenu(null);
                    }}
                  />
                  )}
                  {/* Generate INSERT / UPDATE skeletons into the editor — the
                      schema is already loaded, so scaffold the statement rather
                      than making the user type every column. Columns are fetched
                      on click (they may not be expanded yet); nothing runs. */}
                  {onInsertText && can(session.engine, 'sql') && (
                    <ContextMenuItem
                      label="Generate INSERT"
                      onClick={() => {
                        const parent = buildParent(ctxMenu.tn, flat);
                        setCtxMenu(null);
                        SchemaStore.listColumns(session.sessionId, parent)
                          .then(cols => {
                            const defs = cols.filter(c => c.kind === 'column')
                              .map(c => ({ name: c.name, type: (c as { type_name?: string }).type_name ?? '' }));
                            if (defs.length) onInsertText(insertTemplate(parent, defs, session.engine) + '\n');
                          })
                          .catch(e => setLoadError(errorDisplay(e)));
                      }}
                    />
                  )}
                  {session.engine === 'postgres' && (
                    <ContextMenuItem
                      label="Import CSV via COPY…"
                      onClick={async () => {
                        const parent = buildParent(ctxMenu.tn, flat);
                        setCtxMenu(null);
                        try {
                          const picked = await openDialog({
                            multiple: false,
                            filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }, { name: 'All files', extensions: ['*'] }],
                          });
                          if (!picked || Array.isArray(picked)) return;
                          const fmt = picked.endsWith('.tsv') ? 'tsv' : 'csv';
                          const rows = await invoke<number>('pg_copy_import',
                            { sessionId: session.sessionId, path: picked, table: parent, format: fmt, header: true });
                          setLoadError(`COPY loaded ${rows.toLocaleString()} rows into ${parent}`);
                        } catch (e) { setLoadError(errorDisplay(e)); }
                      }}
                    />
                  )}
                  {onInsertText && can(session.engine, 'sql') && (
                    <ContextMenuItem
                      label="Generate UPDATE"
                      onClick={() => {
                        const parent = buildParent(ctxMenu.tn, flat);
                        setCtxMenu(null);
                        SchemaStore.listColumns(session.sessionId, parent)
                          .then(cols => {
                            const colNodes = cols.filter(c => c.kind === 'column') as Array<{ name: string; type_name?: string; primary_key?: boolean }>;
                            const defs = colNodes.map(c => ({ name: c.name, type: c.type_name ?? '' }));
                            const pk = colNodes.filter(c => c.primary_key).map(c => c.name);
                            if (defs.length) onInsertText(updateTemplate(parent, defs, pk, session.engine) + '\n');
                          })
                          .catch(e => setLoadError(errorDisplay(e)));
                      }}
                    />
                  )}
                  {/* Clone a table on the same server: structure, and (opt-in)
                      its rows too. Emitted into the editor, never auto-run —
                      copying every row of a large table is the user's call. */}
                  {ctxMenu.tn.node.kind === 'table' && onInsertText && can(session.engine, 'sql') && (
                    <ContextMenuItem
                      label="🧬 Duplicate table…"
                      onClick={async () => {
                        const parts = buildParent(ctxMenu.tn, flat).split('.');
                        const table = parts.pop()!;
                        const schema = parts.join('.') || undefined;
                        const newName = await promptDialog('Name for the copy:', `${table}_copy`);
                        if (!newName) { setCtxMenu(null); return; }
                        const withData = await confirmDialog(
                          'Copy the rows too?\n\nOK = structure + data, Cancel = structure only.',
                        );
                        const sql = duplicateTableSql({ schema, table, newName, withData, engine: session.engine })
                          .map(s => s + ';')
                          .join('\n');
                        onInsertText(sql);
                        setCtxMenu(null);
                      }}
                    />
                  )}
                  {/* Only on a system-versioned table, and only there: on any
                      other table FOR SYSTEM_TIME is a plain error. An ordinary
                      SELECT shows none of the history and omits the versioning
                      columns, so without this the retained versions are
                      unreachable from the UI at all. */}
                  {ctxMenu.tn.node.kind === 'table' && ctxMenu.tn.node.temporal && (
                    <ContextMenuItem
                      label="Show history (all versions)"
                      onClick={() => {
                        onInsertText?.(historySql({
                          table: buildParent(ctxMenu.tn, flat),
                          mode: { kind: 'all' },
                          limit: 200,
                        }) + ';');
                        setCtxMenu(null);
                      }}
                    />
                  )}
                </>
              )}
              {/* Drop — executed for real, but only after the in-DOM
                  confirmation modal (askDrop → execDrop); window.confirm is
                  NOT an option, it auto-accepts on WebKitGTK. Covers every
                  kind dropSql knows; databases/schemas keep the sqlDba gate
                  (MySQL/PG) they always had, a schema drop offers CASCADE in
                  the modal. Guarded server-side by the same write/prod limits
                  as editor SQL. */}
              {(() => {
                if (isGroupNode(ctxMenu.tn.node)) return null;
                // MongoDB v1 is read-only by design (the driver has no write
                // path) and does not speak SQL — there is nothing to emit.
                if (session.engine === 'mongodb') return null;
                const d = dropSql(ctxMenu.tn, flat, session.engine);
                if (!d) return null;
                if ((ctxMenu.tn.node.kind === 'database' || ctxMenu.tn.node.kind === 'schema')
                  && !can(session.engine, 'sqlDba')) return null;
                return (
                  <ContextMenuItem
                    label={d.label}
                    danger
                    onClick={() => askDrop(ctxMenu.tn, d.sql, d.what)}
                  />
                );
              })()}
            </>
          )}
        </ContextMenu>
      )}

      {ddl && (
        <DdlModal
          title={ddl.title}
          sql={ddl.sql}
          onClose={() => setDdl(null)}
          onInsert={onInsertText ? () => { onInsertText(ddl.sql); setDdl(null); } : undefined}
        />
      )}

      {vfkTable && (
        <VirtualFkModal table={vfkTable} connectionId={session.connectionId} sessionId={session.sessionId} engine={session.engine}
          onClose={() => setVfkTable(null)} />
      )}

      {extPicker && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setExtPicker(null); }}>
          <div className="modal">
            <div className="modal-header">
              <span className="modal-title">Create extension</span>
              <button className="modal-close" onClick={() => setExtPicker(null)}>×</button>
            </div>
            {extPicker.loading && <div className="tree-empty tree-empty-loading"><SpinnerIcon className="tree-spinner" /><span>Loading available extensions…</span></div>}
            {extPicker.error && <div className="tree-error">{extPicker.error}</div>}
            {!extPicker.loading && !extPicker.error && extPicker.items.length === 0 && (
              <div className="tree-empty">Every available extension is already installed.</div>
            )}
            {!extPicker.loading && extPicker.items.length > 0 && (
              <div className="tree-list" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
                {extPicker.items.map(ext => (
                  <div
                    key={ext.name}
                    className="tree-row depth-0"
                    style={{ cursor: 'pointer' }}
                    title={ext.comment ?? ext.name}
                    // Review-only: the CREATE lands in the editor, never runs here.
                    onClick={() => { onInsertText?.(extensionCreateSql(ext.name)); setExtPicker(null); }}
                  >
                    <span className="tree-label">{ext.name}</span>
                    {ext.version && <span className="tree-sub">{ext.version}</span>}
                    {ext.comment && <span className="tree-sub" style={{ opacity: 0.7 }}>{ext.comment}</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="modal-footer">
              <button onClick={() => setExtPicker(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {dropConfirm && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setDropConfirm(null); }}>
          <div className="modal">
            <div className="modal-header">
              <span className="modal-title">Drop {dropConfirm.what}?</span>
              <button className="modal-close" onClick={() => setDropConfirm(null)}>×</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
              <p style={{ margin: 0 }}>This runs immediately and cannot be undone.</p>
              <pre className="dg-sql" style={{ maxHeight: 120, border: '1px solid var(--border)', borderRadius: 4 }}>{
                dropConfirm.tn.node.kind === 'schema'
                  ? dropSchemaSql({ engine: session.engine, name: nodeName(dropConfirm.tn.node), cascade: dropCascade })
                  : dropConfirm.sql
              }</pre>
              {dropConfirm.tn.node.kind === 'schema' && (
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={dropCascade} onChange={e => setDropCascade(e.target.checked)} />
                  <span>CASCADE — drop every object in the schema (plain drop fails unless it is empty)</span>
                </label>
              )}
            </div>
            <div className="modal-footer">
              <button onClick={() => setDropConfirm(null)}>Cancel</button>
              <button className="td-danger" onClick={() => void execDrop()}>Drop</button>
            </div>
          </div>
        </div>
      )}

      {objDialog && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setObjDialog(null); }}>
          <div className="modal">
            <div className="modal-header">
              <span className="modal-title">Create {objDialog.objType}</span>
              <button className="modal-close" onClick={() => setObjDialog(null)}>×</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>Name</span>
                <input
                  autoFocus
                  value={objDialog.name}
                  onChange={e => setObjDialog({ ...objDialog, name: e.target.value })}
                  placeholder={objDialog.objType === 'schema' ? 'reporting' : 'analytics'}
                />
              </label>
              {/* PostgreSQL spells it OWNER on a database and AUTHORIZATION on a
                  schema; SQL Server takes AUTHORIZATION on a schema too. MySQL
                  has no owner concept at all. */}
              {(session.engine === 'postgres'
                || (session.engine === 'sqlserver' && objDialog.objType === 'schema')) && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>Owner <span style={{ opacity: 0.6 }}>(optional)</span></span>
                  <input
                    value={objDialog.owner}
                    onChange={e => setObjDialog({ ...objDialog, owner: e.target.value })}
                    placeholder="role"
                  />
                </label>
              )}
              {/* A database COLLATION exists on both MySQL and SQL Server; the
                  separate CHARACTER SET is MySQL's alone — SQL Server's code
                  page rides with the collation. */}
              {session.engine === 'sqlserver' && objDialog.objType === 'database' && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>Collation <span style={{ opacity: 0.6 }}>(optional)</span></span>
                  <input
                    value={objDialog.collate}
                    onChange={e => setObjDialog({ ...objDialog, collate: e.target.value })}
                    placeholder="Latin1_General_CI_AS"
                  />
                </label>
              )}
              {session.engine === 'mysql' && objDialog.objType === 'database' && (
                <>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span>Character set <span style={{ opacity: 0.6 }}>(optional)</span></span>
                    <input
                      value={objDialog.charset}
                      onChange={e => setObjDialog({ ...objDialog, charset: e.target.value })}
                      placeholder="utf8mb4"
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span>Collation <span style={{ opacity: 0.6 }}>(optional)</span></span>
                    <input
                      value={objDialog.collate}
                      onChange={e => setObjDialog({ ...objDialog, collate: e.target.value })}
                      placeholder="utf8mb4_unicode_ci"
                    />
                  </label>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button onClick={() => setObjDialog(null)}>Cancel</button>
              <button
                disabled={!objDialog.name.trim()}
                onClick={() => {
                  // Review-only: the CREATE lands in the editor, never runs here.
                  const sql = objDialog.objType === 'schema'
                    ? createSchemaSql({ engine: session.engine, name: objDialog.name.trim(), owner: objDialog.owner })
                    : createDatabaseSql({
                        engine: session.engine, name: objDialog.name.trim(),
                        owner: objDialog.owner, charset: objDialog.charset, collate: objDialog.collate,
                      });
                  onInsertText?.(sql);
                  setObjDialog(null);
                }}
              >
                Insert SQL
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
