/// CSV import: preview (delimiter/header/type detection) + streaming,
/// transactional import with live progress. MySQL / PostgreSQL / SQLite.
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::db::connection::get_session_pub;
use crate::db::types::LiveSession;
use crate::state::AppState;

const PREVIEW_ROWS: usize = 100;
const TYPE_SAMPLE_ROWS: usize = 500;
const BATCH_ROWS: usize = 500;

/// Byte cap on one batched INSERT — flushed early when the VALUES buffer
/// reaches it, whatever the row count (WP-11 11.3): 500 wide-text rows can
/// exceed MySQL's max_allowed_packet and abort + roll back the entire import
/// late. Same constant and trade as datagen's STMT_BYTES_CAP.
const STMT_BYTES_CAP: usize = 4 * 1024 * 1024;

// ── Preview ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CsvColumnInfo {
    pub name: String,           // header name or "column_1"
    pub inferred_type: String,  // BIGINT | DOUBLE PRECISION | DATE | TIMESTAMP | BOOLEAN | VARCHAR(255) | TEXT
}

#[derive(Debug, Serialize)]
pub struct CsvPreview {
    pub delimiter: String,
    pub has_header: bool,
    pub columns: Vec<CsvColumnInfo>,
    pub rows: Vec<Vec<String>>,   // first rows AFTER the header (when detected)
    pub file_bytes: u64,
}

fn detect_delimiter(sample: &str) -> u8 {
    let first_line = sample.lines().next().unwrap_or("");
    let candidates = *b",;\t|";
    let mut best = b',';
    let mut best_count = 0usize;
    for &c in &candidates {
        let count = first_line.bytes().filter(|&b| b == c).count();
        if count > best_count {
            best_count = count;
            best = c;
        }
    }
    best
}

fn looks_numeric(s: &str) -> bool {
    !s.is_empty() && s.trim().parse::<f64>().is_ok()
}
fn looks_int(s: &str) -> bool {
    !s.is_empty() && s.trim().parse::<i64>().is_ok()
}
fn looks_date(s: &str) -> bool {
    let t = s.trim();
    t.len() == 10 && t.as_bytes().get(4) == Some(&b'-') && t.as_bytes().get(7) == Some(&b'-')
        && t[0..4].parse::<u16>().is_ok()
}
fn looks_timestamp(s: &str) -> bool {
    let t = s.trim();
    t.len() >= 19 && looks_date(&t[0..10]) && (t.as_bytes()[10] == b' ' || t.as_bytes()[10] == b'T')
}
fn looks_bool(s: &str) -> bool {
    matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "false" | "t" | "f" | "0" | "1" | "yes" | "no")
}

fn infer_type(samples: &[&str]) -> String {
    let non_empty: Vec<&str> = samples.iter().copied().filter(|s| !s.trim().is_empty()).collect();
    if non_empty.is_empty() { return "TEXT".into(); }
    if non_empty.iter().all(|s| looks_int(s)) { return "BIGINT".into(); }
    if non_empty.iter().all(|s| looks_numeric(s)) { return "DOUBLE PRECISION".into(); }
    if non_empty.iter().all(|s| looks_timestamp(s)) { return "TIMESTAMP".into(); }
    if non_empty.iter().all(|s| looks_date(s)) { return "DATE".into(); }
    if non_empty.iter().all(|s| looks_bool(s)) { return "BOOLEAN".into(); }
    let max_len = non_empty.iter().map(|s| s.len()).max().unwrap_or(0);
    if max_len <= 255 { "VARCHAR(255)".into() } else { "TEXT".into() }
}

#[tauri::command]
pub async fn csv_preview(path: String, delimiter: Option<String>) -> Result<CsvPreview, crate::apperror::AppError> {
    tokio::task::spawn_blocking(move || {
        let file_bytes = std::fs::metadata(&path)?.len();
        let head = {
            use std::io::Read;
            let mut f = std::fs::File::open(&path)?;
            let mut buf = vec![0u8; 64 * 1024];
            let n = f.read(&mut buf)?;
            buf.truncate(n);
            String::from_utf8_lossy(&buf).into_owned()
        };
        let delim = delimiter
            .and_then(|d| d.bytes().next())
            .unwrap_or_else(|| detect_delimiter(&head));

        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(delim)
            .has_headers(false)
            .flexible(true)
            .from_path(&path)
            ?;

        let mut records: Vec<Vec<String>> = Vec::new();
        for rec in rdr.records().take(TYPE_SAMPLE_ROWS + 1) {
            let rec = rec?;
            records.push(rec.iter().map(|s| s.to_string()).collect());
        }
        if records.is_empty() { return Err("file is empty".into()); }

        // Header heuristic: no cell of row 0 is numeric/date/empty
        let first = &records[0];
        let has_header = first.iter().all(|c| {
            let t = c.trim();
            !t.is_empty() && !looks_numeric(t) && !looks_date(t)
        });

        let n_cols = records.iter().map(|r| r.len()).max().unwrap_or(0);
        let data_rows: Vec<&Vec<String>> = records.iter().skip(if has_header { 1 } else { 0 }).collect();

        let columns: Vec<CsvColumnInfo> = (0..n_cols).map(|ci| {
            let name = if has_header {
                let raw = first.get(ci).map(|s| s.trim()).unwrap_or("");
                if raw.is_empty() { format!("column_{}", ci + 1) }
                else {
                    // sanitize into an identifier
                    let mut s: String = raw.chars()
                        .map(|c| if c.is_alphanumeric() || c == '_' { c.to_ascii_lowercase() } else { '_' })
                        .collect();
                    if s.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                        s.insert(0, 'c');
                    }
                    s
                }
            } else {
                format!("column_{}", ci + 1)
            };
            let samples: Vec<&str> = data_rows.iter()
                .filter_map(|r| r.get(ci).map(|s| s.as_str()))
                .collect();
            CsvColumnInfo { name, inferred_type: infer_type(&samples) }
        }).collect();

        let rows = data_rows.iter().take(PREVIEW_ROWS)
            .map(|r| {
                let mut row: Vec<String> = (*r).clone();
                row.resize(n_cols, String::new());
                row
            })
            .collect();

        Ok(CsvPreview {
            delimiter: (delim as char).to_string(),
            has_header,
            columns,
            rows,
            file_bytes,
        })
    })
    .await
    ?
}

