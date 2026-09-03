/**
 * Query variables: `:name` placeholders prompted at run time.
 * Scanner skips strings, comments, backticks, and PG constructs that also
 * use colons (`::cast`, `:=`). Values substitute as quoted literals unless
 * marked raw (or numeric).
 */

import { sqlLiteral } from './sqlIdent.ts';

export interface VarValue {
  value: string;
  raw: boolean;   // insert as-is (numbers, expressions, NULL)
}

interface Token { name: string; from: number; to: number }

function scan(sql: string): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i++;
      while (i < n) {
        if (sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === q) { i++; break; }
        i++;
      }
    } else if (ch === ':') {
      // skip ::cast and := and :: sequences
      if (next === ':' || next === '=') { i += 2; continue; }
      // previous char being ':' already handled; require word start
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
export function findVariables(sql: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of scan(sql)) {
    if (!seen.has(t.name)) { seen.add(t.name); out.push(t.name); }
  }
  return out;
}

export function substituteVariables(
  sql: string,
  values: Record<string, VarValue>,
  engine = 'mysql',
): string {
  const tokens = scan(sql).filter(t => values[t.name] !== undefined);
  // right-to-left so offsets stay valid
  let out = sql;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    const v = values[t.name];
    const literal = v.raw ? v.value : sqlLiteral(v.value, engine);
    out = out.slice(0, t.from) + literal + out.slice(t.to);
  }
  return out;
}

/** Heuristic: prefill raw=true for numeric-looking values. */
export function looksNumeric(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}
