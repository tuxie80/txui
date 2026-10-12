/**
 * Galera background cluster watch — the impure half (the loop itself).
 *
 * The first feature that polls and writes history with NO panel open, so it
 * is deliberately conservative: opt-in per cluster from the ❖ Galera cluster
 * panel, 30 s default interval (15..120 configurable), one loop per cluster,
 * a clear off switch, and it stops itself when every watched connection has
 * been deleted. The loop lives HERE — a module-level store, not the panel —
 * because the panel unmounting must not stop it (the logStore/runningTasks
 * pattern), and it lives FRONTEND-side rather than as a Rust task because
 * every decision (transition diffing, cluster correlation, notification
 * policy) is pure TS by doctrine: a Rust loop would stream the same
 * snapshots back to the webview for processing anyway, and the webview is
 * alive whenever the app is. `galera_cluster_poll` opens and closes an
 * ephemeral session per node per round, so no session can leak no matter
 * when the loop stops.
 *
 * Per round: collect the streamed node snapshots, hand them to the PURE
 * `processWatchRound` (utils/galeraWatch.ts), then execute its decisions —
 * persist timeline events via `record_galera_event` (fire-and-forget, same
 * as the open Galera tab) and send OS notifications via store/notify.ts.
 * The running watch registers with the tab-activity registry so the status
 * bar's "⟳ N running" popover shows it — with a Stop button (the off
 * switch's second home).
 *
 * Persistence is one localStorage key (`dbgui.galeraWatches`, JSON), read by
 * `initGaleraWatches` once at app start (App.tsx) — an enabled watch resumes
 * polling on the next run without the panel ever opening.
 */
import { useSyncExternalStore } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { ConnectionsStore } from './connections';
import { notifyGaleraWatch } from './notify';
import { setActivity, clearTabActivities } from './tabActivity';
import type { NodeSnapshot } from '../utils/galeraCluster';
import {
  allConnectionsGone, clampWatchInterval, emptyWatchRoundState,
  parseWatchConfigs, processWatchRound, serializeWatchConfigs, watchIdFor,
  type GaleraWatchConfig, type WatchRoundState,
} from '../utils/galeraWatch';

const STORAGE_KEY = 'dbgui.galeraWatches';

type GaleraNodeEvent =
  | { type: 'node'; connection_id: string; connection_name: string; ok: boolean;
      error: string | null; status_rows: [string, string][]; variable_rows: [string, string][];
      elapsed_ms: number }
  | { type: 'done'; nodes: number; ok_count: number; total_ms: number };

interface WatchRuntime {
  state: WatchRoundState;
  timer: ReturnType<typeof setTimeout> | null;
  /** A round is running — the schedule-after-completion shape makes overlap
   *  impossible, but a slow round plus a disable must not restart anything. */
  stopped: boolean;
}

let configs: GaleraWatchConfig[] | null = null;   // null = not loaded yet
const runtimes = new Map<string, WatchRuntime>();
const listeners = new Set<() => void>();
let version = 0;
let initialized = false;

function emit() {
  version += 1;
  listeners.forEach(fn => fn());
}

function load(): GaleraWatchConfig[] {
  if (configs === null) {
    try { configs = parseWatchConfigs(localStorage.getItem(STORAGE_KEY)); }
    catch { configs = []; }
  }
  return configs;
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, serializeWatchConfigs(load())); }
  catch { /* quota — the runtime keeps running, the next run just forgets */ }
}

/** The status-bar registry key — the part before '|' doubles as the
 *  "session" label in the running-tasks popover, so it carries the name. */
function activityKey(cfg: GaleraWatchConfig): string {
  return `${cfg.name.replaceAll('|', '/')}|galera-watch`;
}

async function runRound(cfg: GaleraWatchConfig, rt: WatchRuntime): Promise<void> {
  // Battery kindness: stop when EVERY watched connection has been deleted.
  // A failed list call is not a reason to stop — the poll itself will report
  // the missing nodes if they really are gone.
  try {
    const conns = await ConnectionsStore.list();
    if (allConnectionsGone(cfg.connectionIds, conns.map(c => c.id))) {
      disableWatch(cfg.id);
      return;
    }
  } catch { /* keep polling */ }

  const snapshots: NodeSnapshot[] = [];
  const chan = new Channel<GaleraNodeEvent>();
  chan.onmessage = ev => {
    if (ev.type !== 'node') return;
    snapshots.push({
      connectionId: ev.connection_id,
      connectionName: ev.connection_name,
      ok: ev.ok,
      error: ev.error,
      statusRows: ev.status_rows,
      variableRows: ev.variable_rows,
      elapsedMs: ev.elapsed_ms,
      polledAtMs: Date.now(),
    });
  };
  try {
    await invoke('galera_cluster_poll', { connectionIds: cfg.connectionIds, onEvent: chan });
  } catch (e) {
    // A wholesale invoke failure (no per-node events at all) counts as a
    // failed round for every node, so the unreachable-streak rule — and its
    // eventual notification — still works when the backend itself is wedged.
    if (snapshots.length === 0) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of cfg.connectionIds) {
        snapshots.push({
          connectionId: id, connectionName: id, ok: false, error: msg,
          statusRows: [], variableRows: [], elapsedMs: 0, polledAtMs: Date.now(),
        });
      }
    }
  }
  if (rt.stopped) return;

  const res = processWatchRound(snapshots, rt.state, Date.now());
  rt.state = res.state;

  // Timeline rows — fire-and-forget, NEVER blocking the loop (the open
  // Galera tab's exact contract: a failed record is one missing row).
  for (const t of res.timeline) {
    for (const ev of t.events) {
      void invoke('record_galera_event', {
        connectionId: t.connectionId, engine: 'mysql',
        eventType: ev.eventType, summary: ev.summary, detail: ev.detail, ok: ev.ok,
      }).catch(() => {});
    }
  }
  for (const n of res.notices) void notifyGaleraWatch(n.title, n.body);
}

