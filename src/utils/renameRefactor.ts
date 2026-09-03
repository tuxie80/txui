/**
 * Rename refactoring — renaming the TEXT of a table, column, alias or CTE name
 * across one editor buffer, behind a correctness gate.
 *
 * The alias/CTE half of this already existed (renameSymbol.ts, statement-scoped).
 * This module extends the idea to whole-buffer table and column renames, which
 * is where a naive search-and-replace corrupts scripts: `id` exists in every
 * table, `orders` may be an alias for `customers` one statement below, and the
 * word inside a string literal is not a reference at all.
 *
 * ## The classification model — definite vs review
 *
 * Every occurrence of the name is classified before anything is rewritten:
 *
 * - **definite** — provably the same symbol:
 *   - table: the name in a table position (`FROM` / `JOIN` / `UPDATE` / `INTO`
 *     / `TABLE` …), the table part of `schema.name`, or the qualifier of
 *     `name.column` — in a statement where the name is NOT shadowed by an alias
 *     or CTE of the same word;
 *   - column: `q.name` where `q` provably binds to the same table (an alias
 *     defined in that statement, the table's own name, or the same textual
 *     qualifier), and bare `name` in a statement where every in-scope table's
 *     columns are known and exactly one of them has this column;
 *   - alias/CTE: whole-word occurrences inside the defining statement, never
 *     the column part of `x.name`.
 * - **review** — plausible but unprovable, NEVER rewritten silently:
 *   - occurrences inside string literals and comments (dynamic SQL lives
 *     there — `EXECUTE '… orders …'`),
 *   - bare column references where another in-scope table also has the column,
 *     or some in-scope table's columns were not loaded,
 *   - `q.name` where `q` resolves to nothing in that statement,
 *   - a table-name match outside a table position (maybe a column or alias),
 *   - the projection source of a CTE column (`SELECT u.id` projects CTE column
 *     `id` — renaming needs an `AS` there, not a rewrite),
 *   - anything about a symbol whose binding could not be resolved at the caret.
 * - **excluded** (not reported, not rewritten): provably a DIFFERENT object —
 *   the name shadowed by an alias or CTE in that statement, `other_alias.name`,
 *   a select-list output alias (`expr AS name` — a new name, not a reference),
 *   or a bare name no in-scope table provides.
 *
 * Rewriting preserves quoting: a quoted occurrence keeps its quote style, a
 * bare occurrence is quoted only when the new name needs it (sqlIdent).
 *
 * Scope honesty: this is BUFFER-LOCAL text refactoring. It never runs
 * `ALTER TABLE … RENAME` and never touches another buffer or file.
 *
 * Pure: no React/Tauri imports — `node --test` covers it.
 */
import { findAliases } from './sqlAlias.ts';
import { findVirtualTables, type VirtualTable } from './sqlContext.ts';
import { maskLiterals, TABLE_POSITION, type Engine as MaskEngine } from './findUsages.ts';
import { needsQuote, quoteIdent, RESERVED_WORDS } from './sqlIdent.ts';
import { splitStatements, type Statement } from './sqlSplit.ts';

export interface RenameSchemaTable {
  /** As written in the buffer or `schema.table`; matched by bare name. */
  name: string;
  columns: string[];
}

/** Table/column metadata the caller fetched. Missing tables mean `review`. */
export interface RenameSchema {
  tables: RenameSchemaTable[];
}

export type RenameKind = 'alias' | 'cte' | 'table' | 'column';

/** What sits under the caret, resolved as far as text alone allows. */
export interface RenameTarget {
  kind: RenameKind;
  /** The name as written at the caret, unquoted. */
  name: string;
  /**
   * Column bindings only: the table the column belongs to (as written or
   * alias-resolved). Undefined when the binding needs schema metadata to
   * resolve — planRename refines it, or leaves every occurrence `review`.
   */
  table?: string;
  /** The column belongs to a CTE — the projection inside the body defines it. */
  cte?: boolean;
  /** Statement range for alias/CTE-scoped renames (doc offsets). */
  scope?: { from: number; to: number };
  /** Doc offset of the caret occurrence. */
  at: number;
  /** Tables whose columns would sharpen classification (for getColumns). */
  tablesNeeded: string[];
}

export type RenameClass = 'definite' | 'review';

export interface RenameOccurrence {
  /** Doc offsets of the token, quotes included when quoted. */
  from: number;
  to: number;
  line: number;
  cls: RenameClass;
  /** Why it is not definite, when it is not. */
  reason?: string;
  quoted: boolean;
}

