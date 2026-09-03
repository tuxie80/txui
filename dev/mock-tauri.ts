// Mock of the @tauri-apps/* surface so the REAL React frontend boots in plain
// Chromium (for documentation screenshots). Renders real components/CSS with
// sample data — the backend is not involved. Aliased in dev/vite.shots.config.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */

// The shipped version, injected from package.json by dev/vite.shots.config.ts.
// It used to be a hardcoded literal, which is how every screenshot went on
// showing 0.58.0 four releases after the fact — a version string is exactly the
// kind of thing nobody re-checks in an image.
declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

// Sample data keyed by backend command name. Anything not listed falls through
// to a typed default so the UI renders instead of throwing.
const SAMPLE: Record<string, any> = {
  get_app_version: VERSION,
  list_connections: [
    { id: 'c1', name: 'prod-orders (mysql)', engine: 'mysql', host: '10.0.0.4', port: 3306, group: 'Production' },
    { id: 'c2', name: 'analytics (postgres)', engine: 'postgres', host: '10.0.0.9', port: 5432, group: 'Production' },
    { id: 'c3', name: 'warehouse (clickhouse)', engine: 'clickhouse', host: '10.0.0.20', port: 9000, group: 'Analytics' },
    { id: 'c4', name: 'cache (redis)', engine: 'redis', host: '127.0.0.1', port: 6379, group: 'Local' },
    { id: 'c5', name: 'app.db (sqlite)', engine: 'sqlite', host: null, port: null, group: 'Local' },
    { id: 'c6', name: 'events.parquet', engine: 'parquet', host: null, port: null, group: 'Local' },
  ],
};

function fallback(cmd: string): any {
  if (cmd.startsWith('list_') || cmd.startsWith('get_') && cmd.endsWith('s')) return [];
  if (cmd.startsWith('get_') || cmd.startsWith('load_')) return null;
  return null;
}

export async function invoke<T = any>(cmd: string, _args?: any): Promise<T> {
  // Allow a test page to inject per-command responses via window.__MOCK__.
  // The injection wins over SAMPLE so a shot can deliberately EMPTY a list
  // SAMPLE fills — the zero-connection first-run screen is unreachable while
  // SAMPLE always answers list_connections with six rows. Nothing in
  // doc-fixtures' mockFor() shadows a SAMPLE key, so existing shots are
  // unaffected.
  const inj = (globalThis as any).__MOCK__?.[cmd];
  if (inj !== undefined) return (typeof inj === 'function' ? inj(_args) : inj) as T;
  if (cmd in SAMPLE) return SAMPLE[cmd] as T;
  return fallback(cmd) as T;
}

export class Channel<T = any> {
  onmessage: ((m: T) => void) | null = null;
  toJSON() { return '__CHANNEL__'; }
}

export async function listen(_event: string, _cb: (e: any) => void): Promise<() => void> {
  return () => {};
}

export function getCurrentWebview() {
  return {
    onDragDropEvent: async (_cb: any) => () => {},
    label: 'main',
  };
}

export async function getVersion(): Promise<string> { return VERSION; }

export async function open(_opts?: any): Promise<string | null> { return null; }
export async function save(_opts?: any): Promise<string | null> { return null; }

// ── Additions the real app needs to boot under the mock ──────────────────────
// Each of these was a hard boot failure, not a missing feature: Vite's
// dependency optimizer resolves @tauri-apps/plugin-* against this file, so a
// symbol it imports and this file does not export fails the whole build with
// MISSING_EXPORT — and the screenshot pipeline stops before the first frame.

/** Required by @tauri-apps/plugin-notification's dist-js import. */
export async function addPluginListener(
  _plugin: string, _event: string, _cb: (p: any) => void,
): Promise<{ unregister: () => Promise<void> }> {
  return { unregister: async () => {} };
}

/** src/main.tsx — window chrome; nothing to do in a browser tab. */
export function getCurrentWindow() {
  return {
    label: 'main',
    setTitle: async (_t: string) => {},
    onCloseRequested: async (_cb: any) => () => {},
    onFocusChanged: async (_cb: any) => () => {},
    isFocused: async () => true,
    show: async () => {},
    setFocus: async () => {},
  };
}

// ── plugin-notification ──
// Screenshots must never raise an OS notification, so permission is reported as
// granted and sending is a no-op rather than a prompt mid-capture.
export async function isPermissionGranted(): Promise<boolean> { return true; }
export async function requestPermission(): Promise<string> { return 'granted'; }
export function sendNotification(_o?: any): void {}
