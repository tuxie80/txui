/**
 * Which desktop we are running on, and the handful of things that differ.
 *
 * The *bindings* in this app were always portable — CodeMirror's `Mod-` and
 * `metaKey || ctrlKey` both do the right thing everywhere. What was not
 * portable was everything the app **says and shows**: thirty-odd labels reading
 * `⌘↵`, filenames split on `/`, and a "Unix socket" field offered on Windows
 * where no such thing exists.
 *
 * That class of bug is worse than it looks. A wrong keystroke label is not
 * cosmetic — it is an instruction the user cannot follow, and there is nothing
 * on screen to suggest it is wrong rather than the app being broken.
 *
 * Detection is from the user-agent rather than a Tauri plugin: it needs no new
 * dependency, no permission, and no async, so a label can be computed during
 * render. All three webviews (WKWebView, WebView2, WebKitGTK) report a usable
 * platform token.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export type Platform = 'mac' | 'windows' | 'linux';

/**
 * Read the platform out of a user-agent string.
 *
 * Order matters: a Windows UA contains neither "Mac" nor "Linux", but an
 * Android one contains "Linux", and macOS reports "Macintosh". Defaulting to
 * `linux` rather than `mac` is deliberate — a wrong `Ctrl` label on a Mac is
 * mildly annoying, a wrong `⌘` label on anything else is unusable.
 */
export function detectPlatform(ua: string): Platform {
  if (/Win(dows|32|64|CE)/i.test(ua)) return 'windows';
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return 'mac';
  return 'linux';
}

let cached: Platform | null = null;

export function platform(): Platform {
  if (cached) return cached;
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  cached = detectPlatform(ua);
  return cached;
}

/** Test seam — lets a test pin the platform without touching `navigator`. */
export function setPlatformForTests(p: Platform | null): void {
  cached = p;
}

export const isMac = () => platform() === 'mac';
export const isWindows = () => platform() === 'windows';
export const isLinux = () => platform() === 'linux';

// ── keyboard labels ──────────────────────────────────────────────────────────

/**
 * The modifier symbols this platform's users actually see on their keyboards.
 *
 * macOS uses glyphs and no separator (`⌘⇧F`); Windows and Linux spell them out
 * and join with `+` (`Ctrl+Shift+F`). Rendering `⌘` on Windows is not a style
 * choice — most users cannot even name that character, let alone press it.
 */
export interface KeyLabels {
  mod: string;
  shift: string;
  alt: string;
  enter: string;
  sep: string;
}

export function keyLabels(p: Platform = platform()): KeyLabels {
  return p === 'mac'
    ? { mod: '⌘', shift: '⇧', alt: '⌥', enter: '↵', sep: '' }
    : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter', sep: '+' };
}

/**
 * Render a shortcut from its parts: `shortcut('F')` → `⌘F` / `Ctrl+F`.
 *
 * Taking parts rather than rewriting a `⌘`-laden string is the point — a
 * find-and-replace over display strings gets `Ctrl+⇧F` wrong on the first
 * two-modifier shortcut it meets.
 */
export function shortcut(
  key: string,
  opts: { shift?: boolean; alt?: boolean; mod?: boolean } = {},
  p: Platform = platform(),
): string {
  const l = keyLabels(p);
  const parts: string[] = [];
  if (opts.mod !== false) parts.push(l.mod);
  if (opts.alt) parts.push(l.alt);
  if (opts.shift) parts.push(l.shift);
  parts.push(key === 'Enter' ? l.enter : key);
  return parts.join(l.sep);
}

/** `⌘↵` / `Ctrl+Enter` — much the commonest one in this app. */
export const runKey = (p: Platform = platform()) => shortcut('Enter', {}, p);

// ── paths ────────────────────────────────────────────────────────────────────

/**
 * The filename part of a path, on any platform.
 *
 * `path.split('/').pop()` was used in a dozen places, so on Windows every
 * "Saved …" toast printed `C:\Users\j\reports\q.csv` in full instead of
 * `q.csv`. Windows accepts both separators in paths, so both are split on.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/** The directory part — the mirror of [`basename`]. */
