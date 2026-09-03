/**
 * Lightweight SQL statement splitter — string/comment/quote aware.
 * Handles: 'strings' (with '' and \' escapes), "quoted idents", `backticks`,
 * `--` line comments, `#` line comments (MySQL), block comments,
 * PostgreSQL dollar-quoting ($$ … $$, $tag$ … $tag$), and the MySQL
 * `DELIMITER` directive. Good enough for run-at-caret; not a full parser.
 */

export interface Statement {
  from: number;   // doc offset of first char
  to: number;     // doc offset AFTER last char (semicolon included)
  text: string;
}

/**
 * Does the delimiter at `i` stand on its own?
 *
 * Only word-like delimiters need this. `GO` is a real terminator (T-SQL, and
 * the setting allows it), but a bare `startsWith` also fires inside `GOODS`
 * and would cut a statement in half mid-identifier. Punctuation delimiters
 * such as `;` or `/` can never be part of a word, so they always fit.
 */
function delimiterFits(doc: string, i: number, delim: string): boolean {
  const wordish = /\w/;
  if (wordish.test(delim[0]) && i > 0 && wordish.test(doc[i - 1])) return false;
  const after = i + delim.length;
  if (wordish.test(delim[delim.length - 1]) && after < doc.length && wordish.test(doc[after])) {
    return false;
  }
  return true;
}

/**
 * Split `doc` into statements.
 *
 * `delimiter` is the terminator to start with — `;` for every normal dialect,
 * but Settings → Editor can change it for scripts that use something else, and
 * a MySQL `DELIMITER` directive in the text still overrides it from that point
 * on. An empty or whitespace delimiter falls back to `;`: it would otherwise
 * match at every offset and split the document into nothing.
 */
