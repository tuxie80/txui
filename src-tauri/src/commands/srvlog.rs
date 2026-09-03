//! Per-connection server activity log: the frontend ships log lines here and
//! they are appended to `<log_dir>/<sanitized-connection-name>.log` from the
//! connection config. Logging must never break a query — a missing config or
//! log_dir is a silent no-op and I/O failures are warnings, not errors.
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;

/// Append lines to the connection's server activity log.
#[tauri::command]
pub async fn append_server_log(
    connection_id: Uuid,
    lines: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    let Some(config) = state.configs.read().await.get(&connection_id).cloned() else {
        return Ok(());
    };
    let Some(dir) = config.log_dir.filter(|d| !d.trim().is_empty()) else {
        return Ok(());
    };
    if lines.is_empty() {
        return Ok(());
    }

    // Filename-safe connection name: keep alnum, '-', '_', '.'; else '_'.
    let name: String = config.name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect();
    let path = std::path::Path::new(&dir).join(format!("{name}.log"));

    let r: std::io::Result<()> = async {
        use tokio::io::AsyncWriteExt;
        tokio::fs::create_dir_all(&dir).await?;
        let mut f = tokio::fs::OpenOptions::new()
            .create(true).append(true).open(&path).await?;
        for line in &lines {
            f.write_all(line.as_bytes()).await?;
            f.write_all(b"\n").await?;
        }
        Ok(())
    }.await;

    if let Err(e) = r {
        log::warn!("append_server_log: could not write {}: {e}", path.display());
    }
    Ok(())
}
