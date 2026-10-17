/**
 * Generator presets (datagen Phase 5), in localStorage — the same pattern as
 * connFavorites: a UI convenience layer of named data, cached nowhere else,
 * broadcasting `dbgui:datagen-presets-changed` so open panels re-read.
 *
 * Scope is GLOBAL (not per-connection), on purpose: a preset is a generator id
 * plus a params bundle — nothing in it references a server, a schema or an
 * engine, so scoping it would only mean saving the same "work email" preset
 * once per connection. The panel's generator catalogue is global too.
 */
import { useEffect, useState } from 'react';
import {
  parsePresets, upsertPreset, removePreset, renamePreset as renameInList,
} from '../utils/datagenPresets';
import type { GenPreset } from '../utils/datagenPresets';

const KEY = 'dbgui.datagenPresets.v1';
const EVT = 'dbgui:datagen-presets-changed';

function read(): GenPreset[] {
  try {
    const v = localStorage.getItem(KEY);
    return parsePresets(v ? JSON.parse(v) : []);
  } catch { return []; }
}
function write(list: GenPreset[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota */ }
  window.dispatchEvent(new Event(EVT));
}

export function listPresets(): GenPreset[] { return read(); }

/** Insert, or replace the preset of the same name (the UI confirms first). */
export function savePreset(p: GenPreset): void { write(upsertPreset(read(), p)); }

export function deletePreset(name: string): void { write(removePreset(read(), name)); }

/** Returns an error message, or null on success. */
export function renamePreset(oldName: string, newName: string): string | null {
  const r = renameInList(read(), oldName, newName);
  if ('error' in r) return r.error;
  write(r.list);
  return null;
}

/** The current preset list, re-read whenever any panel changes it. */
export function useDatagenPresets(): GenPreset[] {
  const [presets, setPresets] = useState(read);
  useEffect(() => {
    const on = () => setPresets(read());
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return presets;
}
