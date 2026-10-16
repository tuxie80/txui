//! DuckDB spatial extension — on-demand INSTALL/LOAD.
//!
//! GEOMETRY is a core type since DuckDB 1.5 (reading and drawing it works
//! offline today), but the ST_* functions, the EPSG catalog, `ST_Read` and
//! GeoParquet writing live in the `spatial` extension, which duckdb-rs's
//! `bundled` feature does not compile in. The first `INSTALL spatial`
//! downloads a per-platform binary from DuckDB's extension repository into
//! `~/.duckdb/extensions` (the identical flow on all three desktops — the
//! engine fetches the right artifact itself); afterwards `LOAD` works offline
//! from that cache. Hence the order below: try LOAD first (free, offline),
//! and only when the binary is absent, INSTALL (the one network step).
//!
//! Read-only sessions are not refused: neither statement writes to the
//! database file — INSTALL touches the extension cache in the profile
//! directory, LOAD is session-local — and every function this unlocks is a
//! read function (GeoParquet writing is `COPY (SELECT …) TO`, a file write
//! the user runs explicitly in the editor).

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::db::connection::get_session_pub;
use crate::db::types::LiveSession;
use crate::state::AppState;

/// The outcome, structured rather than thrown: this is a probe-like operation
/// (same shape as `ping`), and the frontend needs the failure KIND — a network
/// failure greys the affordance with a "needs the extension repository" reason,
/// anything else reports the engine's own text.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialEnableResult {
    /// LOAD succeeded — ST_* functions are usable on this session now.
    pub enabled: bool,
    /// LOAD alone sufficed: the binary was already in `~/.duckdb/extensions`.
    pub already_installed: bool,
    /// This call ran the one-time INSTALL download before loading.
    pub installed_now: bool,
    /// The engine's error text when `enabled` is false.
    pub error: Option<String>,
    /// The failure looked like no network / unreachable extension repository.
    pub network_error: bool,
}

/// INSTALL (if needed) + LOAD the spatial extension on a DuckDB session.
#[tauri::command]
pub async fn duckdb_enable_spatial(
    session_id: Uuid,
    state: State<'_, AppState>,
) -> Result<SpatialEnableResult, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions).await?;
    let LiveSession::Duckdb(s) = session.as_ref() else {
        return Err("The spatial extension is only available for DuckDB sessions.".into());
    };
    Ok(enable_spatial(s).await)
}

/// LOAD first (free, offline when the binary is cached), INSTALL only when
/// LOAD reports it absent — the one network step.
async fn enable_spatial(s: &crate::db::duckdb::DuckDbSession) -> SpatialEnableResult {
    if crate::db::duckdb::execute(s, "LOAD spatial").await.is_ok() {
        return SpatialEnableResult {
            enabled: true, already_installed: true, installed_now: false,
            error: None, network_error: false,
        };
    }

    // The one network step — DuckDB downloads the per-platform binary.
    if let Err(e) = crate::db::duckdb::execute(s, "INSTALL spatial").await {
        let msg = e.to_string();
        return SpatialEnableResult {
            enabled: false, already_installed: false, installed_now: false,
            network_error: looks_like_network_error(&msg), error: Some(msg),
        };
    }
    match crate::db::duckdb::execute(s, "LOAD spatial").await {
        Ok(_) => SpatialEnableResult {
            enabled: true, already_installed: false, installed_now: true,
            error: None, network_error: false,
        },
        Err(e) => {
            let msg = e.to_string();
            SpatialEnableResult {
                enabled: false, already_installed: false, installed_now: false,
                network_error: looks_like_network_error(&msg), error: Some(msg),
            }
        }
    }
}

/// DuckDB reports a failed download as an IO/HTTP error whose phrasing varies
/// by platform and version, so match the family, not one exact string.
fn looks_like_network_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    ["http", "network", "resolve", "connect", "download", "timed out", "timeout",
     "offline", "ssl", "certificate", "extension repository"]
        .iter().any(|k| m.contains(k))
}

// ── Server-side GeoParquet export ────────────────────────────────────────────
//
// The grid's client-side Parquet export (write_parquet_file) serializes the
// FETCHED rows — a geometry column crosses the bridge as hex text, so the
// file it writes holds an opaque string, not a GEOMETRY column, and no `geo`
// footer metadata. A real GeoParquet file has to be written by the engine:
// `COPY (<the query>) TO '…' (FORMAT PARQUET)` on the session's own
// connection, where the GEOMETRY type survives and the spatial extension
// emits the GeoParquet 1.1 footer. Re-running the statement also means the
// export is NOT the grid's row-capped preview — it is the whole result.

