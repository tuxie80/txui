//! Tuner command — thin Tauri wrapper over crate::tuner. All three engines
//! produce the same TunerReport shape.
use tauri::State;
use uuid::Uuid;

use crate::db::connection::get_session_pub;
use crate::db::types::LiveSession;
use crate::state::AppState;
use crate::tuner::TunerReport;

/// Full read-only configuration/security/resilience analysis of the live
/// server behind this session. Read-only sessions are welcome: every probe
/// is SHOW/SELECT, and the returned fix_sql is generated, never executed.
#[tauri::command]
pub async fn tuner_analyze(
    session_id: Uuid,
    state: State<'_, AppState>,
) -> Result<TunerReport, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    match session.as_ref() {
        LiveSession::Mysql(pool) => crate::tuner::analyze(pool, &state.data_dir)
            .await
            .map_err(Into::into),
        LiveSession::Postgres(pool) => crate::tuner::analyze_pg(pool, &state.data_dir)
            .await
            .map_err(Into::into),
        LiveSession::Redis(mgr, _) => crate::tuner::analyze_redis(mgr, &state.data_dir)
            .await
            .map_err(Into::into),
        LiveSession::Clickhouse(session) => crate::tuner::analyze_ch(session, &state.data_dir)
            .await
            .map_err(Into::into),
        // SQLite has no server, but the file itself is tunable: freelist bloat
        // (VACUUM), auto_vacuum mode, page size, journalling and integrity.
        LiveSession::Sqlite(pool) => crate::tuner::analyze_sqlite(pool)
            .await
            .map_err(Into::into),
        // Parquet is immutable — genuinely nothing to tune.
        LiveSession::Parquet(_) => Err(
            "there is nothing to tune on an immutable Parquet file".into()),
        // No tuner rule set for DuckDB yet — its knobs are duckdb_settings(),
        // which the variables view already shows.
        LiveSession::Duckdb(_) => Err(
            "there is no DuckDB tuning analysis yet — see Server variables".into()),
        // No MongoDB rule set in v1; serverStatus is already in the Server panel.
        LiveSession::MongoDb(_) => Err(
            "there is no MongoDB tuning analysis yet — see Server info".into()),
        LiveSession::SqlServer(session) => crate::tuner::analyze_mssql(session, &state.data_dir)
            .await
            .map_err(Into::into),
    }
}
