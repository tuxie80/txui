//! Per-connection server activity log: the frontend ships log lines here and
//! they are appended to `<log_dir>/<sanitized-connection-name>.log` from the
//! connection config. Logging must never break a query — a missing config or
//! log_dir is a silent no-op and I/O failures are warnings, not errors.
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;

const MAX_LOG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LOG_LINE_BYTES: usize = 64 * 1024;

fn bounded_line(line: &str) -> &str {
    if line.len() <= MAX_LOG_LINE_BYTES { return line; }
    let mut end = MAX_LOG_LINE_BYTES;
    while !line.is_char_boundary(end) { end -= 1; }
    &line[..end]
}

fn needs_rotation(size: u64, incoming: u64, max: u64) -> bool {
    size.saturating_add(incoming) > max
}

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
        let mut size = f.metadata().await?.len();
        for line in &lines {
            let text = bounded_line(line);
            let incoming = text.len() as u64 + 1;
            if needs_rotation(size, incoming, MAX_LOG_BYTES) {
                drop(f);
                let backup = path.with_extension("log.1");
                let _ = tokio::fs::remove_file(&backup).await;
                tokio::fs::rename(&path, &backup).await?;
                f = tokio::fs::OpenOptions::new()
                    .create(true).append(true).open(&path).await?;
                size = 0;
            }
            f.write_all(text.as_bytes()).await?;
            f.write_all(b"\n").await?;
            size += incoming;
        }
        Ok(())
    }.await;

    if let Err(e) = r {
        log::warn!("append_server_log: could not write {}: {e}", path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_preserves_the_cap_without_overflow() {
        assert!(!needs_rotation(10, 10, 20));
        assert!(needs_rotation(11, 10, 20));
        assert!(needs_rotation(u64::MAX, 1, 20));
    }

    #[test]
    fn long_lines_are_bounded_on_utf8_boundaries() {
        let ascii = "x".repeat(MAX_LOG_LINE_BYTES + 1);
        assert_eq!(bounded_line(&ascii).len(), MAX_LOG_LINE_BYTES);
        let unicode = "🦆".repeat(MAX_LOG_LINE_BYTES);
        let bounded = bounded_line(&unicode);
        assert!(bounded.len() <= MAX_LOG_LINE_BYTES);
        assert!(std::str::from_utf8(bounded.as_bytes()).is_ok());
        assert_eq!(bounded_line("short"), "short");
    }
}
