use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::db::types::{ConnectionConfig, Engine, LiveSession};
use crate::db::ssh::SshTunnel;
use crate::history::HistoryStore;

pub type ConfigStore = Arc<RwLock<HashMap<Uuid, ConnectionConfig>>>;
pub type SessionMap  = Arc<RwLock<HashMap<Uuid, Arc<LiveSession>>>>;
/// SSH child processes kept alive for the duration of a session.
pub type TunnelMap   = Arc<RwLock<HashMap<Uuid, SshTunnel>>>;
/// Oneshot senders used to cancel in-flight queries.
/// Key = "<session_id>-<tab_id>".
pub type CancelMap   = Arc<RwLock<HashMap<String, tokio::sync::oneshot::Sender<()>>>>;
/// Server-side backend ids (MySQL thread id / PG backend pid) of in-flight
/// queries, so cancel can issue KILL QUERY / pg_cancel_backend. Same key.
pub type KillMap     = Arc<RwLock<HashMap<String, u64>>>;
/// In-flight ClickHouse `query_id`s, same key as {@link KillMap}.
///
/// Separate from `KillMap` rather than widening it: ClickHouse identifies a
/// running query by an opaque string it was *told* to use, not by a numeric
/// backend the server assigned. There is no connection to kill either — the
/// HTTP request is stateless, so the only handle is the id, and the only way
/// to stop the query is `KILL QUERY WHERE query_id = …` sent over a second
/// request. Different identifier, different kill verb, different lifetime.
pub type ChKillMap   = Arc<RwLock<HashMap<String, String>>>;
/// Editor's chosen default database/schema per session — injected as
/// USE / SET search_path on the connection before each editor query.
pub type SessionDbMap = Arc<RwLock<HashMap<Uuid, String>>>;

/// Server-side write guard + prod hard limits captured from the connection
/// config at open time, so every command can enforce them regardless of the
/// frontend.
#[derive(Clone, Debug)]
pub struct SessionGuard {
    pub read_only:   bool,
    /// Which guard applies. Redis commands are not SQL — `sqlguard` reported
    /// FLUSHALL/DEL/SET as reads, so a Redis session must be judged by
    /// `redisguard` instead.
    pub engine: Engine,
    /// "prod" enables the server-side hard limits (sqlguard::check_prod_limits)
    pub environment: Option<String>,
    /// Per-connection directory for server activity logs (append_server_log)
    pub log_dir: Option<String>,
    /// Opt-outs from the prod hard limits
    pub prod_allow_ddl: bool,
    pub prod_allow_unfiltered_write: bool,
    /// Connection asks for autocommit off, so the session pins a connection and
    /// holds a transaction on it. Applied to the **pinned** connection only —
    /// see db/mysql.rs::setup_new_connection for why not to the pool.
    pub autocommit: bool,
    /// Per-connection client-side query deadline, in seconds. `None` defers to
    /// the app-wide setting; `Some(0)` is explicitly unbounded. Captured here
    /// rather than looked up per query — execute_query holds a session id, and
    /// this is what a session id already resolves to.
    pub query_timeout_secs: Option<u32>,
}

impl SessionGuard {
    /// Should a bulk job be refused on this session?
    ///
    /// Bulk jobs — data generation, database generation, CSV import — have no
    /// single statement for `check_prod_limits` to judge, so they checked
    /// `read_only` and nothing else. A connection marked **prod** therefore
    /// accepted a million generated rows, or a round of CREATE/DROP TABLE,
    /// with none of the friction the prod border exists to provide.
    ///
    /// Lives here rather than on `AppState` so it is testable without a
    /// database: `AppState` owns a live SQLite pool for history.
    pub fn refuse_bulk(&self, what: &str) -> Result<(), String> {
        if self.environment.as_deref() != Some("prod") || self.prod_allow_ddl {
            return Ok(());
        }
        Err(format!(
            "blocked on prod: {what} writes in bulk to a production server \
             — enable 'Allow destructive DDL' on the connection to permit"))
    }
}

