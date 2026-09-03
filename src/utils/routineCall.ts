/**
 * Build the SQL that INVOKES a stored routine from a typed parameter form.
 *
 * The Routine panel creates and edits routine DDL; this is the other half —
 * running one. A DBA who wants to try a procedure otherwise hand-writes
 * `CALL db.proc(@out, 3)`, remembers to `SET`/`SELECT` the OUT variables, and
 * quotes every argument by hand. This turns a filled-in form into exactly that
 * SQL, and stops there: the caller drops it in the editor for review and runs
 * it themselves. Nothing here executes anything.
 *
 * Shapes produced (MySQL / MariaDB):
 *
 *   FUNCTION   SELECT `db`.`fn`(<in-args>) AS result;
 *
 *   PROCEDURE  SET @p_total = NULL;          -- one per OUT/INOUT param
 *              CALL `db`.`proc`(3, @p_total);
 *              SELECT @p_total AS total;      -- read the OUT/INOUT params back
 *
 * An INOUT var is seeded with the typed input; an OUT var with NULL. IN args
 * are inlined as literals. PostgreSQL functions get the same `SELECT fn(...)`
 * form; PostgreSQL has no OUT-via-session-var convention, so procedures there
 * are out of scope for this builder.
 *
 * SQL Server (T-SQL) is a third shape:
 *
 *   FUNCTION   SELECT [s].[fn](<in-args>) AS result;
 *   TVF        SELECT * FROM [s].[tvf](<in-args>);
 *   PROCEDURE  DECLARE @p_total int
 *              EXEC [s].[proc] @days = 3, @total = @p_total OUTPUT
 *              SELECT @p_total AS [total];
 *
 * Two T-SQL facts shape that last one. `DECLARE` is **batch-scoped**, not
 * session-scoped as MySQL's `@var` is, so the three statements must reach the
 * server together — which is why they are returned as ONE array entry with
 * newlines rather than three. And T-SQL makes the semicolon optional, so the
 * inner statements carry none: a `;`-splitting statement runner then sees one
 * statement and keeps the batch intact, which is the whole point.
 *
 * Pure and dependency-light — driven by `node --test`.
 */
import { quoteIdent, safeIdent, sqlLiteral } from './sqlIdent.ts';
import type { RoutineKind, RoutineParam } from './routineDdl.ts';

export interface BuildRoutineCallArgs {
  kind: RoutineKind;
  schema?: string | null;
  name: string;
  params: RoutineParam[];
  /** Typed values keyed by parameter name. Missing/blank → NULL. */
  values: Record<string, string>;
  engine: string;
  /**
   * The function's return type, when the caller knows it.
   *
   * Only SQL Server needs it, and only to tell a scalar function from a
   * table-valued one: `SELECT fn(…)` is a syntax error for a TVF and
   * `SELECT * FROM fn(…)` is one for a scalar. Every other engine ignores it.
   */
  returns?: string | null;
}

/**
 * A typed form value as a SQL scalar.
 *
 * Empty is NULL — a blank box means "no argument", not the empty string, which
 * is what a DBA reaching for NULL expects and is safe to change by typing. A
 * bare integer or decimal is passed through unquoted so numeric parameters bind
 * as numbers; everything else becomes a properly escaped string literal.
 */
export function formatValue(raw: string | undefined, engine: string): string {
  const v = (raw ?? '').trim();
  if (v === '') return 'NULL';
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return v;
  return sqlLiteral(v, engine);
}

/**
 * The variable that carries an OUT/INOUT parameter's value.
 *
 * The leading `@` is stripped first because a T-SQL parameter name already
 * carries one, and `@p_@total` is not an identifier.
 */
function outVar(name: string): string {
  return `@p_${name.replace(/^@/, '')}`;
}

/**
 * Turn a routine plus a filled-in form into the statements that invoke it.
 *
 * Returns one string per statement (each already `;`-terminated) so the caller
 * can join them however the editor wants.
 */
