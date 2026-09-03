/**
 * Views and materialized views — reading their definition back, and writing
 * the DDL that creates, replaces, refreshes and drops them.
 *
 * Views were the last relation kind with only a read-only DDL box: you could
 * look at a view's `SELECT` under "View DDL" and then hand-write the
 * `CREATE OR REPLACE VIEW` in the SQL editor. This is the pure half of the
 * editor that closes that gap — `ViewPanel` is the screen.
 *
 * Same two rules as the routine, sequence and type editors. **Show exactly
 * what will run before it runs** — the statements are on screen, never behind
 * a silent Save — and every identifier the editor inserts is quoted through
 * `utils/sqlIdent`, so a view named `order` or living in a mixed-case schema
 * still resolves.
 *
 * ## Replace is not one statement on every engine
 *
 * - **PostgreSQL / MySQL / ClickHouse** have `CREATE OR REPLACE VIEW`, so a
 *   plain view edits in place.
 * - **SQLite** has no `OR REPLACE` for a view, so replacing one is a
 *   `DROP VIEW` followed by a `CREATE VIEW`.
 * - **A materialized view has no `OR REPLACE` anywhere.** Editing a matview's
 *   body means dropping it — discarding its stored rows — and recreating it,
 *   which is why that path is marked destructive and warns.
 *
 * Materialized views span two engines here. PostgreSQL's is a stored query you
 * `REFRESH`; ClickHouse's is a different object — an insert trigger with either
 * a `TO` target table or an inline `ENGINE`, optionally `POPULATE`d once at
 * creation. Both are edited by drop-and-recreate (no engine has
 * `OR REPLACE MATERIALIZED VIEW`); the CH form is built by
 * {@link createSql} and read back by {@link parseClickhouseMatview}.
 *
 * Pure and dependency-free apart from the quoter, so `node --test` covers it.
 */
import { quoteIdent } from './sqlIdent.ts';

/** The SQL engines that have editable views. Redis and Parquet do not. */
export type Engine = 'postgres' | 'mysql' | 'clickhouse' | 'sqlite' | 'sqlserver';

/** A plain view, or a PostgreSQL materialized view. */
export type ViewKind = 'view' | 'matview';

export interface ViewDef {
  schema: string;
  name: string;
  kind: ViewKind;
  /** The `SELECT` body, without a leading `AS` or a trailing semicolon. */
  body: string;
  /**
   * Matview create only (PostgreSQL): build it populated (`WITH DATA`) or
   * empty (`WITH NO DATA`). Ignored for a plain view.
   */
  withData?: boolean;

  // ── ClickHouse materialized view ─────────────────────────────────────────
  // A ClickHouse matview is a different object: an insert trigger that writes
  // to storage, either a separate `TO` target table or an inline `ENGINE`. The
  // fields below describe that storage; they are ignored on every other engine
  // and for a plain view.
  /** Which storage form: a `TO db.target` table, or an inline `ENGINE = …`. */
  chTarget?: 'to' | 'engine';
  /** TO-form: the target table, `db.table` or bare `table`. */
  chTo?: string;
  /** Engine-form: the storage engine, e.g. `MergeTree()`. */
  chEngine?: string;
  /** Engine-form: the `ORDER BY` expression (free text). */
  chOrderBy?: string;
  /** Engine-form: the `PARTITION BY` expression (free text). */
  chPartitionBy?: string;
  /** Engine-form: `POPULATE` — backfill once at creation. Skips inserts that
      arrive while it runs, so it is off by default. Ignored in the TO form. */
  populate?: boolean;
}

export type Risk = 'safe' | 'lossy' | 'destructive';

export interface ViewChange {
  kind: 'create' | 'replace' | 'refresh' | 'drop';
  subject: string;
  risk: Risk;
  sql: string;
  /** Why this is not `safe`, when it is not. */
  warning?: string;
}

// ── quoting ──────────────────────────────────────────────────────────────────

/** Quote unconditionally — the same choice the sibling editors make, so a
    folded-case or reserved-word name always resolves. */
const q = (s: string, engine: Engine) => quoteIdent(s, engine);

