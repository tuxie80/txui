export type Engine = 'mysql' | 'postgres' | 'redis' | 'clickhouse' | 'sqlite' | 'parquet' | 'duckdb' | 'mongodb' | 'sqlserver';

export type SslMode = 'disable' | 'preferred' | 'require' | 'verify_ca' | 'verify_full';

export interface Label {
  /** Display name, without the hidden marker. */
  name: string;
  /** Groups and filters, but spends no chip in the sidebar. */
  hidden: boolean;
}

export interface ConnectionConfig {
  id:       string;
  name:     string;
  engine:   Engine;
  host:     string | null;
  port:     number | null;
  user:     string | null;
  database: string | null;
  ssl_mode: SslMode;
  group:    string | null;
  color:    string | null;
  /** "dev" | "test" | "prod" — prod triggers confirm-before-write */
  environment: string | null;
  /** Client-side write guard */
  read_only: boolean;
  /** Autocommit for this connection. `false` pins one connection for the whole
   *  session and keeps a transaction open on it, so Commit/Rollback are live
   *  from the moment you connect — and settle everything you ran, not whichever
   *  pooled connection the statement happened to use. */
  autocommit: boolean;
  notes: string | null;
  auto_connect: boolean;
  /** Superseded by `labels`; still read so an old config or import loads. */
  tags: string[];
  /** The functional grouping — what fleet checks run against. See utils/labels. */
  labels: Label[];
  // SSH tunnel
  use_ssh:      boolean;
  ssh_host:     string | null;
  ssh_port:     number | null;
  ssh_user:     string | null;
  ssh_key_path: string | null;
  // SSL certificates
  /** MySQL session time zone. null/blank = UTC (TxUI default); 'SYSTEM' =
   *  the server's own zone; or an offset / named zone. */
  time_zone: string | null;
  ssl_ca_path:   string | null;
  ssl_cert_path: string | null;
  ssl_key_path:  string | null;
  /** Accept ANY server certificate — verification off, not narrowed. Default
   *  false. SQL Server only today; the escape hatch for self-signed dev
   *  servers, including every stock SQL Server container. */
  trust_server_cert?: boolean;
  // Cloud SQL IAM auth (MySQL / PostgreSQL): password is a minted OAuth token.
  use_iam_auth?: boolean;
  iam_key_path?: string | null;
  // Connection tuning
  connect_timeout_secs: number | null;
  /** Client-side query deadline, seconds. null = use the app-wide Settings
   *  value; 0 = explicitly unbounded for this connection. */
  query_timeout_secs: number | null;
  /** PG application_name / MySQL program_name */
  application_name: string | null;
  /** MySQL: SET SESSION k = v; PG: startup options */
  extra_params: Record<string, string>;
  /** Unix socket path; overrides host/port when set */
  /** File-backed engines (SQLite, Parquet, DuckDB): the file this connection
   *  opens. Replaces host/port entirely — there is nothing to dial. DuckDB
   *  also takes `:memory:` for a scratch database. */
  file_path?: string | null;
  socket_path: string | null;
  /** Statements run once per new pooled connection */
  init_sql: string | null;
  // MySQL-specific
  charset: string | null;
  collation: string | null;
  /** Allow mysql_clear_password auth plugin (PAM) */
  enable_cleartext_plugin: boolean;
  // Pool tuning
  pool_max: number | null;
  pool_acquire_timeout_secs: number | null;
  pool_idle_timeout_secs: number | null;
  /** Server-side ceiling per statement. What it covers differs by engine — see ConnectionForm. */
  statement_timeout_secs: number | null;
  // SSH (jump host + password auth)
  /** user@host[:port] */
  ssh_jump: string | null;
  use_ssh_password: boolean;
  // Logging
  /** Directory for the per-connection server activity log (null = off) */
  log_dir: string | null;
  // Prod hard limits (server-side enforced; these opt OUT)
  /** prod: permit DROP/TRUNCATE/ALTER/RENAME/GRANT/REVOKE */
  prod_allow_ddl: boolean;
  /** prod: permit UPDATE/DELETE without a WHERE clause */
  prod_allow_unfiltered_write: boolean;
}

export interface PingResult {
  ok: boolean;
  latency_ms: number;
  server_version: string | null;
  error: string | null;
}

export interface ColumnInfo {
  name: string;
  type_name: string;
  nullable: boolean;
}

