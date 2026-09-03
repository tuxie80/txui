//! Kill hinting — the data behind the `kill …` / `killall` editor popup.
//!
//! `kill_candidates` returns ONE normalized row per server backend, longest
//! running first, enriched with everything you need to be sure about what a
//! KILL would hit: transaction age, rows locked, and the **lock-wait graph**
//! (who blocks whom) so the UI can point at the blocker instead of its
//! victims. `kill_processes` kills a batch and reports per-thread outcomes.
//!
//! Everything beyond the plain processlist is best-effort: missing privileges
//! or a server without `sys` degrades the extra columns, never the list.
use sqlx::AssertSqlSafe;
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;
use uuid::Uuid;

use crate::db::connection::get_session_pub;
use crate::db::types::{LiveSession, QueryResult};
use crate::db::{mysql, postgres, redis};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub id: u64,
    pub user: String,
    pub host: String,
    pub db: String,
    /// MySQL COMMAND (Query/Sleep/…) · PG backend state (active/idle in transaction/…)
    pub command: String,
    /// Seconds in the current state (MySQL TIME · PG now()-query_start)
    pub time: i64,
    /// MySQL STATE (thread stage) · PG wait_event_type:wait_event
    pub state: String,
    pub info: String,
    /// Seconds the transaction has been open; -1 = no open transaction
    pub trx_age: i64,
    pub rows_locked: i64,
    pub trx_state: String,
    /// Thread ids this backend is blocking (it holds what they want)
    pub blocking: Vec<u64>,
    /// Thread ids blocking this backend
    pub blocked_by: Vec<u64>,
    /// The connection TxUI polled with — killing it is refused
    pub is_self: bool,
    /// Server-internal thread (event scheduler, binlog dump, autovacuum, …)
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillOutcome {
    pub id: u64,
    pub ok: bool,
    pub error: Option<String>,
    /// The exact statement issued — the UI logs it verbatim
    pub statement: String,
}

// ── SQL ───────────────────────────────────────────────────────────────────────

/// The statement is truncated server-side: the UI shows ~300 chars and the
/// digest reads 400, while MySQL's INFO can be 64 kB per row — shipping that
/// for every backend, every second, is pure waste on the wire.
const INFO_CHARS: usize = 512;

/// Processlist + InnoDB transaction age/locks in one pass, longest first.
/// `{src}` is the processlist source (see `MY_PROCS_SOURCES`).
/// Threads returned per poll.
///
/// A server with fifteen thousand connections would otherwise ship fifteen
/// thousand rows across the IPC boundary every second so the picker can render
/// sixty of them. The cap is applied **server-side**, after the ordering, so
/// what arrives is the top of the list rather than an arbitrary slice.
pub const PROCS_LIMIT: usize = 500;

/// How the processlist is narrowed before it crosses the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcFilter {
    /// Include threads that are merely sleeping.
    pub include_idle: bool,
    pub limit: usize,
}

impl Default for ProcFilter {
    fn default() -> Self {
        Self { include_idle: false, limit: PROCS_LIMIT }
    }
}

/// The `WHERE` that drops idle connections — but never the ones that matter.
///
/// "Ignore Sleep" is the right instinct and the wrong rule. Three kinds of
/// sleeping thread are the whole reason you opened the list:
///
///   - one holding an **open transaction**, which keeps its locks and its
///     read view while doing nothing — the classic outage, and exactly what
///     `killall` looks for;
///   - one that is **blocking** somebody, which is the same thing seen from
///     the other side;
///   - one whose `TIME` is enormous, which is a leaked connection rather than
///     an idle one.
///
/// So idleness alone is not the filter — idleness *with nothing attached to
/// it* is. Without the transaction join there is no way to tell those apart,
/// and the honest move is to keep every sleeper rather than hide the one that
/// matters.
fn idle_predicate(with_trx: bool) -> &'static str {
    if with_trx {
        " WHERE (p.COMMAND <> 'Sleep' OR x.trx_id IS NOT NULL OR p.TIME >= 600)"
    } else {
        // No transaction data available: keep everything rather than risk
        // hiding a sleeper that is holding locks.
        ""
    }
}

fn my_procs_sql(src: &str, with_trx: bool) -> String {
    my_procs_sql_filtered(src, with_trx, ProcFilter { include_idle: true, limit: 0 })
}

