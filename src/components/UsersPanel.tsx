/**
 * 👤 Users & grants — the DBA's security view, TxUI-style:
 * reading is instant, WRITING IS REVIEW-ONLY. Every mutation (create user,
 * grant, revoke, drop…) is generated as SQL and inserted into the editor for
 * the DBA to inspect and run deliberately — this panel never executes writes.
 *
 *   MySQL — mysql.user list (host, lock/expire state, auth plugin),
 *           SHOW GRANTS per account.
 *   PG    — pg_roles with attributes (login/superuser/createdb/…),
 *           role memberships, and a table-privilege summary per role.
 *   MSSQL — sys.database_principals (users and roles, with the login behind
 *           each and whether it is orphaned), sys.database_permissions per
 *           principal, and a THREE-state matrix, because DENY is a state and
 *           not the absence of a grant. See utils/mssqlGrants.ts for why that
 *           is a separate module rather than a third branch of the MySQL one.
 */
import { errorDisplay } from '../utils/appError';
import { useServerFlavor } from '../store/serverFlavors';
import { sqlLiteral } from '../utils/sqlIdent';
import {
  PRIVILEGES, parseGrants, privsForScope, grantDiffSql,
  type Privilege, type Scope,
} from '../utils/grantMatrix';
import {
  PG_PRIVILEGES_BY_KIND, PG_DEFACL_OBJTYPE, PG_DEFAULT_OBJTYPE_KIND,
  buildAclMatrix, privMapForGrantee,
  pgGrantDiffSql, pgDefaultPrivDiffSql,
  mysqlCreateUserSql, mysqlAlterUserSql, mysqlDropUserSql,
  mysqlCreateRoleSql, mysqlGrantRoleSql, mysqlSetDefaultRoleSql, type MysqlRoleRef,
  pgCreateRoleSql, pgAlterRoleSql, pgDropRoleSql,
  type PgPrivilege, type PgPrivMap, type PgDefaultObjType,
  type PgEffectiveRow, type MysqlUserSpec, type MysqlPasswordExpire, type PgRoleSpec,
} from '../utils/privileges';
import {
  MSSQL_PERMISSIONS_BY_SCOPE, MSSQL_PRINCIPALS_SQL,
  mssqlPrincipalFromRow, mssqlPermissionsSql, parseMssqlPermissions,
  mssqlStatesForScope, mssqlGrantDiffSql, mssqlScopeLabel,
  mssqlCreateUserSql, mssqlCreateRoleSql, mssqlDropSql, mssqlRoleMemberSql,
  mssqlFixOrphanSql,
  type MssqlPermission, type MssqlGrantState, type MssqlScope, type MssqlScopeKind,
  type MssqlPrincipal,
} from '../utils/mssqlGrants';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';

interface Props {
  sessionId: string;
  engine: string;
  onClose: () => void;
}

interface UserRow {
  /** display key: user@host (MySQL) or role name (PG / SQL Server) */
  key: string;
  user: string;
  host?: string;
  flags: string[];     // locked / expired / superuser / nologin / …
  plugin?: string;
  /** SQL Server only — the principal behind the row, for the login/orphan detail. */
  ms?: MssqlPrincipal;
}

const MYSQL_USERS_SQL =
  "SELECT user, host, account_locked, password_expired, plugin, 'N' AS is_role FROM mysql.user ORDER BY user, host";
/**
 * MariaDB's account list.
 *
 * `mysql.user` there is a **view** over `mysql.global_priv` and has no
 * `account_locked` column — MySQL's query fails outright with "Unknown column",
 * so the panel showed a permissions message for what is really a dialect
 * difference. The lock lives in the `Priv` JSON instead.
 *
 * `is_role` has no MySQL equivalent: MariaDB stores roles as rows in the same
 * table, so without it every role in the schema appears in the list as a user
 * that cannot log in, with no indication why.
 *
 * Read from `global_priv` rather than the view because the view is the thing
 * that lacks the column, and 10.4+ is where both the view and the JSON exist.
 */
const MARIA_USERS_SQL =
  "SELECT u.user, u.host, "
  // `JSON_VALUE` renders a JSON boolean as 1, not as the string 'true' —
  // comparing against 'true' reported every locked account as unlocked, which
  // is the wrong direction for a security flag to fail in. Both spellings are
  // accepted so a version that renders it differently still reads correctly.
  + "CASE WHEN COALESCE(JSON_VALUE(g.Priv, '$.account_locked'), '0') IN ('1', 'true') "
  + "THEN 'Y' ELSE 'N' END AS account_locked, "
  + "u.password_expired, u.plugin, u.is_role "
  + "FROM mysql.user u "
  + "LEFT JOIN mysql.global_priv g ON g.User = u.User AND g.Host = u.Host "
  + "ORDER BY u.user, u.host";
const PG_ROLES_SQL =
  "SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolconnlimit, rolvaliduntil::text " +
  "FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname";
const PG_MEMBERS_SQL =
  "SELECT m.rolname AS member, g.rolname AS grp FROM pg_auth_members am " +
  "JOIN pg_roles m ON m.oid = am.member JOIN pg_roles g ON g.oid = am.roleid";
const PG_TABLE_PRIVS_SQL = (role: string) =>
  "SELECT table_schema, table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) " +
  `FROM information_schema.table_privileges WHERE grantee = ${sqlLiteral(role, 'postgres')} ` +
  "GROUP BY table_schema, table_name ORDER BY table_schema, table_name LIMIT 500";

// ── Grant-wizard catalogue reads (PostgreSQL) ────────────────────────────────
// All plain SELECTs through the ordinary query path — the acl columns are
// world-readable, so no elevated grant is needed to read them, and nothing
// here writes.
const PG_TABLE_ACL_SQL =
  "SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner), c.relacl::text " +
  "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE c.relkind IN ('r','v','m','p') " +
  "AND n.nspname NOT IN ('pg_catalog','information_schema') " +
  "ORDER BY n.nspname, c.relname LIMIT 2000";
const PG_SCHEMA_ACL_SQL =
  "SELECT nspname, pg_get_userbyid(nspowner), nspacl::text FROM pg_namespace " +
  "WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname";
const PG_DEFACL_SQL =
  "SELECT pg_get_userbyid(d.defaclrole), COALESCE(n.nspname, ''), d.defaclobjtype, d.defaclacl::text " +
  "FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace ORDER BY 1, 2, 3";

function pq(sessionId: string, sql: string): Promise<QueryResult> {
  return invoke<QueryResult>('panel_query', { sessionId, sql, token: crypto.randomUUID() });
}

/** A cell/string that may legitimately be SQL NULL — `relacl` when never granted. */
const asAclText = (v: unknown): string | null => (v == null ? null : String(v));

const q = (s: string) => sqlLiteral(s, 'mysql');
const mysqlAccount = (u: UserRow) => `${q(u.user)}@${q(u.host ?? '%')}`;

