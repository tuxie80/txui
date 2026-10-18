/**
 * Contract: every `invoke('<cmd>', { ... })` object literal in src/ carries
 * every argument the Rust command requires.
 *
 * Born from a real bug class: six call sites invoked `execute_query` without
 * its required `connectionId`/`engine` (TxShell also passed `tabId: null`
 * into a `u64`). Serde rejects those at the IPC boundary, so the SQL never
 * ran — the panels failed on a generic invoke error. TypeScript cannot see
 * across the IPC boundary; this test can.
 *
 * Method: parse every `#[tauri::command]` signature in src-tauri/src, drop
 * Option<…> and Tauri-injected params (State, AppHandle, Webview, Channel,
 * …), camelCase the rest, then brace-match each invoke object literal in
 * src/ and require the needed keys. Call sites whose payload is a variable
 * or contains a spread are skipped — unverifiable statically, and skipping
 * is the sound direction (never a false alarm).
 *
 * The Rust half of this contract — that the boundary really rejects a
 * missing/wrong-typed arg — is pinned by ipc_arg_tests in
 * src-tauri/src/commands/query.rs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'vendor' || e === 'target' || e === 'gen') continue;
      out.push(...walk(p, ext));
    } else if (ext.test(e)) out.push(p);
  }
  return out;
}

/** Types Tauri injects at runtime — never passed by the JS caller. */
const INJECTED = /^(State|AppHandle|Webview|WebviewWindow|Window|Channel|JavaScriptChannelId|Request|Responder)|^(tauri::|crate::)/;

/** Split a parameter list on top-level commas (generic-depth aware). */
function splitParams(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function snakeToCamel(s: string): string {
  // heck::to_lower_camel_case, which the tauri macro applies: a leading
  // underscore (Rust's unused-binding marker, e.g. `_path`) is a word
  // boundary, not part of the name.
  return s.replace(/^_+/, '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** cmd name → required JS arg keys, parsed from the Rust signatures. */
function rustCommands(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of walk(join(ROOT, 'src-tauri/src'), /\.rs$/)) {
    const src = readFileSync(f, 'utf8');
    const re = /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const name = m[1];
      // Brace-match the parameter list (paren depth from the open paren).
      let i = m.index + m[0].length, depth = 1, params = '';
      while (i < src.length && depth > 0) {
        const ch = src[i++];
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) break; }
        params += ch;
      }
      const required: string[] = [];
      for (const p of splitParams(params)) {
        const pm = /^\s*(?:mut\s+)?(\w+)\s*:\s*(.+)$/s.exec(p);
        if (!pm) continue;
        const [, argName, ty] = pm;
        const t = ty.trim();
        if (t.startsWith('Option<')) continue;
        if (INJECTED.test(t)) continue;
        if (/^&/.test(t)) continue; // borrowed args are deserializable but never injected
        required.push(snakeToCamel(argName));
      }
      map.set(name, required);
    }
  }
  return map;
}

/** Top-level keys of one JS object literal starting at src[start] === '{'. */
function objectKeys(src: string, start: number): { keys: string[]; spread: boolean } {
  let i = start, depth = 0, cur = '';
  const keys: string[] = [];
  let spread = false;
  const flush = () => {
    // Comments may sit between keys (a `//` line inside the literal); strip
    // them before reading the key.
    const seg = cur.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    cur = '';
    if (!seg) return;
    if (seg.startsWith('...')) { spread = true; return; }
    const km = /^['"]?([A-Za-z_$][\w$]*)['"]?\s*(:|$)/.exec(seg);
    if (km) keys.push(km[1]);
  };
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; if (depth > 1) cur += ch; continue; }
    if (ch === '}') { depth--; if (depth === 0) { flush(); break; } cur += ch; continue; }
    if (ch === ',' && depth === 1) { flush(); continue; }
    cur += ch;
  }
  return { keys, spread };
}

interface Site { file: string; cmd: string; keys: string[]; skipped: boolean }

function invokeSites(): Site[] {
  const sites: Site[] = [];
  for (const f of walk(join(ROOT, 'src'), /\.(ts|tsx)$/)) {
    const src = readFileSync(f, 'utf8');
    const re = /\binvoke\s*(?:<[^>]*>)?\(\s*['"`]([\w:]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === ')') { sites.push({ file: f, cmd: m[1], keys: [], skipped: false }); continue; }
      if (src[i] !== ',') continue; // invoke('cmd') with weird tail — not our shape
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] !== '{') { sites.push({ file: f, cmd: m[1], keys: [], skipped: true }); continue; }
      const { keys, spread } = objectKeys(src, i);
      sites.push({ file: f, cmd: m[1], keys, skipped: spread });
    }
  }
  return sites;
}

