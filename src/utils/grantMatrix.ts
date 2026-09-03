/**
 * 🔳 Grant matrix — the checkbox grid behind 👤 Users & grants (MySQL / MariaDB).
 *
 * Same rule as the panel it lives in: reading is free, WRITING IS REVIEW-ONLY.
 * This module never touches a database. It turns the text of `SHOW GRANTS` into
 * a privilege set per scope, and turns the difference between what the boxes
 * say and what the account already has into the `GRANT …` / `REVOKE …`
 * statements — which the panel drops into the editor for a human to run.
 *
 * Two matching pieces have to agree on one thing: the *scope key*. `parseGrants`
 * keys each scope by [`scopeKey`], and the UI looks a scope up with the very
 * same function, so `\`shop\`.*` from the server and a `shop` typed into a box
 * land on the same bucket. Canonicalising through `quoteIdent` (rather than
 * trusting the server's spelling) is what lets a bare name and a back-ticked
 * one compare equal.
 *
 * Pure and dependency-light — driven by `node --test`, see
 * tests/grantMatrix.test.ts.
 */
import { quoteIdent } from './sqlIdent.ts';

/**
 * The columns of the matrix — the privileges a DBA reaches for daily, in the
 * order MySQL's own `SHOW PRIVILEGES` roughly lists them. Not the whole set:
 * server-admin privileges (SUPER, PROCESS, RELOAD…) are global-only knobs that
 * belong in a different screen, and a checkbox grid of forty rows helps nobody.
 * `GRANT OPTION` is last because it is not a privilege on data but the right to
 * pass privileges on — handled specially in [`grantDiffSql`].
 */
export const PRIVILEGES = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES',
  'CREATE VIEW', 'SHOW VIEW', 'TRIGGER', 'EVENT',
  'EXECUTE', 'CREATE ROUTINE', 'ALTER ROUTINE',
  'CREATE TEMPORARY TABLES', 'LOCK TABLES',
  'GRANT OPTION',
] as const;

export type Privilege = (typeof PRIVILEGES)[number];

/** The data privileges — everything `ALL PRIVILEGES` covers, i.e. all but the meta one. */
export const DATA_PRIVILEGES: readonly Privilege[] =
  PRIVILEGES.filter(p => p !== 'GRANT OPTION');

const PRIV_ORDER = new Map(PRIVILEGES.map((p, i) => [p, i]));

/** The three levels a grant can bite at. */
export type Scope =
  | { kind: 'global' }
  | { kind: 'database'; db: string }
  | { kind: 'table'; db: string; table: string };

/**
 * The canonical string a scope is keyed by — `*.*`, `` `db`.* ``,
 * `` `db`.`tbl` ``. Both sides of the diff (parsed grants and the UI's picked
 * scope) go through this, so quoting is the same on both and lookups line up.
 */
export function scopeKey(scope: Scope, engine: string = 'mysql'): string {
  switch (scope.kind) {
    case 'global': return '*.*';
    case 'database': return `${quoteIdent(scope.db, engine)}.*`;
    case 'table': return `${quoteIdent(scope.db, engine)}.${quoteIdent(scope.table, engine)}`;
  }
}

/** The `ON <scope>` clause of a GRANT/REVOKE — the key doubles as the clause. */
export function scopeSql(scope: Scope, engine: string = 'mysql'): string {
  return scopeKey(scope, engine);
}

/**
 * Walk the `db.tbl` object of a grant line into its two identifiers, honouring
 * back-ticks (and doubled `` `` `` escapes inside them) so a database literally
 * named `a.b` is not mistaken for `a`.`b`. Returns `null` for anything that is
 * not a clean two-part object — an unknown line is dropped, never guessed at.
 */
function splitObject(object: string): { db: string; table: string } | null {
  let i = 0;
  const part = (): string | null => {
    if (object[i] === '*') { i++; return '*'; }
    if (object[i] === '`') {
      i++;
      let s = '';
      while (i < object.length) {
        if (object[i] === '`') {
          if (object[i + 1] === '`') { s += '`'; i += 2; continue; }
          i++; return s;
        }
        s += object[i++];
      }
      return null; // unterminated quote
    }
    let s = '';
    while (i < object.length && object[i] !== '.') s += object[i++];
    return s || null;
  };
  const db = part();
  if (db === null || object[i] !== '.') return null;
  i++;
  const table = part();
  if (table === null || i !== object.length) return null;
  return { db, table };
}

/** Canonicalise a grant object into the same key `scopeKey` would produce. */
function objectToKey(object: string, engine: string): string | null {
  if (object === '*.*') return '*.*';
  const parts = splitObject(object);
  if (!parts) return null;
  if (parts.db === '*' && parts.table === '*') return '*.*';
  if (parts.table === '*') return scopeKey({ kind: 'database', db: parts.db }, engine);
  return scopeKey({ kind: 'table', db: parts.db, table: parts.table }, engine);
}

