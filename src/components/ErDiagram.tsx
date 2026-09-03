/**
 * ER diagram — an interactive schema map built from the FK graph.
 * Introspects the chosen schema client-side (via monitor_query on
 * all schemas incl. system), lays tables out in FK-depth layers on a
 * pannable/zoomable canvas with draggable nodes, and draws crow's-foot
 * relationship edges between the referencing and referenced columns.
 *
 * Interactions: click a table to focus it (+ direct neighbours), double
 * -click to open it in the Data Browser, right-click for the same object
 * menu the schema tree offers, hover a column/edge to trace a relation.
 * No data is read or mutated — catalog only.
 */
import { errorDisplay } from '../utils/appError';
import { confirmDialog } from '../utils/appDialog';
import { can } from '../utils/engineCaps';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';
import { addVirtualFk, listVirtualFks } from '../store/virtualFks';
import { commentedColumnsSql, findSoftRefs, resolveSoftRefs } from '../utils/softRefs';
import type { SoftRef } from '../utils/softRefs';
import { SchemaStore } from '../store/schema';
import { quoteIdent, escapeLiteral } from '../utils/sqlIdent';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { DdlModal } from './DdlModal';
import {
  contentBounds, erNodeHAt, fitTransform, focusSet, intersects, layoutEr, routeEdge,
  viewportRect, columnRow, ER_COLLAPSE_ZOOM, ER_NODE_W, type ErEdge, type ErPos, type ErTable,
} from '../utils/erLayout';
import { ErNode } from './ErNode';
import { ErMinimap } from './ErMinimap';
import {
  emptyDiagram, growSelection, matchTables, prefixColors, tableColor,
  type ColorMode, type Density, type Diagram,
} from '../utils/diagramModel';
import { flushDiagrams, loadDiagrams, saveDiagramsSoon } from '../store/diagrams';
import { loadSnapshot, saveSnapshot } from '../store/erSnapshots';
import { PREFS, getPref, usePreference } from '../store/preferences';
import { computeDrift, driftSummary, type ErSnapshot } from '../utils/schemaDrift';
import {
  diagramFileName, diagramToSvg, downloadBlob, downloadSvg, svgToPng, themeFromDocument,
} from '../utils/erExport';
import { PALETTE } from '../utils/palette';

interface Props {
  sessionId: string;
  connectionId: string;
  engine: string;
  onClose: () => void;
}

