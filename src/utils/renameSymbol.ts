/**
 * Scope-aware rename of a table ALIAS or CTE name inside a SINGLE SQL statement.
 *
 * Safety is the whole point: a rename that rewrites the wrong text corrupts a
 * script. So the scope is deliberately tight — only whole-word occurrences of
 * the identifier that actually names an alias/CTE *defined in this statement*
 * are touched. Never text inside strings/comments (masked via `blank()`),
 * never a longer identifier that merely contains the name, and never the column
 * part of a `something.name` qualifier (which belongs to a different alias).
 *
 * When the caret is not on a renameable alias/CTE — a table name, a keyword, a
 * bare column, a string/comment — the function returns null and nothing moves.
 */
import { blank, findAliases } from './sqlAlias.ts';
import { findVirtualTables } from './sqlContext.ts';

const IDENT_RE = /^[A-Za-z_][\w$]*$/;

function isIdentChar(c: string): boolean {
  return c !== '' && /[A-Za-z0-9_$]/.test(c);
}

function bareName(table: string): string {
  return (table.split('.').pop() ?? table).toLowerCase();
}

export interface RenameResult {
  text: string;
}

/**
 * Rename the alias/CTE under `offset` (an index into `statementText`) to
 * `newName`, returning the rewritten statement — or null when the caret isn't
 * on a renameable alias/CTE or `newName` is not a legal identifier.
 */
export function renameAliasAt(
  statementText: string,
  offset: number,
  newName: string,
): RenameResult | null {
  if (!IDENT_RE.test(newName)) return null;

  const len = statementText.length;
  if (offset < 0 || offset > len) return null;

  // Mask strings/comments so the caret and matches never land inside a literal.
  const masked = blank(statementText);

  // Identify the identifier under the caret. A caret sitting just after a word
  // (offset === word end) still counts.
  let probe = -1;
  if (offset < len && isIdentChar(masked[offset])) probe = offset;
  else if (offset > 0 && isIdentChar(masked[offset - 1])) probe = offset - 1;
  if (probe < 0) return null;

  let start = probe;
  while (start > 0 && isIdentChar(masked[start - 1])) start--;
  let end = probe;
  while (end < len && isIdentChar(masked[end])) end++;

  const ident = statementText.slice(start, end);
  if (!IDENT_RE.test(ident)) return null; // e.g. a numeric literal

  // If the caret's identifier is the column part after a dot (`x.ident`), it is
  // NOT an alias here — refuse rather than guess.
  if (start > 0 && masked[start - 1] === '.') return null;

  const lower = ident.toLowerCase();

  // Confirm the identifier is a real alias (not merely a bare table name that
  // findAliases also records) or a CTE name defined in this statement.
  const aliases = findAliases(statementText);
  const aliasTable = aliases.get(lower);
  let renameable = aliasTable !== undefined && lower !== bareName(aliasTable);
  if (!renameable) {
    const vt = findVirtualTables(statementText).get(lower);
    if (vt && vt.kind === 'cte') renameable = true;
  }
  if (!renameable) return null;

  // Replace every whole-word occurrence of the identifier that is a real
  // reference: masked (so nothing inside strings/comments matches), not inside
  // a longer identifier, and not the column part after a `.` qualifier.
  let out = '';
  let last = 0;
  let i = 0;
  while (i < len) {
    if (isIdentChar(masked[i]) && (i === 0 || !isIdentChar(masked[i - 1]))) {
      let j = i;
      while (j < len && isIdentChar(masked[j])) j++;
      const word = statementText.slice(i, j);
      const prev = i > 0 ? masked[i - 1] : '';
      if (word.toLowerCase() === lower && prev !== '.') {
        out += statementText.slice(last, i) + newName;
        last = j;
      }
      i = j;
    } else {
      i++;
    }
  }
  out += statementText.slice(last);

  return { text: out };
}