impl SessionGuard {
    /// Capture the guard fields from a connection config at session open.
    pub fn from_config(config: &ConnectionConfig) -> Self {
        SessionGuard {
            read_only:   config.read_only,
            engine:      config.engine,
            environment: config.environment.clone(),
            log_dir:     config.log_dir.clone(),
            prod_allow_ddl: config.prod_allow_ddl,
            prod_allow_unfiltered_write: config.prod_allow_unfiltered_write,
            autocommit: config.autocommit,
            query_timeout_secs: config.query_timeout_secs,
        }
    }
}
pub type SessionMetaMap = Arc<RwLock<HashMap<Uuid, SessionGuard>>>;

/// What a session's lifecycle audit rows need after the config is gone:
/// captured at open so `close_connection`/`close_all` can write the
/// 'disconnect' entry with nothing but the session id in hand.
#[derive(Clone, Debug)]
pub struct SessionStart {
    pub connection_name: String,
    /// The wire/frontend engine name ("mysql", "mongodb", …) — Engine::wire_name.
    pub engine:          String,
    pub db_user:         String,
    pub database:        String,
    /// Monotonic clock for the duration; `at_text` is the displayable twin in
    /// the audit log's text format (the same shape the frontend's isoNow writes).
    pub at:              std::time::Instant,
    pub at_text:         String,
}
pub type SessionStartMap = Arc<RwLock<HashMap<Uuid, SessionStart>>>;

/// Which client-side query deadline applies, given the connection's setting
/// and the app-wide one.
///
/// The three-way distinction is the whole point and is easy to flatten by
/// accident: `None` on the connection means "no opinion, use the app value",
/// while `Some(0)` means "this connection is explicitly unbounded" and must
/// therefore beat a non-zero app-wide default. Collapsing them — treating a
/// connection's 0 as absent — would silently re-impose the global ceiling on
/// the one connection the user had exempted, which is where the long ALTER
/// they were protecting gets killed.
pub fn resolve_query_deadline(per_conn: Option<u32>, app_wide: u32) -> Option<std::time::Duration> {
    let secs = per_conn.unwrap_or(app_wide);
    (secs > 0).then(|| std::time::Duration::from_secs(u64::from(secs)))
}
/// Oneshot senders that kill running external dump/restore processes.
/// Key = "{scope_id}-{run_key}" — see [`ext_job_key`].
pub type ExtJobMap = Arc<RwLock<HashMap<String, tokio::sync::oneshot::Sender<()>>>>;

/// The key an external job (watch / playground / datagen / dump / CSV import)
/// is registered under. The frontend generates a bare UUID run key; the
/// backend prefixes it with the owning session (or connection, for dump, which
/// has no session) so `cancel_session_work` can find everything a session has
/// running by prefix.
pub fn ext_job_key(scope: Uuid, run_key: &str) -> String {
    format!("{scope}-{run_key}")
}

/// Remove an external job's cancel sender, accepting either the raw frontend
/// run key or the scope-prefixed stored form, so the cancel commands keep
/// working with the un-prefixed key the frontend holds.
pub async fn take_ext_job(
    map: &ExtJobMap,
    run_key: &str,
) -> Option<tokio::sync::oneshot::Sender<()>> {
    let mut m = map.write().await;
    if let Some(tx) = m.remove(run_key) {
        return Some(tx);
    }
    let suffix = format!("-{run_key}");
    let key = m.keys().find(|k| k.ends_with(&suffix)).cloned();
    key.and_then(|k| m.remove(&k))
}

/// Does a cancel/kill map key belong to this session? Three shapes exist:
/// `"{session}-{tab}"` (editor), `"panel-{session}-{token}"` (panels) and
/// `"multi-{session}"` (multi-server execution).
fn session_owned_key(key: &str, session_id: &str) -> bool {
    key.starts_with(&format!("{session_id}-"))
        || key.starts_with(&format!("panel-{session_id}-"))
        || key == format!("multi-{session_id}")
}

