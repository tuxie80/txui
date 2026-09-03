/**
 * Caret-context classification for editor hinting: what KIND of thing belongs
 * at the cursor (table, column, database, procedure, join target, …), plus
 * CTE / derived-table discovery so `cte.` completes the projected columns.
 *
 * Works on `blank()`ed SQL (strings/comments spaced out) — same foundation as
 * the alias parser.
 */
import { blank } from './sqlAlias.ts';

export type SqlContextKind =
  | 'table-clause'   // FROM / JOIN / INTO / UPDATE / TRUNCATE … → tables & views
  | 'join-table'     // immediately after JOIN → FK-aware join suggestions + tables
  | 'on-clause'      // after JOIN <t> ON → equality-pair suggestions + columns
  | 'use-db'         // USE → databases
  | 'call-proc'      // CALL → procedures
  | 'insert-cols'    // INSERT INTO t (… → columns of t
  | 'column'         // SELECT / WHERE / GROUP BY … → columns
  | 'statement-start'
  | 'literal'        // inside a string/comment/backtick — no hinting at all
  | 'generic';

export interface SqlContext {
  kind: SqlContextKind;
  /** insert-cols: the target table as written */
  insertTable?: string;
  /** on-clause: the JOIN target ("table [alias]") this ON belongs to */
  joinTarget?: { table: string; alias: string };
}

const TABLE_CLAUSE_RE =
  /\b(?:from|straight_join|into|update|truncate(?:\s+table)?|describe|table)\s+[\w`"$.]*$/i;
const JOIN_RE = /\bjoin\s+[\w`"$.]*$/i;
const USE_RE = /\buse\s+[\w`"$]*$/i;
const CALL_RE = /\bcall\s+[\w`"$.]*$/i;
const INSERT_COLS_RE =
  /\binsert\s+(?:ignore\s+)?into\s+([\w`"$.]+)\s*\(\s*[\w`"$,\s]*$/i;
const ON_RE =
  /\bjoin\s+([\w`"$.]+)(?:\s+(?:as\s+)?(?!on\b)([A-Za-z_][\w$]*))?\s+on\s+(?:[\w`"$.]+\s*=\s*)*[\w`"$.]*$/i;
const COLUMN_RE =
  /(?:\border\s+by|\bgroup\s+by|\bwhere|\bhaving|\bselect|\bset|\bon|\band|\bor|\bnot|\bwhen|\bthen|\bby|,|\(|=|<|>)\s*[\w`"$]*$/i;

function cleanIdent(raw: string): string {
  return raw.replace(/[`"]/g, '');
}

/** What is still open when the text runs out. */
export interface Unclosed {
  /** An unterminated string/quoted identifier: the quote char that opened it. */
  quote?: "'" | '"' | '`';
  /** An unterminated comment — 'line' ends only at a newline, 'block' at its closer. */
  comment?: 'line' | 'block';
  /** `(` without a matching `)`, counted outside strings/comments. */
  parens: number;
}

/**
 * Scan `sql` and report what is still open at the end — the one scan behind
 * both `endsInsideLiteral` and Complete Statement's "close what I left open".
 * Quote handling follows SQL rules: a doubled quote (`''`, `""`, `` `` ``) is
 * an escape, not the end; a backslash escapes the next char. A `)` seen with
 * nothing open is ignored — unbalanced closers are the user's to fix, there is
 * nothing to "close" for them.
 */
export function unclosedAt(sql: string): Unclosed {
  const out: Unclosed = { parens: 0 };
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) { out.comment = 'line'; i = n; break; }
      i = nl + 1;
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) { out.comment = 'block'; i = n; break; }
      i = close + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch as "'" | '"' | '`';
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === q) {
          if (j + 1 < n && sql[j + 1] === q) { j += 2; continue; } // '' escape
          closed = true; j++; break;
        }
        j++;
      }
      if (!closed) { out.quote = q; i = n; break; }
      i = j;
    } else {
      if (ch === '(') out.parens++;
      else if (ch === ')' && out.parens > 0) out.parens--;
      i++;
    }
  }
  return out;
}

/**
 * True when `sql` ends inside an unterminated string literal, quoted
 * identifier, or comment — the caret is in free text, not SQL.
 */
export function endsInsideLiteral(sql: string): boolean {
  const u = unclosedAt(sql);
  return u.quote !== undefined || u.comment !== undefined;
}

/**
 * Classify the caret position. `before` = document (or current statement)
 * text up to the caret, NOT yet blanked.
 */
