/**
 * What the object explorer is scanning RIGHT NOW — a single transient line
 * for the status bar while a schema refresh walks the open tree
 * ("scanning reporting.orders…").
 *
 * One slot, last-writer-wins across sessions: two trees refreshing at once is
 * rare, and the line is ambient context, not a per-session ledger. Clearing is
 * session-scoped so a slow refresh cannot erase a newer one's text — and vice
 * versa a finished one never wipes the line still in progress elsewhere.
 *
 * Unlike tabActivity, every publish notifies: the text IS the payload, and a
 * refresh publishes a handful of lines, not a per-row progress counter.
 */
import { useSyncExternalStore } from 'react';

export interface SchemaScan {
  sessionId: string;
  text: string;
}

let current: SchemaScan | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(fn => fn());
}

/** Show a line for the scan this session is running. */
export function publishSchemaScan(sessionId: string, text: string) {
  if (current && current.sessionId === sessionId && current.text === text) return;
  current = { sessionId, text };
  emit();
}

/** Clear the line — only if it still belongs to this session's scan. */
export function clearSchemaScan(sessionId: string) {
  if (current?.sessionId !== sessionId) return;
  current = null;
  emit();
}

export function getSchemaScan(): SchemaScan | null {
  return current;
}

/** The status bar subscribes with this; renders nothing while null. */
export function useSchemaScan(): SchemaScan | null {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => current,
  );
}
