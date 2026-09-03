// Sample backend responses for the documentation screenshots.
//
// Shared by dev/shoot.mjs and dev/shoot_userguide.mjs, and injected into the
// page as `window.__MOCK__` (dev/mock-tauri.ts reads it). A value may be a
// function of the invoke args — `list_schema` needs that, because the object
// tree loads lazily and asks for one `context` at a time.
//
// These shapes are load-bearing: a wrong one renders an empty panel, and an
// empty panel photographs exactly like a broken feature. When a panel's
// response type changes, the screenshot is the last place anyone notices, so
// keep the shape next to the type it mirrors.

/** `QueryResult` — what execute_query / panel_query / list_processes return. */
export function queryResult(columns, rows, ms = 4.2) {
  return {
    columns: columns.map(c =>
      typeof c === 'string'
        ? { name: c, type_name: 'varchar', nullable: true }
        : c),
    rows,
    rows_affected: null,
    execution_ms: ms,
    fetch_ms: 1.1,
    warnings: [],
  };
}

export const ORDERS_RESULT = queryResult(
  [
    { name: 'id', type_name: 'bigint', nullable: false },
    { name: 'customer', type_name: 'varchar(120)', nullable: false },
    { name: 'status', type_name: 'varchar(16)', nullable: false },
    { name: 'total', type_name: 'decimal(10,2)', nullable: false },
    { name: 'currency', type_name: 'char(3)', nullable: false },
    { name: 'channel', type_name: 'varchar(24)', nullable: true },
    { name: 'created_at', type_name: 'timestamp', nullable: true },
  ],
  [
    [10241, 'Aisha Rahman', 'shipped', '128.40', 'EUR', 'web', '2026-08-18 09:12:03'],
    [10242, 'Tomáš Novák', 'pending', '54.00', 'CZK', 'mobile', '2026-08-18 09:14:51'],
    [10243, 'Mei-Ling Chen', 'shipped', '312.75', 'EUR', 'web', '2026-08-18 09:20:11'],
    [10244, 'Carlos Mendes', 'refunded', '0.00', 'EUR', 'partner', '2026-08-18 09:31:44'],
    [10245, 'Sofia Rossi', 'shipped', '89.99', 'EUR', 'web', '2026-08-18 09:40:02'],
    [10246, 'James O’Brien', 'pending', '245.10', 'GBP', 'mobile', '2026-08-18 09:52:37'],
    [10247, 'Yuki Tanaka', 'shipped', '17.25', 'JPY', 'web', '2026-08-18 10:03:19'],
    [10248, 'Fatima Al-Sayed', 'shipped', '431.00', 'EUR', 'partner', '2026-08-18 10:15:55'],
    [10249, 'Lukas Weber', 'cancelled', '76.20', 'EUR', 'web', '2026-08-18 10:22:08'],
    [10250, 'Priya Nair', 'shipped', '154.60', 'EUR', 'mobile', '2026-08-18 10:31:47'],
    [10251, 'Ana García', 'pending', '62.30', 'EUR', 'web', '2026-08-18 10:44:12'],
    [10252, 'Kwame Mensah', 'shipped', '208.00', 'USD', 'partner', '2026-08-18 10:58:26'],
  ],
);

/** Processlist — the panel renders whatever QueryResult it is handed. */
export const PROCESSLIST_RESULT = queryResult(
  ['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info'],
  [
    [418823, 'app_rw', '10.0.2.31:51422', 'shop', 'Query', 184,
      'Sending data', 'SELECT o.id, o.total FROM orders o JOIN order_lines l ON l.order_id = o.id WHERE o.created_at > ?'],
    [418844, 'app_rw', '10.0.2.34:51930', 'shop', 'Query', 92,
      'Waiting for table metadata lock', 'ALTER TABLE order_lines ADD INDEX idx_order (order_id)'],
    [418851, 'reporting', '10.0.4.8:44120', 'shop', 'Query', 61,
      'Copying to tmp table', 'SELECT channel, count(*) FROM orders GROUP BY channel'],
    [418860, 'app_rw', '10.0.2.31:51500', 'shop', 'Sleep', 12, '', null],
    [418862, 'repl', '10.0.9.2:60122', null, 'Binlog Dump GTID', 88431,
      'Master has sent all binlog to slave', null],
    [418871, 'txui', '10.0.7.4:52100', 'shop', 'Query', 0, 'starting', 'SHOW FULL PROCESSLIST'],
  ],
);

