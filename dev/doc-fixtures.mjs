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

const MYSQL_PROGRESS_COLUMNS = [
  'conn_id', 'query', 'query_secs', 'state', 'phase', 'work_completed',
  'work_estimated', 'pct', 'phase_secs', 'phase_status', 'event_id',
  'statement_event_id', 'user', 'host', 'db', 'command', 'lock_secs',
  'rows_affected', 'rows_examined', 'rows_sent', 'warnings', 'errors',
  'statement_thread_id',
];

function mysqlProgressRow(eventId, phase, completed, estimated, pct, secs, status, connId, threadId) {
  return [
    connId, 'ALTER TABLE order_lines ADD INDEX idx_order (order_id)',
    184.2, 'Copying to tmp table', phase, completed, estimated, pct, secs,
    status, eventId, 7001, 'app_rw', '10.0.2.34:51930', 'shop', 'Query',
    0.3, 0, 1_250_000, 0, 0, 0, threadId,
  ];
}

export function mysqlProgressFixture() {
  return {
    thread: queryResult(MYSQL_PROGRESS_COLUMNS, [
      mysqlProgressRow(101, 'stage/innodb/alter table (read PK and internal sort)', 1250000, 1250000, 100, 48.2, 'done', 418844, 901),
      mysqlProgressRow(102, 'stage/innodb/alter table (merge sort)', 1250000, 1250000, 100, 31.7, 'done', 418844, 901),
      mysqlProgressRow(103, 'stage/innodb/alter table (insert)', 802500, 1250000, 64.2, 56.8, 'running', 418844, 901),
    ]),
    workers: queryResult(MYSQL_PROGRESS_COLUMNS, [
      mysqlProgressRow(104, 'stage/innodb/alter table (log apply index)', 18400, 92000, 20, 12.4, 'running', null, 902),
    ]),
  };
}

export function pgWorkloadFixture() {
  const columns = [
    'queryid', 'query', 'calls', 'total_exec_time', 'mean_exec_time',
    'rows', 'shared_blks_hit', 'shared_blks_read',
  ];
  return {
    detect: queryResult(['installed', 'available'], [['1.11', '1.11']]),
    version: queryResult(['current_setting'], [[170004]]),
    before: queryResult(columns, [
      ['81001', 'SELECT * FROM orders WHERE created_at > now() - interval \'1 day\'', 1200, 48000, 40, 24000, 90000, 1200],
      ['81002', 'UPDATE inventory SET qty = qty - 1 WHERE sku = $1', 400, 12000, 30, 400, 8000, 80],
    ]),
    after: queryResult(columns, [
      ['81001', 'SELECT * FROM orders WHERE created_at > now() - interval \'1 day\'', 1800, 156000, 86.7, 36000, 92000, 28000],
      ['81002', 'UPDATE inventory SET qty = qty - 1 WHERE sku = $1', 900, 27000, 30, 900, 15000, 240],
      ['81003', 'SELECT customer_id, sum(total) FROM orders GROUP BY customer_id', 80, 9600, 120, 8000, 4000, 16000],
    ]),
  };
}

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

// ── Galera (wsrep) fixtures ─────────────────────────────────────────────────
//
// Real wsrep rows mined from tests/fixtures/galera-status-mariadb118-*.txt —
// live captures of the 3-node MariaDB 11.8.8 + galera 26.4.27 fleet
// (2026-10-02). Two fixture paths consume them:
//
//   (a) the per-session ❖ Galera tab — monitor_query answering the wsrep
//       SHOWs (detection probe, STATUS/VARIABLES polls, the ops probes);
//   (b) the ❖ Galera cluster panel — galera_cluster_poll driving its Channel
//       with one `node` event per selected connection, then `done`.
//
// The counter BASES are the real captures; the per-poll `bump` deltas are
// synthetic (the captures are of an idle cluster, and an idle cluster has no
// write shares to photograph) — installMock() adds them per poll tick, which
// is what gives the rate math (commits/s, bytes/s, "writes here", the ✎ write
// target badge) and the gcache window estimator a second poll to diff against.
// Shapes verified against parseGaleraStatus (src/utils/galeraStatus.ts) and
// the GaleraNodeEvent wire type in src/components/GaleraClusterPanel.tsx.

