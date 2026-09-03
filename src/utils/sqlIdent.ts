/**
 * Identifier quoting for anything the editor INSERTS into your SQL.
 *
 * Completing an object name is only useful if the text that lands in the buffer
 * actually resolves to that object, and unquoted identifiers frequently do not:
 *
 *   - **PostgreSQL folds unquoted names to lower case.** A table created as
 *     `"OrderItems"` (every ORM does this) inserted as `public.OrderItems`
 *     resolves to `orderitems` → *relation does not exist*.
 *   - **Reserved words collide.** A column called `order`, `key` or `interval`
 *     inserted bare is a syntax error on both engines.
 *   - Names with dashes, spaces, dots or a leading digit are never legal bare.
 *
 * So the rule is: quote when the identifier would otherwise mean something
 * different (or nothing), and leave plain names alone — a DBA does not want
 * backticks smeared over `SELECT id FROM orders`.
 */
/**
 * Engine tag. Kept local (a string union, not an import) so this module has NO
 * dependencies and can be unit-tested straight from node — see
 * tests/sqlIdent.test.ts.
 */
export type IdentEngine = 'mysql' | 'postgres' | 'redis' | string;

/** Bare-legal on MySQL: letters, digits, `_`, `$`, not starting with a digit. */
const MY_BARE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
/** Bare-legal on PostgreSQL: LOWER-case only — anything else folds. */
const PG_BARE = /^[a-z_][a-z0-9_$]*$/;
/** Bare-legal on SQL Server: like MySQL plus `@` and `#` (temp/variable
 *  prefixes are legal inside regular identifiers too). Case is preserved and
 *  — on the default case-insensitive collations — not folded, so a mixed-case
 *  name resolves bare exactly as on MySQL. */
