/**
 * Client-side write guard: read-only connections block writes, prod
 * environments require confirmation. Detection is intentionally broad —
 * a false "confirm" beats a silent prod write.
 */

import { blank } from './sqlAlias.ts';
import { confirmDialog } from './appDialog.ts';

// Mirror of WRITE_KEYWORDS in src-tauri/src/sqlguard.rs — the two lists are
// kept identical, and tests/sqlGuardDrift.test.ts fails when they drift.
// Beyond MySQL's DML/DDL/DCL the list covers PostgreSQL (anonymous DO blocks,
// storage rewrites, catalog edits, explicit locks), ClickHouse's mutating
// vocabulary (DETACH/ATTACH/EXCHANGE/SYSTEM) and T-SQL (EXEC('…') runs a body
// we cannot see; BULK INSERT loads rows). `SELECT … INTO t` — T-SQL's
// table-creating SELECT — is the `select`+`into` rule in statementIsWrite
// below; that rule is engine-agnostic on purpose because no MySQL/PG syntax
// puts a bare INTO in a top-level SELECT, so it cannot misfire there.
// `start` is a write unless it begins START TRANSACTION (BEGIN's other
// spelling); SET PERSIST / PERSIST_ONLY mutate server state like SET GLOBAL —
// both are the special forms in WRITE_RE, matched before the keyword list.
export const WRITE_KEYWORDS = [
  'insert', 'update', 'delete', 'replace', 'drop', 'alter', 'truncate',
  'create', 'grant', 'revoke', 'rename', 'call', 'merge', 'load',
  'optimize', 'repair', 'flush', 'reset', 'kill',
  'detach', 'attach', 'exchange', 'system',
  'do', 'vacuum', 'cluster', 'reindex', 'refresh', 'comment', 'security',
  'lock', 'discard', 'notify', 'import', 'reassign', 'cleanup',
  'execute',
  'shutdown', 'purge', 'change', 'install', 'uninstall', 'stop',
  'exec', 'bulk',
];
const WRITE_RE = new RegExp(
  `^(?:${WRITE_KEYWORDS.join('|')}|set\\s+(?:global|persist(?:_only)?)|start\\b(?!\\s+transaction\\b))\\b`,
  'i',
);

// MySQL versioned comments ("slash-star-bang", optionally with version
// digits) are EXECUTED by the server, and optimizer hints (slash-star-plus)
// carry live tokens: strip only the opener token (plus version digits) so
// the body stays visible to keyword scanning — the stray comment closer is
// punctuation no word check matches. Mirrors the same handling in
// src-tauri/src/sqlguard.rs blank().
function exposeVersionedComments(sql: string): string {
  return sql.replace(/\/\*[!+]\d*/g, m => ' '.repeat(m.length));
}

/** Direction of a COPY statement: true when it loads data in. Mirrors
 *  `copy_writes` in src-tauri/src/sqlguard.rs — only a top-level FROM/TO
 *  counts, and the first one wins. */
function copyWrites(blanked: string): boolean {
  const after = blanked.trimStart().slice(4);
  let depth = 0;
  let word = '';
  for (const c of after) {
    if (c === '(') { depth++; word = ''; continue; }
    if (c === ')') { depth--; word = ''; continue; }
    if (/[a-z0-9_]/i.test(c)) { word += c.toLowerCase(); continue; }
    if (depth === 0) {
      if (word === 'from') return true;
      if (word === 'to')   return false;
    }
    word = '';
  }
  return depth === 0 && word === 'from';
}

