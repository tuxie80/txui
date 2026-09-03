/**
 * "What is this thing under my cursor?" — the resolver behind hover tooltips,
 * ⌘-click navigation and signature help.
 *
 * Pure: it takes the document, an offset, and the aliases/schema already known
 * to the editor, and says what the token is. No DOM, no async, no CodeMirror —
 * so the rules are testable (tests/sqlHover.test.ts).
 */

/** Word (identifier) boundaries in SQL, including quoted forms. */
const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Which quote means what depends on the engine, and getting it wrong makes the
 * whole resolver lie: on **PostgreSQL** `"x"` is an IDENTIFIER, on **MySQL** it
 * is a string literal (unless ANSI_QUOTES, which we do not assume) while
 * `` `x` `` is the identifier. Both treat `'x'` as a string.
 */
export type HoverEngine = 'mysql' | 'postgres' | string;

/**
 * The identifier-quote pairs for this engine, as `[open, close]`.
 *
 * A list of PAIRS rather than a single character, because SQL Server has two
 * and one of them is **asymmetric**: `[order]` is the T-SQL form, and `"order"`
 * is also an identifier there (the driver runs with QUOTED_IDENTIFIER ON).
 * Treating `"…"` as a string on SQL Server — the MySQL rule this used to fall
 * back to — made every double-quoted column un-hoverable, and treating `[…]`
 * as ordinary text made the brackets part of the name.
 */
function identQuotes(engine: HoverEngine): Array<[string, string]> {
  if (engine === 'postgres') return [['"', '"']];
  if (engine === 'sqlserver') return [['[', ']'], ['"', '"']];
  return [['`', '`']];
}

/**
 * Characters that open a string literal.
 *
 * `"` is a string on MySQL and an identifier on PostgreSQL and SQL Server — the
 * one place where SQL Server sides with PostgreSQL rather than with the
 * backtick family.
 */
const stringQuotes = (engine: HoverEngine) =>
  (engine === 'postgres' || engine === 'sqlserver' ? ["'"] : ["'", '"']);

/** Every character that can CLOSE a quoted identifier, for the qualifier walk-back. */
const identClosers = (engine: HoverEngine) => identQuotes(engine).map(([, c]) => c);

export interface TokenSpan {
  from: number;
  to: number;
  text: string;
  /** the dotted qualifier before it, if any: `o` in `o.state`, `shop` in `shop.orders` */
  qualifier?: string;
}

/**
 * The identifier under `pos`, plus its dotted qualifier. Returns null inside a
 * string, a comment, or where there is simply no word.
 */
export function tokenAt(doc: string, pos: number, engine: HoverEngine = 'mysql'): TokenSpan | null {
  if (pos < 0 || pos > doc.length) return null;

  // A quoted identifier is one token: `my table` (MySQL) / "OrderItems" (PG).
  // Checked BEFORE the literal test, because on PG that same quote would look
  // like a string to a naive scanner.
  const quoted = quotedTokenAt(doc, pos, engine);
  if (quoted) return quoted;

  if (inStringOrComment(doc, pos, engine)) return null;

  let from = pos, to = pos;
  while (from > 0 && IDENT_CHAR.test(doc[from - 1])) from--;
  while (to < doc.length && IDENT_CHAR.test(doc[to])) to++;
  if (from === to) return null;
  const text = doc.slice(from, to);
  if (/^\d/.test(text)) return null;                 // a number is not an identifier

  // Walk back over `qualifier.` (one level: alias.col, schema.table)
  let qualifier: string | undefined;
  if (from > 0 && doc[from - 1] === '.') {
    let qs = from - 1;
    const closers = identClosers(engine);
    if (qs > 0 && closers.includes(doc[qs - 1])) {
      // Walk back to the matching OPENER, which is not the same character for
      // `[…]`. Using the closer to find the start finds nothing and leaves the
      // qualifier unresolved, so `[sales].[orders]` loses its schema.
      const close = doc[qs - 1];
      const openCh = identQuotes(engine).find(([, c]) => c === close)![0];
      const open = doc.lastIndexOf(openCh, qs - 2);
      if (open >= 0) { qualifier = doc.slice(open + 1, qs - 1); qs = open; }
    } else {
      let s = qs;
      while (s > 0 && IDENT_CHAR.test(doc[s - 1])) s--;
      if (s < qs) qualifier = doc.slice(s, qs);
    }
  }
  return { from, to, text, qualifier };
}