// ── Import ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CsvImportSpec {
    pub path: String,
    pub delimiter: String,
    pub has_header: bool,
    /// Quoted target table (frontend quotes it per engine)
    pub table: String,
    /// One entry per CSV column: quoted target column name, or None = skip
    pub columns: Vec<Option<String>>,
    /// DDL to run first (new-table mode)
    pub create_sql: Option<String>,
    /// DELETE existing rows first
    pub truncate: bool,
    /// Empty string → NULL
    pub null_empty: bool,
    /// Insert conflict handling: skip duplicates / update on duplicate key
    #[serde(default)]
    pub upsert: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ImportEvent {
    Progress { rows: u64, bytes: u64, total_bytes: u64 },
}

#[derive(Debug, Serialize)]
pub struct ImportSummary {
    pub rows: u64,
    pub ms: u64,
    /// A cancel commits the rows already imported and stops — unlike an
    /// error, which rolls the whole import back.
    pub cancelled: bool,
}

#[cfg(test)]   // the hot path uses escape_literal_into; tests assert via this wrapper
fn escape_literal(v: &str, mysql: bool) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    escape_literal_into(v, mysql, &mut out);
    out
}

/// Append the quoted literal to `out` — the hot-loop form: no per-value
/// String (WP-11 11.2).
fn escape_literal_into(v: &str, mysql: bool, out: &mut String) {
    out.push('\'');
    for ch in v.chars() {
        match ch {
            '\'' => out.push_str("''"),
            '\\' if mysql => out.push_str("\\\\"),
            c => out.push(c),
        }
    }
    out.push('\'');
}

/// Build batched INSERT statements from the CSV, streaming.
struct BatchBuilder<'a> {
    spec: &'a CsvImportSpec,
    mysql: bool,
    /// T-SQL has no INSERT-level conflict clause; see `statement_for`.
    sqlserver: bool,
    col_list: String,
}

impl<'a> BatchBuilder<'a> {
    fn new(spec: &'a CsvImportSpec, mysql: bool, sqlserver: bool) -> Self {
        let col_list = spec.columns.iter().flatten().cloned().collect::<Vec<_>>().join(", ");
        BatchBuilder { spec, mysql, sqlserver, col_list }
    }
    /// Append one row's `(v1, v2, …)` tuple to `out`. Writes literals
    /// directly into the reused statement buffer — the old shape allocated a
    /// Vec<String> plus one String per value per row, millions of transient
    /// allocations per second at the measured import rates (WP-11 11.2).
    fn push_row_values(&self, rec: &csv::StringRecord, out: &mut String) {
        out.push('(');
        let mut first = true;
        for (i, c) in self.spec.columns.iter().enumerate() {
            if c.is_none() { continue; }
            if !first { out.push_str(", "); }
            first = false;
            let raw = rec.get(i).unwrap_or("");
            if raw.is_empty() && self.spec.null_empty {
                out.push_str("NULL");
            } else {
                escape_literal_into(raw, self.mysql, out);
            }
        }
        out.push(')');
    }
    /// Full statement around an already-joined VALUES body.
    fn statement_for(&self, values: &str) -> String {
        let base = format!("INSERT INTO {} ({}) VALUES\n{}", self.spec.table, self.col_list, values);
        if !self.spec.upsert { return base; }
        if self.mysql {
            // update every non-key column on duplicate key
            let sets: Vec<String> = self.spec.columns.iter().flatten()
                .map(|c| format!("{c}=VALUES({c})")).collect();
            format!("{base}\nON DUPLICATE KEY UPDATE {}", sets.join(", "))
        } else if self.sqlserver {
            // T-SQL has no INSERT-level conflict clause at all. Its upsert is
            // `MERGE`, which needs the key columns to match on — and this
            // importer does not know them; it knows a column list from a CSV
            // header. Emitting a MERGE with a guessed key would silently update
            // or skip the wrong rows, so the command refuses the option before
            // it reads a byte (see `csv_import`) and this branch is unreachable.
            base
        } else {
            // PG without a known conflict target → skip duplicates safely
            format!("{base}\nON CONFLICT DO NOTHING")
        }
    }
}

