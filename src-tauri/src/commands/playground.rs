//! Playground — scenario generator. First scenario: **spawn mess**.
//!
//! It manufactures a realistic incident on the target server so the DBA tools
//! (⚡ Processes, 🔒 Locks, and the `kill …` / `killall` editor popup) have
//! something real to look at: N concurrent workers on their own connections,
//! each running a recognizable statement, optionally piling up on one row so a
//! genuine blocking chain forms.
//!
//! Every worker gets a real server thread, so the run needs its own pool (the
//! session pool holds 4). The pool is dropped — and any survivor thread KILLed
//! — when the run ends or is stopped.
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::db::types::{ConnectionConfig, Engine};
use crate::state::AppState;

/// Table the lock scenarios contend on. Created on demand, never dropped
/// (2 rows; recreating it every run would itself need DDL locks).
const PG_TABLE: &str = "txui_playground";
const MY_TABLE: &str = "txui_playground";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessSpec {
    /// "sleep" — N identical long statements (a rogue family)
    /// "lock"  — 1 holder + N waiters queued on one row (blocking chain)
    /// "mixed" — a rogue family + benign churn + a blocking chain
    pub scenario: String,
    /// Workers to spawn (server threads held simultaneously)
    pub threads: u32,
    /// Seconds each statement runs
    pub duration_secs: f64,
    /// Delay between launches — 0 = all at once, >0 = staggered ages
    pub stagger_ms: u64,
    /// Statements per worker (>1 = churn: threads come and go)
    pub repeats: u32,
    /// ± % randomization of duration, so the family's ages differ
    pub jitter_pct: u32,
    /// Database (MySQL) / schema (PG) for the lock table — lock scenarios only
    pub database: Option<String>,
    /// How long the blocker holds the row lock
    pub hold_secs: f64,
    /// Baked into the statement comment: makes the family recognizable
    pub tag: Option<String>,
}

/// Clamped, engine-independent view of a spec. Clamping happens once, here,
/// so no scenario can ask the server for something absurd.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub scenario: Scenario,
    pub threads: u32,
    pub duration: f64,
    pub stagger_ms: u64,
    pub repeats: u32,
    pub jitter_pct: u32,
    pub hold: f64,
    pub tag: String,
    pub database: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario { Sleep, Lock, Mixed }

/// Smallest thread count a scenario can express: a chain needs a holder AND a
/// waiter; "mixed" needs a rogue family, some churn and a chain.
pub fn min_threads(scenario: Scenario) -> u32 {
    match scenario {
        Scenario::Sleep => 1,
        Scenario::Lock  => 2,
        Scenario::Mixed => 4,
    }
}

/// Hard ceilings: 64 threads / 10 min per statement / 200 statements each.
/// `threads` is the EXACT number of workers the run will spawn — it is clamped
/// up to the scenario's minimum here, once, so `build_workers` never quietly
/// spawns more than the number the UI showed you.
pub fn plan_from(spec: &MessSpec) -> Plan {
    let scenario = match spec.scenario.as_str() {
        "lock"  => Scenario::Lock,
        "mixed" => Scenario::Mixed,
        _       => Scenario::Sleep,
    };
    let tag = {
        let raw = spec.tag.clone().unwrap_or_else(|| "mess".into());
        let cleaned: String = raw.chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == ' ')
            .take(32).collect();
        let t = cleaned.trim().to_string();
        if t.is_empty() { "mess".to_string() } else { t }
    };
    Plan {
        scenario,
        threads:    spec.threads.clamp(min_threads(scenario), 64),
        duration:   spec.duration_secs.clamp(0.1, 600.0),
        stagger_ms: spec.stagger_ms.min(60_000),
        repeats:    spec.repeats.clamp(1, 200),
        jitter_pct: spec.jitter_pct.min(100),
        hold:       spec.hold_secs.clamp(0.1, 600.0),
        tag,
        database:   spec.database.clone().filter(|d| !d.trim().is_empty()),
    }
}