export const PG_ACTIVITY_RESULT = queryResult(
  ['pid', 'usename', 'state', 'wait_event_type', 'wait_event', 'duration', 'query'],
  [
    [24188, 'app_rw', 'active', 'IO', 'DataFileRead', '00:00:12.4',
      'SELECT * FROM orders WHERE created_at > now() - interval \'1 day\''],
    [24191, 'app_rw', 'active', 'Lock', 'transactionid', '00:01:38.9',
      'UPDATE inventory SET qty = qty - 1 WHERE sku = $1'],
    [24202, 'reporting', 'active', 'CPU', null, '00:00:03.1',
      'SELECT channel, sum(total) FROM orders GROUP BY 1'],
    [24210, 'app_rw', 'idle in transaction', 'Client', 'ClientRead', '00:04:52.0', 'BEGIN'],
    [24215, 'postgres', 'active', null, null, '00:00:00.0', 'SELECT * FROM pg_stat_activity'],
  ],
);

export const TUNER_REPORT = {
  generated_at: '2026-08-28T14:20:11Z',
  server: {
    version: '8.4.3',
    version_comment: 'MySQL Community Server - GPL',
    flavor: 'mysql',
    arch: 'x86_64',
    uptime_secs: 1_284_400,
    cloud: null,
  },
  eol: {
    product: 'mysql', cycle: '8.4', eol_date: '2032-04-30',
    status: 'supported', latest: '8.4.6', source: 'endoflife.date',
  },
  score: { total: 68, performance: 24, security: 21, resilience: 23 },
  findings: [
    {
      id: 'innodb-buffer-pool-small', category: 'performance', severity: 'warn',
      title: 'InnoDB buffer pool is 12% of data size',
      detail: 'innodb_buffer_pool_size is 2.0G against 16.4G of InnoDB data + indexes. '
        + 'The read hit rate is 91.2%, so pages are being evicted and re-read from disk.',
      recommendation: 'Raise the pool to at least 12G on a host with 32G of RAM, leaving '
        + 'headroom for connections and the OS page cache.',
      fix_sql: ['SET GLOBAL innodb_buffer_pool_size = 12884901888;'],
      fix_config: ['innodb_buffer_pool_size = 12G'],
      points_lost: 8,
    },
    {
      id: 'anon-users', category: 'security', severity: 'critical',
      title: 'Two anonymous accounts can connect',
      detail: "mysql.user contains rows with an empty User for hosts 'localhost' and '%'. "
        + 'An anonymous account matches before a named one on the same host.',
      recommendation: 'Drop both accounts.',
      fix_sql: ["DROP USER ''@'localhost';", "DROP USER ''@'%';"],
      fix_config: [],
      points_lost: 9,
    },
    {
      id: 'binlog-expire', category: 'resilience', severity: 'advice',
      title: 'Binary logs are kept for 3 days',
      detail: 'binlog_expire_logs_seconds = 259200. A restore has to reach a full backup '
        + 'inside that window, and the last full backup is 4 days old.',
      recommendation: 'Keep 7 days of binlogs, or take backups more often.',
      fix_sql: ['SET GLOBAL binlog_expire_logs_seconds = 604800;'],
      fix_config: ['binlog_expire_logs_seconds = 604800'],
      points_lost: 4,
    },
    {
      id: 'slow-log-off', category: 'performance', severity: 'advice',
      title: 'Slow query log is off',
      detail: 'slow_query_log = OFF, so nothing is recording which statements are slow.',
      recommendation: 'Enable it with long_query_time = 1 and review weekly.',
      fix_sql: ['SET GLOBAL slow_query_log = ON;', 'SET GLOBAL long_query_time = 1;'],
      fix_config: ['slow_query_log = ON', 'long_query_time = 1'],
      points_lost: 3,
    },
    {
      id: 'tls-available', category: 'security', severity: 'ok',
      title: 'TLS is configured and in use',
      detail: 'have_ssl = YES; 100% of the sampled non-local connections negotiated TLS.',
      recommendation: null, fix_sql: [], fix_config: [], points_lost: 0,
    },
  ],
};