export interface RenamePlan {
  target: RenameTarget;
  occurrences: RenameOccurrence[];
  definite: number;
  review: number;
}

export interface RenameReport {
  text: string;
  rewritten: number;
  reviews: { line: number; lineText: string; reason: string }[];
}

// ── small text helpers ───────────────────────────────────────────────────────

function isIdentChar(c: string): boolean {
  return c !== '' && /[A-Za-z0-9_$]/.test(c);
}

/**
 * The masking dialect for this engine.
 *
 * SQL Server is passed through rather than folded into `mysql`, which is what
 * this did before and which threw away two things `maskLiterals` already knows:
 * `[bracketed]` identifiers, and that T-SQL treats `"x"` as an **identifier**
 * (QUOTED_IDENTIFIER is ON for the driver) where MySQL treats it as a string.
 * Under the MySQL rules a reference written `"orders"` was masked out as a
 * literal and became invisible — a rename that silently skipped it.
 */
function maskEngine(engine: string): MaskEngine {
  if (engine === 'sqlserver') return 'sqlserver';
  return engine === 'postgres' || engine === 'sqlite' || engine === 'duckdb' ? 'postgres' : 'mysql';
}

/** Bare lowercased last part of a possibly-qualified, possibly-quoted name. */
function bareName(table: string): string {
  return (table.split('.').pop() ?? table).replace(/[`"]/g, '').toLowerCase();
}

function prevNonSpace(s: string, i: number): string {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j])) j--;
  return j >= 0 ? s[j] : '';
}

function nextNonSpace(s: string, i: number): string {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  return j < s.length ? s[j] : '';
}

/** The word immediately before an offset — `FROM`, `JOIN`, `AS`, … */
function keywordBefore(masked: string, at: number): string {
  let i = at - 1;
  while (i >= 0 && /[\s(]/.test(masked[i])) i--;
  const end = i + 1;
  while (i >= 0 && isIdentChar(masked[i])) i--;
  return masked.slice(i + 1, end).toLowerCase();
}

/** Keywords after which a name can only be a table (findUsages' set + `DELETE t FROM`). */
const TABLE_KEYWORDS = new Set([...TABLE_POSITION, 'delete']);

// Newline-offset index, computed once per text and binary-searched per
// occurrence (WP-14 14.8): lineOf used to rescan from offset 0 for EVERY
// occurrence — O(occurrences × docLength). Single-slot memo: planRename works
// on one buffer at a time.
let nlIndexKey = '';
let nlIndex: number[] = [];
function newlineIndex(text: string): number[] {
  if (text === nlIndexKey) return nlIndex;
  const idx: number[] = [];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) idx.push(i);
  nlIndexKey = text;
  nlIndex = idx;
  return idx;
}

function lineOf(text: string, at: number): number {
  const idx = newlineIndex(text);
  // count newlines strictly before `at` — binary search for the first ≥ at
  let lo = 0, hi = idx.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (idx[mid] < at) lo = mid + 1; else hi = mid;
  }
  return lo + 1;
}

function lineTextOf(text: string, at: number): string {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  let end = text.indexOf('\n', at);
  if (end === -1) end = text.length;
  return text.slice(start, end).replace(/\s+$/, '');
}

/** Matching `)` for the `(` at `open`, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ── tokenizing ───────────────────────────────────────────────────────────────

interface Tok {
  from: number;
  to: number;
  /** Unquoted name content. */
  name: string;
  quoted: boolean;
}

/**
 * Identifier tokens of the masked text. Quoted identifiers survive
 * maskLiterals with their quotes, so they tokenize as one quoted token;
 * strings and comments are spaces by then and never produce tokens.
 */
function tokenize(masked: string): Tok[] {
  const out: Tok[] = [];
  const n = masked.length;
  let i = 0;
  while (i < n) {
    const ch = masked[i];
    if (ch === '`' || ch === '"') {
      let j = i + 1;
      while (j < n && masked[j] !== ch) j++;
      const to = Math.min(j + 1, n);
      out.push({ from: i, to, name: masked.slice(i + 1, Math.min(j, n)), quoted: true });
      i = to;
      continue;
    }
    if (isIdentChar(ch)) {
      let j = i;
      while (j < n && isIdentChar(masked[j])) j++;
      out.push({ from: i, to: j, name: masked.slice(i, j), quoted: false });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

// ── per-statement analysis ───────────────────────────────────────────────────

interface StmtInfo {
  stmt: Statement;
  aliases: Map<string, string>;
  /** Aliases that rename a table (`orders o`), not bare-name entries. */
  realAliases: Set<string>;
  vtables: Map<string, VirtualTable>;
  /** Real tables in scope, as written (FROM/JOIN/UPDATE targets + INSERT INTO). */
  tables: string[];
  /** `INSERT INTO t ( … )` column-list spans, doc offsets. */
  insertLists: { from: number; to: number; table: string }[];
}

function buildInfo(stmt: Statement, masked: string): StmtInfo {
  const aliases = findAliases(stmt.text);
  const realAliases = new Set<string>();
  const tables: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of aliases) {
    if (bareName(v) !== k) realAliases.add(k);
    if (!seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); tables.push(v); }
  }
  const vtables = findVirtualTables(stmt.text);

  // findAliases does not read INSERTs — add the target table and, when the
  // statement has an explicit column list, its span (its entries are provably
  // columns OF that table).
  const insertLists: StmtInfo['insertLists'] = [];
  const slice = masked.slice(stmt.from, stmt.to);
  const re = /\binsert\s+(?:low_priority\s+|high_priority\s+|delayed\s+|ignore\s+)*into\s+([A-Za-z_`"][\w`"$]*(?:\s*\.\s*[A-Za-z_`"][\w`"$]*)?)/gi;
  for (;;) {
    const m = re.exec(slice);
    if (!m) break;
    const table = m[1].replace(/[`"\s]/g, '');
    if (!table) continue;
    if (!seen.has(table.toLowerCase())) { seen.add(table.toLowerCase()); tables.push(table); }
    let j = m.index + m[0].length;
    while (j < slice.length && /\s/.test(slice[j])) j++;
    if (slice[j] === '(') {
      const close = matchParen(slice, j);
      if (close > j) insertLists.push({ from: stmt.from + j + 1, to: stmt.from + close, table });
    }
  }
  return { stmt, aliases, realAliases, vtables, tables, insertLists };
}

/** Columns of a table as written, from the caller-provided metadata. */
function schemaColumns(schema: RenameSchema, asWritten: string): string[] | undefined {
  const bare = bareName(asWritten);
  const e = schema.tables.find(t => bareName(t.name) === bare);
  return e?.columns.map(c => c.toLowerCase());
}

interface BareResolution {
  /** In-scope real tables that HAVE this column. */
  holders: string[];
  /** In-scope real tables whose columns are not loaded. */
  unknowns: string[];
  /** In-scope CTEs / derived tables projecting this column. */
  virtualHolders: string[];
}

function resolveBare(info: StmtInfo, lname: string, schema: RenameSchema): BareResolution {
  const holders: string[] = [];
  const unknowns: string[] = [];
  const virtualHolders: string[] = [];
  for (const t of info.tables) {
    const cols = schemaColumns(schema, t);
    if (!cols) { unknowns.push(t); continue; }
    if (cols.includes(lname)) holders.push(t);
  }
  for (const [k, vt] of info.vtables) {
    if (vt.columns.some(c => c.toLowerCase() === lname)) virtualHolders.push(k);
  }
  return { holders, unknowns, virtualHolders };
}

/** Every table the classification would like columns for, across the buffer. */
function tablesNeeded(stmts: Statement[], masked: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of stmts) {
    if (!s.text.trim()) continue;
    for (const t of buildInfo(s, masked).tables) {
      const k = t.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(t); }
    }
    if (out.length >= 50) break; // a pathological script must not storm the server
  }
  return out;
}

