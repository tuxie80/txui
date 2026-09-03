/**
 * Structural query refactors, beyond the single-statement alias rename in
 * renameSymbol.ts:
 *   - wrap the current statement (or selection) in an outer SELECT,
 *   - extract a selected subquery into a CTE and reference it by name.
 *
 * Text transforms, deliberately not a full parser: they reshape the buffer and
 * leave the result for the user to review before running. Statement bounds come
 * from sqlSplit's statementAtCaret so a refactor stays inside one statement.
 */
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { statementAtCaret } from './sqlSplit.ts';
import { blank } from './sqlAlias.ts';
import { selectListColumns, selectListEntries } from './sqlContext.ts';

const indent = (s: string) => s.trim().split('\n').map(l => `  ${l}`).join('\n');

/** Wrap the current statement (or the selection, if any) in `SELECT * FROM (…) AS sub`. */
export function wrapInSubquery(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  let from: number, to: number, inner: string;
  if (!sel.empty) {
    from = sel.from; to = sel.to; inner = state.sliceDoc(from, to);
  } else {
    const stmt = statementAtCaret(state.doc.toString(), sel.head);
    if (!stmt) return false;
    from = stmt.from; to = stmt.to; inner = stmt.text;
  }
  if (!inner.trim()) return false;
  const wrapped = `SELECT *\nFROM (\n${indent(inner)}\n) AS sub`;
  view.dispatch(state.update({
    changes: { from, to, insert: wrapped },
    selection: EditorSelection.cursor(from + wrapped.length),
    userEvent: 'input',
  }));
  return true;
}

/**
 * Extract the selected subquery into a CTE. Replaces the selection with a CTE
 * name and either prepends a new `WITH` to the statement or splices into an
 * existing one. Requires a non-empty selection.
 */
export function extractCte(view: EditorView, cteName = 'cte_1'): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.empty) return false;
  const selected = state.sliceDoc(sel.from, sel.to).trim();
  if (!selected) return false;
  const stmt = statementAtCaret(state.doc.toString(), sel.head);
  if (!stmt) return false;

  const body = indent(selected);
  const changes: { from: number; to?: number; insert: string }[] = [
    { from: sel.from, to: sel.to, insert: cteName },
  ];
  const withMatch = /^\s*WITH\s+(RECURSIVE\s+)?/i.exec(stmt.text);
  if (withMatch) {
    // Splice into the existing WITH list, right after `WITH [RECURSIVE] `.
    changes.push({ from: stmt.from + withMatch[0].length, insert: `${cteName} AS (\n${body}\n),\n` });
  } else {
    changes.push({ from: stmt.from, insert: `WITH ${cteName} AS (\n${body}\n)\n` });
  }
  view.dispatch(state.update({ changes, userEvent: 'input' }));
  return true;
}

// ── statement transforms: SELECT → INSERT/CTAS/CVIEW/DELETE/UPDATE ──────────
// The DBA workflow these serve is well-worn: preview rows with a SELECT, then
// turn it into the statement that ACTS on those rows. Text transforms like
// wrap/extract above — the result lands in the buffer for review, never runs
// by itself.

export interface SelectParts {
  /** The statement text, trimmed, trailing semicolons stripped. */
  select: string;
  /** First top-level FROM target, as written (quoting/qualification kept). */
  table: string | null;
  /** Its bare last segment (quotes stripped) — used for generated names. */
  tableShort: string | null;
  /**
   * Select-list output names (AS alias wins, else the last dotted segment;
   * expressions without an alias are skipped — utils/sqlContext's rule).
   */
  columns: string[];
  hasStar: boolean;
  /** Top-level WHERE clause text (keyword excluded), null when absent. */
  where: string | null;
}

const IDENT = '(?:[A-Za-z_][\\w$]*|`[^`]*`|"[^"]*")';
const TABLE_RE = new RegExp(`^${IDENT}(?:\\s*\\.\\s*${IDENT})*`);

/** Clause keywords recognized at the top level (everything else ends a WHERE). */
const CLAUSE_WORD_RE =
  /^(from|where|group\s+by|having|order\s+by|limit|offset|union|intersect|except|window|fetch|for|into|lock|procedure)\b/i;