/// A connection held open for a manual transaction (autocommit off).
/// While present for a session, editor queries route through it so BEGIN /
/// statements / COMMIT all happen on the SAME backend connection.
pub enum TxConn {
    My(sqlx::pool::PoolConnection<sqlx::MySql>),
    Pg(sqlx::pool::PoolConnection<sqlx::Postgres>),
}
pub type TxConnMap = Arc<RwLock<HashMap<Uuid, Arc<tokio::sync::Mutex<TxConn>>>>>;

/// Ingested Dolphie replay recordings, keyed by a `path|size|mtime` fingerprint
/// so a re-open of the same unchanged file reuses the in-memory columnar cache
/// instantly, and a grown recording (live daemon still appending) is rebuilt.
/// This is the "convert once to a faster format" spine of the Replay feature.
pub type ReplayCacheMap =
    Arc<RwLock<HashMap<String, Arc<crate::db::replay::ReplayCache>>>>;

#[derive(Clone)]
pub struct AppState {
    pub configs:  ConfigStore,
    pub sessions: SessionMap,
    pub tunnels:  TunnelMap,
    pub cancels:  CancelMap,
    pub kills:    KillMap,
    pub ch_kills: ChKillMap,
    pub session_dbs: SessionDbMap,
    pub session_meta: SessionMetaMap,
    /// When each session connected + the identity its lifecycle audit rows
    /// carry. Entries are written at open and removed at close (both of which
    /// also write the audit row), so the map never outlives the session.
    pub session_starts: SessionStartMap,
    pub ext_jobs: ExtJobMap,
    pub tx_conns: TxConnMap,
    pub history:  HistoryStore,
    /// App data dir — connection configs are persisted here as JSON.
    pub data_dir: std::path::PathBuf,
    /// Connect timeout, in seconds, for connections that do not set their own.
    /// Mirrors the Settings value; see db::types::DEFAULT_CONNECT_TIMEOUT_SECS.
    pub connect_timeout_secs: std::sync::Arc<std::sync::atomic::AtomicU32>,
    /// Client-side query deadline, in seconds, for connections that do not set
    /// their own. `0` is unbounded, which is the default — see
    /// db::types::DEFAULT_QUERY_TIMEOUT_SECS.
    pub query_timeout_secs: std::sync::Arc<std::sync::atomic::AtomicU32>,
    /// Running `LISTEN` tasks, keyed by the frontend's token. Each holds a
    /// dedicated connection, so an unstopped one is an invisible leak.
    pub pg_listeners: crate::commands::pglisten::ListenerMap,
    /// Ingested Dolphie replay recordings (see {@link ReplayCacheMap}).
    pub replay_cache: ReplayCacheMap,
    /// Per-session Redis command catalog: the baseline unioned with the
    /// server's own `ACL CAT write` answer, captured once at connect (WP-10
    /// 10.3). Sessions without an entry (old servers, ACL refused) fall back
    /// to the shared baseline.
    pub redis_catalogs: std::sync::Arc<tokio::sync::RwLock<std::collections::HashMap<Uuid, std::sync::Arc<crate::redisguard::CommandCatalog>>>>,
}

impl AppState {
    pub fn new(
        history: HistoryStore,
        data_dir: std::path::PathBuf,
        configs: HashMap<Uuid, ConnectionConfig>,
    ) -> Self {
        AppState {
            configs:  Arc::new(RwLock::new(configs)),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            tunnels:  Arc::new(RwLock::new(HashMap::new())),
            cancels:  Arc::new(RwLock::new(HashMap::new())),
            kills:    Arc::new(RwLock::new(HashMap::new())),
            ch_kills: Arc::new(RwLock::new(HashMap::new())),
            session_dbs: Arc::new(RwLock::new(HashMap::new())),
            session_meta: Arc::new(RwLock::new(HashMap::new())),
            session_starts: Arc::new(RwLock::new(HashMap::new())),
            ext_jobs: Arc::new(RwLock::new(HashMap::new())),
            tx_conns: Arc::new(RwLock::new(HashMap::new())),
            history,
            data_dir,
            connect_timeout_secs: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(
                crate::db::types::DEFAULT_CONNECT_TIMEOUT_SECS as u32,
            )),
            query_timeout_secs: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(
                crate::db::types::DEFAULT_QUERY_TIMEOUT_SECS,
            )),
            pg_listeners: Arc::new(RwLock::new(HashMap::new())),
            replay_cache: Arc::new(RwLock::new(HashMap::new())),
            redis_catalogs: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// The client-side query deadline in force for a session: the connection's
    /// own value if it set one, otherwise the app-wide default.
    pub async fn query_deadline(&self, session_id: &Uuid) -> Option<std::time::Duration> {
        let per_conn = self.session_meta.read().await
            .get(session_id).and_then(|g| g.query_timeout_secs);
        resolve_query_deadline(
            per_conn,
            self.query_timeout_secs.load(std::sync::atomic::Ordering::Relaxed),
        )
    }