/** `schema.name`, each part quoted, the schema dropped when absent. */
function qualified(d: Pick<ViewDef, 'schema' | 'name'>, engine: Engine): string {
  const name = q(d.name, engine);
  return d.schema.trim() ? `${q(d.schema, engine)}.${name}` : name;
}

/** The keyword pair for a kind: `VIEW` or `MATERIALIZED VIEW`. */
const kindKw = (kind: ViewKind) => (kind === 'matview' ? 'MATERIALIZED VIEW' : 'VIEW');

/** A body with any leading `AS` and any trailing semicolon trimmed off, so it
    is a bare `SELECT` the builders can wrap. */
function cleanBody(body: string): string {
  return body.replace(/^\s*AS\s+/i, '').replace(/;\s*$/, '').trim();
}

// ── reading ──────────────────────────────────────────────────────────────────

/**
 * The schemas/databases a view can live in, engine by engine — the system
 * ones filtered out so the picker starts on something useful.
 */
export function schemaListSql(engine: Engine): string {
  switch (engine) {
    case 'postgres':
      return "SELECT schema_name FROM information_schema.schemata "
        + "WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name";
    case 'mysql':
      return "SELECT schema_name FROM information_schema.schemata "
        + "WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys') "
        + 'ORDER BY schema_name';
    case 'clickhouse':
      return "SELECT name FROM system.databases "
        + "WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY name";
    case 'sqlite':
      return 'SELECT name FROM pragma_database_list ORDER BY seq';
    case 'sqlserver':
      // `schema_id < 16384` drops the dozen empty schemas SQL Server creates
      // for its fixed database roles — `db_datareader` and friends, which
      // nobody has ever put a view in.
      return 'SELECT name FROM sys.schemas '
        + "WHERE schema_id < 16384 AND name NOT IN ('sys','INFORMATION_SCHEMA','guest') "
        + 'ORDER BY name';
  }
}

/**
 * Every view and materialized view in a schema, as `(name, kind)` where kind is
 * `view` or `matview`. Ordered by name.
 */
export function listSql(schema: string, engine: Engine): string {
  const s = lit(schema);
  switch (engine) {
    case 'postgres':
      // relkind: 'v' view, 'm' materialized view.
      return "SELECT c.relname, CASE c.relkind WHEN 'm' THEN 'matview' ELSE 'view' END "
        + 'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE n.nspname = ${s} AND c.relkind IN ('v','m') ORDER BY c.relname`;
    case 'mysql':
      // MySQL has no materialized views.
      return "SELECT TABLE_NAME, 'view' FROM information_schema.VIEWS "
        + `WHERE TABLE_SCHEMA = ${s} ORDER BY TABLE_NAME`;
    case 'clickhouse':
      return "SELECT name, CASE WHEN engine = 'MaterializedView' THEN 'matview' ELSE 'view' END "
        + `FROM system.tables WHERE database = ${s} AND engine LIKE '%View' ORDER BY name`;
    case 'sqlite':
      return "SELECT name, 'view' FROM sqlite_master WHERE type = 'view' ORDER BY name";
    case 'sqlserver':
      // SQL Server has no materialized view as a distinct object. Its nearest
      // thing is an INDEXED view — an ordinary view with a unique clustered
      // index on it, which materialises the result but is still a `view` in
      // `sys.views`. It is reported as one, because the editor edits the query
      // and the index is separate storage it does not own.
      return 'SELECT v.name, \'view\' FROM sys.views v '
        + 'JOIN sys.schemas sc ON sc.schema_id = v.schema_id '
        + `WHERE sc.name = ${s} ORDER BY v.name`;
  }
}

