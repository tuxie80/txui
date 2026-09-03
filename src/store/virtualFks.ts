/**
 * Virtual foreign keys — user-declared relations for schemas that don't
 * define real FK constraints (most production MySQL). Stored locally, keyed
 * by qualified table names (`schema.table`), and merged into every FK
 * consumer: JOIN completion, data-browser click-through, ER diagram edges.
 * They never touch the server.
 *
 * **Scoped to a connection.** They used to be global, which meant a relation
 * declared against staging was drawn on production, suggested in production's
 * JOIN completion, and followed by production's data browser — asserting a
 * relationship that may not exist there. Two servers sharing table names is the
 * normal case, not the exotic one, so the global store was wrong precisely
 * where it mattered most.
 */
import { useSyncExternalStore } from 'react';

export interface VirtualFk {
  id: string;
  /** child side (owns the referencing column), qualified `schema.table` */
  fromTable: string;
  fromColumn: string;
  /** parent side (referenced), qualified `schema.table` */
  toTable: string;
  toColumn: string;
}

const KEY = 'dbgui.virtualFks.v2';
/**
 * The pre-scoping store. Read once to migrate, never written again.
 *
 * Its entries cannot be attributed to a connection after the fact — nothing
 * recorded which server they were drawn against. Discarding them silently
 * would throw away work the user did; applying them everywhere is the bug being
 * fixed. So they are held aside and offered for adoption, and until adopted
 * they affect nothing.
 */
const LEGACY_KEY = 'dbgui.virtualFks.v1';

type Store = Record<string, VirtualFk[]>;

const listeners = new Set<() => void>();
let cache: Store = load();
let legacy: VirtualFk[] = loadLegacy();
let snapshot: Store = cache;
let legacySnapshot: VirtualFk[] = legacy;

function load(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    // An array here means someone's v2 key holds v1 data; treat it as absent
    // rather than letting every lookup return undefined-shaped results.
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Store : {};
  } catch { return {}; }
}

function loadLegacy(): VirtualFk[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]');
    return Array.isArray(raw) ? raw as VirtualFk[] : [];
  } catch { return []; }
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* quota */ }
  snapshot = { ...cache };
  listeners.forEach(fn => fn());
}

function persistLegacy() {
  try {
    if (legacy.length) localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    else localStorage.removeItem(LEGACY_KEY);
  } catch { /* quota */ }
  legacySnapshot = [...legacy];
  listeners.forEach(fn => fn());
}

const norm = (t: string) => t.trim().toLowerCase();

/** Everything declared against one connection. */
export function listVirtualFks(connectionId: string): VirtualFk[] {
  return cache[connectionId] ?? [];
}

/** All virtual FKs on this connection touching a table, both directions. */
export function virtualFksFor(connectionId: string, qualifiedTable: string): VirtualFk[] {
  const t = norm(qualifiedTable);
  return listVirtualFks(connectionId)
    .filter(f => norm(f.fromTable) === t || norm(f.toTable) === t);
}

export function addVirtualFk(connectionId: string, fk: Omit<VirtualFk, 'id'>): void {
  const mine = listVirtualFks(connectionId);
  // idempotent — the same relation isn't stored twice on the same connection
  const dup = mine.some(f =>
    norm(f.fromTable) === norm(fk.fromTable) && f.fromColumn === fk.fromColumn
    && norm(f.toTable) === norm(fk.toTable) && f.toColumn === fk.toColumn);
  if (dup) return;
  cache = { ...cache, [connectionId]: [...mine, { ...fk, id: crypto.randomUUID() }] };
  persist();
}

export function removeVirtualFk(connectionId: string, id: string): void {
  const mine = listVirtualFks(connectionId);
  const next = mine.filter(f => f.id !== id);
  if (next.length === mine.length) return;
  cache = { ...cache, [connectionId]: next };
  persist();
}

/** Drop everything for a connection — used when the connection is deleted. */
export function forgetConnection(connectionId: string): void {
  if (!(connectionId in cache)) return;
  const next = { ...cache };
  delete next[connectionId];
  cache = next;
  persist();
}

// ── the pre-scoping leftovers ───────────────────────────────────────────────

/** Relations from before scoping existed. They affect nothing until adopted. */
export function listLegacyVirtualFks(): VirtualFk[] {
  return legacy;
}

/** Attach one leftover to a connection, which is the only way it takes effect. */
export function adoptLegacyVirtualFk(connectionId: string, id: string): void {
  const f = legacy.find(x => x.id === id);
  if (!f) return;
  legacy = legacy.filter(x => x.id !== id);
  persistLegacy();
  addVirtualFk(connectionId, {
    fromTable: f.fromTable, fromColumn: f.fromColumn,
    toTable: f.toTable, toColumn: f.toColumn,
  });
}

export function discardLegacyVirtualFk(id: string): void {
  if (!legacy.some(x => x.id === id)) return;
  legacy = legacy.filter(x => x.id !== id);
  persistLegacy();
}

export function useVirtualFks(connectionId: string): VirtualFk[] {
  const store = useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb); },
    () => snapshot);
  return store[connectionId] ?? EMPTY;
}

export function useLegacyVirtualFks(): VirtualFk[] {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb); },
    () => legacySnapshot);
}

/** A stable empty array — a fresh `[]` each render would loop useSyncExternalStore. */
const EMPTY: VirtualFk[] = [];
