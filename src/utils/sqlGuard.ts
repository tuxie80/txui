/**
 * Client-side write guard: read-only connections block writes, prod
 * environments require confirmation. Detection is intentionally broad —
 * a false "confirm" beats a silent prod write.
 */

import { blank } from './sqlAlias.ts';
import { confirmDialog } from './appDialog.ts';

// Mirror of WRITE_KEYWORDS in src-tauri/src/sqlguard.rs. The second line is
// PostgreSQL-specific: anonymous DO blocks, storage rewrites, catalog edits
// and explicit locks all change server state and were previously treated as
// reads by this guard.
// `bulk` is T-SQL's BULK INSERT (row load). MERGE/TRUNCATE/DROP and
// `SELECT … INTO t` — T-SQL's table-creating SELECT — are already covered by
// the first line and the `select`+`into` rule in isWriteStatement below; that
// rule is engine-agnostic on purpose because no MySQL/PG syntax puts a bare
// INTO in a top-level SELECT, so it cannot misfire there.
// `shutdown|purge|change|install|uninstall|stop` are MySQL/MariaDB server
// administration verbs (SHUTDOWN, PURGE BINARY LOGS, CHANGE REPLICATION
// SOURCE TO, INSTALL/UNINSTALL PLUGIN, STOP REPLICA); `start` is a write
// unless it begins START TRANSACTION (BEGIN's other spelling); SET PERSIST /
// PERSIST_ONLY mutate server state like SET GLOBAL. `exec` is T-SQL's
// EXEC('…')/EXEC sp_executesql — a body we cannot see, blocked like EXECUTE.
const WRITE_RE = /^(insert|update|delete|replace|drop|alter|truncate|create|grant|revoke|rename|call|merge|load|bulk|set\s+(?:global|persist(?:_only)?)|start\b(?!\s+transaction\b)|shutdown|purge|change|install|uninstall|stop|exec|optimize|repair|flush|reset|kill)\b/i;
const PG_WRITE_RE = /^(do|vacuum|cluster|reindex|refresh|comment|security|lock|discard|notify|import|reassign|execute)\b/i;

// MySQL versioned comments ("slash-star-bang", optionally with version
// digits) are EXECUTED by the server, and optimizer hints (slash-star-plus)
// carry live tokens: strip only the opener token (plus version digits) so
// the body stays visible to keyword scanning — the stray comment closer is
// punctuation no word check matches. Mirrors the same handling in
// src-tauri/src/sqlguard.rs blank().
function exposeVersionedComments(sql: string): string {
  return sql.replace(/\/\*[!+]\d*/g, m => ' '.repeat(m.length));
}

/** Strip leading whitespace and comments so the first keyword is inspected. */
function firstKeywordText(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('--') || t.startsWith('#')) {
      const nl = t.indexOf('\n');
      if (nl === -1) return '';
      s = t.slice(nl + 1);
    } else if (t.startsWith('/*')) {
      const end = t.indexOf('*/');
      if (end === -1) return '';
      s = t.slice(end + 2);
    } else {
      return t;
    }
  }
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
 * True if the statement writes. Beyond a leading write keyword this also
 * catches two bypasses that inspect only the first token would miss:
 *   • data-modifying CTEs — `WITH x AS (DELETE …) SELECT …` (the write sits
 *     inside the CTE parens), and `WITH … UPDATE …`;
 *   • `EXPLAIN [ANALYZE] <write>` — on PostgreSQL EXPLAIN ANALYZE executes
 *     the statement, so `EXPLAIN ANALYZE DELETE …` is a real write.
 */
export function isWriteStatement(sql: string): boolean {
  sql = exposeVersionedComments(sql);
  const head = firstKeywordText(sql);
  if (WRITE_RE.test(head) || PG_WRITE_RE.test(head)) return true;

  const kw = /^[a-z]+/i.exec(head)?.[0].toLowerCase() ?? '';

  if (kw === 'copy') {
    // COPY … FROM loads rows in; COPY … TO exports. Only the FROM/TO at paren
    // depth 0 decides — the FROM inside `COPY (SELECT … FROM t) TO …` must not
    // make an export look like a write.
    return copyWrites(blank(sql));
  }
  if (kw === 'prepare') {
    // PREPARE w AS INSERT … parks a write for a later EXECUTE.
    return /\b(insert|update|delete|merge|create|drop|alter|truncate)\b/i.test(blank(sql));
  }
  if (kw === 'select') {
    // SELECT … INTO new_table creates and fills a table (T-SQL's table-creating
    // SELECT; PG accepts the same syntax). Engine-agnostic on purpose — see the
    // comment on WRITE_RE above.
    return /\binto\b/i.test(blank(sql));
  }
  if (kw === 'with') {
    // Blank strings/comments/idents, then look for a modifying keyword anywhere.
    return /\b(insert|update|delete|merge)\b/i.test(blank(sql));
  }
  if (kw === 'explain' || kw === 'describe' || kw === 'desc') {
    // Drop the EXPLAIN keyword, ANALYZE/VERBOSE/FORMAT words and a (…) option
    // list, then re-test the underlying statement.
    let rest = head.replace(/^[a-z]+\s*/i, '');
    rest = rest.replace(/^(analyze|analyse|verbose|format(\s*=?\s*\w+)?)\s+/gi, '');
    rest = rest.replace(/^\([^)]*\)\s*/, '');
    return rest !== head && isWriteStatement(rest);
  }
  return false;
}