    /// True if the session was opened from a read-only connection config.
    pub async fn is_read_only(&self, session_id: &Uuid) -> bool {
        self.session_meta.read().await.get(session_id).map(|g| g.read_only).unwrap_or(false)
    }

    /// Stop everything a session has running, so `close_connection` never
    /// hangs on it: in-flight queries, watches, data generation, playground
    /// runs, PG listeners and wait samplers all hold pooled connections or
    /// run loops that would otherwise outlive the close.
    ///
    /// Everything here is fire-and-forget or bounded — this must NEVER hang:
    /// oneshots are fired, JoinHandles aborted, and server-side kills are
    /// issued through `stop_in_flight`, which spawns rather than awaits.
    pub async fn cancel_session_work(&self, session_id: Uuid) {
        let sid = session_id.to_string();

        // Client-side cancels: the editor/panel/multi-exec oneshots.
        let senders: Vec<_> = {
            let mut map = self.cancels.write().await;
            let keys: Vec<String> = map.keys()
                .filter(|k| session_owned_key(k, &sid))
                .cloned().collect();
            keys.into_iter().filter_map(|k| map.remove(&k)).collect()
        };
        for tx in senders { let _ = tx.send(()); }

        // External jobs (watch / playground / datagen / CSV import; dump is
        // keyed by connection, not session, and holds no pooled connection).
        let jobs: Vec<_> = {
            let mut map = self.ext_jobs.write().await;
            let keys: Vec<String> = map.keys()
                .filter(|k| k.starts_with(&format!("{sid}-")))
                .cloned().collect();
            keys.into_iter().filter_map(|k| map.remove(&k)).collect()
        };
        for tx in jobs { let _ = tx.send(()); }

        // PG LISTEN listeners pin a pool connection for their whole lifetime;
        // the wait samplers poll on it. Both are aborted, not awaited.
        crate::commands::pglisten::abort_session_listeners(&self.pg_listeners, session_id).await;
        crate::commands::pgwait::stop_session_samplers(session_id).await;

        // Server-side kills for queries in flight right now. `stop_in_flight`
        // removes the handles and spawns the KILL / pg_cancel_backend, so a
        // dead server cannot stall the close.
        let keys: Vec<String> = {
            let kills = self.kills.read().await;
            let ch = self.ch_kills.read().await;
            kills.keys().chain(ch.keys())
                .filter(|k| session_owned_key(k, &sid))
                .cloned().collect()
        };
        for key in keys {
            crate::commands::query::stop_in_flight(
                session_id, &key, &self.sessions, &self.kills, &self.ch_kills,
            ).await;
        }
    }

    /// Prod hard limits for a session (destructive DDL / unfiltered writes
    /// blocked unless the connection opts out). Unknown session → Ok.
    pub async fn check_prod_limits(&self, session_id: &Uuid, sql: &str) -> Result<(), String> {
        match self.session_meta.read().await.get(session_id) {
            Some(g) if g.engine == Engine::Redis =>
                crate::redisguard::check_prod_limits(g, sql),
            Some(g) => crate::sqlguard::check_prod_limits(g, sql),
            None => Ok(()),
        }
    }

