/**
 * Cross-column formulas for the data generator (plan-datagen-nextgen Phase 4).
 *
 * A `formula` column carries an EXPRESSION over earlier columns of the same
 * row — `price * qty`, `first_name || ' ' || last_name` — so a generated table
 * can carry the arithmetic consistency real data has (a totals column that
 * agrees with its parts) instead of independent randoms that contradict each
 * other.
 *
 * Safety and determinism rules:
 *
 *   - **No eval.** A tiny recursive-descent parser produces an AST once per
 *     run; rows evaluate the AST. The grammar has no way to reach anything
 *     outside the row: literals, column refs, arithmetic, `||` concatenation
 *     and a whitelisted function set. Nothing else parses.
 *   - **Earlier columns only.** Rows are built left to right, so a reference
 *     to a later (or unknown, or self) column is a CONFIG error — reported by
 *     `validateFormula`, surfaced in the panel and rejected by the Rust
 *     preview/run commands before a row is written. `evalFormula` never
 *     throws: a runtime type mismatch (a string where arithmetic wanted a
 *     number) yields NULL for that cell, the SQL-ish answer, rather than
 *     killing a ten-million-row run mid-stream.
 *   - **No RNG.** A formula consumes no draws from the seeded stream, which is
 *     what lets both engines evaluate it as a post-pass over the row just
 *     built — the stream (and every other column's values) is identical with
 *     or without formula columns. TS (`generateRows`) and Rust
 *     (`datagen_formula.rs`) implement the same semantics and are pinned
 *     against each other by the tests.
 *   - **NULL propagates** through operators and every function except
 *     `coalesce`, matching SQL — and `x / 0` and `x % 0` are NULL too (the
 *     server-side SQL form emits `NULLIF(denominator, 0)` so the two paths
 *     agree; a bare `/` would ERROR mid-run on PostgreSQL).
 *
 * Value model: a cell is null, a number (f64), a string or a boolean. Strings
 * that LOOK numeric are NOT numbers — `'10' + 1` concatenates (`'101'`),
 * matching what a person reading `'10' + 1` in a text column expects, while
 * `-` `*` `/` `%` apply a STRICT numeric parse to string operands (a trim plus
 * an optional-sign/decimal/exponent shape — no hex, no Infinity, no empty
 * string counting as 0) so `price * qty` still works when `price` came from a
 * choice list. Booleans take no part in arithmetic or concatenation (a type
 * error → NULL); `coalesce` passes them through.
 *
 * The SQL-expressible subset (emitted by datagenSql.ts for the server-side
 * INSERT…SELECT path): literals, column refs, `+ - * / %`, parens, `||`, and
 * the functions ABS/ROUND/FLOOR/CEIL/LEAST/GREATEST/LENGTH/UPPER/LOWER/
 * SUBSTRING/COALESCE — with two honest edges: `+` is only expressible when
 * both sides are statically known numbers (numeric add) or at least one side
 * is statically a string (concatenation); and `substr` only with non-negative
 * integer LITERAL bounds (the clamped runtime semantics for computed/negative
 * starts differ per SQL engine). `slugify` and anything else is reported
 * unsupported-for-server, so the run falls back to the row-by-row engine
 * rather than emitting something that silently differs.
 */

// ── AST ───────────────────────────────────────────────────────────────────────

export type FormulaNode =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'col'; name: string }
  | { t: 'neg'; a: FormulaNode }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '%' | '||'; a: FormulaNode; b: FormulaNode }
  | { t: 'fn'; name: string; args: FormulaNode[] };

/**
 * The whitelisted function set. `args` is [min, max] arity. `sql` names the
 * portable SQL spelling family — `null` means runtime-only, and a formula
 * using it is reported unsupported on the server path (honest fallback, not a
 * silent approximation).
 */
