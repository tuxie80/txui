/**
 * User-imported schema kits (datagen Phase 5), in localStorage — same pattern
 * as connFavorites / datagenPresets: named user data, validated at import
 * (utils/userKits), broadcast on change so an open DataGenPanel re-reads.
 *
 * Global scope, like the bundled kits themselves: a kit describes a demo
 * world, not a server, and the engine dialect is resolved at generation time.
 */
import { useEffect, useState } from 'react';
import { parseStoredKits } from '../utils/userKits';
import type { SchemaKit } from '../utils/schemaKits';

const KEY = 'dbgui.schemaKits.v1';
const EVT = 'dbgui:user-kits-changed';

function read(): SchemaKit[] {
  try {
    const v = localStorage.getItem(KEY);
    return parseStoredKits(v ? JSON.parse(v) : []);
  } catch { return []; }
}
function write(list: SchemaKit[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota */ }
  window.dispatchEvent(new Event(EVT));
}

export function listUserKits(): SchemaKit[] { return read(); }

/** Insert, or replace the kit of the same id (the UI confirms first). */
export function saveUserKit(kit: SchemaKit): void {
  const list = read();
  write(list.some(k => k.id === kit.id)
    ? list.map(k => (k.id === kit.id ? kit : k))
    : [...list, kit]);
}

export function deleteUserKit(id: string): void {
  write(read().filter(k => k.id !== id));
}

/** The current user-kit list, re-read whenever it changes. */
export function useUserKits(): SchemaKit[] {
  const [kits, setKits] = useState(read);
  useEffect(() => {
    const on = () => setKits(read());
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return kits;
}