    /// Run a read on the session's PINNED connection when one exists.
    ///
    /// Returns `None` when nothing is pinned, so the caller falls back to the
    /// pool. This is what makes a panel or the data browser see the session's
    /// **uncommitted** work: without it they acquire a different connection,
    /// cannot see rows written inside the open transaction, and a user who
    /// inserts a row then opens the browser concludes the insert failed.
    ///
    /// Every command that executes SQL for a session should go through here
    /// first. `execute_query` did; `monitor_query`, `panel_query`,
    /// `browse_table` and `kill_candidates` did not.
    pub async fn try_on_tx_conn(
        &self,
        session_id: &Uuid,
        sql: &str,
    ) -> Option<Result<crate::db::types::QueryResult, crate::apperror::AppError>> {
        let txc = self.tx_conns.read().await.get(session_id).cloned()?;
        let mut guard = txc.lock().await;
        Some(match &mut *guard {
            TxConn::My(conn) => crate::db::mysql::execute(&mut **conn, sql)
                .await
                .map_err(crate::apperror::AppError::from),
            TxConn::Pg(conn) => crate::db::postgres::execute(&mut **conn, sql)
                .await
                .map_err(crate::apperror::AppError::from),
        })
    }

    /// The single read-only + prod gate for anything that executes a
    /// statement. Engine-aware: SQL statements go through `sqlguard`, Redis
    /// command lines through `redisguard`. Every execution path calls this
    /// rather than picking a guard itself — the previous per-site
    /// `sqlguard::is_write` calls silently let every Redis write through.
    /// Execute a statement for a session with **every** cross-cutting rule
    /// applied: the read-only and prod guards first, then the session's pinned
    /// transaction connection if one exists, then the pool.
    ///
    /// This exists because those rules were opt-in per call site, and the
    /// opting-in was incomplete in a way nothing could catch. `drop_routine`
    /// took a `drop_sql: String` straight from the frontend and ran it with no
    /// guard at all, so the prod border — the thing standing between a user and
    /// `DROP PROCEDURE` on production — simply did not apply to it. Neither did
    /// the transaction routing, so a routine created inside an open transaction
    /// landed on a pooled connection and committed on its own.
    ///
    /// A command that reaches for `pool.acquire()` directly is opting out of
    /// all of it, and nothing about that line says so. This one does the right
    /// thing by default.
    pub async fn run_guarded(
        &self,
        session_id: &Uuid,
        sql: &str,
    ) -> Result<crate::db::types::QueryResult, crate::apperror::AppError> {
        self.guard_statement(session_id, sql).await?;
        if let Some(r) = self.try_on_tx_conn(session_id, sql).await {
            return r;
        }
        let session = crate::db::connection::get_session_pub(*session_id, &self.sessions)
            .await
            .map_err(crate::apperror::AppError::from)?;
        match session.as_ref() {
            LiveSession::Mysql(pool) => crate::db::mysql::execute(&mut *pool.acquire().await.map_err(crate::apperror::AppError::from)?, sql)
                .await.map_err(crate::apperror::AppError::from),
            LiveSession::Postgres(pool) => crate::db::postgres::execute(&mut *pool.acquire().await.map_err(crate::apperror::AppError::from)?, sql)
                .await.map_err(crate::apperror::AppError::from),
            LiveSession::Sqlite(pool) => crate::db::sqlite::execute(pool, sql)
                .await.map_err(crate::apperror::AppError::from),
            LiveSession::Clickhouse(ch) => crate::db::clickhouse::execute(ch, sql)
                .await.map_err(crate::apperror::AppError::from),
            LiveSession::Parquet(f) => crate::db::parquet::execute(f, sql)
                .map_err(crate::apperror::AppError::from),
            LiveSession::Duckdb(s) => crate::db::duckdb::execute(s, sql)
                .await.map_err(crate::apperror::AppError::from),
            // Redis is not SQL; a caller holding a SQL string has already gone
            // wrong, and guessing a translation would be worse than saying so.
            LiveSession::Redis(..) =>
                Err("this command is not available for Redis".into()),
            // MongoDB likewise: find goes through `mongo_find`, and the driver
            // has no write path at all (see db/mongodb.rs).
            LiveSession::MongoDb(_) =>
                Err("this command is not available for MongoDB".into()),
            LiveSession::SqlServer(s) => crate::db::sqlserver::execute(s, sql)
                .await.map_err(crate::apperror::AppError::from),
        }
    }