export const FORMULA_FUNCTIONS: Record<string, { minArgs: number; maxArgs: number; sql: boolean }> = {
  abs:      { minArgs: 1, maxArgs: 1, sql: true },
  round:    { minArgs: 1, maxArgs: 2, sql: true },
  floor:    { minArgs: 1, maxArgs: 1, sql: true },
  ceil:     { minArgs: 1, maxArgs: 1, sql: true },
  min:      { minArgs: 1, maxArgs: 32, sql: true },   // LEAST
  max:      { minArgs: 1, maxArgs: 32, sql: true },   // GREATEST
  length:   { minArgs: 1, maxArgs: 1, sql: true },
  upper:    { minArgs: 1, maxArgs: 1, sql: true },
  lower:    { minArgs: 1, maxArgs: 1, sql: true },
  substr:   { minArgs: 2, maxArgs: 3, sql: true },    // literal bounds only
  coalesce: { minArgs: 1, maxArgs: 32, sql: true },
  slugify:  { minArgs: 1, maxArgs: 1, sql: false },
};

/** Guards against pathological input, not real expressions. */
const MAX_SRC = 2000;
const MAX_DEPTH = 64;

// ── Parser (recursive descent, no eval anywhere) ─────────────────────────────

export type ParseResult = { ok: true; ast: FormulaNode } | { ok: false; error: string };

interface Tok {
  kind: 'num' | 'str' | 'ident' | 'qcol' | 'op' | 'end';
  text: string;          // ident/qcol text, op text
  num?: number;          // numeric literal value
  str?: string;          // string literal value (unescaped)
  pos: number;           // char offset, for error messages
}

function tokenize(src: string): Tok[] | string {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if (text.split('.').length > 2) {
        return `malformed number '${text}' at position ${i + 1}`;
      }
      const num = Number(text);
      if (!Number.isFinite(num)) return `malformed number '${text}' at position ${i + 1}`;
      toks.push({ kind: 'num', text, num, pos: i });
      i = j;
      continue;
    }
    if (c === '\'') {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) return `unterminated string literal at position ${i + 1}`;
        if (src[j] === '\'' && src[j + 1] === '\'') { s += '\''; j += 2; continue; }
        if (src[j] === '\'') break;
        s += src[j]; j++;
      }
      toks.push({ kind: 'str', text: s, str: s, pos: i });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) return `unterminated quoted column at position ${i + 1}`;
        if (src[j] === '"' && src[j + 1] === '"') { s += '"'; j += 2; continue; }
        if (src[j] === '"') break;
        s += src[j]; j++;
      }
      if (!s) return `empty quoted column name at position ${i + 1}`;
      toks.push({ kind: 'qcol', text: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ kind: 'ident', text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === '|' && src[i + 1] === '|') { toks.push({ kind: 'op', text: '||', pos: i }); i += 2; continue; }
    if ('+-*/%(),'.includes(c)) { toks.push({ kind: 'op', text: c, pos: i }); i++; continue; }
    return `unexpected character '${c}' at position ${i + 1}`;
  }
  toks.push({ kind: 'end', text: '', pos: src.length });
  return toks;
}

/**
 * Parse `src` into an AST. Grammar, tightest binding last:
 *
 *   expr    := concat
 *   concat  := add ( '||' add )*
 *   add     := mul ( ('+' | '-') mul )*
 *   mul     := unary ( ('*' | '/' | '%') unary )*
 *   unary   := '-' unary | primary
 *   primary := number | 'string' | column | fn(args) | '(' expr ')'
 *
 * A column is a bare identifier or a "double-quoted" one (for names with
 * spaces/unicode). An identifier followed by '(' must be a whitelisted
 * function — anything else is a parse error, never a silent column guess.
 */