const MS_BARE = /^[A-Za-z_][A-Za-z0-9_@$#]*$/;

/**
 * Reserved on SQL Server but absent from the MySQL/PG union above, and
 * plausible object names (`order`, `key` and friends are already in the
 * union). Consulted only when the engine is sqlserver, so MySQL/PG quoting
 * decisions do not move. MERGE/TOP/OUTPUT/PIVOT bare in the wrong spot are a
 * syntax error, not just bad style.
 */
const TSQL_EXTRA_RESERVED = new Set([
  'apply', 'bulk', 'identity', 'merge', 'output', 'pivot', 'throw', 'top',
  'try', 'catch', 'unpivot', 'within',
]);

/**
 * Words that break (or change meaning) when used bare as an identifier. This is
 * the union of the MySQL and PostgreSQL reserved lists, trimmed to what can
 * plausibly be an object name — quoting a few extra names is harmless, missing
 * one produces broken SQL. Exported for the SQL Quality lint/DDL audit, which
 * warn when a CREATE TABLE column is named after one of these.
 */
export const RESERVED_WORDS = new Set([
  'add', 'all', 'alter', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'authorization',
  'before', 'begin', 'between', 'bigint', 'binary', 'blob', 'both', 'by',
  'call', 'cascade', 'case', 'cast', 'change', 'char', 'character', 'check', 'collate',
  'column', 'comment', 'commit', 'concurrently', 'condition', 'constraint', 'continue',
  'convert', 'create', 'cross', 'current', 'current_date', 'current_time',
  'current_timestamp', 'current_user', 'cursor',
  'database', 'databases', 'day', 'dec', 'decimal', 'declare', 'default', 'deferrable',
  'delayed', 'delete', 'desc', 'describe', 'distinct', 'div', 'do', 'double', 'drop', 'dual',
  'each', 'else', 'elseif', 'enclosed', 'end', 'enum', 'escape', 'except', 'exists',
  'exit', 'explain', 'false', 'fetch', 'float', 'for', 'force', 'foreign', 'freeze',
  'from', 'full', 'fulltext', 'function',
  'grant', 'group', 'grouping', 'having', 'high_priority', 'hour',
  'if', 'ignore', 'ilike', 'in', 'index', 'infile', 'initially', 'inner', 'inout',
  'insensitive', 'insert', 'int', 'integer', 'intersect', 'interval', 'into', 'is',
  'isnull', 'iterate', 'join', 'key', 'keys', 'kill',
  'label', 'lateral', 'leading', 'leave', 'left', 'like', 'limit', 'lines', 'load',
  'localtime', 'localtimestamp', 'lock', 'locks', 'long', 'longblob', 'longtext', 'loop',
  'match', 'mediumblob', 'mediumint', 'mediumtext', 'minute', 'mod', 'modifies', 'month',
  'natural', 'not', 'notnull', 'null', 'numeric',
  'of', 'offset', 'on', 'only', 'optimize', 'option', 'optionally', 'or', 'order', 'out',
  'outer', 'outfile', 'over', 'overlaps',
  'partition', 'placing', 'precision', 'primary', 'procedure', 'purge',
  'range', 'rank', 'read', 'reads', 'real', 'references', 'regexp', 'release', 'rename',
  'repeat', 'replace', 'require', 'restrict', 'return', 'returning', 'revoke', 'right',
  'rlike', 'row', 'rows',
  'schema', 'schemas', 'second', 'select', 'sensitive', 'separator', 'session_user', 'set',
  'show', 'signal', 'similar', 'smallint', 'some', 'spatial', 'specific', 'sql', 'ssl',
  'starting', 'status', 'straight_join', 'symmetric', 'system', 'system_user',
  'table', 'tables', 'tablesample', 'terminated', 'then', 'time', 'timestamp', 'tinyblob',
  'tinyint', 'tinytext', 'to', 'trailing', 'trigger', 'true', 'type',
  'undo', 'union', 'unique', 'unlock', 'unsigned', 'update', 'usage', 'use', 'user',
  'using', 'utc_date', 'utc_time', 'utc_timestamp',
  'value', 'values', 'varbinary', 'varchar', 'varying', 'verbose', 'when', 'where',
  'while', 'window', 'with', 'write', 'xor', 'year', 'zerofill',
  // MySQL 8.0 additions (the window-function wave, CUBE, recursive CTEs) and
  // the MySQL 8.4 additions — all plausible object names on an older server
  'cube', 'cume_dist', 'dense_rank', 'empty', 'first_value', 'groups',
  'json_table', 'lag', 'last_value', 'lead', 'member', 'nth_value', 'ntile',
  'percent_rank', 'recursive', 'row_number',
  'manual', 'parallel', 'qualify',
  // MySQL 9.x additions (9.2 / 9.4 / 9.6 — nothing new since, as of 26.7)
  'library', 'external', 'sets',
]);

/**
 * Reserved words a running server does NOT yet enforce, but a later release
 * does — the words that turn an upgrade into a syntax-error hunt. `since` is
 * the release that added the reservation; `until` (exclusive) is the release
 * that lifted it again — MANUAL and PARALLEL were reserved from 8.4 and became
 * non-reserved in 9.7.2. Verified against the per-version keyword tables in
 * the MySQL manual, 9.0 through 26.7 (no reserved-word changes in 9.0, 9.1,
 * 9.3, 9.5, 9.7.0 or 26.7). Every key is in RESERVED_WORDS. MariaDB is
 * deliberately absent: it never took these reservations.
 */
/**
 * PostgreSQL's **fully reserved** words (the PG keyword table, Appendix C,
 * category "reserved" — the ones that can never be a bare identifier).
 * `RESERVED_WORDS` above is a *union* whose job is "quote a few extra names,
 * miss none"; this set's job is grading: on a PostgreSQL schema review a name
 * colliding with one of THESE is an orange finding (it exists only because
 * the DDL quoted it), while a name reserved only on MySQL — or a PG keyword
 * from a weaker category — is the milder cross-engine warning. A few entries
 * (`analyse`, `asymmetric`, `variadic`, `current_catalog`, `current_role`)
 * are deliberately absent from `RESERVED_WORDS`: the union exists to decide
 * *quoting*, where a missed PG-only word only costs a rare unquoted paste,
 * while this set exists to decide *severity*, where it must be complete.
 */
export const PG_RESERVED_WORDS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric',
  'both', 'case', 'cast', 'check', 'collate', 'column', 'constraint', 'create',
  'current_catalog', 'current_date', 'current_role', 'current_time',
  'current_timestamp', 'current_user', 'default', 'deferrable', 'desc',
  'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign',
  'from', 'grant', 'group', 'having', 'in', 'initially', 'intersect', 'into',
  'lateral', 'leading', 'limit', 'localtime', 'localtimestamp', 'not', 'null',
  'offset', 'on', 'only', 'or', 'order', 'placing', 'primary', 'references',
  'returning', 'select', 'session_user', 'some', 'symmetric', 'system_user',
  'table', 'then',
  'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic',
  'when', 'where', 'window', 'with',
]);