/**
 * True if any `;`-separated statement in `sql` writes — mirrors
 * `sqlguard::is_write_for` in Rust, which splits on `;` and classifies each
 * statement (a write hiding behind a leading SELECT used to pass here).
 * Beyond a leading write keyword this also catches two bypasses that inspect
 * only the first token would miss:
 *   • data-modifying CTEs — `WITH x AS (DELETE …) SELECT …` (the write sits
 *     inside the CTE parens), and `WITH … UPDATE …`;
 *   • `EXPLAIN [ANALYZE] <write>` — on PostgreSQL EXPLAIN ANALYZE executes
 *     the statement, so `EXPLAIN ANALYZE DELETE …` is a real write.
 *
 * `engine` is threaded into `blank`, which decides what is text and what is
 * code (nested comments on PG/T-SQL, `#` comments on MySQL-family only,
 * backslash escapes, dollar quotes). Without it the historical MySQL-leaning
 * defaults apply.
 */
export function isWriteStatement(sql: string, engine?: string): boolean {
  return blank(exposeVersionedComments(sql), engine).split(';')
    .some(s => statementIsWrite(s, engine));
}

/** One blanked statement — mirror of `statement_is_write` in sqlguard.rs. */
function statementIsWrite(blanked: string, engine?: string): boolean {
  const head = blanked.trimStart();
  if (WRITE_RE.test(head)) return true;
  const kw = /^[a-z]+/i.exec(head)?.[0].toLowerCase() ?? '';

  if (kw === 'set') {
    // SET GLOBAL/PERSIST already matched via WRITE_RE. On PostgreSQL,
    // SET [SESSION|LOCAL] (default_)transaction_read_only flips the
    // driver-level read-only backstop the pool sets at connect — a write as
    // far as the guard is concerned (pg_set_readonly in sqlguard.rs).
    return engine === 'postgres'
      && /^set\s+(?:(?:session|local)\s+)?(?:default_transaction_read_only|transaction_read_only)\b/i.test(head);
  }
  if (kw === 'copy') {
    // COPY … FROM loads rows in; COPY … TO exports. Only the FROM/TO at paren
    // depth 0 decides — the FROM inside `COPY (SELECT … FROM t) TO …` must not
    // make an export look like a write.
    return copyWrites(head);
  }
  if (kw === 'prepare') {
    // PREPARE w AS INSERT … parks a write for a later EXECUTE.
    return /\b(insert|update|delete|merge|create|drop|alter|truncate)\b/i.test(head);
  }
  if (kw === 'select') {
    // SELECT … INTO new_table creates and fills a table (T-SQL's table-creating
    // SELECT; PG accepts the same syntax). Engine-agnostic on purpose — see the
    // comment on WRITE_KEYWORDS above.
    return /\binto\b/i.test(head);
  }
  if (kw === 'with') {
    // The write can sit inside the CTE parens — look for a modifying keyword
    // anywhere in the (already blanked) statement.
    return /\b(insert|update|delete|merge)\b/i.test(head);
  }
  if (kw === 'explain' || kw === 'describe' || kw === 'desc') {
    // Drop the EXPLAIN keyword, ALL ANALYZE/VERBOSE/FORMAT option words and a
    // (…) option list, then re-test the underlying statement. Mirrors
    // `strip_explain` in sqlguard.rs (the previous single-regex pass removed
    // only one option word, so EXPLAIN ANALYZE VERBOSE DELETE slipped by).
    const rest = stripExplain(head);
    return rest !== '' && statementIsWrite(rest, engine);
  }
  return false;
}

/** Remove a leading explain/describe keyword plus analyze/verbose/format
 *  words and a parenthesised option list — port of `strip_explain` in
 *  src-tauri/src/sqlguard.rs, including its loop. */
function stripExplain(blanked: string): string {
  let s = blanked.trimStart();
  const fw = /^[a-z]+/i.exec(s)?.[0] ?? '';
  s = s.slice(fw.length).trimStart();
  for (;;) {
    const lw = (/^[a-z]+/i.exec(s)?.[0] ?? '').toLowerCase();
    if (lw === 'analyze' || lw === 'analyse' || lw === 'verbose' || lw === 'format') {
      s = s.slice(lw.length).trimStart();
      // `format = json` / `format=json`
      if (s.startsWith('=')) s = s.slice(1).trimStart();
      const v = /^[a-z]+/i.exec(s)?.[0] ?? '';
      if (v && lw === 'format') s = s.slice(v.length).trimStart();
      continue;
    }
    break;
  }
  if (s.startsWith('(')) {
    // skip the balanced option list
    let depth = 0;
    let i = 0;
    while (i < s.length) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0) { i++; break; } }
      i++;
    }
    s = s.slice(i).trimStart();
  }
  return s;
}