fn my_procs_sql_filtered(src: &str, with_trx: bool, f: ProcFilter) -> String {
    let trx = if with_trx {
        "LEFT JOIN information_schema.innodb_trx x ON x.trx_mysql_thread_id = p.ID"
    } else {
        ""
    };
    let (age, locked, state) = if with_trx {
        ("IFNULL(TIMESTAMPDIFF(SECOND, x.trx_started, NOW()), -1)",
         "IFNULL(x.trx_rows_locked, 0)", "IFNULL(x.trx_state,'')")
    } else {
        ("-1", "0", "''")
    };
    let filter = if f.include_idle { "" } else { idle_predicate(with_trx) };
    let limit = if f.limit == 0 { String::new() } else { format!(" LIMIT {}", f.limit) };
    format!(
        "SELECT p.ID, IFNULL(p.USER,'') AS u, IFNULL(p.HOST,'') AS h, IFNULL(p.DB,'') AS db, \
                IFNULL(p.COMMAND,'') AS cmd, IFNULL(p.TIME,0) AS t, IFNULL(p.STATE,'') AS st, \
                LEFT(IFNULL(p.INFO,''), {info}) AS info, \
                {age} AS trx_age, {locked} AS rows_locked, {state} AS trx_state \
         FROM {src} p {trx}{filter} ORDER BY p.TIME DESC{limit}",
        info = INFO_CHARS, src = src, trx = trx, age = age, locked = locked,
        state = state, filter = filter, limit = limit)
}

/// Where to read the processlist from, best first:
/// `performance_schema.processlist` (8.0.22+) is a drop-in for
/// `information_schema.PROCESSLIST` that does NOT take the global thread mutex —
/// on a server with thousands of connections that is the difference between a
/// free poll and one that stalls new connections. It can be empty when the
/// instrument is off, and our own connection is always in the list, so
/// **zero rows means "not available"** and we fall through.
const MY_PROCS_SOURCES: &[&str] = &["performance_schema.processlist", "information_schema.PROCESSLIST"];

/// Which source+shape worked for a session, so a 1 Hz poll probes ONCE instead
/// of paying for two failing queries on every tick (a server without
/// `performance_schema.processlist`, or a user without PROCESS on innodb_trx).
/// Cleared for that session whenever the remembered query stops working, so a
/// privilege or instrument change is picked up on the next poll.
static PROCS_SOURCE: std::sync::OnceLock<std::sync::Mutex<HashMap<Uuid, (usize, bool)>>> =
    std::sync::OnceLock::new();

fn procs_source_cache() -> &'static std::sync::Mutex<HashMap<Uuid, (usize, bool)>> {
    PROCS_SOURCE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn remembered_source(session_id: Uuid) -> Option<(usize, bool)> {
    procs_source_cache().lock().ok()?.get(&session_id).copied()
}

/// Called when a session closes — the map must not grow for the app's lifetime.
pub fn forget_session(session_id: Uuid) {
    remember_source(session_id, None);
}

fn remember_source(session_id: Uuid, choice: Option<(usize, bool)>) {
    if let Ok(mut map) = procs_source_cache().lock() {
        match choice {
            Some(c) => { map.insert(session_id, c); }
            None    => { map.remove(&session_id); }
        }
    }
}

/// Row-lock waits (InnoDB) and metadata-lock waits (MDL) — both as
/// (waiting thread, blocking thread) pairs.
const MY_ROW_WAITS_SQL: &str = "SELECT waiting_pid, blocking_pid FROM sys.innodb_lock_waits";
const MY_MDL_WAITS_SQL: &str = "SELECT waiting_pid, blocking_pid FROM sys.schema_table_lock_waits";

const PG_PROCS_SQL: &str = "\
SELECT a.pid, \
       COALESCE(a.usename,'') AS u, \
       COALESCE(host(a.client_addr) || ':' || a.client_port::text, 'local') AS h, \
       COALESCE(a.datname,'') AS db, \
       COALESCE(a.state,'') AS cmd, \
       COALESCE(EXTRACT(EPOCH FROM (now() - a.query_start))::bigint, 0) AS t, \
       COALESCE(a.wait_event_type || ':' || a.wait_event, '') AS st, \
       LEFT(COALESCE(a.query,''), 512) AS info, \
       COALESCE(EXTRACT(EPOCH FROM (now() - a.xact_start))::bigint, -1) AS trx_age, \
       0 AS rows_locked, \
       COALESCE(a.backend_type,'') AS trx_state, \
       COALESCE(array_to_string(pg_blocking_pids(a.pid), ','), '') AS blockers, \
       (a.pid = pg_backend_pid()) AS is_self \
FROM pg_stat_activity a ORDER BY t DESC LIMIT 500";
// ^ same server-side cap as the MySQL path (PROCS_LIMIT): applied AFTER the
// ordering, so what arrives is the top of the list, not an arbitrary slice.

