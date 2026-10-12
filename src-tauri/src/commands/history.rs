use tauri::State;

use crate::history::{self, DeadlockEvent, DeadlockEventMeta, DigestDelta, DigestRowIn, DigestSnapshotMeta, DigestSnapshotStored, HistoryEntry};
use crate::state::AppState;

#[tauri::command]
pub async fn search_history(
    connection_id: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryEntry>, crate::apperror::AppError> {
    history::search(
        &state.history,
        connection_id.as_deref(),
        query.as_deref(),
        limit.unwrap_or(200),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn delete_history_entry(id: i64, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    history::delete_entry(&state.history, id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn clear_connection_history(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    history::clear_connection(&state.history, &connection_id)
        .await
        .map_err(Into::into)
}

/// Digest stats for one statement shape — the gutter tooltip's "ran N× in
/// history · p95 …" line. The frontend fingerprints the statement it just ran
/// (utils/slowLogParse.fingerprint); the history rows are fingerprinted by the
/// Rust mirror (history::fingerprint_sql). No match → null, never an error:
/// a first-time statement is the common case.
#[tauri::command]
pub async fn history_digest_stats(
    connection_id: String,
    fingerprint: String,
    state: State<'_, AppState>,
) -> Result<Option<history::DigestStats>, crate::apperror::AppError> {
    history::digest_stats(&state.history, &connection_id, &fingerprint)
        .await
        .map_err(Into::into)
}

// ── Digest snapshots (QAN-style persistent store) ───────────────────────────
//
// The persistence half of the digest-history panels: the panel sends the
// capture it just took (cumulative counters), and stored snapshots can later
// be listed, fetched and diffed against each other across restarts.

#[tauri::command]
pub async fn save_digest_snapshot(
    connection_id: String,
    engine: String,
    label: String,
    rows: Vec<DigestRowIn>,
    state: State<'_, AppState>,
) -> Result<i64, crate::apperror::AppError> {
    history::save_digest_snapshot(&state.history, &connection_id, &engine, &label, &rows)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_digest_snapshots(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<DigestSnapshotMeta>, crate::apperror::AppError> {
    history::list_digest_snapshots(&state.history, &connection_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_digest_snapshot(
    id: i64,
    state: State<'_, AppState>,
) -> Result<DigestSnapshotStored, crate::apperror::AppError> {
    history::get_digest_snapshot(&state.history, id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn diff_digest_snapshots(
    before_id: i64,
    after_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<DigestDelta>, crate::apperror::AppError> {
    let before = history::get_digest_snapshot(&state.history, before_id).await?;
    let after = history::get_digest_snapshot(&state.history, after_id).await?;
    Ok(history::diff_digest_rows(&before.rows, &after.rows))
}

#[tauri::command]
pub async fn delete_digest_snapshot(
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    history::delete_digest_snapshot(&state.history, id)
        .await
        .map_err(Into::into)
}

// ── Deadlock events (analyzer history) ───────────────────────────────────────
//
// The persistence half of the Deadlocks panel: it records a parsed deadlock
// (or a PG counter snapshot) on detection, and past events can be listed,
// re-viewed and deleted across restarts. Dedupe and retention live in
// history.rs.

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn record_deadlock_event(
    connection_id: String,
    engine: String,
    detected_at: String,
    victim: String,
    txn_count: i64,
    raw: String,
    parsed: String,
    state: State<'_, AppState>,
) -> Result<Option<i64>, crate::apperror::AppError> {
    history::record_deadlock_event(
        &state.history, &connection_id, &engine, &detected_at, &victim, txn_count, &raw, &parsed,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn list_deadlock_events(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<DeadlockEventMeta>, crate::apperror::AppError> {
    history::list_deadlock_events(&state.history, &connection_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_deadlock_event(
    id: i64,
    state: State<'_, AppState>,
) -> Result<DeadlockEvent, crate::apperror::AppError> {
    history::get_deadlock_event(&state.history, id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn delete_deadlock_event(
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    history::delete_deadlock_event(&state.history, id)
        .await
        .map_err(Into::into)
}

// ── Long-query events (watchdog capture store) ───────────────────────────────
//
// The persistence half of the Long query panel's watchdog: the panel records
// each threshold crossing (its `newOnes`), and the incident timeline reads
// them back as one of its event kinds. Dedupe and retention live in
// history.rs, mirroring the deadlock store.

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn record_long_query_event(
    connection_id: String,
    engine: String,
    db_user: String,
    host: String,
    db: String,
    age_secs: i64,
    sql: String,
    state: State<'_, AppState>,
) -> Result<Option<i64>, crate::apperror::AppError> {
    history::record_long_query_event(
        &state.history, &connection_id, &engine, &db_user, &host, &db, age_secs, &sql,
    )
    .await
    .map_err(Into::into)
}

// ── Galera events (wsrep transition captures) ────────────────────────────────
//
// The persistence half of the Galera dashboard's transition detection: the
// view's 5 s poll diffs consecutive wsrep snapshots (pure
// utils/galeraStatus.ts galeraEventsFromTransition) and records each
// transition fire-and-forget; the incident timeline reads them back as one of
// its event kinds. Dedupe and retention live in history.rs, mirroring the
// long-query store.

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn record_galera_event(
    connection_id: String,
    engine: String,
    event_type: String,
    summary: String,
    detail: String,
    ok: bool,
    state: State<'_, AppState>,
) -> Result<Option<i64>, crate::apperror::AppError> {
    history::record_galera_event(
        &state.history, &connection_id, &engine, &event_type, &summary, &detail, ok,
    )
    .await
    .map_err(Into::into)
}

// ── Incident timeline ────────────────────────────────────────────────────────
//
// One chronological per-connection view over the event stores history.db
// already keeps: audit statements + lifecycle (connect/disconnect), deadlock
// incidents, digest snapshots, multi-server runs, long-query captures and
// Galera transition events — "what happened on this server between 14:00 and
// 14:30?" as one list.
//
// Timestamps are the trap: `datetime('now')` rows (deadlocks, snapshots,
// multi-runs, long queries) are UTC-naive, while audit `started_at` is
// LOCAL-naive (the frontend's isoNow). Every row is normalized to epoch ms
// (`at_ms`) HERE — the frontend never parses a timestamp string.

/// One event of the incident timeline. snake_case on the wire per the
/// struct-payload convention. `id` is a stable key ("audit:1234") so the
/// frontend can key rows; `ref_id` is the source row's id within its store.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TimelineEvent {
    pub id: String,
    /// 'audit' | 'lifecycle' | 'deadlock' | 'digest_snapshot' | 'multi_run' |
    /// 'long_query' | 'galera_event'
    pub kind: String,
    pub at_ms: i64,
    pub title: String,
    pub detail: String,
    pub ok: bool,
    pub duration_ms: i64,
    pub ref_id: i64,
}

/// Each kind is one small query with its own time predicate, capped — seven
/// bounded scans rather than one unbounded UNION the per-kind sort forces
/// into a full table walk.
const TIMELINE_PER_KIND_LIMIT: i64 = 500;
const TIMELINE_DEFAULT_LIMIT: i64 = 500;
const TIMELINE_MAX_LIMIT: i64 = 2000;

/// Audit's frontend rows carry milliseconds ('…:11.123'), the `datetime('now')`
/// stores never do — try the millisecond shape first, then the whole-second.
fn parse_naive(s: &str) -> Option<chrono::NaiveDateTime> {
    for fmt in ["%Y-%m-%d %H:%M:%S%.3f", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(n) = chrono::NaiveDateTime::parse_from_str(s.trim(), fmt) {
            return Some(n);
        }
    }
    None
}

/// Audit `started_at` is local-naive → epoch ms in the machine's zone.
/// `.single()` declines the ambiguous hour of a DST fold rather than guessing.
fn local_text_to_ms(s: &str) -> Option<i64> {
    use chrono::TimeZone;
    chrono::Local
        .from_local_datetime(&parse_naive(s)?)
        .single()
        .map(|d| d.timestamp_millis())
}

/// A `datetime('now')` row is UTC-naive → epoch ms.
fn utc_text_to_ms(s: &str) -> Option<i64> {
    Some(
        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(parse_naive(s)?, chrono::Utc)
            .timestamp_millis(),
    )
}

/// from/to arrive as LOCAL text (the panel's datetime-local inputs). The audit
/// table compares lexicographically in the same local shape, but the UTC
/// stores need the bound converted first.
fn local_text_to_utc_text(s: &str) -> Option<String> {
    use chrono::TimeZone;
    let local = chrono::Local.from_local_datetime(&parse_naive(s)?).single()?;
    Some(
        local
            .with_timezone(&chrono::Utc)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string(),
    )
}

struct KindFilter {
    audit: bool,
    lifecycle: bool,
    deadlock: bool,
    digest_snapshot: bool,
    multi_run: bool,
    long_query: bool,
    galera_event: bool,
}

impl KindFilter {
    /// None / empty list = every kind. Unknown names are ignored, so a newer
    /// frontend asking an older backend for a kind it does not have still gets
    /// the rest of the picture.
    fn parse(kinds: Option<&[String]>) -> Self {
        let all = Self { audit: true, lifecycle: true, deadlock: true,
            digest_snapshot: true, multi_run: true, long_query: true,
            galera_event: true };
        let Some(list) = kinds else { return all };
        if list.is_empty() { return all; }
        Self {
            audit:           list.iter().any(|k| k == "audit"),
            lifecycle:       list.iter().any(|k| k == "lifecycle"),
            deadlock:        list.iter().any(|k| k == "deadlock"),
            digest_snapshot: list.iter().any(|k| k == "digest_snapshot"),
            multi_run:       list.iter().any(|k| k == "multi_run"),
            long_query:      list.iter().any(|k| k == "long_query"),
            galera_event:    list.iter().any(|k| k == "galera_event"),
        }
    }
}

/// The shared shape of the from/to predicates: `?2`/`?3` are the bound range
/// (numbered so one bind serves both mentions, as commands/audit.rs does).
/// `col` differs per store: audit rows may carry milliseconds, so they are
/// compared on their whole-second prefix; the UTC stores are whole-second
/// already, on a bound converted to UTC by the caller. Only fixed column-name
/// literals from this module are ever spliced in — the query is assembled with
/// `format!` and handed to sqlx under `AssertSqlSafe` for exactly that reason.
fn time_predicate(col: &str) -> String {
    format!(
        "AND (?2 IS NULL OR {col} >= ?2) AND (?3 IS NULL OR {col} <= ?3)"
    )
}

#[allow(clippy::too_many_arguments)]
async fn incident_timeline_inner(
    pool: &sqlx::SqlitePool,
    connection_id: &str,
    connection_name: &str,
    from: Option<&str>,
    to: Option<&str>,
    kinds: Option<&[String]>,
    limit: i64,
) -> anyhow::Result<Vec<TimelineEvent>> {
    let filter = KindFilter::parse(kinds);
    let limit = limit.clamp(1, TIMELINE_MAX_LIMIT);
    // Audit's predicate is lexicographic on the LOCAL text as stored; the UTC
    // stores get the same range converted.
    let from_utc = match from {
        Some(f) => Some(local_text_to_utc_text(f)
            .ok_or_else(|| anyhow::anyhow!("invalid 'from' timestamp (want 'YYYY-MM-DD HH:MM:SS')"))?),
        None => None,
    };
    let to_utc = match to {
        Some(t) => Some(local_text_to_utc_text(t)
            .ok_or_else(|| anyhow::anyhow!("invalid 'to' timestamp (want 'YYYY-MM-DD HH:MM:SS')"))?),
        None => None,
    };

    let mut out: Vec<TimelineEvent> = Vec::new();

    // ── audit_log: statements AND lifecycle share the table; the audit spine
    // is keyed by connection NAME (not id — the id is per saved-connection,
    // and the audit row's attribution is the name it ran under). The honest
    // caveat: renaming a connection orphans its old rows from this view.
    if filter.audit || filter.lifecycle {
        use sqlx::Row;
        let sql = format!(
            "SELECT id, source, started_at, duration_ms, ok, error, sql, db_user, database \
             FROM audit_log WHERE connection_name = ?1 {} \
             ORDER BY started_at DESC, id DESC LIMIT ?4",
            time_predicate("substr(started_at, 1, 19)")
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(connection_name)
            .bind(from)
            .bind(to)
            .bind(TIMELINE_PER_KIND_LIMIT)
            .fetch_all(pool)
            .await?;
        for r in &rows {
            let source: String = r.get("source");
            let is_lifecycle = source == "lifecycle";
            if is_lifecycle && !filter.lifecycle { continue; }
            if !is_lifecycle && !filter.audit { continue; }
            let started_at: String = r.get("started_at");
            // A row whose stamp cannot be parsed cannot be placed on a
            // timeline — skip it rather than sort it somewhere wrong.
            let Some(at_ms) = local_text_to_ms(&started_at) else { continue };
            let id: i64 = r.get("id");
            let text: String = r.get("sql");
            let ok = r.get::<i64, _>("ok") != 0;
            let error: Option<String> = r.get("error");
            let (kind, title, detail) = if is_lifecycle {
                let user: String = r.get("db_user");
                let db: String = r.get("database");
                let whereabouts = [user, db].into_iter().filter(|s| !s.is_empty())
                    .collect::<Vec<_>>().join(" · ");
                ("lifecycle", text.clone(),
                 [whereabouts, error.unwrap_or_default()].into_iter()
                    .filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · "))
            } else {
                ("audit", text.clone(), error.unwrap_or_default())
            };
            out.push(TimelineEvent {
                id: format!("{kind}:{id}"),
                kind: kind.to_string(),
                at_ms,
                title,
                detail,
                ok,
                duration_ms: r.get("duration_ms"),
                ref_id: id,
            });
        }
    }

    // ── deadlock_events (UTC store, connection-id scoped).
    if filter.deadlock {
        use sqlx::Row;
        let sql = format!(
            "SELECT id, engine, detected_at, victim, txn_count, created_at \
             FROM deadlock_events WHERE connection_id = ?1 {} \
             ORDER BY created_at DESC, id DESC LIMIT ?4",
            time_predicate("created_at")
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(connection_id)
            .bind(&from_utc)
            .bind(&to_utc)
            .bind(TIMELINE_PER_KIND_LIMIT)
            .fetch_all(pool)
            .await?;
        for r in &rows {
            let created_at: String = r.get("created_at");
            let Some(at_ms) = utc_text_to_ms(&created_at) else { continue };
            let id: i64 = r.get("id");
            let victim: String = r.get("victim");
            let detected_at: String = r.get("detected_at");
            let txn_count: i64 = r.get("txn_count");
            let title = if victim.is_empty() {
                "Deadlock".to_string()
            } else {
                format!("Deadlock — victim {victim}")
            };
            let detail = [
                if detected_at.is_empty() { String::new() } else { format!("server reported {detected_at}") },
                if txn_count > 0 { format!("{txn_count} transactions") } else { String::new() },
            ].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
            out.push(TimelineEvent {
                id: format!("deadlock:{id}"),
                kind: "deadlock".to_string(),
                at_ms,
                title,
                detail,
                // A deadlock is an incident, never a green row.
                ok: false,
                duration_ms: 0,
                ref_id: id,
            });
        }
    }

    // ── digest_snapshots (UTC store).
    if filter.digest_snapshot {
        use sqlx::Row;
        let sql = format!(
            "SELECT s.id, s.engine, s.label, s.created_at, \
                    (SELECT COUNT(*) FROM digest_snapshot_rows r WHERE r.snapshot_id = s.id) AS rows_count \
             FROM digest_snapshots s WHERE s.connection_id = ?1 {} \
             ORDER BY s.created_at DESC, s.id DESC LIMIT ?4",
            time_predicate("s.created_at")
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(connection_id)
            .bind(&from_utc)
            .bind(&to_utc)
            .bind(TIMELINE_PER_KIND_LIMIT)
            .fetch_all(pool)
            .await?;
        for r in &rows {
            let created_at: String = r.get("created_at");
            let Some(at_ms) = utc_text_to_ms(&created_at) else { continue };
            let id: i64 = r.get("id");
            let label: String = r.get("label");
            let rows_count: i64 = r.get("rows_count");
            let title = if label.is_empty() {
                "Digest snapshot".to_string()
            } else {
                format!("Digest snapshot — {label}")
            };
            out.push(TimelineEvent {
                id: format!("digest_snapshot:{id}"),
                kind: "digest_snapshot".to_string(),
                at_ms,
                title,
                detail: format!("{rows_count} statement digests"),
                ok: true,
                duration_ms: 0,
                ref_id: id,
            });
        }
    }

    // ── multi_runs: one event per run this connection took part in, the
    // run-wide ok/err counts on the title (UTC store).
    if filter.multi_run {
        use sqlx::Row;
        let sql = format!(
            "SELECT m.id, m.sql, m.total, m.ok_count, m.err_count, m.total_ms, m.created_at \
             FROM multi_runs m \
             WHERE EXISTS (SELECT 1 FROM multi_run_results r \
                           WHERE r.run_id = m.id AND r.connection_id = ?1) {} \
             ORDER BY m.created_at DESC, m.id DESC LIMIT ?4",
            time_predicate("m.created_at")
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(connection_id)
            .bind(&from_utc)
            .bind(&to_utc)
            .bind(TIMELINE_PER_KIND_LIMIT)
            .fetch_all(pool)
            .await?;
        for r in &rows {
            let created_at: String = r.get("created_at");
            let Some(at_ms) = utc_text_to_ms(&created_at) else { continue };
            let id: i64 = r.get("id");
            let ok_count: i64 = r.get("ok_count");
            let err_count: i64 = r.get("err_count");
            let total: i64 = r.get("total");
            out.push(TimelineEvent {
                id: format!("multi_run:{id}"),
                kind: "multi_run".to_string(),
                at_ms,
                title: format!("Multi-run — {ok_count} ok, {err_count} failed of {total}"),
                detail: r.get("sql"),
                ok: err_count == 0,
                duration_ms: r.get("total_ms"),
                ref_id: id,
            });
        }
    }

    // ── long_query_events (UTC store).
    if filter.long_query {
        use sqlx::Row;
        let sql = format!(
            "SELECT id, db_user, host, db, age_secs, sql, created_at \
             FROM long_query_events WHERE connection_id = ?1 {} \
             ORDER BY created_at DESC, id DESC LIMIT ?4",
            time_predicate("created_at")
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(connection_id)
            .bind(&from_utc)
            .bind(&to_utc)
            .bind(TIMELINE_PER_KIND_LIMIT)
            .fetch_all(pool)
            .await?;
        for r in &rows {
            let created_at: String = r.get("created_at");
            let Some(at_ms) = utc_text_to_ms(&created_at) else { continue };
            let id: i64 = r.get("id");
            let user: String = r.get("db_user");
            let host: String = r.get("host");
            let age_secs: i64 = r.get("age_secs");
            let who = [user, host].into_iter().filter(|s| !s.is_empty())
                .collect::<Vec<_>>().join("@");
            out.push(TimelineEvent {
                id: format!("long_query:{id}"),
                kind: "long_query".to_string(),
                at_ms,
                title: format!("Long query — {age_secs}s{}", if who.is_empty() { String::new() } else { format!(" by {who}") }),
                detail: r.get("sql"),
                ok: true,
                // Age at detection, as a duration the row can show.
                duration_ms: age_secs * 1000,
                ref_id: id,
            });
        }
    }

    // ── galera_events (UTC store). `ok` comes from the row: a node returning
    // to Synced is a green event, leaving it is not.
    if filter.galera_event {
        use sqlx::Row;
        let sql = format!(
            "SELECT id, event_type, summary, detail, ok, created_at \
             FROM galera_events WHERE connection_id = ?1 {} \
             ORDER BY created_at DESC, id DESC LIMIT ?4",
            time_predicate("created_at")
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(connection_id)
            .bind(&from_utc)
            .bind(&to_utc)
            .bind(TIMELINE_PER_KIND_LIMIT)
            .fetch_all(pool)
            .await?;
        for r in &rows {
            let created_at: String = r.get("created_at");
            let Some(at_ms) = utc_text_to_ms(&created_at) else { continue };
            let id: i64 = r.get("id");
            out.push(TimelineEvent {
                id: format!("galera_event:{id}"),
                kind: "galera_event".to_string(),
                at_ms,
                title: r.get("summary"),
                detail: r.get("detail"),
                ok: r.get::<i64, _>("ok") != 0,
                duration_ms: 0,
                ref_id: id,
            });
        }
    }

    // Newest first; the id breaks ties deterministically (same-millisecond
    // events from different stores must not shimmer between refreshes).
    out.sort_by(|a, b| b.at_ms.cmp(&a.at_ms).then_with(|| a.id.cmp(&b.id)));
    out.truncate(limit as usize);
    Ok(out)
}

/// The incident timeline for one connection. Read-only; from/to are LOCAL
/// 'YYYY-MM-DD HH:MM:SS' text (the panel's datetime-local inputs), `kinds`
/// selects event kinds (None/empty = all), `limit` clamps to 2000.
#[tauri::command]
pub async fn incident_timeline(
    connection_id: String,
    connection_name: String,
    from: Option<String>,
    to: Option<String>,
    kinds: Option<Vec<String>>,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<TimelineEvent>, crate::apperror::AppError> {
    incident_timeline_inner(
        &state.history,
        &connection_id,
        &connection_name,
        from.as_deref(),
        to.as_deref(),
        kinds.as_deref(),
        limit.unwrap_or(TIMELINE_DEFAULT_LIMIT),
    )
    .await
    .map_err(Into::into)
}

#[cfg(test)]
mod incident_timeline_tests {
    use super::*;
    use sqlx::Row;

    async fn store() -> sqlx::SqlitePool {
        history::open_in_memory().await.expect("in-memory history db")
    }

    /// Insert an audit row (LOCAL-naive stamp, the frontend's isoNow shape).
    #[allow(clippy::too_many_arguments)]
    async fn audit_row(
        pool: &sqlx::SqlitePool, conn_name: &str, source: &str, started_at: &str,
        ok: i64, sql: &str, error: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO audit_log \
             (run_id, session_id, tab_title, database, source, started_at, ended_at, \
              duration_ms, connection_name, db_user, engine, ok, rows_out, sql, error) \
             VALUES ('', 's', '', 'app', ?, ?, ?, 42, ?, 'root', 'mysql', ?, 1, ?, ?)"
        )
        .bind(source).bind(started_at).bind(started_at)
        .bind(conn_name).bind(ok).bind(sql).bind(error)
        .execute(pool).await.unwrap();
    }

    async fn deadlock_row(pool: &sqlx::SqlitePool, conn_id: &str, created_at: &str, victim: &str) {
        sqlx::query(
            "INSERT INTO deadlock_events (connection_id, engine, detected_at, victim, txn_count, raw, parsed, created_at) \
             VALUES (?, 'mysql', '2026-03-14 12:00:01 srv', ?, 2, 'raw', '', ?)"
        )
        .bind(conn_id).bind(victim).bind(created_at)
        .execute(pool).await.unwrap();
    }

    async fn long_query_row(pool: &sqlx::SqlitePool, conn_id: &str, created_at: &str) {
        sqlx::query(
            "INSERT INTO long_query_events (connection_id, engine, db_user, host, db, age_secs, sql, created_at) \
             VALUES (?, 'mysql', 'app', '10.0.0.4:1', 'shop', 75, 'UPDATE orders SET x = 1', ?)"
        )
        .bind(conn_id).bind(created_at)
        .execute(pool).await.unwrap();
    }

    async fn galera_row(pool: &sqlx::SqlitePool, conn_id: &str, created_at: &str, ok: i64) {
        sqlx::query(
            "INSERT INTO galera_events (connection_id, engine, event_type, summary, detail, ok, created_at) \
             VALUES (?, 'mysql', 'local_state', 'Node left Synced → Donor/Desynced (donating SST)', 'node galera1', ?, ?)"
        )
        .bind(conn_id).bind(ok).bind(created_at)
        .execute(pool).await.unwrap();
    }

    /// Mixed UTC/local fixture, stamped far enough apart (≈2 days) that the
    /// ordering holds in every timezone a test machine could sit in:
    ///   audit       LOCAL '2026-03-10 12:00:00.000'  (oldest, in any zone)
    ///   long_query  UTC   '2026-03-12 12:00:00'      (middle)
    ///   deadlock    UTC   '2026-03-14 12:00:00'      (newest)
    async fn fixture(pool: &sqlx::SqlitePool) {
        audit_row(pool, "prod", "editor", "2026-03-10 12:00:00.000", 1, "SELECT 1", None).await;
        audit_row(pool, "prod", "lifecycle", "2026-03-10 12:00:01.000", 1, "connect", None).await;
        long_query_row(pool, "c1", "2026-03-12 12:00:00").await;
        deadlock_row(pool, "c1", "2026-03-14 12:00:00", "(2) · thread 813").await;
        // Noise that belongs to somebody else.
        audit_row(pool, "staging", "editor", "2026-03-11 12:00:00.000", 1, "SELECT 2", None).await;
        deadlock_row(pool, "c2", "2026-03-13 12:00:00", "(1)").await;
        long_query_row(pool, "c2", "2026-03-13 12:00:00").await;
    }

    #[tokio::test]
    async fn mixed_utc_and_local_rows_merge_into_one_order() {
        let pool = store().await;
        fixture(&pool).await;
        let events = incident_timeline_inner(&pool, "c1", "prod", None, None, None, 500)
            .await.unwrap();
        assert_eq!(events.len(), 4, "only this connection's rows: {events:?}");
        // at_ms is epoch — the merge is correctly ordered even though the
        // source stamps mixed UTC and local time.
        assert!(events.windows(2).all(|w| w[0].at_ms >= w[1].at_ms),
            "newest first: {:?}", events.iter().map(|e| e.at_ms).collect::<Vec<_>>());
        assert_eq!(events[0].kind, "deadlock");
        assert_eq!(events[1].kind, "long_query");
        // The audit statement and the lifecycle connect sit last, audit first
        // (12:00:00 before 12:00:01 — the millisecond the lexicographic
        // whole-second predicate cannot see but the epoch merge can).
        assert_eq!(events[2].kind, "lifecycle");
        assert_eq!(events[3].kind, "audit");
        assert_eq!(events[3].id, format!("audit:{}", events[3].ref_id));
        // A deadlock is never a green row; a lifecycle connect is.
        assert!(!events[0].ok);
        assert!(events[2].ok);
    }

    #[tokio::test]
    async fn range_filter_boundaries_are_inclusive_on_both_ends() {
        let pool = store().await;
        fixture(&pool).await;
        // from/to are LOCAL text, inclusive — the audit row stamped exactly
        // '2026-03-10 12:00:00(.000)' survives a bound equal to its own second.
        let exact = incident_timeline_inner(
            &pool, "c1", "prod",
            Some("2026-03-10 12:00:00"), Some("2026-03-10 12:00:00"), None, 500)
            .await.unwrap();
        assert!(exact.iter().any(|e| e.kind == "audit"),
            "a bound equal to the row's own second must include it: {exact:?}");

        // A window that brackets only the middle event, wide enough (±12 h)
        // that no machine timezone moves a boundary across it.
        let mid = incident_timeline_inner(
            &pool, "c1", "prod",
            Some("2026-03-11 12:00:00"), Some("2026-03-13 12:00:00"), None, 500)
            .await.unwrap();
        assert_eq!(mid.len(), 1, "only the long query falls inside: {mid:?}");
        assert_eq!(mid[0].kind, "long_query");
    }

    #[tokio::test]
    async fn other_connections_never_leak_in() {
        let pool = store().await;
        fixture(&pool).await;
        let events = incident_timeline_inner(&pool, "c2", "staging", None, None, None, 500)
            .await.unwrap();
        assert_eq!(events.len(), 3, "staging/c2's own rows only: {events:?}");
        assert!(events.iter().all(|e| !e.title.contains("SELECT 1")));
        assert!(events.iter().any(|e| e.kind == "deadlock"));
        assert!(events.iter().any(|e| e.kind == "long_query"));
        assert!(events.iter().any(|e| e.kind == "audit"));
    }

    #[tokio::test]
    async fn kinds_filter_selects_event_sources() {
        let pool = store().await;
        fixture(&pool).await;
        let only = incident_timeline_inner(
            &pool, "c1", "prod", None, None,
            Some(&["deadlock".to_string()]), 500)
            .await.unwrap();
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].kind, "deadlock");
        assert_eq!(only[0].title, "Deadlock — victim (2) · thread 813");

        // audit without lifecycle: the connect row stays out.
        let statements = incident_timeline_inner(
            &pool, "c1", "prod", None, None,
            Some(&["audit".to_string()]), 500)
            .await.unwrap();
        assert_eq!(statements.len(), 1);
        assert_eq!(statements[0].kind, "audit");

        // An unknown kind name is ignored, not an error.
        let none = incident_timeline_inner(
            &pool, "c1", "prod", None, None,
            Some(&["nonsense".to_string()]), 500)
            .await.unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn multi_runs_and_snapshots_join_the_timeline() {
        let pool = store().await;
        sqlx::query(
            "INSERT INTO multi_runs (sql, total, ok_count, err_count, total_ms, created_at) \
             VALUES ('SELECT 1', 3, 2, 1, 900, '2026-03-12 06:00:00')"
        ).execute(&pool).await.unwrap();
        let run_id: i64 = sqlx::query_scalar("SELECT last_insert_rowid()")
            .fetch_one(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO multi_run_results (run_id, connection_id, connection_name, ok, rows_returned, execution_ms) \
             VALUES (?, 'c1', 'prod', 0, 0, 300)"
        ).bind(run_id).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO digest_snapshots (connection_id, engine, label, created_at) \
             VALUES ('c1', 'mysql', 'before deploy', '2026-03-12 07:00:00')"
        ).execute(&pool).await.unwrap();

        let events = incident_timeline_inner(&pool, "c1", "prod", None, None, None, 500)
            .await.unwrap();
        let run = events.iter().find(|e| e.kind == "multi_run").expect("multi_run event");
        assert_eq!(run.title, "Multi-run — 2 ok, 1 failed of 3");
        assert!(!run.ok, "a run with a failure is not a green row");
        assert_eq!(run.duration_ms, 900);
        let snap = events.iter().find(|e| e.kind == "digest_snapshot").expect("snapshot event");
        assert_eq!(snap.title, "Digest snapshot — before deploy");
        assert_eq!(snap.detail, "0 statement digests");

        // The run belongs to c1's timeline, not to a connection that played
        // no part in it.
        let other = incident_timeline_inner(&pool, "cX", "prod", None, None,
            Some(&["multi_run".to_string()]), 500).await.unwrap();
        assert!(other.is_empty());
    }

    #[tokio::test]
    async fn galera_events_join_the_timeline() {
        let pool = store().await;
        galera_row(&pool, "c1", "2026-03-13 12:00:00", 0).await;
        galera_row(&pool, "c2", "2026-03-13 13:00:00", 1).await; // somebody else's

        let events = incident_timeline_inner(&pool, "c1", "prod", None, None,
            Some(&["galera_event".to_string()]), 500).await.unwrap();
        assert_eq!(events.len(), 1, "only this connection's galera rows: {events:?}");
        assert_eq!(events[0].kind, "galera_event");
        assert_eq!(events[0].id, format!("galera_event:{}", events[0].ref_id));
        assert_eq!(events[0].title, "Node left Synced → Donor/Desynced (donating SST)");
        assert_eq!(events[0].detail, "node galera1");
        assert!(!events[0].ok, "leaving Synced is not a green row");
        assert!(events[0].at_ms > 0, "UTC stamp normalized to epoch ms");
    }

    #[tokio::test]
    async fn galera_events_merge_with_the_other_kinds_in_order() {
        let pool = store().await;
        fixture(&pool).await;
        // Stamped between the long query (03-12) and the deadlock (03-14).
        galera_row(&pool, "c1", "2026-03-13 12:00:00", 0).await;
        let events = incident_timeline_inner(&pool, "c1", "prod", None, None, None, 500)
            .await.unwrap();
        assert_eq!(events.len(), 5, "the galera row joins the merge: {events:?}");
        assert_eq!(events[1].kind, "galera_event",
            "between deadlock (newest) and long query: {:?}",
            events.iter().map(|e| &e.kind).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn limit_clamps_the_merged_list() {
        let pool = store().await;
        fixture(&pool).await;
        let one = incident_timeline_inner(&pool, "c1", "prod", None, None, None, 1)
            .await.unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].kind, "deadlock", "the newest event survives the cap");

        let row = sqlx::query("SELECT COUNT(*) AS n FROM audit_log")
            .fetch_one(&pool).await.unwrap();
        assert!(row.get::<i64, _>("n") > 1, "fixture sanity");
    }
}
