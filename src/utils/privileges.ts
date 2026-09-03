/**
 * What this *role* is allowed to do — the second reason a feature can be
 * unavailable, alongside the engine (`engineCaps`) and the desktop
 * (`platformCaps`).
 *
 * The three read the same way in the UI and mean different things:
 *
 *   engine    — this database has no such concept (Redis has no ER diagram)
 *   platform  — this desktop cannot run it (no Unix sockets on Windows)
 *   privilege — **you** cannot run it here; someone else with more grants can
 *
 * The privilege one is the one users hit daily and the one the app handled
 * worst: a read-only reporting account opens ⚡ Processes and sees its own
 * single row, opens 🩺 DBA Views and gets `SELECT command denied to user` from
 * half the catalogue, opens ⇄ Replication and gets nothing at all. Each of
 * those is a correct database response and a terrible product answer — the
 * screen looks broken rather than restricted, and nothing on it names the
 * grant that would fix it.
 *
 * ## The rule that matters: unknown means allowed
 *
 * This module never guesses a denial. MySQL privileges can arrive through a
 * role this probe cannot expand, a proxy user, or a `mysql.*` grant we did not
 * parse; PostgreSQL adds `SECURITY DEFINER` wrappers and per-object GRANTs.
 * Greying a feature the user actually has is worse than the failure it
 * replaces — the user believes the app, stops, and asks their DBA for a grant
 * they already hold. So a capability is `denied` only when the probe positively
 * says so; anything else is `unknown`, and `unknown` behaves exactly like
 * `granted`.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';

/**
 * The capabilities the UI gates on. Each maps to a surface a user can point
 * at, not to a privilege name — "you need PROCESS" is the *answer*, and it
 * belongs in the reason, not in the vocabulary.
 */
export type Capability =
  /** See statements belonging to other sessions (⚡ Processes, 🔒 Locks, ⏱ Long query). */
  | 'processlist-all'
  /** Terminate someone else's session. */
  | 'kill-others'
  /** Read replication topology and lag (⇄ Replication). */
  | 'replication'
  /** Read the server-wide statistics catalogues (🩺 DBA Views, 💊 Tuner). */
  | 'stats-views'
  /** Read the aggregated statement workload (pg_stat_statements, P_S digests). */
  | 'statement-stats'
  /** Read other accounts and their grants (👤 Users). */
  | 'user-admin';

export const CAPABILITIES: readonly Capability[] = [
  'processlist-all', 'kill-others', 'replication', 'stats-views', 'statement-stats', 'user-admin',
];

export type Grant = 'granted' | 'denied' | 'unknown';

/** A capability's state plus, when denied, the grant that would fix it. */
export interface CapabilityState {
  state: Grant;
  /** Present only when `denied` — names the privilege or role to ask for. */
  needs?: string;
}

export type Privileges = Record<Capability, CapabilityState>;

const ALL_UNKNOWN: Privileges = {
  'processlist-all': { state: 'unknown' },
  'kill-others': { state: 'unknown' },
  'replication': { state: 'unknown' },
  'stats-views': { state: 'unknown' },
  'statement-stats': { state: 'unknown' },
  'user-admin': { state: 'unknown' },
};

/** Nothing is known — the probe has not run, failed, or the engine has no model. */
export function unknownPrivileges(): Privileges {
  return { ...ALL_UNKNOWN };
}

// ── MySQL ────────────────────────────────────────────────────────────────────

/** `SHOW GRANTS` — one row, one string, whatever the server decides to show. */
export const MYSQL_PROBE = 'SHOW GRANTS';

interface MysqlGrants {
  /** Privileges granted `ON *.*`, upper-cased. */
  global: Set<string>;
  /** Schemas with an explicit SELECT (or ALL) grant, lower-cased. */
  selectSchemas: Set<string>;
  /**
   * A role was granted and we cannot see through it. MySQL 8 shows role
   * membership as its own `GRANT \`r\`@\`%\` TO …` line and does NOT expand
   * the privileges behind it unless the role is active, so a user whose whole
   * access arrives through a role parses as having nothing at all — the exact
   * shape that would grey a working feature.
   */
  opaqueRoles: boolean;
}

/**
 * Parse the lines of `SHOW GRANTS`.
 *
 * Deliberately forgiving: a line this does not understand is ignored rather
 * than treated as evidence of absence, and `ALL PRIVILEGES` on `*.*` short
 * circuits everything.
 */