// ── value helpers (rows arrive as serde_json values from db::*::execute) ──────

fn v_u64(v: &serde_json::Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_i64().map(|n| n.max(0) as u64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .unwrap_or(0)
}

fn v_i64(v: &serde_json::Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_f64().map(|f| f as i64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .unwrap_or(0)
}

fn v_str(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn cell(r: &[serde_json::Value], i: usize) -> serde_json::Value {
    r.get(i).cloned().unwrap_or(serde_json::Value::Null)
}

/// (waiting, blocking) pairs from a two-column result.
fn wait_pairs(r: &QueryResult) -> Vec<(u64, u64)> {
    r.rows.iter()
        .map(|row| (v_u64(&cell(row, 0)), v_u64(&cell(row, 1))))
        .filter(|(w, b)| *w != 0 && *b != 0 && w != b)
        .collect()
}

/// MySQL threads that are the server's own, not a client's.
fn my_is_system(user: &str, command: &str) -> bool {
    matches!(user, "event_scheduler" | "system user" | "unauthenticated user")
        || command.starts_with("Binlog Dump")
        || command == "Daemon"
        || command == "Connect"
}

fn pg_is_system(backend_type: &str) -> bool {
    !backend_type.is_empty() && backend_type != "client backend"
}

// ── commands ──────────────────────────────────────────────────────────────────

/// Live kill candidates, longest-running first. Read-only on the server.
#[tauri::command]
/// Threads worth offering to `kill`.
///
/// `include_idle` is off by default: a server with fifteen thousand idle
/// connections would otherwise bury the handful of threads actually doing
/// something, and ship all fifteen thousand across the wire every second to do
/// it. Sleepers holding a transaction, or aged past ten minutes, are kept
/// regardless — see `idle_predicate`.
pub async fn kill_candidates(
    session_id: Uuid,
    include_idle: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<ProcInfo>, crate::apperror::AppError> {
    let filter = ProcFilter { include_idle: include_idle.unwrap_or(false), ..Default::default() };
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let mut conn = pool.acquire().await?;
            let self_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
                .fetch_one(&mut *conn).await?;

            // Cheapest source that actually returns rows; innodb_trx is dropped
            // from the query if it is unreadable (no PROCESS privilege). The
            // winning combination is remembered per session — this runs once a
            // second, so probing every time would be pure overhead.
            let mut procs = None;
            if let Some((i, with_trx)) = remembered_source(session_id) {
                match mysql::execute(&mut *conn, &my_procs_sql_filtered(MY_PROCS_SOURCES[i], with_trx, filter)).await {
                    Ok(r) if !r.rows.is_empty() => procs = Some(r),
                    // stopped working (instrument off, privilege revoked) → re-probe
                    _ => remember_source(session_id, None),
                }
            }
            if procs.is_none() {
                'probe: for (i, src) in MY_PROCS_SOURCES.iter().enumerate() {
                    for with_trx in [true, false] {
                        if let Ok(r) = mysql::execute(&mut *conn, &my_procs_sql_filtered(src, with_trx, filter)).await {
                            if !r.rows.is_empty() {
                                remember_source(session_id, Some((i, with_trx)));
                                procs = Some(r);
                                break 'probe;
                            }
                        }
                    }
                }
            }
            let procs = match procs {
                Some(r) => r,
                // Last resort: report the real error from the portable source.
                None => mysql::execute(&mut *conn, &my_procs_sql(MY_PROCS_SOURCES[1], false))
                    .await?,
            };

            let mut out: Vec<ProcInfo> = procs.rows.iter().map(|row| {
                let user = v_str(&cell(row, 1));
                let command = v_str(&cell(row, 4));
                let id = v_u64(&cell(row, 0));
                ProcInfo {
                    id,
                    is_system: my_is_system(&user, &command),
                    user,
                    host: v_str(&cell(row, 2)),
                    db: v_str(&cell(row, 3)),
                    command,
                    time: v_i64(&cell(row, 5)),
                    state: v_str(&cell(row, 6)),
                    info: v_str(&cell(row, 7)),
                    trx_age: v_i64(&cell(row, 8)),
                    rows_locked: v_i64(&cell(row, 9)),
                    trx_state: v_str(&cell(row, 10)),
                    blocking: Vec::new(),
                    blocked_by: Vec::new(),
                    is_self: id == self_id,
                }
            }).collect();

            // Lock-wait graph — but only when a wait is POSSIBLE. Both `sys`
            // views are expensive (they join + format performance_schema data),
            // and polling them every second on a healthy server buys nothing:
            //   • an InnoDB row wait needs at least two open transactions;
            //   • an MDL wait always shows up as a "…metadata lock" thread state.
            // On an idle server this skips both queries entirely.
            let open_trx = out.iter().filter(|p| p.trx_age >= 0).count();
            let mdl_waiting = out.iter()
                .any(|p| p.state.to_ascii_lowercase().contains("metadata lock"));
            let mut pairs: Vec<(u64, u64)> = Vec::new();
            if open_trx >= 2 {
                if let Ok(r) = mysql::execute(&mut *conn, MY_ROW_WAITS_SQL).await {
                    pairs.extend(wait_pairs(&r));
                }
            }
            if mdl_waiting {
                if let Ok(r) = mysql::execute(&mut *conn, MY_MDL_WAITS_SQL).await {
                    pairs.extend(wait_pairs(&r));
                }
            }

            apply_wait_graph(&mut out, &pairs);
            Ok(out)
        }

        LiveSession::Postgres(pool) => {
            let r = postgres::execute(pool, PG_PROCS_SQL).await?;
            let mut pairs: Vec<(u64, u64)> = Vec::new();
            let mut out: Vec<ProcInfo> = r.rows.iter().map(|row| {
                let id = v_u64(&cell(row, 0));
                let backend_type = v_str(&cell(row, 10));
                for b in v_str(&cell(row, 11)).split(',').filter(|s| !s.trim().is_empty()) {
                    if let Ok(bid) = b.trim().parse::<u64>() {
                        if bid != id { pairs.push((id, bid)); }
                    }
                }
                let is_self = matches!(cell(row, 12), serde_json::Value::Bool(true))
                    || v_str(&cell(row, 12)) == "true";
                ProcInfo {
                    id,
                    user: v_str(&cell(row, 1)),
                    host: v_str(&cell(row, 2)),
                    db: v_str(&cell(row, 3)),
                    command: v_str(&cell(row, 4)),
                    time: v_i64(&cell(row, 5)),
                    state: v_str(&cell(row, 6)),
                    info: v_str(&cell(row, 7)),
                    trx_age: v_i64(&cell(row, 8)),
                    rows_locked: v_i64(&cell(row, 9)),
                    trx_state: backend_type.clone(),
                    blocking: Vec::new(),
                    blocked_by: Vec::new(),
                    is_self,
                    is_system: pg_is_system(&backend_type),
                }
            }).collect();
            apply_wait_graph(&mut out, &pairs);
            Ok(out)
        }

        LiveSession::Redis(mgr, _) => {
            // CLIENT LIST is the Redis processlist. redis_shape has already
            // turned its `k=v k=v` text into named columns, so the fields are
            // looked up by NAME — Redis adds fields between versions and
            // positional indexing would silently shift.
            let r = redis::execute(mgr.clone(), "CLIENT LIST")
                .await?;
            let idx = |name: &str| r.columns.iter().position(|c| c.name == name);
            let get = |row: &[serde_json::Value], name: &str| -> String {
                idx(name).map(|i| v_str(&cell(row, i))).unwrap_or_default()
            };

            let self_id: u64 = {
                let mut m = mgr.clone();
                ::redis::cmd("CLIENT").arg("ID").query_async::<i64>(&mut m).await
                    .map(|v| v.max(0) as u64).unwrap_or(0)
            };

            let mut out: Vec<ProcInfo> = r.rows.iter().map(|row| {
                let id = idx("id").map(|i| v_u64(&cell(row, i))).unwrap_or(0);
                let cmd = get(row, "cmd");
                ProcInfo {
                    id,
                    user: get(row, "user"),
                    host: get(row, "addr"),
                    db:   get(row, "db"),
                    // `cmd` is the command the client last ran, which is the
                    // closest analogue of MySQL's COMMAND column.
                    command: cmd.clone(),
                    // Redis reports both total age and idle time; idle is what
                    // identifies a stuck client, matching "time in this state".
                    time: idx("idle").map(|i| v_i64(&cell(row, i))).unwrap_or(0),
                    state: get(row, "flags"),
                    info: cmd,
                    // Redis has no transactions in the SQL sense. MULTI depth
                    // is the nearest thing: -1 means no MULTI is open.
                    trx_age: idx("multi").map(|i| v_i64(&cell(row, i))).unwrap_or(-1),
                    rows_locked: 0,
                    trx_state: get(row, "resp"),
                    blocking: Vec::new(),
                    blocked_by: Vec::new(),
                    is_self: id != 0 && id == self_id,
                    // Replica links and AOF/RDB children are not client work.
                    is_system: get(row, "flags").contains('S') || get(row, "flags").contains('M'),
                }
            }).collect();
            // Longest-idle first, same ordering contract as the SQL engines.
            out.sort_by_key(|p| std::cmp::Reverse(p.time));
            Ok(out)
        }
        // MongoDB: db.currentOp() is the operation list. Shaped by
        // db/mongodb.rs into named columns — looked up BY NAME here, the same
        // reason as the Redis arm: fields drift between server versions.
        LiveSession::MongoDb(client) => {
            let r = crate::db::mongodb::current_ops(client).await?;
            let idx = |name: &str| r.columns.iter().position(|c| c.name == name);
            let get = |row: &[serde_json::Value], name: &str| -> String {
                idx(name).map(|i| v_str(&cell(row, i))).unwrap_or_default()
            };
            let own: std::collections::HashSet<u64> =
                crate::db::mongodb::own_opids(client).await.into_iter().collect();

            let mut out: Vec<ProcInfo> = Vec::new();
            for row in &r.rows {
                // opid is "shard:opid" via mongos — not addressable by the
                // u64 kill path, so sharded entries are listed by the
                // processes panel but not offered for kill.
                let id = idx("opid").map(|i| v_u64(&cell(row, i))).unwrap_or(0);
                if id == 0 { continue; }
                let op = get(row, "op");
                let ns = get(row, "ns");
                let db = ns.split('.').next().unwrap_or("").to_string();
                out.push(ProcInfo {
                    id,
                    user: String::new(),
                    host: get(row, "client"),
                    db,
                    command: op.clone(),
                    time: idx("secs_running").map(|i| v_i64(&cell(row, i))).unwrap_or(0),
                    state: get(row, "active"),
                    info: get(row, "desc"),
                    trx_age: -1,          // no transaction concept in v1
                    rows_locked: 0,
                    trx_state: String::new(),
                    blocking: Vec::new(), blocked_by: Vec::new(),
                    is_self: own.contains(&id),
                    // Internal ops have no client address.
                    is_system: get(row, "client").is_empty(),
                });
            }
            out.sort_by_key(|p| std::cmp::Reverse(p.time));
            Ok(out)
        }
        // SQL Server: the shared DMV query (ops::MSSQL_PROCESSES_SQL), shaped
        // by position — the column list is ours, fixed, so it cannot drift.
        // The blocking graph comes free: every waiting request names its
        // blocker in blocking_session_id.
        LiveSession::SqlServer(s) => {
            let self_id: u64 = crate::db::sqlserver::execute(s, "SELECT @@SPID")
                .await.ok()
                .and_then(|r| r.rows.first().and_then(|row| row.first()).map(v_u64))
                .unwrap_or(0);
            let r = crate::db::sqlserver::execute(s, crate::commands::ops::MSSQL_PROCESSES_SQL)
                .await?;
            let mut pairs: Vec<(u64, u64)> = Vec::new();
            let mut out: Vec<ProcInfo> = r.rows.iter().map(|row| {
                let id = v_u64(&cell(row, 0));
                let command = v_str(&cell(row, 6));
                let wait_type = v_str(&cell(row, 7));
                let blocker = v_u64(&cell(row, 9));
                if blocker != 0 && blocker != id { pairs.push((id, blocker)); }
                let status = v_str(&cell(row, 5));
                ProcInfo {
                    id,
                    user: v_str(&cell(row, 1)),
                    host: v_str(&cell(row, 2)),
                    db: v_str(&cell(row, 4)),
                    // A session with no running request has no command — its
                    // status is the honest label (sleeping / dormant).
                    command: if command.is_empty() { status.clone() } else { command },
                    time: v_i64(&cell(row, 10)),
                    state: if wait_type.is_empty() { status.clone() } else { wait_type },
                    info: v_str(&cell(row, 11)),
                    // No cheap per-session transaction age in the shared query;
                    // -1 is the honest "no open transaction known".
                    trx_age: -1,
                    rows_locked: 0,
                    trx_state: status,
                    blocking: Vec::new(),
                    blocked_by: Vec::new(),
                    is_self: id != 0 && id == self_id,
                    // is_user_process = 1 is filtered in SQL — these are all
                    // client sessions.
                    is_system: false,
                }
            }).collect();
            apply_wait_graph(&mut out, &pairs);
            Ok(out)
        }
        // ClickHouse identifies a running query by a STRING query_id, not a
        // numeric thread id, so it does not fit ProcInfo's u64 id. The
        // processes panel shows system.processes instead (see ops.rs).
        LiveSession::Clickhouse(_) => Err(
            "ClickHouse queries are identified by query_id (a string), not a numeric thread              id — use the processes panel, then KILL QUERY WHERE query_id = '…'".into()),
        // Nothing to enumerate: these run inside this process.
        LiveSession::Sqlite(_) | LiveSession::Parquet(_) | LiveSession::Duckdb(_) => Ok(Vec::new()),
    }
}

/// Fill `blocking` / `blocked_by` from (waiting, blocking) pairs.
fn apply_wait_graph(procs: &mut [ProcInfo], pairs: &[(u64, u64)]) {
    let mut blocked_by: HashMap<u64, Vec<u64>> = HashMap::new();
    let mut blocking: HashMap<u64, Vec<u64>> = HashMap::new();
    for (w, b) in pairs {
        let bb = blocked_by.entry(*w).or_default();
        if !bb.contains(b) { bb.push(*b); }
        let bl = blocking.entry(*b).or_default();
        if !bl.contains(w) { bl.push(*w); }
    }
    for p in procs.iter_mut() {
        if let Some(v) = blocked_by.remove(&p.id) { p.blocked_by = v; }
        if let Some(v) = blocking.remove(&p.id) { p.blocking = v; }
    }
}

/// Kill a batch of backends. `mode` = "query" (abort the statement, keep the
/// connection: KILL QUERY / pg_cancel_backend) or "connection" (drop it:
/// KILL / pg_terminate_backend). Never kills the connection doing the killing.
#[tauri::command]
pub async fn kill_processes(
    session_id: Uuid,
    ids: Vec<u64>,
    mode: String,
    state: State<'_, AppState>,
) -> Result<Vec<KillOutcome>, crate::apperror::AppError> {
    let terminate = mode != "query";
    // Killing a backend is a destructive server-side action, so a read-only
    // connection refuses it — "read-only" has to mean the session cannot
    // change server state, not merely that it cannot write rows.
    if state.is_read_only(&session_id).await {
        return Err("Connection is read-only — killing sessions is blocked.".into());
    }
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    let mut out = Vec::with_capacity(ids.len());

    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            // One connection for the whole batch, so `self_id` is accurate.
            let mut conn = pool.acquire().await?;
            let self_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
                .fetch_one(&mut *conn).await?;
            for id in ids {
                let stmt = if terminate { format!("KILL {}", id) } else { format!("KILL QUERY {}", id) };
                if id == self_id {
                    out.push(KillOutcome { id, ok: false, statement: stmt,
                        error: Some("refused: that is TxUI's own connection".into()) });
                    continue;
                }
                match sqlx::query(AssertSqlSafe(stmt.clone())).execute(&mut *conn).await {
                    Ok(_)  => out.push(KillOutcome { id, ok: true,  error: None, statement: stmt }),
                    Err(e) => out.push(KillOutcome { id, ok: false, error: Some(e.to_string()), statement: stmt }),
                }
            }
        }
        LiveSession::Postgres(pool) => {
            let mut conn = pool.acquire().await?;
            let self_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                .fetch_one(&mut *conn).await?;
            let func = if terminate { "pg_terminate_backend" } else { "pg_cancel_backend" };
            for id in ids {
                let stmt = format!("SELECT {}({})", func, id);
                if id == self_pid as u64 {
                    out.push(KillOutcome { id, ok: false, statement: stmt,
                        error: Some("refused: that is TxUI's own backend".into()) });
                    continue;
                }
                match sqlx::query(AssertSqlSafe(format!("SELECT {}($1)", func)))
                    .bind(id as i32).execute(&mut *conn).await
                {
                    Ok(_)  => out.push(KillOutcome { id, ok: true,  error: None, statement: stmt }),
                    Err(e) => out.push(KillOutcome { id, ok: false, error: Some(e.to_string()), statement: stmt }),
                }
            }
        }
        LiveSession::Redis(mgr, _) => {
            // CLIENT KILL ID <id> disconnects a client. Redis has no
            // "cancel the running command" equivalent of KILL QUERY — a
            // command is atomic — so both modes terminate the connection and
            // the caller is told so rather than being silently downgraded.
            let mut m = mgr.clone();
            let self_id: i64 = ::redis::cmd("CLIENT").arg("ID")
                .query_async(&mut m).await.unwrap_or(-1);
            for id in ids {
                let stmt = format!("CLIENT KILL ID {}", id);
                if self_id >= 0 && id == self_id as u64 {
                    out.push(KillOutcome { id, ok: false, statement: stmt,
                        error: Some("refused: that is TxUI's own connection".into()) });
                    continue;
                }
                let killed: Result<i64, _> = ::redis::cmd("CLIENT")
                    .arg("KILL").arg("ID").arg(id)
                    .query_async(&mut m).await;
                match killed {
                    Ok(1) => out.push(KillOutcome { id, ok: true, error: None, statement: stmt }),
                    Ok(_) => out.push(KillOutcome { id, ok: false, statement: stmt,
                        error: Some("no client with that id (already gone?)".into()) }),
                    Err(e) => out.push(KillOutcome { id, ok: false,
                        error: Some(e.to_string()), statement: stmt }),
                }
            }
            let _ = terminate; // Redis cannot cancel a command, only the client
        }
        LiveSession::MongoDb(client) => {
            // killOp is request semantics: it answers ok even for a dead
            // opid, so "sent", never "killed". `terminate` vs query mode has
            // no Mongo distinction — killOp aborts the operation; the client
            // connection survives.
            let own: std::collections::HashSet<u64> =
                crate::db::mongodb::own_opids(client).await.into_iter().collect();
            for id in ids {
                let stmt = format!("db.killOp({})", id);
                if own.contains(&id) {
                    out.push(KillOutcome { id, ok: false, statement: stmt,
                        error: Some("refused: that is TxUI's own operation".into()) });
                    continue;
                }
                match crate::db::mongodb::kill_op(client, id).await {
                    Ok(_)  => out.push(KillOutcome { id, ok: true, error: None, statement: stmt }),
                    Err(e) => out.push(KillOutcome { id, ok: false,
                        error: Some(e.to_string()), statement: stmt }),
                }
            }
            let _ = terminate;
        }
        LiveSession::SqlServer(s) => {
            // T-SQL has exactly one KILL form — `KILL <session_id>` ends the
            // session (there is no KILL QUERY split), so both modes do the
            // same thing, like Redis. Audit logging rides the same caller path
            // as every other engine's kill.
            let self_id: u64 = crate::db::sqlserver::execute(s, "SELECT @@SPID")
                .await.ok()
                .and_then(|r| r.rows.first().and_then(|row| row.first()).map(v_u64))
                .unwrap_or(0);
            for id in ids {
                let stmt = format!("KILL {}", id);
                if self_id != 0 && id == self_id {
                    out.push(KillOutcome { id, ok: false, statement: stmt,
                        error: Some("refused: that is TxUI's own session".into()) });
                    continue;
                }
                match crate::db::sqlserver::execute(s, &stmt).await {
                    Ok(_)  => out.push(KillOutcome { id, ok: true,  error: None, statement: stmt }),
                    Err(e) => out.push(KillOutcome { id, ok: false,
                        error: Some(e.to_string()), statement: stmt }),
                }
            }
            let _ = terminate;
        }
        LiveSession::Clickhouse(_) => return Err(
            "ClickHouse kills are addressed by query_id — run              KILL QUERY WHERE query_id = '…' from the editor".into()),
        LiveSession::Sqlite(_) | LiveSession::Parquet(_) | LiveSession::Duckdb(_) => return Err(
            "a file-backed engine has no server-side sessions to kill".into()),
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: u64) -> ProcInfo {
        ProcInfo {
            id, user: "u".into(), host: "h".into(), db: "d".into(), command: "Query".into(),
            time: 1, state: String::new(), info: String::new(), trx_age: -1, rows_locked: 0,
            trx_state: String::new(), blocking: vec![], blocked_by: vec![],
            is_self: false, is_system: false,
        }
    }

    #[test]
    fn wait_graph_is_symmetric() {
        let mut procs = vec![p(1), p(2), p(3)];
        // 2 and 3 both wait on 1
        apply_wait_graph(&mut procs, &[(2, 1), (3, 1), (2, 1)]);
        assert_eq!(procs[0].blocking, vec![2, 3]);   // deduped
        assert!(procs[0].blocked_by.is_empty());
        assert_eq!(procs[1].blocked_by, vec![1]);
        assert_eq!(procs[2].blocked_by, vec![1]);
    }

    #[test]
    fn self_waits_are_dropped() {
        let r = QueryResult {
            columns: vec![], rows: vec![
                vec![serde_json::json!(7), serde_json::json!(7)],   // self-wait: bogus
                vec![serde_json::json!(0), serde_json::json!(9)],   // unknown waiter
                vec![serde_json::json!("11"), serde_json::json!("12")], // stringly typed
            ],
            rows_affected: None, execution_ms: 0, fetch_ms: 0, warnings: vec![],
            truncated: false,
        };
        assert_eq!(wait_pairs(&r), vec![(11, 12)]);
    }

    #[test]
    fn system_threads_are_flagged() {
        assert!(my_is_system("event_scheduler", "Daemon"));
        assert!(my_is_system("repl", "Binlog Dump GTID"));
        assert!(!my_is_system("app_rw", "Query"));
        assert!(pg_is_system("autovacuum worker"));
        assert!(!pg_is_system("client backend"));
        assert!(!pg_is_system(""));
    }
}

