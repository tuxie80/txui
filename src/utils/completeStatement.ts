/**
 * Complete Current Statement — one chord that finishes the statement in hand:
 * close any quote/paren/comment left open, make sure the statement ends with
 * the delimiter, and land the caret on a fresh line below, ready for the next
 * one. The musical-end-of-typing gesture (DataGrip's ⌘⇧↵-style "Complete
 * Statement"), so a half-written `WHERE name = 'abc` becomes a runnable
 * statement without reaching for the end of the line.
 *
 * ## Semantics
 *
 * The unit of completion is the statement the caret sits in
 * (sqlSplit.statementAt) — not the text up to the caret. Completing only the
 * prefix would close a quote the caret merely stands AFTER (`SELECT 'done' |`
 * is balanced; scanning the whole statement is how we know). Unbalanced
 * constructs are read with sqlContext.unclosedAt — the same scanner behind
 * `endsInsideLiteral`, not a third copy of the quote/comment rules.
 *
 * Two placement rules worth knowing:
 *
 * - A statement that already ends with the delimiter gets nothing appended
 *   but the fresh line. The check runs on the comment/string-blanked text
 *   (sqlAlias.blank), so a `-- done;` comment tail cannot masquerade as a
 *   terminator.
 * - A statement whose tail is a LINE comment gets its delimiter on the next
 *   line — appending it directly would comment the delimiter out
 *   (`SELECT 1 -- note;` terminates nothing).
 *
 * Pure: no React/Tauri imports — `node --test` covers it.
 */
import { statementAt } from './sqlSplit.ts';
import { unclosedAt } from './sqlContext.ts';
import { blank } from './sqlAlias.ts';

export interface CompleteEdit {
  from: number;
  to: number;
  insert: string;
}

export interface CompleteStatementResult {
  /** A single insertion at the statement's end — empty when there is nothing to do. */
  edits: CompleteEdit[];
  /** Where the caret lands after the edits are applied (post-edit offsets). */
  caret: number;
}

/**
 * The edits that complete the statement under `pos`.
 *
 * A no-op (empty edits, caret unmoved) when there is no statement to complete —
 * an empty buffer, or a caret sitting in a comment-only region: turning a
 * trailing `-- note` into `-- note\n;` would plant a stray empty statement.
 */
export function completeStatement(
  text: string, pos: number, delimiter = ';',
): CompleteStatementResult {
  const delim = delimiter.trim() || ';';
  const noop: CompleteStatementResult = { edits: [], caret: pos };

  const stmt = statementAt(text, pos, delim);
  if (!stmt || !stmt.text.trim()) return noop;
  // A comment-only "statement" (the splitter emits comment runs as statements)
  // has nothing to terminate.
  if (!blank(stmt.text).trim()) return noop;

  // Close what is still open, innermost first: the quote, then the parens,
  // then a block comment. A line comment cannot be "closed" — it runs to the
  // end of the line — so the delimiter must start on a fresh line instead.
  const u = unclosedAt(stmt.text);
  let insert = '';
  if (u.quote) insert += u.quote;
  if (u.parens > 0) insert += ')'.repeat(u.parens);
  if (u.comment === 'block') insert += '*/';
  if (u.comment === 'line') insert += '\n';

  // Terminate, unless the statement already ends with the delimiter outside
  // any string/comment.
  if (!blank(stmt.text).trimEnd().endsWith(delim)) insert += delim;

  // Land the caret on a fresh line below the statement. When the statement is
  // already followed by a blank line, reuse it instead of piling up empties.
  const after = text.slice(stmt.to);
  const reuse = /^\r?\n[ \t]*(?:\r?\n|$)/.exec(after);
  let caret: number;
  if (reuse) {
    // `\n…` (possibly through one whitespace-only line) already leads to a
    // blank line: caret at the start of the line right after the statement.
    caret = stmt.to + insert.length + (reuse[0].startsWith('\r') ? 2 : 1);
  } else {
    insert += '\n';
    caret = stmt.to + insert.length;
  }

  return { edits: [{ from: stmt.to, to: stmt.to, insert }], caret };
}

/** Apply the result to `text` (tests, and any non-CodeMirror caller). */
export function applyCompletion(
  text: string, result: CompleteStatementResult,
): { text: string; caret: number } {
  let out = text;
  // Right-to-left so earlier offsets stay valid — there is only ever one edit
  // today, but the shape is a list on purpose.
  for (const e of [...result.edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return { text: out, caret: result.caret };
}
