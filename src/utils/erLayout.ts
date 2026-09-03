/**
 * Pure ER-diagram geometry: layered graph layout, edge routing, focus
 * sets and zoom-to-fit math. No React/Tauri imports so it stays unit
 * testable with `node --test` (tests/erLayout.test.ts).
 *
 * Layout doctrine (DbSchema-style): tables are placed in columns by FK
 * depth — a table that references nothing sits in column 0, its children
 * one column to the right, and so on. Within a column, tables are ordered
 * by the barycenter of their already-placed neighbours (two sweeps) to
 * reduce edge crossings. Tables with no relationships at all ("islands")
 * are shelf-packed into a separate region right of the layered area.
 */

export interface ErColumn { name: string; type: string; pk: boolean; fk: boolean; unique: boolean }
export interface ErTable { name: string; columns: ErColumn[] }
export interface ErEdge {
  fromTable: string; fromCol: string;
  toTable: string; toCol: string;
  constraint?: string;
  virtual?: boolean;
  /**
   * `ON DELETE` for this key.
   *
   * The diagram draws relationships; this is what happens when one end goes
   * away, which is a different question and the one that ends up costing
   * somebody a table (see utils/cascade.ts). Drawn as a marked edge so a
   * cascade chain is visible as a chain rather than discovered afterwards.
   */
  onDelete?: string;
}
export interface ErPos { x: number; y: number }

export const ER_NODE_W = 230;
export const ER_HEADER_H = 30;
export const ER_ROW_H = 20;
const HGAP = 90;
const VGAP = 26;
const PAD = 24;

export const erNodeH = (t: Pick<ErTable, 'columns'>) => ER_HEADER_H + t.columns.length * ER_ROW_H;

/**
 * How many rows a node draws at a given density.
 *
 * `all` is every column. `keys` is only the columns that carry meaning in a
 * relationship diagram — primary, foreign and unique — which on a wide table
 * is four rows instead of sixty. `header` is the name alone, for the context
 * tables you need present but not detailed.
 */
export function visibleColumns<C extends { pk: boolean; fk: boolean; unique: boolean }>(
  columns: C[],
  density: 'all' | 'keys' | 'header',
): C[] {
  if (density === 'header') return [];
  if (density === 'keys') return columns.filter(c => c.pk || c.fk || c.unique);
  return columns;
}

/** Node height at a density — the geometry layout and culling both need. */
export function erNodeHAt(t: Pick<ErTable, 'columns'>, density: 'all' | 'keys' | 'header'): number {
  return ER_HEADER_H + visibleColumns(t.columns, density).length * ER_ROW_H;
}

/**
 * Which row an edge should attach to for a column, at a given density.
 *
 * Shared by the live canvas and the SVG export so the two cannot drift — an
 * export whose edges land on different rows than the screen is worse than no
 * export.
 *
 * A column hidden by the density has no row of its own, so the edge anchors to
 * the middle of the header instead: the relationship still has to be visible
 * when a node is collapsed to its name. The fraction is the row index that
 * `routeEdge`'s arithmetic turns into the header's centre line.
 */
export function columnRow<C extends { name: string; pk: boolean; fk: boolean; unique: boolean }>(
  columns: C[],
  colName: string,
  density: 'all' | 'keys' | 'header',
): number {
  const i = visibleColumns(columns, density).findIndex(c => c.name === colName);
  if (i >= 0) return i;
  return -(ER_HEADER_H / 2 + ER_ROW_H / 2) / ER_ROW_H;
}

/** Axis-aligned rectangle, in diagram (unscaled) coordinates. */
export interface Rect { x: number; y: number; w: number; h: number }

/**
 * The viewport, in diagram coordinates, for a canvas of `vw`×`vh` pixels under
 * transform `tf`.
 *
 * `margin` widens it so nodes just off-screen are already mounted when they
 * scroll in, which keeps a pan from flickering as it goes.
 */
export function viewportRect(
  tf: { x: number; y: number; s: number },
  vw: number, vh: number,
  margin = 300,
): Rect {
  const s = tf.s > 0 ? tf.s : 1;   // a zero scale would divide to Infinity
  return {
    x: -tf.x / s - margin,
    y: -tf.y / s - margin,
    w: vw / s + margin * 2,
    h: vh / s + margin * 2,
  };
}

/**
 * Does a node at `p` intersect the viewport?
 *
 * The reason this exists: every node is a DOM element with one child per
 * column, and at a few hundred tables most of them are off-screen at any
 * useful zoom. Skipping those is the difference between a canvas that pans
 * smoothly and one that does not.
 */
