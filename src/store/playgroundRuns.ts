/**
 * Live Playground runs, kept OUTSIDE the panel component.
 *
 * A spawned mess is real server state: threads exist on the database until they
 * finish or someone kills them. Closing the panel (or switching tabs, or
 * un-clicking the 🎪 icon) must therefore NOT touch them — the panel is a
 * window onto the run, not its owner. So the run lives here, keyed by session:
 * events keep arriving while the panel is unmounted, and reopening it shows the
 * same workers, the same log, and the same working Stop button.
 *
 * Only two things end a run: it finishes, or the user presses Stop
 * (`stopRun` / `stopSessionRuns`, the latter on disconnect — after that there
 * would be no UI left to manage the threads with).
 */
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface PlaygroundWorker {
  slot: number;
  role: string;
  threadId: number;
  sql: string;
  status: 'running' | 'done' | 'failed';
  ms?: number;
  error?: string | null;
}

export interface PlaygroundLogLine { t: string; level: string; msg: string }

export interface PlaygroundRun {
  runKey: string;
  /** one-line description of what was spawned, for the panel header */
  summary: string;
  scenario: string;
  running: boolean;
  workers: PlaygroundWorker[];
  log: PlaygroundLogLine[];
  error: string | null;
  startedAt: number;
}

const runs = new Map<string, PlaygroundRun>();         // sessionId → run
const listeners = new Map<string, Set<() => void>>();
const snapshots = new Map<string, PlaygroundRun | null>();

function emit(sessionId: string) {
  const run = runs.get(sessionId) ?? null;
  // New object identity per change so useSyncExternalStore re-renders.
  snapshots.set(sessionId, run ? { ...run, workers: [...run.workers], log: [...run.log] } : null);
  listeners.get(sessionId)?.forEach(fn => fn());
}

const clock = () => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

export function startRun(sessionId: string, run: Omit<PlaygroundRun, 'workers' | 'log' | 'error' | 'running' | 'startedAt'>) {
  runs.set(sessionId, {
    ...run, running: true, workers: [], log: [], error: null, startedAt: Date.now(),
  });
  emit(sessionId);
}

export function getRun(sessionId: string): PlaygroundRun | null {
  return runs.get(sessionId) ?? null;
}

export function addRunLog(sessionId: string, level: string, msg: string) {
  const run = runs.get(sessionId);
  if (!run) return;
  run.log = [...run.log.slice(-299), { t: clock(), level, msg }];
  emit(sessionId);
}

export function addWorker(sessionId: string, w: PlaygroundWorker) {
  const run = runs.get(sessionId);
  if (!run) return;
  run.workers = [...run.workers, w];
  emit(sessionId);
}

export function updateWorker(sessionId: string, slot: number, patch: Partial<PlaygroundWorker>) {
  const run = runs.get(sessionId);
  if (!run) return;
  run.workers = run.workers.map(w => w.slot === slot ? { ...w, ...patch } : w);
  emit(sessionId);
}

export function finishRun(sessionId: string, error?: string | null) {
  const run = runs.get(sessionId);
  if (!run) return;
  run.running = false;
  if (error) run.error = error;
  emit(sessionId);
}

/** Explicit user Stop: kills every thread the run spawned. */
export function stopRun(sessionId: string) {
  const run = runs.get(sessionId);
  if (!run) return;
  invoke('playground_stop', { runKey: run.runKey }).catch(() => {});
}

/**
 * Disconnect: the session's workspace is going away, so nothing would be left
 * to manage the spawned threads with — stop them rather than orphan them.
 */
export function stopSessionRuns(sessionId: string) {
  const run = runs.get(sessionId);
  if (run?.running) invoke('playground_stop', { runKey: run.runKey }).catch(() => {});
  runs.delete(sessionId);
  snapshots.delete(sessionId);
  listeners.delete(sessionId);
}

/** Forget a finished run (the panel's "clear" — never touches the server). */
export function clearRun(sessionId: string) {
  const run = runs.get(sessionId);
  if (!run || run.running) return;
  runs.delete(sessionId);
  emit(sessionId);
}

export function usePlaygroundRun(sessionId: string): PlaygroundRun | null {
  return useSyncExternalStore(
    cb => {
      let set = listeners.get(sessionId);
      if (!set) { set = new Set(); listeners.set(sessionId, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    },
    () => {
      if (!snapshots.has(sessionId)) snapshots.set(sessionId, runs.get(sessionId) ?? null);
      return snapshots.get(sessionId) ?? null;
    },
  );
}
