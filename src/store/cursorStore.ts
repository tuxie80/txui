/**
 * Caret position per SQL tab — written by SqlEditor's update listener on every
 * doc/selection change, read by exactly two leaves: the status-bar Ln/Col badge
 * and the outline's caret tracking.
 *
 * This used to be a useState on the QueryTabs workspace root, so EVERY
 * keystroke re-rendered every mounted tab, grid and panel. Keyed by tab id
 * (app-wide unique — QueryTabs' _tabCounter), subscribable per tab, same
 * shape as logStore's per-session buckets. Entries are four numbers and tab
 * ids are never reused, so there is no drop path to keep in sync.
 */
import { useSyncExternalStore } from 'react';

export interface CursorPos {
  line: number;
  col: number;
  /** total selected characters across all ranges (0 = bare caret) */
  selLen: number;
  /** number of caret ranges (>1 = multi-caret) */
  carets: number;
}

const positions = new Map<number | string, CursorPos>();
const listeners = new Map<number | string, Set<() => void>>();

function emit(tabId: number | string) {
  listeners.get(tabId)?.forEach(fn => fn());
}

/**
 * Record a tab's caret position. A no-op write (caret did not actually move —
 * e.g. a doc change that kept line/col) does not notify, so subscribers
 * re-render only when there is something new to show.
 */
export function setCursorPos(tabId: number | string, pos: CursorPos): void {
  const cur = positions.get(tabId);
  if (cur && cur.line === pos.line && cur.col === pos.col
    && cur.selLen === pos.selLen && cur.carets === pos.carets) return;
  positions.set(tabId, pos);
  emit(tabId);
}

/** Non-reactive read — for callers that need the position at one instant. */
export function getCursorPos(tabId: number | string): CursorPos | null {
  return positions.get(tabId) ?? null;
}

// Stable per-tab subscribe functions: a fresh identity per render would make
// useSyncExternalStore tear down and re-add the listener every render.
const subscribeFns = new Map<number | string, (cb: () => void) => () => void>();
function subscribeTab(tabId: number | string) {
  let fn = subscribeFns.get(tabId);
  if (!fn) {
    fn = (cb: () => void) => {
      let set = listeners.get(tabId);
      if (!set) { set = new Set(); listeners.set(tabId, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    };
    subscribeFns.set(tabId, fn);
  }
  return fn;
}

/**
 * Live caret position of one tab — re-renders only the subscriber (the
 * status-bar badge), never the workspace.
 */
export function useCursorPos(tabId: number | string): CursorPos | null {
  return useSyncExternalStore(subscribeTab(tabId), () => positions.get(tabId) ?? null);
}