/** The 3-node cluster as saved connections (one folder — the common case). */
export const GALERA_CONNECTIONS = [
  { id: 'g1', name: 'galera1 (mysql)', engine: 'mysql', host: '127.0.0.1', port: 3341, group: 'Galera' },
  { id: 'g2', name: 'galera2 (mysql)', engine: 'mysql', host: '127.0.0.1', port: 3342, group: 'Galera' },
  { id: 'g3', name: 'galera3 (mysql)', engine: 'mysql', host: '127.0.0.1', port: 3343, group: 'Galera' },
];

const GALERA_UUID = 'b110b4c2-be33-11f1-bc82-9e6500f05053';

/** STATUS rows for node n (1-based), donor = mid-SST donor state. */
function galeraStatusRows(n, donor) {
  return [
    ['wsrep_local_state_uuid', GALERA_UUID],
    ['wsrep_protocol_version', '11'],
    ['wsrep_last_committed', '19000'],
    ['wsrep_replicated', n === 1 ? '6200' : n === 2 ? '3000' : '800'],
    ['wsrep_replicated_bytes', n === 1 ? '812004112' : n === 2 ? '402118804' : '88120441'],
    ['wsrep_repl_keys', n === 1 ? '12400' : n === 2 ? '6000' : '1600'],
    ['wsrep_repl_keys_bytes', n === 1 ? '198400' : n === 2 ? '96000' : '25600'],
    ['wsrep_repl_data_bytes', n === 1 ? '790118442' : n === 2 ? '391002118' : '86011223'],
    ['wsrep_repl_other_bytes', '0'],
    ['wsrep_received', n === 1 ? '190' : n === 2 ? '350' : '460'],
    ['wsrep_received_bytes', n === 1 ? '1500000' : n === 2 ? '2700000' : '3600000'],
    ['wsrep_local_commits', '0'],
    ['wsrep_local_cert_failures', '0'],
    ['wsrep_local_replays', '0'],
    ['wsrep_local_send_queue', '0'],
    ['wsrep_local_send_queue_max', '2'],
    ['wsrep_local_send_queue_min', '0'],
    ['wsrep_local_send_queue_avg', '0.000000'],
    ['wsrep_local_recv_queue', '0'],
    ['wsrep_local_recv_queue_max', '1'],
    ['wsrep_local_recv_queue_min', '0'],
    ['wsrep_local_recv_queue_avg', '0.000000'],
    ['wsrep_local_cached_downto', '1000'],
    ['wsrep_flow_control_paused_ns', '0'],
    ['wsrep_flow_control_paused', '0.000000'],
    ['wsrep_flow_control_sent', '0'],
    ['wsrep_flow_control_recv', '0'],
    ['wsrep_flow_control_active', 'false'],
    ['wsrep_flow_control_requested', 'false'],
    ['wsrep_cert_deps_distance', '3.200000'],
    ['wsrep_apply_oooe', '0.000000'],
    ['wsrep_apply_oool', '0.000000'],
    ['wsrep_apply_window', '1.000000'],
    ['wsrep_commit_oooe', '0.000000'],
    ['wsrep_commit_oool', '0.000000'],
    ['wsrep_commit_window', '1.000000'],
    ['wsrep_local_state', donor ? '2' : '4'],
    ['wsrep_local_state_comment', donor ? 'Donor/Desynced' : 'Synced'],
    ['wsrep_cert_index_size', '12'],
    ['wsrep_causal_reads', '0'],
    ['wsrep_cert_interval', '0'],
    ['wsrep_open_transactions', '0'],
    ['wsrep_open_connections', '3'],
    ['wsrep_incoming_addresses', 'AUTO,AUTO,AUTO'],
    ['wsrep_cluster_weight', '3'],
    ['wsrep_desync_count', donor ? '1' : '0'],
    ['wsrep_evs_delayed', ''],
    ['wsrep_evs_evict_list', ''],
    ['wsrep_evs_repl_latency', '0.000219/0.000478/0.00212/0.00031/0.041'],
    ['wsrep_evs_state', 'OPERATIONAL'],
    ['wsrep_gcomm_uuid', '8ec2e96a-be44-11f1-9ecb-6e972a549e21'],
    ['wsrep_gmcast_segment', '0'],
    ['wsrep_applier_thread_count', '4'],
    ['wsrep_cluster_conf_id', '11'],
    ['wsrep_cluster_size', '3'],
    ['wsrep_cluster_state_uuid', GALERA_UUID],
    ['wsrep_cluster_status', 'Primary'],
    ['wsrep_connected', 'ON'],
    ['wsrep_local_bf_aborts', '0'],
    ['wsrep_local_index', String(n - 1)],
    ['wsrep_provider_capabilities', ':MULTI_MASTER:CERTIFICATION:PARALLEL_APPLYING:TRX_REPLAY:ISOLATION:PAUSE:CAUSAL_READS:INCREMENTAL_WRITESET:UNORDERED:PREORDERED:STREAMING:NBO:'],
    ['wsrep_provider_name', 'Galera'],
    ['wsrep_provider_vendor', 'Codership Oy <info@codership.com>'],
    ['wsrep_provider_version', '4.27(r2633b84)'],
    ['wsrep_ready', 'ON'],
    ['wsrep_rollbacker_thread_count', '1'],
    ['wsrep_thread_count', '5'],
  ];
}

