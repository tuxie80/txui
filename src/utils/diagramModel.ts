/**
 * Saved ER diagrams — the data model and every pure operation on it.
 *
 * A diagram is a *named subset of a schema with an arrangement*. That is the
 * whole idea: a 400-table schema is not one picture, it is fifteen pictures
 * called "Orders", "Billing", "Fulfilment". Without this the diagram panel can
 * only ever re-render the entire schema and throw the arrangement away on
 * close.
 *
 * Persisted per connection under its instance directory (see
 * `store/diagrams.ts` and the Rust `instancedata` module). Nothing here knows
 * about storage, React or Tauri — it is all pure, so `node --test` covers it.
 */
import type { ErEdge } from './erLayout.ts';

/** How much of a table to draw. */
export type Density = 'all' | 'keys' | 'header';

/** How table colours are decided for a diagram. */
export type ColorMode = 'none' | 'prefix' | 'manual';

export interface DiagramTable {
  /** Table name as it appears in the schema. */
  name: string;
  x: number;
  y: number;
  /** Explicit colour, overriding whatever `colorMode` would choose. */
  color?: string | null;
  /** Per-table override of the diagram's density. */
  density?: Density | null;
}

export interface DiagramNote {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface Diagram {
  id: string;
  name: string;
  /** The schema these tables live in. A diagram does not span schemas. */
  schema: string;
  tables: DiagramTable[];
  notes: DiagramNote[];
  density: Density;
  colorMode: ColorMode;
  /** Last viewport, so reopening lands where you left off. */
  view?: { x: number; y: number; s: number };
  /** ISO 8601. Sorts the list and answers "is this one stale". */
  updatedAt: string;
}

export interface DiagramFile {
  version: 1;
  diagrams: Diagram[];
}

export const DIAGRAM_KEY = 'diagrams';

export function emptyDiagram(name: string, schema: string, id: string, now: string): Diagram {
  return {
    id, name, schema,
    tables: [], notes: [],
    density: 'all',
    colorMode: 'none',
    updatedAt: now,
  };
}

/**
 * Read a diagram file, tolerating anything.
 *
 * This parses a file on disk that a previous version of TxUI wrote, that a
 * user may have hand-edited, and that a failed write may have truncated. The
 * only acceptable failure mode is "you have no saved diagrams", never a crash
 * or a blank panel with a stack trace — so every field is checked and a bad
 * *diagram* is dropped without taking the good ones with it.
 */
export function parseDiagramFile(text: string | null | undefined): Diagram[] {
  if (!text) return [];
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { diagrams?: unknown }).diagrams;
  if (!Array.isArray(list)) return [];
  return list.map(coerceDiagram).filter((d): d is Diagram => d !== null);
}

const DENSITIES: Density[] = ['all', 'keys', 'header'];
const COLOR_MODES: ColorMode[] = ['none', 'prefix', 'manual'];

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function coerceDiagram(v: unknown): Diagram | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id), name = str(o.name), schema = str(o.schema);
  // Identity is the one thing that cannot be defaulted: a diagram with no id
  // could not be selected, updated or deleted.
  if (!id || !name || schema === null) return null;

  const tables: DiagramTable[] = Array.isArray(o.tables)
    ? o.tables.flatMap(t => {
        if (!t || typeof t !== 'object') return [];
        const to = t as Record<string, unknown>;
        const tn = str(to.name);
        if (!tn) return [];
        const density = DENSITIES.includes(to.density as Density) ? to.density as Density : null;
        return [{ name: tn, x: num(to.x, 0), y: num(to.y, 0), color: str(to.color), density }];
      })
    : [];

  const notes: DiagramNote[] = Array.isArray(o.notes)
    ? o.notes.flatMap(n => {
        if (!n || typeof n !== 'object') return [];
        const no = n as Record<string, unknown>;
        const nid = str(no.id);
        if (!nid) return [];
        return [{
          id: nid, x: num(no.x, 0), y: num(no.y, 0),
          w: num(no.w, 200), h: num(no.h, 90), text: str(no.text) ?? '',
        }];
      })
    : [];

  const view = o.view && typeof o.view === 'object'
    ? (() => {
        const vo = o.view as Record<string, unknown>;
        const s = num(vo.s, 1);
        // A zero or negative scale would render nothing and cannot be zoomed
        // back out of — clamp rather than trust the file.
        return { x: num(vo.x, 0), y: num(vo.y, 0), s: s > 0.02 && s < 20 ? s : 1 };
      })()
    : undefined;

  return {
    id, name, schema, tables, notes,
    // Spread rather than `view,` so a diagram that never had a saved viewport
    // comes back without the key, not with an explicit `undefined`. Round-trip
    // equality is what makes "did this change?" answerable by comparison.
    ...(view ? { view } : {}),
    density: DENSITIES.includes(o.density as Density) ? o.density as Density : 'all',
    colorMode: COLOR_MODES.includes(o.colorMode as ColorMode) ? o.colorMode as ColorMode : 'none',
    updatedAt: str(o.updatedAt) ?? new Date(0).toISOString(),
  };
}