/// Read the CSV on a blocking thread and stream batched INSERT statements
/// down the channel as `(statement, rows_so_far, byte_offset)` triples —
/// one send per [`BATCH_ROWS`]-sized batch, then a final partial one.
///
/// Extracted from `csv_import` unchanged in behaviour so the tests drive the
/// exact reader the command does — a test that reimplemented this loop would
/// prove nothing about it. `upsert` travels with the reader: the inline
/// version rebuilt the spec with `upsert: false`, so the conflict clause the
/// UI promised was silently never appended.
#[allow(clippy::too_many_arguments)]
fn spawn_batch_reader(
    path: String,
    delim: u8,
    has_header: bool,
    columns: Vec<Option<String>>,
    table: String,
    null_empty: bool,
    mysql: bool,
    sqlserver: bool,
    upsert: bool,
    tx: tokio::sync::mpsc::Sender<Result<(String, u64, u64), String>>,
) {
    // BatchBuilder borrows the spec — rebuild one inside the thread from the
    // owned parts.
    std::thread::spawn(move || {
        let owned_spec = CsvImportSpec {
            path: path.clone(), delimiter: String::new(), has_header,
            table, columns, create_sql: None, truncate: false, null_empty, upsert,
        };
        let builder = BatchBuilder::new(&owned_spec, mysql, sqlserver);
        let rdr = csv::ReaderBuilder::new()
            .delimiter(delim)
            .has_headers(has_header)
            .flexible(true)
            .from_path(&path);
        let mut rdr = match rdr {
            Ok(r) => r,
            Err(e) => { let _ = tx.blocking_send(Err(e.to_string())); return; }
        };
        // One reused VALUES buffer, cleared between batches (capacity kept).
        let mut values = String::new();
        let mut batch_rows = 0usize;
        let mut rows_total: u64 = 0;
        let mut rec = csv::StringRecord::new();
        loop {
            match rdr.read_record(&mut rec) {
                Ok(true) => {
                    if batch_rows > 0 { values.push_str(",\n"); }
                    builder.push_row_values(&rec, &mut values);
                    batch_rows += 1;
                    rows_total += 1;
                    // Row cap OR byte cap — see STMT_BYTES_CAP.
                    if batch_rows >= BATCH_ROWS || values.len() >= STMT_BYTES_CAP {
                        let bytes = rdr.position().byte();
                        let stmt = builder.statement_for(&values);
                        values.clear();
                        batch_rows = 0;
                        if tx.blocking_send(Ok((stmt, rows_total, bytes))).is_err() { return; }
                    }
                }
                Ok(false) => break,
                Err(e) => {
                    let _ = tx.blocking_send(Err(format!("row {}: {}", rows_total + 1, e)));
                    return;
                }
            }
        }
        if batch_rows > 0 {
            let bytes = rdr.position().byte();
            let stmt = builder.statement_for(&values);
            let _ = tx.blocking_send(Ok((stmt, rows_total, bytes)));
        }
    });
}

#[tauri::command]
pub async fn csv_import(
    session_id: Uuid,
    run_key: String,
    spec: CsvImportSpec,
    on_event: Channel<ImportEvent>,
    state: State<'_, AppState>,
) -> Result<ImportSummary, crate::apperror::AppError> {
    if spec.columns.iter().flatten().count() == 0 {
        return Err("no columns mapped".into());
    }
    // A read-only connection must refuse bulk loads too — this path builds its
    // own INSERT/COPY statements and never passes through the query command's
    // guard, so without this check the CSV importer was a way around it.
    if state.is_read_only(&session_id).await {
        return Err("Connection is read-only — CSV import is blocked.".into());
    }
    // …and the prod border applies for the same reason: this is a bulk write
    // that no per-statement guard ever sees.
    state.check_prod_bulk(&session_id, "CSV import").await?;
    if state.has_open_transaction(&session_id).await {
        return Err("a transaction is open on this session — commit or roll back first. \
                    The import writes on its own connection, so its rows would not be part \
                    of your transaction and Rollback would not remove them.".into());
    }
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;

    // T-SQL has no INSERT-level conflict clause. Its upsert is `MERGE`, which
    // needs the key columns to match on — and this importer knows a column list
    // from a CSV header, not a key. A MERGE with a guessed key would update or
    // skip the wrong rows and report success, so the option is refused here
    // rather than quietly ignored: an unticked promise is better than a kept
    // one that did something else.
    if spec.upsert && matches!(session.as_ref(), LiveSession::SqlServer(_)) {
        return Err("SQL Server has no INSERT-level \"on duplicate\" clause — its upsert is \
                    MERGE, which needs the key columns to match on, and the importer only \
                    knows the CSV's column list. Import into a staging table and MERGE from \
                    it, or untick the option to insert every row.".into());
    }

    let started = std::time::Instant::now();
    let total_bytes = std::fs::metadata(&spec.path).map(|m| m.len()).unwrap_or(0);
    let delim = spec.delimiter.bytes().next().unwrap_or(b',');

    // CSV reading is sync — parse batches on a blocking thread, execute async.
    // Simplest robust structure: read ALL batches' SQL lazily via an iterator
    // channel between a blocking reader task and this async executor.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<(String, u64, u64), String>>(4);
    spawn_batch_reader(
        spec.path.clone(),
        delim,
        spec.has_header,
        spec.columns.clone(),
        spec.table.clone(),
        spec.null_empty,
        matches!(session.as_ref(), LiveSession::Mysql(_)),
        matches!(session.as_ref(), LiveSession::SqlServer(_)),
        spec.upsert,
        tx,
    );

    // Register the cancel handle BEFORE the pool acquire, which can wait
    // seconds on a busy pool — a cancel arriving during startup must not be a
    // silent no-op. Session-prefixed so `cancel_session_work` finds it on
    // close; `cancel_import` resolves the bare key via `take_ext_job`.
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let job_key = crate::state::ext_job_key(session_id, &run_key);
    state.ext_jobs.write().await.insert(job_key.clone(), cancel_tx);

    let import_result = run_import_inner(
        session.as_ref(), &spec, &mut rx, &on_event, total_bytes, &mut cancel_rx,
    ).await;
    // Removed on every exit path — success, error and cancel alike.
    state.ext_jobs.write().await.remove(&job_key);

    // A CSV that a JSON/XLSX conversion left in the shared temp dir is
    // deleted once the import consumed it — success OR failure (WP-12 12.4).
    // User-picked files are untouched: the helper deletes only our own
    // txui-import-* files inside the temp dir.
    crate::importconv::cleanup_temp_csv(std::path::Path::new(&spec.path));
    let (rows, cancelled) = import_result?;

    Ok(ImportSummary { rows, ms: started.elapsed().as_millis() as u64, cancelled })
}

