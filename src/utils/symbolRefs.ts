/**
 * Semantic symbol reference highlighting — where does the identifier under the
 * caret actually bind, and where is it used?
 *
 * The editor already has TEXTUAL occurrence highlighting
 * (utils/occurrenceHighlight.ts): every word that spells the same, including
 * the one inside a string literal and the same-named column of the other
 * table. That is the right tool for "where does this word appear" and the
 * wrong one for "where does this SYMBOL live" — reading a join, the second
 * question is the one being asked.
 *
 * This module answers it by REUSING the rename classifier
 * (utils/renameRefactor.ts): renameTargetAt resolves what sits under the caret
 * (table / column / alias / CTE), planRename classifies every occurrence of
 * that name as provably-the-same-symbol (`definite`) or merely plausible
 * (`review`). Highlighting keeps only the `definite` set — the same standard
 * the rename applies before it dares rewrite text. With no schema metadata
 * (the editor paints synchronously; a server round-trip per caret move is out
 * of the question), bare-column occurrences degrade to `review` and simply
 * are not highlighted — honest rather than wrong.
 *
 * ## Scope
 *
 * Only the CURRENT STATEMENT is analysed. That covers tables, columns and
 * aliases, which are statement-local by definition, and CTEs too: a `WITH`
 * block and its main query are one statement to the splitter, and SQL gives a
 * CTE no meaning outside it — statement scope and buffer scope coincide for
 * valid SQL, so there is no reason to parse the rest of the buffer.
 *
 * ## Definition
 *
 * Alias and CTE names are defined in the buffer (`FROM orders o`,
 * `WITH c AS (…)`); the definition occurrence is reported separately in `def`
 * so the UI can paint it a distinct shade. Tables and columns are defined in
 * the database, not here — `def` stays undefined for them.
 *
 * Pure: no React/Tauri imports — `node --test` covers it.
 */
import { findAliases } from './sqlAlias.ts';
import { maskLiterals, type Engine as MaskEngine } from './findUsages.ts';
import { renameTargetAt, planRename } from './renameRefactor.ts';
import { statementAt } from './sqlSplit.ts';

export interface SymbolRange {
  /** Doc offsets, quotes included when the occurrence is quoted. */
  from: number;
  to: number;
}

export interface SymbolRefs {
  /** Where the symbol is defined (aliases and CTEs only). Also in `refs`. */
  def?: SymbolRange;
  /** Every provable reference, in document order. */
  refs: SymbolRange[];
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

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `FROM orders o` / `JOIN orders AS o` — the alias's defining occurrence. */
function aliasDefAt(masked: string, table: string, name: string): SymbolRange | undefined {
  const bare = table.split('.').pop() ?? table;
  const re = new RegExp(
    `(^|[^A-Za-z0-9_$])(?:[\`"]?${esc(bare)}[\`"]?)\\s+(?:as\\s+)?([\`"]?${esc(name)}[\`"]?)(?![A-Za-z0-9_$])`,
    'i',
  );
  const m = re.exec(masked);
  if (!m) return undefined;
  // The alias group ends the match (the lookahead consumes nothing).
  const from = m.index + m[0].length - m[2].length;
  return { from, to: from + m[2].length };
}

/** `WITH c [(…)] AS (` — the CTE's defining occurrence. */
function cteDefAt(masked: string, name: string): SymbolRange | undefined {
  const re = new RegExp(
    `(^|[^A-Za-z0-9_$])([\`"]?${esc(name)}[\`"]?)(?![A-Za-z0-9_$])\\s*(?:\\([^)]*\\))?\\s+as\\s*\\(`,
    'i',
  );
  const m = re.exec(masked);
  if (!m) return undefined;
  const from = m.index + m[1].length;
  return { from, to: from + m[2].length };
}

/**
 * The definition and provable references of the symbol under `pos`, or null
 * when the caret is not on a renameable symbol (whitespace, a number, a
 * keyword, a schema qualifier) — which is exactly the condition under which
 * the caller clears the highlight.
 *
 * `engine` follows the editor's dialect (it decides which quote char is an
 * identifier quote); `delimiter` is the user's statement delimiter setting.
 */
export function symbolRefs(
  text: string, pos: number, engine: string, delimiter = ';',
): SymbolRefs | null {
  const stmt = statementAt(text, pos, delimiter);
  if (!stmt || !stmt.text.trim()) return null;
  const sub = text.slice(stmt.from, stmt.to);
  const target = renameTargetAt(sub, pos - stmt.from, engine, delimiter);
  if (!target) return null;

  // An empty schema on purpose: everything the text alone cannot prove stays
  // unhighlighted. Classification quality matches the rename tool's gate.
  const plan = planRename(sub, target, { tables: [] }, engine, delimiter);
  const refs = plan.occurrences
    .filter(o => o.cls === 'definite')
    .map(o => ({ from: o.from + stmt.from, to: o.to + stmt.from }));
  if (refs.length === 0) return null;

  const masked = maskLiterals(sub, maskEngine(engine));
  let def: SymbolRange | undefined;
  if (target.kind === 'cte') {
    def = cteDefAt(masked, target.name);
  } else if (target.kind === 'alias') {
    const table = findAliases(stmt.text).get(target.name.toLowerCase());
    if (table) def = aliasDefAt(masked, table, target.name);
  }
  if (def) def = { from: def.from + stmt.from, to: def.to + stmt.from };

  return { def, refs };
}