/// Deterministic per-slot jitter — no rand dependency, and the same slot always
/// gets the same offset, so a run is reproducible.
pub fn jittered(duration: f64, jitter_pct: u32, slot: u32) -> f64 {
    if jitter_pct == 0 { return duration; }
    // slot → a fixed pseudo-random factor in [-1, 1]
    let h = (slot as u64).wrapping_mul(2_654_435_761) % 2_000;
    let f = (h as f64 / 1_000.0) - 1.0;
    let d = duration * (1.0 + f * (jitter_pct as f64 / 100.0));
    d.clamp(0.1, 600.0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MessEvent {
    /// A worker got its server thread and started its statement
    Spawned { slot: u32, thread_id: u64, role: String, sql: String },
    /// That worker's statement finished (or failed / was killed)
    Ended { slot: u32, thread_id: u64, ms: u64, ok: bool, error: Option<String> },
    Log { level: String, msg: String },
    Done { spawned: u32, ms: u64, cancelled: bool },
}

/// One worker's script: the statements it runs, in order, on ONE connection.
#[derive(Debug, Clone, PartialEq)]
pub struct Worker {
    pub slot: u32,
    pub role: String,
    pub statements: Vec<String>,
}

fn comment(tag: &str, role: &str, slot: u32) -> String {
    format!("/* txui-playground {} {} slot={} */", tag, role, slot)
}

/// The rogue family's statement — identical text for every member of a family
/// (apart from the slot marker), which is exactly what makes `killall` able to
/// recognize them as one family.
fn sleep_stmt(engine: Engine, tag: &str, role: &str, slot: u32, secs: f64) -> String {
    let c = comment(tag, role, slot);
    match engine {
        Engine::Postgres => format!("SELECT {} pg_sleep({:.2})", c, secs),
        // T-SQL has no sleep FUNCTION — `WAITFOR DELAY` is a statement, and its
        // argument is a time STRING, not a number of seconds. The comment
        // cannot ride inside a SELECT list here because there is no SELECT, so
        // it leads the statement; `sys.dm_exec_sql_text` returns the batch
        // verbatim either way, which is what `killall` matches on.
        Engine::SqlServer => format!("{} WAITFOR DELAY '{}'", c, hhmmss(secs)),
        _                => format!("SELECT {} SLEEP({:.2})", c, secs),
    }
}

/// Seconds as the `hh:mm:ss.mmm` string `WAITFOR DELAY` takes.
///
/// Clamped to just under 24 hours: `WAITFOR` rejects anything longer, and the
/// playground's own duration cap is far below it — but the clamp is here rather
/// than assumed, because a silently rejected worker is one that never appears
/// in the processlist the user is watching.
pub fn hhmmss(secs: f64) -> String {
    let ms_total = (secs.max(0.0) * 1000.0).round().min(86_399_999.0) as u64;
    format!("{:02}:{:02}:{:02}.{:03}",
            ms_total / 3_600_000, (ms_total / 60_000) % 60,
            (ms_total / 1000) % 60, ms_total % 1000)
}

fn qualified(engine: Engine, db: Option<&str>) -> String {
    let table = if engine == Engine::Postgres { PG_TABLE } else { MY_TABLE };
    match (engine, db) {
        (Engine::Postgres, Some(d)) => format!("\"{}\".\"{}\"", d.replace('"', "\"\""), table),
        (Engine::Postgres, None)    => format!("\"{}\"", table),
        // `db` is a SCHEMA on SQL Server, not a database: the session is
        // already connected to one and the driver never issues USE, so
        // qualifying with a database name would point at a table that is not
        // there.
        (Engine::SqlServer, Some(d)) => format!("[{}].[{}]", d.replace(']', "]]"), table),
        (Engine::SqlServer, None)    => format!("[dbo].[{}]", table),
        (_, Some(d))                => format!("`{}`.`{}`", d.replace('`', "``"), table),
        (_, None)                   => format!("`{}`", table),
    }
}

/// DDL that makes the lock scenario possible. Runs once, on the control
/// connection, before any worker starts. MySQL creates the database too;
/// PG expects the schema to exist (or uses the default search_path).
pub fn lock_setup(engine: Engine, db: Option<&str>) -> Vec<String> {
    let t = qualified(engine, db);
    match engine {
        // T-SQL has no `CREATE TABLE IF NOT EXISTS` and no `INSERT IGNORE`;
        // both are expressed as an existence test around the statement.
        Engine::SqlServer => vec![
            format!("IF OBJECT_ID('{}') IS NULL CREATE TABLE {} \
                     (id int PRIMARY KEY, n bigint NOT NULL DEFAULT 0)",
                    t.replace('[', "").replace(']', "").replace('\'', "''"), t),
            format!("IF NOT EXISTS (SELECT 1 FROM {} WHERE id = 1) \
                     INSERT INTO {} (id, n) VALUES (1, 0)", t, t),
        ],
        Engine::Postgres => {
            let mut v = Vec::new();
            if let Some(d) = db {
                v.push(format!("CREATE SCHEMA IF NOT EXISTS \"{}\"", d.replace('"', "\"\"")));
            }
            v.push(format!(
                "CREATE TABLE IF NOT EXISTS {} (id int PRIMARY KEY, n bigint NOT NULL DEFAULT 0)", t));
            v.push(format!("INSERT INTO {} (id, n) VALUES (1, 0) ON CONFLICT (id) DO NOTHING", t));
            v
        }
        _ => {
            let mut v = Vec::new();
            if let Some(d) = db {
                v.push(format!("CREATE DATABASE IF NOT EXISTS `{}`", d.replace('`', "``")));
            }
            v.push(format!(
                "CREATE TABLE IF NOT EXISTS {} (id int PRIMARY KEY, n bigint NOT NULL DEFAULT 0) ENGINE=InnoDB", t));
            v.push(format!("INSERT IGNORE INTO {} (id, n) VALUES (1, 0)", t));
            v
        }
    }
}

/// The holder: opens a transaction, locks row 1, then sits on it.
fn lock_holder(engine: Engine, tag: &str, slot: u32, db: Option<&str>, hold: f64) -> Worker {
    let t = qualified(engine, db);
    let c = comment(tag, "holder", slot);
    let statements = match engine {
        Engine::Postgres => vec![
            "BEGIN".to_string(),
            format!("SELECT {} n FROM {} WHERE id = 1 FOR UPDATE", c, t),
            format!("SELECT {} pg_sleep({:.2})", c, hold),
            "COMMIT".to_string(),
        ],
        // `FOR UPDATE` is not T-SQL. The equivalent is a table hint:
        // UPDLOCK takes the update lock, HOLDLOCK keeps it until the
        // transaction ends rather than releasing it at statement end — without
        // the second one the "holder" releases immediately and no chain forms.
        //
        // `BEGIN` alone opens a statement block in T-SQL, not a transaction.
        Engine::SqlServer => vec![
            "BEGIN TRANSACTION".to_string(),
            format!("SELECT {} n FROM {} WITH (UPDLOCK, HOLDLOCK) WHERE id = 1", c, t),
            format!("{} WAITFOR DELAY '{}'", c, hhmmss(hold)),
            "COMMIT".to_string(),
        ],
        _ => vec![
            // A waiter must not die of innodb_lock_wait_timeout (default 50s)
            // before the user gets to look at the chain.
            "SET SESSION innodb_lock_wait_timeout = 600".to_string(),
            "BEGIN".to_string(),
            format!("SELECT {} n FROM {} WHERE id = 1 FOR UPDATE", c, t),
            format!("SELECT {} SLEEP({:.2})", c, hold),
            "COMMIT".to_string(),
        ],
    };
    Worker { slot, role: "holder".into(), statements }
}

/// A waiter: tries to update the locked row and blocks until the holder commits.
fn lock_waiter(engine: Engine, tag: &str, slot: u32, db: Option<&str>) -> Worker {
    let t = qualified(engine, db);
    let c = comment(tag, "waiter", slot);
    let statements = match engine {
        Engine::Postgres => vec![
            "SET lock_timeout = 0".to_string(),
            format!("UPDATE {} SET n = n + 1 {} WHERE id = 1", t, c),
        ],
        // SQL Server's default LOCK_TIMEOUT is already -1 (wait forever), but
        // it is set explicitly so a session that inherited a timeout from
        // somewhere else still queues rather than erroring out of the chain the
        // user is trying to look at.
        Engine::SqlServer => vec![
            "SET LOCK_TIMEOUT -1".to_string(),
            format!("UPDATE {} SET n = n + 1 {} WHERE id = 1", t, c),
        ],
        _ => vec![
            "SET SESSION innodb_lock_wait_timeout = 600".to_string(),
            format!("UPDATE {} SET n = n + 1 {} WHERE id = 1", t, c),
        ],
    };
    Worker { slot, role: "waiter".into(), statements }
}

/// Turn a plan into the exact worker scripts. Pure — unit-tested below, and
/// the UI shows the same statements before you press Spawn.
pub fn build_workers(plan: &Plan, engine: Engine) -> Vec<Worker> {
    let db = plan.database.as_deref();
    let tag = plan.tag.as_str();
    match plan.scenario {
        Scenario::Sleep => (0..plan.threads).map(|slot| {
            let secs = jittered(plan.duration, plan.jitter_pct, slot);
            Worker {
                slot,
                role: "rogue".into(),
                statements: (0..plan.repeats)
                    .map(|_| sleep_stmt(engine, tag, "rogue", slot, secs))
                    .collect(),
            }
        }).collect(),

        Scenario::Lock => {
            // exactly `threads`: one holder, the rest queued behind it
            let mut v = vec![lock_holder(engine, tag, 0, db, plan.hold)];
            v.extend((1..plan.threads).map(|slot| lock_waiter(engine, tag, slot, db)));
            v
        }

        Scenario::Mixed => {
            // 3 families the analyzer must tell apart:
            //   rogue  — same statement, long, growing  → the ones to kill
            //   churn  — short, repeated, different text → benign, leave alone
            //   holder/waiters — a real blocking chain   → kill the blocker
            // The split always sums to EXACTLY `plan.threads`.
            let n = plan.threads;
            let chain = if db.is_some() { (n / 4).max(2) } else { 0 };
            let rest = n - chain;
            let rogue = (rest * 2).div_ceil(3);          // ~2/3 of what is left
            let churn = rest - rogue;
            let mut v: Vec<Worker> = Vec::new();
            for slot in 0..rogue {
                let secs = jittered(plan.duration, plan.jitter_pct.max(20), slot);
                v.push(Worker { slot, role: "rogue".into(), statements: vec![sleep_stmt(engine, tag, "rogue", slot, secs)] });
            }
            for i in 0..churn {
                let slot = rogue + i;
                let secs = (plan.duration / 8.0).clamp(0.1, 5.0);
                v.push(Worker {
                    slot, role: "churn".into(),
                    statements: (0..plan.repeats.max(4))
                        .map(|_| sleep_stmt(engine, tag, "churn", slot, secs))
                        .collect(),
                });
            }
            if chain > 0 {
                let base = rogue + churn;
                v.push(lock_holder(engine, tag, base, db, plan.hold));
                for i in 1..chain {
                    v.push(lock_waiter(engine, tag, base + i, db));
                }
            }
            debug_assert_eq!(v.len() as u32, n, "mixed must spawn exactly `threads` workers");
            v
        }
    }
}

// ── connection headroom ───────────────────────────────────────────────────────

/// Connections a run must leave free for everyone else (including TxUI itself).
const HEADROOM: u64 = 5;

/// Would this run exhaust the server's connection limit? Pure, so the rule is
/// testable; `max`/`used` come from the server (best-effort — an unknown limit
/// never blocks the feature).
pub fn headroom_check(max: u64, used: u64, needed: u64) -> Result<(), crate::apperror::AppError> {
    let free = max.saturating_sub(used);
    if needed + HEADROOM <= free {
        return Ok(());
    }
    let room = free.saturating_sub(HEADROOM);
    Err(format!(
        "not enough connections on the server: it allows {max} and {used} are in use, \
so this run can use at most {room} — it needs {needed}.{} Free some connections first.",
        if room >= 2 { format!(" Lower the thread count to {}.", room - 1) } else { String::new() }).into())
}

fn v_num(v: &serde_json::Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_i64().map(|n| n.max(0) as u64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .unwrap_or(0)
}

/// (max_connections, connections in use) — best effort, None when unreadable.
async fn my_connection_usage(pool: &sqlx::MySqlPool) -> Option<(u64, u64)> {
    let r = crate::db::mysql::execute(pool,
        "SELECT @@max_connections AS m, \
                (SELECT COUNT(*) FROM information_schema.PROCESSLIST) AS c").await.ok()?;
    let row = r.rows.first()?;
    Some((v_num(row.first()?), v_num(row.get(1)?)))
}

async fn pg_connection_usage(pool: &sqlx::PgPool) -> Option<(u64, u64)> {
    let r = crate::db::postgres::execute(pool,
        "SELECT current_setting('max_connections')::bigint AS m, \
                (SELECT count(*) FROM pg_stat_activity)::bigint AS c").await.ok()?;
    let row = r.rows.first()?;
    Some((v_num(row.first()?), v_num(row.get(1)?)))
}

/// The session's own pool, cloned — for cheap pre-flight questions.
enum PoolRef { My(sqlx::MySqlPool), Pg(sqlx::PgPool) }

async fn session_pool(state: &State<'_, AppState>, session_id: Uuid) -> Option<PoolRef> {
    let session = crate::db::connection::get_session_pub(session_id, &state.sessions).await.ok()?;
    match session.as_ref() {
        crate::db::types::LiveSession::Mysql(p)    => Some(PoolRef::My(p.clone())),
        crate::db::types::LiveSession::Postgres(p) => Some(PoolRef::Pg(p.clone())),
        _ => None,
    }
}

// ── execution ─────────────────────────────────────────────────────────────────

/// Spawn the mess. Streams one event per worker start/finish; returns when all
/// workers are done, the run is stopped, or the caller closes the channel.
#[tauri::command]
pub async fn playground_spawn(
    session_id: Uuid,
    connection_id: Uuid,
    spec: MessSpec,
    run_key: String,
    on_event: Channel<MessEvent>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    let plan = plan_from(&spec);
    let config: ConnectionConfig = state.configs.read().await.get(&connection_id).cloned()
        .ok_or_else(|| format!("connection {} not found", connection_id))?;
    if config.engine == Engine::Redis {
        return Err("the Playground needs MySQL or PostgreSQL".into());
    }
    // Prod border: the playground manufactures load, lock chains and
    // minutes-long sleeping connections — there is no legitimate use for it
    // against a production server, so it refuses outright (same posture as
    // routines::mysql_debug_gate; the destructive-DDL opt-out is explicitly
    // not a sufficient signal here).
    if let Some(g) = state.session_meta.read().await.get(&session_id) {
        if g.environment.as_deref() == Some("prod") {
            return Err(crate::apperror::AppError::guard(
                "the Playground is disabled on prod-tagged connections — it \
                 manufactures load, lock chains and sleeping connections"));
        }
    }
    // Lock scenarios write (a table, a row) — a read-only connection refuses.
    let writes = plan.scenario != Scenario::Sleep;
    if writes && state.is_read_only(&session_id).await {
        return Err("this connection is read-only — the lock scenarios need to create \
                    a playground table and update a row. Use the Sleep scenario, or \
                    a writable connection.".into());
    }

    let workers = build_workers(&plan, config.engine);
    let engine = config.engine;

    // Ask the server whether it can take this many connections, on the session's
    // EXISTING pool — refusing here beats failing halfway through a spawn with a
    // raw "too many connections" from the driver, half the mess already live.
    // An unreadable limit (no privilege) never blocks the run.
    let needed = workers.len() as u64 + 2;      // workers + the control connection
    let usage = match session_pool(&state, session_id).await {
        Some(PoolRef::My(p)) => my_connection_usage(&p).await,
        Some(PoolRef::Pg(p)) => pg_connection_usage(&p).await,
        None => None,
    };
    if let Some((max, used)) = usage {
        headroom_check(max, used, needed)?;
    }
    let password = crate::secretstore::get(&state.data_dir, &config.keychain_key());
    // Reuse the session's SSH tunnel if it has one — the playground pool must
    // reach the same server through the same forwarded port.
    let local_port = state.tunnels.read().await.get(&session_id).map(|t| t.local_port);
    let host_override = local_port.map(|p| ("127.0.0.1", p));

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    // Session-prefixed so `cancel_session_work` finds it on close; the stop
    // command resolves the bare key via `take_ext_job`.
    let job_key = crate::state::ext_job_key(session_id, &run_key);
    state.ext_jobs.write().await.insert(job_key.clone(), cancel_tx);

    // +2 connections: the control connection (setup / kills) and headroom.
    let pool_size = workers.len() as u32 + 2;
    let started = std::time::Instant::now();
    let spawned_ids: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));

    let result = match engine {
        // ClickHouse has no connection pool to size and no transactional
        // workload to simulate — the playground models lock/transaction
        // contention, which it does not have.
        Engine::Clickhouse | Engine::Sqlite | Engine::Parquet | Engine::Duckdb
        | Engine::MongoDb =>
            return Err("the playground supports MySQL, PostgreSQL and SQL Server".into()),
        Engine::SqlServer => {
            // No pool: each worker opens its own connection, which is what N
            // distinct server sessions requires.
            run_ms(config.clone(), password, plan.clone(), workers, on_event.clone(),
                   cancel_rx, spawned_ids.clone()).await
        }
        Engine::Mysql => {
            let pool = crate::db::mysql::open_pool(&config, password, host_override, pool_size)
                .await.map_err(|e| format!("playground pool: {:#}", e))?;
            let r = run_my(pool.clone(), plan.clone(), workers, on_event.clone(),
                           cancel_rx, spawned_ids.clone()).await;
            pool.close().await;
            r
        }
        Engine::Postgres => {
            let pool = crate::db::postgres::open_pool(&config, password, host_override, pool_size)
                .await.map_err(|e| format!("playground pool: {:#}", e))?;
            let r = run_pg(pool.clone(), plan.clone(), workers, on_event.clone(),
                           cancel_rx, spawned_ids.clone()).await;
            pool.close().await;
            r
        }
        Engine::Redis => unreachable!(),
    };

    state.ext_jobs.write().await.remove(&job_key);
    let ms = started.elapsed().as_millis() as u64;
    let spawned = spawned_ids.lock().await.len() as u32;
    match result {
        Ok(cancelled) => {
            let _ = on_event.send(MessEvent::Done { spawned, ms, cancelled });
            Ok(())
        }
        Err(e) => {
            let _ = on_event.send(MessEvent::Log { level: "err".into(), msg: e.to_string() });
            let _ = on_event.send(MessEvent::Done { spawned, ms, cancelled: false });
            Err(e)
        }
    }
}

/// Stop a run: cancels the launcher and KILLs whatever it still holds.
#[tauri::command]
pub async fn playground_stop(run_key: String, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    if let Some(tx) = crate::state::take_ext_job(&state.ext_jobs, &run_key).await {
        let _ = tx.send(());
    }
    Ok(())
}

macro_rules! run_engine {
    ($name:ident, $pool_ty:ty, $exec:path, $engine:expr, $conn_id_sql:expr, $kill_fmt:expr) => {
        /// Launch every worker on its own connection, staggered, and wait for
        /// them all. On cancel: KILL every thread we spawned, then return.
        async fn $name(
            pool: $pool_ty,
            plan: Plan,
            workers: Vec<Worker>,
            on_event: Channel<MessEvent>,
            mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
            spawned_ids: Arc<Mutex<Vec<u64>>>,
        ) -> Result<bool, crate::apperror::AppError> {
            // Lock scenarios need their table before any worker runs.
            if plan.scenario != Scenario::Sleep {
                let mut c = pool.acquire().await?;
                for stmt in lock_setup($engine, plan.database.as_deref()) {
                    if let Err(e) = $exec(&mut *c, &stmt).await {
                        return Err(format!("playground setup failed on `{}`: {}", stmt, e).into());
                    }
                }
                let _ = on_event.send(MessEvent::Log { level: "ok".into(),
                    msg: format!("playground table ready ({} workers queueing on row id=1)", workers.len()) });
            }

            let mut set = tokio::task::JoinSet::new();
            let launch = async {
                for w in workers {
                    let pool = pool.clone();
                    let ev = on_event.clone();
                    let ids = spawned_ids.clone();
                    set.spawn(async move {
                        let t0 = std::time::Instant::now();
                        let mut conn = match pool.acquire().await {
                            Ok(c) => c,
                            Err(e) => {
                                let _ = ev.send(MessEvent::Ended { slot: w.slot, thread_id: 0,
                                    ms: t0.elapsed().as_millis() as u64, ok: false,
                                    error: Some(format!("no connection: {}", e)) });
                                return;
                            }
                        };
                        let tid: u64 = sqlx::query_scalar($conn_id_sql)
                            .fetch_one(&mut *conn).await
                            .map(|v: i64| v as u64)
                            .unwrap_or(0);
                        ids.lock().await.push(tid);
                        let visible = w.statements.iter()
                            .find(|s| s.contains("txui-playground"))
                            .cloned().unwrap_or_default();
                        let _ = ev.send(MessEvent::Spawned { slot: w.slot, thread_id: tid,
                            role: w.role.clone(), sql: visible });
                        let mut err: Option<String> = None;
                        for stmt in &w.statements {
                            if let Err(e) = $exec(&mut *conn, stmt).await {
                                err = Some(e.to_string());
                                break;
                            }
                        }
                        let _ = ev.send(MessEvent::Ended { slot: w.slot, thread_id: tid,
                            ms: t0.elapsed().as_millis() as u64, ok: err.is_none(), error: err });
                    });
                    if plan.stagger_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(plan.stagger_ms)).await;
                    }
                }
                while set.join_next().await.is_some() {}
            };

            tokio::select! {
                _ = launch => Ok(false),
                _ = &mut cancel_rx => {
                    // Kill on a separate connection: the workers are asleep
                    // inside their statements and can't be interrupted otherwise.
                    let ids = spawned_ids.lock().await.clone();
                    if let Ok(mut k) = pool.acquire().await {
                        for id in ids.iter().filter(|i| **i != 0) {
                            let _ = $exec(&mut *k, &format!($kill_fmt, id)).await;
                        }
                    }
                    let _ = on_event.send(MessEvent::Log { level: "warn".into(),
                        msg: format!("stopped — killed {} playground thread(s)", ids.len()) });
                    Ok(true)
                }
            }
        }
    };
}