/// What a server-side GeoParquet export produced.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeoParquetExportResult {
    /// The file as written (echo of the chosen path).
    pub path: String,
    /// Rows COPY reported writing.
    pub rows_written: u64,
    /// File size on disk after the write.
    pub bytes: u64,
}

/// Progress of a server-side GeoParquet export, streamed over the command's
/// channel. duckdb-rs exposes no `duckdb_query_progress` binding, so a true
/// row percentage is impossible — `Progress` reports the output FILE's size
/// while the COPY runs (honest liveness, never a fake percent).
#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GeoExportEvent {
    /// The statement, path and spatial probe are being checked.
    Validating,
    /// The checks passed; the COPY statement is starting on the engine.
    Running,
    /// Liveness while the COPY runs: the output file's current size.
    Progress { bytes_written: u64 },
    /// The COPY finished — final row count and file size (the invoke's
    /// return value carries the same numbers).
    Done { rows_written: u64, bytes: u64 },
    /// The export failed; the invoke rejects with the same message.
    Error { message: String },
}

/// The statement a GeoParquet export re-runs must be ONE read: the text is
/// pasted into `COPY (<sql>) TO …`, so a write here is a write the export
/// menu smuggled past the grid's read path, and a second statement cannot
/// live inside the COPY subquery at all. Returns the single statement,
/// trimmed (and so without a trailing `;`, which the subquery would reject).
fn validate_export_sql(sql: &str) -> Result<String, String> {
    let stmts = crate::db::duckdb::split_statements(sql);
    match stmts.len() {
        0 => return Err("nothing to export — the statement is empty".into()),
        1 => {}
        n => return Err(format!(
            "GeoParquet export re-runs one statement — this text holds {n}")),
    }
    let stmt = stmts.into_iter().next().expect("len checked").0;
    // A comment-only slice survives the splitter — it is not a statement.
    if crate::sqlguard::blank(&stmt).trim().is_empty() {
        return Err("nothing to export — the statement is empty".into());
    }
    if crate::sqlguard::is_write_for(Some(crate::db::types::Engine::Duckdb), sql) {
        return Err("GeoParquet export re-runs the query server-side — \
                    a write statement cannot be exported".into());
    }
    Ok(stmt)
}

/// A DuckDB string literal for the output path: single quotes, doubled to
/// escape (DuckDB standard strings have no backslash escapes). The path is
/// the one user-controlled string in the generated COPY — this quoting is
/// the injection boundary, the SQL-string analogue of the dump tools' "never
/// interpolate into a shell" rule.
fn sql_string_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The engine's own answer to "is spatial loaded on this connection". The
/// frontend's per-session store is a client-side mirror of this fact, so the
/// command probes the catalog rather than trusting a flag that crossed IPC —
/// duckdb_extensions() is built in, so the probe itself needs no extension.
async fn spatial_loaded(s: &crate::db::duckdb::DuckDbSession) -> anyhow::Result<bool> {
    let r = crate::db::duckdb::execute(s,
        "SELECT loaded FROM duckdb_extensions() WHERE extension_name = 'spatial'").await?;
    Ok(r.rows.first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// The command body, separated from session lookup so the live test can drive
/// it on a bare session. Refuses an existing path — a parquet file is written
/// once, completely (same rule as `write_parquet_file`); DuckDB's COPY would
/// otherwise truncate it silently.
async fn export_geoparquet_inner(
    s: &crate::db::duckdb::DuckDbSession,
    sql: &str,
    out_path: &str,
) -> Result<GeoParquetExportResult, crate::apperror::AppError> {
    let inner = validate_export_sql(sql)?;
    if out_path.trim().is_empty() {
        return Err("no output path chosen".into());
    }
    let out = std::path::PathBuf::from(out_path);
    if out.exists() {
        return Err(format!("{} already exists — pick a new file name", out.display()).into());
    }
    if !spatial_loaded(s).await? {
        return Err("the spatial extension is not loaded on this session — \
                    enable it with the 🌐 toolbar button first".into());
    }
    let copy = format!("COPY ({inner}) TO {} (FORMAT PARQUET)", sql_string_literal(out_path));
    let res = crate::db::duckdb::execute(s, &copy).await?;
    // COPY TO answers one row — its Count column.
    let rows_written = res.rows.first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n.max(0) as u64)))
        .ok_or("COPY did not report a row count")?;
    let bytes = tokio::fs::metadata(&out).await
        .map_err(|e| format!("could not stat {}: {e}", out.display()))?
        .len();
    Ok(GeoParquetExportResult { path: out_path.to_string(), rows_written, bytes })
}

