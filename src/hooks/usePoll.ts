/**
 * The one polling loop (WP-07). Six-plus panels used to hand-copy the same
 * boilerplate — an in-flight ref (skip a tick while the previous is still
 * running), the `useTabVisible` gate (a hidden tab polls nothing), a
 * `setInterval` + cleanup — and the copies drifted: two panels shipped
 * without the in-flight guard, stacking overlapping processlist queries on a
 * server exactly when it was too slow to answer.
 *
 * Semantics mirror the canonical copy (ProcessListPanel):
 *  - becoming visible (or mounting visible) fires the poll immediately, then
 *    repeats every `intervalSec` seconds;
 *  - `paused` keeps the immediate refresh-on-show but stops the timer;
 *  - a tick that is still running swallows the next tick (and manual clicks);
 *  - changing `intervalSec` re-arms the timer (with one immediate fire, as
 *    the panels always did);
 *  - hidden tab (via `useTabVisible`, unless `visibleOnly: false`): no timer,
 *    no traffic.
 *
 * Returns the guarded runner for manual Refresh buttons — sharing the same
 * in-flight latch, a click during a slow tick is a no-op, not a second
 * concurrent query. The poll body owns its error handling (panels setError
 * themselves); a body that still throws is swallowed so an interval tick can
 * never become an unhandled rejection.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useTabVisible } from '../store/tabVisibility';

export interface UsePollOpts {
  /** Gate on the panel's tab being the one on screen. Default true. */
  visibleOnly?: boolean;
  /** Keep the refresh-on-show but stop the interval. Default false. */
  paused?: boolean;
  /** Fire once immediately when (re)armed. Default true. */
  immediate?: boolean;
  /** Additionally skip ticks while the whole WINDOW is hidden/minimized
   *  (`document.hidden`) — for window-level pollers like the status bar. */
  windowVisibleOnly?: boolean;
  /**
   * Watchdog: let a new tick through anyway once the running one has been in
   * flight this long (a poll hung on a dead server must not silence the panel
   * forever). Default: never — strict in-flight skip.
   */
  inFlightGraceMs?: number;
}

export function usePoll(
  fn: () => Promise<unknown> | unknown,
  intervalSec: number,
  opts: UsePollOpts = {},
): () => Promise<void> {
  const { visibleOnly = true, paused = false, immediate = true, windowVisibleOnly = false,
          inFlightGraceMs = Infinity } = opts;
  const inFlight = useRef(false);
  const startedAt = useRef(0);
  // The latest body, read through a ref so the interval never re-arms just
  // because a panel re-created its callback.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const tabVisible = useTabVisible();
  const visible = visibleOnly ? tabVisible : true;

  const runSeq = useRef(0);
  const run = useCallback(async () => {
    // never queue overlapping polls (unless the running one outlived the watchdog)
    if (inFlight.current && Date.now() - startedAt.current < inFlightGraceMs) return;
    if (windowVisibleOnly && typeof document !== 'undefined' && document.hidden) return;
    // Sequence token: when a watchdog let a newer tick start past a hung one,
    // the hung tick finally resolving must not release the newer tick's latch.
    const my = ++runSeq.current;
    inFlight.current = true;
    startedAt.current = Date.now();
    try {
      await fnRef.current();
    } catch {
      // the body owns its error handling — see the module comment
    } finally {
      if (runSeq.current === my) inFlight.current = false;
    }
  }, [windowVisibleOnly, inFlightGraceMs]);

  useEffect(() => {
    if (!visible) return;                              // hidden tab: no timer, no traffic
    if (immediate) void run();
    if (paused) return;
    if (!(intervalSec > 0)) return;
    const t = setInterval(() => { void run(); }, intervalSec * 1000);
    return () => clearInterval(t);
  }, [visible, paused, intervalSec, immediate, run]);

  return run;
}
