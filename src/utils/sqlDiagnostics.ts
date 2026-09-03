/**
 * Live diagnostics — the squiggles under your SQL while you type.
 *
 * Every check is **offset-precise** (so the editor can underline the exact
 * token) and **quiet when it cannot be sure**: schema checks only fire for
 * tables whose metadata is already cached, because a false "unknown column" on
 * a big schema is worse than no check at all. Nothing here talks to a database
 * — the caller passes what it knows.
 *
 * Rules, roughly in the order a DBA cares about them:
 *   errors    unknown table · unknown column · `= NULL` · unbalanced quotes/parens
 *             · comma before FROM · GROUP/ORDER BY ordinal past the select list
 *   warnings  UPDATE/DELETE with no WHERE · JOIN with no ON · ambiguous column
 *             · WHERE on a column no index starts with · unqualified write with
 *             no default database · select-list column neither aggregated nor
 *             in GROUP BY (PostgreSQL and SQL Server always; MySQL under
 *             ONLY_FULL_GROUP_BY)
 *   info      `SELECT *` in a joined query · SELECT with no LIMIT
 */
import type { Engine } from '../types';
import { blank, findAliases } from './sqlAlias.ts';
import { backslashEscapesStrings } from './sqlIdent.ts';
import { selectListEntries } from './sqlContext.ts';
import { splitStatements } from './sqlSplit.ts';

export type DiagSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  from: number;
  to: number;
  severity: DiagSeverity;
  /** stable short code, shown in the tooltip and usable for muting later */
  code: string;
  message: string;
}

export interface DiagContext {
  /** lower-cased known object names (bare AND `schema.name`) */
  objects: Set<string>;
  /** table as written (lower-cased) → its column names, lower-cased */
  columns: Map<string, Set<string>>;
  /**
   * table (lower-cased) → columns that some index STARTS with (plus the PK).
   * A predicate on anything else cannot use an index for a lookup.
   */
  indexed: Map<string, Set<string>>;
  /** a default database/schema is selected in the toolbar */
  hasDefaultDb: boolean;
  /** names that are CTEs or derived tables in this document — never "unknown" */
  virtual: Set<string>;
  /**
   * Which engine the buffer runs against — gates the dialect-sensitive checks
   * (the not-in-GROUP-BY warning fires only where the server actually enforces
   * it). Optional: when absent, only dialect-neutral checks run — a check that
   * cannot know the dialect stays quiet, never guesses.
   */
  engine?: Engine;
}

export const emptyDiagContext = (): DiagContext => ({
  objects: new Set(), columns: new Map(), indexed: new Map(),
  hasDefaultDb: true, virtual: new Set(),
});

const CLAUSE_END = /\b(where|group\s+by|having|order\s+by|limit|union|into|set|values|returning|on|using|join|left|right|inner|cross|outer|straight_join)\b/i;

/**
 * Catalog schemas are deliberately NOT in the object sweep (they would drown
 * it), so a reference into one must never be reported as unknown — DBAs query
 * them constantly.
 */
const SYSTEM_SCHEMAS = new Set([
  'information_schema', 'performance_schema', 'mysql', 'sys',
  'pg_catalog', 'pg_toast', 'pg_temp', 'pg_temp_1',
]);

/**
 * Tables the DOCUMENT itself creates (`CREATE [TEMPORARY] TABLE x …`). They are
 * not in the catalog yet, and flagging your own migration script as broken is
 * exactly the kind of false alarm that makes people turn diagnostics off.
 */
export function createdTables(doc: string): Set<string> {
  const out = new Set<string>();
  const b = blank(doc);
  for (const m of b.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:global\s+|local\s+)?(?:temporary\s+|temp\s+|unlogged\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?([\w$.]+)/gi)) {
    const name = m[1].toLowerCase();
    out.add(name);
    const short = name.split('.').pop();
    if (short) out.add(short);
  }
  return out;
}

