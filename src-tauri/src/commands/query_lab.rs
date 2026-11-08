use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{AssertSqlSafe, Connection};
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
    pub run_key: Option<String>,
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
    pub elapsed_us: Option<u64>,
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
    pub hypopg_reset: Option<bool>,
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
    execution_database: String,
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
    QueryLabPlanEvidence { label: label.into(), format: format.into(), content, elapsed_ms, elapsed_us: None }
}

fn estimated_precise(label: &str, format: &str, content: String, started: Instant) -> QueryLabPlanEvidence {
    let elapsed = started.elapsed();
    QueryLabPlanEvidence {
        label: label.into(), format: format.into(), content,
        elapsed_ms: elapsed.as_millis() as u64,
        elapsed_us: Some(elapsed.as_micros() as u64),
    }
}

async fn validated_migration_scratch(
    input: &QueryLabBaselineInput,
    guard: &crate::state::SessionGuard,
    state: &AppState,
) -> Result<crate::commands::migration::MigrationScratchRecord, AppError> {
    let scratch = input.scratch.as_ref()
        .ok_or_else(|| AppError::guard("Query Lab real indexes require an explicit Migration scratch"))?;
    let run_key = scratch.run_key.as_deref()
        .ok_or_else(|| AppError::guard("Query Lab real indexes require a Migration scratch run key"))?;
    Uuid::parse_str(run_key).map_err(|_| AppError::bad_request("Query Lab Migration scratch run key must be a UUID"))?;
    if !scratch.database.starts_with("txui_mig_") {
        return Err(AppError::guard("Query Lab Migration scratch must use its generated txui_mig_* name"));
    }
    if scratch.session_id != input.session_id || scratch.connection_id != input.connection_id {
        return Err(AppError::guard("Query Lab scratch identity does not match the open session"));
    }
    if guard.read_only || scratch.read_only || guard.environment.as_deref() == Some("prod")
        || scratch.environment.as_deref() == Some("prod")
    {
        return Err(AppError::guard("Query Lab real indexes require a writable non-production Migration scratch"));
    }
    if scratch.environment != guard.environment || scratch.read_only != guard.read_only {
        return Err(AppError::guard("Query Lab scratch safety metadata does not match the open session"));
    }
    let record = crate::commands::migration::scratch_record(state, run_key).await?;
    if record.status != "active" {
        return Err(AppError::guard("Query Lab requires an active Migration scratch record"));
    }
    if record.session_id != input.session_id.to_string()
        || record.connection_id != input.connection_id.to_string()
        || record.engine != guard.engine.wire_name()
        || record.name != scratch.database
    {
        return Err(AppError::guard("Query Lab scratch/target identity does not match the Migration record"));
    }
    Ok(record)
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
        if scratch.environment.as_deref() == Some("prod") || guard.environment.as_deref() == Some("prod") {
            return Err(AppError::guard("Query Lab measured experiments require a non-production scratch target"));
        }
        if scratch.read_only || guard.read_only {
            return Err(AppError::guard("Query Lab measured scratch target must be writable"));
        }
        if scratch.environment != guard.environment || scratch.read_only != guard.read_only {
            return Err(AppError::guard("Query Lab scratch safety metadata does not match the open session"));
        }
        if scratch.run_key.is_some() {
            validated_migration_scratch(input, &guard, state).await?;
        } else if scratch.database != input.database {
            return Err(AppError::guard("Query Lab scratch database does not match the experiment database without a Migration scratch run key"));
        }
    }
    state.guard_statement(&input.session_id, &input.sql).await?;
    let execution_database = if input.execution_mode == "measured" {
        input.scratch.as_ref().map(|scratch| scratch.database.clone()).unwrap_or_else(|| input.database.clone())
    } else {
        input.database.clone()
    };
    Ok(ValidatedInput {
        timeout_ms: input.timeout_ms.clamp(100, 60_000),
        engine: guard.engine,
        execution_database,
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
        crate::db::mysql::execute(&mut conn, &format!("USE `{}`", validated.execution_database.replace('`', "``"))).await?;
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
        crate::db::postgres::execute(&mut conn, &format!("SET search_path TO \"{}\"", validated.execution_database.replace('"', "\"\""))).await?;
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
        database: validated.execution_database,
        engine: validated.engine.wire_name().into(),
        version: parts.version,
        backend_id: parts.backend_id,
        timeout_ms: validated.timeout_ms,
        estimated_plan: parts.estimated_plan,
        measured_plan: parts.measured_plan,
        cost_estimates: input.evidence.cost,
        settings: parts.settings,
        cache_observations: cache_observations(&input.execution_mode),
        cleanup: QueryLabCleanup { timeout_restored: true, connection_closed: true, hypopg_reset: None },
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


#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabHypopgCandidateInput {
    pub id: String,
    pub name: String,
    pub table: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub where_clause: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabHypopgInput {
    pub session_id: Uuid,
    pub connection_id: Uuid,
    pub run_key: String,
    pub database: String,
    pub sql: String,
    pub spec_sha256: String,
    pub index_evidence_mode: String,
    pub timeout_ms: u64,
    pub candidate: QueryLabHypopgCandidateInput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabHypopgResponse {
    pub run_key: String,
    pub spec_sha256: String,
    pub candidate_id: String,
    pub backend_id: u64,
    pub baseline_plan: QueryLabPlanEvidence,
    pub candidate_plan: QueryLabPlanEvidence,
    pub created_index_names: Vec<String>,
    pub used_index_names: Vec<String>,
    pub baseline_cost: Option<f64>,
    pub candidate_cost: Option<f64>,
    pub absolute_delta: Option<f64>,
    pub percent_delta: Option<f64>,
    pub index_used: bool,
    pub verdict: String,
    pub comparison_policy: String,
    pub cleanup: QueryLabCleanup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HypopgFail {
    InitialReset,
    Baseline,
    Create,
    Explain,
    FinalReset,
    Restore,
}

fn fail_step(step: HypopgFail, injected: Option<HypopgFail>) -> Result<(), AppError> {
    if injected == Some(step) {
        Err(AppError::local(format!("Query Lab injected {:?} failure", step)))
    } else {
        Ok(())
    }
}

fn quote_pg_identifier(name: &str) -> Result<String, AppError> {
    if name.is_empty() || name.len() > 63 || name.contains('\0') {
        return Err(AppError::bad_request("Query Lab identifier is empty or invalid"));
    }
    if !name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '$')) {
        return Err(AppError::bad_request("Query Lab identifiers must be unquoted names"));
    }
    Ok(format!("\"{}\"", name.replace('"', "\"\"")))
}

fn pg_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn candidate_ddl(candidate: &QueryLabHypopgCandidateInput) -> Result<String, AppError> {
    if candidate.columns.is_empty() || candidate.columns.len() > 32 {
        return Err(AppError::bad_request("Query Lab index requires 1–32 columns"));
    }
    if candidate.id.is_empty() || candidate.name.is_empty() {
        return Err(AppError::bad_request("Query Lab candidate id/name is required"));
    }
    let table = candidate.table.split('.').map(quote_pg_identifier).collect::<Result<Vec<_>, _>>()?;
    if table.len() > 2 {
        return Err(AppError::bad_request("Query Lab table must be table or schema.table"));
    }
    let columns = candidate.columns.iter().map(|column| quote_pg_identifier(column)).collect::<Result<Vec<_>, _>>()?;
    let unique = if candidate.unique { "UNIQUE " } else { "" };
    let predicate = match &candidate.where_clause {
        Some(where_clause) if !where_clause.trim().is_empty() => {
            if where_clause.len() > 10_000 || where_clause.contains([';', '\0']) {
                return Err(AppError::bad_request("Query Lab partial-index predicate is invalid"));
            }
            format!(" WHERE {where_clause}")
        }
        _ => String::new(),
    };
    Ok(format!(
        "CREATE {unique}INDEX ON {} ({}){predicate}",
        table.join("."),
        columns.join(", "),
    ))
}

fn total_cost(plan_json: &str) -> Option<f64> {
    fn walk(value: &serde_json::Value) -> Option<f64> {
        match value {
            serde_json::Value::Object(map) => {
                if let Some(cost) = map.get("Total Cost").and_then(serde_json::Value::as_f64) {
                    return Some(cost);
                }
                map.values().find_map(walk)
            }
            serde_json::Value::Array(values) => values.iter().find_map(walk),
            _ => None,
        }
    }
    let parsed: serde_json::Value = serde_json::from_str(plan_json).ok()?;
    let cost = walk(&parsed)?;
    cost.is_finite().then_some(cost)
}

async fn validate_hypopg(input: &QueryLabHypopgInput, state: &AppState) -> Result<u64, AppError> {
    Uuid::parse_str(&input.run_key).map_err(|_| AppError::bad_request("Query Lab run key must be a UUID"))?;
    if input.sql.len() > MAX_QUERY_LAB_SQL_BYTES {
        return Err(AppError::bad_request("Query Lab SQL exceeds the 2 MiB limit"));
    }
    if input.spec_sha256.len() != 64 || !input.spec_sha256.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(AppError::bad_request("Query Lab spec hash must be 64 hexadecimal characters"));
    }
    let statements = crate::sqlguard::split_statements_for(Some(Engine::Postgres), &input.sql);
    if statements.len() != 1 || !crate::sqlguard::is_read_family(&input.sql)
        || crate::sqlguard::is_write_for(Some(Engine::Postgres), &input.sql)
    {
        return Err(AppError::guard("HypoPG accepts exactly one read-only statement"));
    }
    if input.index_evidence_mode != "hypothetical" {
        return Err(AppError::guard("HypoPG candidates require hypothetical estimate evidence; measured or real evidence is incompatible"));
    }
    let guard = state.session_meta.read().await.get(&input.session_id).cloned()
        .ok_or_else(|| AppError::bad_request("Query Lab session is not open"))?;
    if guard.engine != Engine::Postgres {
        return Err(AppError::unsupported("HypoPG is available on PostgreSQL only"));
    }
    let starts = state.session_starts.read().await;
    let start = starts.get(&input.session_id)
        .ok_or_else(|| AppError::bad_request("Query Lab connection identity is unavailable"))?;
    if start.connection_id != input.connection_id {
        return Err(AppError::guard("Query Lab connection ID does not match the open session"));
    }
    drop(starts);
    state.guard_statement(&input.session_id, &input.sql).await?;
    candidate_ddl(&input.candidate)?;
    Ok(input.timeout_ms.clamp(100, 60_000))
}

async fn hypopg_inner(
    input: QueryLabHypopgInput,
    state: &AppState,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
    injected: Option<HypopgFail>,
) -> Result<QueryLabHypopgResponse, AppError> {
    let timeout_ms = validate_hypopg(&input, state).await?;
    let session = crate::db::connection::get_session_pub(input.session_id, &state.sessions).await?;
    let pool = match session.as_ref() {
        LiveSession::Postgres(pool) => pool,
        _ => return Err(AppError::unsupported("HypoPG is available on PostgreSQL only")),
    };
    let mut conn = pool.acquire().await.map_err(|error| AppError::local(format!("Query Lab could not acquire its HypoPG connection: {error}")))?.detach();
    let backend_id = sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
        .fetch_one(&mut conn).await? as u64;
    crate::db::postgres::execute(&mut conn, &format!("SET search_path TO \"{}\"", input.database.replace('"', "\"\""))).await?;
    let previous_timeout = sqlx::query_scalar::<_, String>("SHOW statement_timeout")
        .fetch_one(&mut conn).await?;
    crate::db::postgres::execute(&mut conn, &format!("SET statement_timeout = {timeout_ms}")).await?;
    let result = async {
        let (installed, available) = sqlx::query_as::<_, (Option<String>, Option<String>)>(
            "SELECT (SELECT extversion FROM pg_extension WHERE extname = 'hypopg'), (SELECT default_version FROM pg_available_extensions WHERE name = 'hypopg')",
        ).fetch_one(&mut conn).await?;
        if installed.is_none() {
            if available.is_none() {
                return Err(AppError::unsupported("HypoPG is not available on this PostgreSQL server"));
            }
            state.guard_statement(&input.session_id, "CREATE EXTENSION IF NOT EXISTS hypopg").await?;
            pg_statement(&mut conn, "CREATE EXTENSION IF NOT EXISTS hypopg", cancel).await?;
        }
        fail_step(HypopgFail::InitialReset, injected)?;
        pg_statement(&mut conn, "SELECT public.hypopg_reset()", cancel).await?;
        let started = Instant::now();
        let baseline_result = pg_statement(&mut conn, &format!("EXPLAIN (FORMAT JSON) {}", input.sql), cancel).await?;
        let baseline_plan = estimated("estimated", "json", plan_text(&baseline_result)?, started.elapsed().as_millis() as u64);
        fail_step(HypopgFail::Baseline, injected)?;
        fail_step(HypopgFail::Create, injected)?;
        let ddl = candidate_ddl(&input.candidate)?;
        let create_sql = format!("SELECT indexrelid, indexname FROM public.hypopg_create_index({})", pg_literal(&ddl));
        let created = pg_statement(&mut conn, &create_sql, cancel).await?;
        let created_index_names = created.rows.iter().filter_map(|row| {
            row.last().and_then(serde_json::Value::as_str).map(ToOwned::to_owned)
        }).collect::<Vec<_>>();
        if created_index_names.is_empty() {
            return Err(AppError::local("HypoPG returned no hypothetical index name"));
        }
        fail_step(HypopgFail::Explain, injected)?;
        let started = Instant::now();
        let candidate_result = pg_statement(&mut conn, &format!("EXPLAIN (FORMAT JSON) {}", input.sql), cancel).await?;
        let candidate_plan = estimated("hypothetical", "json", plan_text(&candidate_result)?, started.elapsed().as_millis() as u64);
        Ok((baseline_plan, candidate_plan, created_index_names))
    }.await;
    fail_step(HypopgFail::FinalReset, injected)?;
    let reset = pg_statement(&mut conn, "SELECT public.hypopg_reset()", cancel).await;
    let restored = sqlx::query("SELECT set_config('statement_timeout', $1, false)")
        .bind(previous_timeout).execute(&mut conn).await;
    fail_step(HypopgFail::Restore, injected)?;
    let close = conn.close().await;
    let (baseline_plan, candidate_plan, created_index_names) = result?;
    if reset.is_err() || restored.is_err() || close.is_err() {
        return Err(AppError::local("HypoPG lifecycle cleanup was incomplete"));
    }
    let baseline_cost = total_cost(&baseline_plan.content);
    let candidate_cost = total_cost(&candidate_plan.content);
    let used_index_names = created_index_names.iter().filter(|name| candidate_plan.content.contains(name.as_str())).cloned().collect::<Vec<_>>();
    let index_used = !used_index_names.is_empty();
    let (absolute_delta, percent_delta) = match (baseline_cost, candidate_cost) {
        (Some(baseline), Some(candidate)) if baseline > 0.0 => {
            let absolute = candidate - baseline;
            (Some(absolute), Some(absolute / baseline * 100.0))
        }
        _ => (None, None),
    };
    let verdict = if !index_used {
        "not_used".into()
    } else if absolute_delta.is_some_and(|delta| delta < 0.0) {
        "lower_estimated_cost".into()
    } else if absolute_delta.is_some_and(|delta| delta > 0.0) {
        "higher_estimated_cost".into()
    } else {
        "unchanged".into()
    };
    Ok(QueryLabHypopgResponse {
        run_key: input.run_key,
        spec_sha256: input.spec_sha256,
        candidate_id: input.candidate.id,
        backend_id,
        baseline_plan,
        candidate_plan,
        created_index_names,
        used_index_names,
        baseline_cost,
        candidate_cost,
        absolute_delta,
        percent_delta,
        index_used,
        verdict,
        comparison_policy: "Hypothetical index: plan/cost evidence only; measured runtime comparison is forbidden".into(),
        cleanup: QueryLabCleanup { timeout_restored: true, connection_closed: true, hypopg_reset: Some(true) },
    })
}

async fn audit_hypopg(
    state: &AppState,
    input: &QueryLabHypopgInput,
    started: Instant,
    result: &Result<QueryLabHypopgResponse, AppError>,
) {
    let session_start = state.session_starts.read().await.get(&input.session_id).cloned();
    let (ok, error, code) = match result {
        Ok(_) => (true, None, ""),
        Err(error) => (false, Some(error.message.clone()), error.code.as_str()),
    };
    let entry = crate::commands::audit::AuditInsert {
        run_id: format!("query-lab-hypopg:{}", input.run_key), stmt_index: Some(1), stmt_total: Some(1),
        session_id: input.session_id.to_string(), tab_title: "Query Optimization Lab (HypoPG)".into(),
        database: input.database.clone(), source: "query_lab_hypopg".into(),
        started_at: crate::commands::audit::lifecycle_now(), ended_at: crate::commands::audit::lifecycle_now(),
        duration_ms: started.elapsed().as_millis() as i64,
        connection_name: session_start.as_ref().map(|value| value.connection_name.clone()).unwrap_or_default(),
        db_user: session_start.as_ref().map(|value| value.db_user.clone()).unwrap_or_default(),
        engine: "postgres".into(), ok, rows_out: 0, rows_affected: None,
        error, error_code: code.into(), db_code: String::new(), sqlstate: String::new(),
        sql: input.sql.clone(),
    };
    if let Err(error) = crate::commands::audit::insert(&state.history, &entry).await {
        eprintln!("[audit] query lab HypoPG insert failed: {error:#}");
    }
}

pub async fn execute_hypopg(
    input: QueryLabHypopgInput,
    state: &AppState,
) -> Result<QueryLabHypopgResponse, AppError> {
    let started = Instant::now();
    let key = crate::state::ext_job_key(input.session_id, &input.run_key);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut jobs = state.ext_jobs.write().await;
        if jobs.contains_key(&key) {
            return Err(AppError::bad_request("This HypoPG run is already active"));
        }
        jobs.insert(key.clone(), cancel_tx);
    }
    let result = hypopg_inner(input.clone(), state, &mut cancel_rx, None).await;
    state.ext_jobs.write().await.remove(&key);
    audit_hypopg(state, &input, started, &result).await;
    result
}