test('rust command signatures are actually parsed', () => {
  const cmds = rustCommands();
  assert.ok(cmds.size >= 150,
    `parsed only ${cmds.size} commands — the parser broke, every check below would pass vacuously`);
  assert.ok(cmds.has('execute_query'), 'execute_query must be among the parsed commands');
  assert.deepEqual(
    rustCommands().get('execute_query')!.sort(),
    ['connectionId', 'engine', 'sessionId', 'sql', 'tabId'].sort(),
    'execute_query required args drifted — update ipc_arg_tests in commands/query.rs too');
});

test('every invoke object literal carries the args its command requires', () => {
  const cmds = rustCommands();
  const failures: string[] = [];
  for (const s of invokeSites()) {
    if (s.skipped) continue;
    const required = cmds.get(s.cmd);
    if (!required) continue; // plugin commands (dialog:, updater:) and wrappers
    const missing = required.filter(k => !s.keys.includes(k));
    if (missing.length) {
      failures.push(`${s.file.replace(ROOT + '/', '')}: invoke('${s.cmd}') missing ${missing.join(', ')}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

/** Command names registered in lib.rs's `generate_handler![]`. */
function registeredCommands(): string[] {
  const src = readFileSync(join(ROOT, 'src-tauri/src/lib.rs'), 'utf8');
  const m = /generate_handler!\[([\s\S]*?)\]\s*\)/.exec(src);
  if (!m) throw new Error('generate_handler! block not found in lib.rs');
  return m[1]
    // Strip comments BEFORE splitting: a comment may itself contain commas.
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map(chunk => {
      const clean = chunk.trim();
      // Entries are bare (`save_connection`) or pathed (`commands::vacuum::run_vacuum`).
      const seg = /(\w+)$/.exec(clean);
      return seg ? seg[1] : '';
    })
    .filter(Boolean);
}

/**
 * Registered commands with no static `invoke('name')` call site, and WHY that
 * is correct. Adding an entry here is the review conversation — a command
 * nobody calls is dead weight or a feature that never got wired.
 */
const NO_CALLER_EXEMPTIONS: Record<string, string> = {
  // Dispatched through a union-typed variable: QueryTabs' endTx(cmd) runs
  // `invoke(cmd, …)` with cmd: 'commit_transaction' | 'rollback_transaction'
  // (also re-exported via useQueryRunner and DataBrowser's onEndTx).
  commit_transaction: 'invoked via the endTx(cmd) variable in QueryTabs/useQueryRunner',
  rollback_transaction: 'invoked via the endTx(cmd) variable in QueryTabs/useQueryRunner',
  // W4.4 backend half: the reader is the connection-health surface (W4.1),
  // which lands as the frontend half of the same plan. Self-removing — the
  // "wired" check below fails once a literal call site exists.
  session_pool_stats: 'W4.4 backend half — wired by the W4.1 connection-health surface (frontend half)',
};

test('every registered command has at least one caller in src/', () => {
  const registered = registeredCommands();
  assert.ok(registered.length >= 150,
    `parsed only ${registered.length} registered commands — the parser broke`);
  const invoked = new Set(invokeSites().map(s => s.cmd));
  const missing = registered.filter(
    n => !invoked.has(n) && !(n in NO_CALLER_EXEMPTIONS));
  assert.deepEqual(missing, [],
    `registered commands with no invoke('name') call site — wire them or exempt with a reason:\n${missing.join('\n')}`);
  // An exemption for a command that is no longer registered is stale — it
  // would hide the next genuinely orphaned command behind a long list.
  const stale = Object.keys(NO_CALLER_EXEMPTIONS).filter(n => !registered.includes(n));
  assert.deepEqual(stale, [], `exemptions for unregistered commands: ${stale.join(', ')}`);
  // An exemption that meanwhile gained a literal call site is done — drop it.
  const wired = Object.keys(NO_CALLER_EXEMPTIONS).filter(n => invoked.has(n));
  assert.deepEqual(wired, [], `exempted commands now have a literal caller — remove the exemption: ${wired.join(', ')}`);
});
