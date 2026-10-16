//! Galera cluster group poll: the wsrep snapshot from EVERY node at once.
//!
//! The multi-node companion of the per-session Galera dashboard
//! (frontend `GaleraClusterView`, rules in `utils/galeraStatus.ts`). It clones
//! the multi_exec shape — ephemeral sessions over saved connection configs,
//! opened and closed per poll, concurrency-capped, per-node timeout, live
//! events on a Channel — but is read-only by construction: the two probes are
//! `SHOW GLOBAL STATUS LIKE 'wsrep%'` and `SHOW GLOBAL VARIABLES LIKE
//! 'wsrep%'`, both read-family, run through the same session machinery
//! `multi_execute` uses (which already honours read-only configs). One node's
//! failure never fails the poll; a non-MySQL connection is skipped with a
//! note event rather than an error.
//!
//! Everything interpretive stays frontend (the pure-TS doctrine): this module
//! ships raw name/value rows only. Parsing, cluster-wide findings and rate
//! math live in `utils/galeraCluster.ts`.
//!
//! Two additions remove the "hand-create one saved connection per node"
//! friction, both OFFERED, never forced:
//! - `galera_cluster_poll` also takes `adhoc_configs` — full connection
//!   configs the frontend built from `wsrep_incoming_addresses` ("Monitor
//!   once"). Each is polled through the exact same per-node path as a saved
//!   one, used DIRECTLY: never looked up in and never inserted into
//!   `state.configs`. The config keeps the seed connection's id, which is
//!   what makes secret resolution work (`dbgui:{id}` holds the seed's
//!   password); the Node event's `connection_id` is a synthetic but STABLE
//!   id derived from seed-id + host:port, so it never collides with the
//!   seed's own node in the frontend merge while state clocks and rate
//!   baselines still survive across polls.
//! - `galera_adopt_members` turns discovered members into real saved
//!   connections ("Add as connections"): seed clone, fresh id, host/port
//!   swapped, password AND SSH-password secrets copied to the new ids'
//!   secret keys, one persist at the end.
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::db::connection;
use crate::db::types::{ConnectionConfig, Engine, QueryResult, Row};
use crate::state::AppState;

/// Same fan-out ceiling as the fleet executor.
const CONCURRENCY: usize = 6;
/// Far below multi_exec's 300 s: a cluster poll is two tiny SHOWs, and the
/// frontend re-polls every 5 s — a hung node must not hold a slot.
const PER_NODE_TIMEOUT_SECS: u64 = 30;

const STATUS_SQL: &str = "SHOW GLOBAL STATUS LIKE 'wsrep%'";
const VARIABLES_SQL: &str = "SHOW GLOBAL VARIABLES LIKE 'wsrep%'";

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GaleraNodeEvent {
    /// One node's poll outcome — raw rows, or the failure. `connection_name`
    /// is the saved connection's name (node labeling needs no extra probe:
    /// wsrep_node_name / wsrep_node_address are inside the row sets).
    Node {
        connection_id: Uuid,
        connection_name: String,
        ok: bool,
        error: Option<String>,
        status_rows: Vec<(String, String)>,
        variable_rows: Vec<(String, String)>,
        elapsed_ms: u64,
    },
    Done {
        nodes: usize,
        ok_count: usize,
        total_ms: u64,
    },
}

/// Only the MySQL family speaks wsrep. MariaDB and Percona are the same
/// `Engine::Mysql` — detection is by the `wsrep_on` row, not the flavor.
fn is_mysql_family(engine: Engine) -> bool {
    engine == Engine::Mysql
}
/// SHOW name/value rows → (name, value) pairs. A NULL value becomes the empty
/// string, the same contract the single-node view's parser already eats.
fn pack_name_value_rows(result: &QueryResult) -> Vec<(String, String)> {
    result.rows.iter().map(|row: &Row| {
        let name = row.first().map(|v| match v {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        }).unwrap_or_default();
        let value = row.get(1).map(|v| match v {
            serde_json::Value::Null => String::new(),
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        }).unwrap_or_default();
        (name, value)
    }).collect()
}

/// The `connection_id` an ad-hoc (unsaved, "Monitor once") member reports on
/// its Node events. The ad-hoc CONFIG keeps the seed's id — secret resolution
/// depends on it (`dbgui:{id}` is the seed's password) — so emitting it would
/// collide with the seed's own node in the frontend merge. Instead the event
/// id is derived from `adhoc:{seed_id}:{host}:{port}`: unique per member, and
/// STABLE across polls, so the panel's state clocks, rate baselines and gcache
/// samples keyed by connectionId keep working. uuid's v5 feature is not
/// enabled, so the 128 bits are two FNV-1a-64 hashes with different offsets;
/// the version (5) and variant bits are set the RFC 4122 way. The frontend
/// treats the id as opaque.
fn adhoc_event_id(seed_id: Uuid, host: &str, port: u16) -> Uuid {
    let input = format!("adhoc:{}:{}:{}", seed_id, host.to_lowercase(), port);
    fn fnv1a64(data: &[u8], offset: u64) -> u64 {
        let mut h = offset;
        for b in data {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h
    }
    let a = fnv1a64(input.as_bytes(), 0xcbf2_9ce4_8422_2325);
    let b = fnv1a64(input.as_bytes(), 0x9e37_79b9_7f4a_7c15);
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&a.to_be_bytes());
    bytes[8..].copy_from_slice(&b.to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    Uuid::from_bytes(bytes)
}

/// One node: open an ephemeral session, run the two probes with a timeout,
/// always clean up. Errors are reported, never propagated — a dead node must
/// not take the cluster view down with it. This is the shared core: saved
/// connections reach it through `poll_one` (config looked up in
/// `state.configs`), ad-hoc configs are handed over directly and NEVER touch
/// `state.configs`.
async fn poll_one_config(
    state: &AppState,
    config: &ConnectionConfig,
    event_id: Uuid,
) -> GaleraNodeEvent {
    let name = config.name.clone();
    let started = Instant::now();
    let done = |ok: bool, error: Option<String>,
                status_rows: Vec<(String, String)>, variable_rows: Vec<(String, String)>| {
        GaleraNodeEvent::Node {
            connection_id: event_id,
            connection_name: name,
            ok,
            error,
            status_rows,
            variable_rows,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    };

    if !is_mysql_family(config.engine) {
        return done(false, Some(format!(
            "skipped — {} connections have no wsrep status (Galera is MySQL-family)",
            config.engine.wire_name())), vec![], vec![]);
    }

    let session_id = match super::connections::open_ephemeral_session(config, state).await {
        Ok(id) => id,
        Err(e) => return done(false, Some(crate::apperror::AppError::display(&e)), vec![], vec![]),
    };

    let cancel_key = format!("galera-{}", session_id);
    let run = async {
        let status = connection::execute_query(
            session_id, STATUS_SQL, &state.sessions, &state.kills, &state.ch_kills,
            &cancel_key, false, None, Some(1000)).await?;
        let variables = connection::execute_query(
            session_id, VARIABLES_SQL, &state.sessions, &state.kills, &state.ch_kills,
            &cancel_key, false, None, Some(1000)).await?;
        Ok::<(QueryResult, QueryResult), crate::apperror::AppError>((status, variables))
    };
    let outcome = match tokio::time::timeout(
        std::time::Duration::from_secs(PER_NODE_TIMEOUT_SECS), run,
    ).await {
        Ok(Ok((st, va))) => (true, None, pack_name_value_rows(&st), pack_name_value_rows(&va)),
        Ok(Err(e)) => (false, Some(crate::apperror::AppError::display(&e)), vec![], vec![]),
        Err(_) => (false, Some(format!("timeout after {}s", PER_NODE_TIMEOUT_SECS)), vec![], vec![]),
    };

    // Shared ephemeral teardown: every registry cleaned, and a kill handle
    // still registered (the timeout arm above) is fired, not just removed.
    super::connections::teardown_ephemeral_session(state, session_id, &cancel_key).await;

    done(outcome.0, outcome.1, outcome.2, outcome.3)
}

/// The saved-connection entry point: the config comes out of `state.configs`
/// by id and the event carries that same id. A missing id is a Node-event
/// failure, never a poll failure.
async fn poll_one(
    state: &AppState,
    conn_id: Uuid,
    name: String,
) -> GaleraNodeEvent {
    match state.configs.read().await.get(&conn_id).cloned() {
        Some(c) => poll_one_config(state, &c, conn_id).await,
        None => GaleraNodeEvent::Node {
            connection_id: conn_id,
            connection_name: name,
            ok: false,
            error: Some(format!("connection {} not found", conn_id)),
            status_rows: vec![],
            variable_rows: vec![],
            elapsed_ms: 0,
        },
    }
}

#[tauri::command]
pub async fn galera_cluster_poll(
    connection_ids: Vec<Uuid>,
    // Option because tauri command args have no serde defaults — a caller
    // that predates ad-hoc monitoring simply omits it.
    adhoc_configs: Option<Vec<ConnectionConfig>>,
    on_event: Channel<GaleraNodeEvent>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    let adhoc_configs = adhoc_configs.unwrap_or_default();
    if connection_ids.is_empty() && adhoc_configs.is_empty() {
        return Err("no nodes selected".into());
    }

    let poll_started = Instant::now();
    let sem = Arc::new(Semaphore::new(CONCURRENCY));
    let app_state: AppState = (*state).clone();
    let mut handles = Vec::with_capacity(connection_ids.len() + adhoc_configs.len());

    for conn_id in connection_ids {
        let sem = sem.clone();
        let chan = on_event.clone();
        let st = app_state.clone();

        handles.push(tokio::spawn(async move {
            let name = st.configs.read().await.get(&conn_id)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| conn_id.to_string());
            let event = match sem.acquire().await {
                Ok(_permit) => poll_one(&st, conn_id, name).await,
                Err(_) => GaleraNodeEvent::Node {
                    connection_id: conn_id,
                    connection_name: name,
                    ok: false,
                    error: Some("executor shutting down".into()),
                    status_rows: vec![],
                    variable_rows: vec![],
                    elapsed_ms: 0,
                },
            };
            let ok = matches!(event, GaleraNodeEvent::Node { ok: true, .. });
            let _ = chan.send(event);
            ok
        }));
    }

    // Ad-hoc ("Monitor once") members: the same per-node path — same
    // semaphore, same timeout, same cleanup — but the config is used as
    // handed over and is NEVER looked up in or inserted into state.configs.
    // The event id is the synthetic stable one (see adhoc_event_id), so it
    // cannot collide with the seed's own node whose id the config still
    // carries for secret resolution.
    for config in adhoc_configs {
        let sem = sem.clone();
        let chan = on_event.clone();
        let st = app_state.clone();

        handles.push(tokio::spawn(async move {
            let event_id = adhoc_event_id(
                config.id,
                config.host.as_deref().unwrap_or("localhost"),
                config.port.unwrap_or(config.engine.default_port()),
            );
            let event = match sem.acquire().await {
                Ok(_permit) => poll_one_config(&st, &config, event_id).await,
                Err(_) => GaleraNodeEvent::Node {
                    connection_id: event_id,
                    connection_name: config.name.clone(),
                    ok: false,
                    error: Some("executor shutting down".into()),
                    status_rows: vec![],
                    variable_rows: vec![],
                    elapsed_ms: 0,
                },
            };
            let ok = matches!(event, GaleraNodeEvent::Node { ok: true, .. });
            let _ = chan.send(event);
            ok
        }));
    }

    let mut nodes = 0usize;
    let mut ok_count = 0usize;
    for h in handles {
        // A panicked task lost its Node event, so it cannot count as ok.
        if let Ok(ok) = h.await {
            nodes += 1;
            if ok { ok_count += 1; }
        }
    }
    let _ = on_event.send(GaleraNodeEvent::Done {
        nodes,
        ok_count,
        total_ms: poll_started.elapsed().as_millis() as u64,
    });
    Ok(())
}

// ── One-click adoption: discovered members → saved connections ─────────────
//
// The discovery half lives entirely frontend (the single-node view's poll
// already reads wsrep_incoming_addresses; utils/galeraDiscover.ts does the
// matching). This command is the commit half of "Add as connections": each
// member becomes a clone of the seed config with a fresh id, its own
// host/port, the display name and the chosen folder — and, critically, its
// OWN secret entries, copied from the seed's (`dbgui:{seed}` → `dbgui:{new}`,
// `dbgui-ssh:{seed}` → `dbgui-ssh:{new}`) so the adopted node authenticates
// with the same credentials and `delete_connection` later cleans up the
// right keys. Everything is inserted first and persisted ONCE at the end, so
// a persist failure cannot leave half the members in memory but not on disk.
// A member pointing at the seed's own host:port is skipped silently — the
// frontend filters it too, this is the defense-in-depth copy.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdoptMember {
    pub host: String,
    pub port: u16,
    pub name: String,
}

