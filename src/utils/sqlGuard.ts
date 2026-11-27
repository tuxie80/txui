/**
 * Client-side write guard: read-only connections block writes, prod
 * environments require confirmation. Detection is intentionally broad —
 * a false "confirm" beats a silent prod write.
 */

import { confirmDialog } from './appDialog.ts';

interface Dialect {
  readonly hashComment: boolean;
  readonly backslashEscape: boolean;
  readonly eStrings: boolean;
  readonly bracketIdents: boolean;
  readonly nestedComments: boolean;
  readonly dollarStrings: boolean;
  readonly pgSetReadonly: boolean;
  readonly tsqlBatch: boolean;
}

const DIALECT_OFF: Dialect = {
  hashComment: false,
  backslashEscape: false,
  eStrings: false,
  bracketIdents: false,
  nestedComments: false,
  dollarStrings: false,
  pgSetReadonly: false,
  tsqlBatch: false,
};

const DIALECT_LEGACY: Dialect = {
  hashComment: true,
  backslashEscape: true,
  eStrings: true,
  bracketIdents: false,
  nestedComments: false,
  dollarStrings: true,
  pgSetReadonly: false,
  tsqlBatch: false,
};

function dialectForEngine(engine?: string): Dialect {
  switch (engine) {
    case undefined:
      return DIALECT_LEGACY;
    case 'mysql':
    case 'mariadb':
      return { ...DIALECT_OFF, hashComment: true, backslashEscape: true };
    case 'postgres':
    case 'postgresql':
      return { ...DIALECT_OFF, eStrings: true, nestedComments: true, dollarStrings: true, pgSetReadonly: true };
    case 'sqlserver':
    case 'mssql':
      return { ...DIALECT_OFF, bracketIdents: true, nestedComments: true, tsqlBatch: true };
    case 'clickhouse':
      return { ...DIALECT_OFF, backslashEscape: true };
    case 'duckdb':
      return { ...DIALECT_OFF, eStrings: true, dollarStrings: true };
    default:
      return DIALECT_OFF;
  }
}

