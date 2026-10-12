/**
 * Self-updater state machine — the I/O half of the updater
 * (utils/updatePolicy.ts decides what a version delta means; this store runs
 * the check/download cycle and holds what the status bar renders).
 *
 * States: idle → available{action} → downloading{pct} → ready, with failed
 * for the silent path — a failed check renders NOTHING and retries on the
 * next scheduled run; the low-interruption promise is that the updater never
 * opens a dialog.
 *
 * One design note worth keeping: the download is not abortable mid-flight
 * (Tauri's Channel has no JS→Rust close, and a third command just for abort
 * was not worth it — see src-tauri/src/commands/update.rs). "Cancel" on the
 * chip means "stop telling me": the store forgets the run, the backend still
 * finishes and installs, and the new version applies on the next natural
 * restart instead of via the relaunch chip.
 */
import { useSyncExternalStore } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { classifyUpdate, updateAction } from '../utils/updatePolicy';
import { getPref, PREFS } from './preferences';
import { toAppError } from '../utils/appError';

export interface UpdateInfo {
  version: string;
  date: string | null;
  body: string | null;
}

export type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'available'; info: UpdateInfo; action: 'auto' | 'notify' }
  | { kind: 'downloading'; version: string; pct: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; message: string };

/** Progress events from update_download_and_install (tag = "event"). */
interface UpdateProgress {
  event: 'started' | 'progress' | 'finished';
  contentLength?: number | null;
  downloaded?: number;
  total?: number | null;
}

export const RELEASE_PAGE = 'https://github.com/tuxie80/txui/releases/latest';
export function releaseTagUrl(version: string): string {
  return `https://github.com/tuxie80/txui/releases/tag/v${version}`;
}

let state: UpdaterState = { kind: 'idle' };
const listeners = new Set<() => void>();
/** Bumped on cancel so a finishing download's resolve is ignored. */
let generation = 0;
let downloadInFlight = false;

function emit() { listeners.forEach(fn => fn()); }
function set(s: UpdaterState) { state = s; emit(); }

export function getUpdaterState(): UpdaterState { return state; }
export function useUpdater(): UpdaterState {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
  );
}

export type CheckOutcome =
  | { status: 'current'; version: string }
  | { status: 'update'; version: string }
  | { status: 'error'; message: string };

/**
 * One check cycle: ask the backend, classify the delta, and act per the
 * Settings → Updates prefs — 'auto' starts the download right away, 'notify'
 * leaves the passive chip. Scheduled 10 s after launch and every 6 h from
 * App.tsx, and run on demand by "Check now" (Settings → Updates).
 */
export async function runUpdateCheck(): Promise<CheckOutcome> {
  try {
    const current = await getVersion();
    const latest = await invoke<UpdateInfo | null>('update_check');
    if (!latest) {
      if (state.kind === 'available' || state.kind === 'failed') set({ kind: 'idle' });
      return { status: 'current', version: current };
    }
    const action = updateAction(classifyUpdate(current, latest.version), {
      minor: getPref(PREFS.autoUpdateMinor),
      major: getPref(PREFS.autoUpdateMajor),
    });
    if (action === 'ignore') {
      if (state.kind === 'available' || state.kind === 'failed') set({ kind: 'idle' });
      return { status: 'current', version: current };
    }
    // A download/install for THIS version already in flight (or done) is not
    // to be stomped by a re-check.
    if ((state.kind === 'downloading' || state.kind === 'ready') && state.version === latest.version) {
      return { status: 'update', version: latest.version };
    }
    set({ kind: 'available', info: latest, action });
    if (action === 'auto') void startDownload(latest);
    return { status: 'update', version: latest.version };
  } catch (e) {
    const err = toAppError(e);
    console.warn('[updater] check failed:', err.message);
    set({ kind: 'failed', message: err.message });
    return { status: 'error', message: err.message };
  }
}

/** Download + install in the background; resolves when the bundle is swapped. */
export async function startDownload(info: UpdateInfo): Promise<void> {
  if (downloadInFlight) return;
  downloadInFlight = true;
  const gen = generation;
  let total: number | null = null;
  const chan = new Channel<UpdateProgress>();
  chan.onmessage = ev => {
    if (gen !== generation) return;
    if (ev.event === 'started') {
      total = ev.contentLength ?? null;
      set({ kind: 'downloading', version: info.version, pct: total ? 0 : null });
    } else if (ev.event === 'progress') {
      if (ev.total) total = ev.total;
      const downloaded = ev.downloaded ?? 0;
      // 99 is the cap until "finished" — the install step follows the last
      // byte and 100 % would otherwise sit there lying about being done.
      const pct = total ? Math.min(99, Math.round((downloaded / total) * 100)) : null;
      set({ kind: 'downloading', version: info.version, pct });
    } else {
      set({ kind: 'downloading', version: info.version, pct: 100 });
    }
  };
  try {
    await invoke('update_download_and_install', { onEvent: chan });
    if (gen === generation) set({ kind: 'ready', version: info.version });
  } catch (e) {
    if (gen !== generation) return;
    const err = toAppError(e);
    if (err.code === 'not_updatable') {
      // deb/rpm install — the package manager owns the file. Fall back to
      // the passive chip (the honest "not for you here"), never a failure.
      set({ kind: 'available', info, action: 'notify' });
    } else {
      console.warn('[updater] download/install failed:', err.message);
      set({ kind: 'failed', message: err.message });
    }
  } finally {
    if (gen === generation) downloadInFlight = false;
  }
}

/** "Stop telling me" — see the module comment for why the backend runs on. */
export function cancelDownload(): void {
  generation += 1;
  downloadInFlight = false;
  set({ kind: 'idle' });
}