/** VARIABLES rows for node n — the identity keys parseGaleraStatus reads. */
function galeraVariableRows(n) {
  return [
    ['wsrep_on', 'ON'],
    ['wsrep_provider', '/opt/homebrew/lib/galera/libgalera_smm.so'],
    ['wsrep_cluster_name', 'txui-galera'],
    ['wsrep_cluster_address', 'gcomm://127.0.0.1:4561,127.0.0.1:4562,127.0.0.1:4563'],
    ['wsrep_node_address', `127.0.0.1:456${n}`],
    ['wsrep_node_incoming_address', 'AUTO'],
    ['wsrep_node_name', `galera${n}`],
    ['wsrep_desync', 'OFF'],
    ['wsrep_dirty_reads', 'OFF'],
    ['wsrep_reject_queries', 'NONE'],
    ['wsrep_slave_threads', '4'],
    ['wsrep_sst_method', 'rsync'],
    ['wsrep_sync_wait', '0'],
    ['wsrep_osu_method', 'TOI'],
    ['wsrep_auto_increment_control', 'ON'],
    ['wsrep_provider_options', 'base_dir = /var/lib/galera/; gcache.size = 64M; '
      + 'gcache.page_size = 128M; gcache.recover = yes; gcs.fc_limit = 16; '
      + 'gcs.fc_factor = 1.0; gcs.max_throttle = 0.25; evs.suspect_timeout = PT5S; '
      + 'pc.wait_prim = true; pc.recovery = true;'],
    ['wsrep_start_position', `${GALERA_UUID}:64`],
  ];
}

/**
 * The `__GALERA__` payload (plain JSON — installMock() rebuilds the functions
 * from it inside the page). `bump` is added to the named counters per poll
 * tick: node 1 originates ≈62% of the writes, node 2 ≈30%, node 3 ≈8%, so the
 * write-share stats and the ✎ write target badge have something to show.
 * `received` bumps are the peers' originated writes (what this node applies).
 * `donor` puts that node in Donor/Desynced mid-SST (desync OFF + count 1 —
 * the real MariaDB 11.8 donor signature) for the transfer-card shot.
 */
export function galeraFixture({ donor = null } = {}) {
  const deltas = {
    g1: { replicated: 310, bytes: 2_400_000 },
    g2: { replicated: 150, bytes: 1_200_000 },
    g3: { replicated: 40, bytes: 300_000 },
  };
  const nodes = {};
  for (const n of [1, 2, 3]) {
    const id = `g${n}`;
    const d = deltas[id];
    const others = [1, 2, 3].filter(m => m !== n).map(m => deltas[`g${m}`]);
    nodes[id] = {
      status: galeraStatusRows(n, donor === id),
      vars: galeraVariableRows(n),
      bump: {
        wsrep_last_committed: 500,
        wsrep_replicated: donor === id ? 0 : d.replicated,
        wsrep_replicated_bytes: donor === id ? 0 : d.bytes,
        wsrep_received: others.reduce((s, o) => s + o.replicated, 0),
        wsrep_received_bytes: others.reduce((s, o) => s + o.bytes, 0),
        // Keeps the gcache window (last_committed − cached_downto) constant at
        // 18 000 seqnos while the burn rate runs — ≈3 min at 100 commits/s.
        wsrep_local_cached_downto: 500,
      },
    };
  }
  return {
    sessionNode: 'g1',
    names: Object.fromEntries(GALERA_CONNECTIONS.map(c => [c.id, c.name])),
    nodes,
  };
}