export interface QueryResult {
  columns: ColumnInfo[];
  rows: unknown[][];
  rows_affected: number | null;
  /** EXECUTE-only time (first row / stream completion for writes) */
  execution_ms: number;
  /** Remaining fetch time; TOTAL = execution_ms + fetch_ms (0 for Redis/browser) */
  fetch_ms: number;
  /** MySQL server warnings (SHOW WARNINGS) — one formatted line each, opt-in */
  warnings: string[];
  /** True when the backend row cap cut the result — more rows existed. */
  truncated?: boolean;
}

export type SchemaNode =
  | { kind: 'database'; name: string }
  | { kind: 'schema';   name: string }
  | { kind: 'table';    name: string; schema: string | null; row_count: number | null;
      /** PostgreSQL: parent table when this is a partition. */
      partition_of?: string | null;
      /**
       * MariaDB system-versioned table — it keeps every historical row.
       *
       * Nothing else reveals it: `row_start` / `row_end` are hidden from
       * `information_schema.COLUMNS`, so a table that silently retains its
       * whole history looks identical to one that does not.
       */
      temporal?: boolean }
  | { kind: 'view';     name: string; schema: string | null }
  | { kind: 'mat_view'; name: string; schema: string | null }
  /**
   * ClickHouse Distributed-engine table — a proxy over a per-shard local table.
   * `cluster` is the cluster it spans; `target_db`/`target_table` is the local
   * table it links to.
   */
  | { kind: 'distributed'; name: string; schema: string | null; cluster: string;
      target_db: string; target_table: string }
  /**
   * ClickHouse materialized-view storage target — the backing table an MV
   * writes into, emitted as a child of the MV. `name`/`schema` name the target;
   * `bytes`/`parts` are the target's on-disk size (null for a non-MergeTree
   * target that stores no parts).
   */
  | { kind: 'mat_view_target'; name: string; schema: string | null;
      bytes: number | null; parts: number | null }
  | { kind: 'routine';  name: string; schema: string | null; routine_type: string }
  | { kind: 'trigger';  name: string; schema: string | null;
      /** Relation the trigger is attached to (null when the source omits it). */
      table?: string | null }
  | { kind: 'event';    name: string; schema: string | null }
  | { kind: 'sequence'; name: string; schema: string | null }
  | { kind: 'type';     name: string; schema: string | null; type_kind: string }
  | { kind: 'policy';   name: string; schema: string | null; table: string; command: string }
  | { kind: 'extension'; name: string; schema: string | null; version: string;
      default_version: string | null }
  /** PostgreSQL logical-replication publication (cluster-global, at the root). */
  | { kind: 'publication'; name: string; schema: string | null; all_tables: boolean;
      table_count: number }
  /** PostgreSQL event trigger (cluster-global). */
  | { kind: 'event_trigger'; name: string; schema: string | null; event: string;
      enabled: boolean }
  /** PostgreSQL tablespace (cluster-global). `location` is empty for built-ins. */
  | { kind: 'tablespace'; name: string; schema: string | null; owner: string;
      location: string }
  /** PostgreSQL foreign server (cluster-global). */
  | { kind: 'foreign_server'; name: string; schema: string | null; fdw: string }
  /** PostgreSQL foreign table — backed by a foreign server. */
  | { kind: 'foreign_table'; name: string; schema: string | null; server: string }
  | { kind: 'key_prefix'; name: string; schema: string | null; count: number; sampled: boolean }
  | { kind: 'column';   name: string; type_name: string; nullable: boolean; primary_key: boolean }
  | { kind: 'struct_column'; name: string; type_name: string; nullable: boolean; path: string }
  | { kind: 'index';    name: string; unique: boolean; columns: string[] };

export interface Session {
  connectionId: string;
  sessionId: string;
  connectionName: string;
  engine: Engine;
  environment?: string | null;
  readOnly?: boolean;
  /** user-picked connection colour — propagates to the session tab (DataGrip-style) */
  color?: string | null;
  /** File-backed engines (SQLite/Parquet/DuckDB): the opened file. Used to
   *  detect a Dolphie replay recording and route it to the Replay workspace. */
  filePath?: string | null;
  /** Ephemeral in-memory DuckDB session opened without a saved connection
   *  (utils/scratch). Its connectionId is a one-off UUID, and nothing about
   *  it persists: no buffers, no undo history, no config — closing the tab
   *  drops the database with the session. */
  scratch?: boolean;
}
