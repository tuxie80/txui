/**
 * Editor buffers that survive a restart.
 *
 * Losing a half-written migration because the app restarted (or because closing
 * the last tab disconnected the instance) is the kind of thing you only forgive
 * once. Every SQL tab's text is persisted per CONNECTION — not per session,
 * since session ids are new on every connect — and restored when you reconnect.
 *
 * Rules, all enforced here so they are testable:
 *   - SQL text and view-only presentation are stored, never query results,
 *     running state, credentials or server data;
 *   - plugin tabs are restorable, but the host mounts them only after an
 *     explicit Refresh so restoration cannot restart polling or jobs;
 *   - empty SQL buffers are not worth a localStorage entry;
 *   - hard size caps, because localStorage throws when the quota is hit and a
 *     failed write must never break the editor;
 *   - unknown/older payload shapes are ignored rather than half-read.
 */

export interface StoredEditorState {
  anchor: number;
  head: number;
  scrollTop: number;
  scrollLeft: number;
  folds: Array<{ from: number; to: number }>;
}

export type StoredResultView = 'grid' | 'plan' | 'browser' | 'log' | 'map';

export interface StoredBuffer {
  label: string;
  color?: string;
  sql: string;
  /** A view-only plugin tab. It is not mounted until the user clicks Refresh. */
  panel?: string;
  view?: StoredResultView;
  editor?: StoredEditorState;
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

const RESULT_VIEWS = new Set<StoredResultView>(['grid', 'plan', 'browser', 'log', 'map']);

function cleanPanel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value) ? value : undefined;
}

function offset(value: unknown, max = MAX_BUFFER_CHARS): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
    ? value : undefined;
}

function cleanEditor(value: unknown): StoredEditorState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Partial<StoredEditorState>;
  const anchor = offset(v.anchor);
  const head = offset(v.head);
  if (anchor === undefined || head === undefined) return undefined;
  const folds = Array.isArray(v.folds) ? v.folds.slice(0, 2_000).flatMap(range => {
    if (!range || typeof range !== 'object') return [];
    const from = offset(range.from);
    const to = offset(range.to);
    return from !== undefined && to !== undefined && to > from ? [{ from, to }] : [];
  }) : [];
  return {
    anchor, head, folds,
    scrollTop: offset(v.scrollTop, 100_000_000) ?? 0,
    scrollLeft: offset(v.scrollLeft, 100_000_000) ?? 0,
  };
}

function presentation(t: StoredBuffer): Pick<StoredBuffer, 'panel' | 'view' | 'editor'> {
  const panel = cleanPanel(t.panel);
  const editor = cleanEditor(t.editor);
  return {
    ...(panel ? { panel } : {}),
    ...(RESULT_VIEWS.has(t.view as StoredResultView) ? { view: t.view } : {}),
    ...(editor ? { editor } : {}),
  };
}

/**
 * Trim a tab list down to what may be stored: SQL tabs with text and plugin
 * tabs, newest kept when the caps bite (the tail is most recently opened).
 */
export function encodeBuffers(tabs: StoredBuffer[]): Payload | null {
  const kept: StoredBuffer[] = [];
  let total = 0;
  for (let i = tabs.length - 1; i >= 0 && kept.length < MAX_BUFFERS; i--) {
    const t = tabs[i];
    const sql = (t.sql ?? '').slice(0, MAX_BUFFER_CHARS);
    if (!sql.trim() && !cleanPanel(t.panel)) continue;
    if (total + sql.length > MAX_TOTAL_CHARS) continue;
    total += sql.length;
    kept.unshift({
      label: t.label, color: t.color, sql, active: t.active,
      ...presentation(t),
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
        !!t && typeof t.label === 'string' && typeof t.sql === 'string'
        && (t.sql.trim() !== '' || cleanPanel(t.panel) !== undefined))
      .slice(0, MAX_BUFFERS)
      .map(t => ({
        label: t.label.slice(0, 60),
        color: typeof t.color === 'string' ? t.color : undefined,
        sql: t.sql.slice(0, MAX_BUFFER_CHARS),
        ...presentation(t),
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
