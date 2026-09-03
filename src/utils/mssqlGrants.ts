/**
 * 👤 Users & grants, SQL Server edition — a different security model, not a
 * dialect of MySQL's.
 *
 * `grantMatrix.ts` models MySQL: two-level scopes (`db.*`, `db.tbl`), a
 * privilege list parsed out of `SHOW GRANTS` text, and two states — a privilege
 * is held or it is not. Every one of those is wrong here, which is why this is
 * a separate module rather than a third branch inside that one.
 *
 * ## Three things SQL Server does that neither other engine does
 *
 * **DENY is a state, not the absence of a grant.** `DENY SELECT` beats every
 * GRANT the principal has, including ones inherited from a role, and it keeps
 * beating them until it is explicitly revoked. Modelling permissions as a
 * checkbox — on or off — cannot express it, and a matrix that silently turned a
 * DENY into "not granted" would show a user access they demonstrably do not
 * have. So the cell is **three-state**, and clearing a DENY is `REVOKE`, not
 * `GRANT`.
 *
 * **The scope ladder has a rung MySQL lacks: the schema.** `GRANT SELECT ON
 * SCHEMA::sales` covers every table in it, present and future. It is how
 * SQL Server access is actually granted in practice, and leaving it out would
 * mean the panel could not read back the grants most databases really have.
 *
 * **A login and a user are different objects.** The login authenticates at the
 * instance; the user is its identity inside one database, and the two are
 * matched by SID rather than by name. A user with no login is orphaned — it
 * exists, it owns permissions, and nobody can connect as it. That is worth
 * showing rather than hiding behind a single "account" row.
 *
 * ## What this module does not do
 *
 * Nothing here touches a database. It turns catalog rows into a permission map
 * and turns the difference between the boxes and that map into `GRANT` /
 * `DENY` / `REVOKE` statements, which the panel puts in the editor for a human
 * to run — the same review-only rule the MySQL matrix follows.
 *
 * Pure and dependency-light — driven by `node --test`.
 */
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';

const q = (s: string) => quoteIdent(s, 'sqlserver');
const lit = (s: string) => sqlLiteral(s, 'sqlserver');

/**
 * The permission columns of the matrix.
 *
 * Chosen for what a DBA grants daily, not for completeness — SQL Server defines
 * over two hundred permissions, and a grid of them helps nobody. `CONTROL` is
 * included because it is the one people reach for without realising it implies
 * every other permission on the object; `VIEW DEFINITION` because not having it
 * is why a user's object explorer looks empty.
 */
export const MSSQL_PERMISSIONS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'EXECUTE',
  'ALTER', 'VIEW DEFINITION', 'VIEW CHANGE TRACKING', 'TAKE OWNERSHIP', 'CONTROL',
] as const;

export type MssqlPermission = (typeof MSSQL_PERMISSIONS)[number];

const PERM_ORDER = new Map(MSSQL_PERMISSIONS.map((p, i) => [p, i]));

/**
 * Which permissions mean anything at each scope.
 *
 * `EXECUTE` on a table is not a permission SQL Server has, and offering the
 * checkbox produces a statement the server rejects — so the grid asks the
 * scope what it can hold rather than showing eleven columns everywhere.
 */
export const MSSQL_PERMISSIONS_BY_SCOPE: Readonly<Record<MssqlScopeKind, readonly MssqlPermission[]>> = {
  database: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'EXECUTE',
    'ALTER', 'VIEW DEFINITION', 'TAKE OWNERSHIP', 'CONTROL'],
  schema: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'EXECUTE',
    'ALTER', 'VIEW DEFINITION', 'VIEW CHANGE TRACKING', 'TAKE OWNERSHIP', 'CONTROL'],
  // A table takes the data permissions; a routine takes EXECUTE. Both live at
  // OBJECT scope, so the union is offered and the server rejects a nonsense
  // pairing — the alternative is asking the catalog what kind of object it is
  // before drawing a checkbox, for a mistake the panel makes visible anyway.
  object: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'EXECUTE',
    'ALTER', 'VIEW DEFINITION', 'VIEW CHANGE TRACKING', 'TAKE OWNERSHIP', 'CONTROL'],
};