// ── CTE column projections ───────────────────────────────────────────────────

interface CteDef {
  /** Explicit column list `WITH c(a, b) AS …`, when present (doc offsets). */
  colsFrom?: number;
  colsTo?: number;
  bodyFrom: number;
  bodyTo: number;
}

/** Locate `name [(cols)] AS ( … )` inside the scope. */
function findCteDef(masked: string, scopeFrom: number, scopeTo: number, cteName: string): CteDef | null {
  const slice = masked.slice(scopeFrom, scopeTo);
  const esc = cteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\b' + esc + '\\b\\s*(\\([^)]*\\))?\\s+as\\s*\\(', 'i');
  const m = re.exec(slice);
  if (!m) return null;
  let colsFrom: number | undefined;
  let colsTo: number | undefined;
  if (m[1]) {
    const rel = m[0].indexOf(m[1]);
    colsFrom = scopeFrom + m.index + rel + 1;
    colsTo = colsFrom + m[1].length - 2;
  }
  const open = scopeFrom + m.index + m[0].length - 1;
  const close = matchParen(masked, open);
  if (close < 0) return null;
  return { colsFrom, colsTo, bodyFrom: open + 1, bodyTo: close };
}

interface ProjectionEntry { lastFrom: number; lastTo: number; simple: boolean }