/** Split a `SHOW GRANTS` privilege list into normalised names. */
function parsePrivList(list: string): Privilege[] {
  // `SELECT (col1, col2)` is a column-level grant — the parenthesised list has
  // commas that would wreck a naive split, and the column detail is not
  // something the matrix models, so drop it and keep the bare privilege.
  const cleaned = list.replace(/\([^)]*\)/g, '');
  const out: Privilege[] = [];
  for (const raw of cleaned.split(',')) {
    const name = raw.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!name || name === 'USAGE') continue; // USAGE == "no privileges"
    if (name === 'ALL' || name === 'ALL PRIVILEGES') {
      out.push(...DATA_PRIVILEGES);
      continue;
    }
    if ((PRIV_ORDER.has(name as Privilege))) out.push(name as Privilege);
    // Anything outside the curated columns (SUPER, PROCESS, PROXY, …) is
    // ignored: the matrix does not show it, so it cannot mean to touch it.
  }
  return out;
}

/**
 * Parse the lines of `SHOW GRANTS FOR …` into a set of privilege names per
 * scope. `ALL PRIVILEGES` expands to every data column; `WITH GRANT OPTION`
 * becomes the `GRANT OPTION` member of that scope's set. Lines that are not
 * privilege grants (role membership, proxy) are skipped.
 */
export function parseGrants(
  showGrantsLines: readonly string[],
  engine: string = 'mysql',
): Map<string, Set<Privilege>> {
  const byScope = new Map<string, Set<Privilege>>();
  const at = (key: string) => {
    let s = byScope.get(key);
    if (!s) { s = new Set(); byScope.set(key, s); }
    return s;
  };

  for (const raw of showGrantsLines) {
    const line = raw.trim();
    const m = /^GRANT\s+(.+?)\s+ON\s+(\S+?)\s+TO\s/i.exec(line);
    if (!m) continue; // `GRANT `r`@`%` TO `u`` (membership) and the like
    const key = objectToKey(m[2], engine);
    if (!key) continue;
    const set = at(key);
    for (const p of parsePrivList(m[1])) set.add(p);
    if (/\bWITH\s+GRANT\s+OPTION\s*$/i.test(line)) set.add('GRANT OPTION');
  }
  return byScope;
}

/** The privileges an account already holds at one scope (empty set if none). */
export function privsForScope(
  parsed: Map<string, Set<Privilege>>,
  scope: Scope,
  engine: string = 'mysql',
): Set<Privilege> {
  return new Set(parsed.get(scopeKey(scope, engine)) ?? []);
}

export interface GrantDiffArgs {
  /** Already rendered as `'user'@'host'` (or a role name) — used verbatim. */
  account: string;
  scope: Scope;
  /** What the boxes say should be granted. */
  desired: Iterable<Privilege>;
  /** What `SHOW GRANTS` says is granted now. */
  current: Iterable<Privilege>;
  engine?: string;
}

const inOrder = (privs: Iterable<Privilege>): Privilege[] =>
  [...new Set(privs)].sort((a, b) => (PRIV_ORDER.get(a)! - PRIV_ORDER.get(b)!));

/**
 * The minimal `GRANT` / `REVOKE` for the difference desired − current, ready
 * for the editor. Returns `''` when the two match — a no-op must produce no
 * SQL, so the panel can tell "nothing to do" from "here is a statement".
 *
 * `GRANT OPTION` is the awkward one. It cannot ride in a `GRANT`'s privilege
 * list (it is the `WITH GRANT OPTION` clause), and granting *only* it still
 * needs a privilege placeholder — MySQL's own idiom is `GRANT USAGE … WITH
 * GRANT OPTION`. On the way out it revokes cleanly as a named privilege, so it
 * just joins the `REVOKE` list.
 */
export function grantDiffSql(args: GrantDiffArgs): string {
  const { account, scope, engine = 'mysql' } = args;
  const desired = new Set(args.desired);
  const current = new Set(args.current);
  const on = scopeSql(scope, engine);

  const toAdd = inOrder([...desired].filter(p => !current.has(p)));
  const toRemove = inOrder([...current].filter(p => !desired.has(p)));

  const out: string[] = [];

  if (toAdd.length) {
    const addGrantOption = toAdd.includes('GRANT OPTION');
    const addData = toAdd.filter(p => p !== 'GRANT OPTION');
    // Granting the pass-on right on its own still needs a privilege to name.
    const privList = addData.length ? addData : (['USAGE'] as unknown as Privilege[]);
    out.push(
      `GRANT ${privList.join(', ')} ON ${on} TO ${account}`
      + (addGrantOption ? ' WITH GRANT OPTION' : '') + ';',
    );
  }

  if (toRemove.length) {
    out.push(`REVOKE ${toRemove.join(', ')} ON ${on} FROM ${account};`);
  }

  return out.join('\n');
}
