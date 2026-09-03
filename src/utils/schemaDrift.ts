/**
 * Schema drift — diff the current ER model against a saved snapshot.
 *
 * "Drift" is the gap between the schema you last looked at (or documented) and
 * the schema as it is now: tables added or dropped, columns added / dropped /
 * retyped, relationships gained or lost. The ER diagram is the natural place to
 * see it, because drift is structural and structure is what the diagram draws.
 *
 * This module is the pure core — it takes two models (a snapshot and the live
 * one) and returns a structured diff the diagram overlays. No React, no
 * storage: `node --test`-driven.
 */

import type { ErTable, ErEdge } from './erLayout.ts';

export interface ErSnapshot {
  /** ms epoch when captured — shown so "drift since when" is answerable. */
  takenAt: number;
  tables: ErTable[];
  edges: ErEdge[];
}

/** A column whose definition changed between snapshot and now. */
export interface ColumnChange {
  name: string;
  /** e.g. "int → bigint", "nullable", "+PK", "-PK". */
  what: string;
}

export interface TableDrift {
  addedColumns: string[];
  removedColumns: string[];
  changedColumns: ColumnChange[];
}

export interface SchemaDrift {
  addedTables: string[];
  removedTables: string[];
  /** name → per-table column drift, only for tables present in both. */
  changedTables: Map<string, TableDrift>;
  addedEdges: ErEdge[];
  removedEdges: ErEdge[];
  /** True when nothing differs. */
  clean: boolean;
}

const edgeKey = (e: ErEdge) => `${e.fromTable}.${e.fromCol}→${e.toTable}.${e.toCol}`;

function diffColumns(before: ErTable, after: ErTable): TableDrift | null {
  const b = new Map(before.columns.map(c => [c.name, c]));
  const a = new Map(after.columns.map(c => [c.name, c]));
  const addedColumns = [...a.keys()].filter(n => !b.has(n));
  const removedColumns = [...b.keys()].filter(n => !a.has(n));
  const changedColumns: ColumnChange[] = [];
  for (const [name, bc] of b) {
    const ac = a.get(name);
    if (!ac) continue;
    const bits: string[] = [];
    if (bc.type !== ac.type) bits.push(`${bc.type} → ${ac.type}`);
    if (bc.pk !== ac.pk) bits.push(ac.pk ? '+PK' : '-PK');
    if (bc.unique !== ac.unique) bits.push(ac.unique ? '+unique' : '-unique');
    if (bits.length) changedColumns.push({ name, what: bits.join(', ') });
  }
  if (!addedColumns.length && !removedColumns.length && !changedColumns.length) return null;
  return { addedColumns, removedColumns, changedColumns };
}

/** Compute the drift from `snapshot` to the live `tables`/`edges`. */
export function computeDrift(
  snapshot: ErSnapshot,
  tables: ErTable[],
  edges: ErEdge[],
): SchemaDrift {
  const before = new Map(snapshot.tables.map(t => [t.name, t]));
  const after = new Map(tables.map(t => [t.name, t]));

  const addedTables = [...after.keys()].filter(n => !before.has(n)).sort();
  const removedTables = [...before.keys()].filter(n => !after.has(n)).sort();

  const changedTables = new Map<string, TableDrift>();
  for (const [name, bt] of before) {
    const at = after.get(name);
    if (!at) continue;
    const d = diffColumns(bt, at);
    if (d) changedTables.set(name, d);
  }

  const beforeEdges = new Set(snapshot.edges.map(edgeKey));
  const afterEdges = new Set(edges.map(edgeKey));
  const addedEdges = edges.filter(e => !beforeEdges.has(edgeKey(e)));
  const removedEdges = snapshot.edges.filter(e => !afterEdges.has(edgeKey(e)));

  const clean = !addedTables.length && !removedTables.length && !changedTables.size
    && !addedEdges.length && !removedEdges.length;

  return { addedTables, removedTables, changedTables, addedEdges, removedEdges, clean };
}

/** One-line summary for the toolbar, e.g. "+2 tables · 3 changed · −1 table". */
export function driftSummary(d: SchemaDrift): string {
  if (d.clean) return 'No drift since snapshot';
  const parts: string[] = [];
  if (d.addedTables.length) parts.push(`+${d.addedTables.length} table${d.addedTables.length === 1 ? '' : 's'}`);
  if (d.removedTables.length) parts.push(`−${d.removedTables.length} table${d.removedTables.length === 1 ? '' : 's'}`);
  if (d.changedTables.size) parts.push(`${d.changedTables.size} changed`);
  const edgeDelta = d.addedEdges.length + d.removedEdges.length;
  if (edgeDelta) parts.push(`${edgeDelta} relationship${edgeDelta === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