export const EXPLAIN_JSON = {
  format: 'json',
  engine: 'mysql',
  content: JSON.stringify({
    query_block: {
      select_id: 1,
      cost_info: { query_cost: '4218.55' },
      ordering_operation: {
        using_filesort: true,
        nested_loop: [
          {
            table: {
              table_name: 'o', access_type: 'range', key: 'idx_created_at',
              key_length: '5', rows_examined_per_scan: 18422, rows_produced_per_join: 18422,
              filtered: '100.00',
              cost_info: { read_cost: '1841.20', eval_cost: '1842.20', prefix_cost: '3683.40' },
              used_columns: ['id', 'customer', 'status', 'total', 'created_at'],
              attached_condition: "(`shop`.`o`.`created_at` > '2026-08-01')",
            },
          },
          {
            table: {
              table_name: 'l', access_type: 'ref', key: 'idx_order',
              key_length: '8', ref: ['shop.o.id'], rows_examined_per_scan: 3,
              rows_produced_per_join: 55266, filtered: '100.00',
              cost_info: { read_cost: '535.15', eval_cost: '5526.60', prefix_cost: '4218.55' },
              used_columns: ['order_id', 'sku', 'qty'],
            },
          },
        ],
      },
    },
  }, null, 2),
};

export const REDIS_KEYS = [
  'session:9f2a4c', 'session:1b77de', 'session:c40911',
  'cart:user:8821', 'cart:user:9134',
  'rate:ip:10.0.2.31', 'rate:ip:10.0.2.34',
  'feed:home:v3', 'feed:deals:v3',
  'lock:reindex', 'stats:orders:2026-08-28',
];

export const REDIS_KEY_INFO = {
  key: 'cart:user:8821', key_type: 'hash', ttl: 1740, size: 412, encoding: 'listpack',
};

export const REDIS_VALUE = {
  type: 'hash',
  fields: [
    { field: 'sku:AX-1120', value: '2' },
    { field: 'sku:BR-8840', value: '1' },
    { field: 'currency', value: 'EUR' },
    { field: 'updated_at', value: '2026-08-28T13:58:41Z' },
  ],
};

/**
 * `list_schema(context)` — the tree asks per level, so this is a function.
 * Root (no context) returns databases; a database returns its objects.
 */
