/**
 * Self-updater state machine. The backend returns the newest release overall
 * and the newest release in the current major branch. The branch candidate
 * follows the minor/patch preference; a major remains a separate explicit
 * Upgrade button unless its own preference allows automatic download.
 */
import { useSyncExternalStore } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { classifyUpdate, selectUpdateCandidates, updateAction } from '../utils/updatePolicy';
import { getPref, PREFS } from './preferences';
import { toAppError } from '../utils/appError';

export interface UpdateInfo {
  version: string;
  date: string | null;
  body: string | null;
}

export interface UpdateCandidates {
  latest: UpdateInfo | null;
  branch: UpdateInfo | null;
}

export type UpdateChannel = 'latest' | 'branch';

export type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'available'; info: UpdateInfo; action: 'auto' | 'notify'; notUpdatable?: boolean }
  | { kind: 'downloading'; version: string; pct: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; message: string };

export interface UpdaterView {
  state: UpdaterState;
  majorCandidate: UpdateInfo | null;
}

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
let majorCandidate: UpdateInfo | null = null;
let view: UpdaterView = { state, majorCandidate };
const listeners = new Set<() => void>();
let generation = 0;
let downloadInFlight = false;

function emit() {
  view = { state, majorCandidate };
  listeners.forEach(fn => fn());
}
function set(s: UpdaterState) { state = s; emit(); }
function setMajor(info: UpdateInfo | null) { majorCandidate = info; }

export function getUpdaterState(): UpdaterState { return state; }
export function useUpdater(): UpdaterView {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => view,
  );
}

export type CheckOutcome =
  | { status: 'current'; version: string }
  | { status: 'update'; version: string; majorVersion?: string }
  | { status: 'error'; message: string };

export async function runUpdateCheck(): Promise<CheckOutcome> {
  try {
    const current = await getVersion();
    const candidates = await invoke<UpdateCandidates>('update_check', { currentVersion: current });
    const selection = selectUpdateCandidates(current, candidates.latest, candidates.branch);
    setMajor(selection.major);
    const allowMajor = getPref(PREFS.autoUpdateMajor);
    const info = allowMajor && selection.major ? selection.major : selection.update;
    if (!info) {
      if (state.kind === 'available' || state.kind === 'failed') set({ kind: 'idle' });
      return { status: 'current', version: current };
    }
    const cls = classifyUpdate(current, info.version);
    const action = updateAction(cls, {
      minor: getPref(PREFS.autoUpdateMinor),
      major: allowMajor,
    });
    if (action === 'ignore') {
      if (state.kind === 'available' || state.kind === 'failed') set({ kind: 'idle' });
      return { status: 'current', version: current };
    }
    if ((state.kind === 'downloading' || state.kind === 'ready') && state.version === info.version) {
      return { status: 'update', version: info.version, majorVersion: selection.major?.version };
    }
    const channel: UpdateChannel = selection.major === info ? 'latest' : 'branch';
    set({ kind: 'available', info, action });
    if (action === 'auto') void startDownload(info, channel);
    return { status: 'update', version: info.version, majorVersion: selection.major?.version };
  } catch (e) {
    const err = toAppError(e);
    console.warn('[updater] check failed:', err.message);
    set({ kind: 'failed', message: err.message });
    return { status: 'error', message: err.message };
  }
}

/** Download exactly the version and channel selected by the check or button. */
export async function startDownload(info: UpdateInfo, channel: UpdateChannel): Promise<void> {
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
      const pct = total ? Math.min(99, Math.round((downloaded / total) * 100)) : null;
      set({ kind: 'downloading', version: info.version, pct });
    } else {
      set({ kind: 'downloading', version: info.version, pct: 100 });
    }
  };
  try {
    await invoke('update_download_and_install', {
      onEvent: chan,
      targetVersion: info.version,
      channel,
    });
    if (gen === generation) set({ kind: 'ready', version: info.version });
  } catch (e) {
    if (gen !== generation) return;
    const err = toAppError(e);
    if (err.code === 'not_updatable') {
      if (channel === 'latest') setMajor(null);
      set({ kind: 'available', info, action: 'notify', notUpdatable: true });
    } else {
      console.warn('[updater] download/install failed:', err.message);
      set({ kind: 'failed', message: err.message });
    }
  } finally {
    if (gen === generation) downloadInFlight = false;
  }
}

/** Stop showing this download; the selected bundle may finish in the backend. */
export function cancelDownload(): void {
  if (state.kind === 'downloading' && majorCandidate?.version === state.version) {
    setMajor(null);
  }
  generation += 1;
  downloadInFlight = false;
  set({ kind: 'idle' });
}