// ── Galera cluster processlist + per-row kill fixtures ───────────────────────
//
// Step-⑤ verification (dev/verify_cluster_kill.mjs): `galera_cluster_processlist`
// Channel events for the 3 nodes — realistic MariaDB 11.8 FULL PROCESSLIST
// shapes (per-node columns arrays, applier/rollbacker/event_scheduler system
// threads plus distinct user threads), mined from tests/galeraProcesslist.test.ts
// (itself grounded on the live MariaDB 11.8 capture) — and `galera_cluster_kill`
// outcomes, one thread id wired to fail with ER_KILL_DENIED_ERROR so the inline
// error path renders. installMock() rebuilds the argument-dependent functions
// from the plain `__GALERA_PROC__` payload.

/**
 * The 3-node cluster as saved connections WITH the gating fields the kill
 * flow reads: g2 is prod (typed confirm), g3 is read-only (greyed kill).
 * GALERA_CONNECTIONS stays untouched — the docs screenshots need plain nodes.
 */
export const GALERA_KILL_CONNECTIONS = [
  { id: 'g1', name: 'galera1 (mysql)', engine: 'mysql', host: '127.0.0.1', port: 3341,
    user: 'root', database: null, group: 'Galera', environment: null, read_only: false },
  { id: 'g2', name: 'galera2 (mysql)', engine: 'mysql', host: '127.0.0.1', port: 3342,
    user: 'root', database: null, group: 'Galera', environment: 'prod', read_only: false },
  { id: 'g3', name: 'galera3 (mysql)', engine: 'mysql', host: '127.0.0.1', port: 3343,
    user: 'root', database: null, group: 'Galera', environment: null, read_only: true },
];

/** MariaDB 11.8 FULL PROCESSLIST column order (adds Progress). */
const PROC_COLS = ['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info', 'Progress'];

/** wsrep system threads every live node keeps (appliers, aborter, scheduler). */
function procSystemRows() {
  return [
    ['1', 'system user', '', '', 'Sleep', '1445', 'wsrep aborter idle', '', '0.000'],
    ['2', 'system user', '', '', 'Sleep', '1445', '', '', '0.000'],
    ['3', 'system user', '', '', 'Sleep', '1440', '', '', '0.000'],
    // Identical Info on every node → the cross-node "writeset apply" group.
    ['4', 'system user', '', '', 'Query', '4', 'applying',
      "UPDATE   orders\nSET status = 'shipped'  WHERE id = 9", '0.000'],
    ['7', 'event_scheduler', 'localhost', '', 'Daemon', '88431', 'Waiting on empty queue', '', '0.000'],
  ];
}

/** The probe's own connection — a `user` row every node's poll produces. */
function procProbeRow(id) {
  return [String(id), 'root', 'localhost:54688', '', 'Query', '0', 'starting',
    'SHOW FULL PROCESSLIST', '0.000'];
}

/**
 * The `__GALERA_PROC__` payload (plain JSON). `kill.failIds` lists the thread
 * ids whose kill comes back `ok: false` (ER_KILL_DENIED_ERROR — a missing
 * CONNECTION_ADMIN surfacing honestly). All other ids succeed.
 */