export function UsersPanel({ sessionId, engine, onClose }: Props) {
  const isMysql = engine === 'mysql';
  const isMssql = engine === 'sqlserver';
  // MySQL and MariaDB share the engine but not this catalog — see
  // MARIA_USERS_SQL for what differs.
  const isMaria = useServerFlavor(sessionId, engine).flavor === 'mariadb';
  const [users, setUsers] = useState<UserRow[]>([]);
  const [selected, setSelected] = useState<UserRow | null>(null);
  const [grants, setGrants] = useState<string[]>([]);
  const [memberships, setMemberships] = useState<Map<string, string[]>>(new Map());
  const [filter, setFilter] = useState('');
  // MySQL 8 roles: comma-separated names typed in the selected-account detail.
  const [roleInput, setRoleInput] = useState('');
  const parseRoles = (s: string): MysqlRoleRef[] =>
    s.split(',').map(x => x.trim()).filter(Boolean).map(name => ({ name }));
  const [error, setError] = useState<string | null>(null);
  const [loadingGrants, setLoadingGrants] = useState(false);

  // ── Grant matrix (MySQL) ─────────────────────────────────────────────────
  // A checkbox grid over PRIVILEGES at a chosen scope, pre-checked from the
  // account's own SHOW GRANTS, whose diff becomes GRANT/REVOKE for the editor.
  const [scopeKind, setScopeKind] = useState<'global' | 'database' | 'table'>('global');
  const [scopeDb, setScopeDb] = useState('');
  const [scopeTable, setScopeTable] = useState('');
  const [checked, setChecked] = useState<Set<Privilege>>(new Set());

  // ── Grant matrix (SQL Server) ────────────────────────────────────────────
  // Three states per cell, not two: DENY beats every GRANT — including ones
  // inherited from a role — so it cannot be modelled as an unticked box.
  const [msRows, setMsRows] = useState<(readonly unknown[])[]>([]);
  const [msScopeKind, setMsScopeKind] = useState<MssqlScopeKind>('schema');
  const [msSchema, setMsSchema] = useState('');
  const [msObject, setMsObject] = useState('');
  const [msWanted, setMsWanted] = useState<Map<MssqlPermission, MssqlGrantState>>(new Map());
  const [msDb, setMsDb] = useState('');

  // ── Grant wizard (PostgreSQL) ────────────────────────────────────────────
  // Opened per-role and lazy — it reads the whole relacl catalogue, which is a
  // heavier query than the account list, so it only fires when asked for.
  const [pgWizardOpen, setPgWizardOpen] = useState(false);
  useEffect(() => { setPgWizardOpen(false); }, [selected?.key]);

  // ── User / role lifecycle form (create / alter / drop) ────────────────────
  // A proper form beside the list + matrix that generates review-only
  // CREATE/ALTER/DROP into the editor — the lifecycle counterpart of the grant
  // matrix. `mode` picks create (blank) vs alter (pre-filled from the account).
  const [lifecycle, setLifecycle] = useState<{ mode: 'create' | 'alter'; account: UserRow | null } | null>(null);
  // A selection change while an alter form is open would leave it editing a
  // stale account, so close it — create is not tied to a selection.
  useEffect(() => { setLifecycle(cur => (cur?.mode === 'alter' ? null : cur)); }, [selected?.key]);

  const scope: Scope | null = useMemo(() => {
    if (scopeKind === 'global') return { kind: 'global' };
    if (!scopeDb.trim()) return null;
    if (scopeKind === 'database') return { kind: 'database', db: scopeDb.trim() };
    if (!scopeTable.trim()) return null;
    return { kind: 'table', db: scopeDb.trim(), table: scopeTable.trim() };
  }, [scopeKind, scopeDb, scopeTable]);

  const msScope: MssqlScope | null = useMemo(() => {
    if (msScopeKind === 'database') return { kind: 'database' };
    if (!msSchema.trim()) return null;
    if (msScopeKind === 'schema') return { kind: 'schema', schema: msSchema.trim() };
    if (!msObject.trim()) return null;
    return { kind: 'object', schema: msSchema.trim(), name: msObject.trim() };
  }, [msScopeKind, msSchema, msObject]);

  const msParsed = useMemo(() => parseMssqlPermissions(msRows), [msRows]);
  const msCurrent = useMemo(
    () => (msScope ? mssqlStatesForScope(msParsed.grants, msScope)
      : new Map<MssqlPermission, MssqlGrantState>()),
    [msParsed, msScope]);
  // Re-prime from the catalog whenever the scope or the principal changes: an
  // unsaved cell carried across a scope switch would silently widen the
  // generated GRANT, or worse, generate a DENY nobody asked for.
  useEffect(() => { setMsWanted(new Map(msCurrent)); }, [msCurrent]);

  const parsedGrants = useMemo(() => parseGrants(grants), [grants]);
  const currentPrivs = useMemo(
    () => (scope ? privsForScope(parsedGrants, scope) : new Set<Privilege>()),
    [parsedGrants, scope]);

  // Re-prime the boxes from the current grants whenever the scope or the
  // account (its grants) changes — an unsaved tick is not worth carrying across
  // a scope switch, and a stale one would silently widen the generated GRANT.
  useEffect(() => { setChecked(new Set(currentPrivs)); }, [currentPrivs]);

  const toggle = (p: Privilege) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });

  // ── Load account list ────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        if (isMssql) {
          const [pr, db] = await Promise.all([
            pq(sessionId, MSSQL_PRINCIPALS_SQL),
            // The database name is needed for `ON DATABASE::[name]`; asking the
            // server beats threading the tree's selection down here, because
            // the session's database is what the permissions were read from.
            pq(sessionId, 'SELECT DB_NAME()').catch(() => null),
          ]);
          setMsDb(String(db?.rows[0]?.[0] ?? ''));
          setUsers(pr.rows.map(row => {
            const p = mssqlPrincipalFromRow(row);
            const flags: string[] = [];
            if (p.isRole) flags.push('role');
            // An orphaned user owns permissions and nobody can connect as it.
            if (p.orphaned) flags.push('orphaned — no login');
            if (p.disabled) flags.push('login disabled');
            if (p.roles.length) flags.push(`member of ${p.roles.join(', ')}`);
            return {
              key: p.name, user: p.name, flags,
              plugin: p.typeDesc.toLowerCase().replace(/_/g, ' '),
              ms: p,
            };
          }));
        } else if (isMysql) {
          const r = await pq(sessionId, isMaria ? MARIA_USERS_SQL : MYSQL_USERS_SQL);
          setUsers(r.rows.map(row => {
            const flags: string[] = [];
            if (String(row[2]) === 'Y') flags.push('locked');
            if (String(row[3]) === 'Y') flags.push('password expired');
            // A MariaDB role is not an account. Listing it as one, with no
            // password and no way in, reads as a misconfigured user.
            if (String(row[5]) === 'Y') flags.push('role');
            return {
              key: `${row[0]}@${row[1]}`,
              user: String(row[0]), host: String(row[1]),
              flags, plugin: String(row[4] ?? ''),
            };
          }));
        } else {
          const [rolesR, memR] = await Promise.all([
            pq(sessionId, PG_ROLES_SQL),
            pq(sessionId, PG_MEMBERS_SQL).catch(() => null),
          ]);
          setUsers(rolesR.rows.map(row => {
            const flags: string[] = [];
            if (String(row[1]) === 'true') flags.push('superuser');
            if (String(row[2]) === 'true') flags.push('createrole');
            if (String(row[3]) === 'true') flags.push('createdb');
            if (String(row[4]) !== 'true') flags.push('nologin');
            if (String(row[5]) === 'true') flags.push('replication');
            if (row[7]) flags.push(`valid until ${row[7]}`);
            return { key: String(row[0]), user: String(row[0]), flags };
          }));
          const mem = new Map<string, string[]>();
          for (const row of memR?.rows ?? []) {
            const m = String(row[0]);
            mem.set(m, [...(mem.get(m) ?? []), String(row[1])]);
          }
          setMemberships(mem);
        }
        setError(null);
      } catch (e) {
        setError(`${errorDisplay(e)} — listing accounts needs ${
          isMssql ? 'VIEW DEFINITION on the database (or the securityadmin server role)'
            : `SELECT on ${isMysql ? 'mysql.user' : 'pg_roles'}`}`);
      }
    })();
    // isMaria arrives from an async probe, so it is false on the first render
    // even against MariaDB. Without it here the panel would run MySQL's query,
    // fail on the missing column, and never retry once the flavour was known.
  }, [sessionId, isMysql, isMssql, isMaria]);

  // ── Per-account grants ───────────────────────────────────────────────────
  const loadGrants = useCallback(async (u: UserRow) => {
    setSelected(u);
    setGrants([]);
    setLoadingGrants(true);
    try {
      if (isMssql) {
        const r = await pq(sessionId, mssqlPermissionsSql(u.user));
        setMsRows(r.rows);
        // Only EXPLICIT permissions are listed. What a principal gets through a
        // role is deliberately not merged in: a view that cannot tell them
        // apart makes "revoke this" produce a statement that changes nothing,
        // because the access arrives from somewhere else.
        setGrants(r.rows.map(row => {
          const cls = Number(row[0]);
          const where = cls === 0 ? 'DATABASE'
            : cls === 3 ? `SCHEMA::${row[3]}`
            : cls === 1 ? String(row[3])
            : `class ${cls}`;
          const state = String(row[1]).replace('GRANT_WITH_GRANT_OPTION', 'GRANT … WITH GRANT OPTION');
          return `${state} ${row[2]} ON ${where}${String(row[4]) === '1' ? '  (column-level)' : ''}`;
        }));
      } else if (isMysql) {
        const r = await pq(sessionId, `SHOW GRANTS FOR ${mysqlAccount(u)}`);
        setGrants(r.rows.map(row => String(row[0])));
      } else {
        const r = await pq(sessionId, PG_TABLE_PRIVS_SQL(u.user));
        setGrants(r.rows.map(row => `${row[0]}.${row[1]}: ${row[2]}`));
      }
      setError(null);
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setLoadingGrants(false);
    }
  }, [sessionId, isMysql, isMssql]);

  // ── Review-only SQL templates → editor ───────────────────────────────────
  const insertSql = (sql: string) => {
    window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${sql}\n` } }));
  };

  // Grant *shortcuts* — the whole-schema common cases. Account lifecycle
  // (create / alter / drop) is the form below, not a snippet.
  const templates: { label: string; sql: () => string; needsUser?: boolean }[] = isMssql ? [
    { label: 'Grant read on a schema', needsUser: true, sql: () =>
      `GRANT SELECT ON SCHEMA::[your_schema] TO [${selected!.user}];` },
    { label: 'Grant write on a schema', needsUser: true, sql: () =>
      `GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::[your_schema] TO [${selected!.user}];` },
    { label: 'Revoke all on a schema', needsUser: true, sql: () =>
      `REVOKE SELECT, INSERT, UPDATE, DELETE, REFERENCES, EXECUTE, ALTER, CONTROL\n`
      + `  ON SCHEMA::[your_schema] FROM [${selected!.user}];` },
    // The two fixed roles that cover most of what people actually want, named
    // rather than left for someone to remember.
    { label: 'Add to db_datareader', needsUser: true, sql: () =>
      mssqlRoleMemberSql('db_datareader', selected!.user, true) },
    { label: 'Add to db_datawriter', needsUser: true, sql: () =>
      mssqlRoleMemberSql('db_datawriter', selected!.user, true) },
  ] : isMysql ? [
    { label: 'Grant read on a schema', needsUser: true, sql: () =>
      `GRANT SELECT ON your_db.* TO ${mysqlAccount(selected!)};` },
    { label: 'Grant write on a schema', needsUser: true, sql: () =>
      `GRANT SELECT, INSERT, UPDATE, DELETE ON your_db.* TO ${mysqlAccount(selected!)};` },
    { label: 'Revoke all on a schema', needsUser: true, sql: () =>
      `REVOKE ALL PRIVILEGES ON your_db.* FROM ${mysqlAccount(selected!)};` },
  ] : [
    { label: 'Grant read on a schema', needsUser: true, sql: () =>
      `GRANT USAGE ON SCHEMA public TO "${selected!.user}";\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO "${selected!.user}";` },
    { label: 'Grant write on a schema', needsUser: true, sql: () =>
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${selected!.user}";` },
    { label: 'Revoke all on a schema', needsUser: true, sql: () =>
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${selected!.user}";` },
  ];

  const msDiffSql = (isMssql && selected && msScope)
    ? mssqlGrantDiffSql({
      principal: selected.user, database: msDb || 'the current database',
      scope: msScope, desired: msWanted, current: msCurrent,
    })
    : '';

  // The GRANT/REVOKE for the ticked-vs-current difference — '' when they match.
  const matrixDiffSql = (isMysql && selected && scope)
    ? grantDiffSql({ account: mysqlAccount(selected), scope, desired: checked, current: currentPrivs })
    : '';

  const shown = users.filter(u =>
    !filter.trim() || u.key.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">👤 Users & grants</span>
        <span className="dv-desc">read-only view — every change is generated as SQL into the editor for review</span>
        <div style={{ flex: 1 }} />
        <input
          className="up-filter" placeholder="filter…"
          value={filter} onChange={e => setFilter(e.target.value)}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="up-body">
        <div className="up-list">
          <div className="up-actions">
            <button
              className="toolbar-btn"
              onClick={() => setLifecycle({ mode: 'create', account: null })}
            >
              {isMssql ? '+ Create user / role…' : isMysql ? '+ Create user…' : '+ Create role…'}
            </button>
          </div>
          {shown.map(u => (
            <div
              key={u.key}
              className={`up-row ${selected?.key === u.key ? 'selected' : ''}`}
              onClick={() => loadGrants(u)}
            >
              <span className="up-name">{u.user}</span>
              {u.host && <span className="up-host">@{u.host}</span>}
              {u.flags.map(f => (
                <span key={f} className={`up-flag ${/locked|expired|nologin/.test(f) ? 'up-flag-warn' : ''}`}>{f}</span>
              ))}
            </div>
          ))}
          {shown.length === 0 && <div className="mx-empty">No accounts match.</div>}
        </div>

        <div className="up-detail">
          {lifecycle && isMssql && (
            <MssqlLifecycleForm
              mode={lifecycle.mode} principal={lifecycle.account?.ms ?? null}
              insertSql={insertSql} onDone={() => setLifecycle(null)}
            />
          )}
          {lifecycle && !isMssql && (
            <UserLifecycleForm
              isMysql={isMysql} mode={lifecycle.mode} account={lifecycle.account}
              insertSql={insertSql} onDone={() => setLifecycle(null)}
            />
          )}
          {!lifecycle && !selected && <div className="mx-empty">Select an account to see its grants.</div>}
          {!lifecycle && selected && (
            <>
              <div className="up-detail-head">
                <b>{selected.user}{selected.host ? `@${selected.host}` : ''}</b>
                {selected.plugin && <span className="dv-desc">auth: {selected.plugin}</span>}
                {isMssql && selected.ms && !selected.ms.isRole && (
                  <span className="dv-desc">
                    login: {selected.ms.login || '— none (orphaned)'}
                    {selected.ms.defaultSchema && ` · default schema ${selected.ms.defaultSchema}`}
                  </span>
                )}
                {!isMysql && !isMssql && (memberships.get(selected.user)?.length ?? 0) > 0 && (
                  <span className="dv-desc">member of: {memberships.get(selected.user)!.join(', ')}</span>
                )}
                <div style={{ flex: 1 }} />
                <button
                  className="toolbar-btn"
                  onClick={() => setLifecycle({ mode: 'alter', account: selected })}
                >
                  Alter / drop…
                </button>
              </div>
              <div className="up-grants">
                {loadingGrants && <div className="mx-empty">Loading grants…</div>}
                {!loadingGrants && grants.length === 0 && (
                  <div className="mx-empty">{
                    isMssql
                      ? 'No explicit permissions. Access may still arrive through a database role — '
                        + 'role membership is shown beside the name in the list.'
                      : isMysql ? 'No grants readable.'
                      : 'No explicit table privileges (may inherit via role membership).'
                  }</div>
                )}
                {grants.map((g, i) => <code key={i} className="up-grant">{g}</code>)}
              </div>
              {isMssql && (
                <div className="up-templates" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                  <span className="dv-desc">
                    Permission matrix — three states, because <b>DENY</b> is a state and not an
                    unticked box: it beats every GRANT, including ones inherited from a role.
                    Changes are generated as SQL for review.
                  </span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      className="up-filter" value={msScopeKind}
                      onChange={e => setMsScopeKind(e.target.value as MssqlScopeKind)}
                    >
                      <option value="database">Database — everything in it</option>
                      <option value="schema">Schema — every object in it, now and later</option>
                      <option value="object">Object — one table, view or routine</option>
                    </select>
                    {msScopeKind !== 'database' && (
                      <input
                        className="up-filter" placeholder="schema (e.g. sales)" value={msSchema}
                        onChange={e => setMsSchema(e.target.value)}
                        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                      />
                    )}
                    {msScopeKind === 'object' && (
                      <input
                        className="up-filter" placeholder="object (e.g. orders)" value={msObject}
                        onChange={e => setMsObject(e.target.value)}
                        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                      />
                    )}
                  </div>
                  {msParsed.columnGrants > 0 && (
                    <span className="dv-desc">
                      {msParsed.columnGrants} column-level permission(s) exist and are not shown here —
                      the grid has no column axis, and showing one as a table permission would claim
                      access to the other columns.
                    </span>
                  )}
                  {!msScope && (
                    <span className="dv-desc">
                      Enter {msScopeKind === 'object' ? 'a schema and an object' : 'a schema'} name to load the matrix.
                    </span>
                  )}
                  {msScope && (
                    <>
                      <div className="dv-desc">at {mssqlScopeLabel(msScope, msDb || 'this database')}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 14px' }}>
                        {MSSQL_PERMISSIONS_BY_SCOPE[msScopeKind].map(perm => {
                          const state = msWanted.get(perm) ?? 'none';
                          return (
                            <label key={perm} style={{ display: 'flex', alignItems: 'center', gap: 4, width: 260 }}>
                              <select
                                className="up-filter"
                                style={{ width: 92 }}
                                value={state}
                                onChange={e => setMsWanted(prev => {
                                  const next = new Map(prev);
                                  const v = e.target.value as MssqlGrantState;
                                  if (v === 'none') next.delete(perm); else next.set(perm, v);
                                  return next;
                                })}
                              >
                                <option value="none">—</option>
                                <option value="grant">GRANT</option>
                                <option value="grant-with-option">+ OPTION</option>
                                <option value="deny">DENY</option>
                              </select>
                              <span
                                className="dv-desc"
                                style={{ color: state === 'deny' ? 'var(--danger, #c33)' : 'inherit' }}
                              >{perm}</span>
                            </label>
                          );
                        })}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button
                          className="toolbar-btn" disabled={!msDiffSql}
                          onClick={() => msDiffSql && insertSql(msDiffSql)}
                        >
                          Apply changes → editor
                        </button>
                        <span className="dv-desc">
                          {msDiffSql
                            ? 'every REVOKE is emitted first — a DENY still in place beats a GRANT just issued'
                            : 'no changes at this scope'}
                        </span>
                      </div>
                      {selected.ms?.orphaned && (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            className="toolbar-btn"
                            onClick={() => insertSql(mssqlFixOrphanSql(selected.user, selected.user))}
                          >
                            Reconnect to a login → editor
                          </button>
                          <span className="dv-desc">
                            this user has no login, so nobody can connect as it — the statement assumes
                            a login of the same name
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              {isMysql && (
                <div className="up-templates" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                  <span className="dv-desc">Privilege matrix — tick to generate GRANT/REVOKE for the diff (review-only):</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      className="up-filter" value={scopeKind}
                      onChange={e => setScopeKind(e.target.value as 'global' | 'database' | 'table')}
                    >
                      <option value="global">Global — *.*</option>
                      <option value="database">Database — db.*</option>
                      <option value="table">Table — db.tbl</option>
                    </select>
                    {scopeKind !== 'global' && (
                      <input
                        className="up-filter" placeholder="database" value={scopeDb}
                        onChange={e => setScopeDb(e.target.value)}
                        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                      />
                    )}
                    {scopeKind === 'table' && (
                      <input
                        className="up-filter" placeholder="table" value={scopeTable}
                        onChange={e => setScopeTable(e.target.value)}
                        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                      />
                    )}
                  </div>
                  {!scope && (
                    <span className="dv-desc">
                      Enter a {scopeKind === 'table' ? 'database and table' : 'database'} name to load the matrix.
                    </span>
                  )}
                  {scope && (
                    <>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px' }}>
                        {PRIVILEGES.map(p => (
                          <label
                            key={p}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, width: 168, cursor: 'pointer' }}
                          >
                            <input type="checkbox" checked={checked.has(p)} onChange={() => toggle(p)} />
                            <span className="dv-desc" style={{ color: 'inherit' }}>{p}</span>
                          </label>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button
                          className="toolbar-btn" disabled={!matrixDiffSql}
                          onClick={() => matrixDiffSql && insertSql(matrixDiffSql)}
                        >
                          Apply changes → editor
                        </button>
                        <span className="dv-desc">
                          {matrixDiffSql ? 'generates GRANT/REVOKE for review' : 'no changes at this scope'}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
              {isMysql && !isMaria && (
                <div className="up-templates" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                  <span className="dv-desc">Roles (MySQL 8) — generated as SQL for review:</span>
                  <input className="td-in" placeholder="role names, comma-separated (e.g. app_ro, app_rw)"
                    value={roleInput} onChange={e => setRoleInput(e.target.value)} />
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="toolbar-btn" disabled={!roleInput.trim()}
                      onClick={() => insertSql(mysqlCreateRoleSql(parseRoles(roleInput), { ifNotExists: true }))}>
                      Create role(s)
                    </button>
                    <button className="toolbar-btn" disabled={!roleInput.trim()}
                      onClick={() => insertSql(mysqlGrantRoleSql(parseRoles(roleInput), { user: selected.user, host: selected.host }))}>
                      Grant to {selected.user}
                    </button>
                    <button className="toolbar-btn" disabled={!roleInput.trim()}
                      onClick={() => insertSql(mysqlSetDefaultRoleSql({ user: selected.user, host: selected.host }, parseRoles(roleInput)))}>
                      Set as default
                    </button>
                    <button className="toolbar-btn"
                      onClick={() => insertSql(mysqlSetDefaultRoleSql({ user: selected.user, host: selected.host }, 'ALL'))}>
                      Default: ALL
                    </button>
                  </div>
                </div>
              )}
              {!isMysql && !isMssql && (
                <div className="up-templates" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                  {!pgWizardOpen ? (
                    <button className="toolbar-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setPgWizardOpen(true)}>
                      Open Grant Wizard…
                    </button>
                  ) : (
                    <PgGrantWizard sessionId={sessionId} role={selected.user} insertSql={insertSql} />
                  )}
                </div>
              )}
              <div className="up-templates">
                <span className="dv-desc">Generate SQL → editor (review before running):</span>
                {templates.filter(t => t.needsUser).map(t => (
                  <button key={t.label} className="toolbar-btn" onClick={() => insertSql(t.sql())}>{t.label}</button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// User / role lifecycle form (create / alter / drop)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The account counterpart of the privilege matrix: a real form for
 * CREATE / ALTER / DROP, so a new user is filled in field-by-field instead of
 * hand-edited from a snippet. Like everything in 👤 Users & grants it only
 * generates SQL for the editor — the builders in `privileges.ts` are pure and
 * this form never executes, logs or persists anything it is typed.
 *
 * Booleans are tri-state selects (`—` leaves the attribute untouched, which for
 * ALTER is the difference between "don't change" and "turn off"); a blank text
 * field is likewise omitted. DROP lives here too, in ALTER mode, with `IF
 * EXISTS` opt-in and a danger-styled button — destructive SQL still only lands
 * in the editor for the DBA to run deliberately.
 */
type Tri = '' | 'yes' | 'no';

/** A `—/yes/no` attribute picker; `—` (empty) means "leave as-is". */
function TriSelect({ label, value, onChange }: { label: string; value: Tri; onChange: (v: Tri) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span className="dv-desc" style={{ color: 'inherit', width: 96 }}>{label}</span>
      <select className="up-filter" style={{ width: 90 }} value={value} onChange={e => onChange(e.target.value as Tri)}>
        <option value="">—</option>
        <option value="yes">yes</option>
        <option value="no">no</option>
      </select>
    </label>
  );
}

const MYSQL_AUTH_PLUGINS = ['caching_sha2_password', 'mysql_native_password', 'sha256_password', 'auth_socket'];

function UserLifecycleForm({
  isMysql, mode, account, insertSql, onDone,
}: {
  isMysql: boolean;
  mode: 'create' | 'alter';
  account: UserRow | null;
  insertSql: (sql: string) => void;
  onDone: () => void;
}) {
  // ── shared ──
  const [ifExists, setIfExists] = useState(true);

  // ── MySQL fields ──
  const [myUser, setMyUser] = useState(mode === 'create' ? '' : account?.user ?? '');
  const [myHost, setMyHost] = useState(mode === 'create' ? '%' : account?.host ?? '%');
  const [myPlugin, setMyPlugin] = useState('');
  const [mySsl, setMySsl] = useState<Tri>('');
  const [myLock, setMyLock] = useState<Tri>('');
  const [myLimit, setMyLimit] = useState('');
  const [myExpire, setMyExpire] = useState<'' | 'now' | 'default' | 'never' | 'interval'>('');
  const [myExpireDays, setMyExpireDays] = useState('90');

  // ── PostgreSQL fields ──
  const [pgName, setPgName] = useState(mode === 'create' ? '' : account?.user ?? '');
  const [pgLogin, setPgLogin] = useState<Tri>(mode === 'create' ? 'yes' : '');
  const [pgSuper, setPgSuper] = useState<Tri>('');
  const [pgCreateDb, setPgCreateDb] = useState<Tri>('');
  const [pgCreateRole, setPgCreateRole] = useState<Tri>('');
  const [pgInherit, setPgInherit] = useState<Tri>('');
  const [pgRepl, setPgRepl] = useState<Tri>('');
  const [pgValidUntil, setPgValidUntil] = useState('');
  const [pgConnLimit, setPgConnLimit] = useState('');

  // ── password + rename (both engines) ──
  const [pwMode, setPwMode] = useState<'' | 'set' | 'null'>(mode === 'create' ? 'set' : '');
  const [password, setPassword] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [renameHost, setRenameHost] = useState(account?.host ?? '%');

  const num = (s: string): number | undefined => {
    const t = s.trim();
    if (t === '') return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };
  const tri = (v: Tri): boolean | undefined => (v === '' ? undefined : v === 'yes');

  // Build the review-only SQL from the fields. Pure string work — cheap enough
  // to recompute every render, which sidesteps a stale useMemo.
  let sql = '';
  if (isMysql) {
    const spec: MysqlUserSpec = { user: myUser.trim(), host: myHost.trim() || '%' };
    if (pwMode === 'set') spec.password = password;
    if (myPlugin) spec.authPlugin = myPlugin;
    if (tri(mySsl) !== undefined) spec.requireSsl = tri(mySsl);
    if (tri(myLock) !== undefined) spec.accountLock = tri(myLock);
    const lim = num(myLimit);
    if (lim !== undefined) spec.maxUserConnections = lim;
    if (myExpire) {
      spec.passwordExpire =
        myExpire === 'interval'
          ? ({ intervalDays: num(myExpireDays) ?? 0 } as MysqlPasswordExpire)
          : myExpire;
    }
    if (mode === 'create') {
      sql = spec.user ? mysqlCreateUserSql(spec, { ifNotExists: ifExists }) : '';
    } else if (account) {
      const wantRename = renameTo.trim() !== '' &&
        (renameTo.trim() !== account.user || (renameHost.trim() || '%') !== (account.host ?? '%'));
      sql = mysqlAlterUserSql(
        { user: account.user, host: account.host }, spec,
        wantRename ? { rename: { user: renameTo.trim(), host: renameHost.trim() || '%' } } : {},
      );
    }
  } else {
    const spec: PgRoleSpec = { name: (mode === 'create' ? pgName : account?.user ?? '').trim() };
    if (tri(pgLogin) !== undefined) spec.login = tri(pgLogin);
    if (tri(pgSuper) !== undefined) spec.superuser = tri(pgSuper);
    if (tri(pgCreateDb) !== undefined) spec.createdb = tri(pgCreateDb);
    if (tri(pgCreateRole) !== undefined) spec.createrole = tri(pgCreateRole);
    if (tri(pgInherit) !== undefined) spec.inherit = tri(pgInherit);
    if (tri(pgRepl) !== undefined) spec.replication = tri(pgRepl);
    if (pwMode === 'set') spec.password = password;
    else if (pwMode === 'null') spec.password = null;
    if (pgValidUntil.trim()) spec.validUntil = pgValidUntil.trim();
    const cl = num(pgConnLimit);
    if (cl !== undefined) spec.connectionLimit = cl;
    if (mode === 'create') {
      sql = spec.name ? pgCreateRoleSql(spec) : '';
    } else if (account) {
      const wantRename = renameTo.trim() !== '' && renameTo.trim() !== account.user;
      sql = pgAlterRoleSql(spec, wantRename ? { rename: renameTo.trim() } : {});
    }
  }

  const dropSql = account
    ? (isMysql
        ? mysqlDropUserSql([{ user: account.user, host: account.host }], { ifExists })
        : pgDropRoleSql([account.user], { ifExists }))
    : '';

  const title = mode === 'create'
    ? (isMysql ? 'Create user' : 'Create role')
    : `Alter ${isMysql ? `${account?.user}@${account?.host ?? '%'}` : account?.user}`;

  return (
    <div className="up-templates" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, borderTop: 'none', paddingTop: 0 }}>
      <div className="up-detail-head">
        <b>{title}</b>
        <span className="dv-desc">review-only — generates SQL into the editor, never executes</span>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={onDone}>Close</button>
      </div>

      {/* identity */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {isMysql ? (
          mode === 'create' ? (
            <>
              <input
                className="up-filter" placeholder="user name" value={myUser}
                onChange={e => setMyUser(e.target.value)}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
              <span className="dv-desc">@</span>
              <input
                className="up-filter" placeholder="host (%)" value={myHost} style={{ width: 110 }}
                onChange={e => setMyHost(e.target.value)}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
            </>
          ) : (
            <>
              <span className="dv-desc">rename to</span>
              <input
                className="up-filter" placeholder="new user (blank = keep)" value={renameTo}
                onChange={e => setRenameTo(e.target.value)}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
              <span className="dv-desc">@</span>
              <input
                className="up-filter" placeholder="host" value={renameHost} style={{ width: 110 }}
                onChange={e => setRenameHost(e.target.value)}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
            </>
          )
        ) : (
          mode === 'create' ? (
            <input
              className="up-filter" placeholder="role name" value={pgName}
              onChange={e => setPgName(e.target.value)}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            />
          ) : (
            <>
              <span className="dv-desc">rename to</span>
              <input
                className="up-filter" placeholder="new role name (blank = keep)" value={renameTo}
                onChange={e => setRenameTo(e.target.value)}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
            </>
          )
        )}
      </div>

      {/* password */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="dv-desc" style={{ color: 'inherit', width: 96 }}>password</span>
          <select className="up-filter" style={{ width: 130 }} value={pwMode} onChange={e => setPwMode(e.target.value as '' | 'set' | 'null')}>
            <option value="">{mode === 'create' ? 'none' : 'unchanged'}</option>
            <option value="set">set…</option>
            {!isMysql && <option value="null">remove (NULL)</option>}
          </select>
        </label>
        {pwMode === 'set' && (
          <input
            className="up-filter" type="password" placeholder="password" value={password}
            onChange={e => setPassword(e.target.value)} style={{ width: 180 }}
            autoComplete="new-password" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          />
        )}
        {isMysql && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="dv-desc" style={{ color: 'inherit' }}>auth</span>
            <select className="up-filter" style={{ width: 190 }} value={myPlugin} onChange={e => setMyPlugin(e.target.value)}>
              <option value="">default plugin</option>
              {MYSQL_AUTH_PLUGINS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        )}
      </div>

      {/* attributes */}
      {isMysql ? (
        <div style={{ display: 'flex', gap: '4px 18px', flexWrap: 'wrap' }}>
          <TriSelect label="REQUIRE SSL" value={mySsl} onChange={setMySsl} />
          <TriSelect label="account lock" value={myLock} onChange={setMyLock} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="dv-desc" style={{ color: 'inherit', width: 130 }}>max_user_connections</span>
            <input
              className="up-filter" style={{ width: 70 }} placeholder="—" value={myLimit}
              onChange={e => setMyLimit(e.target.value)} inputMode="numeric"
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="dv-desc" style={{ color: 'inherit', width: 96 }}>password expire</span>
            <select className="up-filter" style={{ width: 110 }} value={myExpire} onChange={e => setMyExpire(e.target.value as typeof myExpire)}>
              <option value="">—</option>
              <option value="now">now</option>
              <option value="default">default</option>
              <option value="never">never</option>
              <option value="interval">interval…</option>
            </select>
            {myExpire === 'interval' && (
              <input
                className="up-filter" style={{ width: 60 }} value={myExpireDays}
                onChange={e => setMyExpireDays(e.target.value)} inputMode="numeric" title="days"
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
            )}
          </label>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '4px 18px', flexWrap: 'wrap' }}>
            <TriSelect label="LOGIN" value={pgLogin} onChange={setPgLogin} />
            <TriSelect label="SUPERUSER" value={pgSuper} onChange={setPgSuper} />
            <TriSelect label="CREATEDB" value={pgCreateDb} onChange={setPgCreateDb} />
            <TriSelect label="CREATEROLE" value={pgCreateRole} onChange={setPgCreateRole} />
            <TriSelect label="INHERIT" value={pgInherit} onChange={setPgInherit} />
            <TriSelect label="REPLICATION" value={pgRepl} onChange={setPgRepl} />
          </div>
          <div style={{ display: 'flex', gap: '4px 18px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="dv-desc" style={{ color: 'inherit', width: 96 }}>valid until</span>
              <input
                className="up-filter" placeholder="2027-01-01 or infinity" value={pgValidUntil}
                onChange={e => setPgValidUntil(e.target.value)} style={{ width: 170 }}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="dv-desc" style={{ color: 'inherit', width: 110 }}>connection limit</span>
              <input
                className="up-filter" style={{ width: 70 }} placeholder="—" value={pgConnLimit}
                onChange={e => setPgConnLimit(e.target.value)} inputMode="numeric" title="-1 = unlimited"
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
            </label>
          </div>
        </>
      )}

      {mode === 'create' && isMysql && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={ifExists} onChange={e => setIfExists(e.target.checked)} />
          <span className="dv-desc" style={{ color: 'inherit' }}>IF NOT EXISTS</span>
        </label>
      )}

      {/* preview + apply */}
      <div className="up-grants">
        {sql
          ? sql.split('\n').map((line, i) => <code key={i} className="up-grant">{line}</code>)
          : <span className="dv-desc">{mode === 'create' ? 'Fill in a name to preview the statement.' : 'Change a field to preview the ALTER.'}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="toolbar-btn" disabled={!sql} onClick={() => sql && insertSql(sql)}>
          {mode === 'create' ? 'Create → editor' : 'Apply changes → editor'}
        </button>
        <span className="dv-desc">generates review-only SQL</span>
      </div>

      {/* drop (alter mode only) */}
      {mode === 'alter' && account && (
        <div className="up-templates" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <span className="dv-desc">
            Drop {isMysql ? 'user' : 'role'} — destructive; the generated <code>DROP</code> still lands in the editor for review.
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={ifExists} onChange={e => setIfExists(e.target.checked)} />
              <span className="dv-desc" style={{ color: 'inherit' }}>IF EXISTS</span>
            </label>
            <button className="toolbar-btn td-danger" onClick={() => insertSql(dropSql)}>
              Drop {isMysql ? `${account.user}@${account.host ?? '%'}` : account.user} → editor
            </button>
            <code className="up-grant">{dropSql}</code>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PostgreSQL Grant Wizard
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The PG answer to the MySQL privilege matrix. It decodes `relacl` / `nspacl`
 * into an effective grantee × privilege grid for a chosen object, lets the DBA
 * re-tick the selected role's privileges (and their grant option), and diffs
 * that back into reviewable GRANT/REVOKE. A second panel does the same for
 * `pg_default_acl` via ALTER DEFAULT PRIVILEGES. Like everything in 👤 Users &
 * grants, it only ever generates SQL for the editor — it never writes.
 */
interface PgObj {
  kind: 'table' | 'schema';
  schema?: string;
  name: string;
  owner: string;
  acl: string | null;
  key: string;
  label: string;
}
interface PgDefAcl {
  ownerRole: string;
  schema: string;
  objType: PgDefaultObjType;
  acl: string | null;
}

function PgGrantWizard(
  { sessionId, role, insertSql }: { sessionId: string; role: string; insertSql: (sql: string) => void },
) {
  const [objects, setObjects] = useState<PgObj[]>([]);
  const [defAcls, setDefAcls] = useState<PgDefAcl[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Object-level grant editor.
  const [objKind, setObjKind] = useState<'table' | 'schema'>('table');
  const [objKey, setObjKey] = useState('');
  const [checked, setChecked] = useState<PgPrivMap>(new Map());

  // Default-privilege editor.
  const [defObjType, setDefObjType] = useState<PgDefaultObjType>('TABLES');
  const [defSchema, setDefSchema] = useState('');
  const [defGrantee, setDefGrantee] = useState('');
  const [defChecked, setDefChecked] = useState<PgPrivMap>(new Map());

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [tblR, schR, defR] = await Promise.all([
          pq(sessionId, PG_TABLE_ACL_SQL),
          pq(sessionId, PG_SCHEMA_ACL_SQL),
          pq(sessionId, PG_DEFACL_SQL).catch(() => null),
        ]);
        const objs: PgObj[] = [];
        for (const row of tblR.rows) {
          const schema = String(row[0]);
          const name = String(row[1]);
          objs.push({
            kind: 'table', schema, name, owner: String(row[2]), acl: asAclText(row[3]),
            key: `${schema}.${name}`, label: `${schema}.${name}`,
          });
        }
        for (const row of schR.rows) {
          const name = String(row[0]);
          objs.push({
            kind: 'schema', name, owner: String(row[1]), acl: asAclText(row[2]),
            key: name, label: name,
          });
        }
        setObjects(objs);
        const defs: PgDefAcl[] = [];
        for (const row of defR?.rows ?? []) {
          const meta = PG_DEFACL_OBJTYPE[String(row[2])];
          if (!meta) continue; // an objtype the wizard does not model
          defs.push({
            ownerRole: String(row[0]), schema: String(row[1] ?? ''),
            objType: meta.label, acl: asAclText(row[3]),
          });
        }
        setDefAcls(defs);
        setErr(null);
      } catch (e) {
        setErr(`${errorDisplay(e)} — the wizard needs SELECT on pg_class / pg_namespace`);
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId]);

  const objsOfKind = useMemo(() => objects.filter(o => o.kind === objKind), [objects, objKind]);
  const selectedObj = useMemo(
    () => objsOfKind.find(o => o.key === objKey) ?? null, [objsOfKind, objKey]);

  const matrix: PgEffectiveRow[] = useMemo(
    () => (selectedObj ? buildAclMatrix(selectedObj.acl, selectedObj.kind, selectedObj.owner) : []),
    [selectedObj]);
  const current = useMemo(() => privMapForGrantee(matrix, role, false), [matrix, role]);

  // Re-prime the boxes from the object's current grants whenever the object (or
  // role) changes — a stale tick would silently widen the generated GRANT.
  useEffect(() => { setChecked(new Map(current)); }, [current]);

  const objPrivs = selectedObj ? PG_PRIVILEGES_BY_KIND[selectedObj.kind] : [];
  const toggleGranted = (p: PgPrivilege) => setChecked(prev => {
    const n = new Map(prev);
    if (n.has(p)) n.delete(p); else n.set(p, false);
    return n;
  });
  const toggleOption = (p: PgPrivilege) => setChecked(prev => {
    const n = new Map(prev);
    if (n.has(p)) n.set(p, !n.get(p));
    return n;
  });

  const objDiffSql = selectedObj
    ? pgGrantDiffSql({
      target: { kind: selectedObj.kind, schema: selectedObj.schema, name: selectedObj.name },
      grantee: role, desired: checked, current,
    })
    : '';

  // ── default privileges ─────────────────────────────────────────────────────
  const defKind = PG_DEFAULT_OBJTYPE_KIND[defObjType];
  const defPrivs = PG_PRIVILEGES_BY_KIND[defKind];
  const defCurrent = useMemo(() => {
    const row = defAcls.find(d =>
      d.ownerRole === role && d.schema === defSchema.trim() && d.objType === defObjType);
    if (!row) return new Map() as PgPrivMap;
    const rows = buildAclMatrix(row.acl, defKind, role);
    return privMapForGrantee(rows, defGrantee.trim(), !defGrantee.trim());
  }, [defAcls, role, defSchema, defObjType, defKind, defGrantee]);

  useEffect(() => { setDefChecked(new Map(defCurrent)); }, [defCurrent]);

  const toggleDefGranted = (p: PgPrivilege) => setDefChecked(prev => {
    const n = new Map(prev);
    if (n.has(p)) n.delete(p); else n.set(p, false);
    return n;
  });
  const toggleDefOption = (p: PgPrivilege) => setDefChecked(prev => {
    const n = new Map(prev);
    if (n.has(p)) n.set(p, !n.get(p));
    return n;
  });

  const defDiffSql = pgDefaultPrivDiffSql({
    forRole: role,
    inSchema: defSchema.trim() || undefined,
    objType: defObjType,
    grantee: defGrantee.trim() || 'PUBLIC',
    isPublic: !defGrantee.trim(),
    desired: defChecked,
    current: defCurrent,
  });

  const mark = (cell: { granted: boolean; grantOption: boolean }) =>
    cell.granted ? (cell.grantOption ? '✓*' : '✓') : '·';

  if (loading) return <span className="dv-desc">Loading privilege catalogue…</span>;
  if (err) return <span className="dv-desc up-flag-warn">{err}</span>;

  return (
    <>
      <span className="dv-desc">
        Grant Wizard — decode <code>relacl</code> into an effective matrix, re-tick, and generate
        GRANT/REVOKE for the diff (review-only). <code>✓*</code> = WITH GRANT OPTION.
      </span>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          className="up-filter" value={objKind}
          onChange={e => { setObjKind(e.target.value as 'table' | 'schema'); setObjKey(''); }}
        >
          <option value="table">Tables / views</option>
          <option value="schema">Schemas</option>
        </select>
        <select className="up-filter" value={objKey} onChange={e => setObjKey(e.target.value)} style={{ minWidth: 220 }}>
          <option value="">— pick a {objKind} —</option>
          {objsOfKind.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </div>

      {!selectedObj && <span className="dv-desc">Pick a {objKind} to see who holds what.</span>}

      {selectedObj && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="up-matrix">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>grantee</th>
                  {objPrivs.map(p => <th key={p} title={p}>{p.slice(0, 4)}</th>)}
                </tr>
              </thead>
              <tbody>
                {matrix.length === 0 && (
                  <tr><td colSpan={objPrivs.length + 1} className="dv-desc">Owner-only (default privileges).</td></tr>
                )}
                {matrix.map(r => (
                  <tr key={r.grantee + String(r.isPublic)} className={r.grantee === role && !r.isPublic ? 'selected' : ''}>
                    <td style={{ textAlign: 'left' }}>{r.isPublic ? 'PUBLIC' : r.grantee}</td>
                    {objPrivs.map(p => <td key={p} style={{ textAlign: 'center' }}>{mark(r.privileges.get(p)!)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <span className="dv-desc">Edit privileges for <b>{role}</b> on this {selectedObj.kind}:</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px' }}>
            {objPrivs.map(p => (
              <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, width: 200 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked.has(p)} onChange={() => toggleGranted(p)} />
                  <span className="dv-desc" style={{ color: 'inherit' }}>{p}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: checked.has(p) ? 'pointer' : 'default', opacity: checked.has(p) ? 1 : 0.4 }} title="WITH GRANT OPTION">
                  <input type="checkbox" disabled={!checked.has(p)} checked={checked.get(p) ?? false} onChange={() => toggleOption(p)} />
                  <span className="dv-desc" style={{ color: 'inherit' }}>grant</span>
                </label>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="toolbar-btn" disabled={!objDiffSql} onClick={() => objDiffSql && insertSql(objDiffSql)}>
              Apply changes → editor
            </button>
            <span className="dv-desc">{objDiffSql ? 'generates GRANT/REVOKE for review' : 'no changes on this object'}</span>
          </div>
        </>
      )}

      <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--border, #3a3a3a)', margin: '4px 0' }} />

      <span className="dv-desc">
        Default privileges — what future objects created by <b>{role}</b> should carry
        (<code>ALTER DEFAULT PRIVILEGES</code>, review-only).
      </span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="up-filter" value={defObjType} onChange={e => setDefObjType(e.target.value as PgDefaultObjType)}>
          {(['TABLES', 'SEQUENCES', 'FUNCTIONS', 'TYPES', 'SCHEMAS'] as PgDefaultObjType[]).map(t =>
            <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          className="up-filter" placeholder="in schema (blank = all)" value={defSchema}
          onChange={e => setDefSchema(e.target.value)}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <input
          className="up-filter" placeholder="grant to (blank = PUBLIC)" value={defGrantee}
          onChange={e => setDefGrantee(e.target.value)}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px' }}>
        {defPrivs.map(p => (
          <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, width: 200 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={defChecked.has(p)} onChange={() => toggleDefGranted(p)} />
              <span className="dv-desc" style={{ color: 'inherit' }}>{p}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: defChecked.has(p) ? 'pointer' : 'default', opacity: defChecked.has(p) ? 1 : 0.4 }} title="WITH GRANT OPTION">
              <input type="checkbox" disabled={!defChecked.has(p)} checked={defChecked.get(p) ?? false} onChange={() => toggleDefOption(p)} />
              <span className="dv-desc" style={{ color: 'inherit' }}>grant</span>
            </label>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="toolbar-btn" disabled={!defDiffSql} onClick={() => defDiffSql && insertSql(defDiffSql)}>
          Apply default privileges → editor
        </button>
        <span className="dv-desc">{defDiffSql ? 'generates ALTER DEFAULT PRIVILEGES for review' : 'no changes'}</span>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SQL Server lifecycle form (create user / role, alter, drop)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The account form for SQL Server, which is not the same form as the other two.
 *
 * A **login** authenticates at the instance; a **user** is that login's
 * identity inside one database, and the two are matched by SID rather than by
 * name. There is no single statement that creates both, so the form makes the
 * split explicit: tick "create the login too" and it emits `CREATE LOGIN`
 * followed by `CREATE USER … FOR LOGIN`; leave it off and it maps a user onto a
 * login that already exists.
 *
 * Everything it produces goes to the editor. This panel never executes a write.
 */
function MssqlLifecycleForm({
  mode, principal, insertSql, onDone,
}: {
  mode: 'create' | 'alter';
  principal: MssqlPrincipal | null;
  insertSql: (sql: string) => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<'user' | 'role'>('user');
  const [name, setName] = useState(principal?.name ?? '');
  const [login, setLogin] = useState(principal?.login ?? '');
  const [makeLogin, setMakeLogin] = useState(true);
  const [password, setPassword] = useState('');
  const [defaultSchema, setDefaultSchema] = useState(principal?.defaultSchema ?? '');
  const [roles, setRoles] = useState('');
  const [roleAction, setRoleAction] = useState<'add' | 'drop'>('add');

  const isAlter = mode === 'alter';
  const roleList = roles.split(',').map(r => r.trim()).filter(Boolean);

  const createSql = () => {
    if (kind === 'role') return mssqlCreateRoleSql(name.trim());
    return mssqlCreateUserSql({
      name: name.trim(),
      login: makeLogin ? (login.trim() || name.trim()) : (login.trim() || undefined),
      password: makeLogin ? password : undefined,
      defaultSchema: defaultSchema.trim() || undefined,
      roles: roleList,
    });
  };

  const alterSql = () => {
    const out: string[] = [];
    const q = (v: string) => `[${v.replace(/]/g, ']]')}]`;
    if (principal && defaultSchema.trim() && defaultSchema.trim() !== principal.defaultSchema) {
      out.push(`ALTER USER ${q(principal.name)} WITH DEFAULT_SCHEMA = ${q(defaultSchema.trim())};`);
    }
    if (principal && login.trim() && login.trim() !== principal.login) {
      // Also the fix for an orphan: repointing a user at a login IS the repair.
      out.push(mssqlFixOrphanSql(principal.name, login.trim()));
    }
    for (const r of roleList) {
      out.push(mssqlRoleMemberSql(r, principal?.name ?? name.trim(), roleAction === 'add'));
    }
    return out.join('\n');
  };

  const pending = isAlter ? alterSql() : createSql();

  return (
    <div className="up-lifecycle" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="up-detail-head">
        <b>{isAlter ? `Alter ${principal?.name ?? ''}` : 'Create'}</b>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={onDone}>Close</button>
      </div>

      {!isAlter && (
        <label className="rt-field">
          <span>Kind</span>
          <select value={kind} onChange={e => setKind(e.target.value as 'user' | 'role')}>
            <option value="user">Database user</option>
            <option value="role">Database role</option>
          </select>
        </label>
      )}

      {!isAlter && (
        <label className="rt-field">
          <span>Name</span>
          <input className="td-in" value={name} onChange={e => setName(e.target.value)}
                 spellCheck={false} placeholder={kind === 'role' ? 'app_readers' : 'app_service'} />
        </label>
      )}

      {kind === 'user' && (
        <>
          {!isAlter && (
            <label className="gsp-check" title="A login is a SERVER object; a user is its identity in ONE database. There is no statement that makes both.">
              <input type="checkbox" checked={makeLogin} onChange={e => setMakeLogin(e.target.checked)} />
              create the server login too
            </label>
          )}
          <label className="rt-field">
            <span>Login</span>
            <input className="td-in" value={login} onChange={e => setLogin(e.target.value)}
                   spellCheck={false}
                   placeholder={isAlter ? (principal?.login || 'no login — the user is orphaned') : 'defaults to the user name'} />
          </label>
          {!isAlter && makeLogin && (
            <label className="rt-field">
              <span>Password</span>
              <input className="td-in" type="password" value={password}
                     onChange={e => setPassword(e.target.value)} spellCheck={false} />
            </label>
          )}
          <label className="rt-field">
            <span>Default schema</span>
            <input className="td-in" value={defaultSchema} onChange={e => setDefaultSchema(e.target.value)}
                   spellCheck={false} placeholder="dbo" />
          </label>
        </>
      )}

      <label className="rt-field">
        <span>Roles</span>
        <input className="td-in" value={roles} onChange={e => setRoles(e.target.value)}
               spellCheck={false} placeholder="db_datareader, app_readers" />
      </label>
      {isAlter && (
        <label className="rt-field">
          <span>Membership</span>
          <select value={roleAction} onChange={e => setRoleAction(e.target.value as 'add' | 'drop')}>
            <option value="add">add to these roles</option>
            <option value="drop">remove from these roles</option>
          </select>
        </label>
      )}

      {pending && <pre className="rt-ddl">{pending}</pre>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="primary" disabled={!pending} onClick={() => { insertSql(pending); onDone(); }}>
          {isAlter ? 'Alter' : 'Create'} → editor
        </button>
        {isAlter && principal && (
          <button
            className="toolbar-btn mnt-danger"
            onClick={() => { insertSql(mssqlDropSql(principal)); onDone(); }}
            title="The login is left alone — it may map users in other databases"
          >
            Drop {principal.isRole ? 'role' : 'user'} → editor
          </button>
        )}
      </div>
      {isAlter && (
        <span className="dv-desc">
          Dropping the user leaves its <b>login</b> in place: a login is a server object that other
          databases may still map users to. The statement to drop it is included as a comment.
        </span>
      )}
    </div>
  );
}