// The thread-id queries CAST to a signed 64-bit int so one macro body decodes
// both engines (MySQL's CONNECTION_ID() is BIGINT UNSIGNED natively).
run_engine!(run_my, sqlx::MySqlPool, crate::db::mysql::execute, Engine::Mysql,
            "SELECT CAST(CONNECTION_ID() AS SIGNED)", "KILL {}");
run_engine!(run_pg, sqlx::PgPool, crate::db::postgres::execute, Engine::Postgres,
            "SELECT pg_backend_pid()::bigint", "SELECT pg_terminate_backend({})");

/// The SQL Server runner.
///
/// Not built from `run_engine!`, because SQL Server has no pool to draw from:
/// a `SqlServerSession` is one pinned connection, so every worker opens its
/// own. That is what the scenario needs anyway — the whole point is N distinct
/// server sessions, and a pool would hand two workers the same one.
///
/// The kill path matters more here than on the other engines. T-SQL has no
/// "cancel the query but keep the session" form: `KILL <spid>` ends the whole
/// session, which is exactly right for a playground worker and is why the
/// control connection is opened separately — a worker sitting inside
/// `WAITFOR DELAY` cannot be interrupted from its own connection.
async fn run_ms(
    config: crate::db::types::ConnectionConfig,
    password: Option<String>,
    plan: Plan,
    workers: Vec<Worker>,
    on_event: Channel<MessEvent>,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
    spawned_ids: Arc<Mutex<Vec<u64>>>,
) -> Result<bool, crate::apperror::AppError> {
    use crate::db::sqlserver;

    let control = sqlserver::open(&config, password.clone()).await
        .map_err(|e| format!("playground control connection: {e:#}"))?;

    if plan.scenario != Scenario::Sleep {
        for stmt in lock_setup(Engine::SqlServer, plan.database.as_deref()) {
            if let Err(e) = sqlserver::execute(&control, &stmt).await {
                return Err(format!("playground setup failed on `{}`: {}", stmt, e).into());
            }
        }
        let _ = on_event.send(MessEvent::Log { level: "ok".into(),
            msg: format!("playground table ready ({} workers queueing on row id=1)", workers.len()) });
    }

    let mut set = tokio::task::JoinSet::new();
    let launch = async {
        for w in workers {
            let cfg = config.clone();
            let pw = password.clone();
            let ev = on_event.clone();
            let ids = spawned_ids.clone();
            set.spawn(async move {
                let t0 = std::time::Instant::now();
                let session = match sqlserver::open(&cfg, pw).await {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ev.send(MessEvent::Ended { slot: w.slot, thread_id: 0,
                            ms: t0.elapsed().as_millis() as u64, ok: false,
                            error: Some(format!("no connection: {e}")) });
                        return;
                    }
                };
                let tid = sqlserver::spid(&session).await.unwrap_or(0);
                ids.lock().await.push(tid);
                let visible = w.statements.iter()
                    .find(|s| s.contains("txui-playground"))
                    .cloned().unwrap_or_default();
                let _ = ev.send(MessEvent::Spawned { slot: w.slot, thread_id: tid,
                    role: w.role.clone(), sql: visible });
                let mut err: Option<String> = None;
                for stmt in &w.statements {
                    if let Err(e) = sqlserver::execute(&session, stmt).await {
                        err = Some(e.to_string());
                        break;
                    }
                }
                let _ = ev.send(MessEvent::Ended { slot: w.slot, thread_id: tid,
                    ms: t0.elapsed().as_millis() as u64, ok: err.is_none(), error: err });
            });
            if plan.stagger_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(plan.stagger_ms)).await;
            }
        }
        while set.join_next().await.is_some() {}
    };

    tokio::select! {
        _ = launch => Ok(false),
        _ = &mut cancel_rx => {
            let ids = spawned_ids.lock().await.clone();
            for id in ids.iter().filter(|i| **i != 0) {
                // KILL takes a bare spid, not a string, and ends the session
                // outright — which is what stops a worker parked in WAITFOR.
                let _ = sqlserver::execute(&control, &format!("KILL {id}")).await;
            }
            let _ = on_event.send(MessEvent::Log { level: "warn".into(),
                msg: format!("stopped — killed {} playground session(s)", ids.len()) });
            Ok(true)
        }
    }
}