export function intersects(p: ErPos, w: number, h: number, view: Rect): boolean {
  return p.x < view.x + view.w && p.x + w > view.x
      && p.y < view.y + view.h && p.y + h > view.y;
}

/**
 * Below this zoom, column text is too small to read, so nodes render as a
 * header bar only regardless of the chosen density. Saves the majority of the
 * DOM at exactly the zoom where a whole large schema is on screen.
 */
export const ER_COLLAPSE_ZOOM = 0.4;

/**
 * FK depth per table: 0 when the table references nothing (a "parent"),
 * otherwise 1 + the deepest table it references. Cycles (self-references,
 * mutual FKs) are broken by ignoring back-edges during the DFS.
 */
export function tableDepths(tables: ErTable[], edges: ErEdge[]): Map<string, number> {
  const names = new Set(tables.map(t => t.name));
  const refs = new Map<string, string[]>();
  for (const e of edges) {
    if (e.fromTable === e.toTable || !names.has(e.fromTable) || !names.has(e.toTable)) continue;
    if (!refs.has(e.fromTable)) refs.set(e.fromTable, []);
    refs.get(e.fromTable)!.push(e.toTable);
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (t: string): number => {
    const hit = memo.get(t);
    if (hit !== undefined) return hit;
    if (visiting.has(t)) return 0; // cycle back-edge
    visiting.add(t);
    let d = 0;
    for (const p of refs.get(t) ?? []) d = Math.max(d, 1 + depth(p));
    visiting.delete(t);
    memo.set(t, d);
    return d;
  };
  for (const t of tables) depth(t.name);
  return memo;
}

/**
 * Layered layout. Returns a position per table. Connected tables form
 * depth columns (parents left, children right); unrelated tables are
 * shelf-packed in an island region to the right of the layered block.
 */
export function layoutEr(tables: ErTable[], edges: ErEdge[]): Map<string, ErPos> {
  const pos = new Map<string, ErPos>();
  if (!tables.length) return pos;
  const depths = tableDepths(tables, edges);
  const connected = new Set<string>();
  for (const e of edges) { connected.add(e.fromTable); connected.add(e.toTable); }

  // Group connected tables by depth.
  const layers = new Map<number, ErTable[]>();
  const islands: ErTable[] = [];
  for (const t of tables) {
    if (!connected.has(t.name)) { islands.push(t); continue; }
    const d = depths.get(t.name) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(t);
  }
  const layerKeys = [...layers.keys()].sort((a, b) => a - b);

  // Neighbour index for barycenter ordering (both directions count).
  const neighbours = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.fromTable === e.toTable) continue;
    if (!neighbours.has(e.fromTable)) neighbours.set(e.fromTable, new Set());
    if (!neighbours.has(e.toTable)) neighbours.set(e.toTable, new Set());
    neighbours.get(e.fromTable)!.add(e.toTable);
    neighbours.get(e.toTable)!.add(e.fromTable);
  }
  const orderOf = new Map<string, number>(); // name → index inside its layer
  const barycenter = (t: ErTable): number => {
    const idx: number[] = [];
    for (const n of neighbours.get(t.name) ?? []) {
      const o = orderOf.get(n);
      if (o !== undefined) idx.push(o);
    }
    if (!idx.length) return Number.MAX_SAFE_INTEGER;
    return idx.reduce((a, b) => a + b, 0) / idx.length;
  };
  const sortLayer = (ts: ErTable[]) =>
    ts.sort((a, b) => (barycenter(a) - barycenter(b)) || a.name.localeCompare(b.name));

  // Two sweeps: ascending uses already-ordered shallower layers, then
  // descending re-orders against the (now ordered) deeper layers.
  for (const d of layerKeys) {
    const ts = layers.get(d)!;
    sortLayer(ts);
    ts.forEach((t, i) => orderOf.set(t.name, i));
  }
  for (const d of [...layerKeys].reverse()) {
    const ts = layers.get(d)!;
    sortLayer(ts);
    ts.forEach((t, i) => orderOf.set(t.name, i));
  }

  // Assign coordinates column by column.
  let maxRight = 0;
  for (const d of layerKeys) {
    const x = PAD + d * (ER_NODE_W + HGAP);
    let y = PAD;
    for (const t of layers.get(d)!) {
      pos.set(t.name, { x, y });
      y += erNodeH(t) + VGAP;
    }
    maxRight = Math.max(maxRight, x + ER_NODE_W);
  }

  // Islands: shelf-pack rows to the right of the layered block.
  if (islands.length) {
    const startX = maxRight ? maxRight + HGAP : PAD;
    const perRow = Math.max(1, Math.ceil(Math.sqrt(islands.length)));
    let x = startX, y = PAD, rowH = 0, inRow = 0;
    for (const t of [...islands].sort((a, b) => a.name.localeCompare(b.name))) {
      if (inRow >= perRow) { x = startX; y += rowH + VGAP; rowH = 0; inRow = 0; }
      pos.set(t.name, { x, y });
      x += ER_NODE_W + 30;
      rowH = Math.max(rowH, erNodeH(t));
      inRow++;
    }
  }
  return pos;
}