/// The shared body, testable without a Tauri State wrapper.
pub(crate) async fn adopt_members(
    state: &AppState,
    seed_id: Uuid,
    members: Vec<AdoptMember>,
    group: Option<String>,
) -> Result<Vec<ConnectionConfig>, crate::apperror::AppError> {
    let seed = state.configs.read().await.get(&seed_id).cloned()
        .ok_or_else(|| crate::apperror::AppError::bad_request(
            format!("connection {seed_id} not found")))?;

    let seed_host = seed.host.as_deref().unwrap_or("").trim().to_lowercase();
    let seed_port = seed.port.unwrap_or(seed.engine.default_port());

    let mut created: Vec<ConnectionConfig> = Vec::new();
    for m in members {
        // The seed's own address among the members means "this node" — never
        // adopt yourself as a second connection.
        if m.host.trim().to_lowercase() == seed_host && m.port == seed_port {
            continue;
        }
        let mut config = seed.clone();
        config.id = Uuid::new_v4();
        config.host = Some(m.host);
        config.port = Some(m.port);
        config.name = m.name;
        config.group = group.clone();
        // Copy BOTH secrets to the new id's keys — a missing one is fine (the
        // seed may have no password, or key-based SSH).
        if let Some(pw) = crate::secretstore::get(&state.data_dir, &seed.keychain_key()) {
            crate::secretstore::set(&state.data_dir, &config.keychain_key(), &pw)
                .map_err(|e| format!("could not copy the seed's password: {e}"))?;
        }
        if let Some(pw) = crate::secretstore::get(&state.data_dir, &seed.ssh_keychain_key()) {
            crate::secretstore::set(&state.data_dir, &config.ssh_keychain_key(), &pw)
                .map_err(|e| format!("could not copy the seed's SSH password: {e}"))?;
        }
        state.configs.write().await.insert(config.id, config.clone());
        created.push(config);
    }
    super::connections::persist_configs_state(state).await?;
    Ok(created)
}

#[tauri::command]
pub async fn galera_adopt_members(
    seed_id: Uuid,
    members: Vec<AdoptMember>,
    group: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionConfig>, crate::apperror::AppError> {
    adopt_members(&state, seed_id, members, group).await
}

// ── Cluster-wide processlist: what is EVERY node executing right now ───────
//
// Same fan-out shape as galera_cluster_poll (ephemeral sessions, concurrency
// cap, per-node timeout, Channel events, ad-hoc configs with synthetic event
// ids), one probe: `SHOW FULL PROCESSLIST` — read-family, so read-only
// configs pass the same guard the poll rides on. The poll itself stays
// read-only by construction; acting on a row (KILL) is a separate command,
// `galera_cluster_kill` below, routed to the row's own node.
//
// Privilege reality the frontend interprets (the backend just ships rows):
// without the PROCESS privilege a server returns only the SESSION'S OWN
// threads — and since every poll is a fresh ephemeral session, an
// unprivileged account sees ~1 row per node: its own probe. utils/
// galeraProcesslist.ts detects that shape and shows the GRANT hint.

const PROCESSLIST_SQL: &str = "SHOW FULL PROCESSLIST";

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GaleraProcessEvent {
    /// One node's processlist — RAW columns + string rows (NULL → the empty
    /// string, the pack contract). Column ORDER differs across MySQL /
    /// MariaDB / Percona versions, so the columns ride along and every
    /// positional decision is the frontend's.
    Node {
        connection_id: Uuid,
        connection_name: String,
        ok: bool,
        error: Option<String>,
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
        elapsed_ms: u64,
    },
    Done {
        nodes: usize,
        ok_count: usize,
        total_ms: u64,
    },
}

/// Arbitrary result → (column names, string rows): NULL → "", everything
/// else stringified without a float anywhere in the path.
fn pack_rows_strings(result: &QueryResult) -> (Vec<String>, Vec<Vec<String>>) {
    let columns = result.columns.iter().map(|c| c.name.clone()).collect();
    let rows = result.rows.iter().map(|row: &Row| row.iter().map(|v| match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }).collect()).collect();
    (columns, rows)
}

/// One node's processlist — the poll_one_config shape with a single probe.
/// Saved connections reach it through `processlist_one`; ad-hoc configs are
/// handed over directly and never touch `state.configs`.
async fn processlist_one_config(
    state: &AppState,
    config: &ConnectionConfig,
    event_id: Uuid,
) -> GaleraProcessEvent {
    let name = config.name.clone();
    let started = Instant::now();
    let done = |ok: bool, error: Option<String>,
                columns: Vec<String>, rows: Vec<Vec<String>>| {
        GaleraProcessEvent::Node {
            connection_id: event_id,
            connection_name: name,
            ok,
            error,
            columns,
            rows,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    };

    if !is_mysql_family(config.engine) {
        return done(false, Some(format!(
            "skipped — {} connections have no processlist (Galera is MySQL-family)",
            config.engine.wire_name())), vec![], vec![]);
    }

    let session_id = match super::connections::open_ephemeral_session(config, state).await {
        Ok(id) => id,
        Err(e) => return done(false, Some(crate::apperror::AppError::display(&e)), vec![], vec![]),
    };

    let cancel_key = format!("galera-proc-{}", session_id);
    let run = async {
        let r = connection::execute_query(
            session_id, PROCESSLIST_SQL, &state.sessions, &state.kills, &state.ch_kills,
            &cancel_key, false, None, Some(10000)).await?;
        Ok::<QueryResult, crate::apperror::AppError>(r)
    };
    let outcome = match tokio::time::timeout(
        std::time::Duration::from_secs(PER_NODE_TIMEOUT_SECS), run,
    ).await {
        Ok(Ok(r)) => {
            let (columns, rows) = pack_rows_strings(&r);
            (true, None, columns, rows)
        }
        Ok(Err(e)) => (false, Some(crate::apperror::AppError::display(&e)), vec![], vec![]),
        Err(_) => (false, Some(format!("timeout after {}s", PER_NODE_TIMEOUT_SECS)), vec![], vec![]),
    };

    // Shared ephemeral teardown, same as the cluster poll.
    super::connections::teardown_ephemeral_session(state, session_id, &cancel_key).await;

    done(outcome.0, outcome.1, outcome.2, outcome.3)
}

/// The saved-connection entry point: config out of `state.configs` by id.
async fn processlist_one(
    state: &AppState,
    conn_id: Uuid,
    name: String,
) -> GaleraProcessEvent {
    match state.configs.read().await.get(&conn_id).cloned() {
        Some(c) => processlist_one_config(state, &c, conn_id).await,
        None => GaleraProcessEvent::Node {
            connection_id: conn_id,
            connection_name: name,
            ok: false,
            error: Some(format!("connection {} not found", conn_id)),
            columns: vec![],
            rows: vec![],
            elapsed_ms: 0,
        },
    }
}

#[tauri::command]
pub async fn galera_cluster_processlist(
    connection_ids: Vec<Uuid>,
    // Same Option-args convention as galera_cluster_poll.
    adhoc_configs: Option<Vec<ConnectionConfig>>,
    on_event: Channel<GaleraProcessEvent>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    let adhoc_configs = adhoc_configs.unwrap_or_default();
    if connection_ids.is_empty() && adhoc_configs.is_empty() {
        return Err("no nodes selected".into());
    }

    let poll_started = Instant::now();
    let sem = Arc::new(Semaphore::new(CONCURRENCY));
    let app_state: AppState = (*state).clone();
    let mut handles = Vec::with_capacity(connection_ids.len() + adhoc_configs.len());

    for conn_id in connection_ids {
        let sem = sem.clone();
        let chan = on_event.clone();
        let st = app_state.clone();

        handles.push(tokio::spawn(async move {
            let name = st.configs.read().await.get(&conn_id)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| conn_id.to_string());
            let event = match sem.acquire().await {
                Ok(_permit) => processlist_one(&st, conn_id, name).await,
                Err(_) => GaleraProcessEvent::Node {
                    connection_id: conn_id,
                    connection_name: name,
                    ok: false,
                    error: Some("executor shutting down".into()),
                    columns: vec![],
                    rows: vec![],
                    elapsed_ms: 0,
                },
            };
            let ok = matches!(event, GaleraProcessEvent::Node { ok: true, .. });
            let _ = chan.send(event);
            ok
        }));
    }

    // Ad-hoc members: same path, config used directly, synthetic STABLE event
    // id (see adhoc_event_id) so it never collides with the seed's own node.
    for config in adhoc_configs {
        let sem = sem.clone();
        let chan = on_event.clone();
        let st = app_state.clone();

        handles.push(tokio::spawn(async move {
            let event_id = adhoc_event_id(
                config.id,
                config.host.as_deref().unwrap_or("localhost"),
                config.port.unwrap_or(config.engine.default_port()),
            );
            let event = match sem.acquire().await {
                Ok(_permit) => processlist_one_config(&st, &config, event_id).await,
                Err(_) => GaleraProcessEvent::Node {
                    connection_id: event_id,
                    connection_name: config.name.clone(),
                    ok: false,
                    error: Some("executor shutting down".into()),
                    columns: vec![],
                    rows: vec![],
                    elapsed_ms: 0,
                },
            };
            let ok = matches!(event, GaleraProcessEvent::Node { ok: true, .. });
            let _ = chan.send(event);
            ok
        }));
    }

    let mut nodes = 0usize;
    let mut ok_count = 0usize;
    for h in handles {
        if let Ok(ok) = h.await {
            nodes += 1;
            if ok { ok_count += 1; }
        }
    }
    let _ = on_event.send(GaleraProcessEvent::Done {
        nodes,
        ok_count,
        total_ms: poll_started.elapsed().as_millis() as u64,
    });
    Ok(())
}