/// The playground against a real SQL Server.
///
/// The scenario is only real if the workers actually block each other, and the
/// only way to know is to look at `sys.dm_os_waiting_tasks` while they run.
/// Skipped without an endpoint; see docs/MSSQL_DEV.md.
#[cfg(test)]
mod mssql_playground_live_tests {
    use super::*;
    use crate::db::sqlserver::{self, live_tests::{live_config, live_session}};

    #[test]
    fn a_delay_is_a_time_string_not_a_number() {
        // `WAITFOR DELAY 5` is a syntax error; it takes hh:mm:ss[.mmm].
        assert_eq!(hhmmss(5.0), "00:00:05.000");
        assert_eq!(hhmmss(0.25), "00:00:00.250");
        assert_eq!(hhmmss(3661.5), "01:01:01.500");
        assert_eq!(hhmmss(-1.0), "00:00:00.000");
        // WAITFOR refuses 24 hours or more, so the clamp is just under it.
        assert_eq!(hhmmss(999_999.0), "23:59:59.999");
    }

    #[test]
    fn the_t_sql_worker_scripts_use_no_other_engine_s_syntax() {
        let plan = Plan {
            scenario: Scenario::Lock, threads: 3, duration: 5.0, hold: 5.0,
            repeats: 1, jitter_pct: 0, stagger_ms: 0,
            tag: "t".into(), database: Some("dbo".into()),
        };
        let all = build_workers(&plan, Engine::SqlServer);
        let text = all.iter().flat_map(|w| w.statements.clone()).collect::<Vec<_>>().join("\n");

        // The holder must HOLD: UPDLOCK alone releases at statement end and no
        // chain ever forms, which would make the whole scenario look broken.
        assert!(text.contains("WITH (UPDLOCK, HOLDLOCK)"), "{text}");
        assert!(text.contains("BEGIN TRANSACTION"), "{text}");
        assert!(text.contains("SET LOCK_TIMEOUT -1"), "{text}");
        // None of these are T-SQL.
        assert!(!text.contains("FOR UPDATE"), "{text}");
        assert!(!text.contains("SLEEP("), "{text}");
        assert!(!text.contains("pg_sleep"), "{text}");
        assert!(!text.contains("innodb"), "{text}");
        // `BEGIN` on its own line would be a statement block, not a transaction.
        assert!(!text.lines().any(|l| l.trim() == "BEGIN"), "{text}");
        // Every worker is identifiable, which is what killall matches on.
        for w in &all {
            assert!(w.statements.iter().any(|s| s.contains("txui-playground")), "{w:?}");
        }
    }

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn a_lock_scenario_really_blocks_and_kill_really_stops_it() {
        let Some((config, password)) = live_config() else {
            println!("no endpoint configured — see docs/MSSQL_DEV.md");
            return;
        };
        let Some(watcher) = live_session().await else { return };

        let plan = Plan {
            scenario: Scenario::Lock, threads: 3, duration: 30.0, hold: 30.0,
            repeats: 1, jitter_pct: 0, stagger_ms: 50,
            tag: "livetest".into(), database: Some("dbo".into()),
        };
        let workers = build_workers(&plan, Engine::SqlServer);
        assert_eq!(workers.len(), 3);

        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let ids: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        // The events go nowhere: this test watches the SERVER, which is the
        // only place the scenario is real.
        let ch: Channel<MessEvent> = Channel::new(|_| Ok(()));

        let ids2 = ids.clone();
        let cfg2 = config.clone();
        let pw2 = password.clone();
        let run = tokio::spawn(async move {
            run_ms(cfg2, pw2, plan, workers, ch, rx, ids2).await
        });

        // Give the holder time to take the lock and the waiters to queue.
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;

        let blocked = sqlserver::execute(&watcher,
            "SELECT COUNT(*) FROM sys.dm_exec_requests r \
             WHERE r.blocking_session_id <> 0 AND r.session_id <> @@SPID")
            .await.expect("waiting tasks");
        let n = blocked.rows[0][0].as_i64().unwrap_or(0);
        // Two waiters queueing behind one holder. If this is 0 the scenario is
        // decorative: the statements ran and nothing contended.
        assert!(n >= 1, "no session is blocked — the chain never formed");

        let spawned = ids.lock().await.len();
        assert_eq!(spawned, 3, "not every worker got a session");

        // Stop, and confirm the sessions are really gone rather than left to
        // finish their 30-second wait.
        tx.send(()).ok();
        let cancelled = run.await.expect("join").expect("run_ms");
        assert!(cancelled, "cancel was not reported");

        // KILL is asynchronous: the session is marked and then rolls back, so
        // this polls rather than sleeping once. A fixed sleep here would either
        // be flaky or would have to be long enough to be useless as a signal.
        let mut left = -1;
        let mut status = String::new();
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            // `r.session_id <> @@SPID` excludes THIS query, whose own text
            // contains the string it is searching for — without it the probe
            // always finds exactly one survivor: itself.
            let r = sqlserver::execute(&watcher,
                "SELECT COUNT(*), ISNULL(MAX(r.status), '') FROM sys.dm_exec_requests r \
                 CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t \
                 WHERE t.text LIKE '%txui-playground livetest%' \
                   AND r.session_id <> @@SPID").await.expect("survivors");
            left = r.rows[0][0].as_i64().unwrap_or(-1);
            status = r.rows[0][1].as_str().unwrap_or("").to_string();
            if left == 0 { break; }
        }
        assert_eq!(left, 0,
                   "playground sessions survived the kill (last status: {status})");