export type ErSide = 'left' | 'right';

export interface ErRoute {
  /** SVG path for the edge body (horizontal tangents at both ends). */
  d: string;
  /** Child (referencing, crow's-foot) end. */
  sx: number; sy: number; srcSide: ErSide;
  /** Parent (referenced, "1" bar) end. */
  tx: number; ty: number; dstSide: ErSide;
  /** Label anchor (path midpoint estimate). */
  mx: number; my: number;
  selfLoop: boolean;
}

/**
 * Route an edge between two column rows. Exits/enters through the sides
 * facing the other node; self-references loop out of the right side.
 * Row indexes are the column's position inside its table (0-based).
 */
export function routeEdge(
  from: ErPos, fromRow: number,
  to: ErPos, toRow: number,
  fromTable: string, toTable: string,
): ErRoute {
  const sy = from.y + ER_HEADER_H + fromRow * ER_ROW_H + ER_ROW_H / 2;
  const ty = to.y + ER_HEADER_H + toRow * ER_ROW_H + ER_ROW_H / 2;

  if (fromTable === toTable) {
    const x = from.x + ER_NODE_W;
    const out = 36;
    return {
      d: `M ${x} ${sy} C ${x + out} ${sy} ${x + out} ${ty} ${x} ${ty}`,
      sx: x, sy, srcSide: 'right',
      tx: x, ty, dstSide: 'right',
      mx: x + out * 0.75, my: (sy + ty) / 2,
      selfLoop: true,
    };
  }

  const goRight = from.x + ER_NODE_W / 2 <= to.x + ER_NODE_W / 2;
  const sx = goRight ? from.x + ER_NODE_W : from.x;
  const tx = goRight ? to.x : to.x + ER_NODE_W;
  // Control offset: enough to make the horizontal tangent visible, scaled
  // with distance but capped so tight stacks don't balloon.
  const c = Math.min(80, Math.max(24, Math.abs(tx - sx) * 0.45)) * (goRight ? 1 : -1);
  return {
    d: `M ${sx} ${sy} C ${sx + c} ${sy} ${tx - c} ${ty} ${tx} ${ty}`,
    sx, sy, srcSide: goRight ? 'right' : 'left',
    tx, ty, dstSide: goRight ? 'left' : 'right',
    mx: (sx + tx) / 2, my: (sy + ty) / 2,
    selfLoop: false,
  };
}

/**
 * Focus set for a selected table: the table itself plus every table that
 * shares an edge with it (either direction). Empty selection → empty set.
 */
export function focusSet(selected: string | null, edges: ErEdge[]): Set<string> {
  const s = new Set<string>();
  if (!selected) return s;
  s.add(selected);
  for (const e of edges) {
    if (e.fromTable === selected) s.add(e.toTable);
    if (e.toTable === selected) s.add(e.fromTable);
  }
  return s;
}

/** Content bounds (positions start at PAD, so the origin is top-left). */
export function contentBounds(tables: ErTable[], pos: Map<string, ErPos>): { w: number; h: number } {
  let w = 600, h = 400;
  for (const t of tables) {
    const p = pos.get(t.name);
    if (!p) continue;
    w = Math.max(w, p.x + ER_NODE_W + PAD);
    h = Math.max(h, p.y + erNodeH(t) + PAD);
  }
  return { w, h };
}

export interface ErTransform { x: number; y: number; s: number }

/**
 * Zoom-to-fit: scale the content bounds into the viewport with padding,
 * centered. Never upscales past 1 — big schemas shrink, small ones stay
 * at 100% and just get centered.
 */
export function fitTransform(
  content: { w: number; h: number },
  viewW: number, viewH: number,
  pad = 40,
): ErTransform {
  const aw = Math.max(1, viewW - pad * 2);
  const ah = Math.max(1, viewH - pad * 2);
  const s = Math.min(1, aw / content.w, ah / content.h);
  const clamped = Math.max(0.05, s);
  return {
    x: (viewW - content.w * clamped) / 2,
    y: (viewH - content.h * clamped) / 2,
    s: clamped,
  };
}
