/**
 * App-wide preferences — the single home for behavioural settings, surfaced
 * in the Settings window (⚙ / ⌘,). Backed by localStorage; components read a
 * key directly for defaults, or subscribe via usePreference() to react live.
 *
 * Keys are intentionally the SAME localStorage keys the rest of the app
 * already reads (e.g. 'dbgui.showCreateOnBrowse'), so this is a UI + typing
 * layer over existing storage, not a migration.
 */
import { useCallback, useEffect, useState } from 'react';

export interface PrefSpec<T> {
  key: string;
  default: T;
  parse: (raw: string | null) => T;
  serialize: (v: T) => string;
}

const bool = (key: string, def: boolean): PrefSpec<boolean> => ({
  key, default: def,
  parse: raw => raw === null ? def : raw === '1',
  serialize: v => (v ? '1' : '0'),
});
const num = (key: string, def: number): PrefSpec<number> => ({
  key, default: def,
  // `Number(null)` and `Number('')` are both 0, and 0 is finite — so the old
  // version returned 0 for every numeric preference that had never been set.
  // On a fresh install that meant `defaultLimit` = 0 (no row cap at all, full
  // result sets) and `prodRowCap` = 0 (prod cap off). Absent must mean the
  // default, and only a real number may override it.
  parse: raw => {
    if (raw === null || raw.trim() === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  },
  serialize: v => String(v),
});

/**
 * A list-of-positive-numbers pref, stored comma-separated (e.g. "80,120").
 *
 * `null` — the key was never written — means the default. An explicitly stored
 * empty string means an EMPTY list, which is how "off" is expressed: the ruler
 * columns default to [80, 120] but clearing them to [] must turn the guides
 * off rather than silently restoring the default. Only finite positive numbers
 * survive parsing; anything else is dropped.
 */
const nums = (key: string, def: number[]): PrefSpec<number[]> => ({
  key, default: def,
  parse: raw => {
    if (raw === null) return def;
    return raw.split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0);
  },
  serialize: v => v.join(','),
});

/**
 * A free-text string pref. An empty value is treated as "unset" and falls back
 * to the default — a blank SQL delimiter, for instance, would split nothing.
 */
const str = (key: string, def: string): PrefSpec<string> => ({
  key, default: def,
  parse: raw => (raw === null || raw.trim() === '' ? def : raw),
  serialize: v => v,
});

/** A string pref constrained to a known set (falls back to the default). */
const choice = <T extends string>(key: string, def: T, allowed: readonly T[]): PrefSpec<T> => ({
  key, default: def,
  parse: raw => (raw !== null && (allowed as readonly string[]).includes(raw) ? raw as T : def),
  serialize: v => v,
});

export const KEYWORD_CASES = ['lower', 'upper'] as const;
export type KeywordCase = typeof KEYWORD_CASES[number];

/**
 * When the editor formats SQL for you (see utils/sqlBeautify.ts).
 *   off       — never (default)
 *   semicolon — format the statement when `;` completes it
 *   paste     — format SQL right after it is pasted
 */
export const AUTO_FORMAT_MODES = ['off', 'semicolon', 'paste'] as const;
export type AutoFormatMode = typeof AUTO_FORMAT_MODES[number];

/**
 * When the write-confirmation window (with its row count) appears.
 *   destructive — UPDATE/DELETE always, everything else only on prod (default)
 *   always      — every write statement
 *   prod        — only on connections tagged prod, or a WHERE-less write
 */
export const WRITE_CONFIRM_MODES = ['destructive', 'always', 'prod'] as const;
export type WriteConfirmMode = typeof WRITE_CONFIRM_MODES[number];

/**
 * What happens when a statement fails partway through a multi-statement run.
 *   ask  — stop and ask: ignore this one, ignore all, or stop (default)
 *   stop — abort immediately, skipping the rest (no prompt)
 */
export const SCRIPT_ERROR_MODES = ['ask', 'stop'] as const;
export type ScriptErrorMode = typeof SCRIPT_ERROR_MODES[number];

/**
 * Line endings for exported text files.
 *   platform — CRLF on Windows, LF elsewhere (default)
 *   lf       — always \n
 *   crlf     — always \r\n
 */
export const EOL_MODES = ['platform', 'lf', 'crlf'] as const;
export type EolMode = typeof EOL_MODES[number];

/**
 * How much of a SQL Quality report is rendered (utils/qualityReport.ts).
 * The same findings, five depths — the reader chooses, not the analyzer.
 */
export const QUALITY_DETAILS = ['oneline', 'summary', 'standard', 'deep', 'forensic'] as const;
export type QualityDetail = typeof QUALITY_DETAILS[number];

/** The severity floor a quality report renders at. `info` = show everything. */
export const QUALITY_FLOORS = ['info', 'yellow', 'orange', 'red'] as const;
export type QualityFloor = typeof QUALITY_FLOORS[number];