export function schemaFor(engine) {
  const t = (name, schema, rows) => ({ kind: 'table', name, schema, row_count: rows });
  const v = (name, schema) => ({ kind: 'view', name, schema });

  const MYSQL = {
    __root: [{ kind: 'database', name: 'shop' }, { kind: 'database', name: 'analytics' },
      { kind: 'database', name: 'mysql' }, { kind: 'database', name: 'information_schema' }],
    shop: [
      t('orders', 'shop', 184_223), t('order_lines', 'shop', 552_664),
      t('customers', 'shop', 41_882), t('inventory', 'shop', 12_004),
      t('payments', 'shop', 180_991), t('shipments', 'shop', 176_330),
      v('v_daily_revenue', 'shop'), v('v_open_orders', 'shop'),
      { kind: 'routine', name: 'sp_close_day', schema: 'shop', routine_type: 'PROCEDURE' },
      { kind: 'routine', name: 'fn_order_total', schema: 'shop', routine_type: 'FUNCTION' },
      { kind: 'trigger', name: 'trg_orders_audit', schema: 'shop', table: 'orders' },
      { kind: 'event', name: 'ev_purge_sessions', schema: 'shop' },
    ],
  };

  const PG = {
    __root: [{ kind: 'database', name: 'shop' }, { kind: 'database', name: 'postgres' }],
    shop: [
      { kind: 'schema', name: 'public' }, { kind: 'schema', name: 'reporting' },
    ],
    public: [
      t('orders', 'public', 184_223), t('order_lines', 'public', 552_664),
      t('customers', 'public', 41_882),
      { kind: 'table', name: 'orders_2026_08', schema: 'public', row_count: 18_422, partition_of: 'orders' },
      v('v_open_orders', 'public'),
      { kind: 'mat_view', name: 'mv_daily_revenue', schema: 'public' },
      { kind: 'sequence', name: 'orders_id_seq', schema: 'public' },
      { kind: 'sequence', name: 'customers_id_seq', schema: 'public' },
      { kind: 'type', name: 'order_status', schema: 'public', type_kind: 'enum' },
      { kind: 'extension', name: 'pg_stat_statements', schema: 'public', version: '1.11', default_version: '1.11' },
    ],
  };

  const CH = {
    __root: [{ kind: 'database', name: 'events' }, { kind: 'database', name: 'system' },
      { kind: 'database', name: 'default' }],
    events: [
      t('page_views', 'events', 812_004_113), t('clicks', 'events', 91_223_004),
      t('sessions', 'events', 18_004_221),
      { kind: 'mat_view', name: 'mv_hourly_views', schema: 'events' },
      { kind: 'mat_view_target', name: '.inner_id.mv_hourly_views', schema: 'events',
        bytes: 4_182_004_112, parts: 84 },
      { kind: 'distributed', name: 'page_views_all', schema: 'events', cluster: 'main',
        target_db: 'events', target_table: 'page_views' },
    ],
  };

  const SQLITE = {
    __root: [
      t('snapshots', null, 8_412), t('processlist', null, 214_882),
      t('metadata_locks', null, 1_204), t('table_io_waits', null, 44_120),
      t('etl_watermarks', null, 12), v('v_recent_snapshots', null),
      { kind: 'index', name: 'idx_snapshots_ts', unique: false, columns: ['captured_at'] },
    ],
  };

  const PARQUET = {
    __root: [
      { kind: 'table', name: 'events.parquet', schema: null, row_count: 4_182_004 },
    ],
    'events.parquet': [
      { kind: 'column', name: 'event_id', type_name: 'INT64', nullable: false, primary_key: false },
      { kind: 'column', name: 'user_id', type_name: 'INT64', nullable: true, primary_key: false },
      { kind: 'column', name: 'event_type', type_name: 'BYTE_ARRAY (UTF8)', nullable: false, primary_key: false },
      { kind: 'column', name: 'ts', type_name: 'INT64 (TIMESTAMP_MICROS)', nullable: false, primary_key: false },
      { kind: 'struct_column', name: 'geo', type_name: 'STRUCT', nullable: true, path: 'geo' },
      { kind: 'column', name: 'revenue', type_name: 'DOUBLE', nullable: true, primary_key: false },
    ],
  };

  const REDIS = {
    __root: [
      { kind: 'key_prefix', name: 'session:', schema: null, count: 18_422, sampled: true },
      { kind: 'key_prefix', name: 'cart:', schema: null, count: 2_104, sampled: true },
      { kind: 'key_prefix', name: 'rate:', schema: null, count: 8_812, sampled: true },
      { kind: 'key_prefix', name: 'feed:', schema: null, count: 12, sampled: false },
    ],
  };

  return { mysql: MYSQL, postgres: PG, clickhouse: CH, sqlite: SQLITE,
    parquet: PARQUET, redis: REDIS }[engine] ?? { __root: [] };
}

/**
 * `list_columns(parent)` — the column/index children of a table row.
 *
 * Engine-specific on purpose. A single shared array is how the Parquet
 * screenshot ended up showing MySQL's `customer_id`, a PRIMARY KEY and a
 * secondary index — none of which Parquet has. Wrong data in a screenshot is
 * worse than missing data: nothing about the image says it is wrong.
 */
export function columnsFor(engine) {
  const col = (name, type_name, nullable = true, primary_key = false) =>
    ({ kind: 'column', name, type_name, nullable, primary_key });

  switch (engine) {
    case 'parquet':
      // No keys, no indexes — Parquet has neither. Physical types as the
      // footer reports them, plus a nested struct.
      return [
        col('event_id', 'INT64', false),
        col('user_id', 'INT64'),
        col('event_type', 'BYTE_ARRAY (UTF8)', false),
        col('ts', 'INT64 (TIMESTAMP_MICROS)', false),
        { kind: 'struct_column', name: 'geo', type_name: 'STRUCT', nullable: true, path: 'geo' },
        col('revenue', 'DOUBLE'),
      ];
    case 'sqlite':
      return [
        col('id', 'INTEGER', false, true),
        col('captured_at', 'TEXT', false),
        col('host', 'TEXT', false),
        col('threads_running', 'INTEGER'),
        col('queries', 'INTEGER'),
        { kind: 'index', name: 'idx_snapshots_ts', unique: false, columns: ['captured_at'] },
      ];
    case 'clickhouse':
      return [
        col('event_date', 'Date', false),
        col('user_id', 'UInt64', false),
        col('url', 'String', false),
        col('duration_ms', 'UInt32', false),
        col('referrer', 'Nullable(String)'),
      ];
    case 'postgres':
      return [
        col('id', 'bigint', false, true),
        col('customer_id', 'bigint', false),
        col('status', 'order_status', false),
        col('total', 'numeric(10,2)', false),
        col('created_at', 'timestamptz'),
        { kind: 'index', name: 'orders_pkey', unique: true, columns: ['id'] },
        { kind: 'index', name: 'orders_created_at_idx', unique: false, columns: ['created_at'] },
      ];
    default:
      return [
        col('id', 'bigint', false, true),
        col('customer_id', 'bigint', false),
        col('status', 'varchar(16)', false),
        col('total', 'decimal(10,2)', false),
        col('created_at', 'timestamp'),
        { kind: 'index', name: 'PRIMARY', unique: true, columns: ['id'] },
        { kind: 'index', name: 'idx_created_at', unique: false, columns: ['created_at'] },
      ];
  }
}