export function splitStatements(doc: string, delimiter = ';'): Statement[] {
  const out: Statement[] = [];
  const n = doc.length;
  let i = 0;
  let start = 0;
  let delim = delimiter.trim() || ';';   // DELIMITER directive can change this mid-script

  const push = (end: number) => {
    const raw = doc.slice(start, end);
    const lead = raw.search(/\S/);
    if (lead >= 0) {
      const endLen = raw.replace(/\s+$/, '').length;
      out.push({ from: start + lead, to: start + endLen, text: raw.slice(lead, endLen) });
    }
    start = end;
  };

  while (i < n) {
    const ch = doc[i];
    const next = i + 1 < n ? doc[i + 1] : '';

    // MySQL DELIMITER directive (line-start, client-side): changes the
    // terminator and is itself not part of any statement.
    if ((i === 0 || doc[i - 1] === '\n') && /^delimiter[ \t]+\S/i.test(doc.slice(i, i + 40))) {
      const eol = doc.indexOf('\n', i);
      const lineEnd = eol === -1 ? n : eol;
      const m = /^delimiter[ \t]+(\S+)/i.exec(doc.slice(i, lineEnd));
      push(i);                       // close anything before the directive
      if (m) delim = m[1];
      i = lineEnd === n ? n : lineEnd + 1;
      start = i;                     // the directive line is not emitted
      continue;
    }

    // custom delimiter boundary
    if (delim !== ';' && doc.startsWith(delim, i) && delimiterFits(doc, i, delim)) {
      push(i + delim.length);
      i += delim.length;
      continue;
    }

    // line comments
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = doc.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // block comment
    if (ch === '/' && next === '*') {
      const end = doc.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // single-quoted string
    if (ch === "'") {
      i++;
      while (i < n) {
        if (doc[i] === '\\') { i += 2; continue; }
        if (doc[i] === "'") {
          if (i + 1 < n && doc[i + 1] === "'") { i += 2; continue; } // '' escape
          i++; break;
        }
        i++;
      }
      continue;
    }
    // double-quoted identifier / string. `""` is the SQL-standard doubling
    // escape for a literal quote inside the identifier, so it does not close.
    if (ch === '"') {
      i++;
      while (i < n) {
        if (doc[i] === '\\') { i += 2; continue; }
        if (doc[i] === '"') {
          if (i + 1 < n && doc[i + 1] === '"') { i += 2; continue; } // "" escape
          i++; break;
        }
        i++;
      }
      continue;
    }
    // backtick identifier (MySQL). `` `` `` doubles to a literal backtick.
    if (ch === '`') {
      i++;
      while (i < n) {
        if (doc[i] === '`') {
          if (i + 1 < n && doc[i + 1] === '`') { i += 2; continue; } // `` escape
          i++; break;
        }
        i++;
      }
      continue;
    }
    // dollar quoting (PG): $$ or $tag$
    if (ch === '$') {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(doc.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = doc.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    // statement boundary (only ';' when it is the active delimiter)
    if (ch === ';' && delim === ';') {
      push(i + 1);
      i++;
      continue;
    }
    i++;
  }
  push(n); // trailing statement without semicolon

  return out;
}

/**
 * Doc offset of a statement's first CODE character: `from` advanced past
 * leading whitespace AND leading `--`, `#` and block comments (several,
 * in any order). `/*+` optimizer hints and `/*!` MySQL conditional comments
 * are NOT skipped — the server executes them, so they count as code (the
 * same rule firstKeywordText in sqlGuard.ts applies to keyword scanning).
 * A statement whose text is nothing but comments falls back to the first
 * non-whitespace character, so the offset always lands on a real character.
 * Used for anchor math (run-marker gutter, statement navigation) — never for
 * deciding what text executes.
 */
export function firstCodeOffset(stmt: { from: number; text: string }): number {
  const t = stmt.text;
  const wsOnly = stmt.from + (t.length - t.trimStart().length);
  let i = 0;
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t.startsWith('--', i) || t.startsWith('#', i)) {
      const nl = t.indexOf('\n', i);
      if (nl === -1) return wsOnly;             // comment runs to the end: comment-only
      i = nl + 1;
    } else if (t.startsWith('/*', i) && !t.startsWith('/*+', i) && !t.startsWith('/*!', i)) {
      const end = t.indexOf('*/', i + 2);
      if (end === -1) return wsOnly;            // unterminated comment: comment-only
      i = end + 2;
    } else {
      break;
    }
  }
  return i >= t.length ? wsOnly : stmt.from + i;
}

/**
 * Keywords that can begin a top-level statement. Used to tell a genuine
 * blank-line-separated statement boundary (a pasted dump: `SHOW CREATE …`
 * blank line `SELECT …`) from a blank line left *inside* one statement for
 * readability (`SELECT a, b` blank line `FROM t`, where `FROM` continues the
 * SELECT). Only the former may be narrowed; the latter must stay whole.
 */
// `with` is deliberately absent: a `WITH …` CTE block is never a complete
// statement on its own — its main query follows (often after a blank line), so
// a leading `WITH` must keep the statement whole rather than narrow to itself.
const STATEMENT_START = new RegExp(
  '^(?:select|insert|update|delete|replace|merge|values|table|call|exec(?:ute)?|do|' +
  'create|alter|drop|truncate|rename|comment|' +
  'show|explain|describe|desc|analyze|analyse|vacuum|optimize|repair|check|checksum|reindex|cluster|' +
  'set|reset|use|begin|start|commit|rollback|savepoint|release|lock|unlock|' +
  'grant|revoke|prepare|deallocate|declare|fetch|open|close|' +
  'load|copy|import|export|pragma|attach|detach|flush|kill|reset|handler|' +
  'insert\\s+ignore)\\b',
  'i',
);

/** Does this block look like the start of a new statement (not a continuation)? */
function looksLikeStatementStart(text: string): boolean {
  return STATEMENT_START.test(text.replace(/^[\s(]+/, ''));
}

/**
 * What ⌘↵ runs with no selection. Semicolon statements first; if the caret's
 * statement spans several BLANK-LINE-separated blocks that each independently
 * begin a statement (e.g. a pasted SHOW CREATE dump followed by a query, with
 * no semicolons between them), narrow to the block under the caret. A blank
 * line left *inside* one statement for readability is NOT a boundary — if any
 * block reads as a clause continuation (`FROM …`, `WHERE …`), the statement is
 * returned whole, so ⌘↵ never runs a fragment.
 */
export function statementAtCaret(doc: string, pos: number, delimiter = ';'): Statement | null {
  const stmt = statementAt(doc, pos, delimiter);
  if (!stmt) return null;
  if (!/\n[ \t]*\n/.test(stmt.text)) return stmt; // single block — done

  // split the statement's span on blank lines, keeping absolute offsets
  const blocks: Statement[] = [];
  const re = /\n[ \t]*\n/g;
  let start = stmt.from;
  let m: RegExpExecArray | null;
  const region = doc.slice(stmt.from, stmt.to);
  re.lastIndex = 0;
  while ((m = re.exec(region)) !== null) {
    const end = stmt.from + m.index;
    const text = doc.slice(start, end).trim();
    if (text) {
      const lead = doc.slice(start, end).search(/\S/);
      blocks.push({ from: start + lead, to: start + doc.slice(start, end).replace(/\s+$/, '').length, text });
    }
    start = stmt.from + re.lastIndex;
  }
  const tail = doc.slice(start, stmt.to).trim();
  if (tail) {
    const lead = doc.slice(start, stmt.to).search(/\S/);
    blocks.push({ from: start + lead, to: start + doc.slice(start, stmt.to).replace(/\s+$/, '').length, text: tail });
  }
  // Only treat the blank lines as boundaries when every block independently
  // begins a statement. Otherwise a blank line inside one statement (a select
  // list separated from its FROM, say) would make ⌘↵ run a fragment — so the
  // statement is returned whole instead.
  if (blocks.length < 2 || !blocks.every(b => looksLikeStatementStart(b.text))) return stmt;
  // block under caret, else the last block that ends at/before caret
  for (const b of blocks) if (pos >= b.from && pos <= b.to) return b;
  let prev = blocks[0] ?? stmt;
  for (const b of blocks) { if (b.to <= pos) prev = b; else break; }
  return prev;
}

/**
 * The statement containing `pos` (caret offset). When the caret sits in the
 * whitespace/comments between two statements, the previous statement wins —
 * matches the "run what I just typed" intuition.
 */
export function statementAt(doc: string, pos: number, delimiter = ';'): Statement | null {
  const stmts = splitStatements(doc, delimiter);
  if (stmts.length === 0) return null;
  for (const s of stmts) {
    if (pos >= s.from && pos <= s.to) return s;
  }
  // caret past the last statement's end (trailing whitespace)
  let prev: Statement | null = null;
  for (const s of stmts) {
    if (s.to <= pos) prev = s;
    else break;
  }
  return prev ?? stmts[0];
}