export const PREFS = {
  /** Insert SHOW CREATE output into the editor when browsing a table/view. */
  showCreateOnBrowse: bool('dbgui.showCreateOnBrowse', false),
  /** Default row cap applied to SELECTs without their own LIMIT (new sessions). */
  defaultLimit: num('dbgui.defaultLimit', 1000),
  /** Word-wrap the SQL editor by default (new editors). */
  editorWrap: bool('dbgui:editor-wrap', false),
  /** Include the column header row when copying cells (⌘C) from a result. */
  copyHeaders: bool('dbgui.copyHeaders', true),
  /**
   * One-time acknowledgment that online tile basemaps may be fetched in the
   * Map view. OFF until the user confirms the egress dialog — tiles carry the
   * viewport's coordinates to a third-party host, so the default posture is
   * local-only rendering.
   */
  mapTilesAck: bool('dbgui.mapTilesAck', false),
  /** How SQL keywords are completed and formatted: `select` or `SELECT`. */
  editorKeywordCase: choice<KeywordCase>('dbgui.editorKeywordCase', 'upper', KEYWORD_CASES),
  /** Show the code minimap beside the SQL editor (toggles live). */
  editorMinimap: bool('dbgui.editorMinimap', true),
  /**
   * Change-bar gutter in the SQL editor (green/blue strips on lines that
   * differ from the buffer as first loaded). OFF by default: a scratch
   * buffer's baseline is its initial value, so every typed line would glow.
   */
  editorChangeBars: bool('dbgui.editorChangeBars', false),
  /**
   * The editor's automatic hint surfaces: the completion popup, live
   * diagnostics (squiggles), hover tooltips, signature help and the
   * INSERT … VALUES inlay hints. Toggles live in every open editor.
   * Explicit commands are not hints and stay on: F12 / ⌘-click, ⌘Y peek,
   * the kill picker, Find Action.
   */
  editorHints: bool('dbgui.editorHints', true),
  /** Auto-format SQL in the editor (never / on `;` / after paste). */
  editorAutoFormat: choice<AutoFormatMode>('dbgui.editorAutoFormat', 'off', AUTO_FORMAT_MODES),
  /** When to show the write-confirmation window with the affected-row count. */
  writeConfirm: choice<WriteConfirmMode>('dbgui.writeConfirm', 'destructive', WRITE_CONFIRM_MODES),
  /** App-wide base font size in px (clamped 10–20 by utils/fontScale). */
  appFontSize: num('dbgui.appFontSize', 13),
  /** Line endings written into exported files (not the clipboard). */
  exportEol: choice<EolMode>('dbgui.exportEol', 'platform', EOL_MODES),
  /** How verbose a SQL Quality report is. Applies to the screen AND exports. */
  qualityDetail: choice<QualityDetail>('dbgui.qualityDetail', 'standard', QUALITY_DETAILS),
  /** Hide quality findings less severe than this. */
  qualityFloor: choice<QualityFloor>('dbgui.qualityFloor', 'info', QUALITY_FLOORS),
  /** Show the checks that passed, at any detail level. */
  qualityShowPassed: bool('dbgui.qualityShowPassed', false),
  /** Mirror session logs to each connection's log_dir (set in the editor). */
  serverLog: bool('dbgui.serverLog', false),
  /** Fetch MySQL server warnings (SHOW WARNINGS) after write-family statements. */
  queryWarnings: bool('dbgui.queryWarnings', true),
  /** Soft row cap replacing the default LIMIT on prod sessions (0 = off). */
  prodRowCap: num('dbgui.prodRowCap', 10000),
  /**
   * How long to wait for a server to answer before giving up, in seconds.
   *
   * Applies to any connection that does not set its own (Advanced → connect
   * timeout). Short on purpose: a server that is up answers in well under a
   * second on a LAN and a couple over a VPN, so a long wait only ever means
   * "this host is not going to answer" — and staring at a spinner for that is
   * the wrong way to be told.
   */
  connectTimeoutSecs: num('dbgui.connectTimeoutSecs', 5),
  /** Render spaces, tabs and trailing whitespace (Notepad++ Show Symbol). */
  editorInvisibles: bool('dbgui.editorInvisibles', false),
  /** Per-editor font zoom in percent, independent of the app font size. */
  editorZoom: num('dbgui.editorZoom', 100),
  /**
   * Vertical right-margin guides, at these character columns (VS Code's
   * `editor.rulers`). Empty list turns them off; default marks 80 and 120.
   */
  editorRulers: nums('dbgui.editorRulers', [80, 120]),

  /**
   * Client-side deadline on a single query, in seconds. `0` — the default —
   * means no deadline.
   *
   * Off by default on purpose. TxUI does not know which statements you expect
   * to take minutes, and an import or a long ALTER killed halfway is worse
   * than a slow one; Connector/J's `socketTimeout` defaults to 0 for the same
   * reason. Set it when you want the guard, per connection (Advanced → query
   * timeout) or here for all of them.
   *
   * Unlike the server-side ceiling this is not MySQL's `max_execution_time`,
   * which bounds read-only SELECT only — this one covers writes too, and
   * issues the same KILL the Stop button does.
   */
  queryTimeoutSecs: num('dbgui.queryTimeoutSecs', 0),
  /**
   * Beep when a query you had stopped watching finally finishes.
   *
   * The point is the queries long enough that you switched to something else:
   * a beep on every 20 ms SELECT would be unusable, so it only fires once the
   * run has passed `longQueryBeepSecs`.
   */
  beepOnLongQuery: bool('dbgui.beepOnLongQuery', true),
  /**
   * OS notification when a long-running query finishes while the window is in
   * the background. Same trigger as the beep — it reuses `longQueryBeepSecs`
   * and fires only when the window is unfocused, so the two never argue about
   * what "long" means, and watching the result land stays silent.
   */
  notifyOnLongQuery: bool('dbgui.notifyOnLongQuery', true),
  /** How long a query must run before its completion is worth a beep, seconds. */
  longQueryBeepSecs: num('dbgui.longQueryBeepSecs', 60),
  /**
   * Fetch the execution plan automatically when a single-statement run takes
   * at least this long, in seconds. `0` = off.
   *
   * The plan waits behind a badge on the statement's gutter marker — fetching
   * it never steals focus. SELECT-family only, single statements only (a script
   * would mean N background EXPLAINs, a surprise load for a nicety), and never
   * on engines without EXPLAIN.
   */
  autoExplainSecs: num('dbgui.autoExplainSecs', 5),
  /**
   * Statement terminator used to split a script into statements.
   *
   * Almost always `;`. Worth changing for dialects and dumps that use
   * something else (`/`, `GO`), and a MySQL `DELIMITER` directive in the text
   * still overrides it from that point on.
   */
  sqlDelimiter: str('dbgui.sqlDelimiter', ';'),
  /** On a failed statement mid-script: prompt, or abort the run outright. */
  scriptErrorMode: choice<ScriptErrorMode>('dbgui.scriptErrorMode', 'ask', SCRIPT_ERROR_MODES),
  /**
   * Offer the interactive kill controls (kill query / kill connection) on the
   * processes list. On by default; turn it off to make the process list a
   * read-only monitor with no one-click way to terminate a session.
   */
  interactiveKill: bool('dbgui.interactiveKill', true),
  /**
   * ER diagram: allow dragging tables/notes to rearrange the layout.
   * OFF by default — the generated layout is pinned, so an accidental drag
   * cannot mutate it; the panel's 🔒/🔓 toggle flips this.
   */
  erMoveMode: bool('dbgui.erMoveMode', false),

  // ── AI assistant ────────────────────────────────────────────────────────
  // Provider + endpoint + model are here; the API key lives only in the vault
  // (ai_set_key), never in localStorage.
  aiProvider: choice<'anthropic' | 'openai'>('dbgui.aiProvider', 'anthropic', ['anthropic', 'openai']),
  aiBaseUrl: str('dbgui.aiBaseUrl', 'https://api.anthropic.com'),
  aiModel: str('dbgui.aiModel', 'claude-sonnet-4-5'),

  /**
   * Keep open sessions warm: ping them on an interval and again when the window
   * regains focus (after sleep / a VPN blip), so the pooled connection is
   * re-established before your next query hits a dead socket. On by default.
   */
  keepAlive: bool('dbgui.keepAlive', true),
} as const;

const EVT = 'dbgui:prefs-changed';

export function getPref<T>(spec: PrefSpec<T>): T {
  try { return spec.parse(localStorage.getItem(spec.key)); }
  catch { return spec.default; }
}

export function setPref<T>(spec: PrefSpec<T>, value: T): void {
  try { localStorage.setItem(spec.key, spec.serialize(value)); } catch { /* quota */ }
  window.dispatchEvent(new CustomEvent(EVT, { detail: { key: spec.key } }));
}

/**
 * The configured statement terminator.
 *
 * A one-liner, but it is read from a dozen call sites in the editor and
 * utils/sqlSplit.ts is a pure module that cannot import this one (it is driven
 * by `node --test`, with no localStorage and no React).
 */
export function sqlDelimiter(): string {
  return getPref(PREFS.sqlDelimiter);
}

/** Live-bound preference: [value, setValue] that re-renders on change anywhere. */
export function usePreference<T>(spec: PrefSpec<T>): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => getPref(spec));
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ key: string }>).detail?.key === spec.key) setValue(getPref(spec));
    };
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, [spec]);
  const set = useCallback((v: T) => setPref(spec, v), [spec]);
  return [value, set];
}
