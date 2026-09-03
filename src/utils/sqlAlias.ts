/**
 * Alias resolution for editor completion: parse FROM / JOIN clauses into an
 * alias → table map so `alias.` completes that table's columns.
 * Pragmatic parser (not a grammar): strings and comments are blanked first,
 * FROM comma-lists and JOINs are handled, subquery aliases are skipped.
 */

import { backslashEscapesStrings } from './sqlIdent.ts';

// `;` is a terminator too: without it every FROM's segment scan ran to the
// end of the document — O(#FROMs × docLength) on the per-keystroke completion
// path — and leaked the next statement's tokens into this FROM's entries.
const CLAUSE_END = /\b(where|group|order|having|limit|offset|union|window|on|using|join|left|right|inner|outer|cross|natural|straight_join|set|values|returning)\b|;/i;

const NOT_ALIAS = new Set([
  'on', 'where', 'group', 'order', 'having', 'limit', 'offset', 'union',
  'join', 'left', 'right', 'inner', 'outer', 'cross', 'natural', 'as',
  'using', 'set', 'values', 'window', 'for', 'into', 'straight_join',
  'lateral', 'returning', 'and', 'or', 'not',
]);

/**
 * Blank out strings and comments (preserving length so offsets survive).
 *
 * Engine-aware where the dialects disagree (WP-08 8.7): a backslash is a
 * string escape on MySQL/MariaDB/ClickHouse (and inside PG `E'…'` strings),
 * but plain data on PostgreSQL/SQLite/DuckDB/T-SQL — and NEVER an escape
 * inside a backtick-quoted identifier on any engine. Callers that know the
 * engine pass it; the default keeps the historical MySQL behavior.
 */
export function blank(sql: string, engine?: string): string {
  const bsInStrings = backslashEscapesStrings(engine);
  let out = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      out += ' '.repeat(end - i);
      i = end;
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      out += ' '.repeat(end - i);
      i = end;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      // PG E'…' strings take backslash escapes even with
      // standard_conforming_strings on.
      const eString = q === "'" && i > 0 && (sql[i - 1] === 'E' || sql[i - 1] === 'e')
        && (i < 2 || !/[\w$]/.test(sql[i - 2]));
      const bs = q !== '`' && (bsInStrings || eString);
      let j = i + 1;
      while (j < n) {
        if (bs && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === q) { j++; break; }
        j++;
      }
      // keep the quote chars so `ident` parsing still sees boundaries
      out += q + ' '.repeat(Math.max(0, j - i - 2)) + (j <= n ? q : '');
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function cleanIdent(raw: string): string {
  return raw.replace(/[`"]/g, '');
}

/** Parse one "table [AS] alias" entry; returns null for subqueries/functions. */
function parseEntry(entry: string, map: Map<string, string>) {
  const t = entry.trim();
  if (!t || t.startsWith('(')) return; // subquery / function — skip
  const m = /^([A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/i.exec(cleanIdent(t));
  if (!m) return;
  const table = m[1].replace(/\s/g, '');
  const alias = m[2];
  if (alias && !NOT_ALIAS.has(alias.toLowerCase())) {
    map.set(alias.toLowerCase(), table);
  }
  // The table's own bare name also resolves (orders. → db.orders columns)
  const bare = table.includes('.') ? table.split('.').pop()! : table;
  if (!map.has(bare.toLowerCase())) map.set(bare.toLowerCase(), table);
}

/** alias (lowercased) → table name as written in the SQL. */
export function findAliases(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const s = blank(sql);

  // FROM clause: take the segment up to the next clause keyword, split on commas
  const fromRe = /\bfrom\s+/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fromRe.exec(s)) !== null) {
    const rest = s.slice(fm.index + fm[0].length);
    const end = rest.search(CLAUSE_END);
    const segment = end === -1 ? rest : rest.slice(0, end);
    // split top-level commas only (ignore commas inside parens)
    let depth = 0, start = 0;
    const entries: string[] = [];
    for (let i = 0; i <= segment.length; i++) {
      const c = segment[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if ((c === ',' && depth === 0) || i === segment.length) {
        entries.push(segment.slice(start, i));
        start = i + 1;
      }
    }
    for (const e of entries) parseEntry(e, map);
  }

  // JOIN targets
  const joinRe = /\bjoin\s+([^\s,;()]+(?:\s+(?:as\s+)?[A-Za-z_][\w$]*)?)/gi;
  let jm: RegExpExecArray | null;
  while ((jm = joinRe.exec(s)) !== null) {
    parseEntry(jm[1], map);
  }

  // UPDATE t [AS] a / INSERT INTO t / DELETE FROM handled by fromRe already
  const updRe = /\bupdate\s+([^\s,;()]+(?:\s+(?:as\s+)?[A-Za-z_][\w$]*)?)/gi;
  let um: RegExpExecArray | null;
  while ((um = updRe.exec(s)) !== null) {
    parseEntry(um[1], map);
  }

  return map;
}
