/**
 * Per-folder metadata (colour, note, replica-set flag, designated primary) for
 * the connection sidebar. Folders are derived from connection group paths, so
 * their own attributes live here, keyed by full folder path
 * ("prod", "prod/eu", "prod/eu/warehouse" — subfolders are separate entries).
 *
 * **Persisted through the backend**, alongside the connections themselves.
 * This used to be localStorage-only, which meant a folder tree someone had
 * built by hand was: absent from every export, not
 * covered by the encrypted vault, and gone the moment site data was cleared.
 * A restore brought back your servers and lost your sidebar.
 *
 * Reads stay synchronous (`getFolderMeta` is called during render), so the
 * store keeps an in-memory cache hydrated once at startup and writes through.
 */
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface FolderMeta {
  color?: string | null;
  note?: string;
  /** folder members form one replica set → group tooling (dashboard, set ops) */
  replicaSet?: boolean;
  /** connection id of the designated primary (writes/ANALYZE go here) */
  primaryId?: string | null;
}
export type FolderStore = Record<string, FolderMeta>;

/** Kept only as a migration source — see `hydrateFolderMeta`. */
const LEGACY_KEY = 'dbgui.folderMeta.v1';

const listeners = new Set<() => void>();
let cache: FolderStore = {};
let snapshot: FolderStore = cache;
let hydrated = false;

function notify() {
  snapshot = { ...cache };
  listeners.forEach(fn => fn());
}

function persist() {
  notify();
  invoke('save_folder_meta', { folders: cache }).catch(() => {
    // A failed write must not lose what was just set in this session: the
    // value stays on screen and the next change retries.
  });
}

/**
 * Load from the backend once at startup, migrating anything left in
 * localStorage on the way.
 *
 * The migration only fills gaps — a value already in the backend wins — so
 * re-running it can never resurrect something that was deleted.
 */
export async function hydrateFolderMeta(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  let stored: FolderStore = {};
  try {
    stored = (await invoke<FolderStore | null>('list_folder_meta')) ?? {};
  } catch {
    stored = {};
  }
  let legacy: FolderStore = {};
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '{}');
  } catch {
    legacy = {};
  }

  cache = { ...legacy, ...stored };
  notify();

  // Only write back when the migration actually added something, so a normal
  // startup does not touch the file — and a sealed vault is not re-encrypted
  // for nothing.
  if (Object.keys(legacy).some(k => !(k in stored))) {
    invoke('save_folder_meta', { folders: cache })
      .then(() => { try { localStorage.removeItem(LEGACY_KEY); } catch { /* quota */ } })
      .catch(() => { /* keep the legacy copy until it lands */ });
  }
}

export function getFolderMeta(path: string): FolderMeta {
  return cache[path] ?? {};
}

export function setFolderMeta(path: string, patch: FolderMeta) {
  cache = { ...cache, [path]: { ...cache[path], ...patch } };
  // Drop entries that no longer say anything, so the file does not accumulate
  // an empty object for every folder ever touched.
  const m = cache[path];
  if (!m.color && !m.note && !m.replicaSet && !m.primaryId) {
    const c = { ...cache };
    delete c[path];
    cache = c;
  }
  persist();
}

/** Rename a folder: carry its attributes — and its subfolders' — to the new path. */
export function renameFolderMeta(from: string, to: string) {
  cache = renamePaths(cache, from, to);
  persist();
}

/**
 * The pure part of a rename. Exported for tests: a folder rename must move the
 * whole subtree, and must not touch a sibling whose name merely starts with
 * the same characters ("prod" vs "production").
 */
export function renamePaths(store: FolderStore, from: string, to: string): FolderStore {
  const moved: FolderStore = {};
  const rest: FolderStore = {};
  for (const [path, meta] of Object.entries(store)) {
    if (path === from) moved[to] = meta;
    else if (path.startsWith(`${from}/`)) moved[`${to}${path.slice(from.length)}`] = meta;
    else rest[path] = meta;
  }
  // The moved subtree is applied last, so renaming onto a path that already
  // exists keeps the attributes of the folder the user actually acted on
  // rather than silently discarding them.
  return { ...rest, ...moved };
}

export function useFolderMetaStore(): FolderStore {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb); },
    () => snapshot,
  );
}