export function parseMysqlGrants(lines: readonly string[]): MysqlGrants {
  const global = new Set<string>();
  const selectSchemas = new Set<string>();
  let opaqueRoles = false;

  for (const raw of lines) {
    const line = raw.trim();
    const m = /^GRANT\s+(.+?)\s+ON\s+(\S+?)\s+TO\s/i.exec(line);
    if (!m) {
      // `GRANT `role`@`%` TO `user`@`%`` — membership, not privileges.
      if (/^GRANT\s+\S+\s+TO\s/i.test(line)) opaqueRoles = true;
      continue;
    }
    const privs = m[1].toUpperCase().split(',').map(p => p.trim()).filter(Boolean);
    // `db`.* / *.* / `db`.`tbl` — the schema part, unquoted.
    const object = m[2].replace(/`/g, '');
    const schema = object.split('.')[0];

    if (object === '*.*') {
      for (const p of privs) global.add(p.replace(/\s+/g, ' '));
    } else if (privs.some(p => p === 'SELECT' || p.startsWith('ALL'))) {
      selectSchemas.add(schema.toLowerCase());
    }
  }
  return { global, selectSchemas, opaqueRoles };
}

/**
 * MySQL capabilities from parsed grants.
 *
 * The privilege names are the ones a DBA types into a `GRANT` statement, so
 * the reason can be pasted straight into a ticket.
 */
export function mysqlPrivileges(lines: readonly string[]): Privileges {
  const g = parseMysqlGrants(lines);
  if (g.opaqueRoles) return unknownPrivileges();

  const has = (...names: string[]) =>
    names.some(n => g.global.has(n)) || g.global.has('ALL PRIVILEGES');
  const canSelect = (schema: string) =>
    g.global.has('SELECT') || g.global.has('ALL PRIVILEGES') || g.selectSchemas.has(schema);

  const verdict = (ok: boolean, needs: string): CapabilityState =>
    ok ? { state: 'granted' } : { state: 'denied', needs };

  return {
    // Without PROCESS a user sees only their own threads — and the panel that
    // exists to show the server's work shows one row.
    'processlist-all': verdict(has('PROCESS'), 'the PROCESS privilege'),
    // CONNECTION_ADMIN is the 8.0 split-out of SUPER; both still work.
    'kill-others': verdict(has('SUPER', 'CONNECTION_ADMIN'), 'SUPER or CONNECTION_ADMIN'),
    'replication': verdict(has('REPLICATION CLIENT', 'SUPER'), 'the REPLICATION CLIENT privilege'),
    'stats-views': verdict(canSelect('performance_schema') || canSelect('sys'),
      'SELECT on performance_schema and sys'),
    'statement-stats': verdict(canSelect('performance_schema'), 'SELECT on performance_schema'),
    'user-admin': verdict(canSelect('mysql'), 'SELECT on the mysql schema'),
  };
}

// ── PostgreSQL ───────────────────────────────────────────────────────────────

/**
 * One row of booleans.
 *
 * `to_regrole` guards each membership test because the predefined roles
 * arrived in different majors (`pg_signal_backend` in 9.6, `pg_monitor` and
 * `pg_read_all_stats` in 10, `pg_read_all_settings` in 10) and
 * `pg_has_role('pg_monitor', …)` *raises* on a server that has no such role —
 * which would fail the probe entirely and lose the answers we can get.
 */
export const PG_PROBE = `SELECT
  current_setting('is_superuser') = 'on' AS is_super,
  CASE WHEN to_regrole('pg_monitor') IS NULL THEN false
       ELSE pg_has_role(current_user, 'pg_monitor', 'USAGE') END AS is_monitor,
  CASE WHEN to_regrole('pg_read_all_stats') IS NULL THEN false
       ELSE pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') END AS read_all_stats,
  CASE WHEN to_regrole('pg_signal_backend') IS NULL THEN false
       ELSE pg_has_role(current_user, 'pg_signal_backend', 'USAGE') END AS signal_backend,
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS has_pgss`;

export interface PgProbe {
  is_super: boolean;
  is_monitor: boolean;
  read_all_stats: boolean;
  signal_backend: boolean;
  has_pgss: boolean;
}

/** Read the probe row out of a result grid, whatever order the columns land in. */
export function pgProbeFromRow(columns: readonly string[], row: readonly unknown[]): PgProbe {
  const truthy = (name: string): boolean => {
    const i = columns.findIndex(c => c.toLowerCase() === name);
    if (i < 0) return false;
    const v = row[i];
    return v === true || v === 't' || v === 'true' || v === 1 || v === '1';
  };
  return {
    is_super: truthy('is_super'),
    is_monitor: truthy('is_monitor'),
    read_all_stats: truthy('read_all_stats'),
    signal_backend: truthy('signal_backend'),
    has_pgss: truthy('has_pgss'),
  };
}

export function pgPrivileges(p: PgProbe): Privileges {
  // pg_monitor is a container role that includes pg_read_all_stats and
  // pg_read_all_settings, so it answers for both.
  const stats = p.is_super || p.is_monitor || p.read_all_stats;
  const verdict = (ok: boolean, needs: string): CapabilityState =>
    ok ? { state: 'granted' } : { state: 'denied', needs };

  return {
    // Without it, pg_stat_activity hides every other backend's query text —
    // the rows are there, the `query` column reads `<insufficient privilege>`.
    'processlist-all': verdict(stats, 'the pg_monitor or pg_read_all_stats role'),
    'kill-others': verdict(p.is_super || p.signal_backend, 'the pg_signal_backend role'),
    'replication': verdict(stats, 'the pg_monitor role'),
    'stats-views': verdict(stats, 'the pg_monitor or pg_read_all_stats role'),
    // Two different walls, and the extension one is the commoner of the two,
    // so it is named first when both apply.
    'statement-stats': !p.has_pgss
      ? { state: 'denied', needs: 'the pg_stat_statements extension' }
      : verdict(stats, 'the pg_monitor role'),
    // pg_roles and pg_auth_members are world-readable; only rolpassword is
    // withheld, and nothing here reads it.
    'user-admin': { state: 'granted' },
  };
}

// ── consuming it ─────────────────────────────────────────────────────────────

/**
 * The hover message for a capability, or `null` when there is nothing to say.
 *
 * `unknown` returns `null` on purpose: it is indistinguishable from granted as
 * far as the UI is concerned, and a tooltip reading "we are not sure whether
 * you may do this" helps nobody.
 */
// ── SQL Server ───────────────────────────────────────────────────────────────

/**
 * One row of yes/no answers from the server itself.
 *
 * `HAS_PERMS_BY_NAME` is the right tool here in a way neither other engine has:
 * it asks the server "may I do this", and the server answers having already
 * resolved fixed roles, server roles, database roles, ownership chains and
 * `DENY`. Reading `sys.server_permissions` and reassembling that ourselves
 * would be reimplementing SQL Server's authorization logic — including DENY,
 * which overrides every GRANT and has no analogue in MySQL or PostgreSQL — and
 * getting it subtly wrong is how a working feature ends up greyed.
 *
 * `IS_SRVROLEMEMBER` is asked alongside it only so the *reason* can name a role
 * a DBA would actually be granted, rather than a permission they would have to
 * look up.
 */
export const MSSQL_PROBE = `SELECT
  CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE'))    AS view_server_state,
  CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY CONNECTION')) AS alter_any_connection,
  CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW ANY DEFINITION'))  AS view_any_definition,
  CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY LOGIN'))      AS alter_any_login,
  CONVERT(int, HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DATABASE STATE')) AS view_database_state,
  CONVERT(int, IS_SRVROLEMEMBER('sysadmin'))                          AS sysadmin,
  CONVERT(int, IS_SRVROLEMEMBER('processadmin'))                      AS processadmin,
  CONVERT(int, IS_SRVROLEMEMBER('securityadmin'))                     AS securityadmin`;

export interface MssqlProbe {
  viewServerState: boolean;
  alterAnyConnection: boolean;
  viewAnyDefinition: boolean;
  alterAnyLogin: boolean;
  viewDatabaseState: boolean;
  sysadmin: boolean;
  processadmin: boolean;
  securityadmin: boolean;
}

/**
 * Read the probe row by COLUMN NAME, not by position.
 *
 * `HAS_PERMS_BY_NAME` returns NULL — not 0 — when the permission name is not
 * recognised on that version, and NULL is not "denied": it is "the question did
 * not apply". Treating it as denied would grey a panel on an older server that
 * can perfectly well run it, so an unreadable answer stays `unknown`.
 */
export function mssqlProbeFromRow(
  columns: readonly string[], row: readonly unknown[],
): MssqlProbe {
  const at = (name: string): boolean => {
    const i = columns.findIndex(c => c.toLowerCase() === name);
    if (i < 0) return false;
    const v = row[i];
    return v === 1 || v === true || v === '1' || v === 'true';
  };
  return {
    viewServerState: at('view_server_state'),
    alterAnyConnection: at('alter_any_connection'),
    viewAnyDefinition: at('view_any_definition'),
    alterAnyLogin: at('alter_any_login'),
    viewDatabaseState: at('view_database_state'),
    sysadmin: at('sysadmin'),
    processadmin: at('processadmin'),
    securityadmin: at('securityadmin'),
  };
}

/** The probe row → the capability set the UI gates on. */
export function mssqlPrivileges(p: MssqlProbe): Privileges {
  // sysadmin bypasses every permission check, so it answers every question at
  // once rather than being ANDed with anything.
  const all = p.sysadmin;
  const yes = { state: 'granted' as const };
  const no = (needs: string) => ({ state: 'denied' as const, needs });

  // Almost everything in the DBA set reads a dynamic management view, and
  // `sys.dm_*` returns YOUR session's rows without VIEW SERVER STATE rather
  // than raising — a silent, believable, wrong answer. That is the reason this
  // one permission gates four capabilities.
  const dmv = all || p.viewServerState;

  return {
    'processlist-all': dmv ? yes : no('VIEW SERVER STATE'),
    // Killing is a separate permission from seeing: a user can watch every
    // session and terminate none.
    'kill-others': all || p.processadmin || p.alterAnyConnection
      ? yes
      : no('ALTER ANY CONNECTION (or the processadmin server role)'),
    'replication': dmv ? yes : no('VIEW SERVER STATE'),
    'stats-views': dmv ? yes : no('VIEW SERVER STATE'),
    // Query Store lives in the database, not the instance, so it has its own
    // permission — and a user with VIEW SERVER STATE but no database access
    // still cannot read it.
    'statement-stats': all || (p.viewServerState && p.viewDatabaseState)
      ? yes
      : no(p.viewServerState ? 'VIEW DATABASE STATE' : 'VIEW SERVER STATE'),
    // Without VIEW ANY DEFINITION, sys.server_principals returns only your own
    // login — again an answer rather than an error.
    'user-admin': all || p.securityadmin || p.viewAnyDefinition || p.alterAnyLogin
      ? yes
      : no('VIEW ANY DEFINITION (or the securityadmin server role)'),
  };
}

export function privilegeTip(privs: Privileges, cap: Capability, label: string): string | null {
  const s = privs[cap];
  if (!s || s.state !== 'denied') return null;
  return `${label} — your account cannot use this: it needs ${s.needs}.\n`
    + 'Shown so you know it exists; ask for the grant, or connect as a role that has it.';
}

/** Is this capability positively denied? (unknown counts as allowed) */
export function denied(privs: Privileges, cap: Capability): boolean {
  return privs[cap]?.state === 'denied';
}

// ═══════════════════════════════════════════════════════════════════════════
// PostgreSQL Grant Wizard — effective & default privileges
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The PG side of 👤 Users & grants. Same law as the whole panel: reading is
 * free, WRITING IS REVIEW-ONLY — every function here is pure, touches no
 * database, and only ever produces text for the editor.
 *
 * Where MySQL hands you `SHOW GRANTS` as sentences, PostgreSQL hands you the
 * raw `aclitem[]` from `pg_class.relacl` (and `pg_namespace.nspacl`,
 * `pg_default_acl.defaclacl`, …). An aclitem is `grantee=privs/grantor`, where
 * `privs` is a run of single letters — `r` SELECT, `a` INSERT, `w` UPDATE — and
 * a `*` after a letter is WITH GRANT OPTION. An **empty grantee** (the string
 * begins with `=`) is PUBLIC. A **NULL** relacl is not "no access": it is the
 * built-in default (owner holds everything), which is why it is decoded
 * separately rather than treated as an empty array.
 *
 * Pure and dependency-light — driven by `node --test`, see
 * tests/pgPrivileges.test.ts.
 */

/** Every privilege name the wizard can name in a GRANT, across object kinds. */
export type PgPrivilege =
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER'
  | 'USAGE' | 'CREATE' | 'CONNECT' | 'TEMPORARY' | 'EXECUTE' | 'MAINTAIN';

/**
 * The single-letter acl codes PostgreSQL stores, mapped to the words a GRANT
 * spells out. Case matters: `d` is DELETE but `D` is TRUNCATE, `c` is CONNECT
 * but `C` is CREATE, `t` is TRIGGER but `T` is TEMPORARY.
 */
export const PG_ACL_LETTERS: Readonly<Record<string, PgPrivilege>> = {
  r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', D: 'TRUNCATE',
  x: 'REFERENCES', t: 'TRIGGER',
  X: 'EXECUTE', U: 'USAGE', C: 'CREATE', c: 'CONNECT', T: 'TEMPORARY',
  m: 'MAINTAIN',
};

/** The object kinds a GRANT can bite at, and the SQL keyword each uses. */
export type PgObjKind = 'table' | 'sequence' | 'function' | 'schema' | 'database' | 'type';

const PG_OBJ_KEYWORD: Readonly<Record<PgObjKind, string>> = {
  table: 'TABLE', sequence: 'SEQUENCE', function: 'FUNCTION',
  schema: 'SCHEMA', database: 'DATABASE', type: 'TYPE',
};

/**
 * The privilege columns that apply to each object kind, in a stable display /
 * emission order. This is also the `ALL PRIVILEGES` expansion for that kind,
 * and the set the matrix draws checkboxes for.
 */
export const PG_PRIVILEGES_BY_KIND: Readonly<Record<PgObjKind, readonly PgPrivilege[]>> = {
  table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
  sequence: ['USAGE', 'SELECT', 'UPDATE'],
  function: ['EXECUTE'],
  schema: ['USAGE', 'CREATE'],
  database: ['CREATE', 'CONNECT', 'TEMPORARY'],
  type: ['USAGE'],
};

/** The `ALTER DEFAULT PRIVILEGES … ON <this>` targets and their pg catalog codes. */
export type PgDefaultObjType = 'TABLES' | 'SEQUENCES' | 'FUNCTIONS' | 'TYPES' | 'SCHEMAS';

/** `pg_default_acl.defaclobjtype` (a single char) → the wizard's view of it. */
export const PG_DEFACL_OBJTYPE: Readonly<Record<string, { label: PgDefaultObjType; kind: PgObjKind }>> = {
  r: { label: 'TABLES', kind: 'table' },
  S: { label: 'SEQUENCES', kind: 'sequence' },
  f: { label: 'FUNCTIONS', kind: 'function' },
  T: { label: 'TYPES', kind: 'type' },
  n: { label: 'SCHEMAS', kind: 'schema' },
};

/** The object kind whose privilege set a default-privilege target draws from. */
export const PG_DEFAULT_OBJTYPE_KIND: Readonly<Record<PgDefaultObjType, PgObjKind>> = {
  TABLES: 'table', SEQUENCES: 'sequence', FUNCTIONS: 'function',
  TYPES: 'type', SCHEMAS: 'schema',
};

// ── decoding aclitem ───────────────────────────────────────────────────────

/**
 * One decoded aclitem: who holds what, and whether they may pass it on. Grants
 * with WITH GRANT OPTION carry `true` in the map; the empty grantee surfaces as
 * `PUBLIC` with `isPublic` set so callers never have to test for `''`.
 */
export interface PgAclItem {
  grantee: string;
  isPublic: boolean;
  grantor: string;
  /** privilege → does the holder also have GRANT OPTION on it. */
  privileges: Map<PgPrivilege, boolean>;
}

/**
 * Split a PostgreSQL array literal (`{a,b,"c,d"}`) into its raw elements,
 * honouring the double-quote quoting Postgres uses for elements that contain a
 * comma or a quote (with `\\` / `\"` backslash escapes inside). `{}` and NULL
 * come back as an empty list.
 */
export function parseAclArray(text: string | null): string[] {
  if (text == null) return [];
  let s = text.trim();
  if (s === '' || s === '{}') return [];
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  if (s === '') return [];

  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let el = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { el += s[i + 1] ?? ''; i += 2; continue; }
        if (s[i] === '"') { i++; break; }
        el += s[i++];
      }
    } else {
      while (i < s.length && s[i] !== ',') el += s[i++];
    }
    out.push(el);
    if (s[i] === ',') i++;
  }
  return out;
}

/**
 * Read a name that may be bare or double-quoted (Postgres quotes role names
 * inside an aclitem when they need it, doubling an embedded `"`). Stops a bare
 * name at any of `stops`.
 */
function readAclName(s: string, i: number, stops: string): { name: string; next: number } {
  if (s[i] === '"') {
    i++;
    let name = '';
    while (i < s.length) {
      if (s[i] === '"') {
        if (s[i + 1] === '"') { name += '"'; i += 2; continue; }
        i++; break;
      }
      name += s[i++];
    }
    return { name, next: i };
  }
  let name = '';
  while (i < s.length && !stops.includes(s[i])) name += s[i++];
  return { name, next: i };
}

/**
 * Decode one aclitem — `grantee=privs/grantor`. Returns `null` for anything
 * that is not a well-formed item (no `=`), so a stray token never invents a
 * grant. Unknown privilege letters are skipped, not guessed.
 */
export function parseAclItem(item: string): PgAclItem | null {
  const g = readAclName(item, 0, '=');
  if (item[g.next] !== '=') return null;

  let i = g.next + 1;
  const privileges = new Map<PgPrivilege, boolean>();
  while (i < item.length && item[i] !== '/') {
    const letter = item[i++];
    let grantOption = false;
    if (item[i] === '*') { grantOption = true; i++; }
    const name = PG_ACL_LETTERS[letter];
    if (name) privileges.set(name, grantOption);
  }

  let grantor = '';
  if (item[i] === '/') grantor = readAclName(item, i + 1, '').name;

  return {
    grantee: g.name === '' ? 'PUBLIC' : g.name,
    isPublic: g.name === '',
    grantor,
    privileges,
  };
}

/** Decode a whole `relacl`/`nspacl`/`defaclacl` text into its aclitems. */
export function parseAcl(aclText: string | null): PgAclItem[] {
  return parseAclArray(aclText)
    .map(parseAclItem)
    .filter((x): x is PgAclItem => x !== null);
}

// ── the effective-privilege matrix ─────────────────────────────────────────

/** One cell of the matrix: is the privilege held, and may it be passed on. */
export interface PgEffectiveCell {
  granted: boolean;
  grantOption: boolean;
}

/** One grantee's row across a kind's privilege columns. */
export interface PgEffectiveRow {
  grantee: string;
  isPublic: boolean;
  privileges: Map<PgPrivilege, PgEffectiveCell>;
}

/**
 * Turn a raw acl into the effective grantee × privilege grid for one object.
 *
 * A **NULL** acl is the built-in default and is decoded as "the owner holds
 * every privilege for this kind, with grant option" — the true effective state,
 * and the reason NULL is not folded into the empty case. A non-NULL acl lists
 * every grantee explicitly (the owner included), so it is decoded verbatim.
 */
export function buildAclMatrix(
  aclText: string | null,
  kind: PgObjKind,
  owner: string,
): PgEffectiveRow[] {
  const cols = PG_PRIVILEGES_BY_KIND[kind];

  if (aclText == null) {
    const privileges = new Map<PgPrivilege, PgEffectiveCell>();
    for (const p of cols) privileges.set(p, { granted: true, grantOption: true });
    return [{ grantee: owner, isPublic: false, privileges }];
  }

  return parseAcl(aclText).map(item => {
    const privileges = new Map<PgPrivilege, PgEffectiveCell>();
    for (const p of cols) {
      const granted = item.privileges.has(p);
      privileges.set(p, { granted, grantOption: granted ? (item.privileges.get(p) ?? false) : false });
    }
    return { grantee: item.grantee, isPublic: item.isPublic, privileges };
  });
}

/**
 * The privileges one grantee currently holds, as the `PgPrivMap` the diff
 * builders consume (present ⇒ granted; value ⇒ grant option). Empty when the
 * grantee has no row.
 */
export function privMapForGrantee(
  rows: readonly PgEffectiveRow[],
  grantee: string,
  isPublic: boolean,
): PgPrivMap {
  const row = rows.find(r => (isPublic ? r.isPublic : (!r.isPublic && r.grantee === grantee)));
  const out: PgPrivMap = new Map();
  if (row) {
    for (const [p, cell] of row.privileges) if (cell.granted) out.set(p, cell.grantOption);
  }
  return out;
}

// ── GRANT / REVOKE / ALTER DEFAULT PRIVILEGES diffs ─────────────────────────

/** A desired-or-current privilege set: present ⇒ granted, value ⇒ grant option. */
export type PgPrivMap = Map<PgPrivilege, boolean>;

/** Where a GRANT bites — the `ON …` object. */
export interface PgGrantTarget {
  kind: PgObjKind;
  /** The containing schema, for schema-qualified kinds (table/sequence/…). */
  schema?: string;
  name: string;
}

/** The `TABLE "s"."t"` / `SCHEMA "s"` clause a GRANT/REVOKE names after `ON`. */
export function pgObjectClause(t: PgGrantTarget): string {
  const kw = PG_OBJ_KEYWORD[t.kind];
  const q = (s: string) => quoteIdent(s, 'postgres');
  // Schemas and databases are single, unqualified identifiers; the rest live
  // inside a schema and are named schema-qualified when one is known.
  if (t.kind === 'schema' || t.kind === 'database' || t.kind === 'type') {
    return `${kw} ${q(t.name)}`;
  }
  const path = t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
  return `${kw} ${path}`;
}

/** The recipient side of a GRANT — `PUBLIC`, or a quoted role name. */
function pgGranteeSql(grantee: string, isPublic: boolean): string {
  return isPublic ? 'PUBLIC' : quoteIdent(grantee, 'postgres');
}

interface PrivDiff {
  grantPlain: PgPrivilege[];
  grantWithOption: PgPrivilege[];
  revokeOptionOnly: PgPrivilege[];
  revoke: PgPrivilege[];
}

/**
 * The four buckets a desired-vs-current change falls into. PostgreSQL cannot
 * put "with grant option" on individual privileges of one statement, so a
 * privilege gaining the option rides a separate `GRANT … WITH GRANT OPTION`,
 * and one losing only the option (keeping the privilege) needs the distinct
 * `REVOKE GRANT OPTION FOR …` form rather than a plain REVOKE.
 */
function diffPrivMaps(desired: PgPrivMap, current: PgPrivMap, order: readonly PgPrivilege[]): PrivDiff {
  const grantPlain: PgPrivilege[] = [];
  const grantWithOption: PgPrivilege[] = [];
  const revokeOptionOnly: PgPrivilege[] = [];
  const revoke: PgPrivilege[] = [];

  for (const p of order) {
    const d = desired.has(p);
    const dgo = desired.get(p) ?? false;
    const c = current.has(p);
    const cgo = current.get(p) ?? false;

    if (d && !c) {
      (dgo ? grantWithOption : grantPlain).push(p);
    } else if (d && c) {
      if (dgo && !cgo) grantWithOption.push(p);        // upgrade: add the option
      else if (!dgo && cgo) revokeOptionOnly.push(p);  // downgrade: drop only the option
    } else if (!d && c) {
      revoke.push(p);
    }
  }
  return { grantPlain, grantWithOption, revokeOptionOnly, revoke };
}

/**
 * Assemble the diff into statements. `prefix` is empty for object grants and
 * the `ALTER DEFAULT PRIVILEGES …` head for default-privilege ones; `onClause`
 * is the object clause or a default-privilege target word (`TABLES`).
 */
function assembleGrantRevoke(diff: PrivDiff, onClause: string, grantee: string, prefix = ''): string[] {
  const out: string[] = [];
  const p = prefix ? `${prefix} ` : '';
  if (diff.grantPlain.length) {
    out.push(`${p}GRANT ${diff.grantPlain.join(', ')} ON ${onClause} TO ${grantee};`);
  }
  if (diff.grantWithOption.length) {
    out.push(`${p}GRANT ${diff.grantWithOption.join(', ')} ON ${onClause} TO ${grantee} WITH GRANT OPTION;`);
  }
  if (diff.revokeOptionOnly.length) {
    out.push(`${p}REVOKE GRANT OPTION FOR ${diff.revokeOptionOnly.join(', ')} ON ${onClause} FROM ${grantee};`);
  }
  if (diff.revoke.length) {
    out.push(`${p}REVOKE ${diff.revoke.join(', ')} ON ${onClause} FROM ${grantee};`);
  }
  return out;
}

export interface PgGrantDiffArgs {
  target: PgGrantTarget;
  grantee: string;
  isPublic?: boolean;
  /** What the boxes say should be granted (present ⇒ granted, value ⇒ option). */
  desired: PgPrivMap;
  /** What the decoded acl says is granted now. */
  current: PgPrivMap;
}

/**
 * The minimal `GRANT` / `REVOKE` for one object and one grantee, ready for the
 * editor. Returns `''` when desired and current already match — a no-op must
 * emit nothing so the panel can tell "nothing to do" from "here is a statement"
 * and never fires a stray REVOKE.
 */
export function pgGrantDiffSql(args: PgGrantDiffArgs): string {
  const order = PG_PRIVILEGES_BY_KIND[args.target.kind];
  const diff = diffPrivMaps(args.desired, args.current, order);
  const on = pgObjectClause(args.target);
  const to = pgGranteeSql(args.grantee, args.isPublic ?? false);
  return assembleGrantRevoke(diff, on, to).join('\n');
}

export interface PgDefaultPrivDiffArgs {
  /** `FOR ROLE …` — whose future objects. Omit for the current role. */
  forRole?: string;
  /** `IN SCHEMA …` — narrow to one schema. Omit for all schemas. */
  inSchema?: string;
  objType: PgDefaultObjType;
  grantee: string;
  isPublic?: boolean;
  desired: PgPrivMap;
  current: PgPrivMap;
}

/**
 * The minimal `ALTER DEFAULT PRIVILEGES … GRANT/REVOKE` for the privileges that
 * future objects of a kind should carry. Same no-op-is-empty contract as
 * [`pgGrantDiffSql`].
 */
export function pgDefaultPrivDiffSql(args: PgDefaultPrivDiffArgs): string {
  const kind = PG_DEFAULT_OBJTYPE_KIND[args.objType];
  const diff = diffPrivMaps(args.desired, args.current, PG_PRIVILEGES_BY_KIND[kind]);

  let prefix = 'ALTER DEFAULT PRIVILEGES';
  if (args.forRole) prefix += ` FOR ROLE ${quoteIdent(args.forRole, 'postgres')}`;
  if (args.inSchema) prefix += ` IN SCHEMA ${quoteIdent(args.inSchema, 'postgres')}`;

  const to = pgGranteeSql(args.grantee, args.isPublic ?? false);
  return assembleGrantRevoke(diff, args.objType, to, prefix).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// User / role lifecycle — CREATE / ALTER / DROP
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The account list and the grant matrices answer "who holds what"; these
 * answer "who exists at all". Creating, altering and dropping an account is the
 * other half of a security screen, and — like everything else in 👤 Users &
 * grants — the builders here only ever produce text for the editor to review.
 * They never execute, and never see a secret twice: the caller passes the
 * password straight from the form field into the generated SQL and forgets it.
 *
 * The engine decides the whole shape. MySQL/MariaDB name an account as the
 * string pair `'user'@'host'` and carry auth-plugin, `REQUIRE SSL`, resource
 * limits and `PASSWORD EXPIRE` on the statement; PostgreSQL names a role as a
 * bare identifier and toggles boolean attributes (LOGIN/SUPERUSER/…) plus
 * `VALID UNTIL` and `CONNECTION LIMIT`. Quoting follows that split exactly:
 * a role **name** is an identifier (`quoteIdent`), while a MySQL user, host and
 * every password are string **literals** (`sqlLiteral`) — see sqlIdent.ts for
 * why the distinction is load-bearing rather than cosmetic.
 */

// ── MySQL / MariaDB ─────────────────────────────────────────────────────────

/**
 * How a MySQL password should be made to expire. `'now'` forces a change at
 * next login, `'default'` defers to `default_password_lifetime`, `'never'`
 * pins it open, and an interval sets an explicit window.
 */
export type MysqlPasswordExpire = 'now' | 'default' | 'never' | { intervalDays: number };

/**
 * The knobs a CREATE/ALTER USER can set. For ALTER a field is emitted only when
 * it is present, so an untouched box changes nothing; `undefined` always means
 * "leave as-is", never "reset". `host` defaults to `'%'` (any host).
 */
export interface MysqlUserSpec {
  user: string;
  host?: string;
  /** Plaintext for `IDENTIFIED BY '…'`. Empty string is a real (empty) password. */
  password?: string;
  /** Auth plugin for `IDENTIFIED WITH …`, e.g. `caching_sha2_password`. */
  authPlugin?: string;
  /** `true` → `REQUIRE SSL`; `false` → `REQUIRE NONE` (ALTER only). */
  requireSsl?: boolean;
  /** `WITH MAX_USER_CONNECTIONS n` — a resource limit. */
  maxUserConnections?: number;
  passwordExpire?: MysqlPasswordExpire;
  /** `true` → `ACCOUNT LOCK`; `false` → `ACCOUNT UNLOCK`. */
  accountLock?: boolean;
}

/** `'user'@'host'` with both halves as MySQL string literals. */
export function mysqlAccountSql(user: string, host = '%'): string {
  return `${sqlLiteral(user, 'mysql')}@${sqlLiteral(host, 'mysql')}`;
}

function mysqlPasswordExpireClause(e: MysqlPasswordExpire): string {
  if (e === 'now') return 'PASSWORD EXPIRE';
  if (e === 'default') return 'PASSWORD EXPIRE DEFAULT';
  if (e === 'never') return 'PASSWORD EXPIRE NEVER';
  return `PASSWORD EXPIRE INTERVAL ${e.intervalDays} DAY`;
}

/**
 * The clauses shared by CREATE and ALTER USER, in the order MySQL parses them:
 * identification, then `REQUIRE`, then resource `WITH`, then `PASSWORD EXPIRE`,
 * then `ACCOUNT`. A field absent from the spec contributes nothing.
 */
function mysqlUserClauses(spec: MysqlUserSpec): string[] {
  const out: string[] = [];
  if (spec.password !== undefined) {
    const by = `BY ${sqlLiteral(spec.password, 'mysql')}`;
    out.push(spec.authPlugin ? `IDENTIFIED WITH ${spec.authPlugin} ${by}` : `IDENTIFIED ${by}`);
  } else if (spec.authPlugin !== undefined) {
    // Switch the plugin without setting a password (e.g. to an OS-auth plugin).
    out.push(`IDENTIFIED WITH ${spec.authPlugin}`);
  }
  if (spec.requireSsl !== undefined) out.push(spec.requireSsl ? 'REQUIRE SSL' : 'REQUIRE NONE');
  if (spec.maxUserConnections !== undefined) {
    out.push(`WITH MAX_USER_CONNECTIONS ${spec.maxUserConnections}`);
  }
  if (spec.passwordExpire !== undefined) out.push(mysqlPasswordExpireClause(spec.passwordExpire));
  if (spec.accountLock !== undefined) out.push(spec.accountLock ? 'ACCOUNT LOCK' : 'ACCOUNT UNLOCK');
  return out;
}

/** `CREATE USER 'u'@'h' …` — the whole account in one statement. */
export function mysqlCreateUserSql(spec: MysqlUserSpec, opts: { ifNotExists?: boolean } = {}): string {
  const head = `CREATE USER ${opts.ifNotExists ? 'IF NOT EXISTS ' : ''}${mysqlAccountSql(spec.user, spec.host)}`;
  const clauses = mysqlUserClauses(spec);
  return `${clauses.length ? `${head} ${clauses.join(' ')}` : head};`;
}

/**
 * `ALTER USER 'u'@'h' …` for the fields the spec sets, plus a leading
 * `RENAME USER` when `rename` is given (MySQL cannot rename inside ALTER USER).
 * Returns `''` when there is nothing to change, so the caller can tell a no-op
 * from a statement.
 */
export function mysqlAlterUserSql(
  account: { user: string; host?: string },
  spec: MysqlUserSpec,
  opts: { rename?: { user: string; host?: string } } = {},
): string {
  const stmts: string[] = [];
  const from = mysqlAccountSql(account.user, account.host);
  if (opts.rename) {
    stmts.push(`RENAME USER ${from} TO ${mysqlAccountSql(opts.rename.user, opts.rename.host)};`);
  }
  const clauses = mysqlUserClauses(spec);
  if (clauses.length) stmts.push(`ALTER USER ${from} ${clauses.join(' ')};`);
  return stmts.join('\n');
}

/** `DROP USER [IF EXISTS] 'u'@'h'[, …]` for one or more accounts. */
export function mysqlDropUserSql(
  accounts: readonly { user: string; host?: string }[],
  opts: { ifExists?: boolean } = {},
): string {
  if (!accounts.length) return '';
  const list = accounts.map(a => mysqlAccountSql(a.user, a.host)).join(', ');
  return `DROP USER ${opts.ifExists ? 'IF EXISTS ' : ''}${list};`;
}

// ── MySQL 8 roles ─────────────────────────────────────────────────────────────
// Roles are named accounts (`'name'` or `'name'@'host'`). These build the
// standard MySQL 8 role verbs: create/drop, grant/revoke to a user, and set the
// user's default (auto-activated) roles. Generated for review, never executed.

/** A role reference — a bare name (host defaults to `%`) or name@host. */
export interface MysqlRoleRef { name: string; host?: string }

const roleList = (roles: readonly MysqlRoleRef[]): string =>
  roles.map(r => mysqlAccountSql(r.name, r.host)).join(', ');

export function mysqlCreateRoleSql(roles: readonly MysqlRoleRef[], opts: { ifNotExists?: boolean } = {}): string {
  if (!roles.length) return '';
  return `CREATE ROLE ${opts.ifNotExists ? 'IF NOT EXISTS ' : ''}${roleList(roles)};`;
}

export function mysqlDropRoleSql(roles: readonly MysqlRoleRef[], opts: { ifExists?: boolean } = {}): string {
  if (!roles.length) return '';
  return `DROP ROLE ${opts.ifExists ? 'IF EXISTS ' : ''}${roleList(roles)};`;
}

/** `GRANT r1, r2 TO 'user'@'host';` — makes the roles available to the account. */
export function mysqlGrantRoleSql(roles: readonly MysqlRoleRef[], account: { user: string; host?: string }): string {
  if (!roles.length || !account.user) return '';
  return `GRANT ${roleList(roles)} TO ${mysqlAccountSql(account.user, account.host)};`;
}

export function mysqlRevokeRoleSql(roles: readonly MysqlRoleRef[], account: { user: string; host?: string }): string {
  if (!roles.length || !account.user) return '';
  return `REVOKE ${roleList(roles)} FROM ${mysqlAccountSql(account.user, account.host)};`;
}

/**
 * `SET DEFAULT ROLE …` — which granted roles activate automatically at login.
 * `spec` is 'ALL', 'NONE', or an explicit list.
 */
export function mysqlSetDefaultRoleSql(
  account: { user: string; host?: string },
  spec: 'ALL' | 'NONE' | readonly MysqlRoleRef[],
): string {
  if (!account.user) return '';
  const what = spec === 'ALL' ? 'ALL' : spec === 'NONE' ? 'NONE' : (spec.length ? roleList(spec) : '');
  if (!what) return '';
  return `SET DEFAULT ROLE ${what} TO ${mysqlAccountSql(account.user, account.host)};`;
}

// ── PostgreSQL ──────────────────────────────────────────────────────────────

/**
 * PostgreSQL role attributes as an explicit tri-state: `true` emits the
 * positive keyword (LOGIN), `false` the negated one (NOLOGIN), and `undefined`
 * emits nothing — the difference between "must be able to log in", "must not",
 * and "don't touch it", which an ALTER needs to keep straight.
 */
export interface PgRoleSpec {
  name: string;
  login?: boolean;
  superuser?: boolean;
  createdb?: boolean;
  createrole?: boolean;
  inherit?: boolean;
  replication?: boolean;
  /** `string` → `PASSWORD '…'`; `null` → `PASSWORD NULL` (remove); `undefined` → omit. */
  password?: string | null;
  /** `VALID UNTIL '…'` — a timestamp literal, or `'infinity'` to never expire. */
  validUntil?: string;
  /** `CONNECTION LIMIT n` — `-1` is unlimited. */
  connectionLimit?: number;
}

/** Each attribute and the positive/negative keyword pair it toggles, in emit order. */
const PG_ROLE_ATTRS: readonly [keyof PgRoleSpec, string, string][] = [
  ['login', 'LOGIN', 'NOLOGIN'],
  ['superuser', 'SUPERUSER', 'NOSUPERUSER'],
  ['createdb', 'CREATEDB', 'NOCREATEDB'],
  ['createrole', 'CREATEROLE', 'NOCREATEROLE'],
  ['inherit', 'INHERIT', 'NOINHERIT'],
  ['replication', 'REPLICATION', 'NOREPLICATION'],
];

/** The option clauses shared by CREATE and ALTER ROLE, in a stable order. */
function pgRoleClauses(spec: PgRoleSpec): string[] {
  const out: string[] = [];
  for (const [key, yes, no] of PG_ROLE_ATTRS) {
    const v = spec[key];
    if (v === true) out.push(yes);
    else if (v === false) out.push(no);
  }
  if (spec.password !== undefined) {
    out.push(spec.password === null ? 'PASSWORD NULL' : `PASSWORD ${sqlLiteral(spec.password, 'postgres')}`);
  }
  if (spec.validUntil !== undefined) out.push(`VALID UNTIL ${sqlLiteral(spec.validUntil, 'postgres')}`);
  if (spec.connectionLimit !== undefined) out.push(`CONNECTION LIMIT ${spec.connectionLimit}`);
  return out;
}

/** `CREATE ROLE "name" …` — every attribute and option in one statement. */
export function pgCreateRoleSql(spec: PgRoleSpec): string {
  const head = `CREATE ROLE ${quoteIdent(spec.name, 'postgres')}`;
  const clauses = pgRoleClauses(spec);
  return `${clauses.length ? `${head} ${clauses.join(' ')}` : head};`;
}

/**
 * `ALTER ROLE "name" …` for the options the spec sets, plus a leading
 * `ALTER ROLE … RENAME TO` when `rename` is given (PostgreSQL cannot rename in
 * the same statement that changes options). `''` when nothing changes.
 */
export function pgAlterRoleSql(spec: PgRoleSpec, opts: { rename?: string } = {}): string {
  const stmts: string[] = [];
  const name = quoteIdent(spec.name, 'postgres');
  if (opts.rename) stmts.push(`ALTER ROLE ${name} RENAME TO ${quoteIdent(opts.rename, 'postgres')};`);
  const clauses = pgRoleClauses(spec);
  if (clauses.length) stmts.push(`ALTER ROLE ${name} ${clauses.join(' ')};`);
  return stmts.join('\n');
}

/** `DROP ROLE [IF EXISTS] "name"[, …]` for one or more roles. */
export function pgDropRoleSql(names: readonly string[], opts: { ifExists?: boolean } = {}): string {
  if (!names.length) return '';
  const list = names.map(n => quoteIdent(n, 'postgres')).join(', ');
  return `DROP ROLE ${opts.ifExists ? 'IF EXISTS ' : ''}${list};`;
}