export function buildRoutineCall(args: BuildRoutineCallArgs): string[] {
  const { kind, schema, name, params, values, engine, returns } = args;
  const q = (s: string) => quoteIdent(s, engine);
  const qualified = schema ? `${q(schema)}.${q(name)}` : q(name);

  if (engine === 'sqlserver') {
    return buildMssqlCall(kind, qualified, params, values, returns ?? null);
  }

  if (kind === 'function') {
    // Functions take only input arguments; an OUT should never appear, but if a
    // parser handed one through, dropping it keeps the SELECT syntactically sound.
    const callArgs = params
      .filter(p => p.mode !== 'OUT')
      .map(p => formatValue(values[p.name], engine));
    return [`SELECT ${qualified}(${callArgs.join(', ')}) AS result;`];
  }

  const outParams = params.filter(p => p.mode === 'OUT' || p.mode === 'INOUT');
  const stmts: string[] = [];

  // Seed a session variable for every OUT/INOUT parameter. INOUT carries the
  // typed input into the call; OUT starts empty and only comes back filled.
  for (const p of outParams) {
    const seed = p.mode === 'INOUT' ? formatValue(values[p.name], engine) : 'NULL';
    stmts.push(`SET ${outVar(p.name)} = ${seed};`);
  }

  const callArgs = params.map(p => {
    if (p.mode === 'OUT' || p.mode === 'INOUT') return outVar(p.name);
    // IN, and VARIADIC passed through as a single positional argument.
    return formatValue(values[p.name], engine);
  });
  stmts.push(`CALL ${qualified}(${callArgs.join(', ')});`);

  // Read the OUT/INOUT variables back — a CALL leaves them in the session but
  // never returns them, so without this the results are invisible.
  if (outParams.length > 0) {
    const cols = outParams.map(p => `${outVar(p.name)} AS ${safeIdent(p.name, engine)}`);
    stmts.push(`SELECT ${cols.join(', ')};`);
  }

  return stmts;
}

/**
 * The T-SQL invocation.
 *
 * Named arguments (`@p = value`) rather than positional: a T-SQL procedure's
 * parameters routinely have defaults, and naming them means a form that leaves
 * an optional parameter blank omits it rather than passing NULL over the top of
 * its default — the difference between "use the default" and "use nothing".
 */
function buildMssqlCall(
  kind: RoutineKind,
  qualified: string,
  params: RoutineParam[],
  values: Record<string, string>,
  returns: string | null,
): string[] {
  // The `@` is part of a T-SQL parameter name; the parser keeps it, but a
  // parameter typed into the form may not have one.
  const at = (n: string) => (n.startsWith('@') ? n : `@${n}`);

  if (kind === 'function') {
    const args = params
      .filter(p => p.mode !== 'OUT')
      .map(p => formatValue(values[p.name], 'sqlserver'));
    // `RETURNS TABLE` (inline TVF) and `RETURNS @t TABLE (…)` (multi-statement)
    // are both selected FROM; only a scalar is selected as an expression.
    const isTable = /(^|\s)TABLE\b/i.test(returns ?? '');
    return isTable
      ? [`SELECT * FROM ${qualified}(${args.join(', ')});`]
      : [`SELECT ${qualified}(${args.join(', ')}) AS result;`];
  }

  const outParams = params.filter(p => p.mode === 'OUT' || p.mode === 'INOUT');
  const lines: string[] = [];
  for (const p of outParams) {
    // A local, not a session variable: T-SQL has no `SET @x` that outlives the
    // batch, so the declaration travels with the call.
    lines.push(`DECLARE ${outVar(p.name)} ${p.type || 'sql_variant'}`);
    if (p.mode === 'INOUT') {
      lines.push(`SET ${outVar(p.name)} = ${formatValue(values[p.name], 'sqlserver')}`);
    }
  }

  const callArgs = params
    .map(p => {
      const n = at(p.name);
      if (p.mode === 'OUT' || p.mode === 'INOUT') return `${n} = ${outVar(p.name)} OUTPUT`;
      const v = (values[p.name] ?? '').trim();
      // Blank and optional means "let the default apply" — passing NULL would
      // override it, which is a different call and usually the wrong one.
      if (v === '' && p.defaultValue !== undefined) return null;
      return `${n} = ${formatValue(values[p.name], 'sqlserver')}`;
    })
    .filter((a): a is string => a !== null);

  lines.push(`EXEC ${qualified}${callArgs.length ? ' ' + callArgs.join(', ') : ''}`);

  if (outParams.length > 0) {
    const cols = outParams.map(p =>
      `${outVar(p.name)} AS ${safeIdent(p.name.replace(/^@/, ''), 'sqlserver')}`);
    lines.push(`SELECT ${cols.join(', ')}`);
  }

  // One entry, one batch — see the module header.
  return [`${lines.join('\n')};`];
}
