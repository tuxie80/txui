/**
 * Portability policy — the gate every new feature passes through.
 *
 * TxUI ships on macOS, Windows and Linux. The goal is not "it compiles on
 * three targets"; it is **one behaviour on three desktops, with as few
 * exceptions as we can live with**. Exceptions are not forbidden — they are
 * *registered*, so the app can grey the feature and say why (see
 * `src/utils/platformCaps.ts`).
 *
 * This file is the mechanism that keeps that true as code is added. Every
 * rule below exists because the alternative is a platform difference nobody
 * notices until a user on the other desktop hits it:
 *
 *  1. **A one-sided `#[cfg]` gate.** `#[cfg(unix)] do_the_thing()` with no
 *     counterpart does not fail to build on Windows — it silently does
 *     nothing there. The feature simply is not present, and no one finds out
 *     until it matters. So a file that gates on a platform must handle the
 *     others, or be listed here with a reason and its `platformCaps` id.
 *  2. **Mac glyphs in printed text.** `⌘↵` on Windows is not a cosmetic slip;
 *     it is an instruction the reader cannot carry out, with nothing on screen
 *     to suggest the app is at fault rather than them.
 *  3. **Second-guessing the platform locally.** One detector, one place, so a
 *     test can pin it — `navigator.userAgent` sniffing scattered through
 *     components cannot be.
 *  4. **`/tmp`.** Does not exist on Windows.
 *  5. **Native script dialogs.** On WebKitGTK `window.confirm()` resolves as
 *     if ACCEPTED with no dialog ever on screen — the exact opposite of a
 *     safety gate — and WKWebView has no `window.prompt` at all. Every
 *     interactive question goes through `utils/appDialog.ts`.
 *
 * The allowlists are deliberately small and each entry carries a reason. A
 * growing allowlist is the signal that the design, not the test, needs the
 * attention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PLATFORM_FEATURES } from '../src/utils/platformCaps.ts';

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'target' || name === 'dist') continue;
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some(e => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** Source with comments removed — a rule about *printed* text must not fire
 *  on a comment explaining the rule. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── 1. platform branches in the backend ─────────────────────────────────────

/**
 * Files allowed to gate on one platform without handling the others.
 * Each entry says why, and names the `platformCaps` feature that tells the
 * user about it — an unregistered exception is an invisible one.
 */
const ONE_SIDED_OK: Record<string, { why: string; feature?: string }> = {
  // Empty, and that is the point: `db/ssh.rs` was the last entry, and it left
  // in 0.49.0 when the Windows branch was written. An empty allowlist is the
  // state this test exists to protect.
};

test('a platform branch in the backend handles every platform, or is registered', () => {
  const files = walk(join(ROOT, 'src-tauri/src'), ['.rs']);
  const offenders: string[] = [];

  for (const file of files) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, 'utf8');
    const gates = [...src.matchAll(/#\[cfg\(([^\]]+)\)\]/g)].map(m => m[1]);
    if (gates.length === 0) continue;

    const has = (re: RegExp) => gates.some(g => re.test(g));
    const covered =
      // unix ↔ windows, in either spelling
      (!has(/^unix$/) || has(/not\(unix\)|windows/)) &&
      (!has(/^windows$/) || has(/not\(windows\)|unix/)) &&
      // target_os = "…" needs either every desktop named or a fallback arm
      (!has(/target_os/) ||
        has(/not\(any\(/) ||
        // `#[cfg(not(target_os = "macos"))]` is a complete cover on its own:
        // one arm for macOS, one for everything else.
        has(/not\(target_os/) ||
        (['macos', 'windows', 'linux'].every(os => has(new RegExp(`target_os = "${os}"`)))));

    if (!covered && !ONE_SIDED_OK[rel]) offenders.push(rel);
  }

  assert.deepEqual(offenders, [],
    'one-sided platform branch — handle the other desktops, or register it in ONE_SIDED_OK '
    + 'with a platformCaps feature so the UI can grey it and say why');
});

test('every registered exception names a real platformCaps feature', () => {
  const ids = new Set(PLATFORM_FEATURES.map(f => f.id));
  for (const [file, entry] of Object.entries(ONE_SIDED_OK)) {
    assert.ok(entry.why.length > 20, `${file}: the reason must be a reason`);
    if (entry.feature) {
      assert.ok(ids.has(entry.feature as never),
        `${file} names feature "${entry.feature}", which is not in PLATFORM_FEATURES`);
    }
  }
});

// ── 2. what the UI prints ───────────────────────────────────────────────────

/** `utils/platform.ts` owns these glyphs; `platformCaps` documents them. */
const GLYPH_OWNERS = ['src/utils/platform.ts', 'src/utils/platformCaps.ts'];

test('no Mac-only glyph is printed outside the shortcut table', () => {
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'src'), ['.ts', '.tsx'])) {
    const rel = relative(ROOT, file);
    if (GLYPH_OWNERS.includes(rel)) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    // ⌘ ⌥ ⇧ — the three that name keys a Windows or Linux keyboard has not
    // got. ↵ ⏎ ⇥ ↑ ↓ are fine: those keys exist everywhere.
    const m = code.match(/[⌘⌥]/);
    if (m) offenders.push(`${rel}: ${JSON.stringify(code.slice(Math.max(0, code.indexOf(m[0]) - 40), code.indexOf(m[0]) + 40))}`);
  }
  assert.deepEqual(offenders, [],
    'print shortcuts through shortcuts() in utils/platform.ts — a hardcoded ⌘ is an '
    + 'instruction a Windows user cannot follow');
});