// ── Cluster-wide kill: KILL <id> on the row's OWN node ─────────────────────
//
// The cluster processlist merges every node's threads, but thread ids are
// node-local — a kill must go back to the node the row came from. This command
// is that route: the config arrives WHOLE (a saved one the panel listed, or an
// ad-hoc "Monitor once" clone — the same rationale as
// `galera_cluster_sst_tail`, so there is no `state.configs` lookup and unsaved
// nodes kill exactly like saved ones), an ephemeral session is opened for it,
// ONE kill is issued through the same implementation the per-session Processes
// panel uses (`do_kill_processes` — factored off `kill_processes`, so no kill
// bypasses the existing gates), and the shared ephemeral teardown
// (`teardown_ephemeral_session`) cleans every registry, kill or no kill.
// A per-thread failure (a missing
// CONNECTION_ADMIN, a thread already gone) comes back as data in the
// `KillOutcome`, never hidden.

/// The shared body, factored off the `tauri::command` shell so tests can drive
/// it with a plain `AppState` (the `cluster_sst_tail` / `poll_one_config`
/// pattern).
pub(crate) async fn cluster_kill(
    state: &AppState,
    config: &ConnectionConfig,
    id: u64,
    mode: String,
) -> Result<Vec<super::kill::KillOutcome>, crate::apperror::AppError> {
    use crate::apperror::AppError;

    // Engine gate BEFORE any connect attempt — a bad config must cost nothing.
    if !is_mysql_family(config.engine) {
        return Err(AppError::unsupported(
            "cluster kill is only available for MySQL-family (Galera) connections"));
    }
    // The same refusal `do_kill_processes` gives, ahead of the connect: a
    // read-only config must not even open a session to kill with. The session
    // opened below still registers its SessionGuard, so the gate inside
    // `do_kill_processes` remains as the defense-in-depth copy of this check.
    if config.read_only {
        return Err(AppError::bad_request(
            "Connection is read-only — killing sessions is blocked."));
    }

    let session_id = super::connections::open_ephemeral_session(config, state).await?;
    // Galera nodes are MySQL-family: numeric thread ids, no ClickHouse
    // query_ids, hence the trailing None.
    let result = super::kill::do_kill_processes(state, session_id, vec![id], mode, None).await;

    // Shared ephemeral teardown. (The kill path registers no cancel key of
    // its own; passing the key keeps the contract symmetric — the remove is
    // a no-op, and no kill is fired.)
    super::connections::teardown_ephemeral_session(
        state, session_id, &format!("galera-kill-{session_id}")).await;

    result
}

/// Kill ONE thread on ONE node of the cluster — the cluster-wide
/// processlist's per-row action. `mode` is "query" (KILL QUERY) or anything
/// else (KILL), exactly `kill_processes`'s contract.
#[tauri::command]
pub async fn galera_cluster_kill(
    connection_config: ConnectionConfig,
    id: u64,
    mode: String,
    state: State<'_, AppState>,
) -> Result<Vec<super::kill::KillOutcome>, crate::apperror::AppError> {
    cluster_kill(&state, &connection_config, id, mode).await
}

// ── Consistency spot-check: same table, same checksum on every node ────────
//
// Galera certification is synchronous, but wsrep_on=OFF drift, local writes
// and repair accidents still happen — this is the DBA's proof. The shape is
// galera_cluster_poll's (ephemeral sessions, concurrency cap, per-node
// timeout, Channel events) and the read-only guarantee is STRONGER than a
// guard: every statement is builder-generated from information_schema
// metadata — no user text ever reaches the wire. Schema/table/column names
// are identifier-quoted (backticks doubled, the browser.rs convention) or
// literal-quoted (single quotes doubled — standard SQL, immune to
// NO_BACKSLASH_ESCAPES); the sample limit is a u64.
//
// The checksum itself: COUNT(*) plus COALESCE(SUM(CRC32(CONCAT_WS('#',
// col…))), 0) over either the whole table (mode "full") or the first N rows
// by PK (mode "sample" — ORDER BY pk LIMIT N is deterministic iff the data
// is). NULL handling: CONCAT_WS SKIPS nulls, identical on every node because
// the expression is byte-identical everywhere — a deliberate, documented
// choice over COALESCE-per-column (a row of all-NULLs and an empty concat
// collide, but both collide on ALL nodes, which is what a cross-node check
// needs). SUM has the usual aggregate weakness (swapped rows can share a
// sum); COUNT(*) alongside narrows it, and this is a spot-check, not a
// forensic hash. A table with NO primary key cannot be sampled
// deterministically — sample mode refuses with that explanation and full
// mode is the offered path.

/// Sample-mode ceiling: the dialog offers 1k/10k/100k; the clamp keeps a
/// hand-crafted invoke from turning "sample" into "full scan".
const MAX_SAMPLE_LIMIT: u64 = 1_000_000;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConsistencyEvent {
    /// One node's outcome. `checksum_text` is the raw SUM string (MySQL
    /// returns DECIMAL here — kept as text, never f64); compare it together
    /// with `sampled_rows`. A node that failed or timed out reports ok=false
    /// and is "inconclusive" — it never blocks the others.
    Node {
        connection_id: Uuid,
        connection_name: String,
        ok: bool,
        error: Option<String>,
        row_estimate: Option<i64>,
        sampled_rows: u64,
        checksum_text: Option<String>,
        pk_columns: Vec<String>,
        elapsed_ms: u64,
    },
    Done {
        nodes: usize,
        ok_count: usize,
        total_ms: u64,
    },
}

/// MySQL identifier quoting: backticks, doubled to escape — the browser
/// builder's MySQL branch (`db/browser.rs::quote_ident(_, false)`).
fn cc_quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// MySQL string literal: single quotes, doubled. Standard SQL, and unlike
/// backslash-escaping it survives NO_BACKSLASH_ESCAPES sql_modes.
fn cc_quote_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Table existence + row estimate (information_schema.TABLES.TABLE_ROWS —
/// an InnoDB ESTIMATE, good enough to size a confirmation, never a count).
fn cc_table_probe_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT TABLE_ROWS FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
        cc_quote_literal(schema), cc_quote_literal(table))
}

/// Column list in declared order — the stable ordering the identical
/// CONCAT_WS expression needs on every node.
fn cc_columns_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY ORDINAL_POSITION",
        cc_quote_literal(schema), cc_quote_literal(table))
}

/// PK columns in key order. CONSTRAINT_NAME = 'PRIMARY' covers every MySQL
/// family primary key; an empty answer means "no PK" (tolerant by design).
fn cc_pk_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND CONSTRAINT_NAME = 'PRIMARY' \
         ORDER BY ORDINAL_POSITION",
        cc_quote_literal(schema), cc_quote_literal(table))
}

/// The checksum SELECT. `limit = Some(n)` samples the first n rows by PK
/// (deterministic given identical data); `None` reads the whole table.
/// Both shapes return one row: (sampled, checksum).
fn cc_checksum_sql(
    schema: &str,
    table: &str,
    columns: &[String],
    pk_columns: &[String],
    limit: Option<u64>,
) -> String {
    let concat = format!(
        "CONCAT_WS('#', {})",
        columns.iter().map(|c| cc_quote_ident(c)).collect::<Vec<_>>().join(", "));
    let expr = format!("COALESCE(SUM(CRC32({concat})), 0)");
    let from = format!("{}.{}", cc_quote_ident(schema), cc_quote_ident(table));
    match limit {
        Some(n) => {
            let cols = columns.iter().map(|c| cc_quote_ident(c)).collect::<Vec<_>>().join(", ");
            let order = pk_columns.iter().map(|c| cc_quote_ident(c)).collect::<Vec<_>>().join(", ");
            format!(
                "SELECT COUNT(*) AS sampled, {expr} AS checksum \
                 FROM (SELECT {cols} FROM {from} ORDER BY {order} LIMIT {n}) AS _cc_sample")
        }
        None => format!("SELECT COUNT(*) AS sampled, {expr} AS checksum FROM {from}"),
    }
}