export interface ReservedWindow { since: string; until?: string }
export const MYSQL_RESERVED_WINDOWS: Record<string, ReservedWindow> = {
  cube: { since: '8.0' }, cume_dist: { since: '8.0' }, dense_rank: { since: '8.0' },
  empty: { since: '8.0' }, except: { since: '8.0' }, first_value: { since: '8.0' },
  function: { since: '8.0' }, grouping: { since: '8.0' }, groups: { since: '8.0' },
  intersect: { since: '8.0' }, json_table: { since: '8.0' }, lag: { since: '8.0' },
  last_value: { since: '8.0' }, lateral: { since: '8.0' }, lead: { since: '8.0' },
  member: { since: '8.0' }, nth_value: { since: '8.0' }, ntile: { since: '8.0' },
  of: { since: '8.0' }, over: { since: '8.0' }, percent_rank: { since: '8.0' },
  rank: { since: '8.0' }, recursive: { since: '8.0' }, row: { since: '8.0' },
  rows: { since: '8.0' }, row_number: { since: '8.0' }, system: { since: '8.0' },
  window: { since: '8.0' },
  qualify: { since: '8.4' }, tablesample: { since: '8.4' },
  manual: { since: '8.4', until: '9.7.2' },
  parallel: { since: '8.4', until: '9.7.2' },
  library: { since: '9.2' },
  external: { since: '9.4' },
  sets: { since: '9.6' },
};

/** Would this identifier mean something else (or nothing) unquoted? */
export function needsQuote(name: string, engine: IdentEngine): boolean {
  if (!name) return false;
  // Only PostgreSQL case-folds, so only there does a mixed-case name need
  // quoting. SQLite preserves case and compares ASCII identifiers
  // case-insensitively, so `Orders` is bare-legal there just as on MySQL.
  const bare = engine === 'postgres' ? PG_BARE : engine === 'sqlserver' ? MS_BARE : MY_BARE;
  if (!bare.test(name)) return true;
  if (engine === 'sqlserver' && TSQL_EXTRA_RESERVED.has(name.toLowerCase())) return true;
  return RESERVED_WORDS.has(name.toLowerCase());
}

/** Quote unconditionally, escaping the quote character by doubling it. */
export function quoteIdent(name: string, engine: IdentEngine): string {
  // SQL Server quotes with brackets; `]` escapes as `]]`. QUOTED_IDENTIFIER
  // makes double quotes work too, but it is a session setting that is OFF in
  // some contexts (and must stay ON for indexed views) — brackets are the
  // always-on choice, so they are the only choice this module makes.
  if (engine === 'sqlserver') {
    return `[${name.replace(/]/g, ']]')}]`;
  }
  // SQLite accepts backticks as a MySQL compatibility extension, but double
  // quotes are its documented form and the SQL standard's — so it quotes like
  // PostgreSQL even though it does not fold case like it. DuckDB is
  // Postgres-flavoured and REJECTS backticks outright (Parser Error at "`"),
  // so it must quote with double quotes too.
  return engine === 'postgres' || engine === 'sqlite' || engine === 'duckdb'
    ? `"${name.replace(/"/g, '""')}"`
    : `\`${name.replace(/`/g, '``')}\``;
}

/** Quote only when the bare form would not resolve to this identifier. */
export function safeIdent(name: string, engine: IdentEngine): string {
  return needsQuote(name, engine) ? quoteIdent(name, engine) : name;
}