/** Single-quoted literal — schema names arrive from the picker. */
function lit(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Pull the `SELECT` body out of a `CREATE … VIEW … AS <body>` DDL string, as
 * returned by the backend's `get_ddl` — the same command the schema tree's
 * "View DDL" uses. Every engine's DDL has the shape
 * `CREATE [OR REPLACE] [MATERIALIZED] VIEW <name> [(cols)] AS <body>`, so the
 * body is whatever follows the first `AS` after the `VIEW` keyword.
 *
 * A PostgreSQL matview's DDL can carry its index definitions after the select;
 * those are dropped here — the editor edits the query, not the storage.
 *
 * Engine-agnostic on purpose: every dialect's DDL shares this `VIEW … AS`
 * shape, so one parse serves them all.
 */
export function parseBody(ddl: string): string {
  const m = /\bVIEW\b[\s\S]*?\bAS\b\s*/i.exec(ddl);
  let body = (m ? ddl.slice(m.index + m[0].length) : ddl).trim();
  // A matview's appended `CREATE INDEX …` statements are a separate statement:
  // cut at the first terminator that begins a new CREATE.
  const cut = /;\s*\n\s*CREATE\b/i.exec(body);
  if (cut) body = body.slice(0, cut.index);
  return cleanBody(body);
}

// ── writing ──────────────────────────────────────────────────────────────────

/**
 * `CREATE [OR REPLACE] [MATERIALIZED] VIEW … AS <body>`.
 *
 * `orReplace` is honoured only where the engine and kind allow it: never for a
 * materialized view (no engine has `OR REPLACE MATERIALIZED VIEW`), and never
 * on SQLite (no `OR REPLACE` for a view at all). The panel handles those by
 * dropping first — see {@link changesFor}.
 */
export function createSql(def: ViewDef, engine: Engine, orReplace = true): string {
  // A ClickHouse materialized view is a different object — its own clauses,
  // and the `AS SELECT` comes after them rather than after the name.
  if (def.kind === 'matview' && engine === 'clickhouse') {
    return clickhouseMatviewSql(def);
  }
  // T-SQL spells it `CREATE OR ALTER` (2016+), not `CREATE OR REPLACE` — the
  // latter is a syntax error there. It replaces in one statement, so a SQL
  // Server view never needs the drop-and-recreate path below.
  const canReplace = orReplace && def.kind === 'view' && engine !== 'sqlite';
  const replaceKw = engine === 'sqlserver' ? 'OR ALTER ' : 'OR REPLACE ';
  const head = `CREATE ${canReplace ? replaceKw : ''}${kindKw(def.kind)} `
    + `${qualified(def, engine)} AS`;
  let out = `${head}\n${cleanBody(def.body)}`;
  // A PostgreSQL matview can be created empty, to be filled by a later REFRESH.
  if (def.kind === 'matview' && engine === 'postgres') {
    out += def.withData === false ? '\nWITH NO DATA' : '\nWITH DATA';
  }
  return out;
}

/** A dotted target (`db.table`) with each part quoted for ClickHouse. */
function qualifyDotted(name: string): string {
  return name.split('.').map(p => p.trim()).filter(Boolean)
    .map(p => q(p, 'clickhouse')).join('.');
}

/**
 * `CREATE MATERIALIZED VIEW … [TO t | ENGINE = e [ORDER BY …] [PARTITION BY …]]
 * [POPULATE] AS <select>` — the ClickHouse form.
 *
 * The two storage forms are mutually exclusive: a `TO` target owns the storage
 * (so no ENGINE / ORDER BY / PARTITION BY, and no POPULATE — those belong to
 * the table being written to), while the inline-`ENGINE` form declares its own.
 */
function clickhouseMatviewSql(def: ViewDef): string {
  const toForm = def.chTarget === 'to';
  const lines: string[] = [`CREATE MATERIALIZED VIEW ${qualified(def, 'clickhouse')}`];
  if (toForm) {
    lines.push(`TO ${qualifyDotted(def.chTo ?? '')}`);
  } else {
    lines.push(`ENGINE = ${(def.chEngine ?? 'MergeTree()').trim()}`);
    if (def.chOrderBy?.trim()) lines.push(`ORDER BY ${def.chOrderBy.trim()}`);
    if (def.chPartitionBy?.trim()) lines.push(`PARTITION BY ${def.chPartitionBy.trim()}`);
    if (def.populate) lines.push('POPULATE');
  }
  lines.push('AS');
  lines.push(cleanBody(def.body));
  return lines.join('\n');
}

/** `DROP [MATERIALIZED] VIEW [IF EXISTS] name [CASCADE]`. */
export function dropSql(
  def: Pick<ViewDef, 'schema' | 'name' | 'kind'>, engine: Engine,
  opts: { ifExists?: boolean; cascade?: boolean } = {},
): string {
  const exists = opts.ifExists ? 'IF EXISTS ' : '';
  // Only PostgreSQL has CASCADE for a view drop.
  const cascade = opts.cascade && engine === 'postgres' ? ' CASCADE' : '';
  // ClickHouse has only DROP VIEW — it drops a materialized view too. There is
  // no DROP MATERIALIZED VIEW there, so never spell one.
  const kw = engine === 'clickhouse' ? 'VIEW' : kindKw(def.kind);
  return `DROP ${kw} ${exists}${qualified(def, engine)}${cascade}`;
}

/**
 * `REFRESH MATERIALIZED VIEW [CONCURRENTLY] name` — PostgreSQL only.
 *
 * A plain refresh takes an exclusive lock: the matview cannot be read while it
 * rebuilds. `CONCURRENTLY` avoids that but needs a unique index on the matview
 * and is slower; the warning says so.
 */
export function refreshSql(
  def: Pick<ViewDef, 'schema' | 'name'>, concurrently = false,
): ViewChange {
  const target = qualified({ ...def, name: def.name }, 'postgres');
  return {
    kind: 'refresh',
    subject: def.name,
    risk: 'safe',
    sql: `REFRESH MATERIALIZED VIEW ${concurrently ? 'CONCURRENTLY ' : ''}${target}`,
    warning: concurrently
      ? 'CONCURRENTLY needs a UNIQUE index on the materialized view and does more work, but '
        + 'lets reads continue while it rebuilds.'
      : 'A plain REFRESH takes an exclusive lock — the materialized view cannot be read until '
        + 'it finishes rebuilding.',
  };
}

/**
 * Everything needed to go from `current` to `draft`.
 *
 * `current` is `null` when creating a new object. The replace path differs by
 * engine and kind: a plain view on an engine with `OR REPLACE` is one
 * statement; a SQLite view or any materialized view is a drop-and-recreate,
 * and dropping a matview discards its stored rows — hence destructive.
 */
export function changesFor(
  current: ViewDef | null, draft: ViewDef, engine: Engine,
): ViewChange[] {
  if (!draft.name.trim() || !cleanBody(draft.body)) return [];

  // New object.
  if (!current) {
    const create: ViewChange = {
      kind: 'create', subject: draft.name, risk: 'safe', sql: createSql(draft, engine),
    };
    const pop = populateWarning(draft, engine);
    if (pop) create.warning = pop;
    return [create];
  }

  // Editing a materialized view: no OR REPLACE exists, so drop and recreate.
  if (draft.kind === 'matview') {
    const create: ViewChange = {
      kind: 'create', subject: draft.name, risk: 'safe', sql: createSql(draft, engine),
    };
    const pop = populateWarning(draft, engine);
    if (pop) create.warning = pop;
    return [
      {
        kind: 'drop', subject: draft.name, risk: 'destructive',
        sql: dropSql(current, engine),
        warning: engine === 'clickhouse'
          ? 'A ClickHouse materialized view has no CREATE OR REPLACE, so changing it drops the '
            + 'view and recreates it. The insert trigger stops while it is gone, and a recreate '
            + 'without POPULATE does not backfill — rows that arrive in the gap are missed.'
          : 'A materialized view has no CREATE OR REPLACE, so changing its query drops it '
            + '— discarding its stored rows — and recreates it. Anything reading it fails until '
            + 'the recreate (and any REFRESH) finishes.',
      },
      create,
    ];
  }

  // Editing a plain view on SQLite: no OR REPLACE, so drop then create.
  if (engine === 'sqlite') {
    return [
      { kind: 'drop', subject: draft.name, risk: 'safe', sql: dropSql(current, engine, { ifExists: true }) },
      { kind: 'create', subject: draft.name, risk: 'safe', sql: createSql(draft, engine, false) },
    ];
  }

  // Editing a plain view where OR REPLACE exists.
  const change: ViewChange = {
    kind: 'replace', subject: draft.name, risk: 'safe', sql: createSql(draft, engine, true),
  };
  if (engine === 'postgres') {
    change.warning = 'CREATE OR REPLACE VIEW on PostgreSQL can only add columns at the end — it '
      + 'cannot rename, drop, reorder or retype the existing ones. Such a change is refused; a '
      + 'drop-and-recreate is then the only way.';
  }
  return [change];
}

/** The one-shot caveat for a ClickHouse `POPULATE`, or nothing when it is off
    or the engine has no such clause. */
function populateWarning(def: ViewDef, engine: Engine): string | undefined {
  if (engine !== 'clickhouse' || def.kind !== 'matview') return undefined;
  if (def.chTarget === 'to' || !def.populate) return undefined;
  return 'POPULATE backfills the view once from the source as it is created, but any rows '
    + 'inserted into the source while that backfill runs are NOT captured — so it is safe only '
    + 'when the source is not being written to. It is also one-shot: it never runs again.';
}

/**
 * Best-effort parse of a ClickHouse `CREATE MATERIALIZED VIEW` DDL (as returned
 * by `get_ddl`) into the storage fields the form edits. The `SELECT` body is
 * pulled separately by {@link parseBody}; this reads only the clauses between
 * the name and the `AS`.
 *
 * Exotic dictionaries of options are not fully modelled — the form always
 * allows editing the raw body, and re-applying rebuilds from these fields — so
 * this favours getting the common `TO` / `ENGINE` shapes right over totality.
 */
export function parseClickhouseMatview(ddl: string): Partial<ViewDef> {
  // The head is everything from MATERIALIZED VIEW up to the AS that precedes
  // the SELECT. A ClickHouse engine/order-by clause has no bare `AS`, so the
  // first `AS` word is the body separator.
  const head = /\bMATERIALIZED\s+VIEW\b([\s\S]*?)\bAS\b/i.exec(ddl);
  const seg = head ? head[1] : '';
  const to = /\bTO\s+([A-Za-z0-9_.`"]+)/i.exec(seg);
  if (to && !/\bENGINE\b/i.test(seg)) {
    return { chTarget: 'to', chTo: unquoteDotted(to[1]) };
  }
  const engineM = /\bENGINE\s*=\s*([\s\S]+?)(?=\s+(?:ORDER\s+BY|PARTITION\s+BY|POPULATE)\b|\s*$)/i.exec(seg);
  const orderM = /\bORDER\s+BY\s+([\s\S]+?)(?=\s+(?:PARTITION\s+BY|POPULATE)\b|\s*$)/i.exec(seg);
  const partM = /\bPARTITION\s+BY\s+([\s\S]+?)(?=\s+(?:ORDER\s+BY|POPULATE)\b|\s*$)/i.exec(seg);
  return {
    chTarget: 'engine',
    chEngine: engineM ? engineM[1].trim() : 'MergeTree()',
    chOrderBy: orderM ? orderM[1].trim() : '',
    chPartitionBy: partM ? partM[1].trim() : '',
    populate: /\bPOPULATE\b/i.test(seg),
  };
}

/** Strip quoting from each part of a dotted name — for reading a `TO` target
    back out of DDL into the plain form field. */
function unquoteDotted(name: string): string {
  return name.split('.')
    .map(p => p.replace(/^[`"]|[`"]$/g, ''))
    .join('.');
}

// ── shared with the other editors ─────────────────────────────────────────────

/** The strongest risk present, for the confirm affordance. */
export function worstRisk(changes: ViewChange[]): Risk {
  if (changes.some(c => c.risk === 'destructive')) return 'destructive';
  if (changes.some(c => c.risk === 'lossy')) return 'lossy';
  return 'safe';
}

/** Statements joined for display and for running. */
export function toScript(changes: ViewChange[]): string {
  return changes.map(c => `${c.sql};`).join('\n');
}
