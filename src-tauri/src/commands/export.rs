/// Result-set export: the frontend builds the serialized payload (CSV/JSON/…)
/// and asks us to persist it at a path the user picked via the save dialog.
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;
use crate::db::connection::get_session_pub;
use crate::db::types::LiveSession;
use crate::state::AppState;

/// Stream an entire Parquet file to a text file (csv/tsv/json) on the backend,
/// a row group at a time. Unlike the grid export, the rows never all live in
/// memory or cross the IPC boundary, so a file too big to browse can still be
/// exported. Returns the number of rows written.
#[tauri::command]
pub async fn export_parquet_file(
    session_id: Uuid,
    out_path: String,
    format: String,
    state: State<'_, AppState>,
) -> Result<u64, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions).await?;
    match session.as_ref() {
        LiveSession::Parquet(f) => {
            let f = f.clone();
            let out = PathBuf::from(out_path);
            // File I/O + decode is blocking; keep it off the async runtime.
            tokio::task::spawn_blocking(move || crate::db::parquet::export_to_file(&f, &out, &format))
                .await
                .map_err(|e| crate::apperror::AppError::from(format!("export task failed: {e}")))?
                .map_err(Into::into)
        }
        _ => Err("whole-file export is only available for Parquet sessions".into()),
    }
}

#[tauri::command]
pub async fn write_text_file(path: PathBuf, contents: String) -> Result<(), crate::apperror::AppError> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| format!("could not write {}: {e}", path.display()))
        .map_err(crate::apperror::AppError::from)
}

/// Binary sibling of write_text_file (xlsx export). Raw bytes over IPC.
#[tauri::command]
pub async fn write_binary_file(path: PathBuf, contents: Vec<u8>) -> Result<(), crate::apperror::AppError> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| format!("could not write {}: {e}", path.display()))
        .map_err(crate::apperror::AppError::from)
}

/// Read a user-picked text file (e.g. a .sql to analyze). 10 MB cap.
#[tauri::command]
pub async fn read_text_file(path: PathBuf) -> Result<String, crate::apperror::AppError> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("file is larger than 10 MB".into());
    }
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("could not read {}: {e}", path.display()))
        .map_err(crate::apperror::AppError::from)
}

/// One streamed piece of a slow log. `done: true` closes the stream — the
/// frontend must not treat the invoke's resolution as the end, since channel
/// messages are delivered asynchronously.
#[derive(serde::Serialize, Clone)]
pub struct SlowLogChunk {
    pub text: Option<String>,
    pub done: bool,
}

/// Read a slow-query-log file for the analyzer, streamed to the frontend in
/// bounded chunks (each ending on a line boundary) instead of one giant
/// String over IPC — a 128 MB payload held on both sides of the bridge at
/// once was an avoidable memory peak. Files beyond the cap contribute their
/// tail, since the recent entries are what a digest is usually about.
/// Returns the number of bytes streamed.
#[tauri::command]
pub async fn read_slow_log(
    path: PathBuf,
    on_chunk: tauri::ipc::Channel<SlowLogChunk>,
) -> Result<u64, crate::apperror::AppError> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    const CAP: u64 = 128 * 1024 * 1024;
    const CHUNK: usize = 8 * 1024 * 1024;
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    let mut f = tokio::fs::File::open(&path).await
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    // Beyond the cap: read the tail, dropping the partial first line.
    let mut skip_partial_first_line = false;
    if meta.len() > CAP {
        f.seek(std::io::SeekFrom::Start(meta.len() - CAP)).await
            .map_err(|e| format!("seek failed: {e}"))?;
        skip_partial_first_line = true;
        let mb = CAP / (1024 * 1024);
        let _ = on_chunk.send(SlowLogChunk {
            text: Some(format!("-- (file exceeds {mb} MB; showing the last {mb} MB)\n")),
            done: false,
        });
    }
    let mut carry: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    let mut total: u64 = 0;
    loop {
        let n = f.read(&mut buf).await.map_err(|e| format!("read failed: {e}"))?;
        if n == 0 { break; }
        total += n as u64;
        carry.extend_from_slice(&buf[..n]);
        // Ship up to the last newline; the remainder (possibly a split UTF-8
        // sequence — the reason the carry is bytes, not a String) waits for
        // the next read.
        if let Some(pos) = carry.iter().rposition(|&b| b == b'\n') {
            let mut head: Vec<u8> = carry.drain(..=pos).collect();
            if skip_partial_first_line {
                if let Some(first_nl) = head.iter().position(|&b| b == b'\n') {
                    head.drain(..=first_nl);
                }
                skip_partial_first_line = false;
            }
            if !head.is_empty() {
                let _ = on_chunk.send(SlowLogChunk {
                    text: Some(String::from_utf8_lossy(&head).into_owned()),
                    done: false,
                });
            }
        }
    }
    if !carry.is_empty() && !skip_partial_first_line {
        let _ = on_chunk.send(SlowLogChunk {
            text: Some(String::from_utf8_lossy(&carry).into_owned()),
            done: false,
        });
    }
    let _ = on_chunk.send(SlowLogChunk { text: None, done: true });
    Ok(total)
}

/// Create a new, empty SQLite database file.
///
/// Separate command (not a side effect of connecting) so that creating a
/// database is always something the user asked for.
#[tauri::command]
pub async fn create_sqlite_file(path: PathBuf) -> Result<(), crate::apperror::AppError> {
    crate::db::sqlite::create(&path).await.map_err(Into::into)
}

/// Write a result grid to a new Parquet file.
///
/// Parquet is immutable, so this is what "create a Parquet file" means: write
/// it once, completely, from a result set. Works from any engine's results —
/// the schema is inferred from the values, since a grid has no catalog behind
/// it. Returns the size of the file written.
#[tauri::command]
pub async fn write_parquet_file(
    path: PathBuf,
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
) -> Result<u64, crate::apperror::AppError> {
    if path.exists() {
        return Err(format!("{} already exists", path.display()).into());
    }
    // File I/O + encoding is blocking; keep it off the async runtime.
    tokio::task::spawn_blocking(move || crate::db::parquet::write_grid(&path, &columns, &rows))
        .await
        .map_err(|e| crate::apperror::AppError::from(format!("export task failed: {e}")))?
        .map_err(Into::into)
}