/**
 * The top-level select-list entries of a CTE body: the last identifier token
 * of each entry (doc offsets) and whether the entry is a plain dotted
 * reference (`u.id`, `id`) rather than an expression.
 */
function projectionEntries(masked: string, bodyFrom: number, bodyTo: number): ProjectionEntry[] {
  const body = masked.slice(bodyFrom, bodyTo);
  const head = /^\s*select\s+(?:distinct\s+)?/i.exec(body);
  if (!head) return [];
  const rest = body.slice(head[0].length);
  const restFrom = bodyFrom + head[0].length;

  // top-level FROM (or end of body) ends the select list
  let depth = 0;
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) { end = i; break; } depth--; }
    else if (depth === 0 && /from/i.test(rest.slice(i, i + 4))
             && /[\s]/.test(rest[i - 1] ?? ' ') && /[\s(]/.test(rest[i + 4] ?? ' ')) {
      end = i;
      break;
    }
  }
  const list = rest.slice(0, end);

  // split on top-level commas
  const out: ProjectionEntry[] = [];
  depth = 0;
  let start = 0;
  const SIMPLE = /^[A-Za-z_`"][\w`"$]*(\s*\.\s*[A-Za-z_`"][\w`"$]*)*$/;
  const TOK = /[A-Za-z_][\w$]*|`[^`]*`|"[^"]*"/g;
  const emit = (entryStart: number, entryEnd: number) => {
    const entry = list.slice(entryStart, entryEnd);
    if (!entry.trim()) return;
    TOK.lastIndex = 0;
    let last: RegExpExecArray | null = null;
    for (let m; (m = TOK.exec(entry)) !== null;) last = m;
    if (!last) return;
    out.push({
      lastFrom: restFrom + entryStart + last.index,
      lastTo: restFrom + entryStart + last.index + last[0].length,
      simple: SIMPLE.test(entry.trim()),
    });
  };
  for (let i = 0; i <= list.length; i++) {
    const c = list[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === ',' && depth === 0) || i === list.length) {
      emit(start, i);
      start = i + 1;
    }
  }
  return out;
}

// ── target resolution (text only, no schema) ─────────────────────────────────

/**
 * What is under the caret? Returns null when the caret is on whitespace, a
 * number, a keyword, or a schema-qualifier position (`db.tbl.col` — renaming
 * schemas is out of scope).
 */