/** Top-level clause keywords of a blanked statement, in order. */
function topLevelClauses(s: string): { word: string; at: number; len: number }[] {
  const out: { word: string; at: number; len: number }[] = [];
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth--; i++; continue; }
    if (depth === 0 && /[A-Za-z]/.test(c) && (i === 0 || !/[\w$]/.test(s[i - 1]))) {
      const m = CLAUSE_WORD_RE.exec(s.slice(i));
      if (m) {
        out.push({ word: m[1].toLowerCase().replace(/\s+/g, ' '), at: i, len: m[0].length });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * Parse a plain SELECT into the pieces the transforms need. Returns null —
 * and the editor hides the menu entries — for anything else, and for
 * set-operation queries (`UNION`/`INTERSECT`/`EXCEPT`): those have no single
 * FROM/WHERE shape, and a DELETE whose WHERE silently stopped at the UNION is
 * exactly the accident this feature exists to prevent.
 */
export function parseSelect(text: string): SelectParts | null {
  const select = text.trim().replace(/;+\s*$/, '');
  const s = blank(select);
  if (!/^\s*select\s/i.test(s)) return null;

  const clauses = topLevelClauses(s);
  if (clauses.some(c => c.word === 'union' || c.word === 'intersect' || c.word === 'except')) {
    return null;
  }
  const entries = selectListEntries(s);
  if (!entries) return null;

  // First top-level FROM → its target, as written. A `FROM (` is a derived
  // table — there is no name to act on.
  const fromClause = clauses.find(c => c.word === 'from');
  let table: string | null = null;
  if (fromClause) {
    const rest = select.slice(fromClause.at + fromClause.len).trimStart();
    if (!rest.startsWith('(')) {
      table = TABLE_RE.exec(rest)?.[0] ?? null;
    }
  }
  const tableShort = table
    ? (table.replace(/[`"]/g, '').split('.').pop() ?? null)
    : null;

  // Top-level WHERE → its text, up to the next clause keyword.
  const whereClause = clauses.find(c => c.word === 'where');
  let where: string | null = null;
  if (whereClause) {
    const start = whereClause.at + whereClause.len;
    const end = clauses.find(c => c.at > whereClause.at)?.at ?? s.length;
    where = select.slice(start, end).trim() || null;
  }

  return {
    select,
    table,
    tableShort,
    columns: selectListColumns(s),
    hasStar: entries.hasStar,
    where,
  };
}

/**
 * SELECT → `INSERT INTO <from-table> (<select-list cols>) <select>`.
 * `SELECT *` (or a list of bare expressions) omits the column list — invented
 * names would be fiction; the table's own order is the only honest reading.
 */
export function selectToInsert(text: string): string | null {
  const p = parseSelect(text);
  if (!p || !p.table) return null;
  const cols = p.hasStar || p.columns.length === 0 ? '' : ` (${p.columns.join(', ')})`;
  return `INSERT INTO ${p.table}${cols}\n${p.select}`;
}

/**
 * SELECT → `CREATE TABLE <name> AS <select>`. Name convention: the source
 * table plus `_copy` (`new_table` when there is no FROM) — visibly a scratch
 * name you rename before running, never the live table itself.
 */
export function selectToCreateTable(text: string): string | null {
  const p = parseSelect(text);
  if (!p) return null;
  return `CREATE TABLE ${p.tableShort ? `${p.tableShort}_copy` : 'new_table'} AS\n${p.select}`;
}

/** SELECT → `CREATE VIEW <name> AS <select>` — same convention, `_v` suffix. */
export function selectToCreateView(text: string): string | null {
  const p = parseSelect(text);
  if (!p) return null;
  return `CREATE VIEW ${p.tableShort ? `${p.tableShort}_v` : 'new_view'} AS\n${p.select}`;
}

/**
 * SELECT → `DELETE FROM <table> WHERE <same where>` — the preview-then-delete
 * workflow: run the SELECT, check the rows, transform, run the DELETE on
 * exactly those rows. Without a WHERE there is nothing to inherit, so the
 * bare `DELETE FROM t` is what you get — the prod guards still apply when run.
 */
export function selectToDelete(text: string): string | null {
  const p = parseSelect(text);
  if (!p || !p.table) return null;
  return `DELETE FROM ${p.table}` + (p.where ? `\nWHERE ${p.where}` : '');
}

/**
 * SELECT → an UPDATE skeleton over the same table and WHERE. The SET target
 * is the first select-list column and its value a NULL-with-comment
 * placeholder — a skeleton to edit, not a statement to run as-is.
 */
export function selectToUpdate(text: string): string | null {
  const p = parseSelect(text);
  if (!p || !p.table || p.columns.length === 0) return null;
  return `UPDATE ${p.table}\nSET ${p.columns[0]} = NULL /* := value */`
    + (p.where ? `\nWHERE ${p.where}` : '');
}

/**
 * Apply a statement transform (the selectTo* family) to the selection — or to
 * the statement at the caret when there is none — replacing the text. Returns
 * false when the transform refuses (the statement is not a plain SELECT), so
 * the keymap/menu path stays silent rather than rewriting anything.
 */
export function transformStatement(
  view: EditorView,
  fn: (text: string) => string | null,
  delimiter = ';',
): boolean {
  const { state } = view;
  const sel = state.selection.main;
  let from: number, to: number, inner: string;
  if (!sel.empty) {
    from = sel.from; to = sel.to; inner = state.sliceDoc(from, to);
  } else {
    const stmt = statementAtCaret(state.doc.toString(), sel.head, delimiter);
    if (!stmt) return false;
    from = stmt.from; to = stmt.to; inner = stmt.text;
  }
  const next = fn(inner);
  if (next == null) return false;
  view.dispatch(state.update({
    changes: { from, to, insert: next },
    selection: EditorSelection.cursor(from + next.length),
    userEvent: 'input',
  }));
  return true;
}
