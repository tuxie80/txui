/**
 * "Is my tab the one in front?" — ambient, so a panel does not need a new prop.
 *
 * Plugin panels are tabs and stay **mounted** while their tab exists, so their
 * state, scroll and progress survive switching away. The flip side is that a
 * hidden panel would keep polling the server every 3–5 s for a view nobody is
 * looking at: open ⚡ Processes, 🔒 Locks and ⇄ Replication and a background tab
 * is quietly adding load to a production box.
 *
 * So the tab host publishes its visibility here and every polling panel reads
 * it: hidden → no timer at all; visible again → refresh immediately, then keep
 * polling. Nothing else changes — one-shot panels ignore it, and work that runs
 * on the SERVER (a query, a generation job, a Playground run) is untouched:
 * that keeps going whether you are looking or not.
 */
import { createContext, useContext } from 'react';

const TabVisibleCtx = createContext(true);

export const TabVisibleProvider = TabVisibleCtx.Provider;

/** True when this panel's tab is the one on screen (default outside a tab). */
export function useTabVisible(): boolean {
  return useContext(TabVisibleCtx);
}