export function renameTargetAt(
  text: string, offset: number, engine: string, delimiter = ';',
): RenameTarget | null {
  const masked = maskLiterals(text, maskEngine(engine));
  const toks = tokenize(masked);
  // The token under the caret; a caret just after a word still counts, and
  // ties resolve to the token on the left.
  const ti = toks.findIndex(t => offset >= t.from && offset <= t.to);
  if (ti < 0) return null;
  const tok = toks[ti];
  if (/^\d/.test(tok.name)) return null;
  const lname = tok.name.toLowerCase();
  if (!tok.quoted && RESERVED_WORDS.has(lname)) return null;

  const stmts = splitStatements(text, delimiter);
  const stmt = stmts.find(s => tok.from >= s.from && tok.from <= s.to);
  const info = stmt ? buildInfo(stmt, masked) : null;
  const scope = stmt ? { from: stmt.from, to: stmt.to } : undefined;

  const dotBefore = prevNonSpace(masked, tok.from) === '.';
  const dotAfter = nextNonSpace(masked, tok.to) === '.';

  // The column part of `q.<name>` or `db.q.<name>` — the immediate token left
  // of the dot is the qualifier (the table part of a three-part name).
  if (dotBefore && !dotAfter && ti > 0) {
    const prev = toks[ti - 1];
    const lp = prev.name.toLowerCase();
    const needed = tablesNeeded(stmts, masked);
    // CTEs first: `FROM c` also records a bare alias-map entry for the CTE
    // reference, and a CTE shadows any real table of the same name.
    if (info?.vtables.has(lp)) {
      return { kind: 'column', name: tok.name, table: prev.name, cte: true,
               scope, at: tok.from, tablesNeeded: needed };
    }
    if (info && (info.realAliases.has(lp) || info.aliases.has(lp))) {
      return { kind: 'column', name: tok.name, table: info.aliases.get(lp)!,
               at: tok.from, tablesNeeded: needed };
    }
    // Unresolvable qualifier — keep the textual binding; occurrences qualified
    // by the same word are still provably the same reference.
    return { kind: 'column', name: tok.name, table: prev.name,
             at: tok.from, tablesNeeded: needed };
  }

  // An alias or CTE name — statement-scoped.
  if (info && scope) {
    if (info.realAliases.has(lname)) {
      return { kind: 'alias', name: tok.name, scope, at: tok.from, tablesNeeded: [] };
    }
    const vt = info.vtables.get(lname);
    if (vt) {
      return { kind: vt.kind === 'cte' ? 'cte' : 'alias', name: tok.name,
               scope, at: tok.from, tablesNeeded: [] };
    }
  }

  // `<name>.x` — the table used as a qualifier, unless the chain continues
  // (`<name>.x.y` makes `<name>` a schema, which this tool does not rename).
  if (dotAfter) {
    const next = toks[ti + 1];
    if (next && nextNonSpace(masked, next.to) === '.') return null;
    return { kind: 'table', name: tok.name, at: tok.from, tablesNeeded: [] };
  }
  // The table part of `db.<name>` (optionally `db.<name>.col`).
  if (dotBefore) {
    return { kind: 'table', name: tok.name, at: tok.from, tablesNeeded: [] };
  }
  // A bare name in a table position, or one findAliases saw in a FROM/JOIN/UPDATE.
  if (TABLE_KEYWORDS.has(keywordBefore(masked, tok.from)) || info?.aliases.has(lname)) {
    return { kind: 'table', name: tok.name, at: tok.from, tablesNeeded: [] };
  }
  // A bare column — which table's is decidable only with the schema, in planRename.
  return { kind: 'column', name: tok.name, at: tok.from,
           tablesNeeded: tablesNeeded(stmts, masked) };
}

// ── the plan: classify every occurrence ─────────────────────────────────────

/**
 * Classify EVERY occurrence of the target's name in the buffer as `definite`
 * or `review` (see the module header for the model). Needs the schema metadata
 * promised by `RenameTarget.tablesNeeded`; missing tables degrade bare-column
 * occurrences to `review`, never to a silent rewrite.
 */