/**
 * The full `window.__MOCK__` payload for one engine.
 *
 * **Plain data only — no functions.** Playwright's `addInitScript` serialises
 * its argument as JSON, so a function here is silently dropped and the command
 * falls through to the mock's typed default. That is how the object tree
 * photographed as "No objects found": `list_schema` was a function, arrived as
 * nothing, and returned []. Anything that needs to vary by argument is declared
 * in `__TREE__` and reassembled inside the page by installMock() below.
 */
export function mockFor(engine) {
  return {
    __TREE__: schemaFor(engine),
    open_connection: `sess-doc-${engine}`,
    session_ping: 3,
    list_columns: columnsFor(engine),
    execute_query: ORDERS_RESULT,
    panel_query: ORDERS_RESULT,
    monitor_query: ORDERS_RESULT,
    browse_table: ORDERS_RESULT,
    get_table_meta: { columns: ORDERS_RESULT.columns, row_count: 184_223, primary_key: ['id'] },
    list_processes: engine === 'postgres' ? PG_ACTIVITY_RESULT : PROCESSLIST_RESULT,
    explain_query: EXPLAIN_JSON,
    tuner_analyze: TUNER_REPORT,
    redis_scan: { cursor: 0, keys: REDIS_KEYS },
    redis_key_info: REDIS_KEY_INFO,
    redis_get_value: REDIS_VALUE,
    redis_server_info: queryResult(['key', 'value'], [
      ['redis_version', '8.0.2'], ['used_memory_human', '1.82G'],
      ['connected_clients', '148'], ['keyspace_hits', '9812004'],
    ]),
    tx_status: { held: false, server_autocommit: true },
    app_metrics: {
      rss_bytes: 92_274_688, cpu_percent: 2.1,
      total_mem_bytes: 17_179_869_184, used_mem_bytes: 9_663_676_416,
    },
    vault_status: { state: 'plain', path: '', connections: 6, secrets: 4, carried_in: null },
    // Privileges are probed through panel_query with a `privileges-*` token
    // (store/sessionPrivileges.ts). Without an answer the panels grey out with
    // "your account cannot use this" — correct behaviour, wrong screenshot.
    __GRANTS__: queryResult(['Grants for doc@%'], [
      ["GRANT ALL PRIVILEGES ON *.* TO `doc`@`%` WITH GRANT OPTION"],
      ['GRANT PROCESS, RELOAD, REPLICATION CLIENT, SUPER ON *.* TO `doc`@`%`'],
    ]),
    server_info: queryResult(['Variable_name', 'Value'], [
      ['version', '8.4.3'], ['innodb_buffer_pool_size', '2147483648'],
      ['max_connections', '512'], ['slow_query_log', 'OFF'],
    ]),
  };
}

/**
 * Runs INSIDE the page (via addInitScript). Rebuilds the argument-dependent
 * commands from the serialisable payload, then publishes window.__MOCK__.
 */
export function installMock(payload) {
  const tree = payload.__TREE__ ?? {};
  const grants = payload.__GRANTS__;
  const panel = payload.panel_query;
  window.__MOCK__ = {
    ...payload,
    list_schema: args => tree[(args && args.context) || '__root'] ?? [],
    // One command, two jobs: the privilege probe rides panel_query under a
    // `privileges-*` token, and answering it with ordinary result rows makes
    // every DBA panel grey itself out.
    panel_query: args =>
      (grants && args && typeof args.token === 'string'
        && args.token.startsWith('privileges-')) ? grants : panel,
  };
}