/// The event-emitting wrapper: phase events around the export, and a poller
/// that reports the output file's size while the blocking COPY runs — the
/// engine offers no row percentage, so bytes-on-disk is the honest liveness
/// signal. The poller is aborted on every exit path, success or failure.
async fn export_geoparquet(
    s: &crate::db::duckdb::DuckDbSession,
    sql: &str,
    out_path: &str,
    on_event: Option<&Channel<GeoExportEvent>>,
) -> Result<GeoParquetExportResult, crate::apperror::AppError> {
    let send = |ev: GeoExportEvent| {
        if let Some(ch) = on_event { let _ = ch.send(ev); }
    };
    send(GeoExportEvent::Validating);

    let poller = on_event.map(|ch| {
        let ch = ch.clone();
        let path = std::path::PathBuf::from(out_path);
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(std::time::Duration::from_millis(250));
            loop {
                iv.tick().await;
                if let Ok(md) = tokio::fs::metadata(&path).await {
                    let _ = ch.send(GeoExportEvent::Progress { bytes_written: md.len() });
                }
            }
        })
    });

    send(GeoExportEvent::Running);
    let result = export_geoparquet_inner(s, sql, out_path).await;
    if let Some(p) = poller { p.abort(); }
    match &result {
        Ok(r) => send(GeoExportEvent::Done { rows_written: r.rows_written, bytes: r.bytes }),
        Err(e) => send(GeoExportEvent::Error { message: e.to_string() }),
    }
    result
}