#[tauri::command]
pub async fn query_lab_hypopg_estimate(
    input: QueryLabHypopgInput,
    state: tauri::State<'_, AppState>,
) -> Result<QueryLabHypopgResponse, AppError> {
    execute_hypopg(input, &state).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabRealIndexInput {
    pub baseline: QueryLabBaselineInput,
    pub candidate: QueryLabHypopgCandidateInput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabRealIndexCleanup {
    pub index_dropped: bool,
    pub scratch_dropped: bool,
    pub timeout_restored: bool,
    pub connection_closed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabRealIndexResponse {
    pub run_key: String,
    pub spec_sha256: String,
    pub candidate_id: String,
    pub scratch_run_key: String,
    pub scratch_database: String,
    pub backend_id: u64,
    pub index_name: String,
    pub index_build_ms: u64,
    pub baseline_plan: QueryLabPlanEvidence,
    pub candidate_plan: QueryLabPlanEvidence,
    pub index_used: bool,
    pub comparison_policy: String,
    pub cleanup: QueryLabRealIndexCleanup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealIndexFail {
    Baseline,
    Create,
    AfterCreate,
    Measure,
    Drop,
    Restore,
}

fn real_fail(step: RealIndexFail, injected: Option<RealIndexFail>) -> Result<(), AppError> {
    if injected == Some(step) {
        Err(AppError::local(format!("Query Lab injected {:?} failure", step)))
    } else {
        Ok(())
    }
}

fn real_identifier(engine: Engine, name: &str) -> Result<String, AppError> {
    if name.is_empty() || name.len() > 63 || name.contains('\0')
        || !name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '$'))
    {
        return Err(AppError::bad_request("Query Lab real-index identifiers must be unquoted names"));
    }
    Ok(match engine {
        Engine::Mysql => format!("`{name}`"),
        Engine::Postgres => format!("\"{name}\""),
        _ => return Err(AppError::unsupported("Query Lab real indexes support MySQL/MariaDB and PostgreSQL only")),
    })
}

fn real_index_sql(
    engine: Engine,
    candidate: &QueryLabHypopgCandidateInput,
    index_name: &str,
) -> Result<String, AppError> {
    candidate_ddl(candidate)?;
    if candidate.table.contains('.') {
        return Err(AppError::guard("Query Lab real-index tables must be unqualified so DDL cannot escape the Migration scratch"));
    }
    if engine == Engine::Mysql && candidate.where_clause.as_deref().is_some_and(|value| !value.trim().is_empty()) {
        return Err(AppError::unsupported("MySQL/MariaDB do not support partial indexes"));
    }
    let unique = if candidate.unique { "UNIQUE " } else { "" };
    let columns = candidate.columns.iter().map(|column| real_identifier(engine, column)).collect::<Result<Vec<_>, _>>()?;
    let predicate = candidate.where_clause.as_deref().filter(|value| !value.trim().is_empty())
        .map(|value| format!(" WHERE {value}")).unwrap_or_default();
    Ok(format!(
        "CREATE {unique}INDEX {} ON {} ({}){predicate}",
        real_identifier(engine, index_name)?,
        real_identifier(engine, &candidate.table)?,
        columns.join(", "),
    ))
}

fn real_index_drop_sql(
    engine: Engine,
    candidate: &QueryLabHypopgCandidateInput,
    index_name: &str,
) -> Result<String, AppError> {
    match engine {
        Engine::Mysql => Ok(format!(
            "DROP INDEX {} ON {}",
            real_identifier(engine, index_name)?,
            real_identifier(engine, &candidate.table)?,
        )),
        Engine::Postgres => Ok(format!("DROP INDEX IF EXISTS {}", real_identifier(engine, index_name)?)),
        _ => Err(AppError::unsupported("Query Lab real indexes support MySQL/MariaDB and PostgreSQL only")),
    }
}

enum RealConnection {
    Mysql {
        conn: sqlx::MySqlConnection,
        version: String,
        previous_timeout: f64,
        backend_id: u64,
    },
    Postgres {
        conn: sqlx::PgConnection,
        previous_timeout: String,
        backend_id: u64,
    },
}

impl RealConnection {
    async fn acquire(
        input: &QueryLabBaselineInput,
        state: &AppState,
        database: &str,
        timeout_ms: u64,
    ) -> Result<Self, AppError> {
        let session = crate::db::connection::get_session_pub(input.session_id, &state.sessions).await?;
        match session.as_ref() {
            LiveSession::Mysql(pool) => {
                let mut conn = pool.acquire().await.map_err(|error| AppError::local(format!("Query Lab could not acquire its candidate connection: {error}")))?.detach();
                let version = sqlx::query_scalar::<_, String>("SELECT VERSION()").fetch_one(&mut conn).await?;
                let is_maria = version.to_lowercase().contains("mariadb");
                let previous_timeout = if is_maria {
                    sqlx::query_scalar::<_, f64>("SELECT @@max_statement_time").fetch_one(&mut conn).await?
                } else {
                    sqlx::query_scalar::<_, f64>("SELECT CAST(@@max_execution_time AS DOUBLE)").fetch_one(&mut conn).await? / 1000.0
                };
                let backend_id = sqlx::query_scalar::<_, u64>("SELECT CONNECTION_ID()").fetch_one(&mut conn).await?;
                crate::db::mysql::execute(&mut conn, &format!("USE `{}`", database.replace('`', "``"))).await?;
                if is_maria {
                    crate::db::mysql::execute(&mut conn, &format!("SET SESSION max_statement_time={}", timeout_ms as f64 / 1000.0)).await?;
                } else {
                    crate::db::mysql::execute(&mut conn, &format!("SET SESSION max_execution_time={timeout_ms}")).await?;
                }
                Ok(Self::Mysql { conn, version, previous_timeout, backend_id })
            },
            LiveSession::Postgres(pool) => {
                let mut conn = pool.acquire().await.map_err(|error| AppError::local(format!("Query Lab could not acquire its candidate connection: {error}")))?.detach();
                let previous_timeout = sqlx::query_scalar::<_, String>("SHOW statement_timeout").fetch_one(&mut conn).await?;
                let backend_id = sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()").fetch_one(&mut conn).await? as u64;
                crate::db::postgres::execute(&mut conn, &format!("SET search_path TO \"{}\"", database.replace('"', "\"\""))).await?;
                crate::db::postgres::execute(&mut conn, &format!("SET statement_timeout = {timeout_ms}")).await?;
                Ok(Self::Postgres { conn, previous_timeout, backend_id })
            },
            _ => Err(AppError::unsupported("Query Lab real indexes support MySQL/MariaDB and PostgreSQL only")),
        }
    }

    fn backend_id(&self) -> u64 {
        match self {
            Self::Mysql { backend_id, .. } | Self::Postgres { backend_id, .. } => *backend_id,
        }
    }

    async fn statement(
        &mut self,
        sql: &str,
        cancel: &mut tokio::sync::oneshot::Receiver<()>,
    ) -> Result<QueryResult, AppError> {
        match self {
            Self::Mysql { conn, .. } => mysql_statement(conn, sql, cancel).await,
            Self::Postgres { conn, .. } => pg_statement(conn, sql, cancel).await,
        }
    }

    async fn capped(
        &mut self,
        sql: &str,
        max_rows: usize,
        cancel: &mut tokio::sync::oneshot::Receiver<()>,
    ) -> Result<QueryResult, AppError> {
        tokio::select! {
            result = async {
                match self {
                    Self::Mysql { conn, .. } => crate::db::mysql::execute_capped(conn, sql, Some(max_rows)).await,
                    Self::Postgres { conn, .. } => crate::db::postgres::execute_capped(conn, sql, Some(max_rows)).await,
                }
            } => result.map_err(Into::into),
            _ = cancel => Err(AppError::new(ErrorCode::Cancelled, "Query Lab rewrite was cancelled")),
        }
    }

    async fn timed(
        &mut self,
        sql: &str,
        timeout_ms: u64,
        cancel: &mut tokio::sync::oneshot::Receiver<()>,
    ) -> Result<u64, AppError> {
        let started = Instant::now();
        let execution = async {
            match self {
                Self::Mysql { conn, .. } => {
                    let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(conn);
                    while stream.try_next().await?.is_some() {}
                    Ok::<(), sqlx::Error>(())
                },
                Self::Postgres { conn, .. } => {
                    let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(conn);
                    while stream.try_next().await?.is_some() {}
                    Ok::<(), sqlx::Error>(())
                },
            }
        };
        tokio::select! {
            result = tokio::time::timeout(Duration::from_millis(timeout_ms), execution) => {
                match result {
                    Ok(Ok(())) => Ok(started.elapsed().as_millis() as u64),
                    Ok(Err(error)) => Err(AppError::from(error)),
                    Err(_) => Err(AppError::new(ErrorCode::Timeout, "Query Lab benchmark run exceeded its timeout")),
                }
            },
            _ = cancel => Err(AppError::new(ErrorCode::Cancelled, "Query Lab benchmark run was cancelled")),
        }
    }

    async fn raw(&mut self, sql: &str) -> Result<(), AppError> {
        match self {
            Self::Mysql { conn, .. } => crate::db::mysql::execute(conn, sql).await.map(|_| ()).map_err(Into::into),
            Self::Postgres { conn, .. } => crate::db::postgres::execute(conn, sql).await.map(|_| ()).map_err(Into::into),
        }
    }

    async fn measured_plan(
        &mut self,
        sql: &str,
        timeout_ms: u64,
        cancel: &mut tokio::sync::oneshot::Receiver<()>,
    ) -> Result<QueryLabPlanEvidence, AppError> {
        let started = Instant::now();
        match self {
            Self::Mysql { conn, version, .. } => {
                let is_maria = version.to_lowercase().contains("mariadb");
                let (_, explain) = crate::commands::quality::mysql_analyze_statements(version, sql, timeout_ms);
                let result = mysql_measured_statement(conn, &explain, timeout_ms, cancel).await?;
                Ok(estimated_precise("executed_query", if is_maria { "json" } else { "text" }, plan_text(&result)?, started))
            },
            Self::Postgres { conn, .. } => {
                let full = format!("EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS) {sql}");
                let result = match pg_measured_statement(conn, &full, timeout_ms, cancel).await {
                    Err(error) if let Some(fallback) = pg_option_fallback_sql(&error.message, sql) => {
                        pg_measured_statement(conn, &fallback, timeout_ms, cancel).await?
                    },
                    other => other?,
                };
                Ok(estimated_precise("executed_query", "json", plan_text(&result)?, started))
            },
        }
    }

    async fn restore(&mut self) -> Result<(), AppError> {
        match self {
            Self::Mysql { conn, version, previous_timeout, .. } => {
                let sql = if version.to_lowercase().contains("mariadb") {
                    format!("SET SESSION max_statement_time={previous_timeout}")
                } else {
                    format!("SET SESSION max_execution_time={}", (*previous_timeout * 1000.0) as u64)
                };
                crate::db::mysql::execute(conn, &sql).await.map(|_| ()).map_err(Into::into)
            },
            Self::Postgres { conn, previous_timeout, .. } => {
                sqlx::query("SELECT set_config('statement_timeout', $1, false)")
                    .bind(previous_timeout.as_str()).execute(conn).await?;
                Ok(())
            },
        }
    }

    async fn close(self) -> Result<(), AppError> {
        match self {
            Self::Mysql { conn, .. } => conn.close().await.map_err(Into::into),
            Self::Postgres { conn, .. } => conn.close().await.map_err(Into::into),
        }
    }
}

struct RealIndexParts {
    baseline_plan: QueryLabPlanEvidence,
    candidate_plan: QueryLabPlanEvidence,
    index_build_ms: u64,
    index_used: bool,
}

async fn finish_real_index(
    mut result: Result<QueryLabRealIndexResponse, AppError>,
    state: &AppState,
    scratch_run_key: &str,
) -> Result<QueryLabRealIndexResponse, AppError> {
    match crate::commands::migration::cleanup_scratch(state, scratch_run_key).await {
        Ok(_) => {
            if let Ok(response) = result.as_mut() { response.cleanup.scratch_dropped = true; }
            result
        },
        Err(cleanup) => match result {
            Ok(_) => Err(cleanup),
            Err(original) => Err(AppError::local(format!(
                "{}; Migration scratch cleanup also failed: {}",
                original.message, cleanup.message,
            ))),
        },
    }
}

async fn real_index_inner(
    input: QueryLabRealIndexInput,
    state: &AppState,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
    injected: Option<RealIndexFail>,
) -> Result<QueryLabRealIndexResponse, AppError> {
    let validated = validate_input(&input.baseline, state).await?;
    if input.baseline.execution_mode != "measured" || input.baseline.index_evidence_mode != "real" {
        return Err(AppError::guard("Query Lab real-index candidates require measured real evidence"));
    }
    let scratch = input.baseline.scratch.as_ref()
        .ok_or_else(|| AppError::guard("Query Lab real indexes require Migration scratch identity"))?;
    let scratch_run_key = scratch.run_key.clone()
        .ok_or_else(|| AppError::guard("Query Lab real indexes require a Migration scratch run key"))?;
    let scratch_database = scratch.database.clone();
    let guard = state.session_meta.read().await.get(&input.baseline.session_id).cloned()
        .ok_or_else(|| AppError::bad_request("Query Lab session is not open"))?;
    validated_migration_scratch(&input.baseline, &guard, state).await?;
    let index_name = format!("txui_lab_{}", &Uuid::parse_str(&input.baseline.run_key)
        .map_err(|_| AppError::bad_request("Query Lab run key must be a UUID"))?.simple().to_string()[..16]);
    let create_sql = real_index_sql(validated.engine, &input.candidate, &index_name)?;
    let drop_sql = real_index_drop_sql(validated.engine, &input.candidate, &index_name)?;
    state.guard_statement(&input.baseline.session_id, &create_sql).await?;
    state.guard_statement(&input.baseline.session_id, &drop_sql).await?;
    let mut conn = match RealConnection::acquire(&input.baseline, state, &scratch_database, validated.timeout_ms).await {
        Ok(conn) => conn,
        Err(error) => return finish_real_index(Err(error), state, &scratch_run_key).await,
    };
    let backend_id = conn.backend_id();
    let mut create_started = false;
    let mut result: Result<RealIndexParts, AppError> = async {
        real_fail(RealIndexFail::Baseline, injected)?;
        let baseline_plan = conn.measured_plan(&input.baseline.sql, validated.timeout_ms, cancel).await?;
        real_fail(RealIndexFail::Create, injected)?;
        create_started = true;
        let started = Instant::now();
        conn.statement(&create_sql, cancel).await?;
        let index_build_ms = started.elapsed().as_millis() as u64;
        real_fail(RealIndexFail::AfterCreate, injected)?;
        real_fail(RealIndexFail::Measure, injected)?;
        let candidate_plan = conn.measured_plan(&input.baseline.sql, validated.timeout_ms, cancel).await?;
        let index_used = candidate_plan.content.contains(&index_name);
        Ok(RealIndexParts { baseline_plan, candidate_plan, index_build_ms, index_used })
    }.await;
    if create_started {
        if let Err(error) = real_fail(RealIndexFail::Drop, injected) {
            if result.is_ok() { result = Err(error); }
        } else if let Err(error) = conn.raw(&drop_sql).await {
            if result.is_ok() { result = Err(AppError::local(format!("Query Lab candidate index cleanup failed: {error}"))); }
        }
    }
    if let Err(error) = real_fail(RealIndexFail::Restore, injected) {
        if result.is_ok() { result = Err(error); }
    } else if let Err(error) = conn.restore().await {
        if result.is_ok() { result = Err(AppError::local(format!("Query Lab timeout restoration failed: {error}"))); }
    }
    if let Err(error) = conn.close().await {
        if result.is_ok() { result = Err(AppError::local(format!("Query Lab connection cleanup failed: {error}"))); }
    }
    let response = result.map(|parts| QueryLabRealIndexResponse {
        run_key: input.baseline.run_key.clone(),
        spec_sha256: input.baseline.spec_sha256.clone(),
        candidate_id: input.candidate.id.clone(),
        scratch_run_key: scratch_run_key.clone(),
        scratch_database,
        backend_id,
        index_name,
        index_build_ms: parts.index_build_ms,
        baseline_plan: parts.baseline_plan,
        candidate_plan: parts.candidate_plan,
        index_used: parts.index_used,
        comparison_policy: "Real index on Migration scratch: both plans executed the read-only query once; create wall time includes lock wait and rebuild and is not a runtime verdict".into(),
        cleanup: QueryLabRealIndexCleanup {
            index_dropped: true,
            scratch_dropped: false,
            timeout_restored: true,
            connection_closed: true,
        },
    });
    finish_real_index(response, state, &scratch_run_key).await
}

async fn audit_real_index(
    state: &AppState,
    input: &QueryLabRealIndexInput,
    started: Instant,
    result: &Result<QueryLabRealIndexResponse, AppError>,
) {
    let baseline = &input.baseline;
    let session_start = state.session_starts.read().await.get(&baseline.session_id).cloned();
    let (ok, error, code) = match result {
        Ok(_) => (true, None, ""),
        Err(error) => (false, Some(error.message.clone()), error.code.as_str()),
    };
    let entry = crate::commands::audit::AuditInsert {
        run_id: format!("query-lab-real-index:{}", baseline.run_key), stmt_index: Some(1), stmt_total: Some(1),
        session_id: baseline.session_id.to_string(), tab_title: "Query Optimization Lab (real index)".into(),
        database: baseline.scratch.as_ref().map(|scratch| scratch.database.clone()).unwrap_or_else(|| baseline.database.clone()),
        source: "query_lab_real_index".into(),
        started_at: crate::commands::audit::lifecycle_now(), ended_at: crate::commands::audit::lifecycle_now(),
        duration_ms: started.elapsed().as_millis() as i64,
        connection_name: session_start.as_ref().map(|value| value.connection_name.clone()).unwrap_or_default(),
        db_user: session_start.as_ref().map(|value| value.db_user.clone()).unwrap_or_default(),
        engine: baseline.engine.clone(), ok, rows_out: 0, rows_affected: None,
        error, error_code: code.into(), db_code: String::new(), sqlstate: String::new(),
        sql: baseline.sql.clone(),
    };
    if let Err(error) = crate::commands::audit::insert(&state.history, &entry).await {
        eprintln!("[audit] query lab real-index insert failed: {error:#}");
    }
}

pub async fn execute_real_index(
    input: QueryLabRealIndexInput,
    state: &AppState,
) -> Result<QueryLabRealIndexResponse, AppError> {
    let started = Instant::now();
    let key = crate::state::ext_job_key(input.baseline.session_id, &input.baseline.run_key);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut jobs = state.ext_jobs.write().await;
        if jobs.contains_key(&key) {
            return Err(AppError::bad_request("This real-index Query Lab run is already active"));
        }
        jobs.insert(key.clone(), cancel_tx);
    }
    let result = real_index_inner(input.clone(), state, &mut cancel_rx, None).await;
    state.ext_jobs.write().await.remove(&key);
    audit_real_index(state, &input, started, &result).await;
    result
}

#[tauri::command]
pub async fn query_lab_real_index_measure(
    input: QueryLabRealIndexInput,
    state: tauri::State<'_, AppState>,
) -> Result<QueryLabRealIndexResponse, AppError> {
    execute_real_index(input, &state).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabRewriteCandidateInput {
    pub id: String,
    pub name: String,
    pub sql: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabRewriteInput {
    pub baseline: QueryLabBaselineInput,
    pub candidate: QueryLabRewriteCandidateInput,
    pub row_order_policy: String,
    pub max_rows: u64,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabResultColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabResultEvidence {
    pub columns: Vec<QueryLabResultColumn>,
    pub rows_observed: u64,
    pub bytes_observed: u64,
    pub sha256: Option<String>,
    pub complete: bool,
    pub unverified_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabRewriteResponse {
    pub run_key: String,
    pub spec_sha256: String,
    pub candidate_id: String,
    pub backend_id: u64,
    pub correctness: String,
    pub reason: Option<String>,
    pub row_order_policy: String,
    pub max_rows: u64,
    pub max_bytes: u64,
    pub baseline: QueryLabResultEvidence,
    pub candidate: QueryLabResultEvidence,
    pub cleanup: QueryLabCleanup,
}

fn hash_part(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}

fn scalar_text(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::String(text) => Ok(text.clone()),
        serde_json::Value::Number(number) => Ok(number.to_string()),
        serde_json::Value::Bool(value) => Ok(if *value { "1" } else { "0" }.into()),
        _ => Err("Query Lab scalar value does not match its declared type".into()),
    }
}

fn canonical_json(value: &serde_json::Value, output: &mut Vec<u8>) -> Result<(), String> {
    match value {
        serde_json::Value::Null => output.push(b'z'),
        serde_json::Value::Bool(value) => {
            output.push(b'b');
            output.push(u8::from(*value));
        },
        serde_json::Value::Number(number) => {
            let exact = number.as_i64().map(|value| value.to_string())
                .or_else(|| number.as_u64().map(|value| value.to_string()))
                .ok_or_else(|| "Query Lab JSON number is not an exact integer; lossy floating-point comparison is refused".to_string())?;
            output.push(b'n');
            output.extend_from_slice(&(exact.len() as u64).to_be_bytes());
            output.extend_from_slice(exact.as_bytes());
        },
        serde_json::Value::String(text) => {
            output.push(b's');
            output.extend_from_slice(&(text.len() as u64).to_be_bytes());
            output.extend_from_slice(text.as_bytes());
        },
        serde_json::Value::Array(values) => {
            output.push(b'a');
            output.extend_from_slice(&(values.len() as u64).to_be_bytes());
            for value in values {
                let mut encoded = Vec::new();
                canonical_json(value, &mut encoded)?;
                output.extend_from_slice(&(encoded.len() as u64).to_be_bytes());
                output.extend_from_slice(&encoded);
            }
        },
        serde_json::Value::Object(values) => {
            output.push(b'o');
            output.extend_from_slice(&(values.len() as u64).to_be_bytes());
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            for (key, value) in entries {
                output.extend_from_slice(&(key.len() as u64).to_be_bytes());
                output.extend_from_slice(key.as_bytes());
                let mut encoded = Vec::new();
                canonical_json(value, &mut encoded)?;
                output.extend_from_slice(&(encoded.len() as u64).to_be_bytes());
                output.extend_from_slice(&encoded);
            }
        },
    }
    Ok(())
}

fn canonical_cell(
    engine: Engine,
    type_name: &str,
    value: &serde_json::Value,
) -> Result<Vec<u8>, String> {
    if value.is_null() {
        return Ok(vec![b'z']);
    }
    let upper = type_name.to_ascii_uppercase();
    let integer = match engine {
        Engine::Mysql => matches!(upper.as_str(), "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" | "YEAR" | "BIT"),
        Engine::Postgres => matches!(upper.as_str(), "INT2" | "INT4" | "INT8" | "OID"),
        _ => false,
    };
    let decimal = matches!(upper.as_str(), "DECIMAL" | "NUMERIC" | "DEC" | "FIXED" | "MONEY");
    let boolean = matches!(upper.as_str(), "BOOL" | "BOOLEAN");
    let textual = match engine {
        Engine::Mysql => matches!(upper.as_str(), "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET"),
        Engine::Postgres => matches!(upper.as_str(), "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" | "UUID"),
        _ => false,
    };
    let temporal = matches!(upper.as_str(), "DATE" | "DATETIME" | "TIMESTAMP" | "TIMESTAMPTZ" | "TIME");
    let binary = match engine {
        Engine::Mysql => upper.contains("BINARY") || upper.contains("BLOB"),
        Engine::Postgres => upper == "BYTEA",
        _ => false,
    };
    let (tag, payload) = if integer {
        let text = scalar_text(value)?;
        let parsed = text.parse::<i128>().map_err(|_| "Query Lab integer is not an exact i128".to_string())?;
        (b'i', parsed.to_string().into_bytes())
    } else if decimal {
        let text = scalar_text(value)?;
        let parsed = <rust_decimal::Decimal as std::str::FromStr>::from_str(&text)
            .map_err(|_| "Query Lab decimal is not exact or finite".to_string())?;
        (b'd', parsed.normalize().to_string().into_bytes())
    } else if boolean {
        let value = match value {
            serde_json::Value::Bool(value) => *value,
            serde_json::Value::String(text) if text == "1" || text.eq_ignore_ascii_case("true") => true,
            serde_json::Value::String(text) if text == "0" || text.eq_ignore_ascii_case("false") => false,
            serde_json::Value::Number(number) if number.as_u64() == Some(1) => true,
            serde_json::Value::Number(number) if number.as_u64() == Some(0) => false,
            _ => return Err("Query Lab boolean does not match its declared type".into()),
        };
        (b'b', vec![u8::from(value)])
    } else if textual || temporal {
        (b's', scalar_text(value)?.into_bytes())
    } else if binary {
        if engine != Engine::Postgres {
            return Err(format!("Query Lab refuses {type_name} equality because the MySQL decoder does not preserve raw-byte versus UTF-8 ambiguity"));
        }
        let encoded = value.as_str().ok_or_else(|| "Query Lab BYTEA is not hexadecimal text".to_string())?;
        (b'b', hex::decode(encoded).map_err(|_| "Query Lab BYTEA is not valid hexadecimal".to_string())?)
    } else if matches!(upper.as_str(), "FLOAT" | "DOUBLE" | "REAL" | "FLOAT4" | "FLOAT8") {
        return Err(format!("Query Lab refuses lossy floating-point equality for {type_name}"));
    } else if matches!(upper.as_str(), "JSON" | "JSONB") {
        let mut encoded = Vec::new();
        canonical_json(value, &mut encoded)?;
        (b'j', encoded)
    } else {
        return Err(format!("Query Lab has no exact canonical decoder for {type_name}"));
    };
    let mut output = vec![tag];
    output.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    output.extend_from_slice(&payload);
    Ok(output)
}

fn result_columns(result: &QueryResult) -> Vec<QueryLabResultColumn> {
    result.columns.iter().map(|column| QueryLabResultColumn {
        name: column.name.clone(),
        type_name: column.type_name.clone(),
    }).collect()
}

fn rewrite_result_evidence(
    engine: Engine,
    result: &QueryResult,
    row_order_policy: &str,
    max_bytes: u64,
) -> QueryLabResultEvidence {
    let columns = result_columns(result);
    let rows_observed = result.rows.len() as u64;
    let bytes_observed = result.rows.iter().map(|row| crate::db::types::row_bytes(row) as u64).sum::<u64>();
    let unverified = |reason: String| QueryLabResultEvidence {
        columns: columns.clone(), rows_observed, bytes_observed,
        sha256: None, complete: false, unverified_reason: Some(reason),
    };
    if result.truncated || result.rows.len() > 100_000 {
        return unverified("Query Lab result exceeded the declared row/driver budget; no correctness verdict is available".into());
    }
    if bytes_observed > max_bytes {
        return unverified(format!("Query Lab result exceeded the declared {max_bytes}-byte budget; no correctness verdict is available"));
    }
    let mut encoded_rows = Vec::with_capacity(result.rows.len());
    for row in &result.rows {
        if row.len() != result.columns.len() {
            return unverified("Query Lab row/column metadata mismatch prevents exact hashing".into());
        }
        let mut encoded = Vec::new();
        for (column, value) in result.columns.iter().zip(row) {
            match canonical_cell(engine, &column.type_name, value) {
                Ok(cell) => {
                    encoded.extend_from_slice(&(cell.len() as u64).to_be_bytes());
                    encoded.extend_from_slice(&cell);
                },
                Err(reason) => return unverified(reason),
            }
        }
        encoded_rows.push(encoded);
    }
    if row_order_policy == "multiset" {
        encoded_rows.sort();
    }
    let mut hash = Sha256::new();
    hash_part(&mut hash, b"TxUI Query Lab result v1");
    hash_part(&mut hash, row_order_policy.as_bytes());
    for column in &columns {
        hash_part(&mut hash, column.name.as_bytes());
        hash_part(&mut hash, column.type_name.as_bytes());
    }
    hash.update((encoded_rows.len() as u64).to_be_bytes());
    for row in encoded_rows {
        hash_part(&mut hash, &row);
    }
    QueryLabResultEvidence {
        columns,
        rows_observed,
        bytes_observed,
        sha256: Some(format!("{:x}", hash.finalize())),
        complete: true,
        unverified_reason: None,
    }
}

fn rewrite_correctness(
    baseline: &QueryLabResultEvidence,
    candidate: &QueryLabResultEvidence,
) -> (String, Option<String>) {
    if baseline.columns != candidate.columns {
        return ("different".into(), Some("Ordered column names/types differ; result equality is invalid".into()));
    }
    if !baseline.complete || !candidate.complete {
        let reasons = [baseline.unverified_reason.clone(), candidate.unverified_reason.clone()]
            .into_iter().flatten().collect::<Vec<_>>().join(" | ");
        return ("unverified".into(), Some(reasons));
    }
    if baseline.sha256 != candidate.sha256 {
        return ("different".into(), Some("Complete canonical result hashes differ; a faster rewrite would be invalid_results, never a winner".into()));
    }
    ("equal".into(), None)
}

fn select_or_with(sql: &str) -> bool {
    let keyword = sql.trim_start().chars().take_while(|character| character.is_ascii_alphabetic())
        .collect::<String>().to_ascii_lowercase();
    matches!(keyword.as_str(), "select" | "with")
}

fn validate_rewrite_candidate(
    engine: Engine,
    candidate: &QueryLabRewriteCandidateInput,
) -> Result<(), AppError> {
    if candidate.id.is_empty() || candidate.id.len() > 80 || candidate.name.is_empty() || candidate.name.len() > 160 {
        return Err(AppError::bad_request("Query Lab rewrite candidate id/name is invalid"));
    }
    if candidate.sql.len() > MAX_QUERY_LAB_SQL_BYTES {
        return Err(AppError::bad_request("Query Lab rewrite SQL exceeds the 2 MiB limit"));
    }
    let statements = crate::sqlguard::split_statements_for(Some(engine), &candidate.sql);
    if statements.len() != 1 || !select_or_with(&candidate.sql) || !crate::sqlguard::is_read_family(&candidate.sql)
        || crate::sqlguard::is_write_for(Some(engine), &candidate.sql)
    {
        return Err(AppError::guard("Query Lab rewrite accepts exactly one read-only statement"));
    }
    Ok(())
}

async fn rewrite_inner(
    input: QueryLabRewriteInput,
    state: &AppState,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<QueryLabRewriteResponse, AppError> {
    let validated = validate_input(&input.baseline, state).await?;
    if input.baseline.execution_mode != "measured" || input.baseline.index_evidence_mode != "none"
        || !input.baseline.has_rewrite_candidate || !input.baseline.evidence.result_equality
        || !select_or_with(&input.baseline.sql)
    {
        return Err(AppError::guard("Query Lab rewrite requires measured mode, result-equality evidence and no index candidate"));
    }
    if !matches!(input.row_order_policy.as_str(), "ordered" | "multiset") {
        return Err(AppError::bad_request("Query Lab row order policy must be ordered or multiset"));
    }
    if !(1..=100_000).contains(&input.max_rows) || !(1024..=64 * 1024 * 1024).contains(&input.max_bytes) {
        return Err(AppError::bad_request("Query Lab rewrite budgets exceed their declared bounds"));
    }
    validate_rewrite_candidate(validated.engine, &input.candidate)?;
    state.guard_statement(&input.baseline.session_id, &input.candidate.sql).await?;
    let database = validated.execution_database.clone();
    let mut conn = RealConnection::acquire(&input.baseline, state, &database, validated.timeout_ms).await?;
    let backend_id = conn.backend_id();
    let mut result = async {
        let baseline = conn.capped(&input.baseline.sql, input.max_rows as usize, cancel).await?;
        let baseline = rewrite_result_evidence(validated.engine, &baseline, &input.row_order_policy, input.max_bytes);
        let candidate = conn.capped(&input.candidate.sql, input.max_rows as usize, cancel).await?;
        let candidate = rewrite_result_evidence(validated.engine, &candidate, &input.row_order_policy, input.max_bytes);
        let (correctness, reason) = rewrite_correctness(&baseline, &candidate);
        Ok((correctness, reason, baseline, candidate))
    }.await;
    if let Err(error) = conn.restore().await {
        if result.is_ok() { result = Err(error); }
    }
    if let Err(error) = conn.close().await {
        if result.is_ok() { result = Err(error); }
    }
    result.map(|(correctness, reason, baseline, candidate)| QueryLabRewriteResponse {
        run_key: input.baseline.run_key.clone(),
        spec_sha256: input.baseline.spec_sha256.clone(),
        candidate_id: input.candidate.id.clone(),
        backend_id,
        correctness,
        reason,
        row_order_policy: input.row_order_policy,
        max_rows: input.max_rows,
        max_bytes: input.max_bytes,
        baseline,
        candidate,
        cleanup: QueryLabCleanup { timeout_restored: true, connection_closed: true, hypopg_reset: None },
    })
}

async fn audit_rewrite(
    state: &AppState,
    input: &QueryLabRewriteInput,
    started: Instant,
    result: &Result<QueryLabRewriteResponse, AppError>,
) {
    let baseline = &input.baseline;
    let session_start = state.session_starts.read().await.get(&baseline.session_id).cloned();
    let (ok, error, code) = match result {
        Ok(_) => (true, None, ""),
        Err(error) => (false, Some(error.message.clone()), error.code.as_str()),
    };
    let entry = crate::commands::audit::AuditInsert {
        run_id: format!("query-lab-rewrite:{}", baseline.run_key), stmt_index: Some(1), stmt_total: Some(1),
        session_id: baseline.session_id.to_string(), tab_title: "Query Optimization Lab (rewrite)".into(),
        database: baseline.scratch.as_ref().map(|scratch| scratch.database.clone()).unwrap_or_else(|| baseline.database.clone()),
        source: "query_lab_rewrite".into(),
        started_at: crate::commands::audit::lifecycle_now(), ended_at: crate::commands::audit::lifecycle_now(),
        duration_ms: started.elapsed().as_millis() as i64,
        connection_name: session_start.as_ref().map(|value| value.connection_name.clone()).unwrap_or_default(),
        db_user: session_start.as_ref().map(|value| value.db_user.clone()).unwrap_or_default(),
        engine: baseline.engine.clone(), ok, rows_out: 0, rows_affected: None,
        error, error_code: code.into(), db_code: String::new(), sqlstate: String::new(),
        sql: format!("{}\n-- Query Lab rewrite candidate: {}\n{}", baseline.sql, input.candidate.id, input.candidate.sql),
    };
    if let Err(error) = crate::commands::audit::insert(&state.history, &entry).await {
        eprintln!("[audit] query lab rewrite insert failed: {error:#}");
    }
}

pub async fn execute_rewrite(
    input: QueryLabRewriteInput,
    state: &AppState,
) -> Result<QueryLabRewriteResponse, AppError> {
    let started = Instant::now();
    let key = crate::state::ext_job_key(input.baseline.session_id, &input.baseline.run_key);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut jobs = state.ext_jobs.write().await;
        if jobs.contains_key(&key) {
            return Err(AppError::bad_request("This Query Lab rewrite run is already active"));
        }
        jobs.insert(key.clone(), cancel_tx);
    }
    let result = rewrite_inner(input.clone(), state, &mut cancel_rx).await;
    state.ext_jobs.write().await.remove(&key);
    audit_rewrite(state, &input, started, &result).await;
    result
}

#[tauri::command]
pub async fn query_lab_rewrite_measure(
    input: QueryLabRewriteInput,
    state: tauri::State<'_, AppState>,
) -> Result<QueryLabRewriteResponse, AppError> {
    execute_rewrite(input, &state).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabBenchmarkInput {
    pub rewrite: QueryLabRewriteInput,
    pub warmup_runs: u64,
    pub repetitions: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabBenchmarkPair {
    pub repetition: u64,
    pub order: String,
    pub baseline_ms: u64,
    pub candidate_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabTimingSummary {
    pub count: u64,
    pub min_ms: u64,
    pub median_ms: f64,
    pub p95_ms: u64,
    pub max_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryLabBenchmarkResponse {
    pub run_key: String,
    pub spec_sha256: String,
    pub candidate_id: String,
    pub backend_id: u64,
    pub warmup_runs: u64,
    pub repetitions: u64,
    pub pairs: Vec<QueryLabBenchmarkPair>,
    pub baseline_ms: Vec<u64>,
    pub candidate_ms: Vec<u64>,
    pub baseline: QueryLabTimingSummary,
    pub candidate: QueryLabTimingSummary,
    pub baseline_sha256: Option<String>,
    pub candidate_sha256: Option<String>,
    pub cleanup: QueryLabCleanup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BenchmarkSide {
    Baseline,
    Candidate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BenchmarkStep {
    measured: bool,
    repetition: u64,
    side: BenchmarkSide,
}

fn benchmark_steps(warmup_runs: u64, repetitions: u64) -> Result<Vec<BenchmarkStep>, AppError> {
    if warmup_runs > 10 || repetitions == 0 || repetitions > 30 {
        return Err(AppError::bad_request("Query Lab benchmark requires 0–10 warmups and 1–30 repetitions"));
    }
    let mut steps = Vec::with_capacity((warmup_runs as usize + repetitions as usize) * 2);
    for (measured, count) in [(false, warmup_runs), (true, repetitions)] {
        for repetition in 1..=count {
            let baseline_first = repetition % 2 == 1;
            steps.push(BenchmarkStep { measured, repetition, side: if baseline_first { BenchmarkSide::Baseline } else { BenchmarkSide::Candidate } });
            steps.push(BenchmarkStep { measured, repetition, side: if baseline_first { BenchmarkSide::Candidate } else { BenchmarkSide::Baseline } });
        }
    }
    Ok(steps)
}

fn timing_summary(values: &[u64]) -> Result<QueryLabTimingSummary, AppError> {
    if values.is_empty() {
        return Err(AppError::local("Query Lab benchmark has no measured timings"));
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let middle = sorted.len() / 2;
    let median_ms = if sorted.len() % 2 == 1 {
        sorted[middle] as f64
    } else {
        (sorted[middle - 1] + sorted[middle]) as f64 / 2.0
    };
    Ok(QueryLabTimingSummary {
        count: sorted.len() as u64,
        min_ms: sorted[0],
        median_ms,
        p95_ms: sorted[(sorted.len() * 95).div_ceil(100).saturating_sub(1)],
        max_ms: sorted[sorted.len() - 1],
    })
}

#[derive(Debug, Clone, Copy, Default)]
struct BenchmarkControl {
    cancel_after: Option<u64>,
}

async fn benchmark_inner(
    input: QueryLabBenchmarkInput,
    state: &AppState,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
    control: BenchmarkControl,
) -> Result<QueryLabBenchmarkResponse, AppError> {
    let steps = benchmark_steps(input.warmup_runs, input.repetitions)?;
    let correctness = rewrite_inner(input.rewrite.clone(), state, cancel).await?;
    if correctness.correctness != "equal" {
        return Err(AppError::guard("Query Lab benchmark requires equal rewrite results; invalid_results cannot be timed as a winner"));
    }
    let validated = validate_input(&input.rewrite.baseline, state).await?;
    let database = validated.execution_database.clone();
    let mut conn = RealConnection::acquire(&input.rewrite.baseline, state, &database, validated.timeout_ms).await?;
    let backend_id = conn.backend_id();
    let mut result = async {
        let mut pairs = Vec::with_capacity(input.repetitions as usize);
        let mut baseline_ms = Vec::with_capacity(input.repetitions as usize);
        let mut candidate_ms = Vec::with_capacity(input.repetitions as usize);
        let mut current_pair: Option<QueryLabBenchmarkPair> = None;
        let mut completed = 0_u64;
        for step in steps {
            if cancel.try_recv().is_ok() {
                return Err(AppError::new(ErrorCode::Cancelled, "Query Lab benchmark was cancelled between runs"));
            }
            let sql = match step.side {
                BenchmarkSide::Baseline => &input.rewrite.baseline.sql,
                BenchmarkSide::Candidate => &input.rewrite.candidate.sql,
            };
            let elapsed = conn.timed(sql, validated.timeout_ms, cancel).await?;
            completed += 1;
            if step.measured {
                if current_pair.as_ref().is_none_or(|pair| pair.repetition != step.repetition) {
                    if let Some(pair) = current_pair.take() { pairs.push(pair); }
                    current_pair = Some(QueryLabBenchmarkPair {
                        repetition: step.repetition,
                        order: if step.side == BenchmarkSide::Baseline { "baseline_first".into() } else { "candidate_first".into() },
                        baseline_ms: 0,
                        candidate_ms: 0,
                    });
                }
                let pair = current_pair.as_mut().expect("pair was just initialized");
                match step.side {
                    BenchmarkSide::Baseline => {
                        pair.baseline_ms = elapsed;
                        baseline_ms.push(elapsed);
                    },
                    BenchmarkSide::Candidate => {
                        pair.candidate_ms = elapsed;
                        candidate_ms.push(elapsed);
                    },
                }
            }
            if control.cancel_after == Some(completed) {
                return Err(AppError::new(ErrorCode::Cancelled, "Query Lab benchmark was cancelled between runs"));
            }
        }
        if let Some(pair) = current_pair { pairs.push(pair); }
        let baseline = timing_summary(&baseline_ms)?;
        let candidate = timing_summary(&candidate_ms)?;
        Ok((pairs, baseline_ms, candidate_ms, baseline, candidate))
    }.await;
    if let Err(error) = conn.restore().await {
        if result.is_ok() { result = Err(error); }
    }
    if let Err(error) = conn.close().await {
        if result.is_ok() { result = Err(error); }
    }
    result.map(|(pairs, baseline_ms, candidate_ms, baseline, candidate)| QueryLabBenchmarkResponse {
        run_key: input.rewrite.baseline.run_key.clone(),
        spec_sha256: input.rewrite.baseline.spec_sha256.clone(),
        candidate_id: input.rewrite.candidate.id.clone(),
        backend_id,
        warmup_runs: input.warmup_runs,
        repetitions: input.repetitions,
        pairs,
        baseline_ms,
        candidate_ms,
        baseline,
        candidate,
        baseline_sha256: correctness.baseline.sha256,
        candidate_sha256: correctness.candidate.sha256,
        cleanup: QueryLabCleanup { timeout_restored: true, connection_closed: true, hypopg_reset: None },
    })
}

async fn audit_benchmark(
    state: &AppState,
    input: &QueryLabBenchmarkInput,
    started: Instant,
    result: &Result<QueryLabBenchmarkResponse, AppError>,
) {
    let rewrite = &input.rewrite;
    let baseline = &rewrite.baseline;
    let session_start = state.session_starts.read().await.get(&baseline.session_id).cloned();
    let (ok, error, code) = match result {
        Ok(_) => (true, None, ""),
        Err(error) => (false, Some(error.message.clone()), error.code.as_str()),
    };
    let entry = crate::commands::audit::AuditInsert {
        run_id: format!("query-lab-benchmark:{}", baseline.run_key), stmt_index: Some(1), stmt_total: Some(1),
        session_id: baseline.session_id.to_string(), tab_title: "Query Optimization Lab (benchmark)".into(),
        database: baseline.scratch.as_ref().map(|scratch| scratch.database.clone()).unwrap_or_else(|| baseline.database.clone()),
        source: "query_lab_benchmark".into(),
        started_at: crate::commands::audit::lifecycle_now(), ended_at: crate::commands::audit::lifecycle_now(),
        duration_ms: started.elapsed().as_millis() as i64,
        connection_name: session_start.as_ref().map(|value| value.connection_name.clone()).unwrap_or_default(),
        db_user: session_start.as_ref().map(|value| value.db_user.clone()).unwrap_or_default(),
        engine: baseline.engine.clone(), ok, rows_out: 0, rows_affected: None,
        error, error_code: code.into(), db_code: String::new(), sqlstate: String::new(),
        sql: format!("{}\n-- Query Lab benchmark candidate: {}\n{}", baseline.sql, rewrite.candidate.id, rewrite.candidate.sql),
    };
    if let Err(error) = crate::commands::audit::insert(&state.history, &entry).await {
        eprintln!("[audit] query lab benchmark insert failed: {error:#}");
    }
}

pub async fn execute_benchmark(
    input: QueryLabBenchmarkInput,
    state: &AppState,
) -> Result<QueryLabBenchmarkResponse, AppError> {
    let started = Instant::now();
    let key = crate::state::ext_job_key(input.rewrite.baseline.session_id, &input.rewrite.baseline.run_key);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut jobs = state.ext_jobs.write().await;
        if jobs.contains_key(&key) {
            return Err(AppError::bad_request("This Query Lab benchmark is already active"));
        }
        jobs.insert(key.clone(), cancel_tx);
    }
    let result = benchmark_inner(input.clone(), state, &mut cancel_rx, BenchmarkControl::default()).await;
    state.ext_jobs.write().await.remove(&key);
    audit_benchmark(state, &input, started, &result).await;
    result
}

#[tauri::command]
pub async fn query_lab_benchmark(
    input: QueryLabBenchmarkInput,
    state: tauri::State<'_, AppState>,
) -> Result<QueryLabBenchmarkResponse, AppError> {
    execute_benchmark(input, &state).await
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
                environment: Some("dev".into()), read_only: false, run_key: None,
            }),
        }
    }

    fn rewrite_input(session_id: Uuid, connection_id: Uuid, engine: Engine) -> QueryLabRewriteInput {
        let mut baseline = input(session_id, connection_id, engine, "measured");
        baseline.sql = "SELECT id, customer_id FROM orders WHERE customer_id = 1 ORDER BY id".into();
        baseline.has_rewrite_candidate = true;
        baseline.evidence.result_equality = true;
        QueryLabRewriteInput {
            baseline,
            candidate: QueryLabRewriteCandidateInput {
                id: "equivalent".into(), name: "Equivalent rewrite".into(),
                sql: "SELECT id, customer_id FROM orders WHERE customer_id = 1 AND id > 0 ORDER BY id".into(),
            },
            row_order_policy: "ordered".into(),
            max_rows: 10_000,
            max_bytes: 1024 * 1024,
        }
    }

    fn real_input(session_id: Uuid, connection_id: Uuid, engine: Engine) -> QueryLabRealIndexInput {
        let mut baseline = input(session_id, connection_id, engine, "measured");
        baseline.sql = "SELECT customer_id FROM orders WHERE customer_id = 1".into();
        baseline.index_evidence_mode = "real".into();
        let scratch_run_key = Uuid::new_v4().to_string();
        baseline.scratch = Some(QueryLabScratchInput {
            session_id, connection_id,
            database: "txui_mig_0123456789abcdef".into(),
            environment: Some("dev".into()), read_only: false,
            run_key: Some(scratch_run_key),
        });
        QueryLabRealIndexInput {
            baseline,
            candidate: QueryLabHypopgCandidateInput {
                id: "customer-index".into(), name: "Customer index".into(),
                table: "orders".into(), columns: vec!["customer_id".into()],
                unique: false, where_clause: None,
            },
        }
    }

    async fn insert_real_scratch(state: &AppState, input: &QueryLabRealIndexInput, status: &str) {
        let scratch = input.baseline.scratch.as_ref().unwrap();
        sqlx::query(
            "INSERT INTO migration_scratch (run_key, session_id, connection_id, engine, name, status)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(scratch.run_key.as_deref().unwrap())
        .bind(input.baseline.session_id.to_string())
        .bind(input.baseline.connection_id.to_string())
        .bind(&input.baseline.engine)
        .bind(&scratch.database)
        .bind(status)
        .execute(&state.history).await.unwrap();
    }

    #[tokio::test]
    async fn real_index_requires_exact_owned_migration_scratch_identity() {
        let (state, session, connection) = state_with_session(Engine::Postgres, Some("dev"), false).await;
        let valid = real_input(session, connection, Engine::Postgres);
        assert!(validate_input(&valid.baseline, &state).await.is_err(), "missing durable record");
        insert_real_scratch(&state, &valid, "active").await;
        assert!(validate_input(&valid.baseline, &state).await.is_ok());

        let mut wrong_database = valid.clone();
        wrong_database.baseline.scratch.as_mut().unwrap().database = "txui_mig_fedcba9876543210".into();
        assert!(validate_input(&wrong_database.baseline, &state).await.is_err());
        let mut wrong_connection = valid.clone();
        wrong_connection.baseline.scratch.as_mut().unwrap().connection_id = Uuid::new_v4();
        assert!(validate_input(&wrong_connection.baseline, &state).await.is_err());
        let mut no_run_key = valid.clone();
        no_run_key.baseline.scratch.as_mut().unwrap().run_key = None;
        assert!(validate_input(&no_run_key.baseline, &state).await.is_err());
        let mut wrong_safety = valid.clone();
        wrong_safety.baseline.scratch.as_mut().unwrap().read_only = true;
        assert!(validate_input(&wrong_safety.baseline, &state).await.is_err());

        let scratch_key = valid.baseline.scratch.as_ref().unwrap().run_key.as_deref().unwrap();
        sqlx::query("UPDATE migration_scratch SET status = 'cleanup_failed' WHERE run_key = ?")
            .bind(scratch_key).execute(&state.history).await.unwrap();
        assert!(validate_input(&valid.baseline, &state).await.is_err(), "non-active scratch");
    }

    #[test]
    fn real_index_ddl_cannot_escape_scratch_or_use_mysql_partial_indexes() {
        let candidate = QueryLabHypopgCandidateInput {
            id: "candidate".into(), name: "Candidate".into(), table: "orders".into(),
            columns: vec!["customer_id".into()], unique: false, where_clause: None,
        };
        let mysql = real_index_sql(Engine::Mysql, &candidate, "txui_lab_0123456789abcdef").unwrap();
        assert!(mysql.contains("CREATE INDEX `txui_lab_0123456789abcdef` ON `orders`"));
        let mut qualified = candidate.clone();
        qualified.table = "shop.orders".into();
        assert!(real_index_sql(Engine::Mysql, &qualified, "txui_lab_0123456789abcdef").is_err());
        let mut partial = candidate;
        partial.where_clause = Some("customer_id > 0".into());
        assert!(real_index_sql(Engine::Mysql, &partial, "txui_lab_0123456789abcdef").is_err());
        assert!(real_index_sql(Engine::Postgres, &partial, "txui_lab_0123456789abcdef").unwrap().contains("WHERE customer_id > 0"));
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
    fn benchmark_schedule_and_summary_match_the_pure_contract() {
        let steps = benchmark_steps(2, 4).unwrap();
        assert_eq!(steps.len(), 12);
        assert_eq!(steps.iter().take(4).map(|step| step.side).collect::<Vec<_>>(), [
            BenchmarkSide::Baseline, BenchmarkSide::Candidate,
            BenchmarkSide::Candidate, BenchmarkSide::Baseline,
        ]);
        assert_eq!(steps.iter().skip(4).map(|step| step.side).collect::<Vec<_>>(), [
            BenchmarkSide::Baseline, BenchmarkSide::Candidate,
            BenchmarkSide::Candidate, BenchmarkSide::Baseline,
            BenchmarkSide::Baseline, BenchmarkSide::Candidate,
            BenchmarkSide::Candidate, BenchmarkSide::Baseline,
        ]);
        assert_eq!(benchmark_steps(10, 30).unwrap().len(), 80);
        assert!(benchmark_steps(11, 1).is_err());
        assert!(benchmark_steps(0, 31).is_err());
        let summary = timing_summary(&[9, 1, 5, 3, 7, 2, 8]).unwrap();
        assert_eq!(summary.count, 7);
        assert_eq!(summary.min_ms, 1);
        assert_eq!(summary.median_ms, 5.0);
        assert_eq!(summary.p95_ms, 9);
        assert_eq!(summary.max_ms, 9);
        assert_eq!(timing_summary(&[10, 1, 7, 3]).unwrap().median_ms, 5.0);
    }

    fn grid(columns: &[(&str, &str)], rows: Vec<Vec<serde_json::Value>>) -> QueryResult {
        QueryResult {
            result_sets: vec![],
            columns: columns.iter().map(|(name, type_name)| crate::db::types::ColumnInfo {
                name: (*name).into(), type_name: (*type_name).into(), nullable: true,
            }).collect(),
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
    fn rewrite_hash_enforces_ordered_columns_and_explicit_row_order_with_duplicates() {
        let left = grid(&[("id", "INT8")], vec![vec![1.into()], vec![1.into()], vec![2.into()]]);
        let right = grid(&[("id", "INT8")], vec![vec![2.into()], vec![1.into()], vec![1.into()]]);
        let ordered_left = rewrite_result_evidence(Engine::Postgres, &left, "ordered", 1024);
        let ordered_right = rewrite_result_evidence(Engine::Postgres, &right, "ordered", 1024);
        assert_eq!(rewrite_correctness(&ordered_left, &ordered_right).0, "different");
        let multiset_left = rewrite_result_evidence(Engine::Postgres, &left, "multiset", 1024);
        let multiset_right = rewrite_result_evidence(Engine::Postgres, &right, "multiset", 1024);
        assert_eq!(rewrite_correctness(&multiset_left, &multiset_right).0, "equal");
        let deduplicated = grid(&[("id", "INT8")], vec![vec![1.into()], vec![2.into()]]);
        let deduplicated = rewrite_result_evidence(Engine::Postgres, &deduplicated, "multiset", 1024);
        assert_eq!(rewrite_correctness(&multiset_left, &deduplicated).0, "different");

        let columns_left = grid(&[("id", "INT8"), ("label", "TEXT")], vec![]);
        let columns_right = grid(&[("label", "TEXT"), ("id", "INT8")], vec![]);
        let left = rewrite_result_evidence(Engine::Postgres, &columns_left, "ordered", 1024);
        let right = rewrite_result_evidence(Engine::Postgres, &columns_right, "ordered", 1024);
        assert_eq!(rewrite_correctness(&left, &right).0, "different");
    }

    #[test]
    fn rewrite_hash_distinguishes_null_empty_decimal_scale_and_binary() {
        let null = grid(&[("value", "TEXT")], vec![vec![serde_json::Value::Null]]);
        let empty = grid(&[("value", "TEXT")], vec![vec!["".into()]]);
        let null = rewrite_result_evidence(Engine::Postgres, &null, "ordered", 1024);
        let empty = rewrite_result_evidence(Engine::Postgres, &empty, "ordered", 1024);
        assert_eq!(rewrite_correctness(&null, &empty).0, "different");

        let one = grid(&[("amount", "NUMERIC")], vec![vec!["1.0".into()]]);
        let scaled = grid(&[("amount", "NUMERIC")], vec![vec!["1.00".into()]]);
        let one = rewrite_result_evidence(Engine::Postgres, &one, "ordered", 1024);
        let scaled = rewrite_result_evidence(Engine::Postgres, &scaled, "ordered", 1024);
        assert_eq!(rewrite_correctness(&one, &scaled).0, "equal");
        let changed = grid(&[("amount", "NUMERIC")], vec![vec!["1.01".into()]]);
        let changed = rewrite_result_evidence(Engine::Postgres, &changed, "ordered", 1024);
        assert_eq!(rewrite_correctness(&one, &changed).0, "different");

        let binary = grid(&[("payload", "BYTEA")], vec![vec!["00ff".into()]]);
        let changed_binary = grid(&[("payload", "BYTEA")], vec![vec!["00fe".into()]]);
        let binary = rewrite_result_evidence(Engine::Postgres, &binary, "ordered", 1024);
        let changed_binary = rewrite_result_evidence(Engine::Postgres, &changed_binary, "ordered", 1024);
        assert_eq!(rewrite_correctness(&binary, &changed_binary).0, "different");
    }

    #[test]
    fn rewrite_hash_refuses_lossy_or_ambiguous_values() {
        let float = grid(&[("ratio", "FLOAT8")], vec![vec![serde_json::json!(1.5)]]);
        let evidence = rewrite_result_evidence(Engine::Postgres, &float, "ordered", 1024);
        assert!(!evidence.complete);
        assert!(evidence.unverified_reason.unwrap().contains("floating-point"));
        let null_float = grid(&[("ratio", "FLOAT8")], vec![vec![serde_json::Value::Null]]);
        assert!(rewrite_result_evidence(Engine::Postgres, &null_float, "ordered", 1024).complete);
        let binary = grid(&[("payload", "BLOB")], vec![vec!["text".into()]]);
        let evidence = rewrite_result_evidence(Engine::Mysql, &binary, "ordered", 1024);
        assert!(!evidence.complete);
        assert!(evidence.unverified_reason.unwrap().contains("ambiguity"));
        let json = grid(&[("document", "JSONB")], vec![vec![serde_json::json!({"n": 1.5})]]);
        assert!(!rewrite_result_evidence(Engine::Postgres, &json, "ordered", 1024).complete);
    }

    #[test]
    fn rewrite_hash_refuses_truncated_and_over_byte_budget_results() {
        let mut truncated = grid(&[("id", "INT8")], vec![vec![1.into()]]);
        truncated.truncated = true;
        assert!(!rewrite_result_evidence(Engine::Postgres, &truncated, "ordered", 1024).complete);
        let large = grid(&[("value", "TEXT")], vec![vec![serde_json::Value::String("x".repeat(2048))]]);
        let evidence = rewrite_result_evidence(Engine::Postgres, &large, "ordered", 1024);
        assert!(!evidence.complete);
        assert!(evidence.unverified_reason.unwrap().contains("1024-byte budget"));
        assert!(validate_rewrite_candidate(Engine::Postgres, &QueryLabRewriteCandidateInput {
            id: "explain".into(), name: "Not a result query".into(), sql: "EXPLAIN SELECT 1".into(),
        }).is_err());
        assert!(validate_rewrite_candidate(Engine::Postgres, &QueryLabRewriteCandidateInput {
            id: "select".into(), name: "Valid result query".into(), sql: "SELECT(1)".into(),
        }).is_ok());
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

    fn hypopg_input(session_id: Uuid, connection_id: Uuid, id: &str) -> QueryLabHypopgInput {
        QueryLabHypopgInput {
            session_id, connection_id, run_key: Uuid::new_v4().to_string(),
            database: "shop".into(), sql: if id == "created-index" {
                "SELECT id FROM orders WHERE other_id = 1".into()
            } else {
                "SELECT id FROM orders WHERE customer_id = 1".into()
            },
            spec_sha256: "b".repeat(64), index_evidence_mode: "hypothetical".into(), timeout_ms: 1000,
            candidate: QueryLabHypopgCandidateInput {
                id: id.into(), name: format!("{id} name"), table: "orders".into(),
                columns: vec![if id == "created-index" { "other_id".into() } else { "customer_id".into() }], unique: false, where_clause: None,
            },
        }
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18 with hypopg"]
    async fn dbctl_hypopg_full_lifecycle_and_concurrent_isolation() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(8).connect(&url).await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE EXTENSION IF NOT EXISTS hypopg").await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE SCHEMA shop").await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY, customer_id INT NOT NULL, other_id INT NOT NULL)").await.unwrap();
        crate::db::postgres::execute(&pool, "INSERT INTO shop.orders SELECT g, g % 10, g % 10 FROM generate_series(1, 100) g").await.unwrap();
        let (state, session, connection) = pg_live_state(&pool).await;
        let response = execute_hypopg(hypopg_input(session, connection, "customer-index"), &state).await.unwrap();
        assert!(response.index_used, "planner did not use the hypothetical index: {response:?}");
        assert_eq!(response.verdict, "lower_estimated_cost");
        assert!(response.absolute_delta.is_some_and(|delta| delta < 0.0));
        assert_eq!(response.cleanup.hypopg_reset, Some(true));
        assert_eq!(response.cleanup.connection_closed, true);
        assert_eq!(response.comparison_policy.contains("measured runtime comparison is forbidden"), true);
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM generate_series(0, 100000) g WHERE public.hypopg_get_indexdef(g) IS NOT NULL").fetch_one(&pool).await.unwrap();
        assert_eq!(remaining, 0);

        let (left, right) = tokio::join!(
            execute_hypopg(hypopg_input(session, connection, "customer-index"), &state),
            execute_hypopg(hypopg_input(session, connection, "created-index"), &state),
        );
        let left = left.unwrap();
        let right = right.unwrap();
        assert!(left.index_used && right.index_used);
        assert!(left.used_index_names.iter().all(|name| !right.created_index_names.contains(name)));
        assert!(right.used_index_names.iter().all(|name| !left.created_index_names.contains(name)));
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM generate_series(0, 100000) g WHERE public.hypopg_get_indexdef(g) IS NOT NULL").fetch_one(&pool).await.unwrap();
        assert_eq!(remaining, 0);
        crate::db::postgres::execute(&pool, "DROP SCHEMA shop CASCADE").await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18 with hypopg"]
    async fn dbctl_hypopg_failures_reset_every_step() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(8).connect(&url).await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE EXTENSION IF NOT EXISTS hypopg").await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE SCHEMA shop").await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY, customer_id INT NOT NULL, other_id INT NOT NULL)").await.unwrap();
        crate::db::postgres::execute(&pool, "INSERT INTO shop.orders SELECT g, g % 10, g % 10 FROM generate_series(1, 100) g").await.unwrap();
        let (state, session, connection) = pg_live_state(&pool).await;
        for step in [
            HypopgFail::InitialReset, HypopgFail::Baseline, HypopgFail::Create,
            HypopgFail::Explain, HypopgFail::FinalReset, HypopgFail::Restore,
        ] {
            let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
            let error = hypopg_inner(hypopg_input(session, connection, "failure"), &state, &mut cancel_rx, Some(step)).await;
            assert!(error.is_err(), "failure {step:?} unexpectedly succeeded");
            let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM generate_series(0, 100000) g WHERE public.hypopg_get_indexdef(g) IS NOT NULL").fetch_one(&pool).await.unwrap();
            assert_eq!(remaining, 0, "failure {step:?} left hypothetical indexes");
            let timeout: String = sqlx::query_scalar("SHOW statement_timeout").fetch_one(&pool).await.unwrap();
            assert_eq!(timeout, "0");
        }
        crate::db::postgres::execute(&pool, "DROP SCHEMA shop CASCADE").await.unwrap();
        pool.close().await;
    }

    async fn prepare_mysql_real_scratch(
        pool: &sqlx::MySqlPool,
        state: &AppState,
        input: &QueryLabRealIndexInput,
    ) {
        let scratch = input.baseline.scratch.as_ref().unwrap();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        crate::commands::migration::create_scratch_named(
            state, input.baseline.session_id, scratch.run_key.as_deref().unwrap(),
            &scratch.database, &mut cancel_rx,
        ).await.unwrap();
        crate::db::mysql::execute(pool, &format!(
            "CREATE TABLE `{}`.orders LIKE shop.orders", scratch.database,
        )).await.unwrap();
        crate::db::mysql::execute(pool, &format!(
            "INSERT INTO `{}`.orders SELECT * FROM shop.orders", scratch.database,
        )).await.unwrap();
    }

    async fn assert_mysql_scratch_gone(pool: &sqlx::MySqlPool, state: &AppState, input: &QueryLabRealIndexInput) {
        let scratch = input.baseline.scratch.as_ref().unwrap();
        let record = crate::commands::migration::scratch_record(state, scratch.run_key.as_deref().unwrap()).await.unwrap();
        assert_eq!(record.status, "dropped");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ?")
            .bind(&scratch.database).fetch_one(pool).await.unwrap();
        assert_eq!(count, 0);
        let source_indexes: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = 'shop' AND table_name = 'orders' AND index_name LIKE 'txui_lab_%'",
        ).fetch_one(pool).await.unwrap();
        assert_eq!(source_indexes, 0);
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
    async fn dbctl_mysql_real_index_success_failure_cancel_and_identity() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(8).connect(&url).await.unwrap();
        crate::db::mysql::execute(&pool, "CREATE DATABASE shop").await.unwrap();
        crate::db::mysql::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY, customer_id INT NOT NULL)").await.unwrap();
        crate::db::mysql::execute(&pool, "INSERT INTO shop.orders SELECT a.x + 10 * b.x + 1, a.x + 10 * b.x + 1 FROM (SELECT 0 x UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a CROSS JOIN (SELECT 0 x UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b").await.unwrap();
        let (state, session, connection) = mysql_live_state(&pool).await;

        let success = real_input(session, connection, Engine::Mysql);
        prepare_mysql_real_scratch(&pool, &state, &success).await;
        let response = execute_real_index(success.clone(), &state).await.unwrap();
        assert!(response.index_used, "candidate plan did not use the generated index");
        assert_eq!(response.baseline_plan.label, "executed_query");
        assert_eq!(response.candidate_plan.label, "executed_query");
        assert!(response.cleanup.index_dropped && response.cleanup.scratch_dropped);
        assert!(response.cleanup.timeout_restored && response.cleanup.connection_closed);
        assert!(response.comparison_policy.contains("lock wait and rebuild"));
        assert_mysql_scratch_gone(&pool, &state, &success).await;
        let audit: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE run_id = ? AND source = 'query_lab_real_index' AND ok = 1")
            .bind(format!("query-lab-real-index:{}", success.baseline.run_key)).fetch_one(&state.history).await.unwrap();
        assert_eq!(audit, 1);

        let failure = real_input(session, connection, Engine::Mysql);
        prepare_mysql_real_scratch(&pool, &state, &failure).await;
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let error = real_index_inner(failure.clone(), &state, &mut cancel_rx, Some(RealIndexFail::AfterCreate)).await;
        assert!(error.is_err());
        assert_mysql_scratch_gone(&pool, &state, &failure).await;

        let cancelled = real_input(session, connection, Engine::Mysql);
        prepare_mysql_real_scratch(&pool, &state, &cancelled).await;
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let _ = cancel_tx.send(());
        let error = real_index_inner(cancelled.clone(), &state, &mut cancel_rx, None).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_mysql_scratch_gone(&pool, &state, &cancelled).await;

        let mismatch = real_input(session, connection, Engine::Mysql);
        prepare_mysql_real_scratch(&pool, &state, &mismatch).await;
        let mut forged = mismatch.clone();
        forged.baseline.scratch.as_mut().unwrap().connection_id = Uuid::new_v4();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert!(real_index_inner(forged, &state, &mut cancel_rx, None).await.is_err());
        let record = crate::commands::migration::scratch_record(
            &state, mismatch.baseline.scratch.as_ref().unwrap().run_key.as_deref().unwrap(),
        ).await.unwrap();
        assert_eq!(record.status, "active", "mismatch must not clean an unverified scratch");
        crate::commands::migration::cleanup_scratch(&state, &record.run_key).await.unwrap();
        crate::db::mysql::execute(&pool, "DROP DATABASE shop").await.unwrap();
        pool.close().await;
    }

    async fn prepare_pg_real_scratch(
        pool: &sqlx::PgPool,
        state: &AppState,
        input: &QueryLabRealIndexInput,
    ) {
        let scratch = input.baseline.scratch.as_ref().unwrap();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        crate::commands::migration::create_scratch_named(
            state, input.baseline.session_id, scratch.run_key.as_deref().unwrap(),
            &scratch.database, &mut cancel_rx,
        ).await.unwrap();
        crate::db::postgres::execute(pool, &format!(
            "CREATE TABLE \"{}\".orders (LIKE shop.orders INCLUDING ALL)", scratch.database,
        )).await.unwrap();
        crate::db::postgres::execute(pool, &format!(
            "INSERT INTO \"{}\".orders SELECT * FROM shop.orders", scratch.database,
        )).await.unwrap();
    }

    async fn assert_pg_scratch_gone(pool: &sqlx::PgPool, state: &AppState, input: &QueryLabRealIndexInput) {
        let scratch = input.baseline.scratch.as_ref().unwrap();
        let record = crate::commands::migration::scratch_record(state, scratch.run_key.as_deref().unwrap()).await.unwrap();
        assert_eq!(record.status, "dropped");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = $1")
            .bind(&scratch.database).fetch_one(pool).await.unwrap();
        assert_eq!(count, 0);
        let source_indexes: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'shop' AND tablename = 'orders' AND indexname LIKE 'txui_lab_%'",
        ).fetch_one(pool).await.unwrap();
        assert_eq!(source_indexes, 0);
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18"]
    async fn dbctl_pg_real_index_success_failure_cancel_and_identity() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(8).connect(&url).await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE SCHEMA shop").await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY, customer_id INT NOT NULL)").await.unwrap();
        crate::db::postgres::execute(&pool, "INSERT INTO shop.orders SELECT g, g FROM generate_series(1, 10000) g").await.unwrap();
        let (state, session, connection) = pg_live_state(&pool).await;

        let success = real_input(session, connection, Engine::Postgres);
        prepare_pg_real_scratch(&pool, &state, &success).await;
        let response = execute_real_index(success.clone(), &state).await.unwrap();
        assert!(response.index_used, "candidate plan did not use the generated index");
        assert_eq!(response.baseline_plan.label, "executed_query");
        assert_eq!(response.candidate_plan.label, "executed_query");
        assert!(response.cleanup.index_dropped && response.cleanup.scratch_dropped);
        assert!(response.cleanup.timeout_restored && response.cleanup.connection_closed);
        assert_pg_scratch_gone(&pool, &state, &success).await;

        let failure = real_input(session, connection, Engine::Postgres);
        prepare_pg_real_scratch(&pool, &state, &failure).await;
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert!(real_index_inner(failure.clone(), &state, &mut cancel_rx, Some(RealIndexFail::AfterCreate)).await.is_err());
        assert_pg_scratch_gone(&pool, &state, &failure).await;

        let cancelled = real_input(session, connection, Engine::Postgres);
        prepare_pg_real_scratch(&pool, &state, &cancelled).await;
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let _ = cancel_tx.send(());
        let error = real_index_inner(cancelled.clone(), &state, &mut cancel_rx, None).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_pg_scratch_gone(&pool, &state, &cancelled).await;

        let mismatch = real_input(session, connection, Engine::Postgres);
        prepare_pg_real_scratch(&pool, &state, &mismatch).await;
        let mut forged = mismatch.clone();
        forged.baseline.scratch.as_mut().unwrap().database = "txui_mig_fedcba9876543210".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert!(real_index_inner(forged, &state, &mut cancel_rx, None).await.is_err());
        let record = crate::commands::migration::scratch_record(
            &state, mismatch.baseline.scratch.as_ref().unwrap().run_key.as_deref().unwrap(),
        ).await.unwrap();
        assert_eq!(record.status, "active", "mismatch must not clean an unverified scratch");
        crate::commands::migration::cleanup_scratch(&state, &record.run_key).await.unwrap();
        crate::db::postgres::execute(&pool, "DROP SCHEMA shop CASCADE").await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
    async fn dbctl_mysql_rewrite_equality_order_budget_binary_and_cancel() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(8).connect(&url).await.unwrap();
        crate::db::mysql::execute(&pool, "CREATE DATABASE shop").await.unwrap();
        crate::db::mysql::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY, customer_id INT NOT NULL)").await.unwrap();
        crate::db::mysql::execute(&pool, "INSERT INTO shop.orders SELECT a.x + 10 * b.x + 1, a.x + 10 * b.x + 1 FROM (SELECT 0 x UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a CROSS JOIN (SELECT 0 x UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b").await.unwrap();
        crate::db::mysql::execute(&pool, "INSERT INTO shop.orders VALUES (101, 1)").await.unwrap();
        let (state, session, connection) = mysql_live_state(&pool).await;

        let equal = execute_rewrite(rewrite_input(session, connection, Engine::Mysql), &state).await.unwrap();
        assert_eq!(equal.correctness, "equal");
        assert!(equal.baseline.complete && equal.candidate.complete);
        assert_eq!(equal.baseline.rows_observed, 2);
        assert!(equal.baseline.sha256.is_some() && equal.cleanup.timeout_restored && equal.cleanup.connection_closed);
        let audit: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE run_id = ? AND source = 'query_lab_rewrite' AND ok = 1")
            .bind(format!("query-lab-rewrite:{}", equal.run_key)).fetch_one(&state.history).await.unwrap();
        assert_eq!(audit, 1);

        let mut ordered = rewrite_input(session, connection, Engine::Mysql);
        ordered.candidate.sql = "SELECT id, customer_id FROM orders WHERE customer_id = 1 ORDER BY id DESC".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(ordered.clone(), &state, &mut cancel_rx).await.unwrap().correctness, "different");
        ordered.row_order_policy = "multiset".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(ordered, &state, &mut cancel_rx).await.unwrap().correctness, "equal");

        let mut columns = rewrite_input(session, connection, Engine::Mysql);
        columns.candidate.sql = "SELECT customer_id, id FROM orders WHERE customer_id = 1 ORDER BY id".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let response = rewrite_inner(columns, &state, &mut cancel_rx).await.unwrap();
        assert_eq!(response.correctness, "different");
        assert!(response.reason.unwrap().contains("Ordered column"));

        let mut different = rewrite_input(session, connection, Engine::Mysql);
        different.candidate.sql = "SELECT id, customer_id FROM orders WHERE customer_id = 2 ORDER BY id".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(different, &state, &mut cancel_rx).await.unwrap().correctness, "different");

        let mut budget = rewrite_input(session, connection, Engine::Mysql);
        budget.baseline.sql = "SELECT id, customer_id FROM orders ORDER BY id".into();
        budget.candidate.sql = budget.baseline.sql.clone();
        budget.max_rows = 1;
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let response = rewrite_inner(budget, &state, &mut cancel_rx).await.unwrap();
        assert_eq!(response.correctness, "unverified");
        assert!(!response.baseline.complete && response.baseline.sha256.is_none());

        for sql in ["SELECT CAST(1.5 AS DOUBLE) AS ratio", "SELECT CAST('00ff' AS BINARY) AS payload"] {
            let mut unsupported = rewrite_input(session, connection, Engine::Mysql);
            unsupported.baseline.sql = sql.into();
            unsupported.candidate.sql = sql.into();
            let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
            assert_eq!(rewrite_inner(unsupported, &state, &mut cancel_rx).await.unwrap().correctness, "unverified");
        }

        let cancelled = rewrite_input(session, connection, Engine::Mysql);
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let _ = cancel_tx.send(());
        let error = rewrite_inner(cancelled, &state, &mut cancel_rx).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shop.orders").fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 101);
        crate::db::mysql::execute(&pool, "DROP DATABASE shop").await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18"]
    async fn dbctl_pg_rewrite_equality_order_budget_binary_and_cancel() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(8).connect(&url).await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE SCHEMA shop").await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY, customer_id INT NOT NULL)").await.unwrap();
        crate::db::postgres::execute(&pool, "INSERT INTO shop.orders SELECT g, g FROM generate_series(1, 100) g").await.unwrap();
        crate::db::postgres::execute(&pool, "INSERT INTO shop.orders VALUES (101, 1)").await.unwrap();
        let (state, session, connection) = pg_live_state(&pool).await;

        let equal = execute_rewrite(rewrite_input(session, connection, Engine::Postgres), &state).await.unwrap();
        assert_eq!(equal.correctness, "equal");
        assert!(equal.baseline.complete && equal.candidate.complete);
        assert!(equal.baseline.sha256.is_some() && equal.cleanup.timeout_restored && equal.cleanup.connection_closed);

        let mut ordered = rewrite_input(session, connection, Engine::Postgres);
        ordered.candidate.sql = "SELECT id, customer_id FROM orders WHERE customer_id = 1 ORDER BY id DESC".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(ordered.clone(), &state, &mut cancel_rx).await.unwrap().correctness, "different");
        ordered.row_order_policy = "multiset".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(ordered, &state, &mut cancel_rx).await.unwrap().correctness, "equal");

        let mut columns = rewrite_input(session, connection, Engine::Postgres);
        columns.candidate.sql = "SELECT customer_id, id FROM orders WHERE customer_id = 1 ORDER BY id".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(columns, &state, &mut cancel_rx).await.unwrap().correctness, "different");

        let mut different = rewrite_input(session, connection, Engine::Postgres);
        different.candidate.sql = "SELECT id, customer_id FROM orders WHERE customer_id = 2 ORDER BY id".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(different, &state, &mut cancel_rx).await.unwrap().correctness, "different");

        let mut budget = rewrite_input(session, connection, Engine::Postgres);
        budget.baseline.sql = "SELECT id, customer_id FROM orders ORDER BY id".into();
        budget.candidate.sql = budget.baseline.sql.clone();
        budget.max_rows = 1;
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(budget, &state, &mut cancel_rx).await.unwrap().correctness, "unverified");

        let mut binary = rewrite_input(session, connection, Engine::Postgres);
        binary.baseline.sql = "SELECT CAST('1.00' AS NUMERIC) AS amount, decode('00ff', 'hex') AS payload".into();
        binary.candidate.sql = "SELECT CAST('1.0' AS NUMERIC) AS amount, decode('00ff', 'hex') AS payload".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(binary.clone(), &state, &mut cancel_rx).await.unwrap().correctness, "equal");
        binary.candidate.sql = "SELECT CAST('1.0' AS NUMERIC) AS amount, decode('00fe', 'hex') AS payload".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(binary, &state, &mut cancel_rx).await.unwrap().correctness, "different");

        let mut float = rewrite_input(session, connection, Engine::Postgres);
        float.baseline.sql = "SELECT CAST(1.5 AS FLOAT8) AS ratio".into();
        float.candidate.sql = float.baseline.sql.clone();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert_eq!(rewrite_inner(float, &state, &mut cancel_rx).await.unwrap().correctness, "unverified");

        let cancelled = rewrite_input(session, connection, Engine::Postgres);
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let _ = cancel_tx.send(());
        let error = rewrite_inner(cancelled, &state, &mut cancel_rx).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shop.orders").fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 101);
        crate::db::postgres::execute(&pool, "DROP SCHEMA shop CASCADE").await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
    async fn dbctl_mysql_benchmark_schedule_and_cancellation() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(8).connect(&url).await.unwrap();
        crate::db::mysql::execute(&pool, "CREATE DATABASE shop").await.unwrap();
        crate::db::mysql::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY, customer_id INT NOT NULL)").await.unwrap();
        crate::db::mysql::execute(&pool, "INSERT INTO shop.orders VALUES (1, 1), (2, 1), (3, 2)").await.unwrap();
        let (state, session, connection) = mysql_live_state(&pool).await;
        let input = QueryLabBenchmarkInput {
            rewrite: rewrite_input(session, connection, Engine::Mysql),
            warmup_runs: 1,
            repetitions: 4,
        };
        let response = execute_benchmark(input.clone(), &state).await.unwrap();
        assert_eq!(response.pairs.len(), 4);
        assert_eq!(response.baseline_ms.len(), 4);
        assert_eq!(response.candidate_ms.len(), 4);
        assert_eq!(response.pairs.iter().map(|pair| pair.order.as_str()).collect::<Vec<_>>(), [
            "baseline_first", "candidate_first", "baseline_first", "candidate_first",
        ]);
        assert_eq!(response.baseline.count, 4);
        assert_eq!(response.candidate.count, 4);
        assert!(response.baseline_sha256 == response.candidate_sha256);
        assert!(response.cleanup.timeout_restored && response.cleanup.connection_closed);
        assert!(state.ext_jobs.read().await.is_empty());
        let audit: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE run_id = ? AND source = 'query_lab_benchmark' AND ok = 1")
            .bind(format!("query-lab-benchmark:{}", response.run_key)).fetch_one(&state.history).await.unwrap();
        assert_eq!(audit, 1);

        let mut invalid = input.clone();
        invalid.rewrite.candidate.sql = "SELECT id, customer_id FROM orders WHERE customer_id = 2 ORDER BY id".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert!(benchmark_inner(invalid, &state, &mut cancel_rx, BenchmarkControl::default()).await.is_err());

        let between = QueryLabBenchmarkInput { warmup_runs: 0, repetitions: 3, ..input.clone() };
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let error = benchmark_inner(between, &state, &mut cancel_rx, BenchmarkControl { cancel_after: Some(1) }).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);

        let mut sleeping = QueryLabBenchmarkInput { warmup_runs: 0, repetitions: 2, ..input };
        sleeping.rewrite.baseline.timeout_ms = 2000;
        sleeping.rewrite.baseline.sql = "SELECT SLEEP(0.2)".into();
        sleeping.rewrite.candidate.sql = sleeping.rewrite.baseline.sql.clone();
        let task_state = state.clone();
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            benchmark_inner(sleeping, &task_state, &mut cancel_rx, BenchmarkControl::default()).await
        });
        tokio::time::sleep(Duration::from_millis(450)).await;
        let _ = cancel_tx.send(());
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        crate::db::mysql::execute(&pool, "DROP DATABASE shop").await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18"]
    async fn dbctl_pg_benchmark_schedule_and_cancellation() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(8).connect(&url).await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE SCHEMA shop").await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY, customer_id INT NOT NULL)").await.unwrap();
        crate::db::postgres::execute(&pool, "INSERT INTO shop.orders VALUES (1, 1), (2, 1), (3, 2)").await.unwrap();
        let (state, session, connection) = pg_live_state(&pool).await;
        let input = QueryLabBenchmarkInput {
            rewrite: rewrite_input(session, connection, Engine::Postgres),
            warmup_runs: 1,
            repetitions: 4,
        };
        let response = execute_benchmark(input.clone(), &state).await.unwrap();
        assert_eq!(response.pairs.len(), 4);
        assert_eq!(response.baseline_ms.len(), 4);
        assert_eq!(response.candidate_ms.len(), 4);
        assert_eq!(response.pairs.iter().map(|pair| pair.order.as_str()).collect::<Vec<_>>(), [
            "baseline_first", "candidate_first", "baseline_first", "candidate_first",
        ]);
        assert_eq!(response.baseline.count, 4);
        assert_eq!(response.candidate.count, 4);
        assert!(response.baseline_sha256 == response.candidate_sha256);
        assert!(response.cleanup.timeout_restored && response.cleanup.connection_closed);
        assert!(state.ext_jobs.read().await.is_empty());

        let mut invalid = input.clone();
        invalid.rewrite.candidate.sql = "SELECT id, customer_id FROM orders WHERE customer_id = 2 ORDER BY id".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        assert!(benchmark_inner(invalid, &state, &mut cancel_rx, BenchmarkControl::default()).await.is_err());

        let between = QueryLabBenchmarkInput { warmup_runs: 0, repetitions: 3, ..input.clone() };
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let error = benchmark_inner(between, &state, &mut cancel_rx, BenchmarkControl { cancel_after: Some(1) }).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);

        let mut sleeping = QueryLabBenchmarkInput { warmup_runs: 0, repetitions: 2, ..input };
        sleeping.rewrite.baseline.timeout_ms = 2000;
        sleeping.rewrite.baseline.sql = "SELECT 1 AS value FROM (SELECT pg_sleep(0.2)) AS slept".into();
        sleeping.rewrite.candidate.sql = sleeping.rewrite.baseline.sql.clone();
        let task_state = state.clone();
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            benchmark_inner(sleeping, &task_state, &mut cancel_rx, BenchmarkControl::default()).await
        });
        tokio::time::sleep(Duration::from_millis(450)).await;
        let _ = cancel_tx.send(());
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        crate::db::postgres::execute(&pool, "DROP SCHEMA shop CASCADE").await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18 with hypopg"]
    async fn dbctl_pg_complete_query_lab_journey() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(8).connect(&url).await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE EXTENSION IF NOT EXISTS hypopg").await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE SCHEMA shop").await.unwrap();
        crate::db::postgres::execute(&pool, "CREATE TABLE shop.orders (id INT PRIMARY KEY, customer_id INT NOT NULL, other_id INT NOT NULL)").await.unwrap();
        crate::db::postgres::execute(&pool, "INSERT INTO shop.orders SELECT g, g % 10, g % 10 FROM generate_series(1, 10000) g").await.unwrap();
        let (state, session, connection) = pg_live_state(&pool).await;

        let mut baseline_input = input(session, connection, Engine::Postgres, "estimate");
        baseline_input.sql = "SELECT id FROM orders WHERE customer_id = 1".into();
        baseline_input.spec_sha256 = "b".repeat(64);
        baseline_input.index_evidence_mode = "hypothetical".into();
        let baseline = execute_baseline(baseline_input, &state).await.unwrap();
        assert_eq!(baseline.execution_mode, "estimate");
        assert!(baseline.measured_plan.is_none());
        assert!(baseline.estimated_plan.content.contains("Seq Scan"));

        let winner = execute_hypopg(hypopg_input(session, connection, "customer-index"), &state).await.unwrap();
        assert!(winner.index_used);
        assert_eq!(winner.verdict, "lower_estimated_cost");
        assert!(winner.absolute_delta.is_some_and(|delta| delta < 0.0));
        let mut losing_input = hypopg_input(session, connection, "losing-index");
        losing_input.sql = "SELECT id FROM orders WHERE other_id = 1".into();
        let losing = execute_hypopg(losing_input, &state).await.unwrap();
        assert!(!losing.index_used);
        assert_eq!(losing.verdict, "not_used");

        let mut baseline_us = Vec::new();
        let mut candidate_us = Vec::new();
        for _ in 0..3 {
            let mut real = real_input(session, connection, Engine::Postgres);
            real.baseline.sql = "SELECT id FROM orders WHERE customer_id = 1".into();
            real.baseline.spec_sha256 = "b".repeat(64);
            prepare_pg_real_scratch(&pool, &state, &real).await;
            let response = execute_real_index(real.clone(), &state).await.unwrap();
            assert!(response.index_used);
            assert!(response.cleanup.scratch_dropped && response.cleanup.index_dropped);
            baseline_us.push(response.baseline_plan.elapsed_us.unwrap());
            candidate_us.push(response.candidate_plan.elapsed_us.unwrap());
            assert_pg_scratch_gone(&pool, &state, &real).await;
        }
        baseline_us.sort_unstable();
        candidate_us.sort_unstable();
        assert!(candidate_us[1] < baseline_us[1], "real candidate median was not lower: {baseline_us:?} vs {candidate_us:?}");

        let mut invalid = rewrite_input(session, connection, Engine::Postgres);
        invalid.candidate.sql = "SELECT id, customer_id FROM orders WHERE customer_id = 2 ORDER BY id".into();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let invalid_result = rewrite_inner(invalid.clone(), &state, &mut cancel_rx).await.unwrap();
        assert_eq!(invalid_result.correctness, "different");
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let rejected = benchmark_inner(QueryLabBenchmarkInput {
            rewrite: invalid, warmup_runs: 1, repetitions: 3,
        }, &state, &mut cancel_rx, BenchmarkControl::default()).await;
        assert!(rejected.is_err(), "different rewrite results reached benchmarking");

        let artifact = "CREATE INDEX \"idx_customer_index_bbbbbbbb\" ON \"orders\" (\"customer_id\")";
        let metadata = vec![crate::commands::migration::MigrationStatementInput {
            kind: "create-index".into(), line: 1, table: Some("orders".into()), supported: true,
            summary: "Create candidate index".into(), destructive: false, lossy: false, cost: None,
        }];
        let preflight = crate::commands::migration::preflight(session, artifact, metadata, &state).await.unwrap();
        assert_eq!(preflight.statement_count, 1);
        assert_eq!(preflight.unsupported, 0);
        assert!(preflight.stop_on_first_error);
        assert_eq!(preflight.sql_sha256, format!("{:x}", sha2::Sha256::digest(artifact.as_bytes())));
        let source_indexes: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'shop' AND tablename = 'orders' AND indexname LIKE 'txui_lab_%'",
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(source_indexes, 0);
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM generate_series(0,100000) g WHERE public.hypopg_get_indexdef(g) IS NOT NULL")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(remaining, 0);
        crate::db::postgres::execute(&pool, "DROP SCHEMA shop CASCADE").await.unwrap();
        pool.close().await;
    }
}