function quotedTokenAt(doc: string, pos: number, engine: HoverEngine): TokenSpan | null {
  for (const [open, close] of identQuotes(engine)) {
    // scan the line for quoted runs and see whether pos falls inside one
    const lineFrom = doc.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
    let i = lineFrom;
    while (i < doc.length && doc[i] !== '\n') {
      if (doc[i] === open) {
        const end = doc.indexOf(close, i + 1);
        if (end < 0) break;
        if (pos > i && pos <= end) {
          const text = doc.slice(i + 1, end);
          let qualifier: string | undefined;
          if (i > 0 && doc[i - 1] === '.') {
            // The qualifier may itself be quoted — `orders`.`total`,
            // "orders"."total", [orders].[total]. Walking back only over bare
            // identifier characters stops at the closing quote and finds
            // nothing, so a fully-quoted reference lost its qualifier on every
            // engine, not just this one.
            const closers = identClosers(engine);
            if (i > 1 && closers.includes(doc[i - 2])) {
              const close = doc[i - 2];
              const openCh = identQuotes(engine).find(([, c]) => c === close)![0];
              const qOpen = doc.lastIndexOf(openCh, i - 3);
              if (qOpen >= 0) qualifier = doc.slice(qOpen + 1, i - 2);
            } else {
              let s = i - 1;
              while (s > 0 && IDENT_CHAR.test(doc[s - 1])) s--;
              if (s < i - 1) qualifier = doc.slice(s, i - 1);
            }
          }
          return { from: i, to: end + 1, text, qualifier };
        }
        i = end + 1;
        continue;
      }
      i++;
    }
  }
  return null;
}

/** Cheap string/comment detector — good enough to keep hovers out of literals. */
export function inStringOrComment(doc: string, pos: number, engine: HoverEngine = 'mysql'): boolean {
  const quotes = stringQuotes(engine);
  let i = 0, inLine = false, inBlock = false;
  let open: string | null = null;
  while (i < pos && i < doc.length) {
    const c = doc[i], n = doc[i + 1];
    if (inLine) { if (c === '\n') inLine = false; i++; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; continue; } i++; continue; }
    if (open) {
      if (c === '\\') { i += 2; continue; }
      if (c === open) { open = null; }
      i++;
      continue;
    }
    if (c === '-' && n === '-') { inLine = true; i += 2; continue; }
    if (c === '#') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (quotes.includes(c)) { open = c; i++; continue; }
    i++;
  }
  return open !== null || inLine || inBlock;
}

// ── what the token means ──────────────────────────────────────────────────────

export interface HoverTarget {
  span: TokenSpan;
  kind: 'table' | 'column' | 'function' | 'variable' | 'keyword' | 'unknown';
  /** resolved table for a column, or the table itself */
  table?: string;
  /** column name when kind === 'column' */
  column?: string;
  /** function/variable name as written */
  name?: string;
}

export interface HoverContext {
  /** alias → table (as written), from utils/sqlAlias */
  aliases: Map<string, string>;
  /** known object names, lower-cased → canonical "schema.name" or name */
  objects: Map<string, string>;
  /** known function names, upper-cased */
  functions: Set<string>;
  /** SQL keywords, lower-cased — hovering these is noise, so they resolve to `keyword` */
  keywords: Set<string>;
}

/**
 * Classify the token under `pos`:
 *   `o.state`          → column of the table aliased `o`
 *   `orders`           → table (if known) — else a column of a table in scope
 *   `@@max_connections`, `@x`, `:var` → variable
 *   `DATE_FORMAT`      → function
 */
export function resolveHover(
  doc: string, pos: number, ctx: HoverContext, engine: HoverEngine = 'mysql',
): HoverTarget | null {
  const varSpan = variableAt(doc, pos, engine);
  if (varSpan) return { span: varSpan, kind: 'variable', name: varSpan.text };

  const span = tokenAt(doc, pos, engine);
  if (!span) return null;
  const lower = span.text.toLowerCase();
  const upper = span.text.toUpperCase();

  // qualified: alias.column / schema.table / table.column
  if (span.qualifier) {
    const q = span.qualifier.toLowerCase();
    const aliased = ctx.aliases.get(q);
    if (aliased) return { span, kind: 'column', table: aliased, column: span.text };
    if (ctx.objects.has(`${q}.${lower}`)) {
      return { span, kind: 'table', table: ctx.objects.get(`${q}.${lower}`) };
    }
    if (ctx.objects.has(q)) return { span, kind: 'column', table: ctx.objects.get(q), column: span.text };
    return { span, kind: 'column', table: span.qualifier, column: span.text };
  }

  // a table/view name we know about
  const objHit = ctx.objects.get(lower);
  if (objHit) return { span, kind: 'table', table: objHit };

  // an alias used bare (`FROM orders o … SELECT o`) — rare but harmless
  const aliasHit = ctx.aliases.get(lower);
  if (aliasHit) return { span, kind: 'table', table: aliasHit };

  if (ctx.functions.has(upper)) return { span, kind: 'function', name: upper };
  if (ctx.keywords.has(lower)) return { span, kind: 'keyword' };

  // otherwise: assume a column of whatever tables are in scope, and let the
  // caller search them (that is where the async column lookups live)
  return { span, kind: 'column', column: span.text };
}