#[cfg(test)]
mod procs_sql_tests {
    use super::*;

    // "Ignore Sleep" is the right instinct and the wrong rule. These pin down
    // which sleepers survive it, because the ones that survive are the entire
    // reason somebody opened the kill list on a server with 15 000 threads.

    #[test]
    fn idle_threads_are_dropped_by_default() {
        let sql = my_procs_sql_filtered("performance_schema.processlist", true, ProcFilter::default());
        assert!(sql.contains("p.COMMAND <> 'Sleep'"), "{sql}");
    }

    #[test]
    fn a_sleeper_holding_a_transaction_is_kept() {
        // The classic outage: idle, but still holding its locks and its read
        // view. Filtering it out would hide the one thread worth killing.
        let sql = my_procs_sql_filtered("performance_schema.processlist", true, ProcFilter::default());
        assert!(sql.contains("x.trx_id IS NOT NULL"), "{sql}");
    }

    #[test]
    fn a_long_lived_sleeper_is_kept() {
        // Ten minutes idle is a leaked connection, not an idle one.
        let sql = my_procs_sql_filtered("performance_schema.processlist", true, ProcFilter::default());
        assert!(sql.contains("p.TIME >= 600"), "{sql}");
    }

    #[test]
    fn without_transaction_data_nothing_is_filtered() {
        // No innodb_trx join means no way to tell a harmless sleeper from one
        // holding locks. Keeping everything is the honest failure.
        let sql = my_procs_sql_filtered("performance_schema.processlist", false, ProcFilter::default());
        assert!(!sql.contains("COMMAND <> 'Sleep'"), "{sql}");
    }

