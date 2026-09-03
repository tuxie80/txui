/**
 * Structural search & replace — match SQL by SHAPE, not by spelling.
 *
 * A pattern is ordinary SQL with `$holes$`: `SELECT * FROM $t$ WHERE $c$ = NULL`
 * finds that shape no matter which table, which condition text, or how it is
 * capitalised and commented. This is the pragmatic comby-lite version: no AST,
 * no grammar — both pattern and document are reduced to a TOKEN STREAM by the
 * same tokenizer, and matching is token-for-token with holes as wildcards.
 *
 * ## Tokenization (the hard part, stated precisely)
 *
 * - Whitespace is not a token. Comments (line `--`/`#` and block) are not
 *   tokens either — a comment anywhere in the document can never break a
 *   match, and `ORDER (block comment here) BY` still matches `ORDER BY`.
 * - Strings are single tokens (`'a;b'` included — the semicolon inside a
 *   string is NOT a statement boundary). A string token only equals a string
 *   token: the pattern word `active` does not match the doc literal
 *   `'active'`. String comparison is case-insensitive like everything else.
 * - Quoted identifiers (backtick- or double-quote-wrapped) and bare words are
 *   the same token kind, compared by content — a quoted `orders` in the
 *   document matches the pattern's bare `orders`.
 * - Everything else (operators, parens, commas) is a single-character token.
 *   A two-char operator tokenizes as two one-char tokens on BOTH sides of the
 *   comparison, so they still meet.
 * - PostgreSQL dollar-quoted bodies are searched as ordinary text. In
 *   PATTERNS, `$name$` is reserved for holes — a pattern cannot search for a
 *   literal dollar-quoted tag.
 *
 * ## Hole grammar (deliberately small)
 *
 * A hole `$name$` captures the SHORTEST run of document tokens that lets the
 * rest of the pattern match, subject to: at least one token; the run never
 * contains `;` (a hole is an expression fragment, not a statement list); and
 * the run is parenthesis-balanced — its running depth never goes negative and
 * ends at zero, so a hole may capture `g(a, b)` but never `g(a`. Repeating a
 * hole name in one pattern requires the same text again, case-insensitively
 * (`$x$ = $x$` matches `a = a`, not `a = b`). A trailing hole captures its
 * minimum — one token — because nothing after it forces it wider.
 *
 * ## Match policy
 *
 * Matches never overlap: after a match the scan resumes at the token
 * following the match's end (`$a$ = $b$` finds `x = y` in `x = y = z`, and
 * does not then find `y = z`). A pattern with no holes degrades to a plain
 * token search — case-insensitive, comment- and string-aware.
 *
 * Pure: no React/Tauri imports — `node --test` covers it.
 */

export interface StructMatch {
  /** Document offsets covering the whole match (first to last matched token). */
  from: number;
  to: number;
  /** Hole name → the exact document text it captured. */
  captures: Record<string, string>;
}

// ── tokenizer ────────────────────────────────────────────────────────────────

interface Tok {
  from: number;
  to: number;
  /**
   * Comparison key: words/quoted identifiers by lowercased CONTENT (quotes
   * stripped), strings by their full lowercased text (quotes kept, so a
   * string can never equal a word), punctuation as the character itself.
   */
  norm: string;
  kind: 'word' | 'string' | 'punct';
}

function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';
    if (/\s/.test(ch)) { i++; continue; }
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*' + '/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === q) {
          if (j + 1 < n && sql[j + 1] === q) { j += 2; continue; } // doubled = escape
          closed = true; j++; break;
        }
        j++;
      }
      j = Math.min(j, n);
      if (q === "'") {
        // A string literal: keep the quotes in the key so it can only ever
        // equal another string.
        out.push({ from: i, to: j, norm: sql.slice(i, j).toLowerCase(), kind: 'string' });
      } else {
        // A quoted identifier: compare by content, so it meets its bare twin.
        const inner = sql.slice(i + 1, closed ? j - 1 : j);
        out.push({ from: i, to: j, norm: inner.toLowerCase(), kind: 'word' });
      }
      i = j;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      out.push({ from: i, to: j, norm: sql.slice(i, j).toLowerCase(), kind: 'word' });
      i = j;
      continue;
    }
    out.push({ from: i, to: i + 1, norm: ch, kind: 'punct' });
    i++;
  }
  return out;
}

// ── pattern parsing ──────────────────────────────────────────────────────────

interface PatHole { hole: string }
type PatItem = Tok | PatHole;

const HOLE_RE = /\$([A-Za-z_]\w*)\$/g;