export function classifyContext(before: string): SqlContext {
  // Inside a string/comment? No SQL hinting there — callers must offer
  // nothing at all (a popped completion would insert code into the literal).
  if (endsInsideLiteral(before)) return { kind: 'literal' };

  const s = blank(before);

  const stmt = s.slice(s.lastIndexOf(';') + 1);
  if (/^\s*$/.test(stmt)) return { kind: 'statement-start' };

  const ins = INSERT_COLS_RE.exec(stmt);
  if (ins) return { kind: 'insert-cols', insertTable: cleanIdent(ins[1]) };

  if (USE_RE.test(stmt)) return { kind: 'use-db' };
  if (CALL_RE.test(stmt)) return { kind: 'call-proc' };

  const on = ON_RE.exec(stmt);
  if (on) {
    const table = cleanIdent(on[1]);
    const alias = on[2] ? cleanIdent(on[2]) : table.split('.').pop()!;
    return { kind: 'on-clause', joinTarget: { table, alias } };
  }

  if (JOIN_RE.test(stmt)) return { kind: 'join-table' };
  if (TABLE_CLAUSE_RE.test(stmt)) return { kind: 'table-clause' };
  if (COLUMN_RE.test(stmt)) return { kind: 'column' };

  return { kind: 'generic' };
}

/**
 * Everything the editor needs to know about an INSERT the caret sits inside.
 *
 * `INSERT INTO shop.orders (id, state) VALUES (1, |)` →
 *   `{ table: 'shop.orders', columns: ['id','state'], index: 1, where: 'values' }`
 *
 * `where` says which part the caret is in:
 *   'target'  after `INTO ` — the table is being chosen
 *   'cols'    inside the `( … )` column list
 *   'values'  inside a `VALUES ( … )` tuple  (`index` = which value)
 *   'set'     after MySQL's `SET` / `ON DUPLICATE KEY UPDATE`
 */
export interface InsertContext {
  table: string;
  columns: string[] | null;
  index: number;
  where: 'target' | 'cols' | 'values' | 'set' | 'after-target';
}

const INSERT_HEAD_RE =
  /\b(?:insert|replace)\s+(?:low_priority\s+|high_priority\s+|delayed\s+|ignore\s+)*into\s+([\w`"$.]+)([\s\S]*)$/i;

export function insertContext(before: string): InsertContext | null {
  const s = blank(before);
  const stmt = s.slice(s.lastIndexOf(';') + 1);
  const m = INSERT_HEAD_RE.exec(stmt);
  if (!m) return null;
  const table = cleanIdent(m[1]);
  const rest = m[2];

  // Still typing the table name itself: the head regex consumes every name
  // character, so an EMPTY rest means the caret is right after the name with no
  // separator yet. A trailing space falls through to 'after-target' below.
  if (rest === '') {
    return { table, columns: null, index: 0, where: 'target' };
  }

  // MySQL's `SET col = …` form, and ON DUPLICATE KEY UPDATE
  if (/\b(?:set|update)\b[^()]*$/i.test(rest)) {
    return { table, columns: null, index: 0, where: 'set' };
  }

  // explicit column list, if one is present (and closed)
  const colList = /\(([^()]*)\)/.exec(rest);
  const beforeValues = /\bvalues?\b/i.exec(rest);
  const columns = colList && (!beforeValues || colList.index < beforeValues.index)
    ? colList[1].split(',').map(c => cleanIdent(c.trim())).filter(Boolean)
    : null;

  // inside an OPEN paren? then count top-level commas since it opened
  const open = lastOpenParen(rest);
  if (open >= 0) {
    const inner = rest.slice(open + 1);
    const index = countTopLevelCommas(inner);
    const inValues = !!beforeValues && beforeValues.index < open;
    return { table, columns, index, where: inValues ? 'values' : 'cols' };
  }

  if (beforeValues) return { table, columns, index: 0, where: 'values' };
  return { table, columns, index: 0, where: 'after-target' };
}

/** Offset of the innermost unclosed '(' in `s`, or -1. */
function lastOpenParen(s: string): number {
  const stack: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') stack.push(i);
    else if (s[i] === ')') stack.pop();
  }
  return stack.length ? stack[stack.length - 1] : -1;
}

function countTopLevelCommas(s: string): number {
  let depth = 0, n = 0;
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

// ── CTE & derived-table column discovery ──────────────────────────────────────

export interface VirtualTable {
  name: string;
  columns: string[];
  kind: 'cte' | 'subquery';
}

/** A raw top-level select-list entry, with its span inside the SELECT body. */
export interface SelectEntry { raw: string; from: number; to: number }

/** Keywords that can only ever come AFTER the select list (top level). */
const SELECT_LIST_END_RE =
  /^(?:from|where|group\s+by|order\s+by|having|limit|offset|union|window|fetch|for)\b/i;

/**
 * The raw top-level select-list entries of a SELECT body (already blanked by
 * the caller, so strings/comments are spaces and offsets are preserved).
 *
 * The list ends at the top-level FROM — or, when there is none, at the first
 * clause keyword that can only follow it (`SELECT a, b ORDER BY …` must not
 * smear the ORDER BY into the last entry). `hasStar` marks a `*` / `alias.*`
 * entry: the text then says nothing about the real column count, and consumers
 * that count columns (ordinal checks) must stay quiet. Returns null when the
 * body is not a plain SELECT.
 */
export function selectListEntries(body: string): { entries: SelectEntry[]; hasStar: boolean } | null {
  const m = /^\s*select\s+(?:distinct\s+)?/i.exec(body);
  if (!m) return null;
  const restStart = m[0].length;
  const rest = body.slice(restStart);

  // find the end of the select list
  let depth = 0;
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) { end = i; break; } depth--; }
    else if (depth === 0 && /[\s()]/.test(rest[i - 1] ?? ' ') && SELECT_LIST_END_RE.test(rest.slice(i))) {
      end = i;
      break;
    }
  }

  // split top-level commas, keeping offsets into `body`
  const entries: SelectEntry[] = [];
  let hasStar = false;
  depth = 0;
  let start = 0;
  for (let i = 0; i <= end; i++) {
    const c = rest[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if ((c === ',' && depth === 0) || i === end) {
      const raw = rest.slice(start, i);
      const lead = /^\s*/.exec(raw)?.[0].length ?? 0;
      const trimmed = raw.trim();
      entries.push({ raw: trimmed, from: restStart + start + lead, to: restStart + start + lead + trimmed.length });
      if (trimmed.endsWith('*')) hasStar = true; // `*` or `alias.*`
      start = i + 1;
    }
  }
  return { entries, hasStar };
}

/**
 * Best-effort projected-column extraction from a SELECT body: the top-level
 * select list up to FROM, one name per entry — trailing `AS alias` wins, else
 * the last dotted identifier; `*` and unaliased expressions are skipped.
 */
export function selectListColumns(body: string): string[] {
  const parsed = selectListEntries(body);
  if (!parsed) return [];
  const cols: string[] = [];
  for (const { raw } of parsed.entries) {
    const e = raw.trim();
    if (!e || e === '*' || e.endsWith('*')) continue;
    const alias = /\bas\s+([A-Za-z_][\w$]*)\s*$/i.exec(e)
      ?? /^[\w`"$.()\s]*\s([A-Za-z_][\w$]*)\s*$/.exec(e); // implicit alias after an expression
    if (alias && !/^(asc|desc|from)$/i.test(alias[1])) {
      cols.push(cleanIdent(alias[1]));
      continue;
    }
    const simple = /^([A-Za-z_][\w$]*\.)*([A-Za-z_`"][\w`"$]*)$/.exec(e);
    if (simple) cols.push(cleanIdent(simple[2]));
  }
  return cols;
}

/** Body of the parenthesized group opening at `open` (index of '('). */
function parenBody(s: string, open: number): { body: string; close: number } | null {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return { body: s.slice(open + 1, i), close: i };
    }
  }
  return null;
}