/** Row-modifying DML only (no DDL/DCL) — drives the "N rows affected" log line:
 *  an UPDATE matching 0 rows still says "0 rows affected", while SET/DDL/admin
 *  statements fall through to "completed in". `bulk` is T-SQL's BULK INSERT. */
const DML_RE = /^(insert|update|delete|replace|merge|load|bulk)\b/i;
export function isDmlStatement(sql: string, engine?: string): boolean {
  const head = blank(sql, engine).trimStart();
  if (DML_RE.test(head)) return true;
  const kw = /^[a-z]+/i.exec(head)?.[0].toLowerCase() ?? '';
  // data-modifying CTE — the DML sits inside the CTE parens
  return kw === 'with' && /\b(insert|update|delete|merge)\b/i.test(head);
}

/** Read-family statements — mirror of sqlguard::is_read_family in Rust. Used
 *  to render a 0-row SELECT as "0 rows retrieved" rather than "completed in".
 *  A data-modifying CTE under WITH is NOT a read, and neither is a script
 *  whose later statements write. */
const READ_FAMILY_RE = /^(select|with|table|values|show|describe|desc|explain)\b/i;
export function isReadFamilyStatement(sql: string, engine?: string): boolean {
  const head = blank(exposeVersionedComments(sql), engine).trimStart();
  return READ_FAMILY_RE.test(head) && !isWriteStatement(sql, engine);
}

/**
 * A bare `UPDATE`/`DELETE` with no WHERE clause hits every row — the classic
 * "oops" write. Detected on blanked SQL so a `where` inside a string/comment
 * doesn't hide the danger. (A data-modifying CTE outer UPDATE/DELETE counts.)
 */
export function isUnfilteredWrite(sql: string, engine?: string): boolean {
  return blank(exposeVersionedComments(sql), engine).split(';').some(unfilteredUpdel);
}

/** One blanked statement: does it contain an UPDATE/DELETE with no WHERE at
 *  the *same paren depth*? A `where` inside a subquery or CTE body must not
 *  excuse a WHERE-less outer write, and a data-modifying CTE's inner
 *  DELETE/UPDATE is judged by the WHERE inside its own parens. Mirrors
 *  `unfiltered_updel` in src-tauri/src/sqlguard.rs. */
function unfilteredUpdel(s: string): boolean {
  const kw = /^\s*([a-z]+)/i.exec(s)?.[1].toLowerCase() ?? '';
  if (kw !== 'update' && kw !== 'delete' && kw !== 'with') return false;
  // pending[d] = an UPDATE/DELETE verb seen at paren depth d, no WHERE yet
  const pending: boolean[] = [false];
  let depth = 0;
  let word = '';
  let unfiltered = false;
  for (const c of s + '\n') {
    if (/[a-z0-9_]/i.test(c)) { word += c.toLowerCase(); continue; }
    if (word) {
      if (word === 'update' || word === 'delete') pending[depth] = true;
      else if (word === 'where') pending[depth] = false;
      word = '';
    }
    if (c === '(') { depth++; pending[depth] = false; }
    else if (c === ')') {
      if (pending[depth]) unfiltered = true;   // group closed WHERE-less
      pending[depth] = false;
      if (depth > 0) depth--;
    }
  }
  return unfiltered || pending.some(Boolean);
}

/** Destructive DDL/DCL keywords blocked on prod sessions (hard limit).
 *  Mirror of DANGEROUS_DDL_KEYWORDS in src-tauri/src/sqlguard.rs — kept
 *  identical; tests/sqlGuardDrift.test.ts fails when they drift. `detach`
 *  and `exchange` are ClickHouse: DETACH makes a table vanish and EXCHANGE
 *  swaps two of them under live readers. */