/** Strip quoting so a name can be compared with catalog data. */
const plain = (s: string) => s.replace(/[`"]/g, '').toLowerCase();

/**
 * All diagnostics for a document, statement by statement.
 *
 * `delimiter` matches the editor's configured terminator so the squiggles land
 * on the same statement boundaries the runner will use.
 */
export function diagnose(doc: string, ctx: DiagContext, delimiter = ';', engine?: Engine): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Whatever this buffer creates counts as known for the rest of the buffer.
  const withCreated: DiagContext = {
    ...ctx,
    virtual: new Set([...ctx.virtual, ...createdTables(doc)]),
  };
  const diagEngine = engine ?? ctx.engine;
  for (const stmt of splitStatements(doc, delimiter)) {
    if (!stmt.text.trim()) continue;
    diagnoseStatement(stmt.from, stmt.text, withCreated, out, diagEngine);
  }
  return out.sort((a, b) => a.from - b.from);
}

function diagnoseStatement(
  base: number, text: string, ctx: DiagContext, out: Diagnostic[], engine?: Engine,
): void {
  // Blanked copy: string/comment contents replaced by spaces, offsets preserved,
  // so every regex below matches only real SQL and the offsets stay usable.
  // Engine-aware: PG's `SELECT 'C:\';` must not squiggle as unterminated.
  const b = blank(text, engine);
  const lower = b.toLowerCase();
  const push = (from: number, to: number, severity: DiagSeverity, code: string, message: string) =>
    out.push({ from: base + from, to: base + Math.max(to, from + 1), severity, code, message });

  const kind = /^\s*(select|insert|update|delete|replace|with|create|alter|drop|truncate|call|show|explain|describe|use|set|begin|commit|rollback|grant|revoke|kill|analyze|optimize)\b/i
    .exec(b)?.[1]?.toLowerCase() ?? '';

  // ── unbalanced parentheses / quotes ────────────────────────────────────────
  const unterminated = findUnterminatedQuote(text, engine);
  if (unterminated >= 0) {
    push(unterminated, unterminated + 1, 'error', 'unterminated-string',
      'Unterminated string literal — everything after this is part of the string.');
  }
  const paren = findUnbalancedParen(b);
  if (paren >= 0) {
    push(paren, paren + 1, 'error', 'unbalanced-paren',
      b[paren] === '(' ? 'This “(” is never closed.' : 'This “)” closes nothing.');
  }

  // ── `= NULL` / `<> NULL` ──────────────────────────────────────────────────
  for (const m of lower.matchAll(/(!=|<>|=)\s*null\b/g)) {
    push(m.index!, m.index! + m[0].length, 'error', 'eq-null',
      `\`${m[0].trim()}\` is never true in SQL — use IS NULL / IS NOT NULL.`);
  }

  // ── comma directly before FROM (a deleted column leaves one behind) ───────
  for (const m of lower.matchAll(/,\s*\bfrom\b/g)) {
    push(m.index!, m.index! + 1, 'error', 'comma-before-from',
      'Trailing comma in the select list.');
  }

  // ── GROUP BY / ORDER BY smarts ────────────────────────────────────────────
  // Both checks share one parse of the select list (utils/sqlContext), and both
  // stay quiet when the text cannot prove the count: a `*` entry (the real
  // count lives in the catalog), a subquery anywhere (whose SELECT does this
  // GROUP BY belong to?), a UNION, or GROUPING SETS/ROLLUP/CUBE.
  if (kind === 'select' && engine !== 'redis'
      && !/\(\s*select\b/i.test(b) && !/\bunion\b/i.test(lower)
      && !/\b(rollup|cube|grouping\s+sets)\b/i.test(lower)) {
    const parsed = selectListEntries(b);
    if (parsed && !parsed.hasStar && parsed.entries.some(e => e.raw.trim())) {
      const clauses = groupOrderClauses(b);

      // ordinal out of range — an error on every engine that allows ordinals
      for (const clause of clauses) {
        for (const item of clause.items) {
          const n = ordinalOf(item.raw);
          if (n === null || (n >= 1 && n <= parsed.entries.length)) continue;
          push(item.from, item.to, 'error', 'ordinal-out-of-range',
            `${clause.keyword === 'group' ? 'GROUP BY' : 'ORDER BY'} ${n} — the select list has only ${parsed.entries.length} column${parsed.entries.length === 1 ? '' : 's'}.`);
        }
      }

      // select-list column neither aggregated nor in GROUP BY. Only where the
      // server enforces it: PostgreSQL and SQL Server always (Msg 8120 there),
      // MySQL under ONLY_FULL_GROUP_BY
      // (default since 8.0, common on MariaDB) — a warning fits both. SQLite /
      // ClickHouse / DuckDB are permissive by design; an unknown engine gets no
      // opinion at all (a false positive here is worse than none).
      // SQL Server enforces this as strictly as PostgreSQL does — a
      // non-aggregated column outside GROUP BY is Msg 8120, an error rather
      // than a permissive default. Leaving it out meant the one engine that
      // will certainly reject the query got no warning about it.
      const group = clauses.find(c => c.keyword === 'group');
      if (group && (engine === 'postgres' || engine === 'mysql' || engine === 'sqlserver')) {
        const groupedNames = new Set<string>();
        const groupedIdx = new Set<number>();
        for (const item of group.items) {
          const t = item.raw.replace(/\s+(asc|desc)$/i, '').trim();
          const ordinal = /^\d+$/.test(t) ? +t : null;
          if (ordinal !== null) {
            if (ordinal >= 1 && ordinal <= parsed.entries.length) groupedIdx.add(ordinal - 1);
            continue;
          }
          if (t.includes('(')) continue;   // expression — membership unprovable from text
          const name = plain(t);
          groupedNames.add(name);
          const bareName = name.split('.').pop();
          if (bareName) groupedNames.add(bareName);   // GROUP BY o.state covers SELECT state
        }
        for (let i = 0; i < parsed.entries.length; i++) {
          if (groupedIdx.has(i)) continue;
          const e = parsed.entries[i].raw.trim();
          // anything with parens — aggregates (COUNT(*)) and expressions alike —
          // gets no opinion; neither do literals and NULL
          if (!e || e.includes('(') || /^(null|true|false)$/i.test(e)) continue;
          const col = /^((?:[A-Za-z_][\w$]*\.)*[A-Za-z_`"][\w`"$]*)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?$/.exec(e);
          if (!col) continue;              // not a plain column reference — uncertain
          const name = plain(col[1]);
          const bareName = name.split('.').pop() ?? name;
          const alias = col[2]?.toLowerCase();
          if (groupedNames.has(name) || groupedNames.has(bareName)
              || (alias && groupedNames.has(alias))) continue;
          // The REASON differs even where the verdict does not: MySQL rejects
          // it under a sql_mode that can be turned off, while PostgreSQL and
          // SQL Server always do. Quoting ONLY_FULL_GROUP_BY at a SQL Server
          // user sends them looking for a setting that does not exist.
          push(parsed.entries[i].from, parsed.entries[i].to, 'warning', 'not-in-group-by',
            engine === 'postgres'
              ? `“${col[1]}” is neither aggregated nor in GROUP BY — PostgreSQL rejects this.`
              : engine === 'sqlserver'
              ? `“${col[1]}” is neither aggregated nor in GROUP BY — SQL Server rejects this (Msg 8120).`
              : `“${col[1]}” is neither aggregated nor in GROUP BY — rejected under ONLY_FULL_GROUP_BY (default since MySQL 8.0).`);
        }
      }
    }
  }

  const aliases = findAliases(text);
  const scope = [...new Set([...aliases.values()])];

  // ── unknown tables ────────────────────────────────────────────────────────
  if (ctx.objects.size > 0) {
    for (const ref of tableRefs(b)) {
      const name = plain(ref.name);
      const parts = name.split('.');
      const bare = parts.pop() ?? name;
      // Catalog schemas are not swept, so never call them unknown.
      if (parts.length > 0 && SYSTEM_SCHEMAS.has(parts[parts.length - 1])) continue;
      if (ctx.virtual.has(bare) || ctx.virtual.has(name)) continue;
      if (ctx.objects.has(name) || ctx.objects.has(bare)) continue;
      push(ref.from, ref.to, 'error', 'unknown-table',
        `No table or view called “${ref.name}” in the loaded schema.`);
    }
  }

  // ── qualified columns: alias.column ───────────────────────────────────────
  for (const m of b.matchAll(/\b([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)\b/g)) {
    const [, qual, col] = m;
    const table = aliases.get(qual.toLowerCase());
    if (!table) continue;                                   // not an alias in scope
    const cols = ctx.columns.get(plain(table));
    if (!cols || cols.size === 0) continue;                  // not cached → stay quiet
    if (cols.has(col.toLowerCase())) continue;
    const from = m.index! + qual.length + 1;
    push(from, from + col.length, 'error', 'unknown-column',
      `“${col}” is not a column of ${table}.`);
  }

  // ── ambiguous unqualified columns ─────────────────────────────────────────
  if (scope.length > 1) {
    const known = scope
      .map(t => ({ t, cols: ctx.columns.get(plain(t)) }))
      .filter((x): x is { t: string; cols: Set<string> } => !!x.cols && x.cols.size > 0);
    if (known.length > 1) {
      const seen = new Set<string>();
      for (const m of b.matchAll(/(^|[\s,(=<>+\-*/])([A-Za-z_][\w$]*)(?=[\s,)=<>+\-*/]|$)/g)) {
        const word = m[2];
        const lw = word.toLowerCase();
        if (seen.has(lw) || RESERVED_WORDS.has(lw)) continue;
        const owners = known.filter(k => k.cols.has(lw));
        if (owners.length < 2) continue;
        seen.add(lw);
        const from = m.index! + m[1].length;
        push(from, from + word.length, 'warning', 'ambiguous-column',
          `“${word}” exists in ${owners.map(o => o.t).join(' and ')} — qualify it.`);
      }
    }
  }

  // ── JOIN without ON / USING ───────────────────────────────────────────────
  for (const m of lower.matchAll(/\b((?:left|right|inner|full|cross)\s+)?join\b/g)) {
    if (/^cross\s+$/.test(m[1] ?? '')) continue;             // CROSS JOIN is explicit
    const rest = lower.slice(m.index! + m[0].length);
    const next = /\b(on|using)\b/.exec(rest);
    const nextJoin = /\bjoin\b/.exec(rest);
    if (!next || (nextJoin && nextJoin.index < next.index)) {
      push(m.index!, m.index! + m[0].length, 'warning', 'join-without-on',
        'JOIN with no ON/USING — this is a cartesian product.');
    }
  }

  // ── writes ────────────────────────────────────────────────────────────────
  if (kind === 'update' || kind === 'delete') {
    if (!/\bwhere\b/.test(lower)) {
      const m = new RegExp(`\\b${kind}\\b`, 'i').exec(b);
      push(m?.index ?? 0, (m?.index ?? 0) + kind.length, 'warning', 'write-without-where',
        `${kind.toUpperCase()} with no WHERE — every row in the table is affected.`);
    }
  }
  if (!ctx.hasDefaultDb && ['insert', 'update', 'delete', 'replace', 'truncate'].includes(kind)) {
    for (const ref of tableRefs(b)) {
      if (ref.name.includes('.')) continue;
      push(ref.from, ref.to, 'warning', 'unqualified-write',
        `No default database is selected — “${ref.name}” may resolve somewhere you do not expect. Qualify it, or pick a database.`);
      break;
    }
  }

  // ── index hints on WHERE predicates ───────────────────────────────────────
  if (ctx.indexed.size > 0) {
    for (const p of wherePredicates(b)) {
      const table = p.qualifier ? aliases.get(p.qualifier.toLowerCase()) : scope[0];
      if (!table) continue;
      const idx = ctx.indexed.get(plain(table));
      const cols = ctx.columns.get(plain(table));
      if (!idx || !cols || !cols.has(p.column.toLowerCase())) continue;
      if (idx.has(p.column.toLowerCase())) continue;
      push(p.from, p.from + p.column.length, 'warning', 'no-index',
        `No index starts with ${table}.${p.column} — this predicate cannot use one.`);
    }
  }

  // ── informational ─────────────────────────────────────────────────────────
  if (kind === 'select') {
    const star = /\bselect\s+(distinct\s+)?\*/i.exec(b);
    if (star && scope.length > 1) {
      const at = star.index + star[0].length - 1;
      push(at, at + 1, 'info', 'select-star-join',
        'SELECT * across joined tables ships duplicate key columns — list what you need.');
    }
    // Only when there is no WHERE either: a filtered SELECT without LIMIT is
    // ordinary, and squiggling every exploratory query trains people to ignore
    // the squiggles.
    if (!/\blimit\b/.test(lower) && !/\bwhere\b/.test(lower)
        && !/\bcount\s*\(/.test(lower) && !/\bgroup\s+by\b/.test(lower)) {
      const m = /\bselect\b/i.exec(b);
      push(m?.index ?? 0, (m?.index ?? 0) + 6, 'info', 'full-scan',
        'No WHERE and no LIMIT — this reads the whole table.');
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** A top-level GROUP BY / ORDER BY clause, with its comma-separated items. */
interface GroupOrderClause {
  keyword: 'group' | 'order';
  items: { raw: string; from: number; to: number }[];
}

/** The integer an ORDER/GROUP BY item refers to, or null when it isn't a bare ordinal. */
function ordinalOf(raw: string): number | null {
  const t = raw.replace(/\s+(asc|desc)(\s+nulls\s+(first|last))?$/i, '').trim();
  return /^\d+$/.test(t) ? parseInt(t, 10) : null;
}

/** Keywords that terminate a GROUP/ORDER BY item list (top level). */
const CLAUSE_ITEMS_END_RE = /^(having|order\s+by|limit|offset|union|window|fetch|for)\b/i;

/**
 * The top-level GROUP BY / ORDER BY clauses of a (blanked) statement, each
 * with its items and their offsets. Window-function ORDER BYs live inside
 * `OVER (…)` — depth > 0 — and never match here, which is correct: ordinals
 * in a window's ORDER BY mean something else entirely.
 */
function groupOrderClauses(b: string): GroupOrderClause[] {
  const out: GroupOrderClause[] = [];
  const wordStart = (i: number) => i === 0 || !/[\w$]/.test(b[i - 1]);
  const starts = /^(group\s+by|order\s+by)\b/i;
  let depth = 0;
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth--; i++; continue; }
    const kw = depth === 0 && wordStart(i) ? starts.exec(b.slice(i)) : null;
    if (!kw) { i++; continue; }
    const keyword = kw[1].toLowerCase().startsWith('group') ? 'group' as const : 'order' as const;
    const regionStart = i + kw[1].length;

    // region end: the next top-level clause keyword, an unmatched ')', or EOS
    let d = 0;
    let regionEnd = b.length;
    for (let j = regionStart; j < b.length; j++) {
      const cj = b[j];
      if (cj === '(') d++;
      else if (cj === ')') { if (d === 0) { regionEnd = j; break; } d--; }
      else if (d === 0 && wordStart(j) && CLAUSE_ITEMS_END_RE.test(b.slice(j))) { regionEnd = j; break; }
    }

    // split the region into top-level comma items, keeping offsets
    const items: GroupOrderClause['items'] = [];
    d = 0;
    let s = regionStart;
    for (let k = regionStart; k <= regionEnd; k++) {
      const ck = b[k];
      if (ck === '(') d++;
      else if (ck === ')') d--;
      if ((ck === ',' && d === 0) || k === regionEnd) {
        const raw = b.slice(s, k);
        const lead = /^\s*/.exec(raw)?.[0].length ?? 0;
        const trimmed = raw.trim();
        if (trimmed) items.push({ raw: trimmed, from: s + lead, to: s + lead + trimmed.length });
        s = k + 1;
      }
    }
    out.push({ keyword, items });
    i = regionEnd;
  }
  return out;
}

/** Words that look like columns but are not, for the ambiguity scan. */
const RESERVED_WORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in', 'as', 'on', 'using',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'group', 'by', 'order',
  'having', 'limit', 'offset', 'union', 'all', 'distinct', 'case', 'when', 'then', 'else',
  'end', 'like', 'between', 'exists', 'count', 'sum', 'avg', 'min', 'max', 'asc', 'desc',
  'update', 'set', 'delete', 'insert', 'into', 'values', 'true', 'false', 'with', 'if',
]);

export interface TableRef { name: string; from: number; to: number }

/** Table references of a (blanked) statement: FROM/JOIN/UPDATE/INTO targets. */
export function tableRefs(b: string): TableRef[] {
  const out: TableRef[] = [];
  const re = /\b(from|join|update|into|truncate\s+table|truncate)\s+([`"\w$.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(b))) {
    const name = m[2];
    if (!name || name === '(') continue;
    if (/^\d/.test(name)) continue;
    const from = m.index + m[0].length - name.length;
    out.push({ name, from, to: from + name.length });
  }
  return out;
}

export interface Predicate { column: string; qualifier?: string; from: number }

/** Equality/range predicates in the WHERE clause of a (blanked) statement. */
export function wherePredicates(b: string): Predicate[] {
  const w = /\bwhere\b/i.exec(b);
  if (!w) return [];
  const start = w.index + w[0].length;
  const tail = b.slice(start);
  const stop = CLAUSE_END.exec(tail.replace(/\bon\b|\busing\b/gi, '   '));
  const region = tail.slice(0, stop ? stop.index : tail.length);
  const out: Predicate[] = [];
  const re = /(?:\b([A-Za-z_][\w$]*)\s*\.\s*)?\b([A-Za-z_][\w$]*)\s*(?:=|>|<|>=|<=|<>|!=|\blike\b|\bbetween\b|\bin\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    const col = m[2];
    if (RESERVED_WORDS.has(col.toLowerCase())) continue;
    const colStart = m.index + m[0].indexOf(col, m[1] ? m[1].length : 0);
    out.push({ column: col, qualifier: m[1], from: start + colStart });
  }
  return out;
}

/** Offset of an unterminated string quote, or -1. Operates on the RAW text. */
export function findUnterminatedQuote(text: string, engine?: string): number {
  // Backslash escapes are a dialect property (WP-08 8.7): honored in
  // MySQL-family string literals and PG `E'…'` strings, never inside
  // backtick-quoted identifiers, and not at all on plain-PG/SQLite strings —
  // `SELECT 'C:\';` is a complete statement there, not an unterminated one.
  const bsInStrings = backslashEscapesStrings(engine);
  let i = 0, open = -1, q = '', bs = false;
  while (i < text.length) {
    const c = text[i];
    if (open >= 0) {
      if (bs && c === '\\') { i += 2; continue; }
      if (c === q) {
        if (text[i + 1] === q) { i += 2; continue; }   // doubled = escaped
        open = -1; q = '';
      }
      i++;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') { const n = text.indexOf('\n', i); i = n < 0 ? text.length : n; continue; }
    if (c === '#') { const n = text.indexOf('\n', i); i = n < 0 ? text.length : n; continue; }
    if (c === '/' && text[i + 1] === '*') { const n = text.indexOf('*/', i); i = n < 0 ? text.length : n + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const eString = c === "'" && i > 0 && (text[i - 1] === 'E' || text[i - 1] === 'e')
        && (i < 2 || !/[\w$]/.test(text[i - 2]));
      bs = c !== '`' && (bsInStrings || eString);
      open = i; q = c; i++; continue;
    }
    i++;
  }
  return open;
}

/** Offset of the first unbalanced parenthesis in blanked text, or -1. */
export function findUnbalancedParen(b: string): number {
  const stack: number[] = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] === '(') stack.push(i);
    else if (b[i] === ')') {
      if (stack.length === 0) return i;
      stack.pop();
    }
  }
  return stack.length ? stack[0] : -1;
}