/**
 * CTEs (`WITH [RECURSIVE] name [(cols)] AS (select…)`) and aliased derived
 * tables (`(SELECT …) [AS] x`), with their projected columns.
 */
export function findVirtualTables(sql: string): Map<string, VirtualTable> {
  const out = new Map<string, VirtualTable>();
  const s = blank(sql);

  // CTE chains
  const withRe = /\bwith\s+(?:recursive\s+)?/gi;
  let wm: RegExpExecArray | null;
  while ((wm = withRe.exec(s)) !== null) {
    let i = wm.index + wm[0].length;
    // entries: name [(col,…)] AS ( … ) separated by top-level commas
    for (;;) {
      const head = /^\s*([A-Za-z_`"][\w`"$]*)\s*(\(([^)]*)\))?\s*as\s*\(/i.exec(s.slice(i));
      if (!head) break;
      const name = cleanIdent(head[1]);
      const open = i + head[0].length - 1;
      const paren = parenBody(s, open);
      if (!paren) break;
      const columns = head[3]
        ? head[3].split(',').map(c => cleanIdent(c.trim())).filter(Boolean)
        : selectListColumns(paren.body);
      out.set(name.toLowerCase(), { name, columns, kind: 'cte' });
      // continue past ") ,"
      const after = /^\s*,/.exec(s.slice(paren.close + 1));
      if (!after) break;
      i = paren.close + 1 + after[0].length;
    }
  }

  // derived tables: "( select … ) [AS] alias"
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '(') continue;
    const paren = parenBody(s, i);
    if (!paren) continue;
    if (!/^\s*select\b/i.test(paren.body)) continue;
    const am = /^\s*(?:as\s+)?([A-Za-z_][\w$]*)/i.exec(s.slice(paren.close + 1));
    if (am && !/^(on|where|group|order|having|limit|join|left|right|inner|outer|cross|union|as|and|or|not|then|else|end|when|in|from|select|set|values)$/i.test(am[1])) {
      const name = am[1];
      if (!out.has(name.toLowerCase())) {
        out.set(name.toLowerCase(), {
          name,
          columns: selectListColumns(paren.body),
          kind: 'subquery',
        });
      }
    }
    i = paren.close; // skip past this group (nested ones were parsed by recursion via loop anyway)
  }

  return out;
}

/**
 * Deterministic alias suggestion for a table name: initials of the
 * underscore-split words (order_items → oi), avoiding collisions with `taken`
 * by appending 2, 3, …
 */
export function suggestAlias(table: string, taken: Set<string>): string {
  const bare = table.split('.').pop() ?? table;
  const base = bare.split(/[_\W]+/).filter(Boolean).map(w => w[0].toLowerCase()).join('')
    || bare.slice(0, 1).toLowerCase() || 't';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const cand = `${base}${n}`;
    if (!taken.has(cand)) return cand;
  }
}