export function planRename(
  text: string, target: RenameTarget, schema: RenameSchema, engine: string, delimiter = ';',
): RenamePlan {
  const masked = maskLiterals(text, maskEngine(engine));
  const toks = tokenize(masked);
  const stmts = splitStatements(text, delimiter);
  const infos = new Map<Statement, StmtInfo>();
  const infoFor = (from: number): StmtInfo | null => {
    // stmts are sorted, non-overlapping ranges — binary search instead of a
    // linear stmts.find per token (WP-14 14.8).
    let lo = 0, hi = stmts.length - 1, s: Statement | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const x = stmts[mid];
      if (from < x.from) hi = mid - 1;
      else if (from > x.to) lo = mid + 1;
      else { s = x; break; }
    }
    if (!s) return null;
    let i = infos.get(s);
    if (!i) { i = buildInfo(s, masked); infos.set(s, i); }
    return i;
  };

  const lname = target.name.toLowerCase();
  const dotB = toks.map(t => prevNonSpace(masked, t.from) === '.');
  const dotA = toks.map(t => nextNonSpace(masked, t.to) === '.');
  const occs: RenameOccurrence[] = [];
  const push = (tok: Tok, cls: RenameClass, reason?: string) => {
    occs.push({ from: tok.from, to: tok.to, line: lineOf(text, tok.from), cls, reason, quoted: tok.quoted });
  };

  // A bare column at the caret binds to a table only when the schema proves it:
  // every in-scope table's columns known, exactly one holder.
  let binding = target.table ? bareName(target.table) : undefined;
  if (target.kind === 'column' && !binding && !target.cte) {
    const info = infoFor(target.at);
    if (info) {
      const r = resolveBare(info, lname, schema);
      if (r.holders.length === 1 && r.unknowns.length === 0 && r.virtualHolders.length === 0) {
        binding = bareName(r.holders[0]);
      }
    }
  }

  // CTE column rename: the projection inside the body is part of the symbol.
  let cteDef: CteDef | null = null;
  let projections: ProjectionEntry[] = [];
  if (target.kind === 'column' && target.cte && target.scope && binding) {
    cteDef = findCteDef(masked, target.scope.from, target.scope.to, binding);
    if (cteDef) projections = projectionEntries(masked, cteDef.bodyFrom, cteDef.bodyTo);
  }

  if (target.kind === 'alias' || target.kind === 'cte') {
    const scope = target.scope!;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.from < scope.from || t.from >= scope.to) continue;
      if (t.name.toLowerCase() !== lname) continue;
      // `x.name` — the column part of a qualified reference is another
      // object's name, even when the word matches the alias.
      if (dotB[i]) continue;
      push(t, 'definite');
    }
  } else if (target.kind === 'table') {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.name.toLowerCase() !== lname) continue;
      const info = infoFor(t.from);
      // Shadowed in this statement — the word binds to an alias or CTE there,
      // provably not to this table. Excluded, not reviewed: there is no doubt.
      if (info && (info.realAliases.has(lname) || info.vtables.has(lname))) continue;
      if (dotB[i]) {
        const prev = toks[i - 1];
        const lp = prev.name.toLowerCase();
        // `alias.name` / `cte.name` — a column of that object, not the table.
        if (info && (info.realAliases.has(lp) || info.vtables.has(lp))) continue;
        if (dotA[i]) { push(t, 'definite'); continue; } // db.<name>.col — the table part
        if (TABLE_KEYWORDS.has(keywordBefore(masked, prev.from))) {
          push(t, 'definite'); // FROM db.<name>
        } else {
          push(t, 'review', `qualified by ${prev.name} — check this is the table, not a column of it`);
        }
        continue;
      }
      if (dotA[i]) {
        const next = toks[i + 1];
        if (next && dotA[i + 1]) continue; // <name>.x.y — the schema part; out of scope
        push(t, 'definite'); // <name>.col — the table as qualifier
        continue;
      }
      if (TABLE_KEYWORDS.has(keywordBefore(masked, t.from))) push(t, 'definite');
      else push(t, 'review', 'the name matches but is not in a table position — check it is not a column or alias');
    }
  } else if (target.cte) {
    // A CTE's column: qualified refs and the projection define it.
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.name.toLowerCase() !== lname) continue;
      if (target.scope && (t.from < target.scope.from || t.from >= target.scope.to)) continue;
      if (cteDef?.colsFrom !== undefined && t.from >= cteDef.colsFrom && t.from < cteDef.colsTo!) {
        push(t, 'definite'); // WITH c(…, name, …) — the explicit column list
        continue;
      }
      if (dotA[i]) continue; // used as a qualifier — a different namespace
      const inBody = !!cteDef && t.from >= cteDef.bodyFrom && t.from < cteDef.bodyTo;
      const projection = projections.find(p => p.lastFrom === t.from && p.lastTo === t.to);
      if (dotB[i]) {
        const prev = toks[i - 1];
        if (prev.name.toLowerCase() === binding) { push(t, 'definite'); continue; } // cte.name
        if (inBody && projection?.simple) {
          push(t, 'review', `the CTE projects this as ${target.name} — renaming needs AS <new name> here`);
        }
        // else another table's column — provably not this symbol
        continue;
      }
      if (keywordBefore(masked, t.from) === 'as') {
        // `AS name` inside the body defines the CTE column; outside it is an
        // output alias — a NEW name, not a reference.
        if (inBody) push(t, 'definite');
        continue;
      }
      if (inBody && projection?.simple) {
        push(t, 'review', `the CTE projects this as ${target.name} — renaming needs AS <new name> here`);
        continue;
      }
      push(t, 'review', 'unqualified — cannot prove it binds to the CTE column');
    }
  } else {
    // A table's column.
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.name.toLowerCase() !== lname) continue;
      const info = infoFor(t.from);
      if (dotA[i]) continue; // <name>.x — used as a qualifier, another namespace
      if (dotB[i]) {
        const prev = toks[i - 1];
        const lp = prev.name.toLowerCase();
        if (info && (info.realAliases.has(lp) || info.aliases.has(lp))) {
          const bound = info.aliases.get(lp)!;
          if (binding && bareName(bound) === binding) push(t, 'definite');
          else if (!binding) push(t, 'review', `the symbol at the caret could not be resolved — cannot prove ${prev.name}.${target.name} is it`);
          // else: provably another table's column — not reported at all
          continue;
        }
        if (info?.vtables.has(lp)) continue; // a CTE's / derived table's column
        if (binding && lp === binding) { push(t, 'definite'); continue; } // same textual qualifier
        push(t, 'review', `qualified by ${prev.name}, which does not resolve to a table or alias here`);
        continue;
      }
      // A bare occurrence.
      if (info && binding) {
        const il = info.insertLists.find(s => t.from >= s.from && t.from < s.to);
        if (il && bareName(il.table) === binding) { push(t, 'definite'); continue; }
      }
      // `expr AS name` — an output alias is a new name, not a reference.
      if (keywordBefore(masked, t.from) === 'as') continue;
      if (!info) { push(t, 'review', 'outside any statement'); continue; }
      if (!binding) {
        push(t, 'review', `could not resolve which table ${target.name} belongs to`);
        continue;
      }
      const r = resolveBare(info, lname, schema);
      if (r.holders.length === 1 && bareName(r.holders[0]) === binding
          && r.unknowns.length === 0 && r.virtualHolders.length === 0) {
        push(t, 'definite');
      } else if (r.unknowns.length > 0) {
        push(t, 'review', `columns of ${r.unknowns.map(bareName).join(', ')} are not loaded — cannot prove this is ${binding}.${target.name}`);
      } else if (r.holders.some(h => bareName(h) === binding)) {
        const others = [
          ...r.holders.filter(h => bareName(h) !== binding).map(bareName),
          ...r.virtualHolders,
        ];
        push(t, 'review', `unqualified — ${others.join(', ')} also has a column named ${target.name}`);
      }
      // else: provably a different table's column (or not a column here) — skip
    }
  }

  // Strings and comments: never rewritten, always reported. A name inside
  // `'…'` may be dynamic SQL; inside a comment it is at least a stale comment.
  // These regions are blank in the masked text, so this cannot double-count
  // the tokens classified above.
  const scope = (target.kind === 'alias' || target.kind === 'cte'
    || (target.kind === 'column' && target.cte)) ? target.scope : undefined;
  const hay = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(lname, from);
    if (at === -1) break;
    from = at + 1;
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + lname.length] ?? '';
    if (isIdentChar(before) || isIdentChar(after)) continue;
    if (scope && (at < scope.from || at >= scope.to)) continue;
    if (masked.slice(at, at + lname.length).trim() !== '') continue; // visible code
    occs.push({
      from: at, to: at + lname.length, line: lineOf(text, at),
      cls: 'review', reason: 'inside a string literal or comment', quoted: false,
    });
  }

  occs.sort((a, b) => a.from - b.from);
  return {
    target,
    occurrences: occs,
    definite: occs.filter(o => o.cls === 'definite').length,
    review: occs.filter(o => o.cls === 'review').length,
  };
}

