/**
 * Query variables: `:name` placeholders prompted at run time.
 * Scanner skips strings, comments, backticks, dollar-quotes, bracketed T-SQL
 * identifiers, and constructs that also use colons (`::cast`, `:=`, array
 * slices `arr[1:upper]`). Values substitute as quoted literals unless marked
 * raw (or numeric).
 */

import { dollarQuotedStrings, hashLineComments, nestedBlockComments } from './sqlAlias.ts';
import { backslashEscapesStrings, sqlLiteral } from './sqlIdent.ts';

export interface VarValue {
  value: string;
  raw: boolean;   // insert as-is (numbers, expressions, NULL)
}

interface Token { name: string; from: number; to: number }

function scan(sql: string, engine?: string): Token[] {
  const hashOk = hashLineComments(engine);
  const bsInStrings = backslashEscapesStrings(engine);
  const nestedComments = nestedBlockComments(engine);
  const dollarOk = engine == null || engine === '' || dollarQuotedStrings(engine);
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';
    if ((ch === '-' && next === '-') || (ch === '#' && hashOk)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
    } else if (ch === '/' && next === '*') {
      if (nestedComments) {
        let depth = 1;
        i += 2;
        while (i < n && depth > 0) {
          if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
          else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
          else i++;
        }
      } else {
        const end = sql.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
      }
    } else if (ch === '$' && dollarOk) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? n : end + tag[0].length;
      } else {
        i++;
      }
    } else if (ch === '[' && engine === 'sqlserver') {
      i++;
      while (i < n) {
        if (sql[i] === ']') {
          if (sql[i + 1] === ']') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      const eString = q === "'"
        && (engine === 'postgres' || engine === 'duckdb')
        && i > 0 && (sql[i - 1] === 'E' || sql[i - 1] === 'e')
        && (i < 2 || !/[\w$]/.test(sql[i - 2]));
      const bs = q !== '`' && (bsInStrings || eString);
      i++;
      while (i < n) {
        if (bs && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === q) {
          if (sql[i + 1] === q) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
    } else if (ch === ':') {
      // skip ::cast (and any run of colons) and := assignment
      if (next === ':') {
        while (i < n && sql[i] === ':') i++;
        continue;
      }
      if (next === '=') { i += 2; continue; }
      // Reject `:name` attached to an identifier, literal digit, or closing
      // bracket/paren (e.g. PostgreSQL array slices `arr[1:upper]`).
      const prev = i > 0 ? sql[i - 1] : '';
      if (prev && /[A-Za-z0-9_)\]]/.test(prev)) { i++; continue; }
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1, i + 65));
      if (m) {
        out.push({ name: m[0], from: i, to: i + 1 + m[0].length });
        i += 1 + m[0].length;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return out;
}

/** Unique variable names in order of first appearance. */
export function findVariables(sql: string, engine?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of scan(sql, engine)) {
    if (!seen.has(t.name)) { seen.add(t.name); out.push(t.name); }
  }
  return out;
}

export function substituteVariables(
  sql: string,
  values: Record<string, VarValue>,
  engine?: string,
): string {
  const effEngine = engine ?? 'mysql';
  const tokens = scan(sql, engine).filter(t => values[t.name] !== undefined);
  // right-to-left so offsets stay valid
  let out = sql;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    const v = values[t.name];
    const literal = v.raw ? v.value : sqlLiteral(v.value, effEngine);
    out = out.slice(0, t.from) + literal + out.slice(t.to);
  }
  return out;
}

/** Heuristic: prefill raw=true for numeric-looking values. */
export function looksNumeric(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}