    /// Is a transaction pinned to this session right now?
    ///
    /// Bulk jobs (data generation, CSV import) run on their own pooled
    /// connections with their own transactions — they cannot join the pinned
    /// one without serialising against it. So they must refuse rather than
    /// write outside a transaction the user believes they are inside: rolling
    /// back afterwards would leave every generated row in place.
    pub async fn has_open_transaction(&self, session_id: &Uuid) -> bool {
        self.tx_conns.read().await.contains_key(session_id)
    }

    /// The prod border for a bulk job, which has no single statement to judge.
    ///
    /// `generate_data` and `generate_database` checked `is_read_only` and
    /// stopped there, so a connection marked **prod** would happily have a
    /// million rows written into it, or have tables created and dropped, with
    /// none of the friction the border exists to provide.
    pub async fn check_prod_bulk(&self, session_id: &Uuid, what: &str) -> Result<(), String> {
        match self.session_meta.read().await.get(session_id) {
            Some(g) => g.refuse_bulk(what),
            // An unknown session is not assumed to be production: a stale id
            // would otherwise block a job on a connection that never was.
            None => Ok(()),
        }
    }

    /// Execute without the guards, for the one case where they would do harm.
    ///
    /// `save_routine` drops a routine and then creates its replacement. If the
    /// create fails it puts the original definition back — and a prod border
    /// that permitted the drop and then refused the restore would leave the
    /// user strictly worse off than if nothing had run at all. The guards have
    /// already had their say on the way in; this is the undo.
    ///
    /// Transaction routing still applies: the restore must land wherever the
    /// drop did.
    pub async fn run_unguarded_restore(
        &self,
        session_id: &Uuid,
        sql: &str,
    ) -> Result<crate::db::types::QueryResult, crate::apperror::AppError> {
        if let Some(r) = self.try_on_tx_conn(session_id, sql).await {
            return r;
        }
        let session = crate::db::connection::get_session_pub(*session_id, &self.sessions)
            .await
            .map_err(crate::apperror::AppError::from)?;
        match session.as_ref() {
            LiveSession::Mysql(pool) => crate::db::mysql::execute(
                &mut *pool.acquire().await.map_err(crate::apperror::AppError::from)?, sql)
                .await.map_err(crate::apperror::AppError::from),
            LiveSession::Postgres(pool) => crate::db::postgres::execute(
                &mut *pool.acquire().await.map_err(crate::apperror::AppError::from)?, sql)
                .await.map_err(crate::apperror::AppError::from),
            _ => Err("restore is only available on MySQL and PostgreSQL".into()),
        }
    }

    pub async fn guard_statement(&self, session_id: &Uuid, sql: &str) -> Result<(), crate::apperror::AppError> {
        let guard = self.session_meta.read().await.get(session_id).cloned();
        let Some(g) = guard else { return Ok(()) };

        if g.engine == Engine::Redis {
            // The session's server-informed catalog when the connect-time
            // `ACL CAT write` probe answered; the shared baseline otherwise.
            // Never rebuilt per statement.
            let session_catalog = self.redis_catalogs.read().await.get(session_id).cloned();
            let class = match &session_catalog {
                Some(cat) => cat.classify_line(sql),
                None => crate::redisguard::baseline_catalog().classify_line(sql),
            };
            if g.read_only && class.mutates() {
                return Err(crate::apperror::AppError::guard(format!(
                    "connection is read-only — {} command rejected", class.as_str())));
            }
            return crate::redisguard::check_prod_limits(&g, sql)
                .map_err(crate::apperror::AppError::guard);
        }

        if g.read_only && crate::sqlguard::is_write(sql) {
            return Err(crate::apperror::AppError::guard(
                "connection is read-only — write statement rejected"));
        }
        crate::sqlguard::check_prod_limits(&g, sql)
            .map_err(crate::apperror::AppError::guard)
    }
}

