import { toAppError } from './appError.ts';
import { fuzzyScore } from './fuzzy.ts';

export interface ErrorGuidance {
  title: string;
  detail: string;
  insertSql?: string;
  schemaObject?: string;
  goto?: { from: number; to: number };
}

export interface ErrorContext {
  sql: string;
  tables?: readonly string[];
  columns?: readonly string[];
}

function editDistance(a: string, b: string): number {
  const aChars = [...a.toLowerCase()];
  const bChars = [...b.toLowerCase()];
  let previous = Array.from({ length: bChars.length + 1 }, (_, index) => index);
  for (let i = 1; i <= aChars.length; i++) {
    const current = [i];
    for (let j = 1; j <= bChars.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (aChars[i - 1] === bChars[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[bChars.length];
}

function bestName(unknown: string, candidates: readonly string[]): string | null {
  const needle = unknown.split('.').pop() ?? unknown;
  let best: { name: string; distance: number; fuzzy: number } | null = null;
  for (const name of candidates) {
    const fuzzy = fuzzyScore(needle, name) ?? Number.NEGATIVE_INFINITY;
    const distance = editDistance(needle, name);
    if (!best || distance < best.distance || (distance === best.distance && fuzzy > best.fuzzy)) {
      best = { name, distance, fuzzy };
    }
  }
  return best?.name ?? null;
}

function position(message: string, sql: string): ErrorGuidance['goto'] {
  const absolute = /\bposition\s*:?\s*(\d+)/i.exec(message);
  if (absolute) {
    const from = Math.max(0, Math.min(sql.length, Number(absolute[1]) - 1));
    return { from, to: Math.min(sql.length, from + 1) };
  }
  const line = /\bat line\s+(\d+)/i.exec(message);
  if (!line) return undefined;
  const wanted = Math.max(1, Number(line[1]));
  let from = 0;
  for (let n = 1; n < wanted; n++) {
    const next = sql.indexOf('\n', from);
    if (next < 0) return { from: 0, to: 0 };
    from = next + 1;
  }
  return { from, to: Math.min(sql.length, from + 1) };
}

export function errorGuidance(error: unknown, context: ErrorContext): ErrorGuidance | null {
  const app = toAppError(error);
  const message = app.message;
  const goto = position(message, context.sql);
  const table = /Table '([^']+)' doesn't exist|relation "([^"]+)" does not exist/i.exec(message);
  if (table) {
    const missing = table[1] ?? table[2];
    const suggestion = bestName(missing, context.tables ?? []);
    return {
      title: suggestion ? `Table “${missing}” was not found — did you mean “${suggestion}”?` : `Table “${missing}” was not found`,
      detail: suggestion
        ? 'The name is close to an object in the current schema. Review the suggestion; nothing runs automatically.'
        : 'Check the selected database, schema and table name. Review the schema tree before retrying.',
      insertSql: suggestion ?? undefined,
      schemaObject: suggestion ?? missing,
      goto,
    };
  }
  const column = /Unknown column '([^']+)'|column "([^"]+)" does not exist/i.exec(message);
  if (column) {
    const missing = column[1] ?? column[2];
    const suggestion = bestName(missing, context.columns ?? []);
    return {
      title: suggestion ? `Column “${missing}” was not found — did you mean “${suggestion}”?` : `Column “${missing}” was not found`,
      detail: suggestion
        ? 'The name is close to a column in the current schema. Review the suggestion; nothing runs automatically.'
        : 'Check the column name, table alias and selected schema before retrying.',
      insertSql: suggestion ?? undefined,
      schemaObject: suggestion ?? missing,
      goto,
    };
  }
  const ambiguous = /Column '([^']+)' in .* is ambiguous|column reference "([^"]+)" is ambiguous/i.exec(message);
  if (ambiguous) {
    const name = ambiguous[1] ?? ambiguous[2];
    return {
      title: `Column “${name}” is ambiguous`,
      detail: 'Qualify it with the intended table or alias. Check every table in the SELECT’s FROM/JOIN list.',
      goto,
    };
  }
  if (app.code === 'permission_denied') {
    return {
      title: 'The database role cannot perform this action',
      detail: 'Review the account’s privileges and the connection’s read-only setting. Do not retry against production with a different account without authorization.',
      goto,
    };
  }
  if (app.code === 'timeout') {
    return {
      title: 'The query exceeded its deadline',
      detail: 'Narrow the result, add a LIMIT or use an appropriate index. Increase the timeout only when the workload is understood.',
      goto,
    };
  }
  if (app.code === 'sql_syntax' || /\bsyntax error|parse error|you have an error in your sql syntax/i.test(message)) {
    return {
      title: 'Review the statement near the reported position',
      detail: 'Check the preceding keyword, parentheses, quoting, delimiter and engine-specific syntax. The highlighted range is the server’s best position, not necessarily the root cause.',
      goto,
    };
  }
  return null;
}