export type MssqlScopeKind = 'database' | 'schema' | 'object';

export type MssqlScope =
  | { kind: 'database' }
  | { kind: 'schema'; schema: string }
  | { kind: 'object'; schema: string; name: string };

/**
 * The three states a cell can be in.
 *
 * `grant-with-option` is kept distinct from `grant` because losing it silently
 * downgrades a principal's ability to delegate, and the catalog reports it as
 * its own `state_desc`.
 */
export type MssqlGrantState = 'none' | 'grant' | 'grant-with-option' | 'deny';

/** The canonical key a scope is stored under. */
export function mssqlScopeKey(scope: MssqlScope): string {
  switch (scope.kind) {
    case 'database': return 'DATABASE';
    case 'schema': return `SCHEMA::${scope.schema}`;
    case 'object': return `OBJECT::${scope.schema}.${scope.name}`;
  }
}

/**
 * The `ON …` clause of a GRANT/DENY/REVOKE.
 *
 * The database is named by `ON DATABASE::[name]`; a schema by `SCHEMA::`; an
 * object by its bare two-part name, which is the one place SQL Server does NOT
 * want a class prefix.
 */
export function mssqlScopeSql(scope: MssqlScope, database: string): string {
  switch (scope.kind) {
    case 'database': return `DATABASE::${q(database)}`;
    case 'schema': return `SCHEMA::${q(scope.schema)}`;
    case 'object': return `${q(scope.schema)}.${q(scope.name)}`;
  }
}

/** How a scope reads in the UI. */
export function mssqlScopeLabel(scope: MssqlScope, database: string): string {
  switch (scope.kind) {
    case 'database': return `database ${database}`;
    case 'schema': return `schema ${scope.schema}`;
    case 'object': return `${scope.schema}.${scope.name}`;
  }
}

// ── reading the catalog ──────────────────────────────────────────────────────

/**
 * Every principal in the current database, with the login behind it.
 *
 * `principal_id > 4` skips `dbo`, `guest`, `INFORMATION_SCHEMA` and `sys`,
 * which exist in every database and are not accounts anyone administers. Fixed
 * roles are excluded for the same reason: `db_owner` is not something you edit.
 *
 * The `LEFT JOIN` on SID is what surfaces an **orphaned user** — a database
 * user whose login was dropped, or which came in on a restore from another
 * instance. It owns permissions and nobody can connect as it, and it shows as
 * a user with no login rather than being quietly hidden.
 */
export const MSSQL_PRINCIPALS_SQL = `SELECT
  dp.name,
  dp.type_desc,
  ISNULL(sp.name, '')                                       AS login_name,
  ISNULL(dp.default_schema_name, '')                        AS default_schema,
  CONVERT(int, ISNULL(sp.is_disabled, 0))                   AS is_disabled,
  ISNULL(CONVERT(varchar(30), dp.create_date, 120), '')      AS created,
  ISNULL(STUFF((SELECT ', ' + r.name
                FROM sys.database_role_members m
                JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
                WHERE m.member_principal_id = dp.principal_id
                ORDER BY r.name
                FOR XML PATH(''), TYPE).value('.', 'nvarchar(400)'), 1, 2, ''), '') AS roles
FROM sys.database_principals dp
LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid
WHERE dp.type IN ('S','U','G','R','E','X')
  AND dp.principal_id > 4
  AND dp.is_fixed_role = 0
ORDER BY CASE WHEN dp.type = 'R' THEN 1 ELSE 0 END, dp.name`;

export interface MssqlPrincipal {
  name: string;
  /** SQL_USER, WINDOWS_USER, DATABASE_ROLE, … */
  typeDesc: string;
  /** Empty when the user has no matching login — i.e. it is orphaned. */
  login: string;
  defaultSchema: string;
  disabled: boolean;
  created: string;
  /** Database roles this principal is a member of. */
  roles: string[];
  isRole: boolean;
  /**
   * A user with no login, which nobody can connect as.
   *
   * Roles are never orphaned — they have no login by definition — so the flag
   * is only meaningful for users, and saying otherwise would put a warning
   * beside every role in the list.
   */
  orphaned: boolean;
}