#[cfg(test)]
mod cancel_work_tests {
    use super::*;
    use std::collections::HashMap;

    async fn test_state() -> AppState {
        let history = crate::history::open_in_memory().await.expect("in-memory history");
        AppState::new(history, std::env::temp_dir(), HashMap::new())
    }

    #[test]
    fn session_owned_key_covers_all_three_shapes() {
        let sid = Uuid::new_v4().to_string();
        let other = Uuid::new_v4().to_string();
        assert!(session_owned_key(&format!("{sid}-7"), &sid), "editor key");
        assert!(session_owned_key(&format!("panel-{sid}-tok"), &sid), "panel key");
        assert!(session_owned_key(&format!("multi-{sid}"), &sid), "multi-exec key");
        assert!(!session_owned_key(&format!("{other}-7"), &sid));
        assert!(!session_owned_key(&format!("panel-{other}-tok"), &sid));
        assert!(!session_owned_key("panel-7-tok", &sid));
    }

    #[tokio::test]
    async fn take_ext_job_accepts_bare_and_prefixed_keys() {
        let map: ExtJobMap = Default::default();
        let scope = Uuid::new_v4();
        let (tx1, rx1) = tokio::sync::oneshot::channel::<()>();
        let (tx2, rx2) = tokio::sync::oneshot::channel::<()>();
        map.write().await.insert(ext_job_key(scope, "run-a"), tx1);
        map.write().await.insert("unprefixed".to_string(), tx2);

        // The frontend holds the bare key in both cases.
        let tx = take_ext_job(&map, "run-a").await.expect("prefixed entry");
        tx.send(()).unwrap();
        assert_eq!(rx1.await, Ok(()));
        let tx = take_ext_job(&map, "unprefixed").await.expect("bare entry");
        tx.send(()).unwrap();
        assert_eq!(rx2.await, Ok(()));
        assert!(map.read().await.is_empty());
        assert!(take_ext_job(&map, "run-a").await.is_none(), "already taken");
    }

    /// The whole point of the sweep: a session's in-flight work is drained and
    /// fired, another session's is untouched.
    #[tokio::test]
    async fn cancel_session_work_drains_only_this_sessions_entries() {
        let state = test_state().await;
        let sid = Uuid::new_v4();
        let other = Uuid::new_v4();

        let mut receivers = Vec::new();
        for key in [
            format!("{sid}-1"),
            format!("panel-{sid}-tok"),
            format!("multi-{sid}"),
        ] {
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            state.cancels.write().await.insert(key, tx);
            receivers.push(rx);
        }
        let (other_tx, other_rx) = tokio::sync::oneshot::channel::<()>();
        state.cancels.write().await.insert(format!("{other}-2"), other_tx);

        let (job_tx, job_rx) = tokio::sync::oneshot::channel::<()>();
        state.ext_jobs.write().await.insert(ext_job_key(sid, "run-1"), job_tx);
        let (conn_tx, _conn_rx) = tokio::sync::oneshot::channel::<()>();
        state.ext_jobs.write().await.insert(ext_job_key(other, "run-2"), conn_tx);

        state.kills.write().await.insert(format!("{sid}-1"), 42);
        state.kills.write().await.insert(format!("{other}-3"), 43);
        state.ch_kills.write().await.insert(format!("panel-{sid}-tok"), "qid".into());

        // A listener belonging to the session and one belonging to another.
        let listener = tokio::spawn(std::future::pending::<()>());
        let other_listener = tokio::spawn(std::future::pending::<()>());
        state.pg_listeners.write().await.insert("l1".into(),
            crate::commands::pglisten::ListenerEntry { session_id: sid, handle: listener });
        state.pg_listeners.write().await.insert("l2".into(),
            crate::commands::pglisten::ListenerEntry { session_id: other, handle: other_listener });

        state.cancel_session_work(sid).await;

        for rx in receivers {
            assert_eq!(rx.await, Ok(()), "the session's cancel was not fired");
        }
        assert_eq!(job_rx.await, Ok(()), "the session's ext job was not fired");
        assert!(state.cancels.read().await.contains_key(&format!("{other}-2")));
        assert!(state.ext_jobs.read().await.contains_key(&ext_job_key(other, "run-2")));
        assert!(state.kills.read().await.contains_key(&format!("{other}-3")));
        assert!(!state.kills.read().await.contains_key(&format!("{sid}-1")),
            "kill handle must be removed once the kill is issued");
        assert!(state.ch_kills.read().await.is_empty());
        let listeners = state.pg_listeners.read().await;
        assert!(!listeners.contains_key("l1"), "the session's listener must be aborted");
        assert!(listeners.contains_key("l2"), "another session's listener must survive");
        drop(listeners);

        // Tidy: the surviving entries would otherwise outlive the test.
        if let Some(e) = state.pg_listeners.write().await.remove("l2") { e.handle.abort(); }
        drop(other_rx);
    }

