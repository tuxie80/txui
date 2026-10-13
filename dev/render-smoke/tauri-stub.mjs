// Programmable stub for the whole @tauri-apps/* surface the frontend imports
// (enumerated 2026-10-13: core invoke/Channel, event listen, app getVersion,
// window getCurrentWindow, webview getCurrentWebview, plugin-dialog open/save,
// plugin-shell open, plugin-process relaunch, plugin-notification *). Every
// package id aliases to this one file in dev/render-smoke/bundle.mjs.
//
// Same philosophy as dev/mock-tauri.ts (which this parallels — keep the two
// in sync), but the responses are programmed per test through a global hub
// instead of a static SAMPLE table:
//
//   globalThis.__TXUI_SMOKE__ = {
//     mock: { vault_status: { state: 'unlocked', path: '/x', connections: 2, secrets: 3 } },
//     calls: [],            // every invoke lands here: { cmd, args }
//     listeners: Map,       // tauri event name -> Set<cb> (emit via emitTauriEvent)
//   }
//
// Tests install the hub; run.mjs does it for every target. A command with no
// programmed response falls back exactly like mock-tauri's fallback().

function hub() {
  const g = globalThis;
  if (!g.__TXUI_SMOKE__) {
    g.__TXUI_SMOKE__ = { mock: {}, calls: [], listeners: new Map() };
  }
  const h = g.__TXUI_SMOKE__;
  h.mock ??= {};
  h.calls ??= [];
  h.listeners ??= new Map();
  return h;
}

function fallback(cmd) {
  // Mirrors dev/mock-tauri.ts: a list/search command that answers null would
  // take panels down with `rows.length` on null — the fixture philosophy is
  // "empty, typed, and rendered", never "absent".
  if (cmd.startsWith('list_') || cmd.startsWith('search_')) return [];
  return null;
}

export async function invoke(cmd, args) {
  const h = hub();
  try {
    h.calls.push({ cmd, args: args ?? null });
    if (h.calls.length > 5000) h.calls.splice(0, h.calls.length - 5000);
  } catch { /* recording must never break the stub */ }
  const m = h.mock[cmd];
  if (m !== undefined) return typeof m === 'function' ? m(args) : m;
  if (typeof h.defaultInvoke === 'function') return h.defaultInvoke(cmd, args);
  return fallback(cmd);
}

export class Channel {
  constructor() { this.onmessage = null; }
  toJSON() { return '__CHANNEL__'; }
}

export async function listen(event, cb) {
  const h = hub();
  let set = h.listeners.get(event);
  if (!set) h.listeners.set(event, set = new Set());
  set.add(cb);
  return () => { set.delete(cb); };
}

/** Test-side helper: deliver a Tauri event as the backend would. */
export function emitTauriEvent(event, payload) {
  const h = hub();
  for (const cb of [...(h.listeners.get(event) ?? [])]) cb({ event, payload });
}

export function getCurrentWindow() {
  return {
    label: 'main',
    setTitle: async () => {},
    onCloseRequested: async () => () => {},
    onFocusChanged: async () => () => {},
    isFocused: async () => true,
    show: async () => {},
    hide: async () => {},
    setFocus: async () => {},
    close: async () => {},
    minimize: async () => {},
    maximize: async () => {},
    unmaximize: async () => {},
    isMaximized: async () => false,
    startDragging: async () => {},
    listen,
  };
}

export function getCurrentWebview() {
  return {
    label: 'main',
    onDragDropEvent: async () => () => {},
    listen,
  };
}

export async function getVersion() { return '0.0.0-smoke'; }
export async function getName() { return 'TxUI'; }
export async function getTauriVersion() { return '2.0.0'; }

// plugin-dialog
export async function open() { return null; }
export async function save() { return null; }
export async function message() {}
export async function ask() { return false; }
export async function confirm() { return false; }

// plugin-process
export async function relaunch() {}
export async function exit() {}

// plugin-notification — granted and silent, as in mock-tauri.
export async function isPermissionGranted() { return true; }
export async function requestPermission() { return 'granted'; }
export function sendNotification() {}
export async function addPluginListener() { return { unregister: async () => {} }; }