/** Split the pattern on `$hole$` markers; the literal chunks tokenize like any SQL. */
function parsePattern(pattern: string): PatItem[] {
  const items: PatItem[] = [];
  HOLE_RE.lastIndex = 0;
  let last = 0;
  for (let m; (m = HOLE_RE.exec(pattern)) !== null;) {
    items.push(...tokenize(pattern.slice(last, m.index)));
    items.push({ hole: m[1] });
    last = m.index + m[0].length;
  }
  items.push(...tokenize(pattern.slice(last)));
  return items;
}

// ── matching ─────────────────────────────────────────────────────────────────

function isHole(p: PatItem): p is PatHole {
  return (p as PatHole).hole !== undefined;
}

function tokEq(p: Tok, d: Tok): boolean {
  return p.kind === d.kind && p.norm === d.norm;
}

/** Case-insensitive comparison key for a token run (repeated-hole equality). */
function normRun(doc: Tok[], fromIdx: number, toIdx: number): string {
  let out = '';
  for (let i = fromIdx; i < toIdx; i++) out += doc[i].kind + ':' + doc[i].norm + ' ';
  return out;
}

/**
 * Try to match the whole pattern starting at document token `start`.
 * Returns the end token index (exclusive) and the captures as token ranges.
 */
function matchAt(
  pat: PatItem[], doc: Tok[], start: number,
): { end: number; caps: [string, number, number][] } | null {
  const caps: [string, number, number][] = [];

  const rec = (pi: number, di: number): number => {
    if (pi === pat.length) return di;
    const p = pat[pi];
    if (!isHole(p)) {
      if (di >= doc.length || !tokEq(p, doc[di])) return -1;
      return rec(pi + 1, di + 1);
    }
    // Hole: extend the run one token at a time (shortest first), trying the
    // rest of the pattern at each balanced stopping point.
    let depth = 0;
    for (let len = 1; di + len <= doc.length; len++) {
      const t = doc[di + len - 1];
      if (t.kind === 'punct') {
        if (t.norm === ';') break;          // a hole never crosses a statement end
        if (t.norm === '(') depth++;
        else if (t.norm === ')') { depth--; if (depth < 0) break; }
      }
      if (depth !== 0) continue;            // inside parens — not a stopping point
      // A repeated hole name must capture the same text again.
      const prior = caps.find(c => c[0] === p.hole);
      if (prior && normRun(doc, prior[1], prior[2]) !== normRun(doc, di, di + len)) continue;
      caps.push([p.hole, di, di + len]);
      const rest = rec(pi + 1, di + len);
      if (rest >= 0) return rest;
      caps.pop();
    }
    return -1;
  };

  const end = rec(0, start);
  return end < 0 ? null : { end, caps };
}

/** Pathological inputs get nothing rather than a slow scan — this runs on a live editor. */
const MAX_DOC_CHARS = 300_000;

/**
 * All non-overlapping matches of `pattern` in `doc`, in document order.
 * An empty pattern (no tokens, no holes) matches nothing.
 */
export function structuralSearch(doc: string, pattern: string): StructMatch[] {
  if (doc.length > MAX_DOC_CHARS) return [];
  const pat = parsePattern(pattern);
  if (pat.length === 0) return [];
  const docToks = tokenize(doc);
  const out: StructMatch[] = [];
  let i = 0;
  while (i < docToks.length) {
    const m = matchAt(pat, docToks, i);
    if (!m) { i++; continue; }
    const captures: Record<string, string> = {};
    for (const [name, a, b] of m.caps) {
      captures[name] = doc.slice(docToks[a].from, docToks[b - 1].to);
    }
    out.push({ from: docToks[i].from, to: docToks[m.end - 1].to, captures });
    i = m.end; // non-overlapping: resume AFTER the match, never inside it
  }
  return out;
}

// ── replace ──────────────────────────────────────────────────────────────────

/**
 * Fill a replace template: each `$hole$` that the match captured becomes its
 * captured text. A hole the pattern never captured is left AS-IS (`$name$`
 * stays in the output) — silently deleting it would hide a typo in the
 * template, and inventing text for it is impossible.
 */
export function substituteTemplate(template: string, captures: Record<string, string>): string {
  HOLE_RE.lastIndex = 0;
  return template.replace(HOLE_RE, (raw, name: string) =>
    Object.prototype.hasOwnProperty.call(captures, name) ? captures[name] : raw);
}

/**
 * Replace every match of `pattern` in `doc` with its filled `template`.
 * Same match policy as structuralSearch: non-overlapping, document order.
 */
export function structuralReplace(
  doc: string, pattern: string, template: string,
): { text: string; count: number } {
  const matches = structuralSearch(doc, pattern);
  let out = doc;
  for (let k = matches.length - 1; k >= 0; k--) {
    const m = matches[k];
    out = out.slice(0, m.from) + substituteTemplate(template, m.captures) + out.slice(m.to);
  }
  return { text: out, count: matches.length };
}
