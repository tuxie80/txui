/**
 * Command aliases: a saved query whose SQL contains :1 :2 … placeholders can
 * be invoked by name with parameters on the same line:
 *
 *   saved "reservations"  =  SELECT * FROM warehouse_reservations
 *                            WHERE warehouse_id = :1 AND grocery_id = :2
 *   typed:  reservations 8793 1349777   →  expands and runs
 *
 * Parameters substitute AS TYPED (quote them yourself for strings:
 * `myalias 'some text' 42`). Extra params are ignored; missing ones stay
 * as :n so the error is visible. A parameterless alias expands too.
 */

export interface AliasDef { name: string; sql: string }

/** First word of a statement if it's a plausible alias call, else null. */
function callParts(stmt: string): { name: string; rest: string } | null {
  const m = /^\s*([A-Za-z_][\w-]*)\b([\s\S]*)$/.exec(stmt);
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: m[2] };
}

/** Split parameters: whitespace-separated, single-quoted strings kept whole. */
function splitParams(rest: string): string[] {
  const out: string[] = [];
  const re = /'(?:[^']|'')*'|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) out.push(m[0]);
  return out;
}

export function expandAlias(
  stmt: string,
  aliases: Map<string, AliasDef>,
): { sql: string; expanded: boolean } {
  const call = callParts(stmt);
  if (!call) return { sql: stmt, expanded: false };
  const def = aliases.get(call.name);
  if (!def) return { sql: stmt, expanded: false };

  const params = splitParams(call.rest);
  const sql = def.sql.replace(/:(\d{1,2})\b/g, (whole, n) => {
    const idx = Number(n) - 1;
    return idx >= 0 && idx < params.length ? params[idx] : whole;
  });
  return { sql, expanded: true };
}
