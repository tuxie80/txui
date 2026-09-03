/**
 * Smart error guidance for the DBA Views panel: map raw server errors to a
 * short explanation + the fix SQL, and explain empty results on views whose
 * data depends on performance_schema consumers being enabled.
 * Pure module — no React/Tauri imports (unit-tested with node --test).
 */
import type { DbaView } from './dbaViews';

export interface Guidance {
  title: string;
  detail: string;
  /** Copy-able SQL snippets shown with the guidance (may be empty). */
  sql: string[];
}

/** Map a raw panel_query error to actionable guidance, or null if unknown. */
export function guidanceForError(msg: string, engine: string): Guidance | null {
  const m = msg.toLowerCase();

  // MySQL: performance_schema itself unreachable → the server has it OFF.
  if (/table ['`]?(performance_schema)\./.test(m) && /doesn'?t exist|unknown table/.test(m)) {
    return {
      title: 'performance_schema is OFF',
      detail: 'The server was started with performance_schema disabled, so none of its tables exist. '
        + 'This cannot be changed at runtime — set it in the config and restart.',
      sql: ['# my.cnf:\n[mysqld]\nperformance_schema = ON\n# then restart the server'],
    };
  }

  // MySQL: a sys schema table is missing → sys schema not installed.
  if (/table ['`]?sys\./.test(m) && /doesn'?t exist|unknown table/.test(m)) {
    return {
      title: 'sys schema missing',
      detail: 'The sys schema is not installed on this server. MySQL 5.7.7+ and 8.0 ship it by default; '
        + 'MariaDB includes a sys compatibility schema since 10.6. On older servers install it '
        + '(mysql_upgrade, or the sys project from GitHub) or use the performance_schema views instead.',
      sql: [],
    };
  }

  // SQLite: sqlite_stat1 only exists once ANALYZE has been run. Its absence
  // is a real finding — the planner is choosing every plan from guesses — so
  // it must not read as a broken view.
  if (engine === 'sqlite' && /no such table:\s*sqlite_stat1/.test(m)) {
    return {
      title: 'ANALYZE has never been run',
      detail: 'sqlite_stat1 is created by ANALYZE and does not exist yet, so the query planner has '
        + 'no statistics at all and picks indexes from built-in guesses. On a database whose tables '
        + 'have grown since they were created, that regularly means the wrong index — or none. '
        + 'ANALYZE writes, so it needs a connection without READONLY.',
      sql: ['ANALYZE;'],
    };
  }

  // SQLite: dbstat is a compile-time option, absent in some builds.
  if (engine === 'sqlite' && /no such table:\s*dbstat/.test(m)) {
    return {
      title: 'dbstat is not compiled into this SQLite',
      detail: 'The size views read the dbstat virtual table, which requires SQLITE_ENABLE_DBSTAT_VTAB. '
        + 'The build shipped with this app has it; a system SQLite may not. Compile options lists '
        + 'what this build actually has.',
      sql: [],
    };
  }

  // PostgreSQL: pg_stat_statements extension not loaded.
  // Two separate steps, and the order matters: CREATE EXTENSION alone fails
  // with the same error unless the library was preloaded at startup — so the
  // config block is shown first, mirroring the performance_schema guidance.
  if (/relation ["']?pg_stat_statements["']? does not exist/.test(m)) {
    return {
      title: 'pg_stat_statements not installed',
      detail: 'The extension has to be preloaded at server start AND created in this database. '
        + 'Preloading needs a restart — it cannot be set at runtime. Once loaded, create the '
        + 'extension in every database you want to inspect.',
      sql: [
        '# postgresql.conf:\nshared_preload_libraries = \'pg_stat_statements\'\n# then restart the server',
        'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;',
      ],
    };
  }

  // PostgreSQL: catalogs that arrived in a specific major. Each is a real
  // finding about the server, not a broken view — so it is stated as a version
  // fact with what to use instead, rather than as an error.
  if (engine === 'postgres' && /relation ["']?pg_stat_io["']? does not exist/.test(m)) {
    return {
      title: 'pg_stat_io requires PostgreSQL 16+',
      detail: 'The view that splits I/O by who did it and why arrived in 16. On older servers the '
        + 'nearest equivalents are pg_statio_user_tables (per relation) and pg_stat_bgwriter '
        + '(server-wide), neither of which separates a backend from autovacuum.',
      sql: [],
    };
  }
  if (engine === 'postgres' && /relation ["']?pg_stat_checkpointer["']? does not exist/.test(m)) {
    return {
      title: 'pg_stat_checkpointer requires PostgreSQL 17+',
      detail: 'PostgreSQL 17 moved the checkpoint counters out of pg_stat_bgwriter into their own '
        + 'view. On 16 and older, use the Bgwriter / checkpoints view instead — the same numbers '
        + 'are there under the old names.',
      sql: [],
    };
  }
  if (engine === 'postgres'
      && /column ["']?(total|mean|stddev|min|max)_exec_time["']? does not exist/.test(m)) {
    return {
      title: 'pg_stat_statements before PostgreSQL 13 names these columns differently',
      detail: 'The extension split planning from execution in the version that shipped with '
        + 'PostgreSQL 13, renaming total_time → total_exec_time, mean_time → mean_exec_time and '
        + 'stddev_time → stddev_exec_time. On an older server the data is there under the old '
        + 'names; the view as written cannot read it.',
      sql: ['SELECT calls, total_time, mean_time, rows, left(query, 200)\n'
        + 'FROM pg_stat_statements ORDER BY total_time DESC LIMIT 50;'],
    };
  }

  if (engine === 'postgres' && /column ["']?wal_bytes["']? does not exist/.test(m)) {
    return {
      title: 'WAL columns in pg_stat_statements require PostgreSQL 13+',
      detail: 'wal_records / wal_fpi / wal_bytes were added to pg_stat_statements in 13. The '
        + 'extension works on older servers; only these columns are missing.',
      sql: [],
    };
  }

  // PostgreSQL: pg_stat_wal only exists on 14+.
  if (engine === 'postgres' && /relation ["']?pg_stat_wal["']? does not exist/.test(m)) {
    return {
      title: 'pg_stat_wal requires PostgreSQL 14+',
      detail: 'This view does not exist on older servers. Upgrade, or use pg_stat_bgwriter for WAL-adjacent stats.',
      sql: [],
    };
  }

  // ClickHouse: a system log/Keeper table that the server config never
  // enabled. Code 60 names the table; the fix is a config block + restart,
  // not a query — so say which. (Newer builds say "Unknown table expression
  // identifier 'system.x'", older ones "Table system.x doesn't exist".)
  const chSys = engine === 'clickhouse'
    && /unknown table|doesn'?t exist/.test(m)
    && /system\.(\w+)/.exec(m);
  if (chSys) {
    const table = chSys[1];
    const blocks: Record<string, string> = {
      query_log: '<query_log>', part_log: '<part_log>', text_log: '<text_log>',
      metric_log: '<metric_log>', zookeeper_connection: 'a ClickHouse Keeper / ZooKeeper config',
    };
    const block = blocks[table] ?? `the matching <${table}> block`;
    return {
      title: `system.${table} is not enabled on this server`,
      detail: `ClickHouse only creates this system table when the server config asks for it, so this `
        + `is a server-config fact, not a broken view. Add ${block} to config.xml (or a file in `
        + `config.d/) and restart — the table exists from then on.`,
      sql: table === 'query_log'
        ? ['<!-- /etc/clickhouse-server/config.d/query_log.xml -->\n<clickhouse>\n  <query_log>\n    <database>system</database>\n    <table>query_log</table>\n  </query_log>\n</clickhouse>']
        : [],
    };
  }

  return null;
}

/** Inline hint for an empty result on a consumer-dependent view. */
/**
 * Why a consumer-backed view came back empty.
 *
 * `disabled` is the set of consumers the server reports as OFF *right now*.
 * Passing it is the whole point: this used to guess from the view definition
 * alone, so after you ran the fix the same "collection is OFF, run this
 * UPDATE" block kept appearing on every refresh — the advice was stale and
 * looked like the fix had not worked.
 *
 * `null` means the state could not be read (no privileges, or
 * performance_schema is off entirely); that falls back to the old wording,
 * which is honest because we genuinely do not know.
 */
/**
 * `performance_schema` is off entirely — not just a consumer.
 *
 * A different problem from a disabled consumer and it needs different advice,
 * because the consumer advice cannot work: with the whole subsystem off,
 * `setup_consumers` returns **no rows at all**, every performance_schema query
 * returns zero rows *without an error*, and
 * `SET GLOBAL performance_schema = ON` fails with "read only variable". So the
 * panel used to answer an empty grid with an `UPDATE` that no-ops, which is
 * worse than saying nothing.
 *
 * This is the normal state on MariaDB, which ships it off; MySQL ships it on.
 * Measured on MariaDB 10.6.
 */
export function performanceSchemaOffGuidance(): Guidance {
  return {
    title: 'No rows — performance_schema is OFF',
    detail: 'This view reads performance_schema, which is disabled on this server. '
      + 'It is a read-only variable, so it cannot be switched on from here — the server '
      + 'has to be restarted with it enabled. MariaDB ships with it off; MySQL ships with '
      + 'it on, which is why the same view answers on one and not the other. Note that it '
      + 'costs memory and a little throughput, which is why it is off by default:',
    sql: [
      '# in my.cnf / my.ini, then restart the server',
      '[mysqld]',
      'performance_schema = ON',
    ],
  };
}

export function consumerHint(view: DbaView, disabled: string[] | null): Guidance | null {
  const names = view.needsConsumers;
  if (!names || names.length === 0) return null;

  if (disabled !== null && disabled.length === 0) {
    // Collection is on and the view is still empty — that is an answer, not a
    // problem, and it needs no SQL.
    return {
      title: 'No rows — collection is on',
      detail: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} enabled, so this view is `
        + 'genuinely empty: either there is nothing to report, or nothing has been recorded yet. '
        + 'A consumer only captures events that happen after it is enabled, so run some queries '
        + 'and refresh.',
      sql: [],
    };
  }

  const off = disabled ?? names;
  return {
    title: 'No rows — collection is OFF',
    detail: `This view reads data collected by ${off.join(', ')}, which `
      + `${off.length === 1 ? 'is' : 'are'} currently disabled. `
      + 'Consumers can be enabled at runtime (no restart), and start capturing from that moment:',
    sql: off.map(n => `UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME='${n}';`),
  };
}
