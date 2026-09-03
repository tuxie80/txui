/**
 * Saved ER diagrams, persisted in the connection's own instance directory.
 *
 * Storage lives on the Rust side (`instancedata`), one directory per
 * connection, so a diagram belongs to the server it describes and goes away
 * with it. The blob is plain JSON — readable, diffable, and copyable to a
 * colleague — rather than anything encrypted or binary.
 *
 * Writes are debounced because the thing that changes a diagram most often is
 * a mouse drag: without it, moving one table across the canvas would be a few
 * hundred file writes. The trade is that a change can be in memory but not yet
 * on disk, so `flushDiagrams()` exists for the moments that matter — closing
 * the panel, switching diagrams, leaving the app.
 *
 * The data model and every pure operation on it live in
 * `utils/diagramModel.ts`; this file is only the I/O.
 */
import { invoke } from '@tauri-apps/api/core';
import { DIAGRAM_KEY, parseDiagramFile, serializeDiagrams } from '../utils/diagramModel';
import type { Diagram } from '../utils/diagramModel';

const SAVE_DEBOUNCE_MS = 600;

/** Pending write per connection, so two connections never share a timer. */
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; diagrams: Diagram[] }>();

export async function loadDiagrams(connectionId: string): Promise<Diagram[]> {
  // A pending write is newer than anything on disk — reading around it would
  // hand back the version the user just changed away from.
  const inflight = pending.get(connectionId);
  if (inflight) return inflight.diagrams;
  const text = await invoke<string | null>('instance_data_get', {
    connectionId, key: DIAGRAM_KEY,
  });
  return parseDiagramFile(text);
}

async function writeNow(connectionId: string, diagrams: Diagram[]): Promise<void> {
  await invoke('instance_data_set', {
    connectionId, key: DIAGRAM_KEY, value: serializeDiagrams(diagrams),
  });
}

/**
 * Queue a save. Repeated calls collapse into one write after the caller stops
 * changing things.
 */
export function saveDiagramsSoon(connectionId: string, diagrams: Diagram[]): void {
  const existing = pending.get(connectionId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const entry = pending.get(connectionId);
    pending.delete(connectionId);
    if (!entry) return;
    // Fire and forget: a failed autosave must not throw into whatever mouse
    // handler happened to trigger it. `flushDiagrams` is the path that reports.
    writeNow(connectionId, entry.diagrams).catch(err => {
      console.error('diagram autosave failed', err);
    });
  }, SAVE_DEBOUNCE_MS);
  pending.set(connectionId, { timer, diagrams });
}

/**
 * Write anything still queued and wait for it.
 *
 * Call before the panel unmounts or the diagram changes. Unlike the debounced
 * path this one propagates failure, because the caller is at a point where it
 * can tell the user.
 */
export async function flushDiagrams(connectionId?: string): Promise<void> {
  const ids = connectionId ? [connectionId] : [...pending.keys()];
  await Promise.all(ids.map(async id => {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    await writeNow(id, entry.diagrams);
  }));
}