/**
 * Join a dotted path (schema, table, column…), quoting each part on its own —
 * `["Shop", "order"]` → `` `Shop`.`order` `` (MySQL) / `"Shop"."order"` (PG).
 * Parts that are already quoted are passed through untouched.
 */
export function safePath(parts: string[], engine: IdentEngine): string {
  return parts
    .filter(p => p !== '' && p != null)
    .map(p => (isQuoted(p) ? p : safeIdent(p, engine)))
    .join('.');
}

/** True when the text is already a quoted identifier. */
export function isQuoted(name: string): boolean {
  return (name.startsWith('`') && name.endsWith('`') && name.length > 1)
    || (name.startsWith('"') && name.endsWith('"') && name.length > 1)
    || (name.startsWith('[') && name.endsWith(']') && name.length > 1);
}

/** Strip one layer of quoting (and un-double the escapes). */
export function unquoteIdent(name: string): string {
  if (!isQuoted(name)) return name;
  if (name[0] === '[') return name.slice(1, -1).split(']]').join(']');
  const q = name[0];
  return name.slice(1, -1).split(q + q).join(q);
}

/**
 * Does this engine's plain `'…'` string literal treat a backslash as an
 * escape? MySQL/MariaDB (NO_BACKSLASH_ESCAPES off — the default) and
 * ClickHouse do; PostgreSQL (`standard_conforming_strings=on` default),
 * SQLite, DuckDB and T-SQL treat it as data. An UNKNOWN engine keeps the
 * historical MySQL behavior — the safe direction for the scanners: they may
 * over-extend a literal, never leak string content into SQL tokens.
 */
export function backslashEscapesStrings(engine?: string): boolean {
  return engine == null || engine === '' || engine === 'mysql'
    || engine === 'mariadb' || engine === 'percona' || engine === 'clickhouse';
}

// ── string literals ──────────────────────────────────────────────────────────

/**
 * A value as a SQL string literal.
 *
 * **Doubling quotes is not enough on MySQL.** Panels were each defining a local
 * `esc = s => s.replace(/'/g, "''")`, which leaves the backslash alone — and
 * with `NO_BACKSLASH_ESCAPES` off (the default) a backslash escapes the first
 * quote of the doubled pair, so the literal ends early. Verified against MySQL
 * 8.0.46: a schema name of
 *
 *     x\' UNION SELECT 1,2,3,4,5,6,7 --
 *
 * fed through the doubling-only version reached the server as parsed SQL and
 * returned `ERROR 1222: The used SELECT statements have a different number of
 * columns` — the UNION was executed, and only the column count saved it.
 *
 * The backslash is escaped first, then the quote. On MySQL either order gives
 * the same answer — doubling quotes introduces no backslashes for the other
 * step to touch. On ClickHouse it is load-bearing: the quote is written `\'`
 * there, so escaping quotes first would leave a backslash for the second step
 * to double into `\\'`, which ends the literal after all.
 *
 * PostgreSQL and SQLite treat a backslash literally, so doubling it there
 * would corrupt the value. The engine decides.
 */
export function sqlLiteral(value: string, engine: IdentEngine = 'mysql'): string {
  return `'${escapeLiteral(value, engine)}'`;
}

/**
 * The inside of a literal, without the surrounding quotes.
 *
 * For the many places that already write `'${…}'` in a template and only need
 * the body escaped. Same rules as [`sqlLiteral`].
 */
export function escapeLiteral(value: string, engine: IdentEngine = 'mysql'): string {
  switch (engine) {
    case 'postgres':
    case 'sqlite':
    case 'duckdb':
    case 'sqlserver':
      // standard_conforming_strings / SQLite / DuckDB / T-SQL: a backslash is
      // data (T-SQL has no backslash escapes at all). Doubling it here would
      // corrupt the value.
      return value.replace(/'/g, "''");
    case 'clickhouse':
      // Backslash escapes, and the quote is escaped as \\' rather than doubled.
      return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    default:
      // MySQL (and MariaDB): the backslash goes first — see above.
      return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
  }
}