test('the platform is detected in exactly one place', () => {
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'src'), ['.ts', '.tsx'])) {
    const rel = relative(ROOT, file);
    if (rel === 'src/utils/platform.ts') continue;
    if (/navigator\.(userAgent|platform|userAgentData)/.test(stripComments(readFileSync(file, 'utf8')))) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], 'use platform() / isMac() from utils/platform.ts');
});

// ── 3. paths ────────────────────────────────────────────────────────────────

/** `/tmp` is not a path on Windows. `std::env::temp_dir()` is. */
const TMP_OK = [
  // An #[ignore]d test fed by dev/probe_file_views.mjs; never runs in CI and
  // never runs on Windows.
  'src/db/sqlite.rs',
];

test('the backend never hardcodes /tmp in shipping code', () => {
  // Only the code above `#[cfg(test)]` is scanned. A unit test asserting that
  // `/tmp/mysql.sock` is treated as a socket path is not a portability
  // problem — it never runs on Windows and it ships to nobody.
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'src-tauri/src'), ['.rs'])) {
    const rel = relative(ROOT, file).replace(/^src-tauri\//, '');
    if (TMP_OK.includes(rel)) continue;
    const shipping = readFileSync(file, 'utf8').split(/#\[cfg\(test\)\]/)[0];
    if (/"\/tmp[/"]/.test(shipping)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'use std::env::temp_dir()');
});

// ── 4. the Windows SSH branch ───────────────────────────────────────────────

test('the askpass helper never contains the password on either platform', () => {
  // The whole design: the secret travels in the child's environment, and the
  // file on disk is three lines that read a variable. A helper that embedded
  // the password would put it on disk, in a world-readable temp directory, for
  // as long as the tunnel took to start.
  const src = readFileSync(join(ROOT, 'src-tauri/src/db/ssh.rs'), 'utf8');
  assert.match(src, /TXUI_SSH_PASS/);
  // The password variable is only ever read, never interpolated into a literal.
  assert.doesNotMatch(src, /write_all\([^)]*\{password\}/);
  assert.doesNotMatch(src, /format!\([^)]*password/);
});

test('the Windows helper uses delayed expansion, not %VAR%', () => {
  // `echo %VAR%` substitutes before the line is parsed, so a password
  // containing `&`, `|` or `>` would be executed as a command. This is the
  // one line in the branch where getting it wrong is a security bug rather
  // than a broken feature.
  const src = readFileSync(join(ROOT, 'src-tauri/src/db/ssh.rs'), 'utf8');
  assert.match(src, /enabledelayedexpansion/);
  assert.match(src, /echo !TXUI_SSH_PASS!/);
  assert.doesNotMatch(src, /echo %TXUI_SSH_PASS%/);
});

test('the Windows helper is a .cmd, because extension decides executability', () => {
  const src = readFileSync(join(ROOT, 'src-tauri/src/db/ssh.rs'), 'utf8');
  assert.match(src, /\.cmd/);
});

test('spawning ssh on Windows does not pop a console window', () => {
  const src = readFileSync(join(ROOT, 'src-tauri/src/db/ssh.rs'), 'utf8');
  assert.match(src, /CREATE_NO_WINDOW/);
});

test('the checker\'s escape hatch stays countable', () => {
  // `xplat-skip` opts a gate out of dev/xplat_check.sh, for the one thing it
  // documents it cannot do: a branch calling a Windows-only API. Each use is a
  // line nothing compiles here, so the number of them is the number of places
  // this project is trusting a manual read.
  const files = walk(join(ROOT, 'src-tauri/src'), ['.rs']);
  const uses: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const n = (src.match(/xplat-skip/g) ?? []).length;
    if (n) uses.push(`${relative(ROOT, f)} × ${n}`);
  }
  assert.deepEqual(uses, ['src-tauri/src/db/ssh.rs × 1'],
    'a new xplat-skip means a new unverifiable branch — justify it here');
});

// ── 5. native script dialogs ────────────────────────────────────────────────

/**
 * Files allowed to call window.confirm/prompt/alert. On WebKitGTK an
 * unhandled script dialog never appears: confirm() resolves as if ACCEPTED
 * (verified live — a confirm-gated DROP DATABASE ran with nothing on screen),
 * prompt() returns null, alert() is a no-op; WKWebView has no prompt() at
 * all. A native dialog is therefore not a safety gate, it is the absence of
 * one — everything goes through utils/appDialog.ts, rendered in-DOM by
 * components/AppDialogHost.tsx (docs/PORTABILITY.md §3.6).
 */
const DIALOG_OWNERS = [
  // The module that owns the in-DOM replacement. It calls none of the three
  // itself; the entry exists so the allowlist pattern matches the other rules.
  'src/utils/appDialog.ts',
];

test('no native script dialog is called outside utils/appDialog.ts', () => {
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'src'), ['.ts', '.tsx'])) {
    const rel = relative(ROOT, file);
    if (DIALOG_OWNERS.includes(rel)) continue;
    // Comments are stripped: a comment documenting the bug is not a call site.
    const code = stripComments(readFileSync(file, 'utf8'));
    // `window.confirm(` plus the bare form, without matching a method call
    // (`x.confirm(`), an identifier suffix (`confirmDialog(`) or a declaration.
    if (/window\.(confirm|prompt|alert)\s*\(|(^|[^.\w$])(confirm|prompt|alert)\s*\(/m.test(code)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [],
    'use confirmDialog/promptDialog/alertDialog from utils/appDialog.ts — on '
    + 'WebKitGTK window.confirm resolves as ACCEPTED with no dialog on screen, '
    + 'so a native confirm is a silent auto-pass, not a safety gate');
});