        sqlserver::execute(&watcher, "DROP TABLE IF EXISTS dbo.txui_playground").await.ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(scenario: &str, threads: u32) -> MessSpec {
        MessSpec {
            scenario: scenario.into(), threads, duration_secs: 30.0, stagger_ms: 100,
            repeats: 1, jitter_pct: 0, database: Some("playground".into()),
            hold_secs: 60.0, tag: Some("demo".into()),
        }
    }

    #[test]
    fn absurd_specs_are_clamped() {
        let mut s = spec("sleep", 5_000);
        s.duration_secs = 99_999.0;
        s.repeats = 10_000;
        s.jitter_pct = 900;
        s.stagger_ms = 999_999;
        let p = plan_from(&s);
        assert_eq!(p.threads, 64);
        assert_eq!(p.duration, 600.0);
        assert_eq!(p.repeats, 200);
        assert_eq!(p.jitter_pct, 100);
        assert_eq!(p.stagger_ms, 60_000);
    }

    #[test]
    fn tag_is_sanitized_for_a_sql_comment() {
        let mut s = spec("sleep", 1);
        s.tag = Some("evil */ DROP TABLE x; --".into());
        let p = plan_from(&s);
        assert!(!p.tag.contains('*') && !p.tag.contains('/') && !p.tag.contains(';'));
        let w = build_workers(&p, Engine::Mysql);
        assert_eq!(w[0].statements[0].matches("*/").count(), 1); // only our own comment closes
    }