/** `@@global_var`, `@user_var` or `:placeholder` at `pos`. */
export function variableAt(
  doc: string, pos: number, engine: HoverEngine = 'mysql',
): TokenSpan | null {
  const lineFrom = doc.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  const lineTo = (() => { const n = doc.indexOf('\n', pos); return n < 0 ? doc.length : n; })();
  const line = doc.slice(lineFrom, lineTo);
  const re = /(@@?[A-Za-z_][\w$.]*|:[A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const from = lineFrom + m.index, to = from + m[0].length;
    if (pos >= from && pos <= to) {
      if (inStringOrComment(doc, from, engine)) return null;
      return { from, to, text: m[0] };
    }
  }
  return null;
}

// ── signature help ────────────────────────────────────────────────────────────

export interface CallSite {
  /** function/procedure name as written */
  name: string;
  /** offset of the name (so the hint can be anchored to it) */
  from: number;
  /** which argument the caret is in, 0-based */
  argIndex: number;
  /** offset of the opening paren */
  parenAt: number;
}

/**
 * The call the caret is inside, if any: `DATE_FORMAT(created_at, |'%Y')` →
 * `{ name: 'DATE_FORMAT', argIndex: 1 }`. Walks back over balanced parens and
 * skips strings/comments, so a comma inside a nested call or a literal does not
 * shift the argument index.
 */
export function callSiteAt(doc: string, pos: number, engine: HoverEngine = 'mysql'): CallSite | null {
  // One forward pass with an explicit paren stack. The old backward walk
  // re-ran inStringOrComment (itself a scan from offset 0) for every
  // character it visited — O(pos²) for a caret deep in a long statement.
  const quotes = stringQuotes(engine);
  const stack: { parenAt: number; argIndex: number }[] = [];
  const limit = Math.min(pos, doc.length);
  let i = 0;
  while (i < limit) {
    const c = doc[i], n = doc[i + 1];
    // Strings and comments are consumed whole, never character-by-character.
    if (c === '-' && n === '-') { const nl = doc.indexOf('\n', i); i = nl < 0 ? limit : nl + 1; continue; }
    if (c === '#') { const nl = doc.indexOf('\n', i); i = nl < 0 ? limit : nl + 1; continue; }
    if (c === '/' && n === '*') { const close = doc.indexOf('*/', i + 2); i = close < 0 ? limit : close + 2; continue; }
    if (quotes.includes(c)) {
      let j = i + 1;
      while (j < doc.length) {
        if (doc[j] === '\\') { j += 2; continue; }
        if (doc[j] === c) { j++; break; }
        j++;
      }
      i = j;
      continue;
    }
    if (c === ';') { stack.length = 0; i++; continue; }  // never cross a statement
    if (c === '(') { stack.push({ parenAt: i, argIndex: 0 }); i++; continue; }
    if (c === ')') { stack.pop(); i++; continue; }
    if (c === ',' && stack.length > 0) { stack[stack.length - 1].argIndex++; i++; continue; }
    i++;
  }
  const top = stack[stack.length - 1];
  if (!top) return null;
  // found the opening paren of our call — the name sits before it
  let e = top.parenAt;
  while (e > 0 && /\s/.test(doc[e - 1])) e--;
  let sName = e;
  while (sName > 0 && /[A-Za-z0-9_$.]/.test(doc[sName - 1])) sName--;
  const name = doc.slice(sName, e);
  if (!name || /^\d/.test(name)) return null;
  return { name, from: sName, argIndex: top.argIndex, parenAt: top.parenAt };
}

/**
 * Split a signature's argument list for highlighting: `SUBSTRING(str, pos, len)`
 * → `['str', 'pos', 'len']`. Returns [] when the signature has no parens.
 */
export function signatureArgs(sig: string): string[] {
  const open = sig.indexOf('(');
  const close = sig.lastIndexOf(')');
  if (open < 0 || close < open) return [];
  const inner = sig.slice(open + 1, close);
  if (!inner.trim()) return [];
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