export function parseFormula(src: string): ParseResult {
  if (!src.trim()) return { ok: false, error: 'the expression is empty' };
  if (src.length > MAX_SRC) return { ok: false, error: `the expression is longer than ${MAX_SRC} characters` };
  const toks = tokenize(src);
  if (typeof toks === 'string') return { ok: false, error: toks };
  let at = 0;
  const peek = () => toks[at];
  const errAt = (msg: string, t: Tok): string => `${msg} at position ${t.pos + 1}`;

  function parseExpr(depth: number): FormulaNode | string {
    if (depth > MAX_DEPTH) return `the expression nests deeper than ${MAX_DEPTH} levels`;
    // concat level
    let a = parseAdd(depth);
    if (typeof a === 'string') return a;
    while (peek().kind === 'op' && peek().text === '||') {
      at++;
      const b = parseAdd(depth);
      if (typeof b === 'string') return b;
      a = { t: 'bin', op: '||', a, b };
    }
    return a;
  }
  function parseAdd(depth: number): FormulaNode | string {
    let a = parseMul(depth);
    if (typeof a === 'string') return a;
    while (peek().kind === 'op' && (peek().text === '+' || peek().text === '-')) {
      const op = peek().text as '+' | '-';
      at++;
      const b = parseMul(depth);
      if (typeof b === 'string') return b;
      a = { t: 'bin', op, a, b };
    }
    return a;
  }
  function parseMul(depth: number): FormulaNode | string {
    let a = parseUnary(depth);
    if (typeof a === 'string') return a;
    while (peek().kind === 'op' && (peek().text === '*' || peek().text === '/' || peek().text === '%')) {
      const op = peek().text as '*' | '/' | '%';
      at++;
      const b = parseUnary(depth);
      if (typeof b === 'string') return b;
      a = { t: 'bin', op, a, b };
    }
    return a;
  }
  function parseUnary(depth: number): FormulaNode | string {
    const t = peek();
    if (t.kind === 'op' && t.text === '-') {
      at++;
      const a = parseUnary(depth + 1);
      if (typeof a === 'string') return a;
      return { t: 'neg', a };
    }
    if (t.kind === 'op' && t.text === '+') {   // unary plus is a no-op
      at++;
      return parseUnary(depth + 1);
    }
    return parsePrimary(depth + 1);
  }
  function parsePrimary(depth: number): FormulaNode | string {
    const t = peek();
    if (t.kind === 'num') { at++; return { t: 'num', v: t.num! }; }
    if (t.kind === 'str') { at++; return { t: 'str', v: t.str! }; }
    if (t.kind === 'qcol') { at++; return { t: 'col', name: t.text }; }
    if (t.kind === 'ident') {
      at++;
      if (peek().kind === 'op' && peek().text === '(') {
        const name = t.text.toLowerCase();
        const fn = FORMULA_FUNCTIONS[name];
        if (!fn) return `unknown function '${t.text}'`;
        at++;   // consume '('
        const args: FormulaNode[] = [];
        if (!(peek().kind === 'op' && peek().text === ')')) {
          for (;;) {
            const a = parseExpr(depth + 1);
            if (typeof a === 'string') return a;
            args.push(a);
            if (peek().kind === 'op' && peek().text === ',') { at++; continue; }
            break;
          }
        }
        if (!(peek().kind === 'op' && peek().text === ')')) return errAt(`expected ')' after ${name}()'s arguments`, peek());
        at++;
        if (args.length < fn.minArgs || args.length > fn.maxArgs) {
          return fn.minArgs === fn.maxArgs
            ? `${name}() takes exactly ${fn.minArgs} argument${fn.minArgs === 1 ? '' : 's'}`
            : `${name}() takes ${fn.minArgs}–${fn.maxArgs} arguments`;
        }
        return { t: 'fn', name, args };
      }
      return { t: 'col', name: t.text };
    }
    if (t.kind === 'op' && t.text === '(') {
      at++;
      const a = parseExpr(depth + 1);
      if (typeof a === 'string') return a;
      if (!(peek().kind === 'op' && peek().text === ')')) return `expected ')' at position ${peek().pos + 1}`;
      at++;
      return a;
    }
    return t.kind === 'end'
      ? 'unexpected end of expression'
      : `unexpected '${t.text}' at position ${t.pos + 1}`;
  }

  const ast = parseExpr(0);
  if (typeof ast === 'string') return { ok: false, error: ast };
  if (peek().kind !== 'end') return { ok: false, error: errAt('unexpected trailing input', peek()) };
  return { ok: true, ast };
}

/** Every column the expression references, in order of first mention. */
export function referencedColumns(ast: FormulaNode): string[] {
  const out: string[] = [];
  const walk = (n: FormulaNode) => {
    if (n.t === 'col') { if (!out.includes(n.name)) out.push(n.name); return; }
    if (n.t === 'neg') { walk(n.a); return; }
    if (n.t === 'bin') { walk(n.a); walk(n.b); return; }
    if (n.t === 'fn') n.args.forEach(walk);
  };
  walk(ast);
  return out;
}