export const DANGEROUS_DDL_KEYWORDS = new Set([
  'drop', 'truncate', 'alter', 'rename', 'grant', 'revoke', 'detach', 'exchange',
]);

/**
 * True if any `;`-separated statement starts with a destructive DDL/DCL
 * keyword (DROP, TRUNCATE, ALTER, RENAME, GRANT, REVOKE). Mirrors
 * `is_dangerous_ddl` in src-tauri/src/sqlguard.rs exactly: blanked SQL (so a
 * `drop` inside a string/comment doesn't count), per-statement first word —
 * a `DROP INDEX` inside a CREATE PROCEDURE body stays invisible at statement
 * level, while `SELECT 1; DROP TABLE t` is caught.
 */
export function isDangerousDdl(sql: string, engine?: string): boolean {
  return blank(exposeVersionedComments(sql), engine).split(';').some(s => {
    const kw = /^\s*([a-z]+)/i.exec(s)?.[1].toLowerCase() ?? '';
    if (DANGEROUS_DDL_KEYWORDS.has(kw)) return true;
    // PostgreSQL maintenance that takes an ACCESS EXCLUSIVE lock and rewrites
    // the relation — stalls every reader for the duration on a prod server.
    // The CONCURRENTLY variants are online and stay allowed.
    switch (kw) {
      case 'vacuum':  return /\bfull\b/i.test(s);
      // ClickHouse SYSTEM spans `FLUSH LOGS` (routine) and `SHUTDOWN` (stops
      // the server) — only the destructive half is a prod hard limit.
      case 'system':  return /\b(shutdown|kill|restart|restore|drop|stop)\b/i.test(s);
      case 'cluster': return true;
      case 'reindex':
      case 'refresh': return !/\bconcurrently\b/i.test(s);
      default:        return false;
    }
  });
}

export type GuardVerdict = 'allow' | 'confirm' | 'deny';
export function guardWrite(
  sql: string,
  opts: { readOnly?: boolean; environment?: string | null; engine?: string },
): GuardVerdict {
  if (!isWriteStatement(sql, opts.engine)) return 'allow';
  if (opts.readOnly) return 'deny';
  if (opts.environment === 'prod') return 'confirm';
  return 'allow';
}

/** Standard interactive check: true = proceed. Asks via appDialog (never
 *  window.confirm — WebKitGTK auto-accepts it with no dialog on screen). */
export async function confirmWriteIfNeeded(
  sql: string,
  opts: { readOnly?: boolean; environment?: string | null; label?: string; engine?: string },
): Promise<{ ok: boolean; reason?: string }> {
  const verdict = guardWrite(sql, opts);
  if (verdict === 'deny') {
    return { ok: false, reason: 'Blocked: this connection is read-only.' };
  }
  if (verdict === 'confirm') {
    const ok = await confirmDialog(
      `⚠ PRODUCTION${opts.label ? ` — ${opts.label}` : ''}\n\nThis looks like a write statement:\n\n${sql.slice(0, 300)}${sql.length > 300 ? '…' : ''}\n\nExecute on production?`,
      { danger: true },
    );
    return ok ? { ok: true } : { ok: false, reason: 'Cancelled.' };
  }
  // Independent of environment: a WHERE-less UPDATE/DELETE affects every row.
  if (isUnfilteredWrite(sql, opts.engine)) {
    const ok = await confirmDialog(
      `⚠ NO WHERE CLAUSE\n\nThis ${/^\s*delete/i.test(blank(sql, opts.engine)) ? 'DELETE' : 'UPDATE'} has no WHERE — it will affect EVERY row:\n\n${sql.slice(0, 300)}${sql.length > 300 ? '…' : ''}\n\nRun it against all rows?`,
      { danger: true },
    );
    return ok ? { ok: true } : { ok: false, reason: 'Cancelled.' };
  }
  return { ok: true };
}