    #[test]
    fn empty_tag_falls_back() {
        let mut s = spec("sleep", 1);
        s.tag = Some("   ".into());
        assert_eq!(plan_from(&s).tag, "mess");
    }

    #[test]
    fn sleep_family_shares_one_statement_shape() {
        let p = plan_from(&spec("sleep", 4));
        let w = build_workers(&p, Engine::Mysql);
        assert_eq!(w.len(), 4);
        assert!(w.iter().all(|x| x.role == "rogue" && x.statements.len() == 1));
        // identical apart from the slot marker → one family for killall
        let shapes: Vec<String> = w.iter()
            .map(|x| x.statements[0].replace(&format!("slot={}", x.slot), "slot=N"))
            .collect();
        assert!(shapes.windows(2).all(|p| p[0] == p[1]), "{:?}", shapes);
        assert!(w[0].statements[0].contains("SLEEP(30.00)"));
    }

    #[test]
    fn jitter_spreads_ages_deterministically() {
        let a = jittered(100.0, 50, 3);
        assert_eq!(a, jittered(100.0, 50, 3));            // reproducible
        assert_ne!(a, jittered(100.0, 50, 4));            // per-slot
        assert!((50.0..=150.0).contains(&a), "{}", a);
        assert_eq!(jittered(10.0, 0, 7), 10.0);           // off = exact
        assert!(jittered(0.2, 100, 1) >= 0.1);            // never below the floor
    }

