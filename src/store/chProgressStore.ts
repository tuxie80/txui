/**
 * Live ClickHouse read progress, per tab — the backend's `dbgui:ch-progress`
 * event fires every ~200 ms for the whole duration of a CH query. Held here
 * instead of in QueryTabs root state, so a running CH query re-renders only
 * the tiny badge next to the Cancel button (the LogCount pattern, one level
 * down), not the entire workspace several times a second.
 *
 * Keyed by tab id (app-wide unique). Other engines never emit, so their tabs
 * never appear here.
 */
import { useSyncExternalStore } from 'react';
import type { ChProgressEvent } from '../utils/chProgress';

const progress = new Map<number, ChProgressEvent>();
const listeners = new Map<number, Set<() => void>>();

function emit(tabId: number) {
  listeners.get(tabId)?.forEach(fn => fn());
}

/** Record one progress sample — called from the `dbgui:ch-progress` listener. */
export function setChProgress(p: ChProgressEvent): void {
  progress.set(p.tabId, p);
  emit(p.tabId);
}

/**
 * Drop every tab that is no longer running, so a finished query does not
 * leave a stale figure next to an idle tab. Called when the tab set changes.
 */
export function pruneChProgress(running: Set<number>): void {
  for (const tabId of [...progress.keys()]) {
    if (!running.has(tabId)) {
      progress.delete(tabId);
      emit(tabId);
    }
  }
}

// Stable per-tab subscribe functions: a fresh identity per render would make
// useSyncExternalStore tear down and re-add the listener every render.
const subscribeFns = new Map<number, (cb: () => void) => () => void>();
function subscribeTab(tabId: number) {
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

/** Live progress of one tab — re-renders only the subscribing badge. */
export function useChProgress(tabId: number): ChProgressEvent | null {
  return useSyncExternalStore(subscribeTab(tabId), () => progress.get(tabId) ?? null);
}