    /// An idle session (nothing running anywhere) must close without drama.
    #[tokio::test]
    async fn cancel_session_work_on_an_idle_session_is_a_no_op() {
        let state = test_state().await;
        state.cancel_session_work(Uuid::new_v4()).await;
    }
}

#[cfg(test)]
mod bulk_border_tests {
    use super::SessionGuard;
    use crate::db::types::Engine;

    fn guard(env: Option<&str>, allow: bool) -> SessionGuard {
        SessionGuard {
            read_only: false,
            engine: Engine::Mysql,
            environment: env.map(str::to_string),
            log_dir: None,
            prod_allow_ddl: allow,
            prod_allow_unfiltered_write: false,
            autocommit: true,
            query_timeout_secs: None,
        }
    }

    mod query_deadline {
        use super::super::resolve_query_deadline as resolve;
        use std::time::Duration;

        #[test]
        fn no_connection_setting_falls_back_to_the_app_wide_one() {
            assert_eq!(resolve(None, 30), Some(Duration::from_secs(30)));
        }

        #[test]
        fn the_connection_setting_wins_when_present() {
            assert_eq!(resolve(Some(5), 30), Some(Duration::from_secs(5)));
        }

        /// Unbounded is the shipped default, so this is the path almost every
        /// query takes — it must cost nothing and bound nothing.
        #[test]
        fn zero_everywhere_means_unbounded() {
            assert_eq!(resolve(None, 0), None);
        }

        /// The distinction worth having a function for: a connection that
        /// explicitly says "no deadline" must not have the global one applied
        /// back to it. Flattening `Some(0)` into "unset" is the bug this
        /// pins — it would kill exactly the long ALTER the user exempted.
        #[test]
        fn a_connection_can_opt_out_of_a_global_deadline() {
            assert_eq!(resolve(Some(0), 30), None);
        }

        /// And the reverse: a connection may impose one where there is no
        /// global default at all, which is the common single-server case.
        #[test]
        fn a_connection_can_opt_in_without_a_global_default() {
            assert_eq!(resolve(Some(10), 0), Some(Duration::from_secs(10)));
        }
    }

    /// The bulk jobs checked `read_only` and stopped there, so a connection
    /// marked prod accepted a million generated rows without friction.
    #[test]
    fn bulk_generation_is_stopped_on_prod() {
        let e = guard(Some("prod"), false).refuse_bulk("data generation").unwrap_err();
        assert!(e.contains("blocked on prod"), "{e}");
        assert!(e.contains("data generation"), "the message must name the job: {e}");
        assert!(e.contains("enable"), "no way out offered: {e}");
        assert!(!e.contains("  "), "stray spaces in: {e}");
    }

    #[test]
    fn the_opt_out_lets_it_through() {
        assert!(guard(Some("prod"), true).refuse_bulk("data generation").is_ok());
    }

    #[test]
    fn nothing_is_blocked_off_prod() {
        assert!(guard(None, false).refuse_bulk("CSV import").is_ok());
        assert!(guard(Some("staging"), false).refuse_bulk("CSV import").is_ok());
        // "prod" is matched exactly — a label that merely contains it is a
        // different environment, and guessing would block the wrong servers.
        assert!(guard(Some("preprod"), false).refuse_bulk("CSV import").is_ok());
    }
}