export function galeraProcesslistFixture() {
  return {
    names: Object.fromEntries(GALERA_KILL_CONNECTIONS.map(c => [c.id, c.name])),
    kill: { failIds: [425] },
    nodes: {
      // g1 — the normal node: two killable user threads (412 ok, 425 denied).
      g1: {
        columns: PROC_COLS,
        rows: [
          ...procSystemRows(),
          ['412', 'app_rw', '10.0.2.31:51422', 'shop', 'Query', '184', 'Sending data',
            'SELECT o.id, o.total FROM orders o JOIN order_lines l ON l.order_id = o.id WHERE o.created_at > \'2026-08-01\'',
            '0.000'],
          ['425', 'reporting', '10.0.4.8:44120', 'shop', 'Query', '61', 'Copying to tmp table',
            'SELECT channel, count(*) FROM orders GROUP BY channel', '0.000'],
          procProbeRow(431),
        ],
      },
      // g2 — the prod node: one long-running UPDATE (typed confirm).
      g2: {
        columns: PROC_COLS,
        rows: [
          ...procSystemRows(),
          ['777', 'app_rw', '10.0.2.34:51930', 'shop', 'Query', '92',
            'Waiting for table metadata lock',
            'ALTER TABLE order_lines ADD INDEX idx_order (order_id)', '0.000'],
          procProbeRow(781),
        ],
      },
      // g3 — the read-only node: its rows' Kill greys out with the reason.
      g3: {
        columns: PROC_COLS,
        rows: [
          ...procSystemRows(),
          ['901', 'backup', '10.0.9.2:60122', null, 'Query', '305', 'Sending data',
            'SELECT * FROM shop.orders ORDER BY created_at DESC', '0.000'],
          procProbeRow(909),
        ],
      },
    },
  };
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
    // Galera fixtures ride the mysql mock by default so the help-site panel
    // sweep (dev/shoot.mjs) captures the ❖ Galera cluster panel with a real
    // node card instead of an eternal "Polling…". Nothing else sends wsrep
    // SQL, so non-Galera panels are unaffected (the monitor_query router
    // falls through to ORDERS_RESULT for anything else).
    ...(engine === 'mysql' ? { __GALERA__: galeraFixture() } : {}),
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
    __GRANTS__: engine === 'postgres'
      ? queryResult(['is_super', 'is_monitor', 'read_all_stats', 'signal_backend', 'has_pgss'], [
        [true, true, true, true, true],
      ])
      : queryResult(['Grants for doc@%'], [
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
  const gal = payload.__GALERA__;
  const proc = payload.__GALERA_PROC__;
  // Tick counters live in the page: each poll round bumps the wsrep counters
  // by the fixture's `bump` deltas, so the second poll has something to diff
  // (write rates, shares, the gcache burn rate) — an unchanging counter set
  // photographs as an idle cluster with every rate at "—".
  let galSessTick = 0;
  let galClusterTick = 0;
  /** STATUS rows with one tick of deltas applied (numbers as strings, as SHOW). */
  const galTickRows = (node, tick) => node.status.map(([k, v]) => {
    const b = node.bump[k];
    return b === undefined ? [k, v] : [k, String(Number(v) + b * tick)];
  });
  /** QueryResult in the [Variable_name, Value] shape SHOW produces. */
  const galKv = rows => ({
    columns: [
      { name: 'Variable_name', type_name: 'varchar', nullable: false },
      { name: 'Value', type_name: 'varchar', nullable: true },
    ],
    rows, rows_affected: null, execution_ms: 2.1, fetch_ms: 0.4, warnings: [],
  });
  const galPlain = rows => ({
    columns: rows[0]?.map((_, i) => ({ name: `c${i}`, type_name: 'varchar', nullable: true })) ?? [],
    rows, rows_affected: null, execution_ms: 1.8, fetch_ms: 0.3, warnings: [],
  });
  let pgWorkloadCaptures = 0;
  const routeMonitor = args => {
    const sql = String((args && args.sql) ?? '');
    const progress = payload.__MYSQL_PROGRESS__;
    if (progress && sql.includes('information_schema.PROCESSLIST')) return progress.thread;
    if (progress && sql.includes('FROM performance_schema.events_stages_current s')) {
      return progress.workers;
    }
    const workload = payload.__PG_WORKLOAD__;
    if (workload && sql.includes('pg_available_extensions')) return workload.detect;
    if (workload && sql.includes("current_setting('server_version_num')")) return workload.version;
    if (workload && sql.includes('FROM pg_stat_statements')) {
      pgWorkloadCaptures += 1;
      return pgWorkloadCaptures % 2 === 1 ? workload.before : workload.after;
    }
    return payload.monitor_query;
  };
  window.__MOCK__ = {
    ...payload,
    list_schema: args => tree[(args && args.context) || '__root'] ?? [],
    monitor_query: routeMonitor,
    // One command, two jobs: the privilege probe rides panel_query under a
    // `privileges-*` token, and answering it with ordinary result rows makes
    // every DBA panel grey itself out.
    panel_query: args =>
      (grants && args && typeof args.token === 'string'
        && args.token.startsWith('privileges-')) ? grants : panel,
    ...(gal ? {
      // The ❖ Galera tab's probe set (GaleraClusterView.tsx): detection, the
      // 5 s STATUS/VARIABLES poll, the ops probes. Anything else (the async
      // replication tab's SHOWs, …) falls through to the static fixture.
      monitor_query: args => {
        const sql = String((args && args.sql) ?? '');
        const node = gal.nodes[gal.sessionNode];
        if (sql === "SHOW GLOBAL VARIABLES LIKE 'wsrep_on'") {
          return galKv([['wsrep_on', 'ON']]);
        }
        if (sql === "SHOW GLOBAL STATUS LIKE 'wsrep%'") {
          galSessTick += 1;
          return galKv(galTickRows(node, galSessTick));
        }
        if (sql === "SHOW GLOBAL VARIABLES LIKE 'wsrep%'") return galKv(node.vars);
        if (sql.includes('@@session.wsrep_sync_wait')) return galPlain([[0, 'OFF']]);
        if (sql.includes('SYSTEM_VARIABLES')) return galPlain([['YES']]);
        if (sql.includes('WSREP_MEMBERSHIP')) return galPlain([]);
        return routeMonitor(args);
      },
      // The ❖ Galera cluster panel (GaleraClusterPanel.tsx): one `node` event
      // per selected connection on the Channel handed over in the invoke args,
      // then `done`. A connection id with no fixture node reuses node 1's rows.
      galera_cluster_poll: args => {
        galClusterTick += 1;
        const ch = args && args.onEvent;
        const ids = [
          ...((args && args.connectionIds) ?? []),
          ...(((args && args.adhocConfigs) ?? []).map(c => c.id)),
        ];
        if (ch && ch.onmessage) {
          for (const id of ids) {
            const node = gal.nodes[id] ?? gal.nodes.g1;
            ch.onmessage({
              type: 'node', connection_id: id,
              connection_name: gal.names[id] ?? id,
              ok: true, error: null,
              status_rows: galTickRows(node, galClusterTick),
              variable_rows: node.vars,
              elapsed_ms: 9 + Math.round(Math.random() * 8),
            });
          }
          ch.onmessage({ type: 'done', nodes: ids.length, ok_count: ids.length, total_ms: 31 });
        }
        return null;
      },
    } : {}),
    ...(proc ? {
      // #2 cluster-wide processlist (the "▦ Processes" view): one `node` event
      // per selected connection carrying that node's columns + raw string rows,
      // then `done`. A connection id with no fixture node reuses node 1's.
      galera_cluster_processlist: args => {
        const ch = args && args.onEvent;
        const ids = [
          ...((args && args.connectionIds) ?? []),
          ...(((args && args.adhocConfigs) ?? []).map(c => c.id)),
        ];
        if (ch && ch.onmessage) {
          for (const id of ids) {
            const node = proc.nodes[id] ?? proc.nodes[Object.keys(proc.nodes)[0]];
            ch.onmessage({
              type: 'node', connection_id: id,
              connection_name: proc.names[id] ?? id,
              ok: true, error: null,
              columns: node.columns, rows: node.rows,
              elapsed_ms: 6 + Math.round(Math.random() * 5),
            });
          }
          ch.onmessage({ type: 'done', nodes: ids.length, ok_count: ids.length, total_ms: 24 });
        }
        return null;
      },
      // Per-row Kill: KillOutcome[] exactly as the backend returns it — the
      // statement actually issued, per-thread failure as data (never a throw).
      // `failIds` threads come back ER_KILL_DENIED_ERROR so the inline error
      // path renders in the verification run.
      galera_cluster_kill: args => {
        const id = Number(args && args.id);
        const statement = `${(args && args.mode) === 'connection' ? 'KILL' : 'KILL QUERY'} ${id}`;
        if (((proc.kill && proc.kill.failIds) ?? []).includes(id)) {
          return [{
            id, ok: false,
            error: `ER_KILL_DENIED_ERROR: You are not owner of thread ${id}`,
            statement,
          }];
        }
        return [{ id, ok: true, error: null, statement }];
      },
    } : {}),
  };
}
