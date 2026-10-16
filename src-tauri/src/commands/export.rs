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
        LiveSession::Parquet(src) => {
            let src = src.clone();
            let out = PathBuf::from(out_path);
            // File I/O + decode is blocking; keep it off the async runtime.
            tokio::task::spawn_blocking(move || match src.as_ref() {
                crate::db::parquet::ParquetSource::Single(f) =>
                    crate::db::parquet::export_to_file(f, &out, &format),
                // A dataset streams through its DuckDB view's COPY … TO.
                crate::db::parquet::ParquetSource::Dataset(d) =>
                    crate::db::parquet::export_dataset_to_file(d, &out, &format),
            })
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

/// Binary sibling of write_text_file (xlsx export). The payload arrives
/// base64-encoded: a raw `Vec<u8>` over the JSON bridge is a number array —
/// ~7x memory amplification on a big workbook — where one string decodes
/// straight into the write buffer.
#[tauri::command]
pub async fn write_binary_file(path: PathBuf, contents_base64: String) -> Result<(), crate::apperror::AppError> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(contents_base64)
        .map_err(|e| format!("write_binary_file got invalid base64: {e}"))?;
    tokio::fs::write(&path, bytes)
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

/// One column of the schema for a new, empty Parquet file, as the connection
/// form's *New…* dialog sends it. `data_type` is one of the names in
/// [`resolve_parquet_type`] — the allowlist mirrored by the frontend's
/// `utils/parquetSchema.ts` dropdown; anything else is refused here.
#[derive(serde::Deserialize)]
pub struct ParquetColumnDef {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

/// Map the dialog's type name to an Arrow type. Kept deliberately small —
/// the scalar types a hand-designed file schema actually needs; nested types
/// stay the domain of writers with real data (export).
fn resolve_parquet_type(spec: &str) -> Result<arrow_schema::DataType, String> {
    use arrow_schema::{DataType, TimeUnit};
    match spec {
        "string" => Ok(DataType::Utf8),
        "integer" => Ok(DataType::Int64),
        "float" => Ok(DataType::Float64),
        "boolean" => Ok(DataType::Boolean),
        "date" => Ok(DataType::Date32),
        "timestamp" => Ok(DataType::Timestamp(TimeUnit::Millisecond, None)),
        "binary" => Ok(DataType::Binary),
        _ => {
            let Some(inner) = spec.strip_prefix("decimal(").and_then(|t| t.strip_suffix(')')) else {
                return Err(format!("unknown Parquet column type: {spec}"));
            };
            let (p, s) = inner
                .split_once(',')
                .and_then(|(p, s)| p.trim().parse::<u8>().ok().zip(s.trim().parse::<u8>().ok()))
                .ok_or_else(|| format!("decimal wants decimal(precision,scale), got: {spec}"))?;
            if !(1..=38).contains(&p) {
                return Err(format!("decimal precision must be 1..=38, got {p}"));
            }
            if s > p {
                return Err(format!("decimal scale ({s}) cannot exceed precision ({p})"));
            }
            Ok(DataType::Decimal128(p, s as i8))
        }
    }
}

/// Create a new, empty Parquet file with a chosen schema.
///
/// The schema-designing sibling of `write_parquet_file` (which infers its
/// schema from a result grid). Same rule as `create_sqlite_file`: creating a
/// file is a standalone action, never a side effect of connecting, and an
/// existing path is refused outright. Returns the size of the file written.
#[tauri::command]
pub async fn create_parquet_file(
    path: PathBuf,
    columns: Vec<ParquetColumnDef>,
) -> Result<u64, crate::apperror::AppError> {
    if path.exists() {
        return Err(format!("{} already exists", path.display()).into());
    }
    if columns.is_empty() {
        return Err("a Parquet file needs at least one column".into());
    }
    let mut fields = Vec::with_capacity(columns.len());
    for c in &columns {
        let name = c.name.trim();
        if name.is_empty() {
            return Err("column names cannot be empty".into());
        }
        if name.chars().count() > 128 {
            return Err(format!("column name too long (max 128 chars): {name}").into());
        }
        if name.chars().any(|ch| ch.is_control()) {
            return Err(format!("column name holds a control character: {name:?}").into());
        }
        if fields.iter().any(|(n, _, _): &(String, arrow_schema::DataType, bool)| n == name) {
            return Err(format!("duplicate column name: {name}").into());
        }
        let dt = resolve_parquet_type(&c.data_type)?;
        fields.push((name.to_string(), dt, c.nullable));
    }
    // File I/O + encoding is blocking; keep it off the async runtime.
    tokio::task::spawn_blocking(move || crate::db::parquet::write_empty(&path, &fields))
        .await
        .map_err(|e| crate::apperror::AppError::from(format!("create task failed: {e}")))?
        .map_err(Into::into)
}

#[cfg(test)]
mod create_parquet_tests {
    use super::*;

    fn col(name: &str, data_type: &str) -> ParquetColumnDef {
        ParquetColumnDef { name: name.into(), data_type: data_type.into(), nullable: true }
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-pqc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn the_type_allowlist_maps_and_rejects() {
        use arrow_schema::DataType;
        assert_eq!(resolve_parquet_type("string").unwrap(), DataType::Utf8);
        assert_eq!(resolve_parquet_type("integer").unwrap(), DataType::Int64);
        assert_eq!(resolve_parquet_type("float").unwrap(), DataType::Float64);
        assert_eq!(resolve_parquet_type("boolean").unwrap(), DataType::Boolean);
        assert_eq!(resolve_parquet_type("date").unwrap(), DataType::Date32);
        assert_eq!(resolve_parquet_type("binary").unwrap(), DataType::Binary);
        assert_eq!(resolve_parquet_type("decimal(10,2)").unwrap(), DataType::Decimal128(10, 2));
        assert_eq!(resolve_parquet_type("decimal(38, 38)").unwrap(), DataType::Decimal128(38, 38));
        // Everything outside the allowlist is refused, with a reason.
        assert!(resolve_parquet_type("struct").is_err());
        assert!(resolve_parquet_type("varchar(10)").is_err());
        assert!(resolve_parquet_type("decimal(0,0)").is_err());
        assert!(resolve_parquet_type("decimal(39,0)").is_err());
        assert!(resolve_parquet_type("decimal(5,6)").is_err()); // scale > precision
        assert!(resolve_parquet_type("decimal(x,y)").is_err());
    }

    #[tokio::test]
    async fn creates_a_file_with_the_designed_schema() {
        let path = tmp("designed.parquet");
        let cols = vec![
            col("id", "integer"),
            col("amount", "decimal(10,2)"),
            ParquetColumnDef { name: "flag".into(), data_type: "boolean".into(), nullable: false },
        ];
        let size = create_parquet_file(path.clone(), cols).await.unwrap();
        assert!(size > 0);
        let f = crate::db::parquet::open_path(&path).unwrap();
        assert_eq!(f.num_rows(), 0);
        assert_eq!(f.leaf_names(), ["id", "amount", "flag"]);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn refuses_an_existing_path_and_bad_input() {
        let path = tmp("occupied.parquet");
        std::fs::write(&path, b"already here").unwrap();
        let err = create_parquet_file(path.clone(), vec![col("a", "string")])
            .await.unwrap_err().to_string();
        assert!(err.contains("already exists"), "{err}");
        // …and the file was not touched.
        assert_eq!(std::fs::read(&path).unwrap(), b"already here");
        let _ = std::fs::remove_file(&path);

        let path = tmp("bad.parquet");
        assert!(create_parquet_file(path.clone(), vec![]).await.is_err());
        assert!(create_parquet_file(path.clone(), vec![col("", "string")]).await.is_err());
        assert!(create_parquet_file(path.clone(), vec![col("a", "string"), col("a", "integer")]).await.is_err());
        assert!(create_parquet_file(path.clone(), vec![col(&"x".repeat(200), "string")]).await.is_err());
        assert!(create_parquet_file(path.clone(), vec![col("a\u{0007}b", "string")]).await.is_err());
        assert!(create_parquet_file(path.clone(), vec![col("a", "decimal(2,9)")]).await.is_err());
        assert!(!path.exists(), "a refused create must not leave a file behind");
    }
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