// ── the rewrite: definite occurrences only ───────────────────────────────────

/**
 * Rewrite the plan's `definite` occurrences to `newName`, quoting only when
 * the original was quoted (quote style preserved) or the new name would not
 * resolve bare. Returns null for a name that cannot be written as one
 * identifier (empty, dotted, or containing a line break).
 *
 * `review` occurrences come back in the report with line numbers — showing
 * them is the caller's job; they are NEVER rewritten here.
 */
export function applyRename(
  text: string, plan: RenamePlan, newName: string, engine: string,
): RenameReport | null {
  const name = newName.trim();
  if (!name || name.includes('.') || /[\r\n]/.test(name)) return null;

  const bareInsert = needsQuote(name, engine) ? quoteIdent(name, engine) : name;
  const edits = plan.occurrences
    .filter(o => o.cls === 'definite')
    .sort((a, b) => b.from - a.from);

  let out = text;
  for (const e of edits) {
    const rep = e.quoted
      ? text[e.from] + name.split(text[e.from]).join(text[e.from] + text[e.from]) + text[e.from]
      : bareInsert;
    out = out.slice(0, e.from) + rep + out.slice(e.to);
  }

  const reviews = plan.occurrences
    .filter(o => o.cls === 'review')
    .map(o => ({
      line: o.line,
      lineText: lineTextOf(text, o.from),
      reason: o.reason ?? 'check this occurrence',
    }));

  return { text: out, rewritten: edits.length, reviews };
}