export function dirname(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i > 0 ? trimmed.slice(0, i) : i === 0 ? '/' : '';
}

// ── capabilities ─────────────────────────────────────────────────────────────

/**
 * Can this platform connect over a Unix domain socket?
 *
 * No on Windows: MySQL there uses a named pipe and PostgreSQL is TCP-only. The
 * connection form hides the field rather than leaving a control that accepts
 * input and can only ever fail — "not applicable here" is information, an
 * obscure connect error is not.
 */
export function supportsUnixSocket(p: Platform = platform()): boolean {
  return p !== 'windows';
}

/**
 * The line ending a text file should use when written for this platform.
 *
 * Exports have always emitted `\n`, which Excel and modern Notepad both read
 * correctly — but plenty of older Windows tooling shows it as a single run-on
 * line. Used as the default for the export CRLF setting, not forced.
 */
export function defaultEol(p: Platform = platform()): '\n' | '\r\n' {
  return p === 'windows' ? '\r\n' : '\n';
}

/**
 * Every shortcut label the UI prints, in one place.
 *
 * Forty inline `shortcut()` calls scattered through the components would be the
 * same bug in a new shape: the next person adding a shortcut copies a
 * neighbouring string and the `⌘` comes back. A label that does not exist here
 * does not get printed.
 *
 * Recomputed on each call so `setPlatformForTests` works; it is a handful of
 * string joins, and these are read during render at most a few dozen times.
 */
export function shortcuts(p: Platform = platform()) {
  const s = (key: string, o: Parameters<typeof shortcut>[1] = {}) => shortcut(key, o, p);
  const l = keyLabels(p);
  return {
    run:         s('Enter'),
    runAll:      s('Enter', { shift: true }),
    runToCursor: s('Enter', { alt: true }),
    /** F9 — a plain function key, not a Mod chord (like `wrap`). */
    runAllBare:  s('F9', { mod: false }),
    explain:     s('E'),
    format:      s('F', { shift: true }),
    // Beautify is Shift-Alt-F — NOT a Mod chord (see commandRegistry &
    // SqlEditor keymap). Without `mod: false` the label printed ⌘⇧⌥F while the
    // working key is ⇧⌥F.
    beautify:    s('F', { shift: true, alt: true, mod: false }),
    expandStar:  s('8', { shift: true }),
    gotoLine:    s('G'),
    sortLines:   s('S', { alt: true }),
    dedupeLines: s('U', { alt: true }),
    upperCase:   s('U', { shift: true }),
    lowerCase:   s('U'),
    saveFile:    s('S'),
    saveFileAs:  s('S', { shift: true }),
    prevStmt:    s('↑', { alt: true }),
    nextStmt:    s('↓', { alt: true }),
    palette:     s('K'),
    goToTable:   s('P'),
    newTab:      s('T'),
    /** ⇧⌘N / Ctrl+Shift+N — the File menu's New Connection accelerator. */
    newConnection: s('N', { shift: true }),
    closeTab:    s('W'),
    settings:    s(','),
    sidebar:     s('B'),
    copy:        s('C'),
    copyHeaders: s('H', { shift: true }),
    find:        s('F'),
    /** Not a mod-key chord — Alt+Z on every platform. */
    wrap:        p === 'mac' ? '⌥Z' : 'Alt+Z',
    /** Zen mode — Mod+Alt+0 (⌘⌥0 / Ctrl+Alt+0); sits beside the Mod-0 zoom reset. */
    zen:         s('0', { alt: true }),
    /** Click-to-navigate in the editor. */
    clickOpen:   p === 'mac' ? '⌘-click' : 'Ctrl+click',
    /** Bare keys, used in the kill picker's footer. */
    enter:       l.enter,
    shiftEnter:  p === 'mac' ? '⇧↵' : 'Shift+Enter',
  };
}