/// One cell → display text. NULL becomes the empty string; numbers and
/// strings stringify without a float anywhere in the path.
fn cc_cell_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn cc_cell_i64(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// One node: probe metadata, build the checksum SQL from it, run it — all
/// under the shared per-node timeout, always cleaning the ephemeral session
/// up. Errors are reported on the event, never propagated.
async fn consistency_check_one(
    state: &AppState,
    conn_id: Uuid,
    name: String,
    schema: Option<String>,
    table: String,
    limit: Option<u64>,
) -> ConsistencyEvent {
    let started = Instant::now();
    let done = |ok: bool, error: Option<String>, row_estimate: Option<i64>,
                sampled_rows: u64, checksum_text: Option<String>, pk_columns: Vec<String>| {
        ConsistencyEvent::Node {
            connection_id: conn_id,
            connection_name: name,
            ok,
            error,
            row_estimate,
            sampled_rows,
            checksum_text,
            pk_columns,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    };

    let config = match state.configs.read().await.get(&conn_id).cloned() {
        Some(c) => c,
        None => return done(false, Some(format!("connection {} not found", conn_id)), None, 0, None, vec![]),
    };
    if !is_mysql_family(config.engine) {
        return done(false, Some(format!(
            "skipped — {} connections have no information_schema/wsrep (consistency checks are MySQL-family)",
            config.engine.wire_name())), None, 0, None, vec![]);
    }

    let session_id = match super::connections::open_ephemeral_session(&config, state).await {
        Ok(id) => id,
        Err(e) => return done(false, Some(crate::apperror::AppError::display(&e)), None, 0, None, vec![]),
    };

    let cancel_key = format!("galera-cc-{}", session_id);
    let run = async {
        // Schema fallback: the dialog sends an explicit schema; an empty one
        // means "the connection's default database" (session_dbs is populated
        // at open from the config).
        let schema = match schema {
            Some(s) if !s.is_empty() => s,
            _ => state.session_dbs.read().await.get(&session_id).cloned()
                .ok_or("no schema given and this connection has no default database")?,
        };

        let q = |sql: String| {
            let key = cancel_key.clone();
            let st = state;
            async move {
                connection::execute_query(
                    session_id, &sql, &st.sessions, &st.kills, &st.ch_kills,
                    &key, false, None, Some(1000)
                ).await
            }
        };

        let probe = q(cc_table_probe_sql(&schema, &table)).await?;
        let row_estimate = probe.rows.first()
            .and_then(|r| r.first())
            .and_then(cc_cell_i64);
        if probe.rows.is_empty() {
            return Err(format!(
                "table `{}`.`{}` not found on this node", schema, table).into());
        }

        let cols = q(cc_columns_sql(&schema, &table)).await?;
        let columns: Vec<String> = cols.rows.iter()
            .filter_map(|r| r.first())
            .map(cc_cell_string)
            .filter(|s| !s.is_empty())
            .collect();
        if columns.is_empty() {
            return Err(format!(
                "no columns found for `{}`.`{}` on this node", schema, table).into());
        }

        let pk = q(cc_pk_sql(&schema, &table)).await?;
        let pk_columns: Vec<String> = pk.rows.iter()
            .filter_map(|r| r.first())
            .map(cc_cell_string)
            .filter(|s| !s.is_empty())
            .collect();
        if limit.is_some() && pk_columns.is_empty() {
            return Err(format!(
                "`{}`.`{}` has no primary key — a LIMIT sample cannot be made \
                 deterministic. Re-run as a full-table check (it reads every row).",
                schema, table).into());
        }

        let sql = cc_checksum_sql(&schema, &table, &columns, &pk_columns, limit);
        // Builder-generated SELECT only — this assert documents the read-only
        // contract at the one place it could ever break.
        debug_assert!(sql.starts_with("SELECT "));
        let sum = q(sql).await?;
        let row = sum.rows.first().ok_or("checksum query returned no row")?;
        let sampled = row.first().and_then(cc_cell_i64).unwrap_or(0) as u64;
        let checksum = row.get(1).map(cc_cell_string).filter(|s| !s.is_empty());
        Ok::<(Option<i64>, u64, Option<String>, Vec<String>), crate::apperror::AppError>(
            (row_estimate, sampled, checksum, pk_columns))
    };

    let outcome = match tokio::time::timeout(
        std::time::Duration::from_secs(PER_NODE_TIMEOUT_SECS), run,
    ).await {
        Ok(Ok((est, sampled, checksum, pk))) => (true, None, est, sampled, checksum, pk),
        Ok(Err(e)) => (false, Some(crate::apperror::AppError::display(&e)), None, 0, None, vec![]),
        Err(_) => (false, Some(format!("timeout after {}s", PER_NODE_TIMEOUT_SECS)), None, 0, None, vec![]),
    };

    // Shared ephemeral teardown, same as multi_exec and the cluster poll.
    super::connections::teardown_ephemeral_session(state, session_id, &cancel_key).await;

    done(outcome.0, outcome.1, outcome.2, outcome.3, outcome.4, outcome.5)
}

#[tauri::command]
pub async fn galera_consistency_check(
    connection_ids: Vec<Uuid>,
    schema: String,
    table: String,
    sample_limit: u64,
    mode: String,
    on_event: Channel<ConsistencyEvent>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    if connection_ids.is_empty() {
        return Err("no nodes selected".into());
    }
    if table.trim().is_empty() {
        return Err("no table given".into());
    }
    let limit = match mode.as_str() {
        "sample" => Some(sample_limit.clamp(1, MAX_SAMPLE_LIMIT)),
        "full" => None,
        other => return Err(format!("unknown consistency-check mode '{other}'").into()),
    };
    let schema = if schema.trim().is_empty() { None } else { Some(schema) };

    let run_started = Instant::now();
    let sem = Arc::new(Semaphore::new(CONCURRENCY));
    let app_state: AppState = (*state).clone();
    let mut handles = Vec::with_capacity(connection_ids.len());

    for conn_id in connection_ids {
        let sem = sem.clone();
        let chan = on_event.clone();
        let st = app_state.clone();
        let schema = schema.clone();
        let table = table.clone();

        handles.push(tokio::spawn(async move {
            let name = st.configs.read().await.get(&conn_id)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| conn_id.to_string());
            let event = match sem.acquire().await {
                Ok(_permit) => consistency_check_one(&st, conn_id, name, schema, table, limit).await,
                Err(_) => ConsistencyEvent::Node {
                    connection_id: conn_id,
                    connection_name: name,
                    ok: false,
                    error: Some("executor shutting down".into()),
                    row_estimate: None,
                    sampled_rows: 0,
                    checksum_text: None,
                    pk_columns: vec![],
                    elapsed_ms: 0,
                },
            };
            let ok = matches!(event, ConsistencyEvent::Node { ok: true, .. });
            let _ = chan.send(event);
            ok
        }));
    }

    let mut nodes = 0usize;
    let mut ok_count = 0usize;
    for h in handles {
        if let Ok(ok) = h.await {
            nodes += 1;
            if ok { ok_count += 1; }
        }
    }
    let _ = on_event.send(ConsistencyEvent::Done {
        nodes,
        ok_count,
        total_ms: run_started.elapsed().as_millis() as u64,
    });
    Ok(())
}

// ── SST/IST error-log tail over SSH ────────────────────────────────────────
//
// The only route to a true SST percentage: Galera exposes none over SQL (the
// SQL-side transfer card in `GaleraClusterView` says so honestly), but the
// server's error log carries WSREP_SST phase lines, "Receiving IST...
// 64.0%" progress and PXC's `[sst] progress=1` pv percentages. When the
// connection has SSH configured, we run `tail -n 200 -F <error log>` on the
// DB host through the same ssh/askpass machinery the tunnel uses and stream
// the lines here. ALL interpretation stays frontend
// (`utils/galeraSstLog.ts`) — this command ships raw lines and lifecycle
// events only.
//
// Cancellation rides the generic ext-job machinery: the run registers a
// oneshot under the session-prefixed key, `cancel_watched` (or
// `cancel_session_work` on session close) fires it, and the select below
// kills the ssh child. Nothing SSH-specific leaks into AppState.

/// Lines of backlog the tail starts with — enough to catch an SST announced
/// seconds before the UI attached, bounded so a huge log costs one screenful.
const TAIL_BACKLOG_LINES: u32 = 200;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SstLogEvent {
    /// The tail is running; `path` is the remote log being followed.
    Started { path: String },
    /// One raw line from the log. Parsing is the frontend's job.
    Line { line: String },
    /// stderr from ssh/tail itself (auth noise, "tail: cannot open …") —
    /// diagnostics, rendered separately, never fed to the parser.
    Note { message: String },
    /// The stream stopped: `reason` is "cancelled", "eof" (the remote side
    /// ended — ssh dropped, tail was killed) or an error string.
    Ended { reason: String },
}

/// One SHOW VARIABLES lookup on the live session, through the same guards
/// every statement gets (SHOW is read-family, so read-only sessions pass).
/// NULL and missing rows become None.
async fn show_variable(
    state: &AppState,
    session_id: &Uuid,
    name: &str,
) -> Result<Option<String>, crate::apperror::AppError> {
    let r = state.run_guarded(session_id, &format!("SHOW VARIABLES LIKE '{name}'")).await?;
    let value = r.rows.first().and_then(|row| row.get(1)).and_then(|v| match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    });
    Ok(value.filter(|s| !s.is_empty()))
}

/// Where does this server's error log live ON THE SERVER? `log_error` is the
/// answer when set; empty means stderr→console/syslog, and MariaDB's fallback
/// is `<datadir>/<hostname>.err`. A relative `log_error` is resolved against
/// the datadir, per the documented semantics. SHOW VARIABLES answers even on
/// a wsrep_ready=OFF joiner whose port accepts connections at all — which is
/// precisely when this command matters.
async fn discover_error_log_path(
    state: &AppState,
    session_id: &Uuid,
) -> Result<String, crate::apperror::AppError> {
    let log_error = show_variable(state, session_id, "log_error").await?;
    if let Some(p) = log_error {
        if p.starts_with('/') {
            return Ok(p);
        }
        let datadir = show_variable(state, session_id, "datadir").await?
            .ok_or("log_error is relative but datadir did not parse — cannot locate the error log")?;
        return Ok(format!("{}/{}", datadir.trim_end_matches('/'), p));
    }
    let datadir = show_variable(state, session_id, "datadir").await?;
    let hostname = show_variable(state, session_id, "hostname").await?;
    match (datadir, hostname) {
        (Some(dir), Some(host)) =>
            Ok(format!("{}/{}.err", dir.trim_end_matches('/'), host)),
        _ => Err("log_error is empty (logging to stderr/syslog) and the \
                  datadir/hostname fallback did not parse — the error log path \
                  is undiscoverable from here".into()),
    }
}

#[tauri::command]
pub async fn galera_sst_log_tail(
    session_id: Uuid,
    connection_id: Uuid,
    run_key: String,
    on_event: Channel<SstLogEvent>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    use crate::apperror::AppError;

    // Engine gate: wsrep is MySQL-family only. Unknown session → unsupported
    // too (there is no log to tail for a session that does not exist).
    let engine = state.session_meta.read().await.get(&session_id).map(|g| g.engine);
    if engine != Some(Engine::Mysql) {
        return Err(AppError::unsupported(
            "the SST log tail is only available for MySQL-family (Galera) sessions"));
    }

    let config = state.configs.read().await.get(&connection_id).cloned()
        .ok_or_else(|| AppError::bad_request("connection not found"))?;
    run_sst_tail(&state, session_id, &config, &run_key, on_event).await
}