/**
 * Config-level validation: the expression parses AND every column it names is
 * one of the columns BEFORE it in the spec list (rows build left to right, so
 * a later column does not exist yet when this one evaluates). `allColumns` is
 * the full spec list, so a name that exists but is NOT earlier gets the
 * "not an earlier column" message rather than the misleading "unknown".
 * Returns the error to show, or null when the formula is usable.
 */
export function validateFormula(
  src: string, earlierColumns: string[], allColumns: string[] = earlierColumns,
): string | null {
  const p = parseFormula(src);
  if (!p.ok) return p.error;
  const earlier = new Set(earlierColumns);
  const all = new Set(allColumns);
  for (const name of referencedColumns(p.ast)) {
    if (!earlier.has(name)) {
      return all.has(name)
        ? `column "${name}" is not an earlier column — a formula can only reference columns to its left`
        : `unknown column "${name}"`;
    }
  }
  return null;
}

// ── Value helpers (the TS twin of datagen_formula.rs — keep in lockstep) ─────

/** A cell value as the evaluator sees it. */
export type FormulaValue = null | number | string | boolean;

/**
 * JavaScript's `String(n)` for a finite f64 — the form a number takes when it
 * is concatenated into a string. Kept as a function so the Rust port
 * (`js_num_str` in datagen_formula.rs) has one documented behaviour to match:
 * integral values print without a decimal point, everything else in shortest
 * round-trip form. (Beyond |1e21| the two tiers' exponential spellings differ;
 * that range is a pathological formula result, not data.)
 */
export function jsNumStr(n: number): string {
  return String(n);
}

/**
 * The STRICT string→number coercion for `- * / %`: a trim, then an optional
 * sign, digits with an optional fraction (or a bare fraction), an optional
 * exponent — and nothing else. `Number()` itself would also accept hex,
 * `Infinity` and the empty string (as 0), and Rust's `str::parse::<f64>`
 * accepts a different overlapping set ('inf', 'NaN'), so both engines gate on
 * this shape first and reject non-finite results — one defined behaviour.
 */
const STRICT_NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function toNumStrict(v: FormulaValue): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!STRICT_NUM_RE.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `Math.round` semantics — half towards +∞ — as one place the Rust port mirrors. */
export function jsRound(x: number): number {
  return Math.round(x);
}

/** Stringify for `||`/concat: numbers in JS form, strings as-is; booleans are a type error. */
function strOf(v: FormulaValue): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return jsNumStr(v);
  return null;
}

/** slugify: lowercase, runs of non-alphanumeric characters → '-', edges trimmed. */
function slugifyValue(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

/** Code-point slice for substr: 1-based `start` (clamped ≥ 1), `len` clamped ≥ 0. */
function substrValue(s: string, start: number, len?: number): string {
  const chars = [...s];
  const from = Math.max(1, Math.trunc(start)) - 1;
  if (len === undefined) return chars.slice(from).join('');
  const n = Math.max(0, Math.trunc(len));
  return chars.slice(from, from + n).join('');
}

// ── Evaluator ─────────────────────────────────────────────────────────────────

/** Internal type-error sentinel; `evalFormula` maps it to NULL at the top. */
const ERR = Symbol('formula-type-error');
type EV = FormulaValue | typeof ERR;

function evalNode(n: FormulaNode, get: (name: string) => unknown): EV {
  switch (n.t) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'col': {
      const v = get(n.name);
      // Anything outside the value model (undefined column, an object, …) is
      // a type error → NULL at the top, never a throw.
      return v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'
        ? v : ERR;
    }
    case 'neg': {
      const a = evalNode(n.a, get);
      if (a === ERR || a === null) return a;
      const x = toNumStrict(a);
      return x === null ? ERR : -x;
    }
    case 'bin': {
      const a = evalNode(n.a, get);
      if (a === ERR) return ERR;
      const b = evalNode(n.b, get);
      if (b === ERR) return ERR;
      if (a === null || b === null) return null;
      if (n.op === '||') {
        const sa = strOf(a), sb = strOf(b);
        return sa === null || sb === null ? ERR : sa + sb;
      }
      if (n.op === '+') {
        // Numbers add; a string on either side concatenates. Deterministic per
        // row, and the SQL emitter only claims the cases it can spell.
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        const sa = strOf(a), sb = strOf(b);
        return sa === null || sb === null ? ERR : sa + sb;
      }
      const x = toNumStrict(a), y = toNumStrict(b);
      if (x === null || y === null) return ERR;
      if (n.op === '-') return x - y;
      if (n.op === '*') return x * y;
      // `/` and `%` by zero are NULL (SQL via NULLIF), never JS Infinity/NaN.
      if (y === 0) return null;
      return n.op === '/' ? x / y : x % y;
    }
    case 'fn': {
      const args: EV[] = [];
      for (const an of n.args) {
        const v = evalNode(an, get);
        if (v === ERR) return ERR;
        args.push(v);
      }
      return applyFn(n.name, args as FormulaValue[]);
    }
  }
}

