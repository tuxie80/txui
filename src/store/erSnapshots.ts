/**
 * ER schema snapshots, per connection, in localStorage.
 *
 * A snapshot is the ER model (tables + columns + FK edges) captured at a point
 * in time so the diagram can show *drift* — what changed since. Keyed by
 * connectionId so each server has its own baseline; one snapshot per connection
 * (taking a new one replaces it), which matches "the schema as I last saw it".
 */
import type { ErSnapshot } from '../utils/schemaDrift';
import type { ErTable, ErEdge } from '../utils/erLayout';

const KEY = 'dbgui.erSnapshots.v1';

function readAll(): Record<string, ErSnapshot> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, ErSnapshot>;
  } catch {
    return {};
  }
}

export function loadSnapshot(connectionId: string): ErSnapshot | null {
  return readAll()[connectionId] ?? null;
}

export function saveSnapshot(connectionId: string, tables: ErTable[], edges: ErEdge[], takenAt: number): void {
  const all = readAll();
  // Store a shallow structural copy — enough for the diff, and immune to later
  // in-place edits of the live model.
  all[connectionId] = {
    takenAt,
    tables: tables.map(t => ({ name: t.name, columns: t.columns.map(c => ({ ...c })) })),
    edges: edges.map(e => ({ ...e })),
  };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota — best effort */ }
}

export function clearSnapshot(connectionId: string): void {
  const all = readAll();
  delete all[connectionId];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ }
}
