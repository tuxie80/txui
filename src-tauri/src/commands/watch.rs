//! Process-progress support and the shared external-job cancellation command.

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::db::types::LiveSession;
use crate::db::connection::get_session_pub;
use crate::state::AppState;

const ENABLE_STAGE_INSTRUMENTS: &str =
    "UPDATE performance_schema.setup_instruments SET ENABLED = 'YES', TIMED = 'YES' \
     WHERE NAME LIKE 'stage/innodb/alter%' OR NAME = 'stage/sql/copy to tmp table'";
const ENABLE_STAGE_CONSUMERS: &str =
    "UPDATE performance_schema.setup_consumers SET ENABLED = 'YES' \
     WHERE NAME LIKE 'events_stages_%'";

#[derive(Debug, Clone, Serialize)]
pub struct EnableStageProgressResult {
    pub instruments_affected: u64,
    pub consumers_affected: u64,
}

/// Explicit, audited-in-the-UI opt-in to MySQL's runtime stage instrumentation.
/// These are server configuration writes, so both go through the normal guard.
#[tauri::command]
pub async fn enable_mysql_stage_progress(
    session_id: Uuid,
    state: State<'_, AppState>,
) -> Result<EnableStageProgressResult, crate::apperror::AppError> {
    state.guard_statement(&session_id, ENABLE_STAGE_INSTRUMENTS).await?;
    state.guard_statement(&session_id, ENABLE_STAGE_CONSUMERS).await?;
    let session = get_session_pub(session_id, &state.sessions).await?;
    let LiveSession::Mysql(pool) = session.as_ref() else {
        return Err("performance_schema stage setup is only available for MySQL".into());
    };

    let instruments = crate::db::mysql::execute(pool, ENABLE_STAGE_INSTRUMENTS).await
        .map_err(|e| crate::apperror::AppError::from(format!(
            "enabling stage instruments failed: {e}")))?;
    let consumers = crate::db::mysql::execute(pool, ENABLE_STAGE_CONSUMERS).await
        .map_err(|e| crate::apperror::AppError::from(format!(
            "stage instruments were enabled, but enabling stage consumers failed: {e}")))?;
    Ok(EnableStageProgressResult {
        instruments_affected: instruments.rows_affected.unwrap_or(0),
        consumers_affected: consumers.rows_affected.unwrap_or(0),
    })
}

/// Cancel an external job registered under a session-scoped run key. Galera
/// tails and PostgreSQL maintenance resolve the key through `take_ext_job`.
#[tauri::command]
pub async fn cancel_watched(run_key: String, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    if let Some(tx) = crate::state::take_ext_job(&state.ext_jobs, &run_key).await {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn stage_setup_is_scoped_to_the_required_rows() {
        assert!(super::ENABLE_STAGE_INSTRUMENTS.contains("stage/innodb/alter%"));
        assert!(super::ENABLE_STAGE_INSTRUMENTS.contains("stage/sql/copy to tmp table"));
        assert!(super::ENABLE_STAGE_CONSUMERS.contains("events_stages_%"));
        assert!(!super::ENABLE_STAGE_INSTRUMENTS.contains("DELETE"));
        assert!(!super::ENABLE_STAGE_CONSUMERS.contains("DELETE"));
    }
}