/// The shared tail body: SSH gate → log-path discovery → spawn → stream, with
/// cancellation on the session-scoped ext-job key. Both entry points funnel
/// here — `galera_sst_log_tail` after resolving the saved config by id,
/// `galera_cluster_sst_tail` with the config it was handed directly (saved OR
/// ad-hoc — never a `state.configs` lookup, so "Monitor once" nodes work).
async fn run_sst_tail(
    state: &AppState,
    session_id: Uuid,
    config: &ConnectionConfig,
    run_key: &str,
    on_event: Channel<SstLogEvent>,
) -> Result<(), crate::apperror::AppError> {
    use crate::apperror::AppError;

    // SSH gate. The UI pre-greys the control on this same predicate, so this
    // is the defense-in-depth copy — a typed error, not a prose trap.
    let (ssh_host, ssh_user) = match (config.use_ssh, &config.ssh_host, &config.ssh_user) {
        (true, Some(h), Some(u)) if !h.is_empty() && !u.is_empty() => (h.clone(), u.clone()),
        _ => return Err(AppError::unsupported(
            "this connection has no SSH configured — add SSH to the connection to watch the server log")),
    };

    let path = discover_error_log_path(state, &session_id).await?;
    let remote = crate::db::ssh::tail_command(&path, TAIL_BACKLOG_LINES)
        .map_err(|e| AppError::bad_request(format!("server reports an unusable log_error path: {e}")))?;

    // Same credential path as the tunnel: the SSH password comes out of the
    // secret store into the askpass child's environment — never argv, never
    // the script body, never a log line.
    let ssh_password = if config.use_ssh_password {
        crate::secretstore::get(&state.data_dir, &config.ssh_keychain_key())
    } else {
        None
    };

    let mut child = crate::db::ssh::spawn_ssh_exec(
        &ssh_host,
        config.ssh_port.unwrap_or(22),
        &ssh_user,
        config.ssh_key_path.as_deref(),
        config.ssh_jump.as_deref(),
        ssh_password.as_deref(),
        &remote,
    ).await.map_err(|e| AppError::new(crate::apperror::ErrorCode::ConnectFailed, e.to_string()))?;

    let _ = on_event.send(SstLogEvent::Started { path });

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let job_key = crate::state::ext_job_key(session_id, run_key);
    state.ext_jobs.write().await.insert(job_key.clone(), cancel_tx);

    // stderr (ssh diagnostics, tail's "cannot open" under -F retry) flows as
    // Note events on a cloned channel; the task is aborted when the tail ends.
    let stderr_task = child.stderr.take().map(|stderr| {
        let chan = on_event.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if l.trim().is_empty() { continue; }
                if chan.send(SstLogEvent::Note { message: l }).is_err() { break; }
            }
        })
    });

    let stdout = child.stdout.take()
        .ok_or_else(|| AppError::local("ssh stdout was not piped"))?;
    let mut lines = {
        use tokio::io::AsyncBufReadExt;
        tokio::io::BufReader::new(stdout).lines()
    };

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                let _ = child.kill().await;
                let _ = on_event.send(SstLogEvent::Ended { reason: "cancelled".into() });
                break;
            }
            line = lines.next_line() => match line {
                Ok(Some(l)) => {
                    // A dead receiver means the UI went away — stop the tail
                    // rather than stream into the void.
                    if on_event.send(SstLogEvent::Line { line: l }).is_err() {
                        let _ = child.kill().await;
                        break;
                    }
                }
                Ok(None) => {
                    let status = child.wait().await.ok()
                        .and_then(|s| s.code().map(|c| c.to_string()))
                        .unwrap_or_else(|| "unknown".into());
                    let _ = on_event.send(SstLogEvent::Ended {
                        reason: format!("eof (ssh exited {status})") });
                    break;
                }
                Err(e) => {
                    let _ = child.kill().await;
                    let _ = on_event.send(SstLogEvent::Ended { reason: format!("read error: {e}") });
                    break;
                }
            }
        }
    }

    if let Some(t) = stderr_task { t.abort(); }
    state.ext_jobs.write().await.remove(&job_key);
    Ok(())
}

/// The cluster-panel variant's body, factored off the `tauri::command` shell
/// so tests can drive it with a plain `AppState` (the same pattern
/// `poll_one_config` / `adopt_members` use).
async fn cluster_sst_tail(
    config: &ConnectionConfig,
    run_key: &str,
    on_event: Channel<SstLogEvent>,
    state: &AppState,
) -> Result<(), crate::apperror::AppError> {
    use crate::apperror::AppError;

    // Engine gate: wsrep is MySQL-family only. This fires BEFORE any connect
    // attempt — a bad config must cost nothing.
    if !is_mysql_family(config.engine) {
        return Err(AppError::unsupported(
            "the SST log tail is only available for MySQL-family (Galera) connections"));
    }

    // SSH gate, also before the connect: the tail rides SSH, so a config
    // without it is refused without opening a session first. Same predicate
    // (and message) as run_sst_tail's own defense-in-depth copy.
    match (config.use_ssh, &config.ssh_host, &config.ssh_user) {
        (true, Some(h), Some(u)) if !h.is_empty() && !u.is_empty() => {}
        _ => return Err(AppError::unsupported(
            "this connection has no SSH configured — add SSH to the connection to watch the server log")),
    }

    // Honest failure: a mid-SST joiner refuses TCP outright (live-verified on
    // MariaDB 11.8 rsync SST) — which is exactly when this tail matters. The
    // connect error therefore arrives as the terminal event, rendered inline
    // by the card, never an Err the UI must special-case, never a hang.
    let session_id = match super::connections::open_ephemeral_session(config, state).await {
        Ok(id) => id,
        Err(e) => {
            let _ = on_event.send(SstLogEvent::Ended {
                reason: format!("connect failed: {}", AppError::display(&e)),
            });
            return Ok(());
        }
    };

    let result = run_sst_tail(state, session_id, config, run_key, on_event).await;

    // Shared ephemeral teardown — every registry cleaned, so nothing leaks
    // across tails.
    super::connections::teardown_ephemeral_session(
        state, session_id, &format!("galera-{session_id}")).await;
    result
}

/// SST/IST error-log tail for the multi-node cluster panel: the config arrives
/// WHOLE (a saved one the panel already listed, or an ad-hoc "Monitor once"
/// clone — `buildAdhocConfig` spreads the seed's SSH fields, and keeping the
/// seed's id is what makes `dbgui-ssh:{id}` resolve the SSH password), so no
/// `state.configs` lookup happens at all. The session is ephemeral, opened
/// and torn down inside this call; the cancel oneshot registers under the
/// session-scoped ext-job key, so the frontend's existing `cancel_watched`
/// works unchanged and `cancel_session_work` drains the tail if the session
/// is torn down first.
#[tauri::command]
pub async fn galera_cluster_sst_tail(
    connection_config: ConnectionConfig,
    run_key: String,
    on_event: Channel<SstLogEvent>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    cluster_sst_tail(&connection_config, &run_key, on_event, &state).await
}

#[cfg(test)]
mod sst_log_tests {
    use super::*;

