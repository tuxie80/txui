use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sqlx::Connection;
use uuid::Uuid;

use crate::apperror::{AppError, ErrorCode};
use crate::db::types::{Engine, LiveSession, QueryResult};
use crate::state::AppState;

const MAX_QUERY_LAB_SQL_BYTES: usize = 2 * 1024 * 1024;
const MAX_PLAN_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabEvidenceInput {
    pub plan: bool,
    pub cost: bool,
    pub timing: bool,
    pub buffers: bool,
    pub result_equality: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabScratchInput {
    pub session_id: Uuid,
    pub connection_id: Uuid,
    pub database: String,
    pub environment: Option<String>,
    pub read_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabBaselineInput {
    pub session_id: Uuid,
    pub connection_id: Uuid,
    pub run_key: String,
    pub engine: String,
    pub database: String,
    pub sql: String,
    pub spec_sha256: String,
    pub execution_mode: String,
    pub index_evidence_mode: String,
    pub timeout_ms: u64,
    pub evidence: QueryLabEvidenceInput,
    pub has_rewrite_candidate: bool,
    pub scratch: Option<QueryLabScratchInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabPlanEvidence {
    pub label: String,
    pub format: String,
    pub content: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabSetting {
    pub name: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabCleanup {
    pub timeout_restored: bool,
    pub connection_closed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabBaselineResponse {
    pub run_key: String,
    pub spec_sha256: String,
    pub execution_mode: String,
    pub index_evidence_mode: String,
    pub comparison_policy: String,
    pub database: String,
    pub engine: String,
    pub version: String,
    pub backend_id: u64,
    pub timeout_ms: u64,
    pub estimated_plan: QueryLabPlanEvidence,
    pub measured_plan: Option<QueryLabPlanEvidence>,
    pub cost_estimates: bool,
    pub settings: Vec<QueryLabSetting>,
    pub cache_observations: Vec<String>,
    pub cleanup: QueryLabCleanup,
}

struct ValidatedInput {
    timeout_ms: u64,
    engine: Engine,
}

struct CaptureParts {
    estimated_plan: QueryLabPlanEvidence,
    measured_plan: Option<QueryLabPlanEvidence>,
    version: String,
    backend_id: u64,
    settings: Vec<QueryLabSetting>,
}

fn plan_text(result: &QueryResult) -> Result<String, AppError> {
    let text = result.rows.iter()
        .filter_map(|row| row.last())
        .map(|value| match value {
            serde_json::Value::String(text) => text.clone(),
            other => serde_json::to_string(other).unwrap_or_default(),
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        return Err(AppError::local("Query Lab received an empty plan"));
    }
    if text.len() > MAX_PLAN_BYTES {
        return Err(AppError::local("Query Lab plan exceeds the 4 MiB evidence limit"));
    }
    Ok(text)
}

fn estimated(label: &str, format: &str, content: String, elapsed_ms: u64) -> QueryLabPlanEvidence {
    QueryLabPlanEvidence { label: label.into(), format: format.into(), content, elapsed_ms }
}

async fn validate_input(input: &QueryLabBaselineInput, state: &AppState) -> Result<ValidatedInput, AppError> {
    Uuid::parse_str(&input.run_key).map_err(|_| AppError::bad_request("Query Lab run key must be a UUID"))?;
    if input.sql.len() > MAX_QUERY_LAB_SQL_BYTES {
        return Err(AppError::bad_request("Query Lab SQL exceeds the 2 MiB limit"));
    }
    if input.spec_sha256.len() != 64 || !input.spec_sha256.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(AppError::bad_request("Query Lab spec hash must be 64 hexadecimal characters"));
    }
    let statements = crate::sqlguard::split_statements_for(None, &input.sql);
    if statements.len() != 1 || !crate::sqlguard::is_read_family(&input.sql)
        || crate::sqlguard::is_write_for(None, &input.sql)
    {
        return Err(AppError::guard("Query Lab baseline accepts exactly one read-only statement"));
    }
    let guard = state.session_meta.read().await.get(&input.session_id).cloned()
        .ok_or_else(|| AppError::bad_request("Query Lab session is not open"))?;
    if !matches!(guard.engine, Engine::Mysql | Engine::Postgres) {
        return Err(AppError::unsupported("Query Lab supports MySQL/MariaDB and PostgreSQL only"));
    }
    if guard.engine.wire_name() != input.engine {
        return Err(AppError::guard("Query Lab engine changed between specification and execution"));
    }
    let starts = state.session_starts.read().await;
    let start = starts.get(&input.session_id)
        .ok_or_else(|| AppError::bad_request("Query Lab connection identity is unavailable"))?;
    if start.connection_id != input.connection_id {
        return Err(AppError::guard("Query Lab connection ID does not match the open session"));
    }
    drop(starts);
    if input.execution_mode != "estimate" && input.execution_mode != "measured" {
        return Err(AppError::bad_request("Query Lab execution mode must be estimate or measured"));
    }
    if !matches!(input.index_evidence_mode.as_str(), "none" | "hypothetical" | "real") {
        return Err(AppError::bad_request("Query Lab index evidence mode must be none, hypothetical or real"));
    }
    if input.execution_mode == "estimate" && input.index_evidence_mode == "real" {
        return Err(AppError::guard("Real-index measured evidence is incompatible with estimate mode"));
    }
    if input.execution_mode == "measured" && input.index_evidence_mode == "hypothetical" {
        return Err(AppError::guard("Hypothetical index evidence cannot produce measured runtime plans"));
    }
    if input.index_evidence_mode == "hypothetical" && guard.engine != Engine::Postgres {
        return Err(AppError::guard("Hypothetical index estimates are PostgreSQL-only"));
    }
    if !input.evidence.plan {
        return Err(AppError::bad_request("Query Lab estimated-plan evidence is required"));
    }
    if input.execution_mode == "estimate"
        && (input.evidence.timing || input.evidence.buffers || input.evidence.result_equality)
    {
        return Err(AppError::bad_request("Query Lab estimate mode accepts plan/cost evidence only"));
    }
    if input.execution_mode == "measured" {
        if !input.evidence.timing {
            return Err(AppError::bad_request("Query Lab measured mode requires timing evidence"));
        }
        if input.has_rewrite_candidate && !input.evidence.result_equality {
            return Err(AppError::bad_request("Query Lab measured rewrites require result-equality evidence"));
        }
        let scratch = input.scratch.as_ref()
            .ok_or_else(|| AppError::bad_request("Query Lab measured mode requires an explicit scratch target"))?;
        if scratch.session_id != input.session_id || scratch.connection_id != input.connection_id {
            return Err(AppError::guard("Query Lab scratch identity does not match the open session"));
        }
        if scratch.database != input.database {
            return Err(AppError::guard("Query Lab scratch database does not match the experiment database"));
        }
        if scratch.environment.as_deref() == Some("prod") {
            return Err(AppError::guard("Query Lab measured experiments require a non-production scratch target"));
        }
        if scratch.read_only {
            return Err(AppError::guard("Query Lab measured scratch target must be writable"));
        }
    }
    state.guard_statement(&input.session_id, &input.sql).await?;
    Ok(ValidatedInput {
        timeout_ms: input.timeout_ms.clamp(100, 60_000),
        engine: guard.engine,
    })
}

async fn mysql_statement(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<QueryResult, AppError> {
    tokio::select! {
        result = crate::db::mysql::execute(conn, sql) => result.map_err(Into::into),
        _ = cancel => Err(AppError::new(ErrorCode::Cancelled, "Query Lab baseline was cancelled")),
    }
}

async fn pg_statement(
    conn: &mut sqlx::PgConnection,
    sql: &str,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<QueryResult, AppError> {
    tokio::select! {
        result = crate::db::postgres::execute(conn, sql) => result.map_err(Into::into),
        _ = cancel => Err(AppError::new(ErrorCode::Cancelled, "Query Lab baseline was cancelled")),
    }
}

async fn mysql_measured_statement(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    timeout_ms: u64,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<QueryResult, AppError> {
    match tokio::time::timeout(Duration::from_millis(timeout_ms), mysql_statement(conn, sql, cancel)).await {
        Ok(result) => result,
        Err(_) => Err(AppError::new(ErrorCode::Timeout, "Query Lab measured plan exceeded its timeout")),
    }
}

async fn pg_measured_statement(
    conn: &mut sqlx::PgConnection,
    sql: &str,
    timeout_ms: u64,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<QueryResult, AppError> {
    match tokio::time::timeout(Duration::from_millis(timeout_ms), pg_statement(conn, sql, cancel)).await {
        Ok(result) => result,
        Err(_) => Err(AppError::new(ErrorCode::Timeout, "Query Lab measured plan exceeded its timeout")),
    }
}

async fn mysql_capture(
    input: &QueryLabBaselineInput,
    pool: &sqlx::MySqlPool,
    validated: &ValidatedInput,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<CaptureParts, AppError> {
    let mut conn = pool.acquire().await.map_err(|error| AppError::local(format!("Query Lab could not acquire its dedicated connection: {error}")))?.detach();
    let maria = "mariadb";
    let version = sqlx::query_scalar::<_, String>("SELECT VERSION()")
        .fetch_one(&mut conn).await?;
    let is_maria = version.to_lowercase().contains(maria);
    let previous_timeout = if is_maria {
        sqlx::query_scalar::<_, f64>("SELECT @@max_statement_time").fetch_one(&mut conn).await?
    } else {
        sqlx::query_scalar::<_, f64>("SELECT CAST(@@max_execution_time AS DOUBLE)").fetch_one(&mut conn).await? / 1000.0
    };
    let result: Result<CaptureParts, AppError> = async {
        let backend_id = sqlx::query_scalar::<_, u64>("SELECT CONNECTION_ID()")
            .fetch_one(&mut conn).await?;
        crate::db::mysql::execute(&mut conn, &format!("USE `{}`", input.database.replace('`', "``"))).await?;
        let buffer_pool = sqlx::query_scalar::<_, Option<String>>("SELECT CAST(@@innodb_buffer_pool_size AS CHAR)")
            .fetch_one(&mut conn).await?;
        if is_maria {
            crate::db::mysql::execute(&mut conn, &format!("SET SESSION max_statement_time={}", validated.timeout_ms as f64 / 1000.0)).await?;
        } else {
            crate::db::mysql::execute(&mut conn, &format!("SET SESSION max_execution_time={}", validated.timeout_ms)).await?;
        }
        let started = Instant::now();
        let estimated_result = mysql_statement(&mut conn, &format!("EXPLAIN FORMAT=JSON {}", input.sql), cancel).await?;
        let estimated_plan = estimated("estimated", "json", plan_text(&estimated_result)?, started.elapsed().as_millis() as u64);
        let measured_plan = if input.execution_mode == "measured" {
            let (_, explain) = crate::commands::quality::mysql_analyze_statements(&version, &input.sql, validated.timeout_ms);
            let started = Instant::now();
            let measured = mysql_measured_statement(&mut conn, &explain, validated.timeout_ms, cancel).await?;
            Some(estimated("executed_query", if is_maria { "json" } else { "text" }, plan_text(&measured)?, started.elapsed().as_millis() as u64))
        } else {
            None
        };
        Ok(CaptureParts {
            estimated_plan,
            measured_plan,
            version: version.clone(),
            backend_id,
            settings: vec![
                QueryLabSetting { name: "innodb_buffer_pool_size".into(), value: buffer_pool },
                QueryLabSetting { name: if is_maria { "max_statement_time".into() } else { "max_execution_time".into() }, value: Some(validated.timeout_ms.to_string()) },
            ],
        })
    }.await;
    let restored = async {
        let seconds = previous_timeout;
        if version.to_lowercase().contains(maria) {
            crate::db::mysql::execute(&mut conn, &format!("SET SESSION max_statement_time={seconds}")).await?;
        } else {
            crate::db::mysql::execute(&mut conn, &format!("SET SESSION max_execution_time={}", (seconds * 1000.0) as u64)).await?;
        }
        Ok::<(), AppError>(())
    }.await;
    let closed = conn.close().await.is_ok();
    let mut parts = result?;
    if restored.is_err() || !closed {
        return Err(AppError::local("Query Lab connection cleanup was incomplete"));
    }
    parts.settings.push(QueryLabSetting { name: "cleanup".into(), value: Some("timeout restored and dedicated connection closed".into()) });
    Ok(parts)
}

fn pg_option_fallback_sql(error_message: &str, sql: &str) -> Option<String> {
    error_message.contains("EXPLAIN option")
        .then(|| format!("EXPLAIN (ANALYZE, BUFFERS) {sql}"))
}

async fn pg_capture(
    input: &QueryLabBaselineInput,
    pool: &sqlx::PgPool,
    validated: &ValidatedInput,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<CaptureParts, AppError> {
    let mut conn = pool.acquire().await.map_err(|error| AppError::local(format!("Query Lab could not acquire its dedicated connection: {error}")))?.detach();
    let version = sqlx::query_scalar::<_, String>("SELECT version()")
        .fetch_one(&mut conn).await?;
    let previous_timeout = sqlx::query_scalar::<_, String>("SHOW statement_timeout")
        .fetch_one(&mut conn).await?;
    let result: Result<CaptureParts, AppError> = async {
        let backend_id = sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
            .fetch_one(&mut conn).await? as u64;
        crate::db::postgres::execute(&mut conn, &format!("SET search_path TO \"{}\"", input.database.replace('"', "\"\""))).await?;
        crate::db::postgres::execute(&mut conn, &format!("SET statement_timeout = {}", validated.timeout_ms)).await?;
        let started = Instant::now();
        let estimated_result = pg_statement(&mut conn, &format!("EXPLAIN (FORMAT JSON) {}", input.sql), cancel).await?;
        let estimated_plan = estimated("estimated", "json", plan_text(&estimated_result)?, started.elapsed().as_millis() as u64);
        let measured_plan = if input.execution_mode == "measured" {
            let started = Instant::now();
            let full = format!("EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS) {}", input.sql);
            let measured = match pg_measured_statement(&mut conn, &full, validated.timeout_ms, cancel).await {
                Err(error) if let Some(fallback) = pg_option_fallback_sql(&error.message, &input.sql) => {
                    pg_measured_statement(&mut conn, &fallback, validated.timeout_ms, cancel).await?
                }
                other => other?,
            };
            Some(estimated("executed_query", "json", plan_text(&measured)?, started.elapsed().as_millis() as u64))
        } else {
            None
        };
        let settings = sqlx::query_as::<_, (String, String, String)>(
            "SELECT current_setting('shared_buffers'), current_setting('work_mem'), current_setting('effective_cache_size')",
        ).fetch_one(&mut conn).await?;
        Ok(CaptureParts {
            estimated_plan,
            measured_plan,
            version,
            backend_id,
            settings: vec![
                QueryLabSetting { name: "shared_buffers".into(), value: Some(settings.0) },
                QueryLabSetting { name: "work_mem".into(), value: Some(settings.1) },
                QueryLabSetting { name: "effective_cache_size".into(), value: Some(settings.2) },
                QueryLabSetting { name: "statement_timeout".into(), value: Some(validated.timeout_ms.to_string()) },
            ],
        })
    }.await;
    let restored = sqlx::query("SELECT set_config('statement_timeout', $1, false)")
        .bind(previous_timeout).execute(&mut conn).await;
    let closed = conn.close().await.is_ok();
    let mut parts = result?;
    if restored.is_err() || !closed {
        return Err(AppError::local("Query Lab connection cleanup was incomplete"));
    }
    parts.settings.push(QueryLabSetting { name: "cleanup".into(), value: Some("statement_timeout restored and dedicated connection closed".into()) });
    Ok(parts)
}

fn comparison_policy(index_evidence_mode: &str) -> String {
    match index_evidence_mode {
        "hypothetical" => "Hypothetical index: plan/cost evidence only; measured runtime comparison is forbidden".into(),
        "real" => "Real index on scratch: measured runtime evidence is permitted".into(),
        _ => "No index candidate: query plan evidence only".into(),
    }
}

fn cache_observations(mode: &str) -> Vec<String> {
    let mut observations = vec![
        "One dedicated Lab connection; no session timeout or search-path state leaks into the pool".into(),
        "No complete cache control or cold/warm-cache claim is made".into(),
    ];
    if mode == "measured" {
        observations.push("EXPLAIN ANALYZE executed the read-only statement once; one execution is not a cache benchmark".into());
    } else {
        observations.push("Estimated plan only: the statement was not executed and no runtime improvement is implied".into());
    }
    observations
}

async fn baseline_inner(
    input: QueryLabBaselineInput,
    state: &AppState,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<QueryLabBaselineResponse, AppError> {
    let validated = validate_input(&input, state).await?;
    let session = crate::db::connection::get_session_pub(input.session_id, &state.sessions).await?;
    let parts = match session.as_ref() {
        LiveSession::Mysql(pool) => mysql_capture(&input, pool, &validated, cancel).await?,
        LiveSession::Postgres(pool) => pg_capture(&input, pool, &validated, cancel).await?,
        _ => return Err(AppError::unsupported("Query Lab supports MySQL/MariaDB and PostgreSQL only")),
    };
    Ok(QueryLabBaselineResponse {
        run_key: input.run_key,
        spec_sha256: input.spec_sha256,
        execution_mode: input.execution_mode.clone(),
        index_evidence_mode: input.index_evidence_mode.clone(),
        comparison_policy: comparison_policy(&input.index_evidence_mode),
        database: input.database,
        engine: validated.engine.wire_name().into(),
        version: parts.version,
        backend_id: parts.backend_id,
        timeout_ms: validated.timeout_ms,
        estimated_plan: parts.estimated_plan,
        measured_plan: parts.measured_plan,
        cost_estimates: input.evidence.cost,
        settings: parts.settings,
        cache_observations: cache_observations(&input.execution_mode),
        cleanup: QueryLabCleanup { timeout_restored: true, connection_closed: true },
    })
}

async fn audit_baseline(
    state: &AppState,
    input: &QueryLabBaselineInput,
    started: Instant,
    result: &Result<QueryLabBaselineResponse, AppError>,
) {
    let session_start = state.session_starts.read().await.get(&input.session_id).cloned();
    let (ok, error, code) = match result {
        Ok(_) => (true, None, ""),
        Err(error) => (false, Some(error.message.clone()), error.code.as_str()),
    };
    let entry = crate::commands::audit::AuditInsert {
        run_id: format!("query-lab:{}", input.run_key), stmt_index: Some(1), stmt_total: Some(1),
        session_id: input.session_id.to_string(), tab_title: "Query Optimization Lab (baseline)".into(),
        database: input.database.clone(), source: "query_lab".into(),
        started_at: crate::commands::audit::lifecycle_now(), ended_at: crate::commands::audit::lifecycle_now(),
        duration_ms: started.elapsed().as_millis() as i64,
        connection_name: session_start.as_ref().map(|value| value.connection_name.clone()).unwrap_or_default(),
        db_user: session_start.as_ref().map(|value| value.db_user.clone()).unwrap_or_default(),
        engine: input.engine.clone(), ok, rows_out: 0, rows_affected: None,
        error, error_code: code.into(), db_code: String::new(), sqlstate: String::new(),
        sql: input.sql.clone(),
    };
    if let Err(error) = crate::commands::audit::insert(&state.history, &entry).await {
        eprintln!("[audit] query lab baseline insert failed: {error:#}");
    }
}

pub async fn execute_baseline(
    input: QueryLabBaselineInput,
    state: &AppState,
) -> Result<QueryLabBaselineResponse, AppError> {
    let started = Instant::now();
    let key = crate::state::ext_job_key(input.session_id, &input.run_key);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut jobs = state.ext_jobs.write().await;
        if jobs.contains_key(&key) {
            return Err(AppError::bad_request("This Query Lab baseline run is already active"));
        }
        jobs.insert(key.clone(), cancel_tx);
    }
    let result = baseline_inner(input.clone(), state, &mut cancel_rx).await;
    state.ext_jobs.write().await.remove(&key);
    audit_baseline(state, &input, started, &result).await;
    result
}

#[tauri::command]
pub async fn query_lab_baseline(
    input: QueryLabBaselineInput,
    state: tauri::State<'_, AppState>,
) -> Result<QueryLabBaselineResponse, AppError> {
    execute_baseline(input, &state).await
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn input(session_id: Uuid, connection_id: Uuid, engine: Engine, mode: &str) -> QueryLabBaselineInput {
        QueryLabBaselineInput {
            session_id,
            connection_id,
            run_key: Uuid::new_v4().to_string(),
            engine: engine.wire_name().into(),
            database: "shop".into(),
            sql: "SELECT id FROM orders".into(),
            spec_sha256: "a".repeat(64),
            execution_mode: mode.into(),
            index_evidence_mode: "none".into(),
            timeout_ms: 100,
            evidence: QueryLabEvidenceInput {
                plan: true, cost: true,
                timing: mode == "measured", buffers: false, result_equality: false,
            },
            has_rewrite_candidate: false,
            scratch: Some(QueryLabScratchInput {
                session_id, connection_id, database: "shop".into(),
                environment: Some("dev".into()), read_only: false,
            }),
        }
    }

    async fn state_with_session(engine: Engine, environment: Option<&str>, read_only: bool) -> (AppState, Uuid, Uuid) {
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, std::env::temp_dir(), std::collections::HashMap::new());
        let session_id = Uuid::new_v4();
        let connection_id = Uuid::new_v4();
        let mut config = crate::db::types::ConnectionConfig::new(engine, "lab");
        config.id = connection_id;
        config.read_only = read_only;
        config.environment = environment.map(Into::into);
        let session = match engine {
            Engine::Mysql => LiveSession::Mysql(sqlx::mysql::MySqlPoolOptions::new().connect_lazy("mysql://127.0.0.1:1/unused").unwrap()),
            Engine::Postgres => LiveSession::Postgres(sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://127.0.0.1:1/unused").unwrap()),
            _ => panic!("unsupported test engine"),
        };
        state.sessions.write().await.insert(session_id, std::sync::Arc::new(session));
        state.session_meta.write().await.insert(session_id, crate::state::SessionGuard::from_config(&config));
        state.session_starts.write().await.insert(session_id, crate::commands::audit::session_start(&config));
        (state, session_id, connection_id)
    }

    #[tokio::test]
    async fn baseline_validation_rejects_writes_multi_statements_and_mode_mixing() {
        let (state, session, connection) = state_with_session(Engine::Mysql, Some("dev"), false).await;
        let mut write = input(session, connection, Engine::Mysql, "estimate");
        write.sql = "DELETE FROM orders".into();
        assert!(validate_input(&write, &state).await.is_err());
        let mut multiple = input(session, connection, Engine::Mysql, "estimate");
        multiple.sql = "SELECT 1; SELECT 2".into();
        assert!(validate_input(&multiple, &state).await.is_err());
        let mut evidence = input(session, connection, Engine::Mysql, "estimate");
        evidence.evidence.timing = true;
        assert!(validate_input(&evidence, &state).await.is_err());
        let mut engine = input(session, connection, Engine::Mysql, "estimate");
        engine.engine = "postgres".into();
        assert!(validate_input(&engine, &state).await.is_err());
    }

    #[tokio::test]
    async fn index_evidence_modes_are_incompatible_and_hypothetical_is_postgres_only() {
        let (state, session, connection) = state_with_session(Engine::Mysql, Some("dev"), false).await;
        let mut real_estimate = input(session, connection, Engine::Mysql, "estimate");
        real_estimate.index_evidence_mode = "real".into();
        assert!(validate_input(&real_estimate, &state).await.is_err());
        let mut hypothetical = input(session, connection, Engine::Mysql, "measured");
        hypothetical.index_evidence_mode = "hypothetical".into();
        assert!(validate_input(&hypothetical, &state).await.is_err());

        let (state, session, connection) = state_with_session(Engine::Postgres, Some("dev"), false).await;
        let mut hypothetical = input(session, connection, Engine::Postgres, "estimate");
        hypothetical.index_evidence_mode = "hypothetical".into();
        assert!(validate_input(&hypothetical, &state).await.is_ok());
        hypothetical.execution_mode = "measured".into();
        assert!(validate_input(&hypothetical, &state).await.is_err());
    }

    #[tokio::test]
    async fn measured_validation_requires_exact_nonproduction_writable_scratch() {
        let (state, session, connection) = state_with_session(Engine::Postgres, Some("dev"), false).await;
        let mut missing = input(session, connection, Engine::Postgres, "measured");
        missing.scratch = None;
        assert!(validate_input(&missing, &state).await.is_err());
        let mut production = input(session, connection, Engine::Postgres, "measured");
        production.scratch.as_mut().unwrap().environment = Some("prod".into());
        assert!(validate_input(&production, &state).await.is_err());
        let mut read_only = input(session, connection, Engine::Postgres, "measured");
        read_only.scratch.as_mut().unwrap().read_only = true;
        assert!(validate_input(&read_only, &state).await.is_err());
        let mut wrong_db = input(session, connection, Engine::Postgres, "measured");
        wrong_db.scratch.as_mut().unwrap().database = "other".into();
        assert!(validate_input(&wrong_db, &state).await.is_err());
        let mut rewrite = input(session, connection, Engine::Postgres, "measured");
        rewrite.has_rewrite_candidate = true;
        assert!(validate_input(&rewrite, &state).await.is_err());
        rewrite.evidence.result_equality = true;
        assert!(validate_input(&rewrite, &state).await.is_ok());
    }

    #[test]
    fn postgres_option_fallback_removes_wal_and_settings() {
        let fallback = pg_option_fallback_sql("EXPLAIN option \"WAL\" is not recognized", "SELECT 1").unwrap();
        assert_eq!(fallback, "EXPLAIN (ANALYZE, BUFFERS) SELECT 1");
        assert!(!fallback.contains("WAL"));
        assert!(!fallback.contains("SETTINGS"));
        assert!(pg_option_fallback_sql("syntax error", "SELECT 1").is_none());
    }

    #[test]
    fn cache_observations_never_claim_cache_control() {
        let estimated = cache_observations("estimate").join(" ");
        let measured = cache_observations("measured").join(" ");
        assert!(estimated.contains("not executed"));
        assert!(measured.contains("executed"));
        assert!(estimated.contains("No complete cache control"));
        assert!(measured.contains("not a cache benchmark"));
    }

    async fn mysql_live_state(pool: &sqlx::MySqlPool) -> (AppState, Uuid, Uuid) {
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, std::env::temp_dir(), std::collections::HashMap::new());
        let session_id = Uuid::new_v4();
        let connection_id = Uuid::new_v4();
        let mut config = crate::db::types::ConnectionConfig::new(Engine::Mysql, "lab");
        config.id = connection_id;
        config.read_only = false;
        config.environment = Some("dev".into());
        state.sessions.write().await.insert(session_id, std::sync::Arc::new(LiveSession::Mysql(pool.clone())));
        state.session_meta.write().await.insert(session_id, crate::state::SessionGuard::from_config(&config));
        state.session_starts.write().await.insert(session_id, crate::commands::audit::session_start(&config));
        (state, session_id, connection_id)
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
    async fn dbctl_mysql_baseline_estimate_measure_timeout_and_write_refusal() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(4).connect(&url).await.unwrap();
        crate::db::mysql::execute(&pool, "CREATE DATABASE shop").await.unwrap();
        crate::db::mysql::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY)").await.unwrap();
        crate::db::mysql::execute(&pool, "INSERT INTO shop.orders VALUES (1)").await.unwrap();
        let (state, session, connection) = mysql_live_state(&pool).await;
        let mut estimate = input(session, connection, Engine::Mysql, "estimate");
        estimate.execution_mode = "estimate".into();
        let response = execute_baseline(estimate, &state).await.unwrap();
        assert_eq!(response.estimated_plan.label, "estimated");
        assert!(response.measured_plan.is_none());
        assert!(!response.estimated_plan.content.is_empty());
        assert_eq!(response.cleanup.timeout_restored, true);
        assert_eq!(response.cleanup.connection_closed, true);
        assert!(response.backend_id > 0);
        assert!(!response.settings.is_empty());
        assert!(state.ext_jobs.read().await.is_empty());

        let measured = execute_baseline(input(session, connection, Engine::Mysql, "measured"), &state).await.unwrap();
        let plan = measured.measured_plan.unwrap();
        assert_eq!(plan.label, "executed_query");
        assert!(!plan.content.is_empty());
        assert_eq!(measured.cleanup.connection_closed, true);
        assert!(measured.cache_observations.iter().any(|line| line.contains("executed")));

        let mut timeout = input(session, connection, Engine::Mysql, "measured");
        timeout.sql = "SELECT id FROM orders WHERE SLEEP(1) = 0".into();
        let started = Instant::now();
        let error = execute_baseline(timeout, &state).await.expect_err("server timeout");
        assert!(!error.message.is_empty());
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(state.ext_jobs.read().await.is_empty());
        let alive: i64 = sqlx::query_scalar("SELECT 1").fetch_one(&pool).await.unwrap();
        assert_eq!(alive, 1);

        let mut write = input(session, connection, Engine::Mysql, "measured");
        write.sql = "DELETE FROM orders".into();
        assert!(execute_baseline(write, &state).await.is_err());
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shop.orders").fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 1);
        crate::db::mysql::execute(&pool, "DROP DATABASE shop").await.unwrap();
        pool.close().await;
    }

    async fn pg_live_state(pool: &sqlx::PgPool) -> (AppState, Uuid, Uuid) {
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, std::env::temp_dir(), std::collections::HashMap::new());
        let session_id = Uuid::new_v4();
        let connection_id = Uuid::new_v4();
        let mut config = crate::db::types::ConnectionConfig::new(Engine::Postgres, "lab");
        config.id = connection_id;
        config.read_only = false;
        config.environment = Some("dev".into());
        state.sessions.write().await.insert(session_id, std::sync::Arc::new(LiveSession::Postgres(pool.clone())));
        state.session_meta.write().await.insert(session_id, crate::state::SessionGuard::from_config(&config));
        state.session_starts.write().await.insert(session_id, crate::commands::audit::session_start(&config));
        (state, session_id, connection_id)
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18"]
    async fn dbctl_pg_baseline_estimate_measure_timeout_and_write_refusal() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(4).connect(&url).await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE SCHEMA shop").await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY)").await.unwrap();
        crate::db::postgres::execute(&pool, "INSERT INTO shop.orders VALUES (1)").await.unwrap();
        let (state, session, connection) = pg_live_state(&pool).await;
        let response = execute_baseline(input(session, connection, Engine::Postgres, "estimate"), &state).await.unwrap();
        assert_eq!(response.estimated_plan.label, "estimated");
        assert!(response.measured_plan.is_none());
        assert!(!response.estimated_plan.content.is_empty());
        assert_eq!(response.cleanup.connection_closed, true);
        assert!(response.backend_id > 0);
        assert!(state.ext_jobs.read().await.is_empty());

        let measured = execute_baseline(input(session, connection, Engine::Postgres, "measured"), &state).await.unwrap();
        let plan = measured.measured_plan.unwrap();
        assert_eq!(plan.label, "executed_query");
        assert!(!plan.content.is_empty());
        assert_eq!(measured.cleanup.timeout_restored, true);
        assert!(measured.settings.iter().any(|setting| setting.name == "shared_buffers"));

        let mut timeout = input(session, connection, Engine::Postgres, "measured");
        timeout.sql = "SELECT pg_sleep(1)".into();
        let started = Instant::now();
        let error = execute_baseline(timeout, &state).await.expect_err("server timeout");
        assert!(!error.message.is_empty());
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(state.ext_jobs.read().await.is_empty());
        let alive: i32 = sqlx::query_scalar("SELECT 1").fetch_one(&pool).await.unwrap();
        assert_eq!(alive, 1);

        let mut write = input(session, connection, Engine::Postgres, "measured");
        write.sql = "DELETE FROM orders".into();
        assert!(execute_baseline(write, &state).await.is_err());
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shop.orders").fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 1);
        crate::db::postgres::execute(&pool, "DROP SCHEMA shop CASCADE").await.unwrap();
        pool.close().await;
    }
}