/** One catalog row → a principal. */
export function mssqlPrincipalFromRow(row: readonly unknown[]): MssqlPrincipal {
  const s = (i: number) => (row[i] === null || row[i] === undefined ? '' : String(row[i]));
  const typeDesc = s(1);
  const isRole = typeDesc === 'DATABASE_ROLE' || typeDesc === 'APPLICATION_ROLE';
  const login = s(2);
  return {
    name: s(0),
    typeDesc,
    login,
    defaultSchema: s(3),
    disabled: s(4) === '1' || s(4).toLowerCase() === 'true',
    created: s(5),
    roles: s(6) ? s(6).split(',').map(r => r.trim()).filter(Boolean) : [],
    isRole,
    orphaned: !isRole && login === '' && typeDesc.startsWith('SQL'),
  };
}

/**
 * The explicit permissions of one principal.
 *
 * `minor_id = 0` drops column-level grants: the matrix has no column axis, and
 * showing a column grant as a table grant would claim access to the other
 * columns. They are counted separately by the panel instead.
 *
 * Only EXPLICIT permissions are here. What a principal gets through a role is
 * deliberately not merged in — a matrix that cannot tell the two apart makes
 * "revoke this" produce a statement that changes nothing, because the access
 * arrives from somewhere else.
 */
export function mssqlPermissionsSql(principal: string): string {
  return `SELECT
  pe.class,
  pe.state_desc,
  pe.permission_name,
  CASE pe.class
    WHEN 1 THEN ISNULL(SCHEMA_NAME(o.schema_id) + '.' + o.name, '')
    WHEN 3 THEN ISNULL(s.name, '')
    ELSE '' END                                  AS on_what,
  CONVERT(int, CASE WHEN pe.minor_id <> 0 THEN 1 ELSE 0 END) AS is_column
FROM sys.database_permissions pe
LEFT JOIN sys.objects o ON o.object_id = pe.major_id AND pe.class = 1
LEFT JOIN sys.schemas s ON s.schema_id = pe.major_id AND pe.class = 3
WHERE pe.grantee_principal_id = DATABASE_PRINCIPAL_ID(${lit(principal)})
ORDER BY pe.class, on_what, pe.permission_name`;
}

/** scope key → permission → state. */
export type MssqlGrantMap = Map<string, Map<MssqlPermission, MssqlGrantState>>;

/**
 * Catalog rows → the permission map the matrix renders.
 *
 * Rows naming a permission the matrix has no column for are ignored rather than
 * dropped into a catch-all: the grid does not show them, so it must not claim
 * to manage them, and the diff below only ever emits statements for columns the
 * user could actually see and change.
 */
export function parseMssqlPermissions(
  rows: readonly (readonly unknown[])[],
): { grants: MssqlGrantMap; columnGrants: number } {
  const grants: MssqlGrantMap = new Map();
  let columnGrants = 0;

  for (const row of rows) {
    const cls = Number(row[0]);
    const state = String(row[1] ?? '');
    const perm = String(row[2] ?? '').toUpperCase() as MssqlPermission;
    const onWhat = String(row[3] ?? '');
    if (String(row[4]) === '1') { columnGrants++; continue; }
    if (!PERM_ORDER.has(perm)) continue;

    let key: string;
    if (cls === 0) key = 'DATABASE';
    else if (cls === 3) key = `SCHEMA::${onWhat}`;
    else if (cls === 1) key = `OBJECT::${onWhat}`;
    else continue;   // certificate, symmetric key, assembly — not modelled

    let m = grants.get(key);
    if (!m) { m = new Map(); grants.set(key, m); }
    m.set(perm, stateFromDesc(state));
  }
  return { grants, columnGrants };
}

/** `sys.database_permissions.state_desc` → the cell's state. */
export function stateFromDesc(desc: string): MssqlGrantState {
  switch (desc.toUpperCase()) {
    case 'GRANT': return 'grant';
    case 'GRANT_WITH_GRANT_OPTION': return 'grant-with-option';
    case 'DENY': return 'deny';
    // REVOKE appears as a state_desc only transiently; it means no permission.
    default: return 'none';
  }
}