    #[test]
    fn asking_for_idle_threads_removes_the_predicate() {
        let sql = my_procs_sql_filtered(
            "performance_schema.processlist", true,
            ProcFilter { include_idle: true, ..Default::default() });
        assert!(!sql.contains("COMMAND <> 'Sleep'"), "{sql}");
    }

    #[test]
    fn the_cap_is_applied_server_side_after_the_ordering() {
        // A LIMIT before the ORDER BY would return an arbitrary 500 threads
        // rather than the 500 that matter.
        let sql = my_procs_sql_filtered("performance_schema.processlist", true, ProcFilter::default());
        let order = sql.find("ORDER BY").expect("ordered");
        let limit = sql.find("LIMIT ").expect("capped");
        assert!(order < limit, "LIMIT must follow ORDER BY:\n{sql}");
        assert!(sql.ends_with(&format!("LIMIT {}", PROCS_LIMIT)), "{sql}");
    }

    #[test]
    fn the_filter_sits_before_the_ordering() {
        // A WHERE after ORDER BY is a syntax error; cheap to get wrong when
        // the query is assembled from fragments.
        let sql = my_procs_sql_filtered("performance_schema.processlist", true, ProcFilter::default());
        assert!(sql.find(" WHERE ").unwrap() < sql.find("ORDER BY").unwrap(), "{sql}");
    }

    #[test]
    fn the_join_precedes_the_where_that_references_it() {
        let sql = my_procs_sql_filtered("performance_schema.processlist", true, ProcFilter::default());
        assert!(sql.find("LEFT JOIN").unwrap() < sql.find(" WHERE ").unwrap(), "{sql}");
    }

    #[test]
    fn the_default_prefers_the_mutex_free_source() {
        // information_schema.PROCESSLIST walks the thread list holding the
        // global mutex; on a 15 000-thread server that stalls new connections.
        assert_eq!(MY_PROCS_SOURCES[0], "performance_schema.processlist");
    }
}
