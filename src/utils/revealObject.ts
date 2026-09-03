/**
 * "Reveal in database tree" — the pure half.
 *
 * The F12 go-to-object opens the object under the caret; this is its mirror:
 * show the same object in the sidebar's schema tree. The editor hands over a
 * bare or qualified name (`orders`, `public.orders`, `` `my db`.`order lines` ``,
 * DuckDB's three-level `db.schema.table`) — here that string is parsed into
 * parts and matched against tree node names, with no React/Tauri imports so
 * `node --test` can drive it.
 *
 * Matching mirrors the editor's own leniency: exact first, case-insensitive
 * as the fallback — MySQL identifiers are case-folded by lower_case_table_names
 * on some platforms and not others, and the name arriving here may have been
 * written either way.
 */

/**
 * Split a possibly-quoted qualified name into its parts, unquoted:
 *   `orders`                    → ['orders']
 *   `public.orders`             → ['public', 'orders']
 *   `"my schema"."order lines"` → ['my schema', 'order lines']
 *   `` `db`.`t` `` / `[db].[t]` → ['db', 't']
 *
 * A dot inside quotes does not split. Empty or whitespace input yields [].
 */
export function splitQualifiedName(raw: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  // close-quote chars: `"` and backtick close themselves, `[` closes with `]`.
  const closerOf = (q: string) => (q === '[' ? ']' : q);
  const s = raw.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      const close = closerOf(quote);
      if (ch === close) {
        // doubled closer inside the quotes is an escaped literal ("" , ``, ]])
        if (s[i + 1] === close) { cur += close; i++; }
        else quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === '`' || ch === '[') {
      quote = ch;
    } else if (ch === '.') {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  return parts.filter(p => p.length > 0);
}

/** Exact, else case-insensitive — see the header note on identifier folding. */
export function nameMatches(candidate: string, target: string): boolean {
  return candidate === target || candidate.toLowerCase() === target.toLowerCase();
}

/**
 * Kinds a reveal target can land on. Relations are the F12 case; routines and
 * friends are included so a name the user typed by hand can still be found
 * (the tree groups them all under a database/schema node).
 */
export const REVEALABLE_KINDS: ReadonlySet<string> = new Set([
  'table', 'view', 'mat_view', 'distributed', 'foreign_table',
  'routine', 'sequence', 'type', 'trigger', 'event',
]);

/**
 * Order the candidate container (database/schema) names a qualified target
 * may live under, best first: the full qualifier (`db.schema` for DuckDB's
 * three-level names), then just its last segment (`public` in `public.orders`,
 * `mydb` in `mydb.orders`). Bare names get no containers — the caller searches
 * every one it has.
 */
export function qualifierCandidates(parts: string[]): string[] {
  const qual = parts.slice(0, -1);
  if (qual.length === 0) return [];
  const full = qual.join('.');
  const last = qual[qual.length - 1];
  return full === last ? [full] : [full, last];
}
