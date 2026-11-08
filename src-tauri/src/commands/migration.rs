use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{AssertSqlSafe, Connection, SqlSafeStr};
use tauri::State;
use uuid::Uuid;

use crate::apperror::AppError;
use crate::db::types::Engine;
use crate::state::AppState;

const MAX_MIGRATION_SQL_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MigrationCostInput {
    pub operation: String,
    pub algorithm: String,
    pub lock: String,
    pub rebuild: bool,
    pub seconds: Option<f64>,
    pub blocked_seconds: Option<f64>,
    pub disk_bytes: Option<f64>,
    pub replica_lag_seconds: Option<f64>,
    pub why: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MigrationStatementInput {
    pub kind: String,
    pub line: u64,
    pub table: Option<String>,
    pub supported: bool,
    pub summary: String,
    pub destructive: bool,
    pub lossy: bool,
    pub cost: Option<MigrationCostInput>,
}

#[derive(Debug, Serialize)]
pub struct MigrationStatementPreflight {
    pub number: u64,
    pub kind: String,
    pub table: Option<String>,
    pub supported: bool,
    pub summary: String,
    pub destructive: bool,
    pub lossy: bool,
    pub implicit_commit: bool,
    pub cost: Option<MigrationCostInput>,
}

#[derive(Debug, Serialize)]
pub struct MigrationPreflightResponse {
    pub sql_sha256: String,
    pub statement_count: u64,
    pub affected_objects: Vec<String>,
    pub unsupported: u64,
    pub destructive: u64,
    pub lossy: u64,
    pub implicit_commits: u64,
    pub statements: Vec<MigrationStatementPreflight>,
    pub environment: Option<String>,
    pub read_only: bool,
    pub prod_allow_ddl: bool,
    pub prod_allow_unfiltered_write: bool,
    pub stop_on_first_error: bool,
}

#[tauri::command]
pub async fn migration_preflight(
    session_id: Uuid,
    sql: String,
    statements: Vec<MigrationStatementInput>,
    state: State<'_, AppState>,
) -> Result<MigrationPreflightResponse, AppError> {
    preflight(session_id, &sql, statements, &state).await
}

async fn preflight(
    session_id: Uuid,
    sql: &str,
    metadata: Vec<MigrationStatementInput>,
    state: &AppState,
) -> Result<MigrationPreflightResponse, AppError> {
    if sql.len() > MAX_MIGRATION_SQL_BYTES {
        return Err(AppError::bad_request("migration SQL exceeds the 16 MiB preflight limit"));
    }
    let guard = state.session_meta.read().await.get(&session_id).cloned()
        .ok_or_else(|| AppError::new(crate::apperror::ErrorCode::NotFound, "migration target session is not open"))?;
    if !matches!(guard.engine, Engine::Mysql | Engine::Postgres) {
        return Err(AppError::unsupported("migration preflight supports MySQL/MariaDB and PostgreSQL only"));
    }
    let sql_statements = crate::sqlguard::split_statements_for(Some(guard.engine), sql);
    if sql_statements.is_empty() {
        return Err(AppError::bad_request("migration SQL contains no statements"));
    }
    if sql_statements.len() != metadata.len() {
        return Err(AppError::bad_request(format!(
            "statement model mismatch: review supplied {}, backend split {}",
            metadata.len(), sql_statements.len(),
        )));
    }

    let mut statements = Vec::with_capacity(metadata.len());
    let mut affected_objects = Vec::new();
    for (index, (statement_sql, input)) in sql_statements.iter().zip(metadata).enumerate() {
        state.guard_statement(&session_id, statement_sql).await?;
        let implicit_commit = guard.engine == Engine::Mysql
            && crate::sqlguard::is_write_for(Some(guard.engine), statement_sql);
        if let Some(table) = input.table.as_ref().filter(|table| !table.trim().is_empty()) {
            if !affected_objects.contains(table) {
                affected_objects.push(table.clone());
            }
        }
        statements.push(MigrationStatementPreflight {
            number: index as u64 + 1,
            kind: input.kind,
            table: input.table,
            supported: input.supported,
            summary: input.summary,
            destructive: input.destructive,
            lossy: input.lossy,
            implicit_commit,
            cost: input.cost,
        });
    }
    affected_objects.sort();
    let unsupported = statements.iter().filter(|statement| !statement.supported).count() as u64;
    let destructive = statements.iter().filter(|statement| statement.destructive).count() as u64;
    let lossy = statements.iter().filter(|statement| statement.lossy).count() as u64;
    let implicit_commits = statements.iter().filter(|statement| statement.implicit_commit).count() as u64;
    Ok(MigrationPreflightResponse {
        sql_sha256: format!("{:x}", Sha256::digest(sql.as_bytes())),
        statement_count: statements.len() as u64,
        affected_objects,
        unsupported,
        destructive,
        lossy,
        implicit_commits,
        statements,
        environment: guard.environment,
        read_only: guard.read_only,
        prod_allow_ddl: guard.prod_allow_ddl,
        prod_allow_unfiltered_write: guard.prod_allow_unfiltered_write,
        stop_on_first_error: true,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct MigrationScratchRecord {
    pub run_key: String,
    pub session_id: String,
    pub connection_id: String,
    pub engine: String,
    pub name: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

enum AdminConnection {
    My(sqlx::MySqlConnection),
    Pg(sqlx::PgConnection),
}

impl AdminConnection {
    async fn execute(&mut self, sql: &str) -> Result<(), AppError> {
        match self {
            Self::My(conn) => sqlx::raw_sql(AssertSqlSafe(sql.to_owned()).into_sql_str())
                .execute(conn).await.map(|_| ()).map_err(AppError::from),
            Self::Pg(conn) => sqlx::raw_sql(AssertSqlSafe(sql.to_owned()).into_sql_str())
                .execute(conn).await.map(|_| ()).map_err(AppError::from),
        }
    }

    async fn drain(&mut self, sql: &str) -> Result<u64, sqlx::Error> {
        let mut affected = 0u64;
        match self {
            Self::My(conn) => {
                let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(conn);
                while let Some(item) = stream.try_next().await? {
                    if let sqlx::Either::Left(done) = item {
                        affected = affected.saturating_add(done.rows_affected());
                    }
                }
            },
            Self::Pg(conn) => {
                let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(conn);
                while let Some(item) = stream.try_next().await? {
                    if let sqlx::Either::Left(done) = item {
                        affected = affected.saturating_add(done.rows_affected());
                    }
                }
            },
        }
        Ok(affected)
    }

    async fn backend_id(&mut self) -> Result<u64, AppError> {
        match self {
            Self::My(conn) => Ok(sqlx::query_scalar("SELECT CONNECTION_ID()").fetch_one(conn).await?),
            Self::Pg(conn) => {
                let id: i32 = sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(conn).await?;
                u64::try_from(id).map_err(|_| AppError::local("PostgreSQL returned an invalid backend pid"))
            },
        }
    }

    async fn scratch_exists(&mut self, name: &str) -> Result<bool, AppError> {
        let count: i64 = match self {
            Self::My(conn) => sqlx::query_scalar(
                "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ?",
            ).bind(name).fetch_one(conn).await?,
            Self::Pg(conn) => sqlx::query_scalar(
                "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = $1",
            ).bind(name).fetch_one(conn).await?,
        };
        Ok(count > 0)
    }

    async fn close(self) {
        let _ = self.close_checked().await;
    }

    async fn close_checked(self) -> Result<(), AppError> {
        match self {
            Self::My(conn) => conn.close().await.map_err(AppError::from),
            Self::Pg(conn) => conn.close().await.map_err(AppError::from),
        }
    }
}

fn scratch_create_sql(engine: Engine, name: &str) -> String {
    match engine {
        Engine::Mysql => format!("CREATE DATABASE `{}`", name.replace('`', "``")),
        Engine::Postgres => format!("CREATE SCHEMA \"{}\"", name.replace('"', "\"\"")),
        _ => unreachable!("scratch engine was validated"),
    }
}

fn scratch_drop_sql(engine: Engine, name: &str) -> String {
    match engine {
        Engine::Mysql => format!("DROP DATABASE IF EXISTS `{}`", name.replace('`', "``")),
        Engine::Postgres => format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", name.replace('"', "\"\"")),
        _ => unreachable!("scratch engine was validated"),
    }
}

fn scratch_guard(guard: &crate::state::SessionGuard) -> Result<(), AppError> {
    if guard.read_only {
        return Err(AppError::guard("rehearsal requires a writable connection"));
    }
    if guard.environment.as_deref() == Some("prod") {
        return Err(AppError::guard("rehearsal is refused on production connections"));
    }
    if !matches!(guard.engine, Engine::Mysql | Engine::Postgres) {
        return Err(AppError::unsupported("scratch rehearsal supports MySQL/MariaDB and PostgreSQL only"));
    }
    Ok(())
}

async fn insert_scratch(state: &AppState, run_key: &str, session_id: Uuid, engine: Engine, name: &str) -> Result<(), AppError> {
    let connection_id = state.session_starts.read().await.get(&session_id)
        .map(|start| start.connection_id.to_string()).unwrap_or_default();
    sqlx::query(
        "INSERT INTO migration_scratch (run_key, session_id, connection_id, engine, name, status)
         VALUES (?, ?, ?, ?, ?, 'creating')",
    )
        .bind(run_key)
        .bind(session_id.to_string())
        .bind(connection_id)
        .bind(engine.wire_name())
        .bind(name)
        .execute(&state.history).await?;
    Ok(())
}

async fn scratch_status(state: &AppState, run_key: &str, status: &str, error: Option<&str>) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE migration_scratch SET status = ?, error = ?, updated_at = datetime('now') WHERE run_key = ?",
    )
        .bind(status)
        .bind(error)
        .bind(run_key)
        .execute(&state.history).await?;
    Ok(())
}

pub(crate) async fn scratch_record(state: &AppState, run_key: &str) -> Result<MigrationScratchRecord, AppError> {
    sqlx::query_as::<_, MigrationScratchRecord>(
        "SELECT run_key, session_id, connection_id, engine, name, status, error, created_at, updated_at
         FROM migration_scratch WHERE run_key = ?",
    )
        .bind(run_key)
        .fetch_optional(&state.history).await?
        .ok_or_else(|| AppError::new(crate::apperror::ErrorCode::NotFound, "scratch rehearsal was not found"))
}

async fn admin_for(state: &AppState, session_id: Uuid) -> Result<(Engine, AdminConnection), AppError> {
    let session = crate::db::connection::get_session_pub(session_id, &state.sessions).await?;
    match session.as_ref() {
        crate::db::types::LiveSession::Mysql(pool) =>
            Ok((Engine::Mysql, AdminConnection::My(pool.acquire().await?.detach()))),
        crate::db::types::LiveSession::Postgres(pool) =>
            Ok((Engine::Postgres, AdminConnection::Pg(pool.acquire().await?.detach()))),
        _ => Err(AppError::unsupported("scratch rehearsal supports MySQL/MariaDB and PostgreSQL only")),
    }
}

pub(crate) async fn create_scratch_named(
    state: &AppState,
    session_id: Uuid,
    run_key: &str,
    name: &str,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<MigrationScratchRecord, AppError> {
    let guard = state.session_meta.read().await.get(&session_id).cloned()
        .ok_or_else(|| AppError::new(crate::apperror::ErrorCode::NotFound, "rehearsal session is not open"))?;
    scratch_guard(&guard)?;
    state.guard_statement(&session_id, &scratch_create_sql(guard.engine, name)).await?;
    insert_scratch(state, run_key, session_id, guard.engine, name).await?;
    let (engine, mut admin) = admin_for(state, session_id).await?;

    if cancel_rx.try_recv().is_ok() {
        admin.close().await;
        scratch_status(state, run_key, "cancelled", None).await?;
        return Err(AppError::new(crate::apperror::ErrorCode::Cancelled, "scratch creation cancelled before writing"));
    }
    if admin.scratch_exists(name).await? {
        admin.close().await;
        let message = format!("scratch object {name} already exists; it was not reused or dropped");
        scratch_status(state, run_key, "failed", Some(&message)).await?;
        return Err(AppError::new(crate::apperror::ErrorCode::Constraint, message));
    }

    let create_sql = scratch_create_sql(engine, name);
    let created = tokio::select! {
        result = admin.execute(&create_sql) => Some(result),
        _ = &mut *cancel_rx => None,
    };
    match created {
        Some(Ok(())) => {
            admin.close().await;
            scratch_status(state, run_key, "active", None).await?;
            scratch_record(state, run_key).await
        },
        Some(Err(error)) => {
            admin.close().await;
            let message = format!("could not create scratch object {name}: {error}");
            scratch_status(state, run_key, "failed", Some(&message)).await?;
            Err(AppError::local(message))
        },
        None => {
            admin.close().await;
            let (_, mut check) = admin_for(state, session_id).await?;
            let exists = check.scratch_exists(name).await?;
            check.close().await;
            if exists {
                let (_, mut cleanup) = admin_for(state, session_id).await?;
                let drop_result = cleanup.execute(&scratch_drop_sql(engine, name)).await;
                cleanup.close().await;
                if let Err(error) = drop_result {
                    let message = format!("creation was cancelled, but scratch object {name} could not be cleaned: {error}");
                    scratch_status(state, run_key, "cleanup_failed", Some(&message)).await?;
                    return Err(AppError::local(message));
                }
            }
            scratch_status(state, run_key, "cancelled", None).await?;
            Err(AppError::new(crate::apperror::ErrorCode::Cancelled, "scratch creation cancelled"))
        },
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct MigrationCloneTable {
    pub name: String,
    pub serial_columns: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MigrationCloneForeignKey {
    pub name: String,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_delete: String,
    pub on_update: String,
    pub validated: Option<bool>,
    pub match_type: Option<String>,
    pub deferrable: Option<bool>,
    pub deferred: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct MigrationCloneResult {
    pub run_key: String,
    pub tables_cloned: u64,
    pub statements_executed: u64,
    pub total_statements: u64,
    pub serial_sequences: u64,
    pub foreign_keys_added: u64,
}

fn mysql_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn pg_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn pg_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn clone_statements(
    engine: Engine,
    source_schema: &str,
    scratch_schema: &str,
    tables: &[MigrationCloneTable],
    foreign_keys: &[MigrationCloneForeignKey],
) -> Vec<String> {
    let q = match engine {
        Engine::Mysql => mysql_ident,
        Engine::Postgres => pg_ident,
        _ => unreachable!("clone engine was validated"),
    };
    let qualified = |schema: &str, table: &str| format!("{}.{}", q(schema), q(table));
    let mut tables = tables.to_vec();
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    let mut statements = Vec::new();
    for table in &tables {
        statements.push(match engine {
            Engine::Mysql => format!(
                "CREATE TABLE {} LIKE {}",
                qualified(scratch_schema, &table.name), qualified(source_schema, &table.name),
            ),
            Engine::Postgres => format!(
                "CREATE TABLE {} (LIKE {} INCLUDING ALL)",
                qualified(scratch_schema, &table.name), qualified(source_schema, &table.name),
            ),
            _ => unreachable!(),
        });
        for column in &table.serial_columns {
            let sequence = format!("txui_seq_{}", &format!("{:x}", Sha256::digest(
                format!("{scratch_schema}/{}/{column}", table.name).as_bytes(),
            ))[..16]);
            statements.push(format!("CREATE SEQUENCE {}", qualified(scratch_schema, &sequence)));
            statements.push(format!(
                "ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT",
                qualified(scratch_schema, &table.name), q(column),
            ));
            statements.push(format!(
                "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT nextval({}::regclass)",
                qualified(scratch_schema, &table.name), q(column),
                pg_literal(&format!("{}.{}", q(scratch_schema), q(&sequence))),
            ));
        }
    }
    let mut foreign_keys = foreign_keys.to_vec();
    foreign_keys.sort_by(|a, b| a.table.cmp(&b.table).then(a.name.cmp(&b.name)));
    for fk in foreign_keys {
        let mut sql = format!(
            "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
            qualified(scratch_schema, &fk.table), q(&fk.name),
            fk.columns.iter().map(|column| q(column)).collect::<Vec<_>>().join(", "),
            qualified(scratch_schema, &fk.ref_table),
            fk.ref_columns.iter().map(|column| q(column)).collect::<Vec<_>>().join(", "),
        );
        if engine == Engine::Postgres {
            match fk.match_type.as_deref() {
                Some("full") => sql.push_str(" MATCH FULL"),
                Some("partial") => sql.push_str(" MATCH PARTIAL"),
                _ => {},
            }
        }
        sql.push_str(&format!(" ON DELETE {} ON UPDATE {}", fk.on_delete, fk.on_update));
        if engine == Engine::Postgres {
            if fk.validated == Some(false) { sql.push_str(" NOT VALID"); }
            if fk.deferrable == Some(true) {
                sql.push_str(" DEFERRABLE");
                if fk.deferred == Some(true) { sql.push_str(" INITIALLY DEFERRED"); }
            }
        }
        statements.push(sql);
    }
    statements
}

#[tauri::command]
pub async fn migration_rehearsal_clone(
    run_key: String,
    source_session_id: Uuid,
    source_schema: String,
    affected: Vec<String>,
    tables: Vec<MigrationCloneTable>,
    foreign_keys: Vec<MigrationCloneForeignKey>,
    state: State<'_, AppState>,
) -> Result<MigrationCloneResult, AppError> {
    clone_scratch(run_key, source_session_id, source_schema, affected, tables, foreign_keys, &state).await
}

async fn clone_scratch(
    run_key: String,
    source_session_id: Uuid,
    source_schema: String,
    affected: Vec<String>,
    tables: Vec<MigrationCloneTable>,
    foreign_keys: Vec<MigrationCloneForeignKey>,
    state: &AppState,
) -> Result<MigrationCloneResult, AppError> {
    let record = scratch_record(state, &run_key).await?;
    let session_id = Uuid::parse_str(&record.session_id)
        .map_err(|_| AppError::local("scratch record has an invalid session id"))?;
    let job_key = crate::state::ext_job_key(session_id, &run_key);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut jobs = state.ext_jobs.write().await;
        if jobs.contains_key(&job_key) {
            return Err(AppError::bad_request("scratch work is already running; cancel it before starting another operation"));
        }
        jobs.insert(job_key.clone(), cancel_tx);
    }
    let result = clone_scratch_inner(
        run_key, source_session_id, source_schema, affected, tables, foreign_keys,
        &mut cancel_rx, state,
    ).await;
    state.ext_jobs.write().await.remove(&job_key);
    result
}

#[allow(clippy::too_many_arguments)]
async fn clone_scratch_inner(
    run_key: String,
    source_session_id: Uuid,
    source_schema: String,
    affected: Vec<String>,
    tables: Vec<MigrationCloneTable>,
    foreign_keys: Vec<MigrationCloneForeignKey>,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
    state: &AppState,
) -> Result<MigrationCloneResult, AppError> {
    let record = scratch_record(state, &run_key).await?;
    if record.status != "active" {
        return Err(AppError::bad_request("clone requires an active scratch rehearsal"));
    }
    let session_id = Uuid::parse_str(&record.session_id)
        .map_err(|_| AppError::local("scratch record has an invalid session id"))?;
    let guard = state.session_meta.read().await.get(&session_id).cloned()
        .ok_or_else(|| AppError::new(crate::apperror::ErrorCode::NotFound, "rehearsal session is not open"))?;
    scratch_guard(&guard)?;
    let source_connection = state.session_starts.read().await.get(&source_session_id)
        .map(|start| start.connection_id.to_string()).unwrap_or_default();
    if source_connection != record.connection_id {
        return Err(AppError::bad_request(
            "the initial native clone requires source and rehearsal sessions on the same connection",
        ));
    }
    if source_schema.trim().is_empty() || affected.is_empty() {
        return Err(AppError::bad_request("choose a source schema and at least one affected table"));
    }
    let mut names: std::collections::BTreeSet<String> = affected.iter().cloned().collect();
    loop {
        let before = names.len();
        for fk in &foreign_keys {
            if names.contains(&fk.table) || names.contains(&fk.ref_table) {
                names.insert(fk.table.clone());
                names.insert(fk.ref_table.clone());
            }
        }
        if names.len() == before { break; }
    }
    let tables: Vec<_> = tables.into_iter().filter(|table| names.contains(&table.name)).collect();
    if tables.is_empty() {
        return Err(AppError::bad_request("none of the affected tables exists in the source catalog"));
    }
    let foreign_keys: Vec<_> = foreign_keys.into_iter()
        .filter(|fk| names.contains(&fk.table) && names.contains(&fk.ref_table)).collect();
    let serial_sequences = tables.iter().map(|table| table.serial_columns.len() as u64).sum();
    let foreign_keys_added = foreign_keys.len() as u64;
    let statements = clone_statements(guard.engine, &source_schema, &record.name, &tables, &foreign_keys);
    let total_statements = statements.len() as u64;
    let tables_cloned = tables.len() as u64;

    let (_, mut admin) = admin_for(&state, session_id).await?;
    if guard.engine == Engine::Postgres {
        let search_path = format!("SET search_path TO {}", pg_ident(&source_schema));
        if let Err(error) = admin.execute(&search_path).await {
            admin.close().await;
            return Err(AppError::local(format!("cannot select clone source schema: {error}")));
        }
    }
    let mut executed = 0;
    for statement in statements {
        state.guard_statement(&session_id, &statement).await?;
        let result = tokio::select! {
            result = admin.execute(&statement) => Some(result),
            _ = &mut *cancel_rx => None,
        };
        match result {
            Some(Ok(())) => executed += 1,
            Some(Err(error)) => {
                admin.close().await;
                let message = format!("clone stopped at statement {}/{}: {error}; SQL: {statement}; earlier cloned objects remain in {}", executed + 1, total_statements, record.name);
                scratch_status(&state, &run_key, "active", Some(&message)).await?;
                return Err(AppError::local(message));
            },
            None => {
                admin.close().await;
                let message = format!("clone cancelled after {}/{} statements; earlier cloned objects remain in {}", executed, total_statements, record.name);
                scratch_status(&state, &run_key, "active", Some(&message)).await?;
                return Err(AppError::new(crate::apperror::ErrorCode::Cancelled, message));
            },
        }
    }
    admin.close().await;
    scratch_status(&state, &run_key, "active", None).await?;
    Ok(MigrationCloneResult {
        run_key,
        tables_cloned,
        statements_executed: executed,
        total_statements,
        serial_sequences,
        foreign_keys_added,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationStatementExecution {
    pub number: u64,
    pub line: u64,
    pub ms: u64,
    pub rows_affected: u64,
    pub ok: bool,
    pub error: Option<String>,
    pub error_code: String,
    pub db_code: String,
    pub sqlstate: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationExecutionResult {
    pub run_key: String,
    pub sql_sha256: String,
    pub backend_id: Option<u64>,
    pub statement_total: u64,
    pub executed: u64,
    pub committed: u64,
    pub unknown: u64,
    pub failed: u64,
    pub not_started: u64,
    pub statements: Vec<MigrationStatementExecution>,
    pub ok: bool,
    pub cancelled: bool,
    pub partial: bool,
    pub ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MigrationDeploymentEvent {
    Started { run_key: String, statement_total: u64, database: String },
    Backend { backend_id: u64 },
    Statement { statement: MigrationStatementExecution, committed: u64, unknown: u64, failed: u64, not_started: u64 },
    Done { ok: bool, cancelled: bool, committed: u64, unknown: u64, failed: u64, not_started: u64 },
}

fn send_deployment_event(
    on_event: Option<&tauri::ipc::Channel<MigrationDeploymentEvent>>,
    event: MigrationDeploymentEvent,
) {
    if let Some(channel) = on_event { let _ = channel.send(event); }
}

#[derive(Debug, PartialEq)]
enum MigrationToken {
    Word(String),
    Number,
    Symbol(char),
    Other,
}

fn migration_word(tokens: &[MigrationToken], at: usize, expected: &str) -> bool {
    matches!(tokens.get(at), Some(MigrationToken::Word(word)) if word == expected)
}

fn migration_tokens(engine: Engine, sql: &str) -> Result<Vec<MigrationToken>, AppError> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_whitespace() { i += 1; continue; }
        if c == b'-' && bytes.get(i + 1) == Some(&b'-')
            || c == b'#' && engine == Engine::Mysql {
            i += 1;
            while i < bytes.len() && bytes[i] != b'\n' { i += 1; }
            continue;
        }
        if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            if matches!(bytes.get(i + 2), Some(b'!') | Some(b'+')) {
                return Err(AppError::bad_request("executable comments are outside the rehearsal model"));
            }
            i += 2;
            let mut depth = 1usize;
            while i < bytes.len() && depth > 0 {
                if engine == Engine::Postgres && bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth != 0 { return Err(AppError::bad_request("unterminated migration comment")); }
            continue;
        }
        if matches!(c, b'\'' | b'"' | b'`') {
            let quote = c;
            i += 1;
            let mut closed = false;
            while i < bytes.len() {
                if engine == Engine::Mysql && bytes[i] == b'\\' { i += 2; continue; }
                if bytes[i] == quote {
                    if bytes.get(i + 1) == Some(&quote) { i += 2; continue; }
                    i += 1;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed { return Err(AppError::bad_request("unterminated quoted text in migration SQL")); }
            tokens.push(MigrationToken::Other);
            continue;
        }
        if c == b'$' && engine == Engine::Postgres {
            let mut end = i + 1;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') { end += 1; }
            if end < bytes.len() && bytes[end] == b'$' {
                let tag = &sql[i..=end];
                let content = end + 1;
                let Some(relative) = sql[content..].find(tag) else {
                    return Err(AppError::bad_request("unterminated dollar-quoted text in migration SQL"));
                };
                i = content + relative + tag.len();
                tokens.push(MigrationToken::Other);
                continue;
            }
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            let start = i;
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'_' | b'$')) { i += 1; }
            tokens.push(MigrationToken::Word(sql[start..i].to_ascii_uppercase()));
            continue;
        }
        if c.is_ascii_digit() {
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') { i += 1; }
            tokens.push(MigrationToken::Number);
            continue;
        }
        if c.is_ascii() {
            tokens.push(MigrationToken::Symbol(c as char));
        } else {
            tokens.push(MigrationToken::Other);
        }
        i += 1;
    }
    Ok(tokens)
}

fn validate_rehearsal_statement(
    engine: Engine,
    sql: &str,
    input: &MigrationStatementInput,
) -> Result<(), AppError> {
    if !input.supported {
        return Err(AppError::bad_request(format!("statement at line {} is not fully modeled", input.line)));
    }
    if !matches!(input.kind.as_str(), "create-table" | "alter-table" | "drop-table" | "create-index" | "drop-index") {
        return Err(AppError::bad_request(format!("statement kind {} is not allowed in rehearsal", input.kind)));
    }
    let tokens = migration_tokens(engine, sql)?;
    if tokens.iter().any(|token| matches!(token, MigrationToken::Symbol('.'))) {
        return Err(AppError::bad_request(format!(
            "statement at line {} contains a qualified object name; rehearsal statements must stay unqualified inside scratch",
            input.line,
        )));
    }
    for forbidden in ["SELECT", "INSERT", "DELETE", "MERGE", "CALL", "DO", "EXEC", "EXECUTE", "COPY", "GRANT", "REVOKE", "TRUNCATE", "USE"] {
        if tokens.iter().any(|token| matches!(token, MigrationToken::Word(word) if word == forbidden)) {
            return Err(AppError::bad_request(format!(
                "statement at line {} contains {forbidden}, outside the DDL-only rehearsal model", input.line,
            )));
        }
    }
    let create_table = migration_word(&tokens, 0, "CREATE")
        && (migration_word(&tokens, 1, "TABLE")
            || migration_word(&tokens, 1, "TEMPORARY") && migration_word(&tokens, 2, "TABLE"));
    let alter_table = migration_word(&tokens, 0, "ALTER") && migration_word(&tokens, 1, "TABLE");
    let drop_table = migration_word(&tokens, 0, "DROP")
        && (migration_word(&tokens, 1, "TABLE")
            || migration_word(&tokens, 1, "TEMPORARY") && migration_word(&tokens, 2, "TABLE"));
    let create_index = migration_word(&tokens, 0, "CREATE")
        && (migration_word(&tokens, 1, "INDEX")
            || migration_word(&tokens, 1, "UNIQUE") && migration_word(&tokens, 2, "INDEX"));
    let drop_index = migration_word(&tokens, 0, "DROP") && migration_word(&tokens, 1, "INDEX");
    let shape_matches = match input.kind.as_str() {
        "create-table" => create_table,
        "alter-table" => alter_table,
        "drop-table" => drop_table,
        "create-index" => create_index,
        "drop-index" => drop_index,
        _ => false,
    };
    if !shape_matches {
        return Err(AppError::bad_request(format!(
            "statement at line {} does not match its reviewed {} shape", input.line, input.kind,
        )));
    }
    Ok(())
}

fn execution_summary(run_key: &str, sql_sha256: String, statement_total: usize) -> MigrationExecutionResult {
    MigrationExecutionResult {
        run_key: run_key.into(), sql_sha256, backend_id: None,
        statement_total: statement_total as u64, executed: 0, committed: 0,
        unknown: 0, failed: 0, not_started: statement_total as u64,
        statements: Vec::new(), ok: false, cancelled: false, partial: false,
        ms: 0, error: None,
    }
}

fn finalize_execution_counts(summary: &mut MigrationExecutionResult, started: std::time::Instant) {
    summary.committed = summary.executed;
    summary.not_started = summary.statement_total.saturating_sub(summary.statements.len() as u64);
    summary.ms = started.elapsed().as_millis() as u64;
    summary.partial = summary.executed > 0 || summary.failed > 0 || summary.unknown > 0
        || !summary.ok && !summary.statements.is_empty();
}

async fn finish_execution(
    state: &AppState,
    run_key: &str,
    status: &str,
    started: std::time::Instant,
    mut summary: MigrationExecutionResult,
) -> Result<MigrationExecutionResult, AppError> {
    finalize_execution_counts(&mut summary, started);
    if let Err(error) = scratch_status(state, run_key, status, summary.error.as_deref()).await {
        summary.ok = false;
        summary.partial = true;
        let message = format!("execution finished, but its scratch registry state could not be saved: {error}");
        summary.error = Some(match summary.error {
            Some(previous) => format!("{previous}; {message}"),
            None => message,
        });
    }
    Ok(summary)
}

async fn audit_execution_statement(
    state: &AppState,
    record: &MigrationScratchRecord,
    session_id: Uuid,
    statement: &MigrationStatementExecution,
    total: usize,
    sql: &str,
    started_at: String,
) {
    let start = state.session_starts.read().await.get(&session_id).cloned();
    let ended_at = crate::commands::audit::lifecycle_now();
    let entry = crate::commands::audit::AuditInsert {
        run_id: format!("migration-rehearsal:{}", record.run_key),
        stmt_index: Some(statement.number as i64),
        stmt_total: Some(total as i64),
        session_id: record.session_id.clone(),
        tab_title: "Migration Cockpit (rehearsal)".into(),
        database: record.name.clone(),
        source: "migration_rehearsal".into(),
        started_at,
        ended_at,
        duration_ms: statement.ms as i64,
        connection_name: start.as_ref().map(|value| value.connection_name.clone()).unwrap_or_default(),
        db_user: start.as_ref().map(|value| value.db_user.clone()).unwrap_or_default(),
        engine: record.engine.clone(),
        ok: statement.ok,
        rows_out: 0,
        rows_affected: statement.ok.then(|| statement.rows_affected as i64),
        error: statement.error.clone(),
        error_code: statement.error_code.clone(),
        db_code: statement.db_code.clone(),
        sqlstate: statement.sqlstate.clone(),
        sql: sql.into(),
    };
    if let Err(error) = crate::commands::audit::insert(&state.history, &entry).await {
        eprintln!("[audit] migration rehearsal insert failed: {error:#}");
    }
}

#[tauri::command]
pub async fn migration_rehearsal_execute(
    run_key: String,
    sql: String,
    expected_sql_sha256: String,
    statements: Vec<MigrationStatementInput>,
    catalog_complete: bool,
    tables_complete: bool,
    state: State<'_, AppState>,
) -> Result<MigrationExecutionResult, AppError> {
    execute_scratch(run_key, sql, expected_sql_sha256, statements, catalog_complete, tables_complete, &state).await
}

async fn execute_scratch(
    run_key: String,
    sql: String,
    expected_sql_sha256: String,
    statements: Vec<MigrationStatementInput>,
    catalog_complete: bool,
    tables_complete: bool,
    state: &AppState,
) -> Result<MigrationExecutionResult, AppError> {
    let record = scratch_record(state, &run_key).await?;
    if record.status != "active" {
        return Err(AppError::bad_request(format!(
            "migration execution requires fresh active scratch; {} is {}. Create new scratch instead of rerunning partial DDL.",
            record.name, record.status,
        )));
    }
    let session_id = Uuid::parse_str(&record.session_id)
        .map_err(|_| AppError::local("scratch record has an invalid session id"))?;
    let job_key = crate::state::ext_job_key(session_id, &run_key);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut jobs = state.ext_jobs.write().await;
        if jobs.contains_key(&job_key) {
            return Err(AppError::bad_request("scratch work is already running; cancel it before starting another operation"));
        }
        jobs.insert(job_key.clone(), cancel_tx);
    }
    let result = execute_scratch_inner(
        record, sql, expected_sql_sha256, statements, catalog_complete, tables_complete,
        session_id, &mut cancel_rx, state,
    ).await;
    state.ext_jobs.write().await.remove(&job_key);
    state.kills.write().await.remove(&format!("panel-{session_id}-migration-{run_key}"));
    result
}

#[allow(clippy::too_many_arguments)]
async fn execute_scratch_inner(
    record: MigrationScratchRecord,
    sql: String,
    expected_sql_sha256: String,
    metadata: Vec<MigrationStatementInput>,
    catalog_complete: bool,
    tables_complete: bool,
    session_id: Uuid,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
    state: &AppState,
) -> Result<MigrationExecutionResult, AppError> {
    let guard = state.session_meta.read().await.get(&session_id).cloned()
        .ok_or_else(|| AppError::new(crate::apperror::ErrorCode::NotFound, "rehearsal session is not open"))?;
    scratch_guard(&guard)?;
    if guard.engine.wire_name() != record.engine {
        return Err(AppError::bad_request("scratch engine does not match the open rehearsal session"));
    }
    let current_connection = state.session_starts.read().await.get(&session_id)
        .map(|start| start.connection_id.to_string()).unwrap_or_default();
    if current_connection != record.connection_id {
        return Err(AppError::bad_request("rehearsal session no longer matches the recorded physical connection"));
    }
    let actual_hash = format!("{:x}", Sha256::digest(sql.as_bytes()));
    if actual_hash != expected_sql_sha256 {
        return Err(AppError::bad_request("migration SQL hash does not match the reviewed hash; execution was refused"));
    }
    if !catalog_complete || !tables_complete {
        return Err(AppError::bad_request("execution requires a complete catalog and complete final table models"));
    }
    let plan = preflight(session_id, &sql, metadata.clone(), state).await?;
    if plan.unsupported != 0 || plan.sql_sha256 != expected_sql_sha256 {
        return Err(AppError::bad_request("backend preflight no longer proves this exact migration"));
    }
    let raw_statements = crate::sqlguard::split_statements_for(Some(guard.engine), &sql);
    for (statement, input) in raw_statements.iter().zip(&metadata) {
        validate_rehearsal_statement(guard.engine, statement, input)?;
    }
    let claimed = sqlx::query(
        "UPDATE migration_scratch SET status = 'executing', error = NULL, updated_at = datetime('now') \
         WHERE run_key = ? AND status = 'active'",
    ).bind(&record.run_key).execute(&state.history).await?;
    if claimed.rows_affected() != 1 {
        return Err(AppError::bad_request("scratch was claimed by another operation; execution was refused"));
    }

    let started = std::time::Instant::now();
    let total = raw_statements.len();
    let mut summary = execution_summary(&record.run_key, actual_hash, total);
    if cancel_rx.try_recv().is_ok() {
        summary.cancelled = true;
        summary.error = Some("migration rehearsal cancelled before acquiring a connection; no migration statement ran".into());
        return finish_execution(state, &record.run_key, "execution_cancelled", started, summary).await;
    }
    let acquired = tokio::select! {
        result = admin_for(state, session_id) => Some(result),
        _ = &mut *cancel_rx => None,
    };
    let (_, mut admin) = match acquired {
        Some(Ok(connection)) => connection,
        Some(Err(error)) => {
            summary.error = Some(format!("could not acquire the pinned rehearsal connection: {error}"));
            return finish_execution(state, &record.run_key, "execution_failed", started, summary).await;
        },
        None => {
            summary.cancelled = true;
            summary.error = Some("migration rehearsal cancelled before acquiring a connection; no migration statement ran".into());
            return finish_execution(state, &record.run_key, "execution_cancelled", started, summary).await;
        },
    };
    let backend = tokio::select! {
        result = admin.backend_id() => Some(result),
        _ = &mut *cancel_rx => None,
    };
    match backend {
        Some(Ok(id)) => summary.backend_id = Some(id),
        Some(Err(error)) => {
            let _ = admin.close_checked().await;
            summary.error = Some(format!("could not identify the pinned rehearsal backend: {error}"));
            return finish_execution(state, &record.run_key, "execution_failed", started, summary).await;
        },
        None => {
            let _ = admin.close_checked().await;
            summary.cancelled = true;
            summary.error = Some("migration rehearsal cancelled before selecting scratch; no migration statement ran".into());
            return finish_execution(state, &record.run_key, "execution_cancelled", started, summary).await;
        },
    }
    let backend_id = summary.backend_id.expect("backend id was assigned");
    let cancel_key = format!("panel-{session_id}-migration-{}", record.run_key);
    let select_scratch = match guard.engine {
        Engine::Mysql => format!("USE {}", mysql_ident(&record.name)),
        Engine::Postgres => format!("SET search_path TO {}", pg_ident(&record.name)),
        _ => unreachable!("scratch engine was validated"),
    };
    state.kills.write().await.insert(cancel_key.clone(), crate::state::KillHandle {
        backend_id, fingerprint: crate::db::connection::statement_fingerprint(&select_scratch),
    });
    let selected = tokio::select! {
        result = admin.drain(&select_scratch) => Some(result),
        _ = &mut *cancel_rx => None,
    };
    match selected {
        Some(Ok(_)) => {
            state.kills.write().await.remove(&cancel_key);
        },
        Some(Err(error)) => {
            state.kills.write().await.remove(&cancel_key);
            let _ = admin.close_checked().await;
            summary.error = Some(format!("could not select recorded scratch {}: {error}", record.name));
            return finish_execution(state, &record.run_key, "execution_failed", started, summary).await;
        },
        None => {
            crate::commands::query::stop_in_flight(
                session_id, &cancel_key, &state.sessions, &state.kills, &state.ch_kills,
            ).await;
            let _ = admin.close_checked().await;
            summary.cancelled = true;
            summary.error = Some("migration rehearsal cancelled while selecting scratch; no migration statement ran".into());
            return finish_execution(state, &record.run_key, "execution_cancelled", started, summary).await;
        },
    }

    for (index, (statement_sql, input)) in raw_statements.iter().zip(&metadata).enumerate() {
        if cancel_rx.try_recv().is_ok() {
            summary.cancelled = true;
            summary.error = Some(format!("cancelled before statement {}; earlier statements remain in scratch", index + 1));
            break;
        }
        let statement_started = std::time::Instant::now();
        let statement_started_at = crate::commands::audit::lifecycle_now();
        state.kills.write().await.insert(cancel_key.clone(), crate::state::KillHandle {
            backend_id,
            fingerprint: crate::db::connection::statement_fingerprint(statement_sql),
        });
        let outcome = tokio::select! {
            result = admin.drain(statement_sql) => Some(result),
            _ = &mut *cancel_rx => None,
        };
        let number = index as u64 + 1;
        let statement = match outcome {
            Some(Ok(rows)) => {
                state.kills.write().await.remove(&cancel_key);
                summary.executed += 1;
                MigrationStatementExecution {
                    number, line: input.line, ms: statement_started.elapsed().as_millis() as u64,
                    rows_affected: rows, ok: true, error: None,
                    error_code: String::new(), db_code: String::new(), sqlstate: String::new(),
                }
            },
            Some(Err(error)) => {
                state.kills.write().await.remove(&cancel_key);
                summary.failed += 1;
                let error = AppError::from(error);
                MigrationStatementExecution {
                    number, line: input.line, ms: statement_started.elapsed().as_millis() as u64,
                    rows_affected: 0, ok: false, error: Some(error.display()),
                    error_code: error.code.as_str().into(),
                    db_code: error.db_code.unwrap_or_default(), sqlstate: error.sqlstate.unwrap_or_default(),
                }
            },
            None => {
                crate::commands::query::stop_in_flight(
                    session_id, &cancel_key, &state.sessions, &state.kills, &state.ch_kills,
                ).await;
                summary.cancelled = true;
                summary.unknown += 1;
                MigrationStatementExecution {
                    number, line: input.line, ms: statement_started.elapsed().as_millis() as u64,
                    rows_affected: 0, ok: false,
                    error: Some("cancellation requested before this statement completed; its server outcome is unverified".into()),
                    error_code: crate::apperror::ErrorCode::Cancelled.as_str().into(),
                    db_code: String::new(), sqlstate: String::new(),
                }
            },
        };
        if !statement.ok && summary.error.is_none() {
            summary.error = statement.error.clone();
        }
        audit_execution_statement(
            state, &record, session_id, &statement, total, statement_sql, statement_started_at,
        ).await;
        summary.statements.push(statement);
        if summary.cancelled || summary.failed > 0 { break; }
        if cancel_rx.try_recv().is_ok() {
            summary.cancelled = true;
            summary.error = Some(format!("cancelled after statement {number}; completed work remains in scratch"));
            break;
        }
    }
    if !summary.cancelled && summary.failed == 0 && summary.executed as usize == total {
        summary.ok = true;
        summary.error = None;
    } else if summary.error.is_none() {
        summary.error = Some(format!(
            "migration rehearsal stopped after {}/{} statements; scratch was not rolled back",
            summary.executed, total,
        ));
    }
    if let Err(error) = admin.close_checked().await {
        summary.ok = false;
        let message = format!("pinned rehearsal connection could not be closed cleanly: {error}");
        summary.error = Some(match summary.error.take() {
            Some(previous) => format!("{previous}; {message}"),
            None => message,
        });
    }
    let status = if summary.cancelled { "execution_cancelled" }
        else if summary.ok { "executed" } else { "execution_failed" };
    finish_execution(state, &record.run_key, status, started, summary).await
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct MigrationDeploymentRecord {
    pub run_key: String,
    pub session_id: String,
    pub connection_id: String,
    pub source_connection_id: String,
    pub rehearsal_run_key: String,
    pub database_name: String,
    pub engine: String,
    pub sql_sha256: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

async fn deployment_record(state: &AppState, run_key: &str) -> Result<Option<MigrationDeploymentRecord>, AppError> {
    Ok(sqlx::query_as::<_, MigrationDeploymentRecord>(
        "SELECT run_key, session_id, connection_id, source_connection_id, rehearsal_run_key,
                database_name, engine, sql_sha256, status, error, created_at, updated_at
         FROM migration_deployment WHERE run_key = ?",
    ).bind(run_key).fetch_optional(&state.history).await?)
}

async fn deployment_status(state: &AppState, run_key: &str, status: &str, error: Option<&str>) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE migration_deployment SET status = ?, error = ?, updated_at = datetime('now') WHERE run_key = ?",
    ).bind(status).bind(error).bind(run_key).execute(&state.history).await?;
    Ok(())
}

async fn finish_deployment(
    state: &AppState,
    run_key: &str,
    status: &str,
    started: std::time::Instant,
    mut summary: MigrationExecutionResult,
    on_event: Option<&tauri::ipc::Channel<MigrationDeploymentEvent>>,
) -> Result<MigrationExecutionResult, AppError> {
    finalize_execution_counts(&mut summary, started);
    if let Err(error) = deployment_status(state, run_key, status, summary.error.as_deref()).await {
        summary.ok = false;
        summary.partial = true;
        let message = format!("deployment finished, but its durable run state could not be saved: {error}");
        summary.error = Some(match summary.error {
            Some(previous) => format!("{previous}; {message}"),
            None => message,
        });
    }
    send_deployment_event(on_event, MigrationDeploymentEvent::Done {
        ok: summary.ok, cancelled: summary.cancelled, committed: summary.committed,
        unknown: summary.unknown, failed: summary.failed, not_started: summary.not_started,
    });
    Ok(summary)
}

#[allow(clippy::too_many_arguments)]
async fn audit_deployment_statement(
    state: &AppState,
    run_key: &str,
    session_id: Uuid,
    engine: Engine,
    database: &str,
    statement: &MigrationStatementExecution,
    total: usize,
    sql: &str,
    started_at: String,
) {
    let start = state.session_starts.read().await.get(&session_id).cloned();
    let entry = crate::commands::audit::AuditInsert {
        run_id: format!("migration:{run_key}"),
        stmt_index: Some(statement.number as i64),
        stmt_total: Some(total as i64),
        session_id: session_id.to_string(),
        tab_title: "Migration Cockpit (deployment)".into(),
        database: database.into(),
        source: "migration".into(),
        started_at,
        ended_at: crate::commands::audit::lifecycle_now(),
        duration_ms: statement.ms as i64,
        connection_name: start.as_ref().map(|value| value.connection_name.clone()).unwrap_or_default(),
        db_user: start.as_ref().map(|value| value.db_user.clone()).unwrap_or_default(),
        engine: engine.wire_name().into(),
        ok: statement.ok,
        rows_out: 0,
        rows_affected: statement.ok.then(|| statement.rows_affected as i64),
        error: statement.error.clone(),
        error_code: statement.error_code.clone(),
        db_code: statement.db_code.clone(),
        sqlstate: statement.sqlstate.clone(),
        sql: sql.into(),
    };
    if let Err(error) = crate::commands::audit::insert(&state.history, &entry).await {
        eprintln!("[audit] migration deployment insert failed: {error:#}");
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn migration_deploy_execute(
    session_id: Uuid,
    run_key: String,
    rehearsal_run_key: String,
    source_connection_id: String,
    target_connection_id: String,
    database: String,
    sql: String,
    expected_sql_sha256: String,
    statements: Vec<MigrationStatementInput>,
    catalog_complete: bool,
    tables_complete: bool,
    on_event: tauri::ipc::Channel<MigrationDeploymentEvent>,
    state: State<'_, AppState>,
) -> Result<MigrationExecutionResult, AppError> {
    execute_deployment(
        session_id, run_key, rehearsal_run_key, source_connection_id, target_connection_id,
        database, sql, expected_sql_sha256, statements, catalog_complete, tables_complete,
        Some(&on_event), &state,
    ).await
}

#[allow(clippy::too_many_arguments)]
async fn execute_deployment(
    session_id: Uuid,
    run_key: String,
    rehearsal_run_key: String,
    source_connection_id: String,
    target_connection_id: String,
    database: String,
    sql: String,
    expected_sql_sha256: String,
    metadata: Vec<MigrationStatementInput>,
    catalog_complete: bool,
    tables_complete: bool,
    on_event: Option<&tauri::ipc::Channel<MigrationDeploymentEvent>>,
    state: &AppState,
) -> Result<MigrationExecutionResult, AppError> {
    if Uuid::parse_str(&run_key).is_err() || Uuid::parse_str(&rehearsal_run_key).is_err() {
        return Err(AppError::bad_request("deployment and rehearsal run keys must be UUIDs"));
    }
    let job_key = crate::state::ext_job_key(session_id, &run_key);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut jobs = state.ext_jobs.write().await;
        if jobs.contains_key(&job_key) {
            return Err(AppError::bad_request("this migration deployment is already running"));
        }
        jobs.insert(job_key.clone(), cancel_tx);
    }
    let cancel_key = format!("panel-{session_id}-migration-deploy-{run_key}");
    let result = execute_deployment_inner(
        session_id, &run_key, &rehearsal_run_key, &source_connection_id, &target_connection_id,
        &database, &sql, &expected_sql_sha256, metadata, catalog_complete, tables_complete,
        &mut cancel_rx, &cancel_key, on_event, state,
    ).await;
    state.ext_jobs.write().await.remove(&job_key);
    state.kills.write().await.remove(&cancel_key);
    result
}

#[allow(clippy::too_many_arguments)]
async fn execute_deployment_inner(
    session_id: Uuid,
    run_key: &str,
    rehearsal_run_key: &str,
    source_connection_id: &str,
    target_connection_id: &str,
    database: &str,
    sql: &str,
    expected_sql_sha256: &str,
    metadata: Vec<MigrationStatementInput>,
    catalog_complete: bool,
    tables_complete: bool,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
    cancel_key: &str,
    on_event: Option<&tauri::ipc::Channel<MigrationDeploymentEvent>>,
    state: &AppState,
) -> Result<MigrationExecutionResult, AppError> {
    if deployment_record(state, run_key).await?.is_some() {
        return Err(AppError::bad_request("deployment run ID was already claimed; inspect its audit/result instead of executing it again"));
    }
    let rehearsal = scratch_record(state, rehearsal_run_key).await?;
    if rehearsal.status != "executed" {
        return Err(AppError::bad_request("deployment requires its completed, uncompared scratch execution to remain recorded; cleanup or a failed rehearsal cannot authorize deployment"));
    }
    let guard = state.session_meta.read().await.get(&session_id).cloned()
        .ok_or_else(|| AppError::new(crate::apperror::ErrorCode::NotFound, "migration target session is not open"))?;
    if !matches!(guard.engine, Engine::Mysql | Engine::Postgres) || guard.engine.wire_name() != rehearsal.engine {
        return Err(AppError::bad_request("deployment target and rehearsal engines do not match"));
    }
    if !guard.autocommit {
        return Err(AppError::guard("migration deployment requires an autocommit target so completed statement outcomes are not mistaken for committed work"));
    }
    if database.trim().is_empty() {
        return Err(AppError::bad_request("deployment requires the exact reviewed target database/schema"));
    }
    let actual_target = state.session_starts.read().await.get(&session_id)
        .map(|start| start.connection_id.to_string()).unwrap_or_default();
    if actual_target != target_connection_id || rehearsal.connection_id != source_connection_id {
        return Err(AppError::bad_request("source/target physical connection identity changed; review and rehearsal must be repeated"));
    }
    let actual_hash = format!("{:x}", Sha256::digest(sql.as_bytes()));
    if actual_hash != expected_sql_sha256 || !catalog_complete || !tables_complete {
        return Err(AppError::bad_request("deployment requires the exact reviewed SQL hash and complete catalog/final-table proof"));
    }
    let plan = preflight(session_id, sql, metadata.clone(), state).await?;
    if plan.unsupported != 0 || plan.sql_sha256 != expected_sql_sha256 {
        return Err(AppError::bad_request("target preflight no longer proves this exact migration"));
    }
    let raw_statements = crate::sqlguard::split_statements_for(Some(guard.engine), sql);
    for (statement, input) in raw_statements.iter().zip(&metadata) {
        validate_rehearsal_statement(guard.engine, statement, input)?;
    }
    let claimed = sqlx::query(
        "INSERT INTO migration_deployment
         (run_key, session_id, connection_id, source_connection_id, rehearsal_run_key,
          database_name, engine, sql_sha256, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deploying')",
    ).bind(run_key).bind(session_id.to_string()).bind(target_connection_id)
        .bind(source_connection_id).bind(rehearsal_run_key).bind(database)
        .bind(guard.engine.wire_name()).bind(&actual_hash)
        .execute(&state.history).await;
    if let Err(error) = claimed {
        return Err(AppError::bad_request(format!("deployment run could not be claimed exactly once: {error}")));
    }

    let started = std::time::Instant::now();
    let total = raw_statements.len();
    let mut summary = execution_summary(run_key, actual_hash, total);
    send_deployment_event(on_event, MigrationDeploymentEvent::Started {
        run_key: run_key.into(), statement_total: total as u64, database: database.into(),
    });
    if cancel_rx.try_recv().is_ok() {
        summary.cancelled = true;
        summary.error = Some("deployment cancelled before acquiring a connection; no migration statement ran".into());
        return finish_deployment(state, run_key, "execution_cancelled", started, summary, on_event).await;
    }
    let acquired = tokio::select! {
        result = admin_for(state, session_id) => Some(result),
        _ = &mut *cancel_rx => None,
    };
    let (_, mut admin) = match acquired {
        Some(Ok(connection)) => connection,
        Some(Err(error)) => {
            summary.error = Some(format!("could not acquire the dedicated deployment connection: {error}"));
            return finish_deployment(state, run_key, "execution_failed", started, summary, on_event).await;
        },
        None => {
            summary.cancelled = true;
            summary.error = Some("deployment cancelled before acquiring a connection; no migration statement ran".into());
            return finish_deployment(state, run_key, "execution_cancelled", started, summary, on_event).await;
        },
    };
    let backend = tokio::select! {
        result = admin.backend_id() => Some(result),
        _ = &mut *cancel_rx => None,
    };
    match backend {
        Some(Ok(id)) => summary.backend_id = Some(id),
        Some(Err(error)) => {
            let _ = admin.close_checked().await;
            summary.error = Some(format!("could not identify the dedicated deployment backend: {error}"));
            return finish_deployment(state, run_key, "execution_failed", started, summary, on_event).await;
        },
        None => {
            let _ = admin.close_checked().await;
            summary.cancelled = true;
            summary.error = Some("deployment cancelled before selecting the target; no migration statement ran".into());
            return finish_deployment(state, run_key, "execution_cancelled", started, summary, on_event).await;
        },
    }
    let backend_id = summary.backend_id.expect("backend id was assigned");
    send_deployment_event(on_event, MigrationDeploymentEvent::Backend { backend_id });
    let select_target = match guard.engine {
        Engine::Mysql => format!("USE {}", mysql_ident(database)),
        Engine::Postgres => format!("SET search_path TO {}", pg_ident(database)),
        _ => unreachable!("deployment engine was validated"),
    };
    state.kills.write().await.insert(cancel_key.into(), crate::state::KillHandle {
        backend_id, fingerprint: crate::db::connection::statement_fingerprint(&select_target),
    });
    let selected = tokio::select! {
        result = admin.drain(&select_target) => Some(result),
        _ = &mut *cancel_rx => None,
    };
    match selected {
        Some(Ok(_)) => { state.kills.write().await.remove(cancel_key); },
        Some(Err(error)) => {
            state.kills.write().await.remove(cancel_key);
            let _ = admin.close_checked().await;
            summary.error = Some(format!("could not select reviewed deployment target {database}: {error}"));
            return finish_deployment(state, run_key, "execution_failed", started, summary, on_event).await;
        },
        None => {
            crate::commands::query::stop_in_flight(session_id, cancel_key, &state.sessions, &state.kills, &state.ch_kills).await;
            let _ = admin.close_checked().await;
            summary.cancelled = true;
            summary.error = Some("deployment cancelled while selecting the target; no migration statement ran".into());
            return finish_deployment(state, run_key, "execution_cancelled", started, summary, on_event).await;
        },
    }

    for (index, (statement_sql, input)) in raw_statements.iter().zip(&metadata).enumerate() {
        if cancel_rx.try_recv().is_ok() {
            summary.cancelled = true;
            summary.error = Some(format!("cancelled before statement {}; committed statements were not rolled back", index + 1));
            break;
        }
        let statement_started = std::time::Instant::now();
        let statement_started_at = crate::commands::audit::lifecycle_now();
        state.kills.write().await.insert(cancel_key.into(), crate::state::KillHandle {
            backend_id, fingerprint: crate::db::connection::statement_fingerprint(statement_sql),
        });
        let outcome = tokio::select! {
            result = admin.drain(statement_sql) => Some(result),
            _ = &mut *cancel_rx => None,
        };
        let number = index as u64 + 1;
        let statement = match outcome {
            Some(Ok(rows)) => {
                state.kills.write().await.remove(cancel_key);
                summary.executed += 1;
                MigrationStatementExecution {
                    number, line: input.line, ms: statement_started.elapsed().as_millis() as u64,
                    rows_affected: rows, ok: true, error: None,
                    error_code: String::new(), db_code: String::new(), sqlstate: String::new(),
                }
            },
            Some(Err(error)) => {
                state.kills.write().await.remove(cancel_key);
                summary.failed += 1;
                let error = AppError::from(error);
                MigrationStatementExecution {
                    number, line: input.line, ms: statement_started.elapsed().as_millis() as u64,
                    rows_affected: 0, ok: false, error: Some(error.display()),
                    error_code: error.code.as_str().into(),
                    db_code: error.db_code.unwrap_or_default(), sqlstate: error.sqlstate.unwrap_or_default(),
                }
            },
            None => {
                crate::commands::query::stop_in_flight(session_id, cancel_key, &state.sessions, &state.kills, &state.ch_kills).await;
                summary.cancelled = true;
                summary.unknown += 1;
                MigrationStatementExecution {
                    number, line: input.line, ms: statement_started.elapsed().as_millis() as u64,
                    rows_affected: 0, ok: false,
                    error: Some("cancellation requested before this statement completed; its server outcome is unknown and no rollback is claimed".into()),
                    error_code: crate::apperror::ErrorCode::Cancelled.as_str().into(),
                    db_code: String::new(), sqlstate: String::new(),
                }
            },
        };
        if !statement.ok && summary.error.is_none() { summary.error = statement.error.clone(); }
        audit_deployment_statement(
            state, run_key, session_id, guard.engine, database, &statement, total, statement_sql, statement_started_at,
        ).await;
        summary.not_started = (total - index - 1) as u64;
        send_deployment_event(on_event, MigrationDeploymentEvent::Statement {
            statement: statement.clone(), committed: summary.executed, unknown: summary.unknown,
            failed: summary.failed, not_started: summary.not_started,
        });
        summary.statements.push(statement);
        if summary.cancelled || summary.failed > 0 { break; }
        if cancel_rx.try_recv().is_ok() {
            summary.cancelled = true;
            summary.error = Some(format!("cancelled after statement {number}; committed statements were not rolled back"));
            break;
        }
    }
    if !summary.cancelled && summary.failed == 0 && summary.executed as usize == total {
        summary.ok = true;
        summary.error = None;
    } else if summary.error.is_none() {
        summary.error = Some(format!("deployment stopped after {}/{} statements; committed work was not rolled back", summary.executed, total));
    }
    if let Err(error) = admin.close_checked().await {
        summary.ok = false;
        let message = format!("dedicated deployment connection could not be closed cleanly: {error}");
        summary.error = Some(match summary.error.take() {
            Some(previous) => format!("{previous}; {message}"),
            None => message,
        });
    }
    let status = if summary.cancelled { "execution_cancelled" }
        else if summary.ok { "executed" } else { "execution_failed" };
    finish_deployment(state, run_key, status, started, summary, on_event).await
}

#[tauri::command]
pub async fn migration_rehearsal_create(
    session_id: Uuid,
    run_key: String,
    state: State<'_, AppState>,
) -> Result<MigrationScratchRecord, AppError> {
    if Uuid::parse_str(&run_key).is_err() {
        return Err(AppError::bad_request("runKey must be a UUID"));
    }
    let name = format!("txui_mig_{}", Uuid::new_v4().simple().to_string()[..16].to_string());
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    let job_key = crate::state::ext_job_key(session_id, &run_key);
    state.ext_jobs.write().await.insert(job_key.clone(), cancel_tx);
    let result = create_scratch_named(&state, session_id, &run_key, &name, &mut cancel_rx).await;
    state.ext_jobs.write().await.remove(&job_key);
    result
}

#[tauri::command]
pub async fn migration_rehearsal_cleanup(
    run_key: String,
    state: State<'_, AppState>,
) -> Result<MigrationScratchRecord, AppError> {
    cleanup_scratch(&state, &run_key).await
}

pub(crate) async fn cleanup_scratch(state: &AppState, run_key: &str) -> Result<MigrationScratchRecord, AppError> {
    let record = scratch_record(state, run_key).await?;
    let session_id = Uuid::parse_str(&record.session_id)
        .map_err(|_| AppError::local("scratch record has an invalid session id"))?;
    let job_key = crate::state::ext_job_key(session_id, &run_key);
    if state.ext_jobs.read().await.contains_key(&job_key) {
        return Err(AppError::bad_request("scratch work is still running; cancel it before cleanup"));
    }
    let guard = state.session_meta.read().await.get(&session_id).cloned()
        .ok_or_else(|| AppError::new(crate::apperror::ErrorCode::NotFound,
            format!("reconnect the rehearsal session to clean {0}", record.name)))?;
    scratch_guard(&guard)?;
    let engine = match record.engine.as_str() {
        "mysql" => Engine::Mysql,
        "postgres" => Engine::Postgres,
        _ => return Err(AppError::local("scratch record has an unsupported engine")),
    };
    state.guard_statement(&session_id, &scratch_drop_sql(engine, &record.name)).await?;
    let (_, mut admin) = match admin_for(&state, session_id).await {
        Ok(connection) => connection,
        Err(error) => {
            let message = format!("scratch object {} was not dropped: {error}", record.name);
            scratch_status(state, run_key, "cleanup_failed", Some(&message)).await?;
            return Err(AppError::local(message));
        },
    };
    let result = admin.execute(&scratch_drop_sql(engine, &record.name)).await;
    admin.close().await;
    if let Err(error) = result {
        let message = format!("scratch object {} was not dropped: {error}", record.name);
        scratch_status(&state, &run_key, "cleanup_failed", Some(&message)).await?;
        return Err(AppError::local(message));
    }
    scratch_status(&state, &run_key, "dropped", None).await?;
    scratch_record(&state, &run_key).await
}

#[tauri::command]
pub async fn migration_scratch_list(
    state: State<'_, AppState>,
) -> Result<Vec<MigrationScratchRecord>, AppError> {
    Ok(sqlx::query_as::<_, MigrationScratchRecord>(
        "SELECT run_key, session_id, connection_id, engine, name, status, error, created_at, updated_at
         FROM migration_scratch
         WHERE status IN ('creating', 'active', 'executing', 'executed', 'execution_failed', 'execution_cancelled', 'cleanup_failed')
         ORDER BY updated_at DESC LIMIT 100",
    ).fetch_all(&state.history).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::SessionGuard;
    use std::collections::HashMap;

    async fn state_with(engine: Engine, environment: &str, read_only: bool, allow_ddl: bool) -> (AppState, Uuid) {
        let history = crate::history::open_in_memory().await.expect("history");
        let state = AppState::new(history, std::env::temp_dir(), HashMap::new());
        let id = Uuid::new_v4();
        let guard = SessionGuard {
            read_only,
            engine,
            environment: Some(environment.into()),
            log_dir: None,
            prod_allow_ddl: allow_ddl,
            prod_allow_unfiltered_write: false,
            autocommit: true,
            query_timeout_secs: None,
            db_filter: Vec::new(),
            degraded: None,
        };
        state.session_meta.write().await.insert(id, guard);
        (state, id)
    }

    fn metadata(kinds: &[&str]) -> Vec<MigrationStatementInput> {
        kinds.iter().enumerate().map(|(index, kind)| MigrationStatementInput {
            kind: kind.to_string(),
            line: index as u64 + 1,
            table: Some("orders".into()),
            supported: true,
            summary: format!("{kind} orders"),
            destructive: *kind == "drop-table",
            lossy: false,
            cost: None,
        }).collect()
    }

    #[tokio::test]
    async fn read_only_refuses_before_returning_a_plan() {
        let (state, id) = state_with(Engine::Mysql, "dev", true, true).await;
        let error = preflight(id, "ALTER TABLE orders ADD note text", metadata(&["alter-table"]), &state)
            .await.expect_err("read-only must refuse");
        assert_eq!(error.code, crate::apperror::ErrorCode::GuardRefused);
    }

    #[tokio::test]
    async fn prod_ddl_requires_the_connection_opt_in() {
        let (state, id) = state_with(Engine::Mysql, "prod", false, false).await;
        let error = preflight(id, "DROP TABLE orders", metadata(&["drop-table"]), &state)
            .await.expect_err("prod DDL must refuse");
        assert_eq!(error.code, crate::apperror::ErrorCode::GuardRefused);
    }

    #[tokio::test]
    async fn mysql_plan_has_hash_objects_implicit_commits_and_stop_on_error() {
        let (state, id) = state_with(Engine::Mysql, "prod", false, true).await;
        let sql = "ALTER TABLE orders ADD note text;\nDROP TABLE orders;";
        let result = preflight(id, sql, metadata(&["alter-table", "drop-table"]), &state)
            .await.expect("allowed plan");
        assert_eq!(result.statement_count, 2);
        assert_eq!(result.affected_objects, ["orders"]);
        assert_eq!(result.destructive, 1);
        assert_eq!(result.implicit_commits, 2);
        assert_eq!(result.environment.as_deref(), Some("prod"));
        assert!(result.prod_allow_ddl);
        assert!(result.stop_on_first_error);
        assert_eq!(result.sql_sha256, format!("{:x}", Sha256::digest(sql.as_bytes())));
    }

    #[tokio::test]
    async fn postgres_has_no_mysql_implicit_commit() {
        let (state, id) = state_with(Engine::Postgres, "dev", false, true).await;
        let result = preflight(id, "ALTER TABLE orders ADD note text", metadata(&["alter-table"]), &state)
            .await.expect("plan");
        assert_eq!(result.implicit_commits, 0);
    }

    #[tokio::test]
    async fn splitter_ignores_semicolons_inside_engine_specific_text() {
        let (state, id) = state_with(Engine::Postgres, "dev", false, true).await;
        let sql = "CREATE TABLE t(body text DEFAULT $$;$$); /* ; */ ALTER TABLE t ADD note text";
        let result = preflight(id, sql, metadata(&["create-table", "alter-table"]), &state)
            .await.expect("split plan");
        assert_eq!(result.statement_count, 2);
    }

    #[tokio::test]
    async fn statement_model_mismatch_fails_closed() {
        let (state, id) = state_with(Engine::Mysql, "dev", false, true).await;
        let error = preflight(id, "ALTER TABLE orders ADD note text; ALTER TABLE orders ADD other text", metadata(&["alter-table"]), &state)
            .await.expect_err("mismatch");
        assert_eq!(error.code, crate::apperror::ErrorCode::BadRequest);
    }

    #[tokio::test]
    async fn empty_sql_is_rejected() {
        let (state, id) = state_with(Engine::Mysql, "dev", false, true).await;
        let error = preflight(id, " -- only a comment\n", vec![], &state)
            .await.expect_err("empty");
        assert_eq!(error.code, crate::apperror::ErrorCode::BadRequest);
    }

    #[test]
    fn rehearsal_validation_accepts_only_unqualified_modeled_ddl() {
        let input = |kind: &str| MigrationStatementInput {
            kind: kind.into(), line: 7, table: Some("t".into()), supported: true,
            summary: kind.into(), destructive: false, lossy: false, cost: None,
        };
        validate_rehearsal_statement(
            Engine::Mysql,
            "CREATE TABLE t(amount numeric(10,2) DEFAULT 1.25, note text DEFAULT 'schema.table')",
            &input("create-table"),
        ).unwrap();
        validate_rehearsal_statement(
            Engine::Postgres,
            "CREATE TABLE t(note text DEFAULT $$schema.table; SELECT$$)",
            &input("create-table"),
        ).unwrap();
        let qualified = validate_rehearsal_statement(
            Engine::Mysql, "ALTER TABLE shop.t ADD note text", &input("alter-table"),
        ).unwrap_err();
        assert!(qualified.message.contains("qualified object name"));
        let query = validate_rehearsal_statement(
            Engine::Mysql, "CREATE TABLE t AS SELECT * FROM source", &input("create-table"),
        ).unwrap_err();
        assert!(query.message.contains("SELECT"));
        for (sql, kind) in [
            ("USE shop", "alter-table"),
            ("INSERT INTO t VALUES (1)", "alter-table"),
            ("TRUNCATE TABLE t", "truncate"),
            ("DROP TABLE t", "create-table"),
            ("CREATE TABLE t(id int) /*! ENGINE=INNODB */", "create-table"),
        ] {
            assert!(validate_rehearsal_statement(Engine::Mysql, sql, &input(kind)).is_err(), "accepted {sql}");
        }
    }

    #[tokio::test]
    async fn execution_refuses_hash_mismatch_before_acquiring_a_connection() {
        let (state, id) = state_with(Engine::Mysql, "dev", false, true).await;
        let run_key = Uuid::new_v4().to_string();
        insert_scratch(&state, &run_key, id, Engine::Mysql, "txui_mig_hash").await.unwrap();
        scratch_status(&state, &run_key, "active", None).await.unwrap();
        let sql = "ALTER TABLE orders ADD note text";
        let error = execute_scratch(
            run_key.clone(), sql.into(), "0".repeat(64), metadata(&["alter-table"]), true, true, &state,
        ).await.expect_err("wrong reviewed hash");
        assert_eq!(error.code, crate::apperror::ErrorCode::BadRequest);
        assert!(error.message.contains("hash"));
        assert_eq!(scratch_record(&state, &run_key).await.unwrap().status, "active");
        assert!(state.ext_jobs.read().await.is_empty());
    }

    #[tokio::test]
    async fn executed_scratch_is_single_use() {
        let (state, id) = state_with(Engine::Mysql, "dev", false, true).await;
        let run_key = Uuid::new_v4().to_string();
        insert_scratch(&state, &run_key, id, Engine::Mysql, "txui_mig_once").await.unwrap();
        scratch_status(&state, &run_key, "executed", None).await.unwrap();
        let sql = "ALTER TABLE orders ADD note text";
        let hash = format!("{:x}", Sha256::digest(sql.as_bytes()));
        let error = execute_scratch(
            run_key, sql.into(), hash, metadata(&["alter-table"]), true, true, &state,
        ).await.expect_err("second execution");
        assert!(error.message.contains("fresh active scratch"));
    }

    #[tokio::test]
    async fn deployment_refuses_changed_identity_and_manual_transactions_before_claim() {
        let (state, id) = state_with(Engine::Mysql, "dev", false, true).await;
        let mut config = crate::db::types::ConnectionConfig::new(Engine::Mysql, "deployment-target");
        config.autocommit = true;
        state.session_starts.write().await.insert(id, crate::commands::audit::session_start(&config));
        let rehearsal_key = Uuid::new_v4().to_string();
        insert_scratch(&state, &rehearsal_key, id, Engine::Mysql, "txui_mig_deploy_guard").await.unwrap();
        scratch_status(&state, &rehearsal_key, "executed", None).await.unwrap();
        let sql = "ALTER TABLE orders ADD note text";
        let hash = format!("{:x}", Sha256::digest(sql.as_bytes()));
        let wrong = execute_deployment(
            id, Uuid::new_v4().to_string(), rehearsal_key.clone(), "different-source".into(),
            config.id.to_string(), "shop".into(), sql.into(), hash.clone(), metadata(&["alter-table"]),
            true, true, None, &state,
        ).await.expect_err("changed source identity");
        assert!(wrong.message.contains("identity changed"));
        assert!(state.ext_jobs.read().await.is_empty());

        state.session_meta.write().await.get_mut(&id).unwrap().autocommit = false;
        let manual = execute_deployment(
            id, Uuid::new_v4().to_string(), rehearsal_key, config.id.to_string(),
            config.id.to_string(), "shop".into(), sql.into(), hash, metadata(&["alter-table"]),
            true, true, None, &state,
        ).await.expect_err("manual transaction");
        assert_eq!(manual.code, crate::apperror::ErrorCode::GuardRefused);
        assert!(state.ext_jobs.read().await.is_empty());
    }

    #[tokio::test]
    async fn deployment_run_id_cannot_be_claimed_twice() {
        let (state, id) = state_with(Engine::Mysql, "dev", false, true).await;
        let run_key = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO migration_deployment
             (run_key, session_id, connection_id, source_connection_id, rehearsal_run_key,
              database_name, engine, sql_sha256, status)
             VALUES (?, ?, 'target', 'source', ?, 'shop', 'mysql', ?, 'execution_failed')",
        ).bind(&run_key).bind(id.to_string()).bind(Uuid::new_v4().to_string()).bind("0".repeat(64))
            .execute(&state.history).await.unwrap();
        let sql = "ALTER TABLE orders ADD note text";
        let error = execute_deployment(
            id, run_key, Uuid::new_v4().to_string(), "source".into(), "target".into(),
            "shop".into(), sql.into(), format!("{:x}", Sha256::digest(sql.as_bytes())),
            metadata(&["alter-table"]), true, true, None, &state,
        ).await.expect_err("second claim");
        assert!(error.message.contains("already claimed"));
        assert!(state.ext_jobs.read().await.is_empty());
    }

    #[test]
    fn execution_counts_distinguish_unknown_from_failed_and_not_started() {
        let mut summary = execution_summary("run", "0".repeat(64), 3);
        summary.executed = 1;
        summary.unknown = 1;
        summary.cancelled = true;
        summary.statements.push(MigrationStatementExecution {
            number: 1, line: 1, ms: 1, rows_affected: 0, ok: true,
            error: None, error_code: String::new(), db_code: String::new(), sqlstate: String::new(),
        });
        summary.statements.push(MigrationStatementExecution {
            number: 2, line: 2, ms: 1, rows_affected: 0, ok: false,
            error: Some("unknown".into()), error_code: "cancelled".into(), db_code: String::new(), sqlstate: String::new(),
        });
        finalize_execution_counts(&mut summary, std::time::Instant::now());
        assert_eq!((summary.committed, summary.unknown, summary.failed, summary.not_started), (1, 1, 0, 1));
        assert!(summary.partial);
    }

    #[test]
    fn scratch_sql_quotes_identifiers_and_uses_idempotent_cleanup() {
        assert_eq!(scratch_create_sql(Engine::Mysql, "a`b"), "CREATE DATABASE `a``b`");
        assert_eq!(scratch_create_sql(Engine::Postgres, "a\"b"), "CREATE SCHEMA \"a\"\"b\"");
        assert!(scratch_drop_sql(Engine::Mysql, "x").contains("IF EXISTS"));
        assert!(scratch_drop_sql(Engine::Postgres, "x").contains("CASCADE"));
    }

    fn clone_fk(name: &str, table: &str, ref_table: &str) -> MigrationCloneForeignKey {
        MigrationCloneForeignKey {
            name: name.into(), table: table.into(), columns: vec!["a".into(), "b".into()],
            ref_table: ref_table.into(), ref_columns: vec!["x".into(), "y".into()],
            on_delete: "CASCADE".into(), on_update: "SET NULL".into(),
            validated: Some(false), match_type: Some("full".into()),
            deferrable: Some(true), deferred: Some(true),
        }
    }

    #[test]
    fn clone_creates_every_table_before_composite_foreign_keys() {
        let tables = vec![
            MigrationCloneTable { name: "child".into(), serial_columns: vec![] },
            MigrationCloneTable { name: "parent".into(), serial_columns: vec![] },
        ];
        let statements = clone_statements(Engine::Mysql, "source", "scratch", &tables, &[clone_fk("fk", "child", "parent")]);
        assert_eq!(statements.len(), 3);
        assert!(statements[0].contains("CREATE TABLE `scratch`.`child` LIKE `source`.`child`"));
        assert!(statements[1].contains("CREATE TABLE `scratch`.`parent` LIKE `source`.`parent`"));
        assert!(statements[2].contains("ADD CONSTRAINT `fk` FOREIGN KEY (`a`, `b`) REFERENCES `scratch`.`parent` (`x`, `y`) ON DELETE CASCADE ON UPDATE SET NULL"));
    }

    #[test]
    fn postgres_clone_preserves_constraint_options_and_independent_serial_sequences() {
        let tables = vec![MigrationCloneTable { name: "parent".into(), serial_columns: vec!["id".into()] }];
        let statements = clone_statements(Engine::Postgres, "source", "scratch", &tables, &[clone_fk("fk", "child", "parent")]);
        let fk = statements.last().unwrap();
        assert!(fk.contains("MATCH FULL"));
        assert!(fk.contains("NOT VALID"));
        assert!(fk.contains("DEFERRABLE INITIALLY DEFERRED"));
        assert!(statements.iter().any(|sql| sql.starts_with("CREATE SEQUENCE \"scratch\".\"txui_seq_")));
        assert!(statements.iter().any(|sql| sql.contains("SET DEFAULT nextval(")));
        assert!(!statements.iter().any(|sql| sql.contains("nextval('source")));
        assert!(statements.iter().position(|sql| sql.contains("ADD CONSTRAINT")).unwrap() > 1);
    }

    #[test]
    fn rehearsal_guard_requires_non_prod_writable_sql_sessions() {
        let mut guard = SessionGuard {
            read_only: false, engine: Engine::Mysql, environment: Some("dev".into()),
            log_dir: None, prod_allow_ddl: true, prod_allow_unfiltered_write: false,
            autocommit: true, query_timeout_secs: None, db_filter: vec![], degraded: None,
        };
        assert!(scratch_guard(&guard).is_ok());
        guard.read_only = true;
        assert_eq!(scratch_guard(&guard).unwrap_err().code, crate::apperror::ErrorCode::GuardRefused);
        guard.read_only = false;
        guard.environment = Some("prod".into());
        assert_eq!(scratch_guard(&guard).unwrap_err().code, crate::apperror::ErrorCode::GuardRefused);
        guard.environment = Some("dev".into());
        guard.engine = Engine::SqlServer;
        assert_eq!(scratch_guard(&guard).unwrap_err().code, crate::apperror::ErrorCode::Unsupported);
    }

    #[tokio::test]
    async fn scratch_registry_retains_active_and_cleanup_failed_records_only() {
        let (state, id) = state_with(Engine::Mysql, "dev", false, true).await;
        insert_scratch(&state, &id.to_string(), id, Engine::Mysql, "txui_mig_test").await.unwrap();
        scratch_status(&state, &id.to_string(), "active", None).await.unwrap();
        let active = scratch_record(&state, &id.to_string()).await.unwrap();
        assert_eq!(active.status, "active");
        assert_eq!(active.name, "txui_mig_test");
        scratch_status(&state, &id.to_string(), "cleanup_failed", Some("left behind")).await.unwrap();
        let failed = scratch_record(&state, &id.to_string()).await.unwrap();
        assert_eq!(failed.error.as_deref(), Some("left behind"));
        scratch_status(&state, &id.to_string(), "dropped", None).await.unwrap();
        assert_eq!(scratch_record(&state, &id.to_string()).await.unwrap().status, "dropped");
    }

    async fn mysql_live_state(pool: sqlx::MySqlPool) -> (AppState, Uuid) {
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, std::env::temp_dir(), HashMap::new());
        let id = Uuid::new_v4();
        state.sessions.write().await.insert(id, std::sync::Arc::new(crate::db::types::LiveSession::Mysql(pool)));
        let config = crate::db::types::ConnectionConfig::new(Engine::Mysql, "migration-scratch-live");
        state.session_meta.write().await.insert(id, SessionGuard::from_config(&config));
        state.session_starts.write().await.insert(id, crate::commands::audit::session_start(&config));
        (state, id)
    }

    async fn postgres_live_state(pool: sqlx::PgPool) -> (AppState, Uuid) {
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, std::env::temp_dir(), HashMap::new());
        let id = Uuid::new_v4();
        state.sessions.write().await.insert(id, std::sync::Arc::new(crate::db::types::LiveSession::Postgres(pool)));
        let config = crate::db::types::ConnectionConfig::new(Engine::Postgres, "migration-scratch-live");
        state.session_meta.write().await.insert(id, SessionGuard::from_config(&config));
        state.session_starts.write().await.insert(id, crate::commands::audit::session_start(&config));
        (state, id)
    }

    fn live_scratch_name(label: &str) -> String {
        format!("txui_mig_{label}_{}", &Uuid::new_v4().simple().to_string()[..8])
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
    async fn dbctl_mysql_scratch_lifecycle() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(4).connect(&url).await.unwrap();
        let (state, session_id) = mysql_live_state(pool.clone()).await;

        let collision = live_scratch_name("collision");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Mysql, &collision)).into_sql_str())
            .execute(&pool).await.unwrap();
        let (_tx, mut rx) = tokio::sync::oneshot::channel();
        let error = create_scratch_named(&state, session_id, &Uuid::new_v4().to_string(), &collision, &mut rx)
            .await.expect_err("collision");
        assert_eq!(error.code, crate::apperror::ErrorCode::Constraint);
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Mysql, &collision)).into_sql_str())
            .execute(&pool).await.unwrap();

        let cancelled = live_scratch_name("cancelled");
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        tx.send(()).unwrap();
        let error = create_scratch_named(&state, session_id, &Uuid::new_v4().to_string(), &cancelled, &mut rx)
            .await.expect_err("pre-cancelled");
        assert_eq!(error.code, crate::apperror::ErrorCode::Cancelled);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ?")
            .bind(&cancelled).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);

        let active = live_scratch_name("active");
        let run_key = Uuid::new_v4().to_string();
        let (_tx, mut rx) = tokio::sync::oneshot::channel();
        let record = create_scratch_named(&state, session_id, &run_key, &active, &mut rx).await.unwrap();
        assert_eq!(record.status, "active");
        let cleaned = cleanup_scratch(&state, &run_key).await.unwrap();
        assert_eq!(cleaned.status, "dropped");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ?")
            .bind(&active).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);

        let leftover = live_scratch_name("leftover");
        let run_key = Uuid::new_v4().to_string();
        let (_tx, mut rx) = tokio::sync::oneshot::channel();
        create_scratch_named(&state, session_id, &run_key, &leftover, &mut rx).await.unwrap();
        pool.close().await;
        let error = cleanup_scratch(&state, &run_key).await.expect_err("closed pool");
        assert!(error.to_string().contains(&leftover), "cleanup error must name the leftover: {error}");
        assert_eq!(scratch_record(&state, &run_key).await.unwrap().status, "cleanup_failed");
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18"]
    async fn dbctl_postgres_scratch_lifecycle() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(4).connect(&url).await.unwrap();
        let (state, session_id) = postgres_live_state(pool.clone()).await;
        let active = live_scratch_name("pg_active");
        let run_key = Uuid::new_v4().to_string();
        let (_tx, mut rx) = tokio::sync::oneshot::channel();
        let record = create_scratch_named(&state, session_id, &run_key, &active, &mut rx).await.unwrap();
        assert_eq!(record.status, "active");
        assert_eq!(cleanup_scratch(&state, &run_key).await.unwrap().status, "dropped");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = $1")
            .bind(&active).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);

        let cancelled = live_scratch_name("pg_cancelled");
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        tx.send(()).unwrap();
        let error = create_scratch_named(&state, session_id, &Uuid::new_v4().to_string(), &cancelled, &mut rx)
            .await.expect_err("pre-cancelled");
        assert_eq!(error.code, crate::apperror::ErrorCode::Cancelled);
        pool.close().await;
    }

    fn single_fk(name: &str, table: &str, column: &str, ref_table: &str, ref_column: &str) -> MigrationCloneForeignKey {
        MigrationCloneForeignKey {
            name: name.into(), table: table.into(), columns: vec![column.into()],
            ref_table: ref_table.into(), ref_columns: vec![ref_column.into()],
            on_delete: "CASCADE".into(), on_update: "SET NULL".into(),
            validated: Some(false), match_type: Some("full".into()),
            deferrable: Some(true), deferred: Some(true),
        }
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
    async fn dbctl_mysql_clone_roundtrip() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(4).connect(&url).await.unwrap();
        let (state, session_id) = mysql_live_state(pool.clone()).await;
        let source = live_scratch_name("source");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Mysql, &source)).into_sql_str()).execute(&pool).await.unwrap();
        for sql in [
            "CREATE TABLE parents (id INT UNSIGNED NOT NULL, seq INT UNSIGNED NOT NULL, code VARCHAR(20) NOT NULL, note VARCHAR(40) DEFAULT 'hello', computed VARCHAR(21) GENERATED ALWAYS AS (CONCAT(code,'!')) STORED, PRIMARY KEY(id,seq), UNIQUE KEY uq_code(code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
            "CREATE TABLE children (id INT UNSIGNED PRIMARY KEY, parent_id INT UNSIGNED, parent_seq INT UNSIGNED, self_parent INT UNSIGNED, note VARCHAR(20) DEFAULT 'child', CONSTRAINT fk_composite FOREIGN KEY(parent_id,parent_seq) REFERENCES parents(id,seq) ON DELETE CASCADE ON UPDATE SET NULL, CONSTRAINT fk_self FOREIGN KEY(self_parent) REFERENCES children(id))",
            "CREATE TABLE cyc_a (id INT PRIMARY KEY, b_id INT)",
            "CREATE TABLE cyc_b (id INT PRIMARY KEY, a_id INT)",
            "ALTER TABLE cyc_a ADD CONSTRAINT fk_a_b FOREIGN KEY(b_id) REFERENCES cyc_b(id)",
            "ALTER TABLE cyc_b ADD CONSTRAINT fk_b_a FOREIGN KEY(a_id) REFERENCES cyc_a(id)",
        ] {
            let qualified = if sql.starts_with("CREATE TABLE ") {
                sql.replacen("CREATE TABLE ", &format!("CREATE TABLE `{}`.", source), 1)
            } else {
                sql.replacen("ALTER TABLE ", &format!("ALTER TABLE `{}`.", source), 1)
            };
            sqlx::raw_sql(AssertSqlSafe(qualified).into_sql_str()).execute(&pool).await.unwrap();
        }
        let scratch = live_scratch_name("clone");
        let run_key = Uuid::new_v4().to_string();
        let (_tx, mut rx) = tokio::sync::oneshot::channel();
        create_scratch_named(&state, session_id, &run_key, &scratch, &mut rx).await.unwrap();
        let tables: Vec<MigrationCloneTable> = ["parents", "children", "cyc_a", "cyc_b"].into_iter().map(|name| MigrationCloneTable {
            name: name.into(), serial_columns: vec![],
        }).collect();
        let fks = vec![
            MigrationCloneForeignKey {
                name: "fk_composite".into(), table: "children".into(), columns: vec!["parent_id".into(), "parent_seq".into()],
                ref_table: "parents".into(), ref_columns: vec!["id".into(), "seq".into()],
                on_delete: "CASCADE".into(), on_update: "SET NULL".into(),
                validated: None, match_type: None, deferrable: None, deferred: None,
            },
            single_fk("fk_self", "children", "self_parent", "children", "id"),
            single_fk("fk_a_b", "cyc_a", "b_id", "cyc_b", "id"),
            single_fk("fk_b_a", "cyc_b", "a_id", "cyc_a", "id"),
        ];
        let result = clone_scratch(
            run_key.clone(), session_id, source.clone(),
            tables.iter().map(|table| table.name.clone()).collect::<Vec<_>>(),
            tables, fks, &state,
        ).await.unwrap();
        assert_eq!(result.tables_cloned, 4);
        assert_eq!(result.foreign_keys_added, 4);
        assert_eq!(result.statements_executed, result.total_statements);
        let generated: String = sqlx::query_scalar(
            "SELECT generation_expression FROM information_schema.columns WHERE table_schema = ? AND table_name = 'parents' AND column_name = 'computed'",
        ).bind(&scratch).fetch_one(&pool).await.unwrap();
        assert!(generated.contains("code"), "generated expression changed: {generated}");
        let default: String = sqlx::query_scalar(
            "SELECT column_default FROM information_schema.columns WHERE table_schema = ? AND table_name = 'parents' AND column_name = 'note'",
        ).bind(&scratch).fetch_one(&pool).await.unwrap();
        assert_eq!(default.trim_matches('\''), "hello");
        let fks: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT constraint_name) FROM information_schema.key_column_usage WHERE table_schema = ? AND referenced_table_name IS NOT NULL",
        ).bind(&scratch).fetch_one(&pool).await.unwrap();
        assert_eq!(fks, 4);
        cleanup_scratch(&state, &run_key).await.unwrap();
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Mysql, &source)).into_sql_str()).execute(&pool).await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18"]
    async fn dbctl_postgres_clone_roundtrip() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(4).connect(&url).await.unwrap();
        let (state, session_id) = postgres_live_state(pool.clone()).await;
        let source = live_scratch_name("source");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Postgres, &source)).into_sql_str()).execute(&pool).await.unwrap();
        for sql in [
            "CREATE TABLE parents (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, seq INT NOT NULL, code TEXT NOT NULL, note TEXT DEFAULT 'hello', computed TEXT GENERATED ALWAYS AS (code || '!') STORED, UNIQUE(code), UNIQUE(id,seq))",
            "CREATE TABLE children (id INT PRIMARY KEY, parent_id INT, parent_seq INT, self_parent INT, note TEXT DEFAULT 'child', CONSTRAINT fk_composite FOREIGN KEY(parent_id,parent_seq) REFERENCES parents(id,seq) ON DELETE CASCADE ON UPDATE SET NULL, CONSTRAINT fk_self FOREIGN KEY(self_parent) REFERENCES children(id) MATCH FULL DEFERRABLE INITIALLY DEFERRED NOT VALID)",
            "CREATE TABLE serial_items (id serial PRIMARY KEY, note text DEFAULT 'serial')",
            "CREATE TABLE cyc_a (id INT PRIMARY KEY, b_id INT)",
            "CREATE TABLE cyc_b (id INT PRIMARY KEY, a_id INT)",
            "ALTER TABLE cyc_a ADD CONSTRAINT fk_a_b FOREIGN KEY(b_id) REFERENCES cyc_b(id)",
            "ALTER TABLE cyc_b ADD CONSTRAINT fk_b_a FOREIGN KEY(a_id) REFERENCES cyc_a(id)",
        ] {
            let qualified = if sql.starts_with("CREATE TABLE ") {
                sql.replacen("CREATE TABLE ", &format!("CREATE TABLE \"{}\".", source), 1)
            } else {
                sql.replacen("ALTER TABLE ", &format!("ALTER TABLE \"{}\".", source), 1)
            }
                .replace("REFERENCES parents", &format!("REFERENCES \"{}\".parents", source))
                .replace("REFERENCES children", &format!("REFERENCES \"{}\".children", source))
                .replace("REFERENCES cyc_a", &format!("REFERENCES \"{}\".cyc_a", source))
                .replace("REFERENCES cyc_b", &format!("REFERENCES \"{}\".cyc_b", source));
            sqlx::raw_sql(AssertSqlSafe(qualified).into_sql_str()).execute(&pool).await.unwrap();
        }
        let scratch = live_scratch_name("clone");
        let run_key = Uuid::new_v4().to_string();
        let (_tx, mut rx) = tokio::sync::oneshot::channel();
        create_scratch_named(&state, session_id, &run_key, &scratch, &mut rx).await.unwrap();
        let tables = vec![
            MigrationCloneTable { name: "parents".into(), serial_columns: vec![] },
            MigrationCloneTable { name: "children".into(), serial_columns: vec![] },
            MigrationCloneTable { name: "serial_items".into(), serial_columns: vec!["id".into()] },
            MigrationCloneTable { name: "cyc_a".into(), serial_columns: vec![] },
            MigrationCloneTable { name: "cyc_b".into(), serial_columns: vec![] },
        ];
        let fks = vec![
            MigrationCloneForeignKey {
                name: "fk_composite".into(), table: "children".into(), columns: vec!["parent_id".into(), "parent_seq".into()],
                ref_table: "parents".into(), ref_columns: vec!["id".into(), "seq".into()],
                on_delete: "CASCADE".into(), on_update: "SET NULL".into(),
                validated: Some(true), match_type: Some("simple".into()), deferrable: Some(false), deferred: Some(false),
            },
            single_fk("fk_self", "children", "self_parent", "children", "id"),
            single_fk("fk_a_b", "cyc_a", "b_id", "cyc_b", "id"),
            single_fk("fk_b_a", "cyc_b", "a_id", "cyc_a", "id"),
        ];
        let result = clone_scratch(
            run_key.clone(), session_id, source.clone(),
            tables.iter().map(|table| table.name.clone()).collect::<Vec<_>>(),
            tables, fks, &state,
        ).await.unwrap();
        assert_eq!(result.tables_cloned, 5);
        assert_eq!(result.foreign_keys_added, 4);
        assert_eq!(result.serial_sequences, 1);
        let default: String = sqlx::query_scalar(
            "SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'serial_items' AND d.adnum = 1",
        ).bind(&scratch).fetch_one(&pool).await.unwrap();
        assert!(default.contains(&scratch), "serial still references source: {default}");
        assert!(!default.contains(&source));
        let constraint: String = sqlx::query_scalar(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'fk_self' AND conrelid = $1::regclass",
        ).bind(format!("{scratch}.children")).fetch_one(&pool).await.unwrap();
        assert!(constraint.contains("MATCH FULL"));
        assert!(constraint.contains("NOT VALID"));
        assert!(constraint.contains("DEFERRABLE INITIALLY DEFERRED"));
        cleanup_scratch(&state, &run_key).await.unwrap();
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Postgres, &source)).into_sql_str()).execute(&pool).await.unwrap();
        pool.close().await;
    }

    async fn active_execution_scratch(
        state: &AppState,
        session_id: Uuid,
        engine: Engine,
        name: &str,
    ) -> String {
        let run_key = Uuid::new_v4().to_string();
        let (_tx, mut rx) = tokio::sync::oneshot::channel();
        create_scratch_named(state, session_id, &run_key, name, &mut rx).await.unwrap();
        assert_eq!(engine.wire_name(), scratch_record(state, &run_key).await.unwrap().engine);
        run_key
    }

    async fn cancel_once_alter_is_registered(state: &AppState, session_id: Uuid, run_key: &str) {
        let cancel_key = format!("panel-{session_id}-migration-{run_key}");
        let mut registered = false;
        for _ in 0..400 {
            if state.kills.read().await.get(&cancel_key)
                .is_some_and(|handle| handle.fingerprint.to_ascii_uppercase().starts_with("ALTER TABLE")) {
                registered = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(registered, "ALTER never received a backend/fingerprint kill handle");
        let tx = crate::state::take_ext_job(&state.ext_jobs, run_key).await.expect("registered scratch job");
        tx.send(()).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
    async fn dbctl_mysql_execution_success_failure_and_cancel() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(5).connect(&url).await.unwrap();
        let (state, session_id) = mysql_live_state(pool.clone()).await;

        let success_name = live_scratch_name("execute_ok");
        let success_key = active_execution_scratch(&state, session_id, Engine::Mysql, &success_name).await;
        let success_sql = "CREATE TABLE executed_items(id INT PRIMARY KEY); ALTER TABLE executed_items ADD note VARCHAR(40); CREATE INDEX idx_note ON executed_items(note)";
        let success = execute_scratch(
            success_key.clone(), success_sql.into(),
            format!("{:x}", Sha256::digest(success_sql.as_bytes())),
            metadata(&["create-table", "alter-table", "create-index"]), true, true, &state,
        ).await.unwrap();
        assert!(success.ok);
        assert_eq!(success.executed, 3);
        assert_eq!(success.statements.len(), 3);
        assert!(success.backend_id.is_some());
        assert!(success.statements.iter().all(|statement| statement.ok));
        let selected: Option<String> = sqlx::query_scalar("SELECT DATABASE()").fetch_one(&pool).await.unwrap();
        assert_ne!(selected.as_deref(), Some(success_name.as_str()), "USE leaked into the pool");
        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log WHERE run_id = ? AND source = 'migration_rehearsal' AND database = ? AND ok = 1",
        ).bind(format!("migration-rehearsal:{success_key}")).bind(&success_name).fetch_one(&state.history).await.unwrap();
        assert_eq!(audited, 3);
        assert_eq!(scratch_record(&state, &success_key).await.unwrap().status, "executed");
        cleanup_scratch(&state, &success_key).await.unwrap();

        let failure_name = live_scratch_name("execute_fail");
        let failure_key = active_execution_scratch(&state, session_id, Engine::Mysql, &failure_name).await;
        let failure_sql = "CREATE TABLE before_failure(id INT PRIMARY KEY); ALTER TABLE missing_table ADD note TEXT; CREATE TABLE never_created(id INT PRIMARY KEY)";
        let failure = execute_scratch(
            failure_key.clone(), failure_sql.into(),
            format!("{:x}", Sha256::digest(failure_sql.as_bytes())),
            metadata(&["create-table", "alter-table", "create-table"]), true, true, &state,
        ).await.unwrap();
        assert!(!failure.ok && !failure.cancelled && failure.partial);
        assert_eq!(failure.executed, 1);
        assert_eq!(failure.failed, 1);
        assert_eq!(failure.statements.len(), 2, "the third statement must not run");
        assert!(!failure.statements[1].ok);
        assert!(!failure.statements[1].db_code.is_empty());
        let remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_name = 'before_failure'",
        ).bind(&failure_name).fetch_one(&pool).await.unwrap();
        assert_eq!(remaining, 1, "partial object must remain inspectable");
        let never: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_name = 'never_created'",
        ).bind(&failure_name).fetch_one(&pool).await.unwrap();
        assert_eq!(never, 0);
        assert_eq!(scratch_record(&state, &failure_key).await.unwrap().status, "execution_failed");
        let retry = execute_scratch(
            failure_key.clone(), failure_sql.into(),
            format!("{:x}", Sha256::digest(failure_sql.as_bytes())),
            metadata(&["create-table", "alter-table", "create-table"]), true, true, &state,
        ).await.expect_err("single-use retry");
        assert!(retry.message.contains("fresh active scratch"));
        cleanup_scratch(&state, &failure_key).await.unwrap();

        let cancel_name = live_scratch_name("execute_cancel");
        let cancel_key = active_execution_scratch(&state, session_id, Engine::Mysql, &cancel_name).await;
        let blocked_table = format!("{}.{}", mysql_ident(&cancel_name), mysql_ident("blocked_alter"));
        sqlx::query(AssertSqlSafe(format!("CREATE TABLE {blocked_table}(id INT PRIMARY KEY)")).into_sql_str())
            .execute(&pool).await.unwrap();
        let mut blocker = pool.acquire().await.unwrap();
        sqlx::raw_sql(AssertSqlSafe(format!("LOCK TABLES {blocked_table} READ")).into_sql_str())
            .execute(&mut *blocker).await.unwrap();
        let cancel_sql = "ALTER TABLE blocked_alter ADD note VARCHAR(40)";
        let task = tokio::spawn({
            let state = state.clone();
            let run_key = cancel_key.clone();
            async move { execute_scratch(
                run_key, cancel_sql.into(), format!("{:x}", Sha256::digest(cancel_sql.as_bytes())),
                metadata(&["alter-table"]), true, true, &state,
            ).await }
        });
        cancel_once_alter_is_registered(&state, session_id, &cancel_key).await;
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(15), task).await
            .expect("cancel did not finish").expect("execution task").expect("execution result");
        sqlx::raw_sql("UNLOCK TABLES").execute(&mut *blocker).await.unwrap();
        drop(blocker);
        assert!(cancelled.cancelled && !cancelled.ok && cancelled.partial);
        assert_eq!(cancelled.executed, 0);
        assert_eq!(cancelled.statements.len(), 1);
        assert_eq!(cancelled.statements[0].error_code, "cancelled");
        assert_eq!(scratch_record(&state, &cancel_key).await.unwrap().status, "execution_cancelled");
        let selected: Option<String> = sqlx::query_scalar("SELECT DATABASE()").fetch_one(&pool).await.unwrap();
        assert_ne!(selected.as_deref(), Some(cancel_name.as_str()));
        cleanup_scratch(&state, &cancel_key).await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18"]
    async fn dbctl_postgres_execution_success_failure_and_cancel() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(5).connect(&url).await.unwrap();
        let (state, session_id) = postgres_live_state(pool.clone()).await;

        let success_name = live_scratch_name("pg_execute_ok");
        let success_key = active_execution_scratch(&state, session_id, Engine::Postgres, &success_name).await;
        let success_sql = "CREATE TABLE executed_items(id INT PRIMARY KEY); ALTER TABLE executed_items ADD note VARCHAR(40); CREATE INDEX idx_note ON executed_items(note)";
        let success = execute_scratch(
            success_key.clone(), success_sql.into(),
            format!("{:x}", Sha256::digest(success_sql.as_bytes())),
            metadata(&["create-table", "alter-table", "create-index"]), true, true, &state,
        ).await.unwrap();
        assert!(success.ok);
        assert_eq!(success.executed, 3);
        assert_eq!(success.statements.len(), 3);
        assert!(success.backend_id.is_some());
        let selected: String = sqlx::query_scalar("SELECT current_schema()").fetch_one(&pool).await.unwrap();
        assert_ne!(selected, success_name, "search_path leaked into the pool");
        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log WHERE run_id = ? AND source = 'migration_rehearsal' AND database = ? AND ok = 1",
        ).bind(format!("migration-rehearsal:{success_key}")).bind(&success_name).fetch_one(&state.history).await.unwrap();
        assert_eq!(audited, 3);
        cleanup_scratch(&state, &success_key).await.unwrap();

        let failure_name = live_scratch_name("pg_execute_fail");
        let failure_key = active_execution_scratch(&state, session_id, Engine::Postgres, &failure_name).await;
        let failure_sql = "CREATE TABLE before_failure(id INT PRIMARY KEY); ALTER TABLE missing_table ADD note TEXT; CREATE TABLE never_created(id INT PRIMARY KEY)";
        let failure = execute_scratch(
            failure_key.clone(), failure_sql.into(),
            format!("{:x}", Sha256::digest(failure_sql.as_bytes())),
            metadata(&["create-table", "alter-table", "create-table"]), true, true, &state,
        ).await.unwrap();
        assert!(!failure.ok && !failure.cancelled && failure.partial);
        assert_eq!(failure.executed, 1);
        assert_eq!(failure.failed, 1);
        assert_eq!(failure.statements.len(), 2);
        assert_eq!(failure.statements[1].db_code, "42P01");
        let remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'before_failure'",
        ).bind(&failure_name).fetch_one(&pool).await.unwrap();
        assert_eq!(remaining, 1);
        let never: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'never_created'",
        ).bind(&failure_name).fetch_one(&pool).await.unwrap();
        assert_eq!(never, 0);
        assert_eq!(scratch_record(&state, &failure_key).await.unwrap().status, "execution_failed");
        cleanup_scratch(&state, &failure_key).await.unwrap();

        let cancel_name = live_scratch_name("pg_execute_cancel");
        let cancel_key = active_execution_scratch(&state, session_id, Engine::Postgres, &cancel_name).await;
        let blocked_table = format!("{}.{}", pg_ident(&cancel_name), pg_ident("blocked_alter"));
        sqlx::query(AssertSqlSafe(format!("CREATE TABLE {blocked_table}(id INT PRIMARY KEY)")).into_sql_str())
            .execute(&pool).await.unwrap();
        let mut blocker = pool.acquire().await.unwrap();
        sqlx::query("BEGIN").execute(&mut *blocker).await.unwrap();
        sqlx::query(AssertSqlSafe(format!("SELECT * FROM {blocked_table}")).into_sql_str())
            .execute(&mut *blocker).await.unwrap();
        let cancel_sql = "ALTER TABLE blocked_alter ADD note VARCHAR(40)";
        let task = tokio::spawn({
            let state = state.clone();
            let run_key = cancel_key.clone();
            async move { execute_scratch(
                run_key, cancel_sql.into(), format!("{:x}", Sha256::digest(cancel_sql.as_bytes())),
                metadata(&["alter-table"]), true, true, &state,
            ).await }
        });
        cancel_once_alter_is_registered(&state, session_id, &cancel_key).await;
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(15), task).await
            .expect("cancel did not finish").expect("execution task").expect("execution result");
        sqlx::query("ROLLBACK").execute(&mut *blocker).await.unwrap();
        drop(blocker);
        assert!(cancelled.cancelled && !cancelled.ok && cancelled.partial);
        assert_eq!(cancelled.executed, 0);
        assert_eq!(cancelled.statements.len(), 1);
        assert_eq!(cancelled.statements[0].error_code, "cancelled");
        assert_eq!(scratch_record(&state, &cancel_key).await.unwrap().status, "execution_cancelled");
        let selected: String = sqlx::query_scalar("SELECT current_schema()").fetch_one(&pool).await.unwrap();
        assert_ne!(selected, cancel_name);
        cleanup_scratch(&state, &cancel_key).await.unwrap();
        pool.close().await;
    }

    async fn rehearse_for_deployment(
        state: &AppState,
        session_id: Uuid,
        engine: Engine,
        scratch: &str,
        sql: &str,
        kinds: &[&str],
    ) -> String {
        let run_key = active_execution_scratch(state, session_id, engine, scratch).await;
        let outcome = execute_scratch(
            run_key.clone(), sql.into(), format!("{:x}", Sha256::digest(sql.as_bytes())),
            metadata(kinds), true, true, state,
        ).await.unwrap();
        assert!(outcome.ok, "deployment fixture rehearsal failed: {:?}", outcome.error);
        run_key
    }

    async fn cancel_once_deployment_alter_is_registered(state: &AppState, session_id: Uuid, run_key: &str) {
        let cancel_key = format!("panel-{session_id}-migration-deploy-{run_key}");
        let mut registered = false;
        for _ in 0..400 {
            if state.kills.read().await.get(&cancel_key)
                .is_some_and(|handle| handle.fingerprint.to_ascii_uppercase().starts_with("ALTER TABLE")) {
                registered = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(registered, "deployment ALTER never received a backend/fingerprint kill handle");
        let tx = crate::state::take_ext_job(&state.ext_jobs, run_key).await.expect("registered deployment job");
        tx.send(()).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
    async fn dbctl_mysql_deployment_success_failure_and_cancel() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(6).connect(&url).await.unwrap();
        let (state, session_id) = mysql_live_state(pool.clone()).await;
        let connection_id = state.session_starts.read().await.get(&session_id).unwrap().connection_id.to_string();

        let success_sql = "CREATE TABLE deployed_items(id INT PRIMARY KEY); ALTER TABLE deployed_items ADD note VARCHAR(40); CREATE INDEX idx_deployed_note ON deployed_items(note)";
        let success_scratch = live_scratch_name("deploy_rehearse_ok");
        let rehearsal_key = rehearse_for_deployment(
            &state, session_id, Engine::Mysql, &success_scratch, success_sql,
            &["create-table", "alter-table", "create-index"],
        ).await;
        let target = live_scratch_name("deploy_target_ok");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Mysql, &target)).into_sql_str()).execute(&pool).await.unwrap();
        let run_key = Uuid::new_v4().to_string();
        let success = execute_deployment(
            session_id, run_key.clone(), rehearsal_key.clone(), connection_id.clone(), connection_id.clone(),
            target.clone(), success_sql.into(), format!("{:x}", Sha256::digest(success_sql.as_bytes())),
            metadata(&["create-table", "alter-table", "create-index"]), true, true, None, &state,
        ).await.unwrap();
        assert!(success.ok);
        assert_eq!((success.committed, success.unknown, success.failed, success.not_started), (3, 0, 0, 0));
        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log WHERE run_id = ? AND source = 'migration' AND database = ? AND stmt_total = 3 AND ok = 1",
        ).bind(format!("migration:{run_key}")).bind(&target).fetch_one(&state.history).await.unwrap();
        assert_eq!(audited, 3);
        let indexes: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics WHERE table_schema = ? AND table_name = 'deployed_items'",
        ).bind(&target).fetch_one(&pool).await.unwrap();
        assert_eq!(indexes, 2);
        let retry = execute_deployment(
            session_id, run_key, rehearsal_key.clone(), connection_id.clone(), connection_id.clone(),
            target.clone(), success_sql.into(), format!("{:x}", Sha256::digest(success_sql.as_bytes())),
            metadata(&["create-table", "alter-table", "create-index"]), true, true, None, &state,
        ).await.expect_err("single-use deployment");
        assert!(retry.message.contains("already claimed"));
        cleanup_scratch(&state, &rehearsal_key).await.unwrap();
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Mysql, &target)).into_sql_str()).execute(&pool).await.unwrap();

        let failure_sql = "CREATE TABLE before_deploy_failure(id INT PRIMARY KEY); CREATE TABLE deploy_conflict(id INT PRIMARY KEY); CREATE TABLE never_deployed(id INT PRIMARY KEY)";
        let failure_scratch = live_scratch_name("deploy_rehearse_fail");
        let failure_rehearsal = rehearse_for_deployment(
            &state, session_id, Engine::Mysql, &failure_scratch, failure_sql,
            &["create-table", "create-table", "create-table"],
        ).await;
        let failure_target = live_scratch_name("deploy_target_fail");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Mysql, &failure_target)).into_sql_str()).execute(&pool).await.unwrap();
        sqlx::query(AssertSqlSafe(format!("CREATE TABLE {}.deploy_conflict(id INT PRIMARY KEY)", mysql_ident(&failure_target))).into_sql_str())
            .execute(&pool).await.unwrap();
        let failure_key = Uuid::new_v4().to_string();
        let failure = execute_deployment(
            session_id, failure_key.clone(), failure_rehearsal.clone(), connection_id.clone(), connection_id.clone(),
            failure_target.clone(), failure_sql.into(), format!("{:x}", Sha256::digest(failure_sql.as_bytes())),
            metadata(&["create-table", "create-table", "create-table"]), true, true, None, &state,
        ).await.unwrap();
        assert!(!failure.ok && !failure.cancelled && failure.partial);
        assert_eq!((failure.committed, failure.unknown, failure.failed, failure.not_started), (1, 0, 1, 1));
        assert_eq!(failure.statements.len(), 2);
        let committed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_name = 'before_deploy_failure'",
        ).bind(&failure_target).fetch_one(&pool).await.unwrap();
        assert_eq!(committed, 1, "partial deployment must remain visible");
        let never: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_name = 'never_deployed'",
        ).bind(&failure_target).fetch_one(&pool).await.unwrap();
        assert_eq!(never, 0);
        assert_eq!(deployment_record(&state, &failure_key).await.unwrap().unwrap().status, "execution_failed");
        cleanup_scratch(&state, &failure_rehearsal).await.unwrap();
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Mysql, &failure_target)).into_sql_str()).execute(&pool).await.unwrap();

        let cancel_sql = "ALTER TABLE blocked_deploy ALTER COLUMN note SET DEFAULT 'x'";
        let cancel_scratch = live_scratch_name("deploy_rehearse_cancel");
        let cancel_rehearsal = active_execution_scratch(&state, session_id, Engine::Mysql, &cancel_scratch).await;
        sqlx::query(AssertSqlSafe(format!("CREATE TABLE {}.blocked_deploy(id INT PRIMARY KEY, note VARCHAR(40))", mysql_ident(&cancel_scratch))).into_sql_str())
            .execute(&pool).await.unwrap();
        let rehearsed = execute_scratch(
            cancel_rehearsal.clone(), cancel_sql.into(), format!("{:x}", Sha256::digest(cancel_sql.as_bytes())),
            metadata(&["alter-table"]), true, true, &state,
        ).await.unwrap();
        assert!(rehearsed.ok, "cancel fixture rehearsal: {:?}", rehearsed.error);
        let cancel_target = live_scratch_name("deploy_target_cancel");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Mysql, &cancel_target)).into_sql_str()).execute(&pool).await.unwrap();
        let blocked_table = format!("{}.{}", mysql_ident(&cancel_target), mysql_ident("blocked_deploy"));
        sqlx::query(AssertSqlSafe(format!("CREATE TABLE {blocked_table}(id INT PRIMARY KEY, note VARCHAR(40))")).into_sql_str())
            .execute(&pool).await.unwrap();
        let mut blocker = pool.acquire().await.unwrap();
        sqlx::raw_sql(AssertSqlSafe(format!("LOCK TABLES {blocked_table} READ")).into_sql_str()).execute(&mut *blocker).await.unwrap();
        let cancel_key = Uuid::new_v4().to_string();
        let task = tokio::spawn({
            let state = state.clone();
            let run_key = cancel_key.clone();
            let rehearsal = cancel_rehearsal.clone();
            let target = cancel_target.clone();
            let connection = connection_id.clone();
            async move { execute_deployment(
                session_id, run_key, rehearsal, connection.clone(), connection,
                target, cancel_sql.into(), format!("{:x}", Sha256::digest(cancel_sql.as_bytes())),
                metadata(&["alter-table"]), true, true, None, &state,
            ).await }
        });
        cancel_once_deployment_alter_is_registered(&state, session_id, &cancel_key).await;
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(15), task).await
            .expect("deployment cancel did not finish").expect("deployment task").expect("deployment result");
        sqlx::raw_sql("UNLOCK TABLES").execute(&mut *blocker).await.unwrap();
        drop(blocker);
        assert!(cancelled.cancelled && !cancelled.ok && cancelled.partial);
        assert_eq!((cancelled.committed, cancelled.unknown, cancelled.failed, cancelled.not_started), (0, 1, 0, 0));
        assert_eq!(cancelled.statements.len(), 1);
        let cancel_audit: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log WHERE run_id = ? AND source = 'migration' AND error_code = 'cancelled'",
        ).bind(format!("migration:{cancel_key}")).fetch_one(&state.history).await.unwrap();
        assert_eq!(cancel_audit, 1);
        assert!(state.ext_jobs.read().await.is_empty());
        cleanup_scratch(&state, &cancel_rehearsal).await.unwrap();
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Mysql, &cancel_target)).into_sql_str()).execute(&pool).await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18"]
    async fn dbctl_postgres_deployment_success_failure_and_cancel() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(6).connect(&url).await.unwrap();
        let (state, session_id) = postgres_live_state(pool.clone()).await;
        let connection_id = state.session_starts.read().await.get(&session_id).unwrap().connection_id.to_string();

        let success_sql = "CREATE TABLE deployed_items(id INT PRIMARY KEY); ALTER TABLE deployed_items ADD note VARCHAR(40); CREATE INDEX idx_deployed_note ON deployed_items(note)";
        let success_scratch = live_scratch_name("pg_deploy_rehearse_ok");
        let rehearsal_key = rehearse_for_deployment(
            &state, session_id, Engine::Postgres, &success_scratch, success_sql,
            &["create-table", "alter-table", "create-index"],
        ).await;
        let target = live_scratch_name("pg_deploy_target_ok");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Postgres, &target)).into_sql_str()).execute(&pool).await.unwrap();
        let run_key = Uuid::new_v4().to_string();
        let success = execute_deployment(
            session_id, run_key.clone(), rehearsal_key.clone(), connection_id.clone(), connection_id.clone(),
            target.clone(), success_sql.into(), format!("{:x}", Sha256::digest(success_sql.as_bytes())),
            metadata(&["create-table", "alter-table", "create-index"]), true, true, None, &state,
        ).await.unwrap();
        assert!(success.ok);
        assert_eq!((success.committed, success.unknown, success.failed, success.not_started), (3, 0, 0, 0));
        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log WHERE run_id = ? AND source = 'migration' AND database = ? AND stmt_total = 3 AND ok = 1",
        ).bind(format!("migration:{run_key}")).bind(&target).fetch_one(&state.history).await.unwrap();
        assert_eq!(audited, 3);
        let selected: String = sqlx::query_scalar("SELECT current_schema()").fetch_one(&pool).await.unwrap();
        assert_ne!(selected, target, "deployment search_path leaked into the pool");
        cleanup_scratch(&state, &rehearsal_key).await.unwrap();
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Postgres, &target)).into_sql_str()).execute(&pool).await.unwrap();

        let failure_sql = "CREATE TABLE before_deploy_failure(id INT PRIMARY KEY); CREATE TABLE deploy_conflict(id INT PRIMARY KEY); CREATE TABLE never_deployed(id INT PRIMARY KEY)";
        let failure_scratch = live_scratch_name("pg_deploy_rehearse_fail");
        let failure_rehearsal = rehearse_for_deployment(
            &state, session_id, Engine::Postgres, &failure_scratch, failure_sql,
            &["create-table", "create-table", "create-table"],
        ).await;
        let failure_target = live_scratch_name("pg_deploy_target_fail");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Postgres, &failure_target)).into_sql_str()).execute(&pool).await.unwrap();
        sqlx::query(AssertSqlSafe(format!("CREATE TABLE {}.deploy_conflict(id INT PRIMARY KEY)", pg_ident(&failure_target))).into_sql_str())
            .execute(&pool).await.unwrap();
        let failure = execute_deployment(
            session_id, Uuid::new_v4().to_string(), failure_rehearsal.clone(), connection_id.clone(), connection_id.clone(),
            failure_target.clone(), failure_sql.into(), format!("{:x}", Sha256::digest(failure_sql.as_bytes())),
            metadata(&["create-table", "create-table", "create-table"]), true, true, None, &state,
        ).await.unwrap();
        assert!(!failure.ok && !failure.cancelled);
        assert_eq!((failure.committed, failure.unknown, failure.failed, failure.not_started), (1, 0, 1, 1));
        assert_eq!(failure.statements.len(), 2);
        assert_eq!(failure.statements[1].db_code, "42P07");
        cleanup_scratch(&state, &failure_rehearsal).await.unwrap();
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Postgres, &failure_target)).into_sql_str()).execute(&pool).await.unwrap();

        let cancel_sql = "ALTER TABLE blocked_deploy ADD note VARCHAR(40)";
        let cancel_scratch = live_scratch_name("pg_deploy_rehearse_cancel");
        let cancel_rehearsal = active_execution_scratch(&state, session_id, Engine::Postgres, &cancel_scratch).await;
        sqlx::query(AssertSqlSafe(format!("CREATE TABLE {}.blocked_deploy(id INT PRIMARY KEY)", pg_ident(&cancel_scratch))).into_sql_str())
            .execute(&pool).await.unwrap();
        let rehearsed = execute_scratch(
            cancel_rehearsal.clone(), cancel_sql.into(), format!("{:x}", Sha256::digest(cancel_sql.as_bytes())),
            metadata(&["alter-table"]), true, true, &state,
        ).await.unwrap();
        assert!(rehearsed.ok);
        let cancel_target = live_scratch_name("pg_deploy_target_cancel");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Postgres, &cancel_target)).into_sql_str()).execute(&pool).await.unwrap();
        let blocked_table = format!("{}.{}", pg_ident(&cancel_target), pg_ident("blocked_deploy"));
        sqlx::query(AssertSqlSafe(format!("CREATE TABLE {blocked_table}(id INT PRIMARY KEY)")).into_sql_str())
            .execute(&pool).await.unwrap();
        let mut blocker = pool.acquire().await.unwrap();
        sqlx::query("BEGIN").execute(&mut *blocker).await.unwrap();
        sqlx::query(AssertSqlSafe(format!("SELECT * FROM {blocked_table}")).into_sql_str()).execute(&mut *blocker).await.unwrap();
        let cancel_key = Uuid::new_v4().to_string();
        let task = tokio::spawn({
            let state = state.clone();
            let run_key = cancel_key.clone();
            let rehearsal = cancel_rehearsal.clone();
            let target = cancel_target.clone();
            let connection = connection_id.clone();
            async move { execute_deployment(
                session_id, run_key, rehearsal, connection.clone(), connection,
                target, cancel_sql.into(), format!("{:x}", Sha256::digest(cancel_sql.as_bytes())),
                metadata(&["alter-table"]), true, true, None, &state,
            ).await }
        });
        cancel_once_deployment_alter_is_registered(&state, session_id, &cancel_key).await;
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(15), task).await
            .expect("deployment cancel did not finish").expect("deployment task").expect("deployment result");
        sqlx::query("ROLLBACK").execute(&mut *blocker).await.unwrap();
        drop(blocker);
        assert!(cancelled.cancelled && !cancelled.ok && cancelled.partial);
        assert_eq!((cancelled.committed, cancelled.unknown, cancelled.failed, cancelled.not_started), (0, 1, 0, 0));
        let selected: String = sqlx::query_scalar("SELECT current_schema()").fetch_one(&pool).await.unwrap();
        assert_ne!(selected, cancel_target);
        cleanup_scratch(&state, &cancel_rehearsal).await.unwrap();
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Postgres, &cancel_target)).into_sql_str()).execute(&pool).await.unwrap();
        pool.close().await;
    }

    type LiveColumns = Vec<(String, String, bool, bool)>;
    type LiveIndexes = Vec<(String, bool, Vec<(i64, String)>)>;
    type LiveFks = Vec<(String, String, String, String, Vec<(i64, String, String)>)>;

    fn live_table_json(
        name: String,
        columns: LiveColumns,
        indexes: LiveIndexes,
        foreign_keys: LiveFks,
    ) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "complete": true,
            "source": "catalog",
            "columns": columns.into_iter().map(|(name, column_type, nullable, has_default)| serde_json::json!({
                "name": name, "type": column_type, "nullable": nullable, "hasDefault": has_default,
            })).collect::<Vec<_>>(),
            "indexes": indexes.into_iter().map(|(name, unique, columns)| {
                let mut columns = columns;
                columns.sort_by_key(|(seq, _)| *seq);
                serde_json::json!({
                    "name": name,
                    "unique": unique,
                    "columns": columns.into_iter().map(|(_, name)| name).collect::<Vec<_>>(),
                })
            }).collect::<Vec<_>>(),
            "foreignKeys": foreign_keys.into_iter().map(|(name, ref_table, on_delete, _on_update, parts)| {
                let mut parts = parts;
                parts.sort_by_key(|(ordinal, _, _)| *ordinal);
                serde_json::json!({
                    "name": name,
                    "columns": parts.iter().map(|(_, column, _)| column).collect::<Vec<_>>(),
                    "refTable": ref_table,
                    "refColumns": parts.into_iter().map(|(_, _, ref_column)| ref_column).collect::<Vec<_>>(),
                    "onDelete": on_delete,
                })
            }).collect::<Vec<_>>(),
            "rows": null,
            "bytes": null,
        })
    }

    async fn mysql_live_tables(pool: &sqlx::MySqlPool, schema: &str) -> Vec<serde_json::Value> {
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
        ).bind(schema).fetch_all(pool).await.unwrap();
        let mut out = Vec::new();
        for name in names {
            let columns = sqlx::query_as::<_, (String, String, String, Option<String>)>(
                "SELECT column_name, column_type, is_nullable, column_default FROM information_schema.columns \
                 WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
            ).bind(schema).bind(&name).fetch_all(pool).await.unwrap().into_iter()
                .map(|(name, kind, nullable, default)| (name, kind, nullable == "YES", default.is_some_and(|value| value.to_uppercase() != "NULL"))).collect();
            let index_rows = sqlx::query_as::<_, (String, i64, u64, String)>(
                "SELECT index_name, non_unique, seq_in_index, column_name FROM information_schema.statistics \
                 WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index",
            ).bind(schema).bind(&name).fetch_all(pool).await.unwrap();
            let mut indexes: std::collections::BTreeMap<String, (bool, Vec<(i64, String)>)> = Default::default();
            for (index, non_unique, seq, column) in index_rows {
                indexes.entry(index).or_insert_with(|| (non_unique == 0, Vec::new())).1.push((i64::try_from(seq).unwrap(), column));
            }
            let fk_rows = sqlx::query_as::<_, (String, String, String, String, String, i64, String, String)>(
                "SELECT k.constraint_name, k.column_name, k.referenced_table_name, k.referenced_column_name, \
                        k.table_name, CAST(k.ordinal_position AS SIGNED), r.delete_rule, r.update_rule \
                 FROM information_schema.key_column_usage k \
                 JOIN information_schema.referential_constraints r \
                   ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name \
                 WHERE k.table_schema = ? AND k.table_name = ? AND k.referenced_table_name IS NOT NULL \
                 ORDER BY k.constraint_name, k.ordinal_position",
            ).bind(schema).bind(&name).fetch_all(pool).await.unwrap();
            let mut fks: std::collections::BTreeMap<(String, String, String, String), Vec<(i64, String, String)>> = Default::default();
            for (fk, column, ref_table, ref_column, _table, ordinal, on_delete, on_update) in fk_rows {
                fks.entry((fk, ref_table, on_delete, on_update)).or_default().push((i64::try_from(ordinal).unwrap(), column, ref_column));
            }
            out.push(live_table_json(
                name,
                columns,
                indexes.into_iter().map(|(name, (unique, columns))| (name, unique, columns)).collect(),
                fks.into_iter().map(|((name, ref_table, on_delete, on_update), parts)| (name, ref_table, on_delete, on_update, parts)).collect(),
            ));
        }
        out
    }

    async fn postgres_live_tables(pool: &sqlx::PgPool, schema: &str) -> Vec<serde_json::Value> {
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname",
        ).bind(schema).fetch_all(pool).await.unwrap();
        let mut out = Vec::new();
        for name in names {
            let columns = sqlx::query_as::<_, (String, String, String, Option<String>)>(
                "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), \
                        CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, pg_get_expr(d.adbin, d.adrelid) \
                 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
            ).bind(schema).bind(&name).fetch_all(pool).await.unwrap().into_iter()
                .map(|(name, kind, nullable, default)| (name, kind, nullable == "YES", default.is_some_and(|value| value.to_uppercase() != "NULL"))).collect();
            let index_rows = sqlx::query_as::<_, (String, i32, i64, String)>(
                "SELECT CASE WHEN ix.indisprimary THEN 'PRIMARY' ELSE ci.relname END, \
                        CASE WHEN ix.indisunique THEN 0 ELSE 1 END, u.ord, a.attname \
                 FROM pg_index ix JOIN pg_class ci ON ci.oid = ix.indexrelid \
                 JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace \
                 CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS u(attnum, ord) \
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum \
                 WHERE n.nspname = $1 AND t.relname = $2 ORDER BY 1, u.ord",
            ).bind(schema).bind(&name).fetch_all(pool).await.unwrap();
            let mut indexes: std::collections::BTreeMap<String, (bool, Vec<(i64, String)>)> = Default::default();
            for (index, non_unique, seq, column) in index_rows {
                indexes.entry(index).or_insert_with(|| (non_unique == 0, Vec::new())).1.push((seq, column));
            }
            let fk_rows = sqlx::query_as::<_, (String, String, String, String, String, i64, String, String)>(
                "SELECT con.conname, sa.attname, tgt.relname, ta.attname, src.relname, u.ord, \
                        CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' \
                          WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END, \
                        CASE con.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' \
                          WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END \
                 FROM pg_constraint con JOIN pg_class src ON src.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = src.relnamespace JOIN pg_class tgt ON tgt.oid = con.confrelid \
                 CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(satt, tatt, ord) \
                 JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = u.satt \
                 JOIN pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = u.tatt \
                 WHERE con.contype = 'f' AND n.nspname = $1 AND src.relname = $2 \
                 ORDER BY con.conname, u.ord",
            ).bind(schema).bind(&name).fetch_all(pool).await.unwrap();
            let mut fks: std::collections::BTreeMap<(String, String, String, String), Vec<(i64, String, String)>> = Default::default();
            for (fk, column, ref_table, ref_column, _table, ordinal, on_delete, on_update) in fk_rows {
                fks.entry((fk, ref_table, on_delete, on_update)).or_default().push((i64::try_from(ordinal).unwrap(), column, ref_column));
            }
            out.push(live_table_json(
                name,
                columns,
                indexes.into_iter().map(|(name, (unique, columns))| (name, unique, columns)).collect(),
                fks.into_iter().map(|((name, ref_table, on_delete, on_update), parts)| (name, ref_table, on_delete, on_update, parts)).collect(),
            ));
        }
        out
    }

    async fn assert_live_final_proof(
        engine: Engine,
        run_key: &str,
        scratch: &str,
        sql: &str,
        actual_tables: Vec<serde_json::Value>,
    ) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut child = tokio::process::Command::new("node")
            .arg(root.join("dev/migration_final_proof.mjs"))
            .current_dir(root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn().unwrap();
        let input = serde_json::json!({
            "engine": engine.wire_name(), "runKey": run_key, "scratch": scratch,
            "sql": sql, "actualTables": actual_tables,
        });
        tokio::io::AsyncWriteExt::write_all(child.stdin.as_mut().unwrap(), input.to_string().as_bytes()).await.unwrap();
        drop(child.stdin.take());
        let output = child.wait_with_output().await.unwrap();
        assert!(output.status.success(), "final proof failed: {}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        let evidence: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(evidence["tables"], 2);
        assert_eq!(evidence["plantedVariantsBlocked"], 4);
        assert_eq!(evidence["phase"], "ready");
    }

    const LIVE_PROOF_SQL: &str = "CREATE TABLE parents(id INT PRIMARY KEY); CREATE TABLE children(id INT PRIMARY KEY, parent_id INT, note VARCHAR(40), CONSTRAINT fk_parent FOREIGN KEY(parent_id) REFERENCES parents(id)); CREATE INDEX idx_note ON children(note)";

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8 and node"]
    async fn dbctl_mysql_final_object_proof() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(4).connect(&url).await.unwrap();
        let (state, session_id) = mysql_live_state(pool.clone()).await;
        let scratch = live_scratch_name("final_proof");
        let run_key = active_execution_scratch(&state, session_id, Engine::Mysql, &scratch).await;
        let result = execute_scratch(
            run_key.clone(), LIVE_PROOF_SQL.into(), format!("{:x}", Sha256::digest(LIVE_PROOF_SQL.as_bytes())),
            metadata(&["create-table", "create-table", "create-index"]), true, true, &state,
        ).await.unwrap();
        assert!(result.ok);
        assert_live_final_proof(
            Engine::Mysql, &run_key, &scratch, LIVE_PROOF_SQL, mysql_live_tables(&pool, &scratch).await,
        ).await;
        cleanup_scratch(&state, &run_key).await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18 and node"]
    async fn dbctl_postgres_final_object_proof() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(4).connect(&url).await.unwrap();
        let (state, session_id) = postgres_live_state(pool.clone()).await;
        let scratch = live_scratch_name("pg_final_proof");
        let run_key = active_execution_scratch(&state, session_id, Engine::Postgres, &scratch).await;
        let result = execute_scratch(
            run_key.clone(), LIVE_PROOF_SQL.into(), format!("{:x}", Sha256::digest(LIVE_PROOF_SQL.as_bytes())),
            metadata(&["create-table", "create-table", "create-index"]), true, true, &state,
        ).await.unwrap();
        assert!(result.ok);
        assert_live_final_proof(
            Engine::Postgres, &run_key, &scratch, LIVE_PROOF_SQL, postgres_live_tables(&pool, &scratch).await,
        ).await;
        cleanup_scratch(&state, &run_key).await.unwrap();
        pool.close().await;
    }

    async fn assert_live_target_proof(
        engine: Engine,
        rehearsal_run_key: &str,
        run_key: &str,
        scratch: &str,
        sql: &str,
        actual_tables: Vec<serde_json::Value>,
        expect_drift: bool,
    ) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut child = tokio::process::Command::new("node")
            .arg(root.join("dev/migration_target_proof.mjs"))
            .current_dir(root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn().unwrap();
        let input = serde_json::json!({
            "engine": engine.wire_name(), "rehearsalRunKey": rehearsal_run_key,
            "runKey": run_key, "scratch": scratch, "sql": sql,
            "actualTables": actual_tables, "expectDrift": expect_drift,
        });
        tokio::io::AsyncWriteExt::write_all(child.stdin.as_mut().unwrap(), input.to_string().as_bytes()).await.unwrap();
        drop(child.stdin.take());
        let output = child.wait_with_output().await.unwrap();
        assert!(output.status.success(), "target proof failed: {}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        let evidence: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        if expect_drift {
            assert_eq!(evidence["driftBlocked"], true);
        } else {
            assert_eq!(evidence["tables"], 2);
            assert_eq!(evidence["outOfScopeTables"], serde_json::json!(["unrelated_target"]));
            assert_eq!(evidence["plantedVariantsBlocked"], 4);
            assert_eq!(evidence["phase"], "done");
        }
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8 and node"]
    async fn dbctl_mysql_deployed_target_verification() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(5).connect(&url).await.unwrap();
        let (state, session_id) = mysql_live_state(pool.clone()).await;
        let connection_id = state.session_starts.read().await.get(&session_id).unwrap().connection_id.to_string();
        let scratch = live_scratch_name("target_proof_rehearsal");
        let rehearsal_key = rehearse_for_deployment(
            &state, session_id, Engine::Mysql, &scratch, LIVE_PROOF_SQL,
            &["create-table", "create-table", "create-index"],
        ).await;
        let target = live_scratch_name("target_proof");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Mysql, &target)).into_sql_str()).execute(&pool).await.unwrap();
        sqlx::query(AssertSqlSafe(format!("CREATE TABLE {}.unrelated_target(id INT PRIMARY KEY)", mysql_ident(&target))).into_sql_str())
            .execute(&pool).await.unwrap();
        let run_key = Uuid::new_v4().to_string();
        let deployed = execute_deployment(
            session_id, run_key.clone(), rehearsal_key.clone(), connection_id.clone(), connection_id,
            target.clone(), LIVE_PROOF_SQL.into(), format!("{:x}", Sha256::digest(LIVE_PROOF_SQL.as_bytes())),
            metadata(&["create-table", "create-table", "create-index"]), true, true, None, &state,
        ).await.unwrap();
        assert!(deployed.ok);
        assert_live_target_proof(
            Engine::Mysql, &rehearsal_key, &run_key, &scratch, LIVE_PROOF_SQL,
            mysql_live_tables(&pool, &target).await, false,
        ).await;
        sqlx::query(AssertSqlSafe(format!("ALTER TABLE {}.children DROP INDEX idx_note", mysql_ident(&target))).into_sql_str())
            .execute(&pool).await.unwrap();
        assert_live_target_proof(
            Engine::Mysql, &rehearsal_key, &run_key, &scratch, LIVE_PROOF_SQL,
            mysql_live_tables(&pool, &target).await, true,
        ).await;
        cleanup_scratch(&state, &rehearsal_key).await.unwrap();
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Mysql, &target)).into_sql_str()).execute(&pool).await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp postgres@18 and node"]
    async fn dbctl_postgres_deployed_target_verification() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(5).connect(&url).await.unwrap();
        let (state, session_id) = postgres_live_state(pool.clone()).await;
        let connection_id = state.session_starts.read().await.get(&session_id).unwrap().connection_id.to_string();
        let scratch = live_scratch_name("pg_target_proof_rehearsal");
        let rehearsal_key = rehearse_for_deployment(
            &state, session_id, Engine::Postgres, &scratch, LIVE_PROOF_SQL,
            &["create-table", "create-table", "create-index"],
        ).await;
        let target = live_scratch_name("pg_target_proof");
        sqlx::query(AssertSqlSafe(scratch_create_sql(Engine::Postgres, &target)).into_sql_str()).execute(&pool).await.unwrap();
        sqlx::query(AssertSqlSafe(format!("CREATE TABLE {}.unrelated_target(id INT PRIMARY KEY)", pg_ident(&target))).into_sql_str())
            .execute(&pool).await.unwrap();
        let run_key = Uuid::new_v4().to_string();
        let deployed = execute_deployment(
            session_id, run_key.clone(), rehearsal_key.clone(), connection_id.clone(), connection_id,
            target.clone(), LIVE_PROOF_SQL.into(), format!("{:x}", Sha256::digest(LIVE_PROOF_SQL.as_bytes())),
            metadata(&["create-table", "create-table", "create-index"]), true, true, None, &state,
        ).await.unwrap();
        assert!(deployed.ok);
        assert_live_target_proof(
            Engine::Postgres, &rehearsal_key, &run_key, &scratch, LIVE_PROOF_SQL,
            postgres_live_tables(&pool, &target).await, false,
        ).await;
        sqlx::query(AssertSqlSafe(format!("DROP INDEX {}.idx_note", pg_ident(&target))).into_sql_str())
            .execute(&pool).await.unwrap();
        assert_live_target_proof(
            Engine::Postgres, &rehearsal_key, &run_key, &scratch, LIVE_PROOF_SQL,
            postgres_live_tables(&pool, &target).await, true,
        ).await;
        cleanup_scratch(&state, &rehearsal_key).await.unwrap();
        sqlx::query(AssertSqlSafe(scratch_drop_sql(Engine::Postgres, &target)).into_sql_str()).execute(&pool).await.unwrap();
        pool.close().await;
    }
}