/** What this principal holds at one scope; every unlisted permission is `none`. */
export function mssqlStatesForScope(
  grants: MssqlGrantMap, scope: MssqlScope,
): Map<MssqlPermission, MssqlGrantState> {
  return new Map(grants.get(mssqlScopeKey(scope)) ?? []);
}

// ── writing ──────────────────────────────────────────────────────────────────

export interface MssqlGrantDiffArgs {
  /** The database principal, unquoted. */
  principal: string;
  /** The database the scope lives in — needed for `ON DATABASE::[name]`. */
  database: string;
  scope: MssqlScope;
  desired: ReadonlyMap<MssqlPermission, MssqlGrantState>;
  current: ReadonlyMap<MssqlPermission, MssqlGrantState>;
}

const inOrder = (perms: Iterable<MssqlPermission>): MssqlPermission[] =>
  [...new Set(perms)].sort((a, b) => PERM_ORDER.get(a)! - PERM_ORDER.get(b)!);

/**
 * The statements that move `current` to `desired`, ready for the editor.
 *
 * Returns `''` when nothing changed, so the panel can tell "nothing to do" from
 * "here is a statement".
 *
 * Two rules, both learned from the server rejecting the naive version.
 *
 * **Every REVOKE goes first.** Moving a permission from DENY to GRANT needs the
 * DENY revoked before the GRANT is issued, because in SQL Server a DENY still
 * in place wins over a GRANT that was just made — run the other way round, both
 * statements succeed and access does not change, which is the worst possible
 * outcome because it looks like it worked.
 *
 * **Revoking a `WITH GRANT OPTION` permission requires CASCADE.** There is no
 * form that does not: `REVOKE EXECUTE …` on a permission the principal may
 * pass on is Msg 4611, *"To revoke or deny grantable privileges, specify the
 * CASCADE option"* — measured, not read. So those permissions are revoked in
 * their own statement carrying CASCADE, and everything else in a plain one.
 * Splitting them is the point: CASCADE also revokes the permission from
 * everyone this principal granted it to, which is a much larger action than the
 * cell that produced it looks like, and it must not be applied to permissions
 * that never needed it. The panel shows the statement before it runs.
 */