    #[test]
    fn lock_scenario_is_one_holder_then_waiters() {
        let p = plan_from(&spec("lock", 4));
        let w = build_workers(&p, Engine::Mysql);
        assert_eq!(w.len(), 4);
        assert_eq!(w[0].role, "holder");
        assert!(w[0].statements.iter().any(|s| s.contains("FOR UPDATE")));
        assert!(w[0].statements.iter().any(|s| s.contains("COMMIT")));
        assert!(w[1..].iter().all(|x| x.role == "waiter"));
        assert!(w[1].statements.iter().any(|s| s.contains("UPDATE") && s.contains("id = 1")));
        // waiters must outlive innodb's 50 s default wait timeout
        assert!(w[1].statements.iter().any(|s| s.contains("innodb_lock_wait_timeout")));
    }

    #[test]
    fn lock_scenario_always_has_something_to_wait_for() {
        let p = plan_from(&spec("lock", 1));
        assert_eq!(p.threads, 2, "the plan raises the count instead of build_workers");
        let w = build_workers(&p, Engine::Mysql);
        assert_eq!(w.len(), 2, "a chain needs at least a holder and a waiter");
    }

    /// The number in the UI is the number of server threads. No scenario may
    /// quietly spawn more than the plan says.
    #[test]
    fn every_scenario_spawns_exactly_the_planned_thread_count() {
        for scenario in ["sleep", "lock", "mixed"] {
            for asked in 1..=40u32 {
                let mut sp = spec(scenario, asked);
                let plan = plan_from(&sp);
                assert!(plan.threads >= asked.max(min_threads(plan.scenario)));
                let n = build_workers(&plan, Engine::Mysql).len() as u32;
                assert_eq!(n, plan.threads,
                    "{scenario} asked={asked} planned={} spawned={n}", plan.threads);
                // …and with no database (so "mixed" drops its lock chain)
                sp.database = None;
                let plan = plan_from(&sp);
                let n = build_workers(&plan, Engine::Mysql).len() as u32;
                assert_eq!(n, plan.threads, "{scenario} without a db: asked={asked}");
            }
        }
    }

    #[test]
    fn mixed_keeps_all_three_families_at_its_minimum() {
        let p = plan_from(&spec("mixed", 1));
        assert_eq!(p.threads, 4);
        let w = build_workers(&p, Engine::Mysql);
        for role in ["rogue", "holder", "waiter"] {
            assert!(w.iter().any(|x| x.role == role), "missing {role} at the minimum size");
        }
    }

    #[test]
    fn mixed_has_all_three_families() {
        let p = plan_from(&spec("mixed", 8));
        let w = build_workers(&p, Engine::Mysql);
        for role in ["rogue", "churn", "holder", "waiter"] {
            assert!(w.iter().any(|x| x.role == role), "missing {role} in {:?}",
                    w.iter().map(|x| &x.role).collect::<Vec<_>>());
        }
    }

    #[test]
    fn mixed_without_a_database_skips_the_lock_chain() {
        let mut s = spec("mixed", 6);
        s.database = None;
        let w = build_workers(&plan_from(&s), Engine::Mysql);
        assert!(w.iter().all(|x| x.role == "rogue" || x.role == "churn"));
    }

    #[test]
    fn identifiers_are_quoted_per_engine() {
        assert_eq!(qualified(Engine::Mysql, Some("my`db")), "`my``db`.`txui_playground`");
        assert_eq!(qualified(Engine::Postgres, Some("my\"s")), "\"my\"\"s\".\"txui_playground\"");
        let setup = lock_setup(Engine::Mysql, Some("pg"));
        assert!(setup[0].starts_with("CREATE DATABASE IF NOT EXISTS `pg`"));
        assert!(lock_setup(Engine::Postgres, None).len() == 2);
    }

    #[test]
    fn pg_uses_pg_sleep() {
        let p = plan_from(&spec("sleep", 1));
        let w = build_workers(&p, Engine::Postgres);
        assert!(w[0].statements[0].contains("pg_sleep(30.00)"));
    }

    /// The real thing, against a real server: workers must appear in the
    /// processlist as their own threads, and Stop must leave nothing behind.
    /// Ignored by default (needs a live MySQL); run it against a saved
    /// connection — password comes from the same encrypted store as the GUI:
    ///
    ///   TXUI_TEST_CONN=Lo80 cargo test --lib playground -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn spawned_threads_are_real_and_stop_kills_them() {
        let Ok(name) = std::env::var("TXUI_TEST_CONN") else { return };
        let dir = crate::storage::default_data_dir();
        let configs = crate::storage::load(&dir).expect("read connections.json");
        let config = configs.values().find(|c| c.name == name).expect("connection not found").clone();
        let password = crate::secretstore::get(&dir, &config.keychain_key());