export function serializeDiagrams(diagrams: Diagram[]): string {
  const file: DiagramFile = { version: 1, diagrams };
  return JSON.stringify(file, null, 2);
}

/**
 * Grow a selection along the FK graph.
 *
 * How anyone actually builds a useful sub-diagram: start at `orders`, pull in
 * what it touches, then what those touch, and stop when the picture explains
 * the thing. `hops` of 1 is "its neighbours".
 *
 * `direction` matters more than it looks. From `orders`, *referenced* walks up
 * to `customers` (the things it depends on) and *referencing* walks down to
 * `order_lines` (the things that depend on it). Those are different questions
 * and conflating them is how you accidentally pull in the whole schema from a
 * lookup table.
 */
export function growSelection(
  seed: Iterable<string>,
  edges: ErEdge[],
  hops: number,
  direction: 'referenced' | 'referencing' | 'both',
): Set<string> {
  const out = new Set(seed);
  if (hops <= 0) return out;
  // Self-references add nothing and would otherwise burn a hop.
  const useful = edges.filter(e => e.fromTable !== e.toTable);
  let frontier = new Set(out);
  for (let i = 0; i < hops; i++) {
    const next = new Set<string>();
    for (const e of useful) {
      if ((direction === 'referenced' || direction === 'both') && frontier.has(e.fromTable) && !out.has(e.toTable)) {
        next.add(e.toTable);
      }
      if ((direction === 'referencing' || direction === 'both') && frontier.has(e.toTable) && !out.has(e.fromTable)) {
        next.add(e.fromTable);
      }
    }
    if (next.size === 0) break;   // converged early; nothing more to reach
    for (const t of next) out.add(t);
    frontier = next;
  }
  return out;
}

/**
 * Tables matching a search, by table name or by any column name.
 *
 * Column matching is the half that earns its keep: you rarely remember which
 * table `customer_vat_id` is on, which is exactly when you need to find it.
 * An empty query matches nothing rather than everything — the caller treats
 * "no query" as "no filter" and never asks.
 */
export function matchTables(
  query: string,
  tables: Array<{ name: string; columns: Array<{ name: string }> }>,
): Set<string> {
  const q = query.trim().toLowerCase();
  const out = new Set<string>();
  if (!q) return out;
  for (const t of tables) {
    if (t.name.toLowerCase().includes(q) || t.columns.some(c => c.name.toLowerCase().includes(q))) {
      out.add(t.name);
    }
  }
  return out;
}

/**
 * The leading segment of a table name, used to group by subsystem.
 *
 * Large MySQL schemas are namespaced by prefix because the engine has no other
 * way to do it — `wapi_orders`, `wapi_order_lines`, `billing_invoices`. The
 * separator is `_` first and then `.`; a name with neither has no prefix and
 * is left ungrouped rather than being given a colour that means nothing.
 */
export function tablePrefix(name: string): string | null {
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const i = bare.indexOf('_');
  if (i <= 0 || i === bare.length - 1) return null;
  return bare.slice(0, i);
}

/**
 * Assign a stable colour per prefix from a palette.
 *
 * Stable across sessions and across which tables happen to be on the diagram:
 * the colour comes from the prefix itself, not from iteration order, so
 * `billing_*` is the same colour tomorrow and in a colleague's copy.
 */
export function prefixColors(names: string[], palette: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!palette.length) return out;
  for (const n of names) {
    const p = tablePrefix(n);
    if (!p || out.has(p)) continue;
    let h = 0;
    for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0;
    out.set(p, palette[h % palette.length]);
  }
  return out;
}

/** The colour a table should be drawn in, or null to use the default. */
export function tableColor(
  t: Pick<DiagramTable, 'name' | 'color'>,
  mode: ColorMode,
  byPrefix: Map<string, string>,
): string | null {
  // An explicit colour always wins — it was set by hand, on purpose.
  if (t.color) return t.color;
  if (mode !== 'prefix') return null;
  const p = tablePrefix(t.name);
  return (p && byPrefix.get(p)) ?? null;
}