function isIdentBeforeEString(c: string): boolean {
  return /[A-Za-z0-9_$@#]/.test(c);
}

/** Mirror of `blank_dialect` in src-tauri/src/sqlguard.rs — preserves string
 *  length 1-for-1 so `splitAligned` cuts raw and blanked SQL at identical `;`
 *  positions. */
function blankDialect(sql: string, d: Dialect): string {
  const n = sql.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '#' && d.hashComment) {
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      if (i + 2 < n && (sql[i + 2] === '!' || sql[i + 2] === '+')) {
        out += '   ';
        i += 3;
        while (i < n && sql[i] >= '0' && sql[i] <= '9') { out += ' '; i++; }
        continue;
      }
      out += '  ';
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (d.nestedComments && sql[i] === '/' && sql[i + 1] === '*') {
          depth++; out += '  '; i += 2; continue;
        }
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--; out += '  '; i += 2; continue;
        }
        out += ' '; i++;
      }
      continue;
    }
    if (c === '$' && d.dollarStrings) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++;
      if (j < n && sql[j] === '$') {
        const tag = sql.slice(i, j + 1);
        const close = sql.indexOf(tag, j + 1);
        const end = close === -1 ? n : close + tag.length;
        out += ' '.repeat(end - i);
        i = end;
        continue;
      }
    }
    if (c === '[' && d.bracketIdents) {
      out += ' ';
      i++;
      while (i < n) {
        if (sql[i] === ']') {
          if (i + 1 < n && sql[i + 1] === ']') { out += '  '; i += 2; continue; }
          out += ' '; i++; break;
        }
        out += ' '; i++;
      }
      continue;
    }
    if (
      d.eStrings &&
      (c === 'e' || c === 'E') &&
      i + 1 < n &&
      sql[i + 1] === "'" &&
      (i === 0 || !isIdentBeforeEString(sql[i - 1]))
    ) {
      out += '  ';
      i += 2;
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        if (sql[i] === "'") {
          if (i + 1 < n && sql[i + 1] === "'") { out += '  '; i += 2; continue; }
          out += ' '; i++; break;
        }
        out += ' '; i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += ' ';
      i++;
      while (i < n) {
        if (d.backslashEscape && sql[i] === '\\' && c !== '`' && i + 1 < n) {
          out += '  '; i += 2; continue;
        }
        if (sql[i] === c) {
          if (i + 1 < n && sql[i + 1] === c) { out += '  '; i += 2; continue; }
          out += ' '; i++; break;
        }
        out += ' '; i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

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

function hasTopLevelWord(blanked: string, target: string): boolean {
  let depth = 0;
  let word = '';
  for (const c of blanked + '\n') {
    if (/[a-z0-9_]/i.test(c)) { word += c.toLowerCase(); continue; }
    if (word) {
      if (depth === 0 && word === target) return true;
      word = '';
    }
    if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
  }
  return false;
}

interface TsqlTok {
  readonly word: string;
  readonly depth: number;
  readonly afterDot: boolean;
}

function tsqlTokens(blanked: string): TsqlTok[] {
  const out: TsqlTok[] = [];
  let depth = 0;
  let word = '';
  let afterDot = false;
  let sawDot = false;
  for (const c of blanked + '\n') {
    if (/[A-Za-z0-9_@#$]/.test(c)) {
      if (!word) {
        afterDot = sawDot;
        sawDot = false;
      }
      word += c.toLowerCase();
      continue;
    }
    if (word) {
      out.push({ word, depth, afterDot });
      word = '';
      afterDot = false;
    }
    if (c === '.') sawDot = true;
    else if (!/\s/.test(c)) sawDot = false;
    if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
  }
  return out;
}

const TSQL_READ_DBCC = new Set([
  'show_statistics', 'showcontig', 'sqlperf', 'tracestatus', 'useroptions',
  'opentran', 'inputbuffer', 'memorystatus', 'proccache', 'help',
]);

const TSQL_WRITE_VERBS = new Set([
  'insert', 'update', 'delete', 'create', 'alter', 'drop',
  'truncate', 'rename', 'exec', 'execute', 'grant', 'revoke',
  'deny', 'backup', 'restore', 'reconfigure', 'shutdown',
  'kill', 'bulk',
]);

function tsqlStatementIsWrite(blanked: string): boolean {
  const toks = tsqlTokens(blanked);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.afterDot) continue;
    const next = toks[i + 1];
    const nextW = next && !next.afterDot ? next.word : undefined;
    if (TSQL_WRITE_VERBS.has(tok.word)) return true;
    if (tok.word === 'merge' && nextW !== 'join') return true;
    if (tok.word === 'dbcc' && (!nextW || !TSQL_READ_DBCC.has(nextW))) return true;
    if (tok.word === 'select') {
      for (let j = i + 1; j < toks.length; j++) {
        const nx = toks[j];
        if (nx.depth < tok.depth) break;
        if (nx.depth === tok.depth && !nx.afterDot) {
          if (nx.word === 'into') return true;
          if (nx.word === 'select' || nx.word === 'fetch') break;
        }
      }
    }
  }
  return false;
}

const TSQL_DANGEROUS_DDL = new Set([
  'drop', 'truncate', 'alter', 'rename', 'grant', 'revoke', 'deny', 'restore', 'shutdown',
]);

function tsqlStatementIsDangerousDdl(blanked: string): boolean {
  const m = /^\s*([a-z]+)(?:\s+([a-z0-9_]+))?/i.exec(blanked);
  const kw = m?.[1]?.toLowerCase() ?? '';
  const second = m?.[2]?.toLowerCase() ?? '';
  if (kw === 'create' && second !== 'or') return false;
  return tsqlTokens(blanked).some(tok => !tok.afterDot && TSQL_DANGEROUS_DDL.has(tok.word));
}

const TSQL_CLAUSE_MODIFIERS = new Set(['on', 'then', 'for', 'after', 'of']);
const TSQL_STMT_BOUNDARY_VERBS = new Set([
  'select', 'insert', 'merge', 'drop', 'truncate', 'alter', 'create', 'exec', 'execute', 'declare',
]);

function tsqlUnfilteredUpdel(s: string): boolean {
  const kw = /^\s*([a-z]+)/i.exec(s)?.[1].toLowerCase() ?? '';
  if (kw === 'create') return false;
  const pending: boolean[] = [false];
  let depth = 0;
  let word = '';
  let prevWord = '';
  let afterDot = false;
  let sawDot = false;
  let unfiltered = false;

  for (const c of s + '\n') {
    if (/[A-Za-z0-9_@#$]/.test(c)) {
      if (!word) {
        afterDot = sawDot;
        sawDot = false;
      }
      word += c.toLowerCase();
      continue;
    }
    if (word) {
      if (!afterDot) {
        const isModifier = TSQL_CLAUSE_MODIFIERS.has(prevWord);
        if ((word === 'update' || word === 'delete') && !isModifier) {
          if (pending[depth]) unfiltered = true;
          pending[depth] = true;
        } else if (word === 'where') {
          pending[depth] = false;
        } else if (pending[depth] && TSQL_STMT_BOUNDARY_VERBS.has(word)) {
          unfiltered = true;
          pending[depth] = false;
        }
      }
      prevWord = word;
      word = '';
      afterDot = false;
    }
    if (c === '.') sawDot = true;
    else if (!/\s/.test(c)) sawDot = false;
    if (c === '(') { depth++; pending[depth] = false; }
    else if (c === ')') {
      if (pending[depth]) unfiltered = true;
      pending[depth] = false;
      if (depth > 0) depth--;
    }
  }
  return unfiltered || pending.some(Boolean);
}

/**
 * True if any `;`-separated statement in `sql` writes — mirrors
 * `sqlguard::is_write_for` in Rust, which splits on `;` and classifies each
 * statement (a write hiding behind a leading SELECT used to pass here).
 * Beyond a leading write keyword this also catches two bypasses that inspect
 * only the first token would miss:
 *   • data-modifying CTEs — `WITH x AS (DELETE …) SELECT …` (the write sits
 *     inside the CTE parens), and `WITH … SELECT … INTO …`;
 *   • `EXPLAIN [ANALYZE] <write>` — on PostgreSQL EXPLAIN ANALYZE executes
 *     the statement, so `EXPLAIN ANALYZE DELETE …` is a real write.
 *
 * `engine` selects the `Dialect`, which decides what is text and what is
 * code (nested comments on PG/T-SQL, `#` comments on MySQL-family only,
 * backslash escapes, PG `E'…'` strings, T-SQL `[…]` identifiers and
 * semicolon-less batches, dollar quotes). Without it the historical
 * MySQL-leaning defaults apply.
 */
export function isWriteStatement(sql: string, engine?: string): boolean {
  const d = dialectForEngine(engine);
  const b = blankDialect(sql, d);
  if (d.pgSetReadonly) {
    // The read-only-backstop flips hide from blanked text (quoted GUC names,
    // SET SESSION CHARACTERISTICS), so PG SETs are additionally judged on the
    // RAW statement — mirrors is_write_for in sqlguard.rs.
    return splitAligned(sql, b).some(([raw, bl]) =>
      statementIsWrite(bl, d) || (/^\s*set\b/i.test(bl) && pgSetFlipsReadonly(raw)));
  }
  return b.split(';').some(s => statementIsWrite(s, d));
}

/** Cut `raw` and its blanked form into per-statement pairs — the blanked
 *  `;`s are safe split points for both because blanking preserves length
 *  (string/comment content no longer contains any). Mirror of
 *  `split_aligned` in sqlguard.rs. */
function splitAligned(raw: string, blanked: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = 0;
  for (let i = 0; i < blanked.length; i++) {
    if (blanked[i] === ';') {
      out.push([raw.slice(start, i), blanked.slice(start, i)]);
      start = i + 1;
    }
  }
  out.push([raw.slice(start), blanked.slice(start)]);
  return out;
}

/** Token of the PG SET-target scan (mirror of PgTok/pg_set_tokens in
 *  sqlguard.rs): words and "quoted" identifiers are kept lowercased — the
 *  quoted form is the whole point, since blanking erases it — while
 *  '…'/$tag$ strings and comments collapse to `other`. */
type PgTok =
  | { readonly t: 'word' | 'quoted'; readonly v: string }
  | { readonly t: 'dot' }
  | { readonly t: 'other' };

function pgSetTokens(raw: string): PgTok[] {
  const out: PgTok[] = [];
  const n = raw.length;
  let i = 0;
  while (i < n) {
    const c = raw[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && raw[i + 1] === '-') {
      const nl = raw.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    // PG block comments nest (Dialect::nested_comments for postgres).
    if (c === '/' && raw[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (raw[i] === '/' && raw[i + 1] === '*') { depth++; i += 2; }
        else if (raw[i] === '*' && raw[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    // '…' string, incl. the E'…' prefix whose backslash escapes — a SET
    // target never contains one, but the VALUE does, and an escaped quote
    // mis-skipped would leak string content into the token stream.
    if (
      c === "'" ||
      ((c === 'E' || c === 'e') &&
        raw[i + 1] === "'" &&
        (i === 0 || !isIdentBeforeEString(raw[i - 1])))
    ) {
      const escaped = c !== "'";
      i += escaped ? 2 : 1;
      while (i < n) {
        if (escaped && raw[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (raw[i] === "'") {
          if (raw[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out.push({ t: 'other' });
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(raw[j])) j++;
      if (raw[j] === '$') {
        const tag = raw.slice(i, j + 1);
        const close = raw.indexOf(tag, j + 1);
        i = close === -1 ? n : close + tag.length;
        out.push({ t: 'other' });
        continue;
      }
      i++; // a lone $ is punctuation
      continue;
    }
    if (c === '"') {
      i++;
      let name = '';
      while (i < n) {
        if (raw[i] === '"') {
          if (raw[i + 1] === '"') { name += '"'; i += 2; continue; }
          i++;
          break;
        }
        name += raw[i];
        i++;
      }
      // GUC names compare case-insensitively even when quoted.
      out.push({ t: 'quoted', v: name.toLowerCase() });
      continue;
    }
    if (/[A-Za-z0-9_]/.test(c)) {
      let w = '';
      while (i < n && /[A-Za-z0-9_]/.test(raw[i])) { w += raw[i].toLowerCase(); i++; }
      out.push({ t: 'word', v: w });
      continue;
    }
    if (c === '.') out.push({ t: 'dot' });
    i++;
  }
  return out;
}

/** PostgreSQL-only: does this RAW (single) statement flip the driver-level
 *  read-only backstop the pool sets at connect? Catches every spelling of
 *  SET [SESSION|LOCAL] (default_)transaction_read_only — bare, "quoted", or
 *  the last component of a dotted name — plus SET SESSION CHARACTERISTICS AS
 *  TRANSACTION … READ WRITE, which never names the GUC. Mirror of
 *  `pg_set_flips_readonly` in sqlguard.rs. */
function pgSetFlipsReadonly(raw: string): boolean {
  const toks = pgSetTokens(raw);
  const word = (i: number): string | undefined => {
    const t = toks[i];
    return t && t.t === 'word' ? t.v : undefined;
  };
  const component = (i: number): string | undefined => {
    const t = toks[i];
    return t && (t.t === 'word' || t.t === 'quoted') ? t.v : undefined;
  };
  if (word(0) !== 'set') return false;
  let i = 1;
  if (word(i) === 'session' || word(i) === 'local') {
    if (word(i + 1) === 'characteristics') {
      // Only the READ WRITE mode undoes the backstop; READ ONLY and the
      // ISOLATION LEVEL / DEFERRABLE modes stay allowed.
      for (let j = i + 2; j + 1 < toks.length; j++) {
        if (word(j) === 'read' && word(j + 1) === 'write') return true;
      }
      return false;
    }
    i += 1;
  }
  // configuration_parameter := component (. component)*
  let last = component(i);
  if (last === undefined) return false;
  let j = i + 1;
  while (toks[j]?.t === 'dot') {
    const nx = component(j + 1);
    if (nx === undefined) break;
    last = nx;
    j += 2;
  }
  return last === 'transaction_read_only' || last === 'default_transaction_read_only';
}

/** One blanked statement — mirror of `statement_is_write` in sqlguard.rs. */
function statementIsWrite(blanked: string, d: Dialect): boolean {
  const head = blanked.trimStart();
  if (d.tsqlBatch && tsqlStatementIsWrite(head)) return true;
  if (WRITE_RE.test(head)) return true;
  const kw = /^[a-z]+/i.exec(head)?.[0].toLowerCase() ?? '';

  if (kw === 'set') {
    // SET GLOBAL/PERSIST already matched via WRITE_RE. On PostgreSQL the
    // read-only-backstop flips (SET (default_)transaction_read_only in all
    // its quoted/dotted spellings, SET SESSION CHARACTERISTICS … READ WRITE)
    // are judged on the RAW statement by pgSetFlipsReadonly in
    // isWriteStatement — on blanked text a quoted GUC name is invisible.
    return false;
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
    // The write can sit inside the CTE parens (`WITH d AS (DELETE …)`) or feed
    // an outer table-creating `SELECT … INTO new_table`.
    return /\b(insert|update|delete|merge)\b/i.test(head) || hasTopLevelWord(head, 'into');
  }
  if (kw === 'explain' || kw === 'describe' || kw === 'desc') {
    // Drop the EXPLAIN keyword, ALL ANALYZE/VERBOSE/FORMAT option words and a
    // (…) option list, then re-test the underlying statement. Mirrors
    // `strip_explain` in sqlguard.rs (the previous single-regex pass removed
    // only one option word, so EXPLAIN ANALYZE VERBOSE DELETE slipped by).
    const rest = stripExplain(head);
    return rest !== '' && statementIsWrite(rest, d);
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
  const head = blankDialect(sql, dialectForEngine(engine)).trimStart();
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
  const head = blankDialect(sql, dialectForEngine(engine)).trimStart();
  return READ_FAMILY_RE.test(head) && !isWriteStatement(sql, engine);
}

/**
 * A bare `UPDATE`/`DELETE` with no WHERE clause hits every row — the classic
 * "oops" write. Detected on blanked SQL so a `where` inside a string/comment
 * doesn't hide the danger. (A data-modifying CTE outer UPDATE/DELETE counts.)
 */
export function isUnfilteredWrite(sql: string, engine?: string): boolean {
  const d = dialectForEngine(engine);
  const b = blankDialect(sql, d);
  return d.tsqlBatch
    ? b.split(';').some(tsqlUnfilteredUpdel)
    : b.split(';').some(unfilteredUpdel);
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
 * `is_dangerous_ddl_for` in src-tauri/src/sqlguard.rs: blanked SQL (so a
 * `drop` inside a string/comment doesn't count), per-statement first word —
 * a `DROP INDEX` inside a CREATE PROCEDURE body stays invisible at statement
 * level, while `SELECT 1; DROP TABLE t` and T-SQL control-flow / semicolon-less
 * `IF … DROP TABLE t` are caught.
 */
export function isDangerousDdl(sql: string, engine?: string): boolean {
  const d = dialectForEngine(engine);
  return blankDialect(sql, d).split(';').some(s => {
    const kw = /^\s*([a-z]+)/i.exec(s)?.[1].toLowerCase() ?? '';
    if (DANGEROUS_DDL_KEYWORDS.has(kw)) return true;
    if (d.tsqlBatch && tsqlStatementIsDangerousDdl(s)) return true;
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
    const b = blankDialect(sql, dialectForEngine(opts.engine));
    const isDel = /^\s*delete/i.test(b) || (!/^\s*update/i.test(b) && /\bdelete\b/i.test(b));
    const ok = await confirmDialog(
      `⚠ NO WHERE CLAUSE\n\nThis ${isDel ? 'DELETE' : 'UPDATE'} has no WHERE — it will affect EVERY row:\n\n${sql.slice(0, 300)}${sql.length > 300 ? '…' : ''}\n\nRun it against all rows?`,
      { danger: true },
    );
    return ok ? { ok: true } : { ok: false, reason: 'Cancelled.' };
  }
  return { ok: true };
}