export function mssqlGrantDiffSql(args: MssqlGrantDiffArgs): string {
  const { principal, database, scope, desired, current } = args;
  const on = mssqlScopeSql(scope, database);
  const to = q(principal);

  const revoke: MssqlPermission[] = [];
  // Revoking a permission the principal may pass on is refused without CASCADE
  // (Msg 4611), so those are kept apart and get their own statement.
  const revokeCascade: MssqlPermission[] = [];
  const grant: MssqlPermission[] = [];
  const grantWith: MssqlPermission[] = [];
  const deny: MssqlPermission[] = [];

  const all = new Set<MssqlPermission>([...desired.keys(), ...current.keys()]);
  for (const perm of all) {
    const want = desired.get(perm) ?? 'none';
    const have = current.get(perm) ?? 'none';
    if (want === have) continue;

    // Anything leaving a DENY must be revoked first; so must anything being
    // removed outright, and so must a WITH GRANT OPTION being downgraded —
    // plain GRANT does not take the option away (verified: the permission came
    // back still marked GRANT_WITH_GRANT_OPTION).
    if (have === 'grant-with-option') revokeCascade.push(perm);
    else if (have === 'deny' || want === 'none') revoke.push(perm);

    if (want === 'grant') grant.push(perm);
    else if (want === 'grant-with-option') grantWith.push(perm);
    else if (want === 'deny') deny.push(perm);
  }

  const out: string[] = [];
  if (revoke.length) {
    out.push(`REVOKE ${inOrder(revoke).join(', ')} ON ${on} FROM ${to};`);
  }
  if (revokeCascade.length) {
    out.push(
      '-- CASCADE is required here (Msg 4611) and also revokes these permissions\n'
      + '-- from anyone ' + principal + ' granted them to:\n'
      + `REVOKE ${inOrder(revokeCascade).join(', ')} ON ${on} FROM ${to} CASCADE;`);
  }
  if (grant.length) out.push(`GRANT ${inOrder(grant).join(', ')} ON ${on} TO ${to};`);
  if (grantWith.length) {
    out.push(`GRANT ${inOrder(grantWith).join(', ')} ON ${on} TO ${to} WITH GRANT OPTION;`);
  }
  if (deny.length) out.push(`DENY ${inOrder(deny).join(', ')} ON ${on} TO ${to};`);
  return out.join('\n');
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export interface MssqlUserSpec {
  /** The database user's name. */
  name: string;
  /** The server login it maps to; empty for a user without a login. */
  login?: string;
  /** SQL authentication password, when a login is being created too. */
  password?: string;
  defaultSchema?: string;
  /** Database roles to add the new principal to. */
  roles?: readonly string[];
}

/**
 * `CREATE LOGIN` + `CREATE USER`, in that order and as separate statements.
 *
 * They are separate objects at different levels — the login lives on the
 * instance, the user inside one database — and there is no single statement
 * that makes both. Emitting them together, with the order that works, is the
 * whole reason this helper exists.
 *
 * A user with no login is offered on purpose: it is how a contained database
 * user is made, and it is also the shape you want when the login already
 * exists. The password is only ever placed in the `CREATE LOGIN`.
 */
export function mssqlCreateUserSql(spec: MssqlUserSpec): string {
  const out: string[] = [];
  const user = q(spec.name);

  if (spec.login && spec.password) {
    // CHECK_POLICY is left at its default (ON): turning it off to make a
    // password go through is a decision for the person running the statement,
    // not one this tool should quietly make for them.
    out.push(`CREATE LOGIN ${q(spec.login)} WITH PASSWORD = ${lit(spec.password)};`);
  }

  // `CREATE USER u FOR LOGIN l WITH DEFAULT_SCHEMA = s` — the FOR clause comes
  // before WITH, and the options after WITH are comma-separated. A contained
  // user carries its password in the same WITH list instead of a login.
  const opts: string[] = [];
  if (!spec.login && spec.password) opts.push(`PASSWORD = ${lit(spec.password)}`);
  if (spec.defaultSchema) opts.push(`DEFAULT_SCHEMA = ${q(spec.defaultSchema)}`);

  out.push(
    `CREATE USER ${user}`
    + (spec.login ? ` FOR LOGIN ${q(spec.login)}` : '')
    + (opts.length ? ` WITH ${opts.join(', ')}` : '')
    + ';',
  );

  for (const role of spec.roles ?? []) {
    // ALTER ROLE … ADD MEMBER, not the deprecated sp_addrolemember.
    out.push(`ALTER ROLE ${q(role)} ADD MEMBER ${user};`);
  }
  return out.join('\n');
}

/** `CREATE ROLE`, optionally owned by a principal. */
export function mssqlCreateRoleSql(name: string, owner?: string): string {
  return `CREATE ROLE ${q(name)}${owner ? ` AUTHORIZATION ${q(owner)}` : ''};`;
}

/**
 * Drop a database user or role.
 *
 * The login is deliberately left alone. It is a server-level object that other
 * databases may still map users to, and dropping it because someone removed one
 * database's user would cut access they never asked to touch. The statement to
 * drop it is offered separately, as a comment, so the choice is visible.
 */
export function mssqlDropSql(p: Pick<MssqlPrincipal, 'name' | 'isRole' | 'login'>): string {
  const out = [`DROP ${p.isRole ? 'ROLE' : 'USER'} IF EXISTS ${q(p.name)};`];
  if (!p.isRole && p.login) {
    out.push(`-- The login is a SERVER object and may map users in other databases.`);
    out.push(`-- Drop it only if nothing else uses it:`);
    out.push(`-- DROP LOGIN ${q(p.login)};`);
  }
  return out.join('\n');
}

/** Add or remove a database role membership. */
export function mssqlRoleMemberSql(role: string, member: string, add: boolean): string {
  return `ALTER ROLE ${q(role)} ${add ? 'ADD' : 'DROP'} MEMBER ${q(member)};`;
}

/**
 * Reconnect an orphaned user to a login of the same name.
 *
 * The modern form; `sp_change_users_login` is deprecated and does not work for
 * contained databases.
 */
export function mssqlFixOrphanSql(user: string, login: string): string {
  return `ALTER USER ${q(user)} WITH LOGIN = ${q(login)};`;
}