export function ErDiagram({ sessionId, connectionId, engine, onClose }: Props) {
  const isMysql = engine === 'mysql';
  const isMssql = engine === 'sqlserver';
  const supported = can(engine, 'erDiagram');

  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState('');
  const [nodes, setNodes] = useState<ErTable[]>([]);
  const [edges, setEdges] = useState<ErEdge[]>([]);
  const [pos, setPos] = useState<Map<string, ErPos>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tf, setTf] = useState({ x: 0, y: 0, s: 1 });
  const [sel, setSel] = useState<string | null>(null);
  const [hovEdge, setHovEdge] = useState<number | null>(null);
  const [hovCol, setHovCol] = useState<{ table: string; col: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; table: string } | null>(null);
  const [ddl, setDdl] = useState<{ title: string; sql: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  /**
   * A diagram waiting for its schema to finish loading.
   *
   * Opening a diagram for another schema sets `schema`, which re-runs the
   * introspection effect, which ends by auto-laying-out the graph — throwing
   * away the saved positions we had just restored. So the restore is deferred
   * to the end of that effect instead of racing it.
   */
  const pendingRestore = useRef<Diagram | null>(null);

  // ── Saved diagrams ──────────────────────────────────────────────────────
  // `active === null` is the whole schema, unsaved — what the panel has always
  // shown, and still the default so opening it costs nothing.
  const [diagrams, setDiagrams] = useState<Diagram[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const active = useMemo(() => diagrams.find(d => d.id === activeId) ?? null, [diagrams, activeId]);

  // ── View options ────────────────────────────────────────────────────────
  const [density, setDensity] = useState<Density>('all');
  const [colorMode, setColorMode] = useState<ColorMode>('none');
  // 🔒 by default the generated layout is pinned — dragging a table pans
  // nothing and moves nothing; the toolbar's Move toggle unlocks it.
  const [moveMode, setMoveMode] = usePreference(PREFS.erMoveMode);
  // Schema-drift overlay: a saved snapshot + whether to highlight the diff.
  const [snapshot, setSnapshot] = useState<ErSnapshot | null>(null);
  const [showDrift, setShowDrift] = useState(false);
  useEffect(() => { setSnapshot(loadSnapshot(connectionId)); }, [connectionId]);
  const [query, setQuery] = useState('');
  const [showLegend, setShowLegend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** Canvas pixel size, for viewport culling and the minimap. */
  const [vp, setVp] = useState({ w: 0, h: 0 });

  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId, sql }),
    [sessionId],
  );

  // Schema list
  useEffect(() => {
    if (!supported) return;
    // Include system schemas too — their metadata tables are useful to diagram.
    // User schemas sort first, system ones after (still selectable).
    const sql = isMssql
      // sys.schemas, not information_schema.schemata: SQL Server's view lists a
      // schema for every fixed database role too (db_datareader and friends
      // each own an empty one), which is a dozen rows nobody can diagram.
      // schema_id < 16384 is the documented boundary for real schemas.
      ? "SELECT name FROM sys.schemas WHERE schema_id < 16384 AND name <> 'guest' "
        + "ORDER BY CASE WHEN name IN ('sys','INFORMATION_SCHEMA') THEN 1 ELSE 0 END, name"
      : isMysql
      ? "SELECT schema_name FROM information_schema.schemata ORDER BY (schema_name IN ('information_schema','performance_schema','mysql','sys')), schema_name"
      // pg_namespace, not information_schema.schemata: before PG 14 that view
      // lists only schemas OWNED by the current role, so a restricted account
      // could diagram fewer schemas than it can actually read. Same fix as
      // list_schemas() in db/postgres.rs — kept as its own query because the
      // diagram deliberately offers the system schemas too.
      : "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\\_temp%' AND nspname NOT LIKE 'pg\\_toast%' AND has_schema_privilege(oid, 'USAGE') ORDER BY (nspname IN ('pg_catalog','information_schema')), nspname";
    run(sql)
      .then(r => { const l = r.rows.map(x => String(x[0])); setSchemas(l); setSchema(s => s || l[0] || ''); })
      .catch(e => setError(errorDisplay(e)));
  }, [run, isMysql, isMssql, supported]);

  // Build graph for the selected schema
  useEffect(() => {
    if (!schema) return;
    let cancelled = false;
    // Show the loading state before the async introspection — intentional.
    setLoading(true);
    const q = (v: string) =>
      escapeLiteral(v, isMssql ? 'sqlserver' : isMysql ? 'mysql' : 'postgres');

    const colsSql = isMssql
      // sys.columns + sys.types rather than information_schema, to get the
      // length and precision into the type name — `nvarchar(120)` rather than
      // a bare `nvarchar`, which is most of what a diagram column is for.
      // max_length is BYTES, so the n-types halve it; -1 is MAX.
      ? `SELECT o.name, c.name,
                t.name + CASE
                  WHEN t.name IN ('varchar','nvarchar','char','nchar','binary','varbinary')
                    THEN '(' + CASE WHEN c.max_length = -1 THEN 'max'
                         ELSE CAST(c.max_length / CASE WHEN t.name LIKE 'n%' THEN 2 ELSE 1 END AS varchar(10))
                         END + ')'
                  WHEN t.name IN ('decimal','numeric')
                    THEN '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
                  ELSE '' END,
                ''
         FROM sys.columns c
         JOIN sys.objects o ON o.object_id = c.object_id AND o.type IN ('U','V')
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.types t ON t.user_type_id = c.user_type_id
         WHERE s.name = '${q(schema)}'
         ORDER BY o.name, c.column_id`
      : isMysql
      ? `SELECT table_name, column_name, column_type, column_key FROM information_schema.columns WHERE table_schema = '${q(schema)}' ORDER BY table_name, ordinal_position`
      : `SELECT table_name, column_name, data_type, '' FROM information_schema.columns WHERE table_schema = '${q(schema)}' ORDER BY table_name, ordinal_position`;
    // The delete rule rides along: it costs a join and turns "these tables are
    // related" into "deleting this one takes that one with it".
    const fkSql = isMssql
      // sys.foreign_key_columns is the only place the column PAIRS live —
      // information_schema splits them across three views and joins them by
      // constraint name, which mis-pairs a composite FK.
      ? `SELECT po.name, pc.name, ro.name, rc.name, fk.name,
                fk.delete_referential_action_desc
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.objects po ON po.object_id = fkc.parent_object_id
         JOIN sys.schemas ps ON ps.schema_id = po.schema_id
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id
                            AND pc.column_id = fkc.parent_column_id
         JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id
                            AND rc.column_id = fkc.referenced_column_id
         WHERE ps.name = '${q(schema)}'`
      : isMysql
      ? `SELECT k.table_name, k.column_name, k.referenced_table_name, k.referenced_column_name, k.constraint_name, rc.delete_rule
         FROM information_schema.key_column_usage k
         LEFT JOIN information_schema.referential_constraints rc
           ON rc.constraint_schema = k.constraint_schema AND rc.constraint_name = k.constraint_name
         WHERE k.table_schema = '${q(schema)}' AND k.referenced_table_name IS NOT NULL`
      : `SELECT tc.table_name, kcu.column_name, ccu.table_name, ccu.column_name, tc.constraint_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
         LEFT JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '${q(schema)}'`;
    const pkSql = isMssql
      ? `SELECT o.name, c.name
         FROM sys.indexes i
         JOIN sys.objects o ON o.object_id = i.object_id AND o.type = 'U'
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.is_primary_key = 1 AND s.name = '${q(schema)}'`
      : `SELECT kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = '${q(schema)}'`;

    Promise.all([
      run(colsSql),
      run(fkSql).catch(() => ({ rows: [] } as unknown as QueryResult)),
      // MySQL carries the PK in column_key, so it needs no second query;
      // SQL Server and PostgreSQL both do.
      isMysql ? Promise.resolve({ rows: [] } as unknown as QueryResult) : run(pkSql).catch(() => ({ rows: [] } as unknown as QueryResult)),
    ]).then(([colsR, fkR, pkR]) => {
      if (cancelled) return;
      const fkSet = new Set(fkR.rows.map(r => `${r[0]}.${r[1]}`));
      const pkSet = new Set(pkR.rows.map(r => `${r[0]}.${r[1]}`));
      const byTable = new Map<string, ErTable['columns']>();
      for (const r of colsR.rows) {
        const t = String(r[0]); const c = String(r[1]); const ty = String(r[2]);
        const key = `${t}.${c}`;
        const pk = isMysql ? String(r[3]) === 'PRI' : pkSet.has(key);
        const unique = isMysql ? String(r[3]) === 'UNI' : false;
        if (!byTable.has(t)) byTable.set(t, []);
        byTable.get(t)!.push({ name: c, type: ty, pk, fk: fkSet.has(key), unique: unique || pk });
      }
      const ns: ErTable[] = [...byTable.entries()].map(([name, columns]) => ({ name, columns }));
      const es: ErEdge[] = fkR.rows.map(r => ({
        fromTable: String(r[0]), fromCol: String(r[1]),
        toTable: String(r[2]), toCol: String(r[3]),
        constraint: r[4] != null ? String(r[4]) : undefined,
        onDelete: r[5] != null ? String(r[5]).toUpperCase().replace(/_/g, ' ') : undefined,
      })).filter(e => byTable.has(e.fromTable) && byTable.has(e.toTable));
      // Virtual FKs in this schema join the graph as dashed edges
      const sPfx = `${schema.toLowerCase()}.`;
      const bare = (t: string) => t.slice(t.indexOf('.') + 1);
      for (const v of listVirtualFks(connectionId)) {
        if (!v.fromTable.toLowerCase().startsWith(sPfx) || !v.toTable.toLowerCase().startsWith(sPfx)) continue;
        const ft = bare(v.fromTable), tt = bare(v.toTable);
        if (byTable.has(ft) && byTable.has(tt)) {
          es.push({ fromTable: ft, fromCol: v.fromColumn, toTable: tt, toCol: v.toColumn, constraint: 'virtual', virtual: true });
        }
      }
      setNodes(ns);
      setEdges(es);
      const restore = pendingRestore.current;
      pendingRestore.current = null;
      if (restore) {
        // Saved arrangement wins over a fresh auto-layout — that arrangement
        // is the whole reason the diagram was saved.
        setPos(new Map(restore.tables.map(t => [t.name, { x: t.x, y: t.y }])));
        setTf(restore.view ?? { x: 0, y: 0, s: 1 });
      } else {
        setPos(layoutEr(ns, es));
        setTf({ x: 0, y: 0, s: 1 });
      }
      setSel(null);
      setError(null);
      setLoading(false);
    }).catch(e => { if (!cancelled) { setError(errorDisplay(e)); setLoading(false); } });

    return () => { cancelled = true; };
    // connectionId: virtual edges belong to one connection, so switching servers
    // must redraw them rather than keep the previous server's relations.
  }, [schema, run, isMysql, isMssql, connectionId]);

  // ── Interaction (pan / zoom / node drag / click-to-focus) ───────────────
  const drag = useRef<{
    mode: 'pan' | 'node'; table?: string;
    sx: number; sy: number; ox: number; oy: number; moved: number;
  } | null>(null);

  const onCanvasDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: tf.x, oy: tf.y, moved: 0 };
  };
  const onNodeDown = (e: React.MouseEvent, table: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = pos.get(table)!;
    drag.current = { mode: 'node', table, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: 0 };
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current; if (!d) return;
      d.moved = Math.max(d.moved, Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy));
      const dx = (e.clientX - d.sx) / (d.mode === 'node' ? tf.s : 1);
      const dy = (e.clientY - d.sy) / (d.mode === 'node' ? tf.s : 1);
      if (d.mode === 'pan') setTf(t => ({ ...t, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
      // Node drags only move the node in Move mode (PREFS.erMoveMode); when
      // pinned the press is still tracked so a near-stationary click focuses.
      else if (getPref(PREFS.erMoveMode)) setPos(prev => { const m = new Map(prev); m.set(d.table!, { x: d.ox + dx, y: d.oy + dy }); return m; });
    };
    const up = () => {
      const d = drag.current; if (!d) return;
      drag.current = null;
      // A near-stationary press is a click: focus a node, clear on canvas.
      if (d.moved < 5) setSel(d.mode === 'node' ? d.table! : null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [tf.s]);

  // Escape clears the focus selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Wheel zoom, anchored at the cursor so the point under it stays put.
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 2) return;
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    const cx = rect ? e.clientX - rect.left : 0;
    const cy = rect ? e.clientY - rect.top : 0;
    setTf(t => {
      const s = Math.min(3, Math.max(0.1, t.s * (e.deltaY < 0 ? 1.12 : 0.89)));
      const k = s / t.s;
      return { s, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k };
    });
  };

  const zoomBy = (f: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 0;
    const cy = rect ? rect.height / 2 : 0;
    setTf(t => {
      const s = Math.min(3, Math.max(0.1, t.s * f));
      const k = s / t.s;
      return { s, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k };
    });
  };

  // ── Which tables this diagram shows, and how ────────────────────────────
  // A saved diagram is a *subset*; with none selected the whole schema shows,
  // which is how the panel has always behaved.
  const shown = useMemo(() => {
    if (!active) return nodes;
    const want = new Set(active.tables.map(t => t.name));
    return nodes.filter(n => want.has(n.name));
  }, [nodes, active]);

  const shownNames = useMemo(() => new Set(shown.map(n => n.name)), [shown]);
  const shownEdges = useMemo(
    () => edges.filter(e => shownNames.has(e.fromTable) && shownNames.has(e.toTable)),
    [edges, shownNames]);

  /** Below the collapse zoom nothing is legible, so nothing is drawn but names. */
  const effDensity: Density = tf.s < ER_COLLAPSE_ZOOM ? 'header' : density;

  const nodeH = useCallback((t: ErTable) => erNodeHAt(t, effDensity), [effDensity]);

  const colIndex = useMemo(() => {
    const idx = new Map<string, number>();
    for (const n of nodes) {
      for (const c of n.columns) idx.set(`${n.name}.${c.name}`, columnRow(n.columns, c.name, effDensity));
    }
    return idx;
  }, [nodes, effDensity]);

  /** Columns that take part in a relationship — hover targets, memo-stable. */
  const relColsByTable = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (t: string, c: string) => {
      let s = m.get(t);
      if (!s) { s = new Set(); m.set(t, s); }
      s.add(c);
    };
    for (const e of shownEdges) { add(e.fromTable, e.fromCol); add(e.toTable, e.toCol); }
    return m;
  }, [shownEdges]);
  const EMPTY_COLS = useMemo(() => new Set<string>(), []);

  const matches = useMemo(() => matchTables(query, shown), [query, shown]);

  const colorByPrefix = useMemo(
    () => prefixColors(shown.map(n => n.name), PALETTE),
    [shown]);
  const colorOf = useCallback((name: string): string | null => {
    const manual = active?.tables.find(t => t.name === name)?.color ?? null;
    return tableColor({ name, color: manual }, colorMode, colorByPrefix);
  }, [active, colorMode, colorByPrefix]);

  // Schema drift vs the snapshot (full model, not just the shown subset).
  const drift = useMemo(
    () => (snapshot ? computeDrift(snapshot, nodes, edges) : null),
    [snapshot, nodes, edges]);
  const addedSet = useMemo(() => new Set(drift?.addedTables ?? []), [drift]);
  const driftClass = useCallback((name: string): 'added' | 'changed' | undefined => {
    if (!showDrift || !drift) return undefined;
    if (addedSet.has(name)) return 'added';
    if (drift.changedTables.has(name)) return 'changed';
    return undefined;
  }, [showDrift, drift, addedSet]);

  const bounds = useMemo(() => contentBounds(shown, pos), [shown, pos]);
  const zoomFit = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) { setTf({ x: 0, y: 0, s: 1 }); return; }
    setTf(fitTransform(bounds, rect.width, rect.height));
  }, [bounds]);

  const resetLayout = () => { setPos(layoutEr(shown, shownEdges)); setSel(null); };

  // ── Focus / highlight model ─────────────────────────────────────────────
  const focus = useMemo(() => focusSet(sel, shownEdges), [sel, shownEdges]);
  const focusing = sel !== null;

  const edgeHot = useCallback((i: number, e: ErEdge) => {
    if (hovEdge === i) return true;
    if (hovCol && ((e.fromTable === hovCol.table && e.fromCol === hovCol.col)
      || (e.toTable === hovCol.table && e.toCol === hovCol.col))) return true;
    if (sel && (e.fromTable === sel || e.toTable === sel)) return true;
    return false;
  }, [hovEdge, hovCol, sel]);

  // ── Viewport culling ────────────────────────────────────────────────────
  // Most of a large diagram is off-screen at any readable zoom. Skipping those
  // nodes is what keeps a pan smooth once diagrams get big enough to be worth
  // saving. The margin keeps nodes just outside the edge mounted so scrolling
  // in does not flicker.
  const visible = useMemo(() => {
    if (!vp.w || !vp.h) return shown;          // before first measure, draw all
    const view = viewportRect(tf, vp.w, vp.h);
    return shown.filter(n => {
      const p = pos.get(n.name);
      return p ? intersects(p, ER_NODE_W, nodeH(n), view) : false;
    });
  }, [shown, pos, tf, vp, nodeH]);

  const view = useMemo(() => viewportRect(tf, vp.w || 1, vp.h || 1, 0), [tf, vp]);

  // Stable handlers — a fresh arrow function per render would defeat ErNode's
  // memo and put the re-render cost straight back.
  const onHoverCol = useCallback((table: string | null, col: string | null) => {
    setHovCol(table && col ? { table, col } : null);
  }, []);
  const onNodeContext = useCallback((e: React.MouseEvent, table: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSel(table);
    setMenu({ x: e.clientX, y: e.clientY, table });
  }, []);

  // Edge geometry — recomputed when nodes move.
  const edgeEls = useMemo(() => shownEdges.map((e, i) => {
    const a = pos.get(e.fromTable); const b = pos.get(e.toTable);
    if (!a || !b) return null;
    const r = routeEdge(
      a, colIndex.get(`${e.fromTable}.${e.fromCol}`) ?? 0,
      b, colIndex.get(`${e.toTable}.${e.toCol}`) ?? 0,
      e.fromTable, e.toTable,
    );
    const hot = edgeHot(i, e);
    const dim = (focusing && !(e.fromTable === sel || e.toTable === sel)) && !hot;
    // A cascading key is drawn heavier: following a chain of them by eye is
    // how you notice that dropping one table reaches four.
    const cascades = e.onDelete === 'CASCADE';
    const cls = `er-edge ${e.virtual ? 'er-edge-virtual ' : ''}${cascades ? 'er-edge-cascade ' : ''}`
      + `${hot ? 'er-edge-hot' : dim ? 'er-edge-dim' : ''}`;
    const label = `${e.fromTable}.${e.fromCol} → ${e.toTable}.${e.toCol}`
      + (e.constraint ? `  (${e.virtual ? 'virtual FK (user-declared)' : e.constraint})` : '')
      + (e.onDelete
        ? `  ON DELETE ${e.onDelete}${cascades ? ' — deleting the parent deletes these rows' : ''}`
        : '');
    return (
      <g key={i}>
        <path className="er-edge-hit" d={r.d}
          onMouseEnter={() => setHovEdge(i)} onMouseLeave={() => setHovEdge(null)}>
          <title>{label}</title>
        </path>
        <path className={cls} d={r.d}
          markerStart={`url(#er-crow${hot ? '-hot' : ''})`}
          markerEnd={`url(#er-one${hot ? '-hot' : ''})`} />
        {hot && (
          <text className="er-edge-label" x={r.mx} y={r.my - 6} textAnchor="middle">
            {e.constraint ?? `${e.fromCol} → ${e.toCol}`}
          </text>
        )}
      </g>
    );
  }), [shownEdges, pos, colIndex, edgeHot, focusing, sel]);

  // ── Node actions ────────────────────────────────────────────────────────
  const qualified = useCallback((t: string) => `${schema}.${t}`, [schema]);
  const browseTable = useCallback((t: string) => {
    window.dispatchEvent(new CustomEvent('dbgui:browse-table', { detail: { table: qualified(t) } }));
  }, [qualified]);
  const insertSql = useCallback((sql: string) => {
    window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql } }));
  }, []);
  const showDdl = useCallback((t: string) => {
    SchemaStore.getDdl(sessionId, qualified(t))
      .then(sql => setDdl({ title: qualified(t), sql }))
      .catch(e => setError(errorDisplay(e)));
  }, [sessionId, qualified]);

  // ── Canvas measurement (culling + minimap need pixel size) ──────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setVp({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [supported]);

  // ── Saved diagrams: load, persist ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    loadDiagrams(connectionId)
      .then(list => { if (!cancelled) setDiagrams(list); })
      .catch(e => { if (!cancelled) setError(errorDisplay(e)); });
    return () => { cancelled = true; };
  }, [connectionId]);

  // Anything still queued is written when the panel goes away. Without this a
  // drag in the last half-second before closing is lost, which reads as the
  // feature not working at all.
  useEffect(() => () => { void flushDiagrams(connectionId); }, [connectionId]);

  const mutate = useCallback((id: string, fn: (d: Diagram) => Diagram) => {
    setDiagrams(prev => {
      const next = prev.map(d => (d.id === id ? { ...fn(d), updatedAt: new Date().toISOString() } : d));
      saveDiagramsSoon(connectionId, next);
      return next;
    });
  }, [connectionId]);

  /** Capture the current arrangement into the active diagram. */
  const captureLayout = useCallback(() => {
    if (!activeId) return;
    mutate(activeId, d => ({
      ...d,
      density, colorMode,
      view: { ...tf },
      tables: d.tables.map(t => {
        const p = pos.get(t.name);
        return p ? { ...t, x: p.x, y: p.y } : t;
      }),
    }));
  }, [activeId, mutate, pos, tf, density, colorMode]);

  // Positions and view are captured on a timer rather than on every mousemove:
  // `saveDiagramsSoon` debounces the disk write, but rebuilding the diagram
  // array on each pixel would still churn React.
  useEffect(() => {
    if (!activeId) return;
    const t = setTimeout(captureLayout, 400);
    return () => clearTimeout(t);
  }, [activeId, pos, tf, density, colorMode, captureLayout]);

  const openDiagram = useCallback(async (d: Diagram | null) => {
    await flushDiagrams(connectionId).catch(() => {});
    setActiveId(d?.id ?? null);
    setSel(null);
    setQuery('');
    if (!d) return;
    setDensity(d.density);
    setColorMode(d.colorMode);
    if (d.schema && d.schema !== schema) {
      // Restored once the introspection for that schema lands.
      pendingRestore.current = d;
      setSchema(d.schema);
      return;
    }
    setPos(new Map(d.tables.map(t => [t.name, { x: t.x, y: t.y }])));
    if (d.view) setTf(d.view);
  }, [connectionId, schema]);

  const newDiagram = useCallback((seed: string[]) => {
    const id = crypto.randomUUID();
    const d = emptyDiagram(`Diagram ${diagrams.length + 1}`, schema, id, new Date().toISOString());
    const seeded = seed.length ? seed : shown.map(n => n.name);
    const sub = nodes.filter(n => seeded.includes(n.name));
    const laid = layoutEr(sub, edges.filter(e => seeded.includes(e.fromTable) && seeded.includes(e.toTable)));
    d.tables = sub.map(n => ({
      name: n.name, x: laid.get(n.name)?.x ?? 0, y: laid.get(n.name)?.y ?? 0, color: null, density: null,
    }));
    setDiagrams(prev => {
      const next = [...prev, d];
      saveDiagramsSoon(connectionId, next);
      return next;
    });
    setActiveId(id);
    setPos(laid);
    setSel(null);
    setRenaming(true);
  }, [diagrams.length, schema, shown, nodes, edges, connectionId]);

  const deleteDiagram = useCallback((id: string) => {
    setDiagrams(prev => {
      const next = prev.filter(d => d.id !== id);
      saveDiagramsSoon(connectionId, next);
      return next;
    });
    setActiveId(cur => (cur === id ? null : cur));
  }, [connectionId]);

  /** Put tables on the active diagram, laying out any that are new. */
  const addTables = useCallback((names: Iterable<string>) => {
    if (!activeId) return;
    const want = new Set(names);
    mutate(activeId, d => {
      const have = new Set(d.tables.map(t => t.name));
      const fresh = [...want].filter(n => !have.has(n) && nodes.some(x => x.name === n));
      if (!fresh.length) return d;
      // New arrivals are laid out against the whole resulting set so they land
      // near what they relate to, rather than stacked at the origin.
      const all = [...have, ...fresh];
      const laid = layoutEr(
        nodes.filter(n => all.includes(n.name)),
        edges.filter(e => all.includes(e.fromTable) && all.includes(e.toTable)),
      );
      setPos(prev => {
        const m = new Map(prev);
        for (const n of fresh) m.set(n, laid.get(n) ?? { x: 0, y: 0 });
        return m;
      });
      return {
        ...d,
        tables: [...d.tables, ...fresh.map(n => ({
          name: n, x: laid.get(n)?.x ?? 0, y: laid.get(n)?.y ?? 0, color: null, density: null,
        }))],
      };
    });
  }, [activeId, mutate, nodes, edges]);

  const removeTable = useCallback((name: string) => {
    if (!activeId) return;
    mutate(activeId, d => ({ ...d, tables: d.tables.filter(t => t.name !== name) }));
    setSel(cur => (cur === name ? null : cur));
  }, [activeId, mutate]);

  /** Grow from a table along the FK graph — how a useful sub-diagram is built. */
  const grow = useCallback((from: string, dir: 'referenced' | 'referencing' | 'both') => {
    const reached = growSelection([from], edges, 1, dir);
    if (activeId) addTables(reached);
    else newDiagram([...reached]);
  }, [edges, activeId, addTables, newDiagram]);

  // ── Notes ───────────────────────────────────────────────────────────────
  const addNote = useCallback(() => {
    if (!activeId) return;
    // Dropped at the middle of the current viewport, not the origin — a note
    // that appears off-screen looks like nothing happened.
    const v = viewportRect(tf, vp.w || 600, vp.h || 400, 0);
    mutate(activeId, d => ({
      ...d,
      notes: [...d.notes, {
        id: crypto.randomUUID(),
        x: Math.round(v.x + v.w / 2 - 100), y: Math.round(v.y + v.h / 2 - 45),
        w: 200, h: 90, text: '',
      }],
    }));
  }, [activeId, mutate, tf, vp]);

  const updateNote = useCallback((id: string, text: string) => {
    if (!activeId) return;
    mutate(activeId, d => ({ ...d, notes: d.notes.map(n => (n.id === id ? { ...n, text } : n)) }));
  }, [activeId, mutate]);

  const deleteNote = useCallback((id: string) => {
    if (!activeId) return;
    mutate(activeId, d => ({ ...d, notes: d.notes.filter(n => n.id !== id) }));
  }, [activeId, mutate]);

  const onNoteDown = useCallback((e: React.MouseEvent, id: string) => {
    if (e.button !== 0 || !activeId) return;
    e.stopPropagation();
    // Notes follow the same pin as tables: no Move mode, no drag.
    if (!getPref(PREFS.erMoveMode)) return;
    const note = diagrams.find(d => d.id === activeId)?.notes.find(n => n.id === id);
    if (!note) return;
    const sx = e.clientX, sy = e.clientY, ox = note.x, oy = note.y, s = tf.s;
    const move = (ev: MouseEvent) => {
      mutate(activeId, d => ({
        ...d,
        notes: d.notes.map(n => (n.id === id
          ? { ...n, x: ox + (ev.clientX - sx) / s, y: oy + (ev.clientY - sy) / s }
          : n)),
      }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [activeId, diagrams, tf.s, mutate]);

  // ── Export ──────────────────────────────────────────────────────────────
  const buildSvg = useCallback(() => {
    const colors = new Map<string, string>();
    for (const n of shown) {
      const c = colorOf(n.name);
      if (c) colors.set(n.name, c);
    }
    return diagramToSvg({
      tables: shown, edges: shownEdges, pos, density: effDensity, colors,
      notes: active?.notes,
      theme: themeFromDocument(canvasRef.current),
      title: active?.name ?? schema,
    });
  }, [shown, shownEdges, pos, effDensity, colorOf, active, schema]);

  const exportAs = useCallback(async (kind: 'svg' | 'png' | 'clipboard') => {
    setBusy(kind === 'clipboard' ? 'Copying…' : 'Exporting…');
    try {
      const svg = buildSvg();
      const name = diagramFileName(active?.name ?? schema, kind === 'svg' ? 'svg' : 'png',
        new Date().toISOString().slice(0, 10));
      if (kind === 'svg') {
        downloadSvg(svg, name);
      } else {
        const png = await svgToPng(svg);
        if (kind === 'png') downloadBlob(png, name);
        else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      }
      setError(null);
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(null);
    }
  }, [buildSvg, active, schema]);

  // ── Relationships the schema wrote down in comments ─────────────────────
  //
  // Most production MySQL has no foreign keys at all — they were left out for
  // online-DDL or replication reasons — and the relationships live in column
  // comments instead. For those schemas the diagram opens nearly empty and
  // looks broken. It is not broken; it has not been asked the right question.
  //
  // `softRefs` already knows how to read them; it was only ever reachable from
  // a per-table modal elsewhere. Scanning the whole schema here turns a blank
  // canvas into a map. Nothing is applied automatically — each pair is
  // proposed with the comment that produced it.
  const [softFound, setSoftFound] = useState<SoftRef[] | null>(null);
  const [softOpen, setSoftOpen] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => { setSoftFound(null); setSoftOpen(false); }, [schema]);

  const scanComments = useCallback(async () => {
    setScanning(true);
    try {
      const r = await run(commentedColumnsSql(engine, schema));
      const refs = findSoftRefs(r.rows.map(row => ({
        table: String(row[0]), column: String(row[1]),
        comment: row[2] == null ? null : String(row[2]),
      })));
      const colsOf = new Map(nodes.map(n => [n.name, new Set(n.columns.map(c => c.name))]));
      const { resolved } = resolveSoftRefs(
        refs, new Set(colsOf.keys()), t => colsOf.get(t) ?? new Set<string>());
      // Anything already drawn — real FK or previously accepted virtual — is
      // not news, and listing it would bury the ones that are.
      const known = new Set(edges.map(e => `${e.fromTable}.${e.fromCol}>${e.toTable}.${e.toCol}`));
      setSoftFound(resolved.filter(x => !known.has(`${x.fromTable}.${x.fromColumn}>${x.toTable}.${x.toColumn ?? ''}`)));
      setSoftOpen(true);
      setError(null);
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setScanning(false);
    }
  }, [run, engine, schema, nodes, edges]);

  const acceptSoftRef = useCallback((r: SoftRef) => {
    if (!r.toColumn) return;
    addVirtualFk(connectionId, {
      fromTable: `${schema}.${r.fromTable}`, fromColumn: r.fromColumn,
      toTable: `${schema}.${r.toTable}`, toColumn: r.toColumn,
    });
    setEdges(prev => [...prev, {
      fromTable: r.fromTable, fromCol: r.fromColumn,
      toTable: r.toTable, toCol: r.toColumn!,
      constraint: 'virtual', virtual: true,
    }]);
    setSoftFound(prev => (prev ?? []).filter(x => x !== r));
  }, [schema, connectionId]);

  const acceptAllSoftRefs = useCallback(() => {
    for (const r of softFound ?? []) acceptSoftRef(r);
  }, [softFound, acceptSoftRef]);

  /** Few real FKs is the signal that the comments are worth reading. */
  const fkPoor = !loading && nodes.length > 3 && edges.length < nodes.length / 4;

  // ── Search: pan to the first hit ────────────────────────────────────────
  const jumpToFirstMatch = useCallback(() => {
    const first = [...matches][0];
    const p = first ? pos.get(first) : undefined;
    if (!p) return;
    setSel(first);
    setTf(t => ({ ...t, x: (vp.w || 600) / 2 - (p.x + ER_NODE_W / 2) * t.s, y: (vp.h || 400) / 2 - p.y * t.s }));
  }, [matches, pos, vp]);

  const centreOn = useCallback((x: number, y: number) => {
    setTf(t => ({ ...t, x: (vp.w || 600) / 2 - x * t.s, y: (vp.h || 400) / 2 - y * t.s }));
  }, [vp]);

  return (
    <div className="proc-panel er-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🕸 ER diagram</span>
        {supported && (
          <label className="dg-field-inline" style={{ marginLeft: 10 }}>
            <span>Schema</span>
            <select value={schema} disabled={loading} onChange={e => {
              // A diagram belongs to one schema, so browsing to another leaves
              // it rather than showing its name above someone else's tables.
              if (!pendingRestore.current) setActiveId(null);
              setSchema(e.target.value);
            }}>
              {schemas.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}
        {supported && (
          <span className="er-zoom">
            <button className="toolbar-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
            <button className="toolbar-btn er-zoom-pct" title="Reset to 100%"
              onClick={() => setTf(t => ({ ...t, s: 1 }))}>{Math.round(tf.s * 100)}%</button>
            <button className="toolbar-btn" title="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
            <button className="toolbar-btn" title="Fit the whole diagram into view"
              onClick={zoomFit} disabled={loading || !nodes.length}>Fit</button>
          </span>
        )}
        {supported && <button className="toolbar-btn" onClick={resetLayout} disabled={loading || !shown.length}>Auto-arrange</button>}
        {supported && (
          <button className={`toolbar-btn${moveMode ? ' toolbar-btn-on' : ''}`}
            title={moveMode
              ? 'Layout unlocked — drag tables and notes to move them. Click to pin again.'
              : 'Layout pinned — tables and notes cannot be dragged. Click to unlock moving.'}
            onClick={() => setMoveMode(!moveMode)}>{moveMode ? '🔓 Move' : '🔒 Move'}</button>
        )}
        {supported && (
          <button className="toolbar-btn" title="Design a new table in this schema"
            onClick={() => window.dispatchEvent(new CustomEvent('dbgui:design-table', {
              detail: { schema, table: null },
            }))}>+ Table</button>
        )}

        {/* Saved diagrams. "Whole schema" is the unsaved default the panel has
            always shown, so nothing is required to use it as before. */}
        {supported && (
          <label className="dg-field-inline">
            <span>Diagram</span>
            <select value={activeId ?? ''} onChange={e => {
              const d = diagrams.find(x => x.id === e.target.value) ?? null;
              void openDiagram(d);
            }}>
              <option value="">Whole schema</option>
              {diagrams.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
        {supported && (
          <span className="er-zoom">
            <button className="toolbar-btn" title="New diagram from what is on screen"
              onClick={() => newDiagram([])} disabled={loading || !nodes.length}>+ New</button>
            {active && (
              <>
                <button className="toolbar-btn" title="Rename this diagram"
                  onClick={() => setRenaming(true)}>Rename</button>
                <button className="toolbar-btn" title="Delete this diagram"
                  onClick={async () => { if (await confirmDialog(`Delete diagram "${active.name}"?`, { danger: true, okLabel: 'Delete' })) deleteDiagram(active.id); }}>Delete</button>
              </>
            )}
          </span>
        )}

        {supported && (
          <input className="er-search" type="search" value={query} placeholder="Find table or column…"
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') jumpToFirstMatch(); }}
            title="Matches table and column names. Enter jumps to the first hit." />
        )}

        {supported && (
          <label className="dg-field-inline">
            <span>Show</span>
            <select value={density} onChange={e => setDensity(e.target.value as Density)}
              title="How much of each table to draw">
              <option value="all">All columns</option>
              <option value="keys">Keys only</option>
              <option value="header">Names only</option>
            </select>
          </label>
        )}
        {supported && (
          <label className="dg-field-inline">
            <span>Colour</span>
            <select value={colorMode} onChange={e => setColorMode(e.target.value as ColorMode)}
              title="Colour tables to separate subsystems">
              <option value="none">None</option>
              <option value="prefix">By name prefix</option>
            </select>
          </label>
        )}

        {supported && (
          <span className="er-drift-controls">
            <button className="toolbar-btn"
              title={snapshot
                ? `Replace the drift baseline (snapshot taken ${new Date(snapshot.takenAt).toLocaleString()})`
                : 'Capture the current schema as the drift baseline'}
              onClick={() => {
                saveSnapshot(connectionId, nodes, edges, Date.now());
                setSnapshot(loadSnapshot(connectionId));
                setShowDrift(true);
              }}
              disabled={!nodes.length}>Snapshot</button>
            <button className={`toolbar-btn${showDrift ? ' toolbar-btn-on' : ''}`}
              title={snapshot ? 'Highlight what changed since the snapshot' : 'Take a snapshot first'}
              onClick={() => setShowDrift(v => !v)}
              disabled={!snapshot}>Drift</button>
            {showDrift && drift && (
              <span className={`er-drift-summary${drift.clean ? ' clean' : ''}`}
                title={drift.removedTables.length ? `Dropped since snapshot: ${drift.removedTables.join(', ')}` : undefined}>
                {driftSummary(drift)}
              </span>
            )}
          </span>
        )}

        {supported && (
          <span className="er-zoom">
            <button className="toolbar-btn" title="Download as SVG"
              onClick={() => void exportAs('svg')} disabled={!shown.length || !!busy}>SVG</button>
            <button className="toolbar-btn" title="Download as PNG"
              onClick={() => void exportAs('png')} disabled={!shown.length || !!busy}>PNG</button>
            <button className="toolbar-btn" title="Copy the diagram as an image"
              onClick={() => void exportAs('clipboard')} disabled={!shown.length || !!busy}>Copy</button>
          </span>
        )}
        {supported && active && (
          <button className="toolbar-btn" onClick={addNote} title="Add a note to this diagram">+ Note</button>
        )}
        {supported && (
          <button className={`toolbar-btn${showLegend ? ' active' : ''}`}
            onClick={() => setShowLegend(v => !v)} title="What the symbols mean">Legend</button>
        )}

        <span className="dv-desc" style={{ marginLeft: 8 }}>
          {busy ? busy : loading ? 'Loading…' : shown.length
            ? `${shown.length} tables · ${shownEdges.length} FKs`
              + (visible.length < shown.length ? ` · ${visible.length} drawn` : '')
              + (matches.size ? ` · ${matches.size} match` : '')
            : ''}
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {/* The schema has documented its relationships somewhere nobody reads.
          Say so, rather than presenting an empty canvas as the answer. */}
      {supported && fkPoor && softFound === null && (
        <div className="er-hint-bar">
          <span>
            <strong>{edges.length}</strong>{' '}
            {edges.length === 1 ? 'relationship' : 'relationships'} across {nodes.length} tables.
            {' '}Schemas without foreign keys usually describe them in column comments instead.
          </span>
          <button className="toolbar-btn" onClick={() => void scanComments()} disabled={scanning}>
            {scanning ? 'Reading comments…' : 'Read column comments'}
          </button>
        </div>
      )}

      {supported && softFound !== null && softOpen && (
        <div className="er-softrefs">
          <div className="er-softrefs-head">
            <strong>
              {softFound.length
                ? `${softFound.length} relationship${softFound.length === 1 ? '' : 's'} found in column comments`
                : 'No new relationships found in column comments'}
            </strong>
            {softFound.length > 0 && (
              <button className="toolbar-btn" onClick={acceptAllSoftRefs}>Add all</button>
            )}
            <div style={{ flex: 1 }} />
            <button className="icon-btn" title="Dismiss" onClick={() => setSoftOpen(false)}>×</button>
          </div>
          {softFound.length > 0 && (
            <div className="er-softrefs-list">
              {softFound.map((r, i) => (
                <div key={`${r.fromTable}.${r.fromColumn}-${i}`} className="er-softref">
                  <code>{r.fromTable}.{r.fromColumn}</code>
                  <span className="er-softref-arrow">→</span>
                  <code>{r.toTable}{r.toColumn ? `.${r.toColumn}` : ''}</code>
                  <span className="er-softref-why" title={r.evidence}>{r.evidence}</span>
                  <button className="toolbar-btn" onClick={() => acceptSoftRef(r)}
                          disabled={!r.toColumn}
                          title={r.toColumn ? 'Add as a virtual foreign key'
                                            : 'The comment named a table but no column'}>Add</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {!supported && <div className="db-error">ER diagram is available for MySQL and PostgreSQL.</div>}

      {supported && (
        <div className={`er-canvas${moveMode ? '' : ' er-locked'}`} ref={canvasRef} onMouseDown={onCanvasDown} onWheel={onWheel}>
          <div className="er-stage" style={{ transform: `translate(${tf.x}px,${tf.y}px) scale(${tf.s})` }}>
            <svg className="er-svg" width={bounds.w} height={bounds.h}>
              <defs>
                {/* Crow's foot (many) at the child end, single bar (one) at the parent end. */}
                <marker id="er-crow" markerWidth="14" markerHeight="12" refX="13" refY="6"
                  orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                  <path d="M 2 6 L 13 0 M 2 6 L 13 12" className="er-marker" />
                </marker>
                <marker id="er-one" markerWidth="10" markerHeight="12" refX="7" refY="6"
                  orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M 7 0 L 7 12" className="er-marker" />
                </marker>
                <marker id="er-crow-hot" markerWidth="14" markerHeight="12" refX="13" refY="6"
                  orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                  <path d="M 2 6 L 13 0 M 2 6 L 13 12" className="er-marker-hot" />
                </marker>
                <marker id="er-one-hot" markerWidth="10" markerHeight="12" refX="7" refY="6"
                  orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M 7 0 L 7 12" className="er-marker-hot" />
                </marker>
              </defs>
              {edgeEls}
            </svg>
            {visible.map(n => {
              const p = pos.get(n.name)!;
              return (
                <ErNode
                  key={n.name}
                  table={n}
                  x={p.x}
                  y={p.y}
                  density={effDensity}
                  color={colorOf(n.name)}
                  selected={sel === n.name}
                  dimmed={(focusing && !focus.has(n.name)) || (matches.size > 0 && !matches.has(n.name))}
                  matched={matches.has(n.name)}
                  hoverCol={hovCol?.table === n.name ? hovCol.col : null}
                  relCols={relColsByTable.get(n.name) ?? EMPTY_COLS}
                  drift={driftClass(n.name)}
                  onDown={onNodeDown}
                  onOpen={browseTable}
                  onContext={onNodeContext}
                  onHoverCol={onHoverCol}
                />
              );
            })}

            {/* Notes ride in diagram space with the tables. */}
            {(active?.notes ?? []).map(nt => (
              <div key={nt.id} className="er-note" style={{ left: nt.x, top: nt.y, width: nt.w, minHeight: nt.h }}
                   onMouseDown={e => onNoteDown(e, nt.id)}>
                <textarea
                  className="er-note-text"
                  value={nt.text}
                  placeholder="Note…"
                  onMouseDown={e => e.stopPropagation()}
                  onChange={e => updateNote(nt.id, e.target.value)}
                />
                <button className="er-note-del" title="Delete note"
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => deleteNote(nt.id)}>×</button>
              </div>
            ))}
          </div>

          {/* Orientation aids sit above the canvas, outside the transformed
              stage so they do not pan or scale with it. */}
          {shown.length > 1 && (
            <ErMinimap
              tables={shown} pos={pos} density={effDensity}
              bounds={bounds} view={view} selected={sel}
              onJump={centreOn}
            />
          )}

          {showLegend && (
            <div className="er-legend" onMouseDown={e => e.stopPropagation()}>
              <div className="er-legend-title">Notation</div>
              <div className="er-legend-row"><span className="er-legend-key">🔑</span> primary key</div>
              <div className="er-legend-row"><span className="er-legend-key">↗</span> foreign key</div>
              <div className="er-legend-row"><span className="er-legend-key">◆</span> unique</div>
              <svg className="er-legend-svg" viewBox="0 0 150 54" aria-hidden="true">
                <path d="M6 12 L120 12" className="er-edge" markerStart="url(#er-crow)" markerEnd="url(#er-one)" />
                <text x="128" y="15" className="er-legend-label">1</text>
                <text x="0" y="26" className="er-legend-label">many</text>
                <path d="M6 42 L120 42" className="er-edge er-edge-virtual" />
                <text x="0" y="54" className="er-legend-label">virtual FK (declared here, not in the DB)</text>
              </svg>
              <div className="er-legend-row">
                A heavier line is <code>ON DELETE CASCADE</code> — deleting the parent deletes those rows.
              </div>
            </div>
          )}

          {menu && (
            <div onMouseDown={e => e.stopPropagation()}>
              <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
                <ContextMenuItem label="Browse table" onClick={() => { browseTable(menu.table); setMenu(null); }} />
                {/* The diagram shows reality; the designer proposes a change
                    set against it. One direction only, and nothing is applied
                    from the canvas itself — dragging a box must never alter a
                    schema. */}
                <ContextMenuItem label="Design table…"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('dbgui:design-table', {
                      detail: { schema, table: menu.table },
                    }));
                    setMenu(null);
                  }} />
                {/* Growing outward is how a useful sub-diagram actually gets
                    built: start somewhere, pull in what it touches, stop when
                    the picture explains the thing. */}
                <ContextMenuItem label="Add tables it references"
                  onClick={() => { grow(menu.table, 'referenced'); setMenu(null); }} />
                <ContextMenuItem label="Add tables referencing it"
                  onClick={() => { grow(menu.table, 'referencing'); setMenu(null); }} />
                <ContextMenuItem label="Add all neighbours"
                  onClick={() => { grow(menu.table, 'both'); setMenu(null); }} />
                {active && (
                  <ContextMenuItem label="Remove from this diagram"
                    onClick={() => { removeTable(menu.table); setMenu(null); }} />
                )}
                <ContextMenuItem label="Copy name" onClick={() => {
                  navigator.clipboard.writeText(quoteIdent(menu.table, engine)).catch(() => {});
                  setMenu(null);
                }} />
                <ContextMenuItem label="Insert into editor" onClick={() => {
                  insertSql(quoteIdent(menu.table, engine));
                  setMenu(null);
                }} />
                <ContextMenuItem label="Select top 100" onClick={() => {
                  // Listing top records = the data browser (pages of 100).
                  browseTable(menu.table);
                  setMenu(null);
                }} />
                <ContextMenuItem label="View DDL" onClick={() => { showDdl(menu.table); setMenu(null); }} />
              </ContextMenu>
            </div>
          )}

          {ddl && (
            <div onMouseDown={e => e.stopPropagation()}>
              <DdlModal title={ddl.title} sql={ddl.sql} onClose={() => setDdl(null)}
                onInsert={() => { insertSql(ddl.sql); setDdl(null); }} />
            </div>
          )}

          {renaming && active && (
            <div className="modal-overlay" onMouseDown={e => e.stopPropagation()}
                 onClick={() => setRenaming(false)}>
              <div className="modal" style={{ maxWidth: 380 }} onClick={e => e.stopPropagation()}>
                <div className="modal-header"><span className="modal-title">Rename diagram</span></div>
                <div style={{ padding: 16 }}>
                  <input
                    autoFocus
                    className="er-rename"
                    defaultValue={active.name}
                    onKeyDown={e => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      // Escape must abandon the edit, so the blur handler is
                      // disarmed before the input loses focus.
                      if (e.key === 'Escape') { (e.target as HTMLInputElement).dataset.cancel = '1'; setRenaming(false); }
                    }}
                    onBlur={e => {
                      if (e.target.dataset.cancel) return;
                      const v = e.target.value.trim();
                      if (v && v !== active.name) mutate(active.id, d => ({ ...d, name: v }));
                      setRenaming(false);
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