        let plan = plan_from(&MessSpec {
            scenario: "sleep".into(), threads: 3, duration_secs: 60.0, stagger_ms: 0,
            repeats: 1, jitter_pct: 0, database: None, hold_secs: 1.0,
            tag: Some("selftest-sleep".into()),
        });
        let workers = build_workers(&plan, Engine::Mysql);
        let pool = crate::db::mysql::open_pool(&config, password.clone(), None, 6).await.unwrap();
        let probe = crate::db::mysql::open_pool(&config, password, None, 2).await.unwrap();

        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = events.clone();
        let chan = Channel::new(move |body| {
            sink.lock().unwrap().push(format!("{:?}", body));
            Ok(())
        });
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let ids = Arc::new(Mutex::new(Vec::<u64>::new()));
        let run = tokio::spawn(run_my(pool.clone(), plan, workers, chan, cancel_rx, ids.clone()));

        let count = |p: &sqlx::MySqlPool| {
            let p = p.clone();
            async move {
                // The tag is CONCAT-split so this query does not match itself
                // in the very processlist it is reading. "selftest-sleep" must
                // not be a prefix of the lock test's tag ("selftest-lock") or
                // the two tests, run concurrently, would count each other.
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM information_schema.PROCESSLIST \
                     WHERE INFO LIKE CONCAT('%txui-playground ', 'selftest-sleep%')")
                    .fetch_one(&p).await.unwrap()
            }
        };
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        assert_eq!(count(&probe).await, 3, "3 workers should be visible on the server");
        assert_eq!(ids.lock().await.len(), 3);
        assert!(ids.lock().await.iter().all(|id| *id != 0), "every worker reports its thread id");
        assert_eq!(events.lock().unwrap().len(), 3, "one spawned event per worker");

        cancel_tx.send(()).unwrap();
        assert!(run.await.unwrap().unwrap(), "run reports itself cancelled");
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        assert_eq!(count(&probe).await, 0, "Stop must not leave threads behind");
        pool.close().await;
        probe.close().await;
    }

    /// The lock scenario must produce a REAL blocking chain (the thing the
    /// `killall` blocker analysis is built for), not just busy threads.
    /// Same opt-in as the test above.
    #[tokio::test]
    #[ignore]
    async fn lock_scenario_produces_a_real_blocking_chain() {
        let Ok(name) = std::env::var("TXUI_TEST_CONN") else { return };
        let dir = crate::storage::default_data_dir();
        let configs = crate::storage::load(&dir).expect("read connections.json");
        let config = configs.values().find(|c| c.name == name).expect("connection not found").clone();
        let password = crate::secretstore::get(&dir, &config.keychain_key());

        let plan = plan_from(&MessSpec {
            scenario: "lock".into(), threads: 3, duration_secs: 1.0, stagger_ms: 200,
            repeats: 1, jitter_pct: 0, database: Some("txui_playground".into()),
            hold_secs: 20.0, tag: Some("selftest-lock".into()),
        });
        let workers = build_workers(&plan, Engine::Mysql);
        let pool = crate::db::mysql::open_pool(&config, password.clone(), None, 6).await.unwrap();
        let probe = crate::db::mysql::open_pool(&config, password, None, 2).await.unwrap();

        let chan = Channel::new(|_| Ok(()));
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let ids = Arc::new(Mutex::new(Vec::<u64>::new()));
        let run = tokio::spawn(run_my(pool.clone(), plan, workers, chan, cancel_rx, ids.clone()));

        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        let waits: Vec<(u64, u64)> = sqlx::query_as(
            "SELECT waiting_pid, blocking_pid FROM sys.innodb_lock_waits")
            .fetch_all(&probe).await.unwrap();
        assert!(!waits.is_empty(), "the holder must actually block the waiters");
        // Exactly one thread in the queue waits for nobody — the root blocker
        // the analyzer is supposed to single out.
        let waiting: std::collections::HashSet<u64> = waits.iter().map(|(w, _)| *w).collect();
        let blocking: std::collections::HashSet<u64> = waits.iter().map(|(_, b)| *b).collect();
        let roots: Vec<&u64> = blocking.iter().filter(|b| !waiting.contains(b)).collect();
        assert_eq!(roots.len(), 1, "one root blocker, got {:?} (waits: {:?})", roots, waits);

        cancel_tx.send(()).unwrap();
        assert!(run.await.unwrap().unwrap());
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        let left: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.PROCESSLIST \
             WHERE INFO LIKE CONCAT('%txui-playground ', 'selftest-lock%')")
            .fetch_one(&probe).await.unwrap();
        assert_eq!(left, 0, "Stop must clear the whole chain");
        pool.close().await;
        probe.close().await;
    }

    #[test]
    fn headroom_refuses_runs_that_would_exhaust_the_server() {
        assert!(headroom_check(151, 10, 66).is_ok());
        // 151 - 140 = 11 free; 66 + 5 headroom does not fit
        let err = headroom_check(151, 140, 66).unwrap_err();
        assert!(err.message.contains("allows 151"), "{}", err.message);
        assert!(err.message.contains("140 are in use"), "{}", err.message);
        assert!(err.message.contains("at most 6"), "{}", err.message);
        assert!(err.message.contains("Lower the thread count to 5."), "{}", err.message);
        // exact fit is allowed, one more is not
        assert!(headroom_check(20, 5, 10).is_ok());
        assert!(headroom_check(20, 5, 11).is_err());
        // a full server gets no nonsense suggestion
        let err = headroom_check(10, 10, 4).unwrap_err();
        assert!(err.message.contains("at most 0"), "{}", err.message);
        assert!(!err.message.contains("Lower the thread count"), "{}", err.message);
    }

    #[test]
    fn pg_lock_setup_creates_the_schema_when_asked() {
        let with = lock_setup(Engine::Postgres, Some("pg"));
        assert!(with[0].starts_with("CREATE SCHEMA IF NOT EXISTS \"pg\""));
        assert_eq!(with.len(), 3);
        assert_eq!(lock_setup(Engine::Postgres, None).len(), 2);
    }
}