/// The cancellable body of `csv_import`, factored out (like dump.rs's
/// `run_tool_inner`) so the ext_jobs entry is dropped no matter which `?`
/// fires inside. Returns `(rows_imported, cancelled)`.
async fn run_import_inner(
    session: &LiveSession,
    spec: &CsvImportSpec,
    rx: &mut tokio::sync::mpsc::Receiver<Result<(String, u64, u64), String>>,
    on_event: &Channel<ImportEvent>,
    total_bytes: u64,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<(u64, bool), crate::apperror::AppError> {
    // Execute on ONE connection so BEGIN/COMMIT actually holds the transaction.
    match session {
        LiveSession::Mysql(pool) => {
            let mut conn = pool.acquire().await?;
            let mut exec = Exec::Mysql(&mut conn);
            run_import(&mut exec, spec, rx, on_event, total_bytes, cancel_rx).await
        }
        LiveSession::Postgres(pool) => {
            let mut conn = pool.acquire().await?;
            let mut exec = Exec::Postgres(&mut conn);
            run_import(&mut exec, spec, rx, on_event, total_bytes, cancel_rx).await
        }
        LiveSession::Clickhouse(_) =>
            Err("CSV import into ClickHouse is not supported yet".into()),
        LiveSession::Redis(..) => Err("CSV import is not available for Redis".into()),
        LiveSession::Sqlite(pool) => {
            let mut conn = pool.acquire().await?;
            let mut exec = Exec::Sqlite(&mut conn);
            run_import(&mut exec, spec, rx, on_event, total_bytes, cancel_rx).await
        }
        LiveSession::Parquet(_) =>
            Err("a Parquet file is immutable — nothing can be imported into it".into()),
        // No write path at all in v1 (db/mongodb.rs) — import is a write.
        LiveSession::MongoDb(_) =>
            Err("CSV import is not available for MongoDB".into()),
        // DuckDB's own read_csv is the right tool for this; wiring the generic
        // row-stream importer into the mutex-guarded session is a follow-up.
        LiveSession::Duckdb(_) =>
            Err("CSV import into DuckDB is not wired yet — use read_csv() in SQL".into()),
        LiveSession::SqlServer(s) => {
            // `BULK INSERT` and `OPENROWSET(BULK …)` both read a file the
            // SERVER can see, which a desktop client's local CSV is not — so
            // this takes the same batched-INSERT path as the other engines.
            //
            // One T-SQL limit shapes it: a multi-row VALUES constructor accepts
            // at most 1000 rows (Msg 10738), verified. BATCH_ROWS is 500, so
            // the existing batching is already inside it — but that is a fact
            // worth writing down, because raising BATCH_ROWS would break SQL
            // Server and nothing else.
            let mut exec = Exec::SqlServer(s);
            run_import(&mut exec, spec, rx, on_event, total_bytes, cancel_rx).await
        }
    }
}

/// Cancel a running CSV import at the next batch boundary. The rows already
/// imported are committed and stay — an error rolls back, a cancel is a
/// deliberate "keep what went in, stop now".
#[tauri::command]
pub async fn cancel_import(run_key: String, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    if let Some(tx) = crate::state::take_ext_job(&state.ext_jobs, &run_key).await {
        let _ = tx.send(());
    }
    Ok(())
}

/// Single-connection executor across the three SQL engines.
enum Exec<'a> {
    Mysql(&'a mut sqlx::pool::PoolConnection<sqlx::MySql>),
    Postgres(&'a mut sqlx::pool::PoolConnection<sqlx::Postgres>),
    Sqlite(&'a mut sqlx::pool::PoolConnection<sqlx::Sqlite>),
    // Not a pooled connection: a SQL Server session IS one pinned connection,
    // which is exactly what the BEGIN/COMMIT around the import needs.
    SqlServer(&'a crate::db::sqlserver::SqlServerSession),
}

impl Exec<'_> {
    /// The statement that opens a transaction on this engine.
    ///
    /// A bare `BEGIN` is a **syntax error** in T-SQL — it opens a statement
    /// block, not a transaction, and the batch is rejected before anything
    /// runs (Msg 102, verified). Every other engine here accepts it, which is
    /// exactly why it went unnoticed until a fourth one arrived.
    fn begin_stmt(&self) -> &'static str {
        match self {
            Exec::SqlServer(_) => "BEGIN TRANSACTION",
            _ => "BEGIN",
        }
    }

    async fn run(&mut self, sql: &str) -> Result<(), crate::apperror::AppError> {
        match self {
            Exec::Mysql(c) => crate::db::mysql::execute(&mut ***c, sql)
                .await.map(|_| ()).map_err(Into::into),
            Exec::Postgres(c) => crate::db::postgres::execute(&mut ***c, sql)
                .await.map(|_| ()).map_err(Into::into),
            Exec::Sqlite(c) => crate::db::sqlite::execute(&mut ***c, sql)
                .await.map(|_| ()).map_err(Into::into),
            Exec::SqlServer(s) => crate::db::sqlserver::execute(s, sql)
                .await.map(|_| ()).map_err(Into::into),
        }
    }
}

async fn run_import(
    exec: &mut Exec<'_>,
    spec: &CsvImportSpec,
    rx: &mut tokio::sync::mpsc::Receiver<Result<(String, u64, u64), String>>,
    on_event: &Channel<ImportEvent>,
    total_bytes: u64,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<(u64, bool), crate::apperror::AppError> {
    if let Some(ddl) = &spec.create_sql {
        exec.run(ddl).await?;
    }
    exec.run(exec.begin_stmt()).await?;
    if spec.truncate {
        if let Err(e) = exec.run(&format!("DELETE FROM {}", spec.table)).await {
            let _ = exec.run("ROLLBACK").await;
            return Err(e);
        }
    }
    let mut rows_done: u64 = 0;
    let mut failed: Option<String> = None;
    // Cancellation is polled at batch boundaries — a batch is at most
    // BATCH_ROWS rows / STMT_BYTES_CAP bytes, so the stop is prompt without
    // racing every statement. Dropping the receiver on the way out ends the
    // reader thread (its blocking_send fails).
    let mut cancelled = false;
    while let Some(item) = rx.recv().await {
        if cancel_rx.try_recv().is_ok() { cancelled = true; break; }
        match item {
            Ok((stmt, rows, bytes)) => {
                if let Err(e) = exec.run(&stmt).await { failed = Some(e.to_string()); break; }
                rows_done = rows;
                let _ = on_event.send(ImportEvent::Progress { rows, bytes, total_bytes });
            }
            Err(e) => { failed = Some(e); break; }
        }
    }
    if let Some(e) = failed {
        let _ = exec.run("ROLLBACK").await;
        return Err(format!("import failed (rolled back): {e}").into());
    }
    // A cancel COMMITs what already went in — partial import stays, which is
    // what "stop now" means. Only an error rolls back.
    exec.run("COMMIT").await?;
    Ok((rows_done, cancelled))
}

// ── JSON / spreadsheet import ────────────────────────────────────────────────

/// Convert a JSON or spreadsheet file to a temporary CSV.
///
/// The caller then runs the ordinary `csv_preview` / `csv_import` flow against
/// the result, so JSON and Excel inherit the streaming insert, progress,
/// upsert, production guards and audit trail that only exist on that path.
#[tauri::command]
pub async fn import_convert(
    path: String,
    sheet: Option<String>,
) -> Result<crate::importconv::Converted, crate::apperror::AppError> {
    let p = std::path::PathBuf::from(&path);
    tokio::task::spawn_blocking(move || {
        let kind = crate::importconv::format_of(&p);
        match kind {
            "json" => crate::importconv::convert_json(&p, false),
            "ndjson" => crate::importconv::convert_json(&p, true),
            "sheet" => crate::importconv::convert_sheet(&p, sheet.as_deref()),
            "csv" => anyhow::bail!("that is already a CSV — open it directly"),
            _ => anyhow::bail!(
                "TxUI does not know how to read {} — expected .json, .ndjson, .xlsx, .xls or .ods",
                p.display()),
        }
    })
    .await
    .map_err(|e| crate::apperror::AppError::bad_request(format!("conversion failed: {e}")))?
    .map_err(|e| crate::apperror::AppError::bad_request(format!("{e:#}")))
}


// ── Tests ────────────────────────────────────────────────────────────────────

/// The SQLite arm of the import, exercised against real temp-file databases.
/// SQLite needs no server, so these run the full path — reader thread, batch
/// builder, single-connection BEGIN/COMMIT — rather than a reimplementation.
/// CSV import into a real SQL Server.
///
/// The interesting parts are T-SQL-specific and none of them show up in a
/// SQLite test: the multi-row `VALUES` limit, the transaction keyword, and
/// literal escaping without backslashes. Skipped without an endpoint; see
/// docs/MSSQL_DEV.md.
#[cfg(test)]
mod mssql_import_live_tests {
    use super::*;
    use crate::db::sqlserver::{self, live_tests::live_session};

    /// The batch builder the command uses, for a SQL Server target.
    fn builder_sql(rows: usize) -> String {
        let spec = CsvImportSpec {
            path: String::new(), delimiter: ",".into(), has_header: true,
            table: "[dbo].[zz_csv_live]".into(),
            columns: vec![Some("[code]".into()), Some("[label]".into()), Some("[qty]".into())],
            create_sql: None, truncate: false, null_empty: true, upsert: false,
        };
        let b = BatchBuilder::new(&spec, false, true);
        let mut values = String::new();
        for i in 0..rows {
            if i > 0 { values.push_str(",\n"); }
            let rec = csv::StringRecord::from(vec![
                format!("C{i}"), "it's a label".to_string(), (i * 3).to_string(),
            ]);
            b.push_row_values(&rec, &mut values);
        }
        b.statement_for(&values)
    }

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn a_generated_batch_loads_and_the_values_survive() {
        let Some(s) = live_session().await else {
            println!("no endpoint configured — see docs/MSSQL_DEV.md");
            return;
        };
        sqlserver::execute(&s, "DROP TABLE IF EXISTS dbo.zz_csv_live").await.ok();
        sqlserver::execute(&s,
            "CREATE TABLE dbo.zz_csv_live (code nvarchar(20), label nvarchar(100), qty int)")
            .await.expect("create target");

        // The transaction keyword: a bare BEGIN is a SYNTAX ERROR in T-SQL —
        // it opens a statement block, not a transaction (Msg 102).
        sqlserver::execute(&s, "BEGIN")
            .await.expect_err("bare BEGIN must not be accepted by T-SQL");
        sqlserver::execute(&s, "BEGIN TRANSACTION").await.expect("BEGIN TRANSACTION");

        sqlserver::execute(&s, &builder_sql(500)).await.expect("500-row batch");
        sqlserver::execute(&s, "COMMIT").await.expect("COMMIT");

        let r = sqlserver::execute(&s,
            "SELECT COUNT(*), MIN(qty), MAX(qty), MAX(label) FROM dbo.zz_csv_live")
            .await.expect("read back");
        let row = &r.rows[0];
        assert_eq!(row[0].as_i64(), Some(500));
        assert_eq!(row[1].as_i64(), Some(0));
        assert_eq!(row[2].as_i64(), Some(1497));
        // The apostrophe survived as data, not as a quote — and the backslash
        // rule matters here: escaping it the MySQL way would corrupt the value.
        assert_eq!(row[3].as_str(), Some("it's a label"));

        sqlserver::execute(&s, "DROP TABLE dbo.zz_csv_live").await.ok();
    }

    /// The limit that constrains BATCH_ROWS, asserted against the server.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn a_thousand_and_one_value_rows_are_refused() {
        let Some(s) = live_session().await else { return };
        sqlserver::execute(&s, "DROP TABLE IF EXISTS dbo.zz_csv_cap").await.ok();
        sqlserver::execute(&s,
            "CREATE TABLE dbo.zz_csv_cap (code nvarchar(20), label nvarchar(100), qty int)")
            .await.expect("create");

        let over = builder_sql(1001).replace("zz_csv_live", "zz_csv_cap");
        let err = sqlserver::execute(&s, &over).await
            .expect_err("1001 VALUES rows must be refused");
        let msg = format!("{err:#}");
        assert!(msg.contains("1000") || msg.contains("10738"), "unexpected: {msg}");

        // BATCH_ROWS must stay inside it — raising it would break SQL Server
        // and nothing else, which is the kind of change that ships.
        assert!(BATCH_ROWS <= 1000, "BATCH_ROWS is {BATCH_ROWS}");
        let ok = builder_sql(BATCH_ROWS).replace("zz_csv_live", "zz_csv_cap");
        sqlserver::execute(&s, &ok).await.expect("a full BATCH_ROWS batch must load");

        sqlserver::execute(&s, "DROP TABLE dbo.zz_csv_cap").await.ok();
    }

    /// The upsert option is refused, not silently ignored.
    #[test]
    fn the_upsert_clause_is_never_emitted_for_sql_server() {
        let spec = CsvImportSpec {
            path: String::new(), delimiter: ",".into(), has_header: true,
            table: "[t]".into(), columns: vec![Some("[a]".into())],
            create_sql: None, truncate: false, null_empty: true, upsert: true,
        };
        let stmt = BatchBuilder::new(&spec, false, true).statement_for("(1)");
        // Neither other engine's clause is T-SQL, and a guessed MERGE key would
        // update the wrong rows and report success.
        assert!(!stmt.contains("ON DUPLICATE"), "{stmt}");
        assert!(!stmt.contains("ON CONFLICT"), "{stmt}");
        assert!(!stmt.contains("MERGE"), "{stmt}");
        assert!(stmt.starts_with("INSERT INTO [t] ([a]) VALUES"), "{stmt}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        // Unique per test AND per process: the temp dir is shared with every
        // other test binary on the machine.
        let dir = std::env::temp_dir()
            .join(format!("txui-import-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn pool_for(path: &std::path::Path, read_only: bool) -> SqlitePool {
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(!read_only)
            .read_only(read_only);
        SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap()
    }

    fn spec_for(csv: &std::path::Path, table: &str, columns: &[&str]) -> CsvImportSpec {
        CsvImportSpec {
            path: csv.to_string_lossy().into_owned(),
            delimiter: ",".into(),
            has_header: true,
            table: table.into(),
            columns: columns.iter().map(|c| Some(format!("\"{c}\""))).collect(),
            create_sql: None,
            truncate: false,
            null_empty: true,
            upsert: false,
        }
    }

    /// Drive `run_import` through the same reader thread `csv_import` spawns —
    /// anything less would test a reimplementation, not the import.
    async fn import(
        pool: &SqlitePool,
        spec: &CsvImportSpec,
        progress: Option<Arc<AtomicU64>>,
    ) -> Result<(u64, bool), crate::apperror::AppError> {
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let total_bytes = std::fs::metadata(&spec.path).map(|m| m.len()).unwrap_or(0);
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        spawn_batch_reader(
            spec.path.clone(),
            spec.delimiter.bytes().next().unwrap_or(b','),
            spec.has_header,
            spec.columns.clone(),
            spec.table.clone(),
            spec.null_empty,
            false, // not MySQL → SQLite/PG literal quoting
            false, // not SQL Server
            spec.upsert,
            tx,
        );
        let chan: Channel<ImportEvent> = Channel::new(move |_| {
            if let Some(p) = &progress { p.fetch_add(1, Ordering::SeqCst); }
            Ok(())
        });
        let mut conn = pool.acquire().await?;
        let mut exec = Exec::Sqlite(&mut conn);
        run_import(&mut exec, spec, &mut rx, &chan, total_bytes, &mut cancel_rx).await
    }

    async fn row_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM \"t\"")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn import_into_sqlite_types_nulls_and_counts() {
        let dir = temp_dir("types");
        let db = dir.join("t.db");
        let csv_path = dir.join("data.csv");
        std::fs::write(&csv_path,
            "id,price,name,note\n1,1.5,alpha,\n2,2.25,beta,x\n3,3,gamma,\n").unwrap();

        let pool = pool_for(&db, false).await;
        let mut spec = spec_for(&csv_path, "\"imported\"", &["id", "price", "name", "note"]);
        // The type names are exactly what the preview's inference emits.
        spec.create_sql = Some(
            "CREATE TABLE \"imported\" (\"id\" BIGINT, \"price\" DOUBLE PRECISION, \
             \"name\" VARCHAR(255), \"note\" TEXT)".into());

        let hits = Arc::new(AtomicU64::new(0));
        let (rows, cancelled) = import(&pool, &spec, Some(hits.clone())).await.unwrap();
        assert_eq!(rows, 3);
        assert!(!cancelled);
        assert!(hits.load(Ordering::SeqCst) > 0, "progress events were sent");

        let r = crate::db::sqlite::execute(&pool,
            "SELECT id, price, name, note FROM \"imported\" ORDER BY id").await.unwrap();
        assert_eq!(r.rows.len(), 3);
        // Column affinity turned the quoted literals into real storage classes:
        // BIGINT holds an integer, DOUBLE PRECISION a real…
        assert_eq!(r.rows[0][0], serde_json::json!(1));
        assert_eq!(r.rows[0][1], serde_json::json!(1.5));
        assert_eq!(r.rows[2][0], serde_json::json!(3));
        // …VARCHAR stays text, and an empty cell with null_empty is NULL.
        assert_eq!(r.rows[0][2], serde_json::json!("alpha"));
        assert_eq!(r.rows[0][3], serde_json::Value::Null);
        assert_eq!(r.rows[1][3], serde_json::json!("x"));

        pool.close().await;
    }

    #[tokio::test]
    async fn a_failing_late_batch_rolls_back_everything() {
        let dir = temp_dir("rollback");
        let db = dir.join("t.db");
        let csv_path = dir.join("data.csv");
        // BATCH_ROWS + 1 rows; the extra one repeats the first id, so batch 1
        // inserts cleanly and batch 2 violates the PRIMARY KEY.
        let mut text = String::from("id,v\n");
        for i in 1..=BATCH_ROWS { text.push_str(&format!("{i},row{i}\n")); }
        text.push_str("1,dup\n");
        std::fs::write(&csv_path, text).unwrap();

        let pool = pool_for(&db, false).await;
        let mut spec = spec_for(&csv_path, "\"t\"", &["id", "v"]);
        spec.create_sql =
            Some("CREATE TABLE \"t\" (\"id\" INTEGER PRIMARY KEY, \"v\" TEXT)".into());

        let err = import(&pool, &spec, None).await.unwrap_err().to_string();
        assert!(err.contains("rolled back"), "{err}");

        assert_eq!(row_count(&pool).await, 0,
            "the first {BATCH_ROWS} inserted rows must be gone too");

        pool.close().await;
    }

    #[tokio::test]
    async fn a_malformed_row_mid_file_rolls_back_too() {
        let dir = temp_dir("malformed");
        let db = dir.join("t.db");
        let csv_path = dir.join("data.csv");
        // A full clean batch, then bytes that are not valid UTF-8: reading
        // into a StringRecord fails there — after batch 1 was already sent
        // and inserted. (An unterminated quote is NOT a parse error: the csv
        // crate takes EOF as the end of the field.)
        let mut bytes = b"a\n".to_vec();
        for i in 0..BATCH_ROWS { bytes.extend_from_slice(format!("row{i}\n").as_bytes()); }
        bytes.extend_from_slice(b"\xff\xfe\n");
        std::fs::write(&csv_path, bytes).unwrap();

        let pool = pool_for(&db, false).await;
        let mut spec = spec_for(&csv_path, "\"t\"", &["a"]);
        spec.create_sql = Some("CREATE TABLE \"t\" (\"a\" TEXT)".into());

        let err = import(&pool, &spec, None).await.unwrap_err().to_string();
        assert!(err.contains("rolled back"), "{err}");
        assert!(err.contains("row"), "{err}");

        assert_eq!(row_count(&pool).await, 0);

        pool.close().await;
    }

    #[tokio::test]
    async fn read_only_pool_is_refused_by_sqlite_itself() {
        let dir = temp_dir("ro");
        let db = dir.join("t.db");
        {
            let pool = pool_for(&db, false).await;
            sqlx::query("CREATE TABLE \"t\" (\"a\" TEXT)").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO \"t\" VALUES ('keep')").execute(&pool).await.unwrap();
            pool.close().await;
        }
        let csv_path = dir.join("data.csv");
        std::fs::write(&csv_path, "a\nnew\n").unwrap();

        // The session-level guard refuses first (state.is_read_only in
        // csv_import); what is exercised here is the guarantee under it — the
        // file was opened mode=ro and SQLite itself refuses the write.
        let pool = pool_for(&db, true).await;
        let spec = spec_for(&csv_path, "\"t\"", &["a"]);
        let err = import(&pool, &spec, None).await.unwrap_err().to_string().to_lowercase();
        assert!(err.contains("readonly") || err.contains("read-only"), "{err}");

        assert_eq!(row_count(&pool).await, 1);

        pool.close().await;
    }

    #[tokio::test]
    async fn upsert_skips_duplicates_and_truncate_clears_first() {
        let dir = temp_dir("upsert");
        let db = dir.join("t.db");
        let pool = pool_for(&db, false).await;
        sqlx::query("CREATE TABLE \"t\" (\"id\" INTEGER PRIMARY KEY, \"v\" TEXT)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO \"t\" VALUES (1, 'old')").execute(&pool).await.unwrap();

        // Upsert on a duplicate PK: ON CONFLICT DO NOTHING keeps the original.
        // This also pins the reader-thread fix — before it, `upsert` never
        // reached the batch builder and this import failed on the conflict.
        let csv_path = dir.join("upsert.csv");
        std::fs::write(&csv_path, "id,v\n1,new\n2,two\n").unwrap();
        let mut spec = spec_for(&csv_path, "\"t\"", &["id", "v"]);
        spec.upsert = true;
        assert_eq!(import(&pool, &spec, None).await.unwrap(), (2, false));
        let r = crate::db::sqlite::execute(&pool, "SELECT id, v FROM \"t\" ORDER BY id")
            .await.unwrap();
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][1], serde_json::json!("old"), "conflict skips, not overwrites");
        assert_eq!(r.rows[1][1], serde_json::json!("two"));

        // Truncate deletes the existing rows before inserting.
        let csv_path = dir.join("truncate.csv");
        std::fs::write(&csv_path, "id,v\n3,three\n").unwrap();
        let mut spec = spec_for(&csv_path, "\"t\"", &["id", "v"]);
        spec.truncate = true;
        assert_eq!(import(&pool, &spec, None).await.unwrap(), (1, false));
        assert_eq!(row_count(&pool).await, 1);

        pool.close().await;
    }

    /// A cancel fires the oneshot after the first batch's progress event; the
    /// import must stop at the next batch boundary, COMMIT the rows already
    /// in (partial import stays — only an error rolls back) and report itself
    /// cancelled.
    #[tokio::test]
    async fn a_cancel_commits_the_partial_import_and_says_so() {
        let dir = temp_dir("cancel");
        let db = dir.join("t.db");
        let csv_path = dir.join("data.csv");
        // BATCH_ROWS + 1 rows: at least two batches, so the cancel lands
        // while there is still work left.
        let mut text = String::from("id,v\n");
        for i in 0..=BATCH_ROWS { text.push_str(&format!("{i},row{i}\n")); }
        std::fs::write(&csv_path, text).unwrap();

        let pool = pool_for(&db, false).await;
        let mut spec = spec_for(&csv_path, "\"t\"", &["id", "v"]);
        spec.create_sql = Some("CREATE TABLE \"t\" (\"id\" BIGINT, \"v\" TEXT)".into());

        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let cancel_tx = std::sync::Mutex::new(Some(cancel_tx));
        let total_bytes = std::fs::metadata(&spec.path).map(|m| m.len()).unwrap_or(0);
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        spawn_batch_reader(
            spec.path.clone(), b',', spec.has_header, spec.columns.clone(),
            spec.table.clone(), spec.null_empty, false, false, spec.upsert, tx,
        );
        let chan: Channel<ImportEvent> = Channel::new(move |_| {
            // The first progress event means batch 1 was inserted — cancel now.
            if let Some(tx) = cancel_tx.lock().unwrap().take() { let _ = tx.send(()); }
            Ok(())
        });
        // Scoped so the pool's one connection is released before row_count
        // re-acquires it (max_connections(1) — holding it here PoolTimedOuts).
        let (rows, cancelled) = {
            let mut conn = pool.acquire().await.unwrap();
            let mut exec = Exec::Sqlite(&mut conn);
            run_import(&mut exec, &spec, &mut rx, &chan, total_bytes, &mut cancel_rx)
                .await.unwrap()
        };

        assert!(cancelled, "the outcome must say it was cancelled");
        assert_eq!(rows, BATCH_ROWS as u64);
        assert_eq!(row_count(&pool).await, BATCH_ROWS as i64,
            "the partial import stays — cancel commits, it does not roll back");

        pool.close().await;
    }

    #[test]
    fn sqlite_dialect_quoting_and_upsert_shape() {
        // Non-MySQL escaping: single quotes double, backslashes stay literal —
        // SQLite does not treat backslash as an escape in string literals.
        assert_eq!(escape_literal("it's \\ fine", false), "'it''s \\ fine'");

        let spec = CsvImportSpec {
            path: String::new(), delimiter: ",".into(), has_header: true,
            table: "\"t\"".into(),
            columns: vec![Some("\"a\"".into()), None, Some("\"b\"".into())],
            create_sql: None, truncate: false, null_empty: true, upsert: true,
        };
        let builder = BatchBuilder::new(&spec, false, false);
        // Skipped columns leave no hole in the column list…
        let mut values = String::new();
        builder.push_row_values(&csv::StringRecord::from(vec!["x", "skipped", ""]), &mut values);
        let stmt = builder.statement_for(&values);
        assert!(stmt.starts_with("INSERT INTO \"t\" (\"a\", \"b\") VALUES\n('x', NULL)"), "{stmt}");
        // …and SQLite's upsert spelling is the PG one: skip, not update.
        assert!(stmt.ends_with("ON CONFLICT DO NOTHING"), "{stmt}");
    }
}