/// Write the result of a read statement to a GeoParquet file — server-side
/// `COPY (<sql>) TO '<path>' (FORMAT PARQUET)` on the session's own DuckDB
/// connection, so GEOMETRY columns keep their type and the spatial extension
/// writes the GeoParquet 1.1 `geo` footer. The row-capped grid export
/// (`write_parquet_file`) remains the right tool for plain results; this
/// command exists because a geometry column needs the engine to survive.
///
/// Guards: DuckDB session only; the read-only/prod borders judge the
/// statement being re-run (`guard_statement`); the statement itself must be
/// a single read (`validate_export_sql`); spatial must be LOADed, probed from
/// the engine's catalog; the output path must not exist yet.
///
/// Progress rides `on_event` as [`GeoExportEvent`]s: validating → running →
/// progress (the output file's size, ~4×/s) → done / error.
#[tauri::command]
pub async fn duckdb_export_geoparquet(
    session_id: Uuid,
    sql: String,
    out_path: String,
    on_event: Channel<GeoExportEvent>,
    state: State<'_, AppState>,
) -> Result<GeoParquetExportResult, crate::apperror::AppError> {
    // The statement will execute on this session, so it faces the same
    // borders as running it in the editor.
    state.guard_statement(&session_id, &sql).await?;
    let session = get_session_pub(session_id, &state.sessions).await?;
    let LiveSession::Duckdb(s) = session.as_ref() else {
        return Err("GeoParquet export is only available for DuckDB sessions.".into());
    };
    export_geoparquet(s, &sql, &out_path, Some(&on_event)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_failures_are_classified() {
        for msg in [
            "IO Error: Failed to download extension \"spatial\" at URL \"http://extensions.duckdb.org/...\"",
            "HTTP Error: Could not establish connection to extensions.duckdb.org",
            "Could not resolve host: extensions.duckdb.org",
            "network unreachable",
            "Connection timed out",
            "SSL certificate problem",
        ] {
            assert!(looks_like_network_error(msg), "not classified as network: {msg}");
        }
    }

    #[test]
    fn a_missing_binary_is_not_a_network_error() {
        // The expected LOAD failure when the extension was never installed —
        // it is the normal path to INSTALL, and must not read as "offline".
        assert!(!looks_like_network_error(
            "IO Error: Extension \"/home/u/.duckdb/extensions/v1.5.0/linux_amd64/spatial.duckdb_extension\" not found."));
        assert!(!looks_like_network_error(
            "Invalid Input Error: Initialization function \"spatial_init\" from file ... threw an exception: \"GEOS version mismatch\""));
    }

    // ── GeoParquet export guards (pure — no session, no extension) ──────────

    #[test]
    fn export_sql_must_be_a_single_read_statement() {
        // Reads pass, trimmed and without the trailing semicolon the COPY
        // subquery would reject.
        assert_eq!(validate_export_sql(" SELECT id, g FROM geo; ").unwrap(),
                   "SELECT id, g FROM geo");
        assert_eq!(validate_export_sql("WITH x AS (SELECT 1 AS a) SELECT * FROM x").unwrap(),
                   "WITH x AS (SELECT 1 AS a) SELECT * FROM x");

        // Writes are refused — the export re-runs the text server-side.
        for bad in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1 WHERE id = 2",
            "DELETE FROM t",
            "DROP TABLE t",
            "CREATE TABLE t (a INTEGER)",
            "SELECT 1 AS a INTO t",          // creates + populates a table
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
        ] {
            let err = validate_export_sql(bad).unwrap_err();
            assert!(err.contains("write statement"), "`{bad}`: {err}");
        }

        // Multiple statements cannot live inside COPY ( <subquery> ).
        for bad in ["SELECT 1; SELECT 2", "SELECT 1; INSERT INTO t VALUES (1);"] {
            let err = validate_export_sql(bad).unwrap_err();
            assert!(err.contains("one statement"), "`{bad}`: {err}");
        }
        // …but a semicolon inside a string is not a second statement.
        assert_eq!(validate_export_sql("SELECT ';' AS s").unwrap(), "SELECT ';' AS s");

        // Nothing to export.
        assert!(validate_export_sql("").is_err());
        assert!(validate_export_sql("  -- only a comment\n").is_err());
    }

    #[test]
    fn the_output_path_is_quoted_as_a_sql_string_literal() {
        assert_eq!(sql_string_literal("/tmp/out.parquet"), "'/tmp/out.parquet'");
        // The injection boundary: a quote doubles, so a path cannot break out
        // of the literal.
        assert_eq!(sql_string_literal("/tmp/it's.parquet"), "'/tmp/it''s.parquet'");
        assert_eq!(
            sql_string_literal("x'; DROP TABLE t; --"),
            "'x''; DROP TABLE t; --'");
        // Backslashes are NOT escapes in DuckDB standard strings — a Windows
        // path goes through verbatim.
        assert_eq!(sql_string_literal(r"C:\data\out.parquet"), r"'C:\data\out.parquet'");
    }

    /// The channel contract the frontend parses: a `type`-tagged enum with
    /// snake_case variants and fields (same shape as dump's ToolEvent).
    #[test]
    fn geo_export_events_serialize_in_the_channel_shape() {
        assert_eq!(
            serde_json::to_value(GeoExportEvent::Validating).unwrap(),
            serde_json::json!({ "type": "validating" }));
        assert_eq!(
            serde_json::to_value(GeoExportEvent::Running).unwrap(),
            serde_json::json!({ "type": "running" }));
        assert_eq!(
            serde_json::to_value(GeoExportEvent::Progress { bytes_written: 42 }).unwrap(),
            serde_json::json!({ "type": "progress", "bytes_written": 42 }));
        assert_eq!(
            serde_json::to_value(GeoExportEvent::Done { rows_written: 7, bytes: 1024 }).unwrap(),
            serde_json::json!({ "type": "done", "rows_written": 7, "bytes": 1024 }));
        assert_eq!(
            serde_json::to_value(GeoExportEvent::Error { message: "boom".into() }).unwrap(),
            serde_json::json!({ "type": "error", "message": "boom" }));
    }

    /// The export refuses before touching the engine when the input is wrong —
    /// no spatial probe, no file. (The engine-needing paths are the live test.)
    #[tokio::test]
    async fn export_refuses_bad_sql_and_existing_paths_without_an_engine() {
        let s = crate::db::duckdb::open_memory_sync(false).unwrap();
        let err = export_geoparquet(&s, "DELETE FROM t", "/tmp/never-written.parquet", None)
            .await.unwrap_err().to_string();
        assert!(err.contains("write statement"), "{err}");
        let err = export_geoparquet(&s, "SELECT 1; SELECT 2", "/tmp/never-written.parquet", None)
            .await.unwrap_err().to_string();
        assert!(err.contains("one statement"), "{err}");
        let err = export_geoparquet(&s, "SELECT 1", "  ", None)
            .await.unwrap_err().to_string();
        assert!(err.contains("no output path"), "{err}");

        let dir = std::env::temp_dir().join(format!("txui-geoexp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let taken = dir.join("taken.parquet");
        std::fs::write(&taken, b"already here").unwrap();
        let err = export_geoparquet(&s, "SELECT 1", &taken.to_string_lossy(), None)
            .await.unwrap_err().to_string();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(std::fs::read(&taken).unwrap(), b"already here",
                   "a refused export must not touch the file");
        let _ = std::fs::remove_file(&taken);

        // Without the extension the probe refuses — offline-safe: the probe
        // itself (duckdb_extensions()) is built in.
        let err = export_geoparquet(&s, "SELECT 1 AS a",
                                    &dir.join("plain.parquet").to_string_lossy(), None)
            .await.unwrap_err().to_string();
        assert!(err.contains("spatial extension is not loaded"), "{err}");
        assert!(!dir.join("plain.parquet").exists());
    }

    /// Live end-to-end: export through the same body the command uses, then
    /// prove the file is a REAL GeoParquet by reading it back through the
    /// Parquet engine — the `geo` footer parses (geo_bbox answers) and the
    /// tree labels the column GEOMETRY · GeoParquet WKB. Needs the spatial
    /// binary (offline once ~/.duckdb/extensions is warm). Opt-in:
    ///   cargo test --lib duckdb_geoparquet_export -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn duckdb_geoparquet_export_writes_a_real_geoparquet_file() {
        use crate::db::types::{ConnectionConfig, Engine};
        let mut c = ConnectionConfig::new(Engine::Duckdb, "t");
        c.file_path = Some(":memory:".into());
        let s = crate::db::duckdb::open(&c).await.unwrap();
        let r = enable_spatial(&s).await;
        assert!(r.enabled, "spatial did not enable: {:?}", r.error);

        let dir = std::env::temp_dir().join(format!("txui-geoexp-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("cities.parquet");
        let _ = std::fs::remove_file(&out);

        let res = export_geoparquet(&s,
            "SELECT 'Brno' AS name, ST_Point(16.6068, 49.1951) AS geom \
             UNION ALL SELECT 'Oslo', ST_Point(10.7522, 59.9139)",
            &out.to_string_lossy(), None).await.unwrap();
        assert_eq!(res.rows_written, 2);
        assert_eq!(res.bytes, std::fs::metadata(&out).unwrap().len());

        // The proof the metadata landed: the Parquet engine's own geo path.
        let f = crate::db::parquet::open_path(&out).unwrap();
        // RFC 7946 order [west, south, east, north] — Oslo is west, Brno south.
        assert_eq!(crate::db::parquet::geo_bbox(&f),
                   Some([10.7522, 49.1951, 16.6068, 59.9139]),
                   "footer bbox must span both points");
        let cols = crate::db::parquet::list_columns(
            &crate::db::parquet::ParquetSource::Single(crate::db::parquet::open_path(&out).unwrap()));
        assert!(cols.iter().any(|n| matches!(n,
            crate::db::types::SchemaNode::Column { name, type_name, .. }
                if name == "geom" && type_name == "GEOMETRY · GeoParquet WKB")),
            "geo footer must relabel the column: {cols:?}");
        // …and a plain (no-geometry) export is still a plain parquet file.
        let plain = dir.join("plain.parquet");
        let _ = std::fs::remove_file(&plain);
        export_geoparquet(&s, "SELECT 1 AS a", &plain.to_string_lossy(), None).await.unwrap();
        let f = crate::db::parquet::open_path(&plain).unwrap();
        assert_eq!(crate::db::parquet::geo_bbox(&f), None, "no geometry column, no geo footer");

        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&plain);
    }

    /// Live test of the exact command path (LOAD → INSTALL → LOAD) against a
    /// real in-memory DuckDB. Needs network for the first INSTALL; afterwards
    /// it passes offline from ~/.duckdb/extensions. Opt-in:
    ///   cargo test --lib duckdb_spatial_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn duckdb_spatial_live_install_and_load() {
        use crate::db::types::{ConnectionConfig, Engine};
        let mut c = ConnectionConfig::new(Engine::Duckdb, "t");
        c.file_path = Some(":memory:".into());
        let s = crate::db::duckdb::open(&c).await.unwrap();
        let r = enable_spatial(&s).await;
        assert!(r.enabled, "spatial did not enable: {:?}", r.error);
        // The extension answers: ST_Area of a unit square is 1.
        let q = crate::db::duckdb::execute(&s,
            "SELECT ST_Area(ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))')) AS a")
            .await.unwrap();
        assert_eq!(q.rows[0][0], serde_json::json!(1.0), "{:?}", q.rows);
        // And the column type is the core GEOMETRY label, not BLOB.
        let g = crate::db::duckdb::execute(&s,
            "SELECT ST_GeomFromText('POINT(1 2)') AS g").await.unwrap();
        assert_eq!(g.columns[0].type_name, "GEOMETRY", "{:?}", g.columns);
    }
}