    #[test]
    fn sst_log_event_serializes_tagged() {
        let ev = SstLogEvent::Started { path: "/var/log/mysql.err".into() };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "started");
        assert_eq!(v["path"], "/var/log/mysql.err");
        let v = serde_json::to_value(&SstLogEvent::Line { line: "WSREP: x".into() }).unwrap();
        assert_eq!(v["type"], "line");
        let v = serde_json::to_value(&SstLogEvent::Ended { reason: "cancelled".into() }).unwrap();
        assert_eq!(v["type"], "ended");
        assert_eq!(v["reason"], "cancelled");
    }

    fn temp_dir_for_sst_test(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-sst-tail-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The engine gate fires BEFORE any connect attempt: a non-MySQL config
    /// is a typed error, no session is opened, and the channel gets nothing
    /// (an Err surfaces through the invoke, not the event stream).
    #[tokio::test]
    async fn cluster_sst_tail_rejects_non_mysql_without_connecting() {
        let dir = temp_dir_for_sst_test("engine-gate");
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, dir.clone(), std::collections::HashMap::new());
        let config = ConnectionConfig::new(Engine::Postgres, "pg-x");
        let ch: Channel<SstLogEvent> = Channel::new(|_| Ok(()));
        let err = cluster_sst_tail(&config, "run-x", ch, &state).await.unwrap_err();
        assert!(crate::apperror::AppError::display(&err).contains("MySQL-family"));
        assert!(state.sessions.read().await.is_empty(),
            "the engine gate fires before any session opens");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The SSH gate also fires before the connect: a MySQL-family config
    /// without SSH is the same typed `unsupported` the per-session command
    /// gives, and no session is opened for it.
    #[tokio::test]
    async fn cluster_sst_tail_requires_ssh_before_connecting() {
        let dir = temp_dir_for_sst_test("ssh-gate");
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, dir.clone(), std::collections::HashMap::new());
        let config = ConnectionConfig::new(Engine::Mysql, "galera-no-ssh");
        let ch: Channel<SstLogEvent> = Channel::new(|_| Ok(()));
        let err = cluster_sst_tail(&config, "run-y", ch, &state).await.unwrap_err();
        assert!(crate::apperror::AppError::display(&err).contains("no SSH configured"));
        assert!(state.sessions.read().await.is_empty(),
            "the SSH gate fires before any session opens");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod cluster_kill_tests {
    use super::*;

    fn temp_dir_for_kill_test(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-cluster-kill-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The engine gate fires BEFORE any connect attempt: a non-MySQL config is
    /// a typed `unsupported` error and no session is opened for it.
    #[tokio::test]
    async fn cluster_kill_rejects_non_mysql_without_connecting() {
        let dir = temp_dir_for_kill_test("engine-gate");
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, dir.clone(), std::collections::HashMap::new());
        let config = ConnectionConfig::new(Engine::Postgres, "pg-x");
        let err = cluster_kill(&state, &config, 42, "query".into()).await.unwrap_err();
        assert_eq!(err.code, crate::apperror::ErrorCode::Unsupported);
        assert!(crate::apperror::AppError::display(&err).contains("MySQL-family"));
        assert!(state.sessions.read().await.is_empty(),
            "the engine gate fires before any session opens");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A read-only config is refused BEFORE the connect: the refusal precedes
    /// any KILL (and any network), so the test needs no live server. The gate
    /// inside `do_kill_processes` stays as the defense-in-depth copy.
    #[tokio::test]
    async fn cluster_kill_refuses_read_only_before_connecting() {
        let dir = temp_dir_for_kill_test("read-only");
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, dir.clone(), std::collections::HashMap::new());
        let mut config = ConnectionConfig::new(Engine::Mysql, "ro-node");
        config.read_only = true;
        let err = cluster_kill(&state, &config, 42, "connection".into()).await.unwrap_err();
        assert!(crate::apperror::AppError::display(&err).contains("read-only"));
        assert!(state.sessions.read().await.is_empty(),
            "a read-only refusal must not open a session");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(rows: Vec<Row>) -> QueryResult {
        QueryResult {
            columns: vec![],
            rows,
            rows_affected: None,
            execution_ms: 0,
            fetch_ms: 0,
            warnings: vec![],
            truncated: false,
            geo_bbox: None,
        }
    }

    #[test]
    fn pack_rows_strings_and_nulls() {
        let r = result(vec![
            vec![serde_json::json!("wsrep_on"), serde_json::json!("ON")],
            vec![serde_json::json!("wsrep_cluster_size"), serde_json::json!("3")],
            // NULL value → empty string, the parser's contract
            vec![serde_json::json!("wsrep_ist_receive_status"), serde_json::Value::Null],
        ]);
        let packed = pack_name_value_rows(&r);
        assert_eq!(packed, vec![
            ("wsrep_on".to_string(), "ON".to_string()),
            ("wsrep_cluster_size".to_string(), "3".to_string()),
            ("wsrep_ist_receive_status".to_string(), String::new()),
        ]);
    }

    #[test]
    fn pack_rows_non_string_cells_stringify() {
        let r = result(vec![
            vec![serde_json::json!(123), serde_json::json!(456)],
        ]);
        let packed = pack_name_value_rows(&r);
        assert_eq!(packed, vec![("123".to_string(), "456".to_string())]);
    }

    #[test]
    fn pack_rows_short_row_degrades() {
        // A one-column row (should not happen for SHOW, but must not panic).
        let r = result(vec![vec![serde_json::json!("wsrep_on")]]);
        let packed = pack_name_value_rows(&r);
        assert_eq!(packed, vec![("wsrep_on".to_string(), String::new())]);
    }

    #[test]
    fn engine_gate_is_mysql_family_only() {
        assert!(is_mysql_family(Engine::Mysql));
        for e in [Engine::Postgres, Engine::Redis, Engine::Clickhouse,
                  Engine::Sqlite, Engine::Parquet, Engine::Duckdb,
                  Engine::MongoDb, Engine::SqlServer] {
            assert!(!is_mysql_family(e), "{:?} must be skipped", e);
        }
    }

    #[test]
    fn pack_rows_strings_keeps_column_names_and_nulls_become_empty() {
        let r = QueryResult {
            columns: vec![
                crate::db::types::ColumnInfo { name: "Id".into(), type_name: "LONG".into(), nullable: false },
                crate::db::types::ColumnInfo { name: "User".into(), type_name: "VAR_STRING".into(), nullable: false },
                crate::db::types::ColumnInfo { name: "Info".into(), type_name: "BLOB".into(), nullable: true },
            ],
            rows: vec![
                vec![serde_json::json!(1), serde_json::json!("system user"), serde_json::Value::Null],
                vec![serde_json::json!(11), serde_json::json!("root"), serde_json::json!("SHOW FULL PROCESSLIST")],
            ],
            rows_affected: None,
            execution_ms: 0,
            fetch_ms: 0,
            warnings: vec![],
            truncated: false,
            geo_bbox: None,
        };
        let (columns, rows) = pack_rows_strings(&r);
        assert_eq!(columns, vec!["Id", "User", "Info"]);
        assert_eq!(rows, vec![
            vec!["1".to_string(), "system user".to_string(), String::new()],
            vec!["11".to_string(), "root".to_string(), "SHOW FULL PROCESSLIST".to_string()],
        ]);
    }

    #[test]
    fn process_event_serializes_tagged() {
        let ev = GaleraProcessEvent::Node {
            connection_id: Uuid::nil(),
            connection_name: "node-1".into(),
            ok: true,
            error: None,
            columns: vec!["Id".into(), "Info".into()],
            rows: vec![vec!["1".into(), "".into()]],
            elapsed_ms: 7,
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "node");
        assert_eq!(v["connection_name"], "node-1");
        assert_eq!(v["columns"][0], "Id");
        assert_eq!(v["rows"][0][1], "");

        let done = serde_json::to_value(GaleraProcessEvent::Done {
            nodes: 2, ok_count: 2, total_ms: 30,
        }).unwrap();
        assert_eq!(done["type"], "done");
        assert_eq!(done["ok_count"], 2);
    }

    #[test]
    fn node_event_serializes_camel_free_and_tagged() {
        let ev = GaleraNodeEvent::Node {
            connection_id: Uuid::nil(),
            connection_name: "node-1".into(),
            ok: false,
            error: Some("boom".into()),
            status_rows: vec![("wsrep_on".into(), "ON".into())],
            variable_rows: vec![],
            elapsed_ms: 42,
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "node");
        assert_eq!(v["connection_name"], "node-1");
        assert_eq!(v["error"], "boom");
        assert_eq!(v["status_rows"][0], serde_json::json!(["wsrep_on", "ON"]));
        assert_eq!(v["elapsed_ms"], 42);

        let done = serde_json::to_value(GaleraNodeEvent::Done {
            nodes: 3, ok_count: 2, total_ms: 100,
        }).unwrap();
        assert_eq!(done["type"], "done");
    }
}

#[cfg(test)]
mod discover_tests {
    //! Auto-discovery + adoption: the ad-hoc event id's stability contract
    //! (frontend merge keys depend on it), the adopt command's secret copying
    //! and persistence, and the proof that the ad-hoc poll path never touches
    //! `state.configs`.
    use super::*;
    use crate::db::types::SslMode;

    #[test]
    fn adhoc_event_id_is_stable_distinct_and_rfc4122() {
        let seed = Uuid::new_v4();
        let a = adhoc_event_id(seed, "127.0.0.1", 3342);
        let a2 = adhoc_event_id(seed, "127.0.0.1", 3342);
        assert_eq!(a, a2, "same member → same id across polls (merge keys depend on it)");
        assert_eq!(a, adhoc_event_id(seed, "127.0.0.1".to_uppercase().as_str(), 3342),
            "host case must not fork the id");
        assert_ne!(a, adhoc_event_id(seed, "127.0.0.1", 3343), "per-member unique");
        assert_ne!(a, adhoc_event_id(Uuid::new_v4(), "127.0.0.1", 3342), "per-seed unique");
        assert_ne!(a, seed, "must not collide with the seed's own event id");
        let bytes = a.as_bytes();
        assert_eq!(bytes[6] >> 4, 5, "version nibble");
        assert_eq!(bytes[8] >> 6, 0b10, "RFC 4122 variant");
    }

    fn temp_dir_for_test(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-adopt-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn adopt_copies_secrets_inserts_and_persists() {
        let dir = temp_dir_for_test("adopt");
        let mut seed = ConnectionConfig::new(Engine::Mysql, "galera1");
        seed.host = Some("127.0.0.1".into());
        seed.port = Some(3341);
        seed.user = Some("root".into());
        seed.ssl_mode = SslMode::Disable;
        let seed_id = seed.id;
        let mut configs = std::collections::HashMap::new();
        configs.insert(seed.id, seed);
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, dir.clone(), configs);
        crate::secretstore::set(&dir, &format!("dbgui:{seed_id}"), "root").unwrap();
        crate::secretstore::set(&dir, &format!("dbgui-ssh:{seed_id}"), "ssh-secret").unwrap();

        let created = adopt_members(&state, seed_id, vec![
            // The seed's own address — skipped silently.
            AdoptMember { host: "127.0.0.1".into(), port: 3341, name: "self".into() },
            AdoptMember { host: "127.0.0.1".into(), port: 3342, name: "db @ 127.0.0.1:3342".into() },
            AdoptMember { host: "127.0.0.1".into(), port: 3343, name: "db @ 127.0.0.1:3343".into() },
        ], Some("db".into())).await.unwrap();

        assert_eq!(created.len(), 2, "the seed's own host:port must be skipped");
        for c in &created {
            assert_ne!(c.id, seed_id);
            assert_eq!(c.group.as_deref(), Some("db"));
            assert_eq!(c.user.as_deref(), Some("root"), "a clone of the seed");
            // BOTH secrets live under the NEW id's keys.
            assert_eq!(crate::secretstore::get(&dir, &c.keychain_key()).as_deref(), Some("root"));
            assert_eq!(crate::secretstore::get(&dir, &c.ssh_keychain_key()).as_deref(), Some("ssh-secret"));
        }
        assert_eq!(created[0].port, Some(3342));
        assert_eq!(created[1].port, Some(3343));

        // In-memory registry has seed + 2 adopted…
        assert_eq!(state.configs.read().await.len(), 3);
        // …and connections.json on disk agrees (persisted once at the end).
        let loaded = crate::storage::load(&dir).unwrap();
        assert_eq!(loaded.len(), 3);
        assert!(created.iter().all(|c| loaded.contains_key(&c.id)));

        // A second adopt of an unknown seed refuses.
        let err = adopt_members(&state, Uuid::new_v4(), vec![
            AdoptMember { host: "x".into(), port: 1, name: "x".into() },
        ], None).await.unwrap_err();
        assert!(crate::apperror::AppError::display(&err).contains("not found"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn adhoc_poll_config_never_touches_saved_configs() {
        let dir = temp_dir_for_test("adhoc");
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, dir.clone(), std::collections::HashMap::new());
        // A non-MySQL ad-hoc config exits at the engine gate WITHOUT any
        // state.configs lookup — and the registry must stay empty afterwards.
        let mut config = ConnectionConfig::new(Engine::Postgres, "adhoc-x");
        config.id = Uuid::new_v4();
        let event_id = adhoc_event_id(config.id, "127.0.0.1", 5432);
        let ev = poll_one_config(&state, &config, event_id).await;
        let GaleraNodeEvent::Node { connection_id, connection_name, ok, error, .. } = ev
            else { panic!("expected a Node event") };
        assert!(!ok);
        assert_eq!(connection_id, event_id);
        assert_eq!(connection_name, "adhoc-x");
        assert!(error.unwrap().contains("skipped"));
        assert!(state.configs.read().await.is_empty(),
            "the ad-hoc path must never insert into state.configs");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn adhoc_processlist_config_never_touches_saved_configs() {
        let dir = temp_dir_for_test("adhoc-proc");
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, dir.clone(), std::collections::HashMap::new());
        // Same engine-gate proof as the poll: a non-MySQL ad-hoc config is
        // skipped WITHOUT any state.configs lookup, under the same synthetic
        // stable event id the frontend merges on.
        let mut config = ConnectionConfig::new(Engine::Postgres, "adhoc-x");
        config.id = Uuid::new_v4();
        let event_id = adhoc_event_id(config.id, "127.0.0.1", 5432);
        let ev = processlist_one_config(&state, &config, event_id).await;
        let GaleraProcessEvent::Node { connection_id, ok, error, .. } = ev
            else { panic!("expected a Node event") };
        assert!(!ok);
        assert_eq!(connection_id, event_id);
        assert_eq!(event_id, adhoc_event_id(config.id, "127.0.0.1", 5432), "stable across polls");
        assert!(error.unwrap().contains("skipped"));
        assert!(state.configs.read().await.is_empty(),
            "the ad-hoc path must never insert into state.configs");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod consistency_tests {
    use super::*;

    #[test]
    fn ident_quoting_doubles_backticks() {
        assert_eq!(cc_quote_ident("orders"), "`orders`");
        assert_eq!(cc_quote_ident("we`ird"), "`we``ird`");
    }

    #[test]
    fn literal_quoting_doubles_single_quotes() {
        // `''` is standard SQL and survives NO_BACKSLASH_ESCAPES; `\'` does not.
        assert_eq!(cc_quote_literal("galera_smoke"), "'galera_smoke'");
        assert_eq!(cc_quote_literal("o'hare"), "'o''hare'");
    }

    #[test]
    fn probe_sql_quotes_schema_and_table() {
        let sql = cc_table_probe_sql("my db", "cc_test");
        assert_eq!(sql, "SELECT TABLE_ROWS FROM information_schema.TABLES \
                         WHERE TABLE_SCHEMA = 'my db' AND TABLE_NAME = 'cc_test'");
        let cols = cc_columns_sql("s", "t");
        assert!(cols.contains("ORDER BY ORDINAL_POSITION"));
        assert!(cols.contains("TABLE_SCHEMA = 's'"));
        let pk = cc_pk_sql("s", "t");
        assert!(pk.contains("CONSTRAINT_NAME = 'PRIMARY'"));
        assert!(pk.contains("ORDER BY ORDINAL_POSITION"));
    }

    #[test]
    fn sample_sql_is_bounded_and_pk_ordered() {
        let sql = cc_checksum_sql(
            "shop", "orders",
            &["id".into(), "amount".into(), "note".into()],
            &["id".into()],
            Some(10_000),
        );
        assert_eq!(sql,
            "SELECT COUNT(*) AS sampled, \
             COALESCE(SUM(CRC32(CONCAT_WS('#', `id`, `amount`, `note`))), 0) AS checksum \
             FROM (SELECT `id`, `amount`, `note` FROM `shop`.`orders` \
             ORDER BY `id` LIMIT 10000) AS _cc_sample");
    }

    #[test]
    fn sample_sql_composite_pk_orders_all_parts() {
        let sql = cc_checksum_sql(
            "s", "t", &["a".into(), "b".into()], &["a".into(), "b".into()], Some(1),
        );
        assert!(sql.contains("ORDER BY `a`, `b` LIMIT 1"));
    }

    #[test]
    fn full_sql_reads_everything_with_no_subquery() {
        let sql = cc_checksum_sql("s", "t", &["a".into()], &[], None);
        assert_eq!(sql,
            "SELECT COUNT(*) AS sampled, \
             COALESCE(SUM(CRC32(CONCAT_WS('#', `a`))), 0) AS checksum \
             FROM `s`.`t`");
        assert!(!sql.contains("LIMIT"));
        assert!(sql.starts_with("SELECT "), "read-only contract");
    }

    #[test]
    fn hostile_names_cannot_break_out() {
        // A table name carrying SQL stays inside its literal/identifier quotes.
        let sql = cc_table_probe_sql("s", "x' OR '1'='1");
        assert!(sql.contains("TABLE_NAME = 'x'' OR ''1''=''1'"));
        let sql = cc_checksum_sql("s", "t`x", &["c`.x".into()], &[], None);
        assert!(sql.contains("FROM `s`.`t``x`"));
        assert!(sql.contains("`c``.x`"));
    }

    #[test]
    fn cells_decode_without_floats() {
        assert_eq!(cc_cell_string(&serde_json::Value::Null), "");
        assert_eq!(cc_cell_string(&serde_json::json!("abc")), "abc");
        assert_eq!(cc_cell_string(&serde_json::json!(18446744073709551615_u64)),
                   "18446744073709551615");
        assert_eq!(cc_cell_i64(&serde_json::json!(5000)), Some(5000));
        assert_eq!(cc_cell_i64(&serde_json::json!("5000")), Some(5000));
        assert_eq!(cc_cell_i64(&serde_json::Value::Null), None);
    }

    #[test]
    fn consistency_event_serializes_tagged() {
        let ev = ConsistencyEvent::Node {
            connection_id: Uuid::nil(),
            connection_name: "galera2".into(),
            ok: true,
            error: None,
            row_estimate: Some(5000),
            sampled_rows: 5000,
            checksum_text: Some("123456789".into()),
            pk_columns: vec!["id".into()],
            elapsed_ms: 84,
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "node");
        assert_eq!(v["connection_name"], "galera2");
        assert_eq!(v["checksum_text"], "123456789");
        assert_eq!(v["sampled_rows"], 5000);
        assert_eq!(v["pk_columns"][0], "id");

        let done = serde_json::to_value(ConsistencyEvent::Done {
            nodes: 3, ok_count: 3, total_ms: 120,
        }).unwrap();
        assert_eq!(done["type"], "done");
        assert_eq!(done["ok_count"], 3);
    }
}

#[cfg(test)]
mod consistency_live_tests {
    //! The consistency spot-check against the real 3-node MariaDB 11.8 cluster
    //! (dbctl: galera1/2/3 on 127.0.0.1:3341-3343, root/root). What unit tests
    //! cannot prove: the builder SQL runs on a live server, the checksum
    //! decodes identically on every node, a wsrep_on=OFF drift is DETECTED,
    //! and a no-PK table is refused.
    //!
    //!   cargo test --lib galera_consistency_live -- --ignored --nocapture
    //!
    //! Creates galera_smoke.cc_test (5000 rows), verifies match → drift on
    //! galera2 → mismatch naming galera2 → repair → match, then drops the
    //! table. Skips when nothing listens on 3341.
    use super::*;
    use crate::db::types::{ConnectionConfig, Engine, SslMode};
    use sqlx::Row as _;

    fn node_config(name: &str, port: u16) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Mysql, name);
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.user = Some("root".into());
        c.ssl_mode = SslMode::Disable;
        c
    }

    struct LiveBed {
        state: AppState,
        nodes: Vec<(Uuid, String)>,
        pool1: sqlx::MySqlPool,
        pool2: sqlx::MySqlPool,
    }

    async fn live_bed() -> Option<LiveBed> {
        let pool1 = crate::db::mysql::open_pool(
            &node_config("probe1", 3341), Some("root".into()), None, 2).await.ok()?;
        let pool2 = crate::db::mysql::open_pool(
            &node_config("probe2", 3342), Some("root".into()), None, 2).await.ok()?;
        let dir = std::env::temp_dir().join(format!("txui-cc-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).ok()?;
        let mut configs = std::collections::HashMap::new();
        let mut nodes = vec![];
        for (name, port) in [("galera1", 3341u16), ("galera2", 3342), ("galera3", 3343)] {
            let c = node_config(name, port);
            crate::secretstore::set(&dir, &c.keychain_key(), "root").ok()?;
            nodes.push((c.id, name.to_string()));
            configs.insert(c.id, c);
        }
        let history = crate::history::open_in_memory().await.ok()?;
        Some(LiveBed { state: AppState::new(history, dir, configs), nodes, pool1, pool2 })
    }

    #[derive(Debug)]
    struct Row { name: String, ok: bool, error: Option<String>, sampled: u64,
                 checksum: Option<String>, elapsed: u64 }

    async fn check_all(bed: &LiveBed, table: &str, limit: Option<u64>) -> Vec<Row> {
        let mut out = vec![];
        for (id, name) in &bed.nodes {
            let ev = consistency_check_one(
                &bed.state, *id, name.clone(),
                Some("galera_smoke".into()), table.into(), limit).await;
            let ConsistencyEvent::Node {
                connection_name, ok, error, sampled_rows, checksum_text, elapsed_ms, ..
            } = ev else { panic!("check_one returned a non-Node event") };
            out.push(Row { name: connection_name, ok, error,
                           sampled: sampled_rows, checksum: checksum_text, elapsed: elapsed_ms });
        }
        out
    }

    fn print_rows(tag: &str, rows: &[Row]) {
        println!("  {tag}:");
        for r in rows {
            println!("    {:8} ok={} rows={:5} checksum={:>14} elapsed={:3} ms{}",
                r.name, r.ok, r.sampled,
                r.checksum.clone().unwrap_or_else(|| "—".into()),
                r.elapsed,
                r.error.as_ref().map(|e| format!("  [{e}]")).unwrap_or_default());
        }
    }

    #[tokio::test]
    #[ignore]
    async fn galera_consistency_live_match_drift_repair() {
        let Some(bed) = live_bed().await else {
            println!("no galera1 on 3341 — skipping"); return;
        };

        // Fixture: 5000 rows, written on galera1 — Galera replicates it.
        sqlx::query("CREATE DATABASE IF NOT EXISTS galera_smoke").execute(&bed.pool1).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS galera_smoke.cc_test").execute(&bed.pool1).await.unwrap();
        sqlx::query("CREATE TABLE galera_smoke.cc_test \
                     (id INT PRIMARY KEY, val VARCHAR(64), n INT)")
            .execute(&bed.pool1).await.unwrap();
        // MariaDB caps CTE recursion via max_recursive_iterations (default
        // 1000 — MySQL's cte_max_recursion_depth does not exist here). The
        // SET is session-scoped, so it and the INSERT share ONE pooled
        // connection (a pool would happily split them across two).
        let mut setup = bed.pool1.acquire().await.unwrap();
        sqlx::query("SET SESSION max_recursive_iterations = 10000").execute(&mut *setup).await.unwrap();
        sqlx::query("INSERT INTO galera_smoke.cc_test (id, val, n) \
                     WITH RECURSIVE seq AS (SELECT 1 AS i UNION ALL SELECT i+1 FROM seq WHERE i < 5000) \
                     SELECT i, CONCAT('row-', i), i * 7 FROM seq")
            .execute(&mut *setup).await.unwrap();
        drop(setup);
        // Replication on loopback is fast; still, wait for galera3 to see all rows.
        for _ in 0..50 {
            let n: i64 = sqlx::query("SELECT COUNT(*) FROM galera_smoke.cc_test")
                .fetch_one(&bed.pool2).await.unwrap().get(0);
            if n == 5000 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        // 1) Consistent cluster → all three checksums identical.
        let rows = check_all(&bed, "cc_test", Some(10_000)).await;
        print_rows("consistent, sample 10k", &rows);
        assert!(rows.iter().all(|r| r.ok), "all nodes must answer: {rows:?}");
        assert!(rows.iter().all(|r| r.sampled == 5000), "sampled rows: {rows:?}");
        assert!(rows.windows(2).all(|w| w[0].checksum == w[1].checksum),
            "checksums must agree on a consistent cluster: {rows:?}");

        // 1b) Full mode over the same 5000 rows agrees with the 10k sample
        // (the sample covered the whole table) — both shapes work live.
        let full = check_all(&bed, "cc_test", None).await;
        print_rows("consistent, full", &full);
        assert!(full.iter().all(|r| r.ok && r.sampled == 5000));
        assert_eq!(full[0].checksum, rows[0].checksum,
            "full and covering-sample checksums must agree");

        // 2) Drift ONE row on galera2 with wsrep_on=OFF — the exact scenario
        // this feature exists to catch (local write outside certification).
        // Session-scoped, so the whole OFF→UPDATE→ON sequence rides ONE
        // pooled connection; split across two, the UPDATE replicates and the
        // "drift" is just a replicated write (seen in a prior run of this test).
        let mut drift_conn = bed.pool2.acquire().await.unwrap();
        sqlx::query("SET SESSION wsrep_on=OFF").execute(&mut *drift_conn).await.unwrap();
        sqlx::query("UPDATE galera_smoke.cc_test SET val = 'DRIFTED' WHERE id = 2500")
            .execute(&mut *drift_conn).await.unwrap();
        sqlx::query("SET SESSION wsrep_on=ON").execute(&mut *drift_conn).await.unwrap();
        drop(drift_conn);

        let drift = check_all(&bed, "cc_test", Some(10_000)).await;
        print_rows("after wsrep_on=OFF drift on galera2", &drift);
        let by_name = |n: &str| drift.iter().find(|r| r.name == n).unwrap();
        assert!(drift.iter().all(|r| r.ok && r.sampled == 5000),
            "a drifted VALUE keeps the row count — detection is the checksum: {drift:?}");
        assert_eq!(by_name("galera1").checksum, by_name("galera3").checksum,
            "untouched nodes must still agree");
        assert_ne!(by_name("galera2").checksum, by_name("galera1").checksum,
            "the drifted node MUST be flagged");

        // 3) Repair the row and verify the cluster reads consistent again.
        let mut repair_conn = bed.pool2.acquire().await.unwrap();
        sqlx::query("SET SESSION wsrep_on=OFF").execute(&mut *repair_conn).await.unwrap();
        sqlx::query("UPDATE galera_smoke.cc_test SET val = 'row-2500' WHERE id = 2500")
            .execute(&mut *repair_conn).await.unwrap();
        sqlx::query("SET SESSION wsrep_on=ON").execute(&mut *repair_conn).await.unwrap();
        drop(repair_conn);
        let fixed = check_all(&bed, "cc_test", Some(10_000)).await;
        print_rows("after repair", &fixed);
        assert!(fixed.windows(2).all(|w| w[0].checksum == w[1].checksum),
            "repaired cluster must read consistent: {fixed:?}");

        // 4) A no-PK table refuses sample mode with the honest explanation.
        sqlx::query("DROP TABLE IF EXISTS galera_smoke.cc_nopk").execute(&bed.pool1).await.unwrap();
        sqlx::query("CREATE TABLE galera_smoke.cc_nopk (a INT, b VARCHAR(8))")
            .execute(&bed.pool1).await.unwrap();
        sqlx::query("INSERT INTO galera_smoke.cc_nopk VALUES (1, 'x')").execute(&bed.pool1).await.unwrap();
        let nopk = check_all(&bed, "cc_nopk", Some(10_000)).await;
        print_rows("no-PK table, sample mode", &nopk);
        assert!(nopk.iter().all(|r| !r.ok
            && r.error.as_ref().is_some_and(|e| e.contains("no primary key"))),
            "no-PK sample must refuse with the explanation: {nopk:?}");
        sqlx::query("DROP TABLE galera_smoke.cc_nopk").execute(&bed.pool1).await.unwrap();

        // Leave the cluster as found: table dropped, 3× Synced.
        sqlx::query("DROP TABLE galera_smoke.cc_test").execute(&bed.pool1).await.unwrap();
        let state: String = sqlx::query("SHOW GLOBAL STATUS LIKE 'wsrep_local_state_comment'")
            .fetch_one(&bed.pool1).await.unwrap().get(1);
        println!("  galera1 local state after cleanup: {state}");
        assert_eq!(state, "Synced");
        bed.pool1.close().await;
        bed.pool2.close().await;
    }
}

#[cfg(test)]
mod discover_live_tests {
    //! Adoption + ad-hoc polling against the real 3-node MariaDB 11.8 cluster
    //! (galera1/2/3 on 127.0.0.1:3341-3343, root/root). What unit tests cannot
    //! prove: an ADOPTED connection opens a live session with the copied
    //! secret, and an AD-HOC config (the seed's id, a member's host/port)
    //! polls a live node and comes back under its synthetic event id.
    //!
    //!   cargo test --lib galera_discover_live -- --ignored --nocapture
    //!
    //! Read-only against the cluster (SHOW probes only); skips when nothing
    //! listens on 3341. NOTE: this fleet runs wsrep_node_incoming_address=AUTO,
    //! so wsrep_incoming_addresses reads "AUTO,AUTO,AUTO" — the discovery
    //! premise is exercised here with the fleet's known addresses, which is
    //! all the machinery under test consumes.
    use super::*;
    use crate::db::types::SslMode;
    use sqlx::Row as _;

    fn node_config(name: &str, port: u16) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Mysql, name);
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.user = Some("root".into());
        c.ssl_mode = SslMode::Disable;
        c
    }

    #[tokio::test]
    #[ignore]
    async fn galera_discover_live_adopt_and_adhoc_poll() {
        let Ok(pool) = crate::db::mysql::open_pool(
            &node_config("probe", 3341), Some("root".into()), None, 1).await
        else {
            println!("no galera1 on 3341 — skipping"); return;
        };

        // The discovery premise, stated honestly for THIS fleet.
        let row = sqlx::query("SHOW GLOBAL STATUS LIKE 'wsrep_incoming_addresses'")
            .fetch_one(&pool).await.unwrap();
        let incoming: String = row.get(1);
        println!("  wsrep_incoming_addresses on galera1: {incoming}");

        let dir = std::env::temp_dir().join(format!("txui-discover-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let seed = node_config("galera1", 3341);
        crate::secretstore::set(&dir, &seed.keychain_key(), "root").unwrap();
        let seed_id = seed.id;
        let mut configs = std::collections::HashMap::new();
        configs.insert(seed.id, seed);
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, dir.clone(), configs);

        // 1) Adopt the two mates; each adopted config must OPEN A SESSION —
        //    that is the copied secret authenticating, the entire point.
        let created = adopt_members(&state, seed_id, vec![
            AdoptMember { host: "127.0.0.1".into(), port: 3342,
                          name: "txui-galera @ 127.0.0.1:3342".into() },
            AdoptMember { host: "127.0.0.1".into(), port: 3343,
                          name: "txui-galera @ 127.0.0.1:3343".into() },
        ], Some("txui-galera".into())).await.unwrap();
        assert_eq!(created.len(), 2);
        for c in &created {
            let sid = crate::commands::connections::open_session_for_config(c, &state)
                .await.unwrap();
            crate::db::connection::close_session(sid, &state.sessions).await;
            state.session_meta.write().await.remove(&sid);
            println!("  adopted {} — live session opened with the copied secret", c.name);
        }
        assert_eq!(state.configs.read().await.len(), 3);

        // 2) Ad-hoc poll: the id-preserving clone (seed's id, member's
        //    host/port) polls a LIVE node, reports under the synthetic id,
        //    and adds nothing to state.configs.
        let mut adhoc = node_config("txui-galera @ 127.0.0.1:3343", 3343);
        adhoc.id = seed_id;   // the id-preserving clone — secret resolution
        let event_id = adhoc_event_id(seed_id, "127.0.0.1", 3343);
        let ev = poll_one_config(&state, &adhoc, event_id).await;
        let GaleraNodeEvent::Node {
            connection_id, connection_name, ok, error, status_rows, variable_rows, ..
        } = ev else { panic!("expected a Node event") };
        assert!(ok, "ad-hoc poll failed: {error:?}");
        assert_eq!(connection_id, event_id, "the synthetic per-member id, not the seed's");
        assert_ne!(connection_id, seed_id);
        assert_eq!(connection_name, "txui-galera @ 127.0.0.1:3343");
        let size = status_rows.iter().find(|(k, _)| k == "wsrep_cluster_size")
            .map(|(_, v)| v.clone());
        let cluster = variable_rows.iter().find(|(k, _)| k == "wsrep_cluster_name")
            .map(|(_, v)| v.clone());
        println!("  ad-hoc poll of 3343: ok — cluster {cluster:?}, size {size:?}, \
                  {} status rows, event id {connection_id}", status_rows.len());
        assert_eq!(size.as_deref(), Some("3"));
        assert_eq!(state.configs.read().await.len(), 3,
            "the ad-hoc path must never insert into state.configs");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod cluster_kill_live_tests {
    //! Kill from the cluster-wide processlist against the real 3-node MariaDB
    //! 11.8 cluster (galera1/2/3 on 127.0.0.1:3341-3343, root/root). What unit
    //! tests cannot prove: the kill lands on the row's OWN node over the
    //! ephemeral session, the outcome is data, and nothing leaks.
    //!
    //!   cargo test --lib galera_cluster_kill_live -- --ignored --nocapture
    //!
    //! Starts a SLEEPing user thread on galera2 and kills it through
    //! `cluster_kill` with galera2's config — first query mode (the connection
    //! survives), then connection mode (the thread vanishes). Skips when
    //! nothing listens on 3341.
    use super::*;
    use crate::db::types::SslMode;

    fn node_config(name: &str, port: u16) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Mysql, name);
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.user = Some("root".into());
        c.ssl_mode = SslMode::Disable;
        c
    }

    async fn thread_state(pool: &sqlx::MySqlPool, id: u64) -> Option<String> {
        let r = crate::db::mysql::execute(pool, &format!(
            "SELECT COMMAND FROM information_schema.PROCESSLIST WHERE ID = {id}"
        )).await.ok()?;
        r.rows.first().and_then(|row| row.first()).map(|v| match v {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        })
    }

    #[tokio::test]
    #[ignore]
    async fn galera_cluster_kill_live_kills_on_the_rows_own_node() {
        let Ok(probe) = crate::db::mysql::open_pool(
            &node_config("probe", 3341), Some("root".into()), None, 1).await
        else {
            println!("no galera1 on 3341 — skipping"); return;
        };
        let dir = std::env::temp_dir().join(format!("txui-kill-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let victim_cfg = node_config("galera2", 3342);
        crate::secretstore::set(&dir, &victim_cfg.keychain_key(), "root").unwrap();
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, dir.clone(), std::collections::HashMap::new());

        // The victim thread: SLEEP(300) on its own connection on galera2.
        let victim = crate::db::mysql::open_pool(
            &node_config("victim", 3342), Some("root".into()), None, 1).await.unwrap();
        let victim_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&victim).await.unwrap();
        let watcher = crate::db::mysql::open_pool(
            &node_config("watcher", 3342), Some("root".into()), None, 1).await.unwrap();
        let sleeper = tokio::spawn({
            let pool = victim.clone();
            async move { let _ = sqlx::query("SELECT SLEEP(300)").execute(&pool).await; }
        });
        // Wait until the sleeper is actually running its query. (sqlx prepares:
        // the processlist COMMAND reads "Execute", not "Query", on MariaDB.)
        let mut running = false;
        for _ in 0..50 {
            let st = thread_state(&watcher, victim_id).await;
            if matches!(st.as_deref(), Some("Query") | Some("Execute")) {
                running = true; break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(running, "the victim never showed up as running");

        // 1) KILL QUERY — aborts the statement, keeps the connection.
        let outcomes = cluster_kill(&state, &victim_cfg, victim_id, "query".into()).await.unwrap();
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].statement, format!("KILL QUERY {victim_id}"));
        assert!(outcomes[0].ok, "query kill failed: {:?}", outcomes[0].error);
        tokio::time::timeout(std::time::Duration::from_secs(10), sleeper).await
            .expect("the aborted SLEEP never returned").unwrap();
        assert!(state.sessions.read().await.is_empty(),
            "the ephemeral session is always torn down");
        // The connection survived: the thread is back to Sleep.
        assert_eq!(thread_state(&watcher, victim_id).await.as_deref(), Some("Sleep"),
            "query mode must keep the connection");

        // 2) KILL — drops the connection outright.
        let outcomes = cluster_kill(&state, &victim_cfg, victim_id, "connection".into()).await.unwrap();
        assert_eq!(outcomes[0].statement, format!("KILL {victim_id}"));
        assert!(outcomes[0].ok, "connection kill failed: {:?}", outcomes[0].error);
        let mut gone = false;
        for _ in 0..50 {
            if thread_state(&watcher, victim_id).await.is_none() { gone = true; break; }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(gone, "the killed connection lingered in the processlist");
        assert!(state.sessions.read().await.is_empty());
        assert!(state.session_meta.read().await.is_empty(), "the guard is cleaned too");

        victim.close().await;
        watcher.close().await;
        probe.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
