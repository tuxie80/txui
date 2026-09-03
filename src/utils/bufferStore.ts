/**
 * Editor buffers that survive a restart.
 *
 * Losing a half-written migration because the app restarted (or because closing
 * the last tab disconnected the instance) is the kind of thing you only forgive
 * once. Every SQL tab's text is persisted per CONNECTION — not per session,
 * since session ids are new on every connect — and restored when you reconnect.
 *
 * Rules, all enforced here so they are testable:
 *   - only SQL tabs are stored (a plugin tab is one click to reopen, and
 *     restoring one would silently start its polling);
 *   - empty buffers are not worth a localStorage entry;
 *   - hard size caps, because localStorage throws when the quota is hit and a
 *     failed write must never break the editor;
 *   - unknown/older payload shapes are ignored rather than half-read.
 */

export interface StoredBuffer {
  label: string;
  color?: string;
  sql: string;
  /** was this the tab in front */
  active?: boolean;
  /**
   * Stable per-buffer id, minted once when the tab is created and carried
   * across restarts. It is the key the persisted undo history (utils/
   * editorHistoryStore) hangs off, so a restored tab re-inherits the undo
   * stack that belongs to it. Optional
   * for backward compatibility with buffers saved before it existed.
   */
  bid?: string;
}

interface Payload {
  v: 1;
  savedAt: number;
  tabs: StoredBuffer[];
}

/** Per-buffer cap: a 200 kB query is already pathological. */
export const MAX_BUFFER_CHARS = 200_000;
/** Per-connection cap across all buffers. */
export const MAX_TOTAL_CHARS = 600_000;
/** Never keep more than this many buffers for one connection. */
export const MAX_BUFFERS = 40;

export const bufferKey = (connectionId: string) => `dbgui.buffers.${connectionId}`;

/**
 * Trim a tab list down to what may be stored: SQL tabs with text, newest kept
 * when the caps bite (the tail of the list is the most recently opened).
 */
export function encodeBuffers(tabs: StoredBuffer[]): Payload | null {
  const kept: StoredBuffer[] = [];
  let total = 0;
  // Walk from the end so that, when a cap trims, the newest tabs survive.
  for (let i = tabs.length - 1; i >= 0 && kept.length < MAX_BUFFERS; i--) {
    const t = tabs[i];
    const sql = (t.sql ?? '').slice(0, MAX_BUFFER_CHARS);
    if (!sql.trim()) continue;
    if (total + sql.length > MAX_TOTAL_CHARS) continue;
    total += sql.length;
    kept.unshift({
      label: t.label, color: t.color, sql, active: t.active,
      // Only carried when present, so the stored shape is unchanged for
      // buffers that predate the id.
      ...(t.bid ? { bid: t.bid } : {}),
    });
  }
  if (kept.length === 0) return null;
  return { v: 1, savedAt: Date.now(), tabs: kept };
}

/** Parse a stored payload, tolerating anything (corrupt, older, hand-edited). */
export function decodeBuffers(raw: string | null): StoredBuffer[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw) as Partial<Payload>;
    if (!p || p.v !== 1 || !Array.isArray(p.tabs)) return [];
    return p.tabs
      .filter((t): t is StoredBuffer =>
        !!t && typeof t.label === 'string' && typeof t.sql === 'string' && t.sql.trim() !== '')
      .slice(0, MAX_BUFFERS)
      .map(t => ({
        label: t.label.slice(0, 60),
        color: typeof t.color === 'string' ? t.color : undefined,
        sql: t.sql.slice(0, MAX_BUFFER_CHARS),
        active: t.active === true,
        ...(typeof t.bid === 'string' && t.bid ? { bid: t.bid } : {}),
      }));
  } catch {
    return [];
  }
}

/** Write (or clear) a connection's buffers. Never throws — quota is not fatal. */
export function saveBuffers(connectionId: string, tabs: StoredBuffer[]) {
  try {
    const payload = encodeBuffers(tabs);
    if (!payload) localStorage.removeItem(bufferKey(connectionId));
    else localStorage.setItem(bufferKey(connectionId), JSON.stringify(payload));
  } catch { /* quota / private mode — the editor keeps working regardless */ }
}

export function loadBuffers(connectionId: string): StoredBuffer[] {
  try {
    return decodeBuffers(localStorage.getItem(bufferKey(connectionId)));
  } catch {
    return [];
  }
}

export function clearBuffers(connectionId: string) {
  try { localStorage.removeItem(bufferKey(connectionId)); } catch { /* ignore */ }
}