/** Row-modifying DML only (no DDL/DCL) — drives the "N rows affected" log line:
 *  an UPDATE matching 0 rows still says "0 rows affected", while SET/DDL/admin
 *  statements fall through to "completed in". `bulk` is T-SQL's BULK INSERT. */
const DML_RE = /^(insert|update|delete|replace|merge|load|bulk)\b/i;
export function isDmlStatement(sql: string): boolean {
  const head = firstKeywordText(sql);
  if (DML_RE.test(head)) return true;
  const kw = /^[a-z]+/i.exec(head)?.[0].toLowerCase() ?? '';
  // data-modifying CTE — the DML sits inside the CTE parens
  return kw === 'with' && /\b(insert|update|delete|merge)\b/i.test(blank(sql));
}

/** Read-family statements — mirror of sqlguard::is_read_family in Rust. Used
 *  to render a 0-row SELECT as "0 rows retrieved" rather than "completed in".
 *  A data-modifying CTE under WITH is NOT a read. */
const READ_FAMILY_RE = /^(select|with|table|values|show|describe|desc|explain)\b/i;
export function isReadFamilyStatement(sql: string): boolean {
  return READ_FAMILY_RE.test(firstKeywordText(sql)) && !isWriteStatement(sql);
}

/**
 * A bare `UPDATE`/`DELETE` with no WHERE clause hits every row — the classic
 * "oops" write. Detected on blanked SQL so a `where` inside a string/comment
 * doesn't hide the danger. (A data-modifying CTE outer UPDATE/DELETE counts.)
 */
export function isUnfilteredWrite(sql: string): boolean {
  return blank(exposeVersionedComments(sql)).split(';').some(unfilteredUpdel);
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

/** Destructive DDL/DCL keywords blocked on prod sessions (hard limit). */
const DANGEROUS_DDL_KEYWORDS = new Set(['drop', 'truncate', 'alter', 'rename', 'grant', 'revoke']);

/**
 * True if any `;`-separated statement starts with a destructive DDL/DCL
 * keyword (DROP, TRUNCATE, ALTER, RENAME, GRANT, REVOKE). Mirrors
 * `is_dangerous_ddl` in src-tauri/src/sqlguard.rs exactly: blanked SQL (so a
 * `drop` inside a string/comment doesn't count), per-statement first word —
 * a `DROP INDEX` inside a CREATE PROCEDURE body stays invisible at statement
 * level, while `SELECT 1; DROP TABLE t` is caught.
 */
export function isDangerousDdl(sql: string): boolean {
  return blank(exposeVersionedComments(sql)).split(';').some(s => {
    const kw = /^\s*([a-z]+)/i.exec(s)?.[1].toLowerCase() ?? '';
    if (DANGEROUS_DDL_KEYWORDS.has(kw)) return true;
    // PostgreSQL maintenance that takes an ACCESS EXCLUSIVE lock and rewrites
    // the relation — stalls every reader for the duration on a prod server.
    // The CONCURRENTLY variants are online and stay allowed.
    switch (kw) {
      case 'vacuum':  return /\bfull\b/i.test(s);
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
  opts: { readOnly?: boolean; environment?: string | null },
): GuardVerdict {
  if (!isWriteStatement(sql)) return 'allow';
  if (opts.readOnly) return 'deny';
  if (opts.environment === 'prod') return 'confirm';
  return 'allow';
}

/** Standard interactive check: true = proceed. Asks via appDialog (never
 *  window.confirm — WebKitGTK auto-accepts it with no dialog on screen). */
export async function confirmWriteIfNeeded(
  sql: string,
  opts: { readOnly?: boolean; environment?: string | null; label?: string },
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
  if (isUnfilteredWrite(sql)) {
    const ok = await confirmDialog(
      `⚠ NO WHERE CLAUSE\n\nThis ${/^\s*delete/i.test(blank(sql)) ? 'DELETE' : 'UPDATE'} has no WHERE — it will affect EVERY row:\n\n${sql.slice(0, 300)}${sql.length > 300 ? '…' : ''}\n\nRun it against all rows?`,
      { danger: true },
    );
    return ok ? { ok: true } : { ok: false, reason: 'Cancelled.' };
  }
  return { ok: true };
}