function applyFn(name: string, args: FormulaValue[]): EV {
  // NULL propagates; a type error is ERR. `toNumStrict` returns null for both,
  // so the wrappers disambiguate BEFORE calling it.
  const numArg = (v: FormulaValue): number | null | typeof ERR => {
    if (v === null) return null;
    const x = toNumStrict(v);
    return x === null ? ERR : x;
  };
  const strArg = (v: FormulaValue): string | null | typeof ERR => {
    if (v === null) return null;
    const s = strOf(v);
    return s === null ? ERR : s;
  };
  switch (name) {
    case 'abs': {
      const x = numArg(args[0]);
      return x === null || x === ERR ? x : Math.abs(x);
    }
    case 'round': {
      const x = numArg(args[0]);
      if (x === null || x === ERR) return x;
      const d = args.length > 1 ? numArg(args[1]) : 0;
      if (d === null || d === ERR) return d === ERR ? ERR : null;
      const f = 10 ** Math.max(0, Math.min(12, Math.trunc(d)));
      return jsRound(x * f) / f;
    }
    case 'floor': case 'ceil': {
      const x = numArg(args[0]);
      if (x === null || x === ERR) return x;
      return name === 'floor' ? Math.floor(x) : Math.ceil(x);
    }
    case 'min': case 'max': {
      let acc = name === 'min' ? Infinity : -Infinity;
      for (const v of args) {
        const x = numArg(v);
        if (x === ERR) return ERR;
        if (x === null) return null;   // NULL in → NULL out (MySQL LEAST semantics)
        acc = name === 'min' ? Math.min(acc, x) : Math.max(acc, x);
      }
      return acc;
    }
    case 'length': {
      const s = strArg(args[0]);
      return s === null || s === ERR ? s : [...s].length;   // code points, like Rust chars().count()
    }
    case 'upper': case 'lower': {
      const s = strArg(args[0]);
      if (s === null || s === ERR) return s;
      return name === 'upper' ? s.toUpperCase() : s.toLowerCase();
    }
    case 'substr': {
      const s = strArg(args[0]);
      if (s === null || s === ERR) return s;
      const start = numArg(args[1]);
      if (start === null || start === ERR) return start;
      if (args.length > 2) {
        const len = numArg(args[2]);
        if (len === null || len === ERR) return len;
        return substrValue(s, start, len);
      }
      return substrValue(s, start);
    }
    case 'coalesce': {
      for (const v of args) if (v !== null) return v;
      return null;
    }
    case 'slugify': {
      const s = strArg(args[0]);
      return s === null || s === ERR ? s : slugifyValue(s);
    }
    default: return ERR;   // unreachable: the parser whitelists names
  }
}

/**
 * Evaluate a parsed formula against the row's earlier values. `get(name)`
 * returns the value of column `name` (already generated this row); an unknown
 * name (undefined) — or any value outside the null/number/string/boolean
 * model — yields NULL. Any type error yields NULL — a defined per-cell
 * answer, never an exception into the writer loop.
 */
export function evalFormula(ast: FormulaNode, get: (name: string) => unknown): FormulaValue {
  const v = evalNode(ast, get);
  return v === ERR ? null : v;
}