function startRuntime(cfg: GaleraWatchConfig): void {
  stopRuntime(cfg.id);
  const rt: WatchRuntime = { state: emptyWatchRoundState(), timer: null, stopped: false };
  runtimes.set(cfg.id, rt);
  reportWatchActivity(cfg);
  void tick(cfg.id, rt);   // first round immediately, then self-scheduling
}

/** One round, then schedule the next. The tick reads the CURRENT config
 *  every time: an interval change is a plain timer swap (no re-baseline of
 *  the transitions), and a removed config ends the loop (defense in depth —
 *  disableWatch stops the runtime first). */
async function tick(id: string, rt: WatchRuntime): Promise<void> {
  if (rt.stopped) return;
  rt.timer = null;   // we ARE the fired timer — null means "round in flight"
  const cur = load().find(c => c.id === id);
  if (!cur) return;
  await runRound(cur, rt);
  if (!rt.stopped) rt.timer = setTimeout(() => { void tick(id, rt); }, cur.intervalSecs * 1000);
}

function reportWatchActivity(cfg: GaleraWatchConfig): void {
  // Same key + same id = an in-place detail update (the registry keeps the
  // original start time), so an interval change does not reset the elapsed.
  setActivity(activityKey(cfg), {
    id: cfg.id,
    label: '❖ Galera watch',
    detail: `${cfg.connectionIds.length} node${cfg.connectionIds.length === 1 ? '' : 's'} · every ${cfg.intervalSecs}s`,
    // The loop lives in the app, not in any tab — closing tabs cannot hurt it
    // (only the toggle, this registry's Stop, or app shutdown can).
    survives: true,
    kill: () => { disableWatch(cfg.id); },
  });
}

function stopRuntime(id: string): void {
  const rt = runtimes.get(id);
  if (!rt) return;
  rt.stopped = true;
  if (rt.timer !== null) clearTimeout(rt.timer);
  runtimes.delete(id);
  const cfg = load().find(c => c.id === id);
  if (cfg) clearTabActivities(activityKey(cfg));
}

/** All persisted watches (started or not). */
export function listWatchConfigs(): GaleraWatchConfig[] {
  return load();
}

/** The watch for exactly this node selection, if one exists. */
export function watchForSelection(connectionIds: string[]): GaleraWatchConfig | undefined {
  const id = watchIdFor(connectionIds);
  return load().find(c => c.id === id);
}

/** Is this watch's loop actually running right now? */
export function isWatchActive(id: string): boolean {
  return runtimes.has(id);
}

/** Enable (or replace) the watch for a node selection and start its loop. */
export function enableWatch(name: string, connectionIds: string[], intervalSecs: number): GaleraWatchConfig {
  const cfg: GaleraWatchConfig = {
    id: watchIdFor(connectionIds),
    name,
    connectionIds: [...new Set(connectionIds)].sort(),
    intervalSecs: clampWatchInterval(intervalSecs),
    enabled: true,
  };
  configs = [...load().filter(c => c.id !== cfg.id), cfg];
  persist();
  startRuntime(cfg);
  emit();
  return cfg;
}

/** The off switch: stop the loop AND forget the config — "off" means off,
 *  not "paused with a row nobody can see". */
export function disableWatch(id: string): void {
  stopRuntime(id);
  const next = load().filter(c => c.id !== id);
  if (next.length !== load().length) {
    configs = next;
    persist();
  }
  emit();
}

/** Change the interval of a live watch (restarts its timer, keeps the
 *  transition baselines — a re-armed clock must not re-baseline). */
export function setWatchInterval(id: string, intervalSecs: number): void {
  const cfg = load().find(c => c.id === id);
  if (!cfg) return;
  const secs = clampWatchInterval(intervalSecs);
  if (secs === cfg.intervalSecs) return;
  configs = load().map(c => c.id === id ? { ...c, intervalSecs: secs } : c);
  persist();
  const rt = runtimes.get(id);
  if (rt) {
    // Re-arm only BETWEEN rounds (timer pending): a round in flight
    // self-schedules with the fresh interval when it completes, and a second
    // timer here would fork the loop.
    if (rt.timer !== null) {
      clearTimeout(rt.timer);
      rt.timer = setTimeout(() => { void tick(id, rt); }, secs * 1000);
    }
    reportWatchActivity({ ...cfg, intervalSecs: secs });
  }
  emit();
}

/**
 * App-start entry (App.tsx): load the persisted watches and resume every
 * enabled one. Idempotent — StrictMode's double-effect must not double the
 * loops.
 */
export function initGaleraWatches(): void {
  if (initialized) return;
  initialized = true;
  for (const cfg of load()) {
    if (cfg.enabled) startRuntime(cfg);
  }
}

/** Live-bound watch list for the panel toggle: re-renders on any change. */
export function useGaleraWatches(): GaleraWatchConfig[] {
  useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => version,
  );
  return load();
}
