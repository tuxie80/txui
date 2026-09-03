//! SQLite — a file, not a server.
//!
//! `sqlx` already ships the SQLite driver (history.db uses it), so this is a
//! thin engine module rather than a new dependency. Two things differ from the
//! networked engines and drive every decision here:
//!
//! 1. **The file is the connection.** There is no host, port, user, password,
//!    TLS or SSH. `config.file_path` is the whole address.
//! 2. **SQLite is dynamically typed.** A column declared `INTEGER` can hold a
//!    string; the declared type is a *hint*, and the storage class is per
//!    value. Decoding therefore follows the value, not the declaration —
//!    see `json_from_sqlite_row`.
//!
//! Read-only connections open the file with SQLite's own `mode=ro`, so the
//! guarantee is the library's, not ours — the same posture as ClickHouse's
//! `readonly=1`.

use anyhow::{anyhow, Result};
use sqlx::AssertSqlSafe;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Row as _, SqlitePool, TypeInfo, ValueRef};
use std::path::Path;
use std::time::Instant;

use super::types::{
    json_f64, ColumnInfo, ConnectionConfig, PingResult, QueryResult, Row, SchemaNode,
};

/// Objects SQLite keeps for its own bookkeeping. Hidden from the tree for the
/// same reason `information_schema` is: they are noise unless you went looking.
const INTERNAL_PREFIX: &str = "sqlite_";

pub async fn open(config: &ConnectionConfig) -> Result<sqlx::SqlitePool> {
    let path = config
        .file_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| anyhow!("no database file chosen for this connection"))?;

    // A missing file must be an error, never an empty new database: SQLite's
    // default is to create it, and silently opening an empty database because
    // of a typo in the path is the worst possible outcome.
    if !Path::new(path).exists() {
        return Err(anyhow!("no such file: {path}"));
    }

    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        // Server-enforced, in the sense that SQLite itself refuses the write.
        .read_only(config.read_only);

    // One connection unless configured otherwise: SQLite serialises writers
    // anyway, and a pool of them on one file mostly produces SQLITE_BUSY.
    let pool = SqlitePoolOptions::new()
        .max_connections(config.pool_max.unwrap_or(1).max(1))
        .connect_with(opts)
        .await?;
    Ok(pool)
}

/// Create a brand-new, empty SQLite database at `path`.
///
/// Deliberately separate from [`open`], which refuses a missing file. Creating
/// a database is a thing you ask for explicitly; a typo in a connection's path
/// must never produce one silently.
///
/// The new file is given the settings a database should have started with
/// rather than SQLite's 1990s defaults: WAL journaling (readers do not block
/// the writer), NORMAL synchronous (durable against process crash, which is
/// what WAL makes safe), and foreign-key enforcement on.
pub async fn create(path: &Path) -> Result<()> {
    if path.exists() {
        return Err(anyhow!("{} already exists", path.display()));
    }
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            return Err(anyhow!("no such directory: {}", dir.display()));
        }
    }

    let opts = SqliteConnectOptions::new().filename(path).create_if_missing(true);
    let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await?;
    // An empty SQLite file is zero bytes until something is written, and a
    // zero-byte file is not recognisable as a database. Setting the journal
    // mode writes the header, so the file is valid the moment it exists.
    for pragma in ["PRAGMA journal_mode = WAL", "PRAGMA synchronous = NORMAL",
                   "PRAGMA foreign_keys = ON"] {
        sqlx::raw_sql(pragma).execute(&pool).await?;
    }
    pool.close().await;
    Ok(())
}

pub async fn ping(pool: &SqlitePool) -> PingResult {
    let start = Instant::now();
    match sqlx::query_scalar::<_, String>("SELECT sqlite_version()")
        .fetch_one(pool)
        .await
    {
        Ok(v) => PingResult {
            ok: true,
            latency_ms: start.elapsed().as_millis() as u64,
            server_version: Some(format!("SQLite {v}")),
            error: None,
        },
        Err(e) => PingResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            server_version: None,
            error: Some(e.to_string()),
        },
    }
}

pub async fn execute<'e, E>(executor: E, sql: &'e str) -> Result<QueryResult>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    execute_capped(executor, sql, None).await
}

/// As `execute`, fetching at most `max_rows` data rows: past the cap the
/// stream is abandoned and `truncated` is set. Rows are decoded to JSON as
/// they stream so the raw driver row is dropped immediately.
pub async fn execute_capped<'e, E>(
    executor: E,
    sql: &'e str,
    max_rows: Option<usize>,
) -> Result<QueryResult>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    use futures_util::TryStreamExt;
    let start = Instant::now();

    // Same single-pass shape as the other engines: the stream yields rows for
    // result sets and a summary for DML, so a statement never runs twice.
    //
    // `AssertSqlSafe` is sqlx 0.9 asking whether this string was built by
    // concatenation. It was not built at all — it is what the user typed, and
    // running the SQL a person wrote is the entire product. Injection is not a
    // meaningful concept at this boundary; what protects the user here is the
    // read-only flag, the write guard and the pre-flight, none of which are
    // string inspection. See `db/mod.rs`.
    let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(executor);
    let mut affected: Option<u64> = None;
    let mut first_row_ms: Option<u64> = None;
    let mut columns: Vec<ColumnInfo> = vec![];
    let mut data: Vec<Row> = Vec::new();
    let mut truncated = false;
    while let Some(item) = stream.try_next().await? {
        match item {
            sqlx::Either::Left(done) => {
                affected = Some(affected.unwrap_or(0) + done.rows_affected());
            }
            sqlx::Either::Right(row) => {
                if first_row_ms.is_none() {
                    first_row_ms = Some(start.elapsed().as_millis() as u64);
                }
                if columns.is_empty() {
                    columns = row
                        .columns()
                        .iter()
                        .map(|c| ColumnInfo {
                            name: c.name().to_string(),
                            type_name: c.type_info().name().to_string(),
                            nullable: true,
                        })
                        .collect();
                }
                if max_rows.is_some_and(|cap| data.len() >= cap) {
                    truncated = true;
                    break;
                }
                data.push((0..columns.len()).map(|i| json_from_sqlite_row(&row, i)).collect());
            }
        }
    }
    let execution_ms = first_row_ms.unwrap_or_else(|| start.elapsed().as_millis() as u64);

    if columns.is_empty() {
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: affected,
            execution_ms,
            fetch_ms: 0,
            warnings: vec![],
            truncated: false,
        });
    }

    Ok(QueryResult {
        columns,
        rows: data,
        rows_affected: None,
        execution_ms,
        fetch_ms: start.elapsed().as_millis() as u64 - execution_ms,
        warnings: vec![],
        truncated,
    })
}

pub fn json_from_row_pub(row: &SqliteRow, i: usize) -> serde_json::Value {
    json_from_sqlite_row(row, i)
}

/// Decode one cell.
///
/// SQLite has five storage classes and no per-column type enforcement, so this
/// follows the **value**, not the declared type: a column declared `INTEGER`
/// holding the string `'n/a'` must come back as that string, not as NULL.
/// Each decode is attempted in storage-class order and the first that succeeds
/// wins; NULL is checked first so a failed decode can never masquerade as one.
fn json_from_sqlite_row(row: &SqliteRow, i: usize) -> serde_json::Value {
    use serde_json::Value;

    match row.try_get_raw(i) {
        Ok(raw) if raw.is_null() => return Value::Null,
        Err(_) => return Value::Null,
        _ => {}
    }

    if let Ok(v) = row.try_get::<i64, _>(i) {
        return Value::Number(v.into());
    }
    if let Ok(v) = row.try_get::<f64, _>(i) {
        return json_f64(v);
    }
    if let Ok(v) = row.try_get::<String, _>(i) {
        return Value::String(v);
    }
    // BLOB: never rendered as text — the bytes may not be UTF-8, and a lossy
    // conversion would show something that is not what is stored.
    if let Ok(v) = row.try_get::<Vec<u8>, _>(i) {
        return Value::String(format!("<BLOB {} bytes>", v.len()));
    }
    Value::Null
}

// ── Schema tree ──────────────────────────────────────────────────────────────

/// Top level: the attached databases. Always at least `main`; `temp` and any
/// ATTACHed file appear too, which is the only way to see them at all.
pub async fn list_databases(pool: &SqlitePool) -> Result<Vec<SchemaNode>> {
    let rows = sqlx::query("PRAGMA database_list").fetch_all(pool).await?;
    let mut out = Vec::new();
    for r in &rows {
        let name: String = r.try_get("name").unwrap_or_default();
        if !name.is_empty() {
            out.push(SchemaNode::Database { name });
        }
    }
    if out.is_empty() {
        out.push(SchemaNode::Database { name: "main".into() });
    }
    Ok(out)
}

pub async fn list_schema(pool: &SqlitePool, database: Option<&str>) -> Result<Vec<SchemaNode>> {
    match database {
        Some(db) => list_objects(pool, db).await,
        None => list_databases(pool).await,
    }
}

/// Tables, views and triggers of one attached database.
///
/// `sqlite_master` is per-database, so it has to be addressed through the
/// schema name — `main.sqlite_master`, `temp.sqlite_master`, and so on. There
/// is no cross-database catalog.
pub async fn list_objects(pool: &SqlitePool, database: &str) -> Result<Vec<SchemaNode>> {
    let master = format!("\"{}\".sqlite_master", database.replace('"', "\"\""));
    let sql = format!(
        "SELECT type, name FROM {master} \
         WHERE type IN ('table','view','trigger') AND name NOT LIKE '{INTERNAL_PREFIX}%' \
         ORDER BY type, name"
    );
    let rows = sqlx::query(AssertSqlSafe(sql)).fetch_all(pool).await?;

    let schema = Some(database.to_string());
    let mut out = Vec::new();
    for r in &rows {
        let kind: String = r.try_get("type").unwrap_or_default();
        let name: String = r.try_get("name").unwrap_or_default();
        out.push(match kind.as_str() {
            "view" => SchemaNode::View { name, schema: schema.clone() },
            "trigger" => SchemaNode::Trigger { name, schema: schema.clone(), table: None },
            _ => SchemaNode::Table {
                name,
                schema: schema.clone(),
                row_count: None,
                partition_of: None,
                temporal: false,
            },
        });
    }
    Ok(out)
}

/// Columns + indexes of one table.
///
/// `PRAGMA table_info` reports the DECLARED type, which is all SQLite records
/// at the schema level — an empty string for a column declared without one.
///
/// It is `table_xinfo`, not `table_info`, and that is the whole difference
/// between showing a table and showing most of it: **`table_info` omits
/// generated columns entirely.** A column declared
/// `total INT GENERATED ALWAYS AS (a + b) STORED` simply does not appear, so
/// the tree showed a two-column table where the file has four, and the user's
/// conclusion — "that column does not exist" — was wrong in the one direction
/// that costs an afternoon. `table_xinfo` returns the same rows plus a
/// `hidden` flag: 0 ordinary, 1 a virtual table's internal column, 2 VIRTUAL
/// generated, 3 STORED generated.
///
/// Hidden-1 columns stay out. They are an implementation detail of the virtual
/// table module (FTS5's shadow columns and the like), not something anyone
/// declared, and listing them would make every FTS table look malformed.
pub async fn list_columns(
    pool: &SqlitePool,
    database: &str,
    table: &str,
) -> Result<Vec<SchemaNode>> {
    let mut out = Vec::new();

    let cols = sqlx::query(AssertSqlSafe(pragma(database, "table_xinfo", table)))
        .fetch_all(pool)
        .await?;
    for r in &cols {
        let name: String = r.try_get("name").unwrap_or_default();
        let decl: String = r.try_get("type").unwrap_or_default();
        let notnull: i64 = r.try_get("notnull").unwrap_or(0);
        let pk: i64 = r.try_get("pk").unwrap_or(0);
        let hidden: i64 = r.try_get("hidden").unwrap_or(0);
        if hidden == 1 {
            continue;
        }
        let generated = match hidden {
            2 => Some("VIRTUAL"),
            3 => Some("STORED"),
            _ => None,
        };
        let base = if decl.is_empty() { "(untyped)" } else { &decl };
        out.push(SchemaNode::Column {
            name,
            // "" is what SQLite stores for an untyped column, and untyped is a
            // real, meaningful state here — say so rather than showing a blank.
            type_name: match generated {
                // Worth carrying: a generated column cannot be written to, and
                // finding that out from a failed INSERT is a bad way to learn
                // it. STORED vs VIRTUAL is the difference between occupying
                // space and being recomputed per read.
                Some(kind) => format!("{base} · GENERATED {kind}"),
                None => base.to_string(),
            },
            nullable: notnull == 0,
            primary_key: pk > 0,
        });
    }

    // Indexes: index_list names them, index_info gives the columns of each.
    let idx = sqlx::query(AssertSqlSafe(pragma(database, "index_list", table)))
        .fetch_all(pool)
        .await?;
    for r in &idx {
        let name: String = r.try_get("name").unwrap_or_default();
        let unique: i64 = r.try_get("unique").unwrap_or(0);
        // Auto-indexes back a UNIQUE/PK constraint and are not separate objects.
        if name.starts_with(INTERNAL_PREFIX) {
            continue;
        }
        let info = sqlx::query(AssertSqlSafe(pragma(database, "index_info", &name)))
            .fetch_all(pool)
            .await
            .unwrap_or_default();
        let columns: Vec<String> = info
            .iter()
            .filter_map(|c| c.try_get::<Option<String>, _>("name").ok().flatten())
            .collect();
        out.push(SchemaNode::Index { name, unique: unique != 0, columns });
    }

    Ok(out)
}

/// The stored CREATE statement — SQLite keeps the original text verbatim, so
/// this is exactly what created the object rather than a reconstruction.
pub async fn get_ddl(pool: &SqlitePool, database: &str, object: &str) -> Result<String> {
    let master = format!("\"{}\".sqlite_master", database.replace('"', "\"\""));
    let sql = format!("SELECT sql FROM {master} WHERE name = ?1");
    let stored: Option<Option<String>> = sqlx::query_scalar(AssertSqlSafe(sql))
        .bind(object)
        .fetch_optional(pool)
        .await?;

    match stored.flatten() {
        Some(text) if !text.trim().is_empty() => {
            // Indexes belonging to the object are part of "the DDL" in every
            // other engine's view, so include them.
            let idx_sql = format!(
                "SELECT sql FROM {master} WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL ORDER BY name"
            );
            let idx: Vec<String> = sqlx::query_scalar(AssertSqlSafe(idx_sql))
                .bind(object)
                .fetch_all(pool)
                .await
                .unwrap_or_default();
            let mut out = format!("{};", text.trim_end_matches(';'));
            for i in idx {
                out.push_str(&format!("\n{};", i.trim_end_matches(';')));
            }
            Ok(out)
        }
        // Auto-created objects (an implicit index, a virtual table's shadow)
        // have a NULL sql — that is a fact about them, not a failure.
        Some(_) => Ok(format!("-- {object} has no stored DDL (created implicitly by SQLite)")),
        None => Err(anyhow!("no object named {object} in {database}")),
    }
}

/// A schema-qualified PRAGMA.
///
/// PRAGMA does **not** take a dotted name as its argument: the schema goes
/// before the pragma name (`PRAGMA "main".table_info("orders")`), not inside
/// the parentheses. Writing `PRAGMA table_info("main"."orders")` is a syntax
/// error, which is exactly what it produced before this existed.
fn pragma(database: &str, name: &str, arg: &str) -> String {
    format!("PRAGMA \"{}\".{}(\"{}\")", quoted(database), name, quoted(arg))
}

fn quoted(ident: &str) -> String {
    ident.replace('"', "\"\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pragma_puts_the_schema_before_the_pragma_name() {
        // The bug this pins down: `PRAGMA table_info("main"."orders")` is a
        // syntax error. The schema qualifies the PRAGMA, not its argument.
        assert_eq!(pragma("main", "table_info", "orders"),
                   "PRAGMA \"main\".table_info(\"orders\")");
        assert_eq!(pragma("temp", "index_list", "we\"ird"),
                   "PRAGMA \"temp\".index_list(\"we\"\"ird\")");
    }

    /// WP-04 4.1: the editor pipeline's row cap. Insert cap+10 rows, execute
    /// with the cap, and the result must stop at the cap with `truncated` set;
    /// an uncapped run and an under-cap result must not be marked truncated.
    #[tokio::test]
    async fn execute_capped_stops_at_the_cap_and_says_so() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE t (n INTEGER); \
             WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 110) \
             INSERT INTO t SELECT x FROM c",
        ).execute(&pool).await.unwrap();

        let capped = execute_capped(&pool, "SELECT n FROM t", Some(100)).await.unwrap();
        assert_eq!(capped.rows.len(), 100);
        assert!(capped.truncated, "cap was hit — the result must say so");

        let full = execute(&pool, "SELECT n FROM t").await.unwrap();
        assert_eq!(full.rows.len(), 110);
        assert!(!full.truncated);

        let under = execute_capped(&pool, "SELECT n FROM t LIMIT 5", Some(100)).await.unwrap();
        assert_eq!(under.rows.len(), 5);
        assert!(!under.truncated, "an under-cap result must not claim truncation");
    }

    #[tokio::test]
    async fn a_missing_file_is_an_error_not_a_new_empty_database() {
        // SQLite's default is to CREATE the file. Silently opening an empty
        // database because of a typo is the worst outcome available.
        let mut c = ConnectionConfig::new(super::super::types::Engine::Sqlite, "t");
        c.file_path = Some("/nonexistent/definitely/not/here.db".into());
        let err = open(&c).await.unwrap_err().to_string();
        assert!(err.contains("no such file"), "{err}");
        assert!(!std::path::Path::new("/nonexistent/definitely/not/here.db").exists());
    }

    #[tokio::test]
    async fn no_file_path_says_so() {
        let mut c = ConnectionConfig::new(super::super::types::Engine::Sqlite, "t");
        c.file_path = Some("   ".into());
        let err = open(&c).await.unwrap_err().to_string();
        assert!(err.contains("no database file chosen"), "{err}");
    }

    /// Which PRAGMAs survive closing the file — asked of the SQLite that
    /// ships inside TxUI, on whatever platform this test is running.
    ///
    /// The distinction matters because the Settings DBA view reports both
    /// kinds side by side and labels each one `file` or `connection`. If that
    /// label is wrong the view actively misleads: it invites someone to change
    /// a setting and expect the database to keep it.
    ///
    /// It has to be *this* library rather than the `sqlite3` on the machine.
    /// The first version of `docs/SQLITE_PRAGMAS.md` classified these using
    /// the system CLI and got `synchronous` wrong — Apple's build defines
    /// `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` and reports NORMAL for a WAL
    /// database, while the bundled build does not define it and reports FULL.
    /// Same pragma, same file, different answer, purely from compile flags.
    ///
    /// Running here also settles it per platform: `libsqlite3-sys` sets no
    /// `target_os`-conditional flags, so mac, Linux and Windows should all
    /// reach these same assertions — and if a future dependency bump changes
    /// that on one platform, this fails there.
    #[tokio::test]
    async fn pragma_scope_is_what_the_settings_view_claims() {
        let dir = std::env::temp_dir().join(format!("txui-pragma-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (subject, control) = (dir.join("subject.db"), dir.join("control.db"));
        let _ = std::fs::remove_file(&subject);
        let _ = std::fs::remove_file(&control);

        async fn pool_for(p: &std::path::Path) -> SqlitePool {
            let opts = SqliteConnectOptions::new().filename(p).create_if_missing(true);
            SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap()
        }
        // Pragmas answer in whichever storage class they feel like —
        // `journal_mode` is text, `user_version` an integer — so decode the
        // value rather than the declaration, the same rule the row decoder
        // follows. Asking for a String and taking the default on failure would
        // turn every integer pragma into "" and quietly pass the wrong test.
        async fn read(p: &std::path::Path, pragma: &str) -> String {
            let pool = pool_for(p).await;
            let sql = AssertSqlSafe(format!("PRAGMA {pragma}"));
            let row = sqlx::query(sql).fetch_optional(&pool).await.unwrap();
            let v = row.map(|r| match json_from_sqlite_row(&r, 0) {
                serde_json::Value::String(s) => s,
                other => other.to_string(),
            }).unwrap_or_default();
            pool.close().await;
            v
        }

        // Both files exist and are identical; only the subject gets written to.
        for p in [&subject, &control] {
            let pool = pool_for(p).await;
            sqlx::raw_sql("CREATE TABLE t(a); INSERT INTO t VALUES (1);")
                .execute(&pool).await.unwrap();
            pool.close().await;
        }
        {
            let pool = pool_for(&subject).await;
            for stmt in ["PRAGMA journal_mode=WAL", "PRAGMA user_version=42",
                         "PRAGMA application_id=99", "PRAGMA synchronous=OFF",
                         "PRAGMA cache_size=-16000", "PRAGMA locking_mode=EXCLUSIVE",
                         "PRAGMA recursive_triggers=ON", "PRAGMA query_only=ON"] {
                sqlx::raw_sql(AssertSqlSafe(stmt)).execute(&pool).await.unwrap();
            }
            pool.close().await;
        }

        // Stored in the file: a fresh connection sees what was set.
        for (pragma, want) in [("journal_mode", "wal"), ("user_version", "42"),
                               ("application_id", "99")] {
            assert_eq!(read(&subject, pragma).await, want,
                       "{pragma} is documented as file-scoped and did not survive");
        }

        // Belonging to the connection: a fresh one sees the default, which is
        // whatever the control database — never written to — also reports.
        for pragma in ["synchronous", "cache_size", "locking_mode",
                       "recursive_triggers", "query_only"] {
            assert_eq!(read(&subject, pragma).await, read(&control, pragma).await,
                       "{pragma} is documented as connection-scoped but outlived its connection");
        }

        // The correction, pinned: this build does NOT define
        // SQLITE_DEFAULT_WAL_SYNCHRONOUS, so putting a database into WAL does
        // not quietly relax its durability the way Apple's SQLite does.
        assert_eq!(read(&subject, "journal_mode").await, "wal");
        assert_eq!(read(&subject, "synchronous").await, "2",
                   "a WAL database should still report FULL in the bundled build");

        // And what TxUI itself imposes: foreign keys on, a real deviation from
        // SQLite's own OFF default, doubled by the bundled build's
        // -DSQLITE_DEFAULT_FOREIGN_KEYS=1.
        let mut c = ConnectionConfig::new(super::super::types::Engine::Sqlite, "t");
        c.file_path = Some(control.to_string_lossy().into_owned());
        let pool = open(&c).await.unwrap();
        let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&pool).await.unwrap();
        assert_eq!(fk, 1, "TxUI opens SQLite with foreign-key enforcement on");
    }

    /// End-to-end against a real file: build one, then read it back through
    /// the same code paths the app uses.
    #[tokio::test]
    async fn schema_columns_indexes_and_ddl_come_back() {
        let dir = std::env::temp_dir().join(format!("txui-sqlite-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let _ = std::fs::remove_file(&path);

        {
            let opts = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
            let pool = SqlitePoolOptions::new().connect_with(opts).await.unwrap();
            sqlx::raw_sql(
                "CREATE TABLE orders (id INTEGER PRIMARY KEY, note, total REAL NOT NULL,
                   with_vat REAL GENERATED ALWAYS AS (total * 1.21) STORED,
                   half REAL GENERATED ALWAYS AS (total / 2) VIRTUAL);
                 CREATE INDEX idx_total ON orders(total);
                 CREATE VIEW big AS SELECT * FROM orders WHERE total > 100;
                 INSERT INTO orders VALUES (1, 'hi', 9.5), (2, NULL, 250.0), (3, 42, 1.0);",
            )
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;
        }

        let mut c = ConnectionConfig::new(super::super::types::Engine::Sqlite, "t");
        c.file_path = Some(path.to_string_lossy().into_owned());
        let pool = open(&c).await.unwrap();

        // Databases: at minimum `main`.
        let dbs = list_databases(&pool).await.unwrap();
        assert!(dbs.iter().any(|n| matches!(n, SchemaNode::Database { name } if name == "main")));

        // Objects: the table and the view, and no sqlite_* internals.
        let objs = list_objects(&pool, "main").await.unwrap();
        assert!(objs.iter().any(|n| matches!(n, SchemaNode::Table { name, .. } if name == "orders")));
        assert!(objs.iter().any(|n| matches!(n, SchemaNode::View { name, .. } if name == "big")));

        // Columns: the untyped one is reported as untyped, not blank; the
        // declared PK and NOT NULL survive.
        let cols = list_columns(&pool, "main", "orders").await.unwrap();
        let note = cols.iter().find_map(|n| match n {
            SchemaNode::Column { name, type_name, .. } if name == "note" => Some(type_name.clone()),
            _ => None,
        });
        assert_eq!(note.as_deref(), Some("(untyped)"));
        assert!(cols.iter().any(|n| matches!(n,
            SchemaNode::Column { name, primary_key: true, .. } if name == "id")));
        assert!(cols.iter().any(|n| matches!(n,
            SchemaNode::Column { name, nullable: false, .. } if name == "total")));
        assert!(cols.iter().any(|n| matches!(n,
            SchemaNode::Index { name, columns, .. } if name == "idx_total" && columns == &["total"])));

        // Generated columns exist in the file, so they exist in the tree.
        // `PRAGMA table_info` omits them outright — under it this table read
        // as three columns when it has five, and "that column does not exist"
        // is the wrong conclusion in the expensive direction.
        let generated = |want: &str| cols.iter().find_map(|n| match n {
            SchemaNode::Column { name, type_name, .. } if name == want => Some(type_name.clone()),
            _ => None,
        });
        assert_eq!(generated("with_vat").as_deref(), Some("REAL · GENERATED STORED"));
        assert_eq!(generated("half").as_deref(), Some("REAL · GENERATED VIRTUAL"));

        // DDL is the stored text, with the table's indexes appended.
        let ddl = get_ddl(&pool, "main", "orders").await.unwrap();
        assert!(ddl.contains("CREATE TABLE orders"), "{ddl}");
        assert!(ddl.contains("idx_total"), "{ddl}");

        // Dynamic typing: `note` holds a string in one row and an integer in
        // another. Both must survive as themselves.
        let r = execute(&pool, "SELECT note FROM orders ORDER BY id").await.unwrap();
        assert_eq!(r.rows.len(), 3);
        assert_eq!(r.rows[0][0], serde_json::json!("hi"));
        assert_eq!(r.rows[1][0], serde_json::Value::Null);
        assert_eq!(r.rows[2][0], serde_json::json!(42));

        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn read_only_is_refused_by_sqlite_itself() {
        let dir = std::env::temp_dir().join(format!("txui-sqlite-ro-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ro.db");
        let _ = std::fs::remove_file(&path);
        {
            let opts = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
            let pool = SqlitePoolOptions::new().connect_with(opts).await.unwrap();
            sqlx::raw_sql("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        }

        let mut c = ConnectionConfig::new(super::super::types::Engine::Sqlite, "t");
        c.file_path = Some(path.to_string_lossy().into_owned());
        c.read_only = true;
        let pool = open(&c).await.unwrap();

        // Reads work…
        assert_eq!(execute(&pool, "SELECT a FROM t").await.unwrap().rows.len(), 1);
        // …and the WRITE is refused by the library, not by our guard.
        let err = execute(&pool, "INSERT INTO t VALUES (2)").await.unwrap_err().to_string();
        assert!(
            err.to_lowercase().contains("readonly") || err.to_lowercase().contains("read-only"),
            "expected SQLite's own read-only refusal, got: {err}"
        );

        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }
}

/// Tests against the sample database in the repo root. They run when it is
/// present and skip (loudly) when it is not.
#[cfg(test)]
mod sample_tests {
    use super::*;
    use super::super::types::Engine;

    const SAMPLE: &str = "../../txui-data/gcp-prod-sql-cz-web-877f.db";

    async fn sample(read_only: bool) -> Option<SqlitePool> {
        if !Path::new(SAMPLE).exists() {
            eprintln!("skipping: {SAMPLE} not present");
            return None;
        }
        let mut c = ConnectionConfig::new(Engine::Sqlite, "sample");
        c.file_path = Some(SAMPLE.into());
        c.read_only = read_only;
        Some(open(&c).await.expect("sample must open"))
    }

    #[tokio::test]
    async fn the_real_database_is_explored_end_to_end() {
        let Some(pool) = sample(true).await else { return };

        let dbs = list_databases(&pool).await.unwrap();
        assert!(dbs.iter().any(|n| matches!(n, SchemaNode::Database { name } if name == "main")));

        let objs = list_objects(&pool, "main").await.unwrap();
        let tables: Vec<String> = objs.iter().filter_map(|n| match n {
            SchemaNode::Table { name, .. } => Some(name.clone()),
            _ => None,
        }).collect();
        eprintln!("tables: {tables:?}");
        assert!(tables.contains(&"events".to_string()));
        // sqlite_* internals must never leak into the tree.
        assert!(!tables.iter().any(|t| t.starts_with("sqlite_")));

        // Columns + indexes of a real table.
        let cols = list_columns(&pool, "main", "events").await.unwrap();
        let n_cols = cols.iter().filter(|n| matches!(n, SchemaNode::Column { .. })).count();
        let n_idx = cols.iter().filter(|n| matches!(n, SchemaNode::Index { .. })).count();
        eprintln!("events: {n_cols} columns, {n_idx} indexes");
        assert!(n_cols > 10, "expected a wide table, got {n_cols}");
        assert!(cols.iter().any(|n| matches!(n,
            SchemaNode::Column { name, primary_key: true, .. } if name == "id")));

        // DDL is the stored text plus this table's indexes.
        let ddl = get_ddl(&pool, "main", "events").await.unwrap();
        assert!(ddl.contains("CREATE TABLE events"), "{ddl}");

        // And a real query runs.
        let r = execute(&pool, "SELECT count(*) AS n FROM events").await.unwrap();
        let n = r.rows[0][0].as_i64().unwrap();
        eprintln!("events rows: {n}");
        assert!(n > 0);

        pool.close().await;
    }

    /// Writes: allowed on a normal connection, refused by SQLite itself on a
    /// READONLY one. Run against a COPY — proving the write path works must
    /// not mean modifying the user's sample file.
    #[tokio::test]
    async fn writes_work_and_read_only_refuses_them() {
        if !Path::new(SAMPLE).exists() {
            eprintln!("skipping: {SAMPLE} not present");
            return;
        }
        let copy = std::env::temp_dir().join(format!("txui-sample-copy-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&copy);
        std::fs::copy(SAMPLE, &copy).unwrap();

        let mut rw = ConnectionConfig::new(Engine::Sqlite, "copy");
        rw.file_path = Some(copy.to_string_lossy().into_owned());
        let pool = open(&rw).await.unwrap();

        let before = execute(&pool, "SELECT count(*) FROM snapshots").await.unwrap()
            .rows[0][0].as_i64().unwrap();

        // DDL…
        execute(&pool, "CREATE TABLE txui_probe (a INTEGER, b TEXT)").await.unwrap();
        // …DML, with the affected count reported…
        let ins = execute(&pool, "INSERT INTO txui_probe VALUES (1,'x'),(2,'y')").await.unwrap();
        assert_eq!(ins.rows_affected, Some(2));
        let upd = execute(&pool, "UPDATE txui_probe SET b='z' WHERE a=1").await.unwrap();
        assert_eq!(upd.rows_affected, Some(1));
        let del = execute(&pool, "DELETE FROM txui_probe WHERE a=2").await.unwrap();
        assert_eq!(del.rows_affected, Some(1));
        let left = execute(&pool, "SELECT a, b FROM txui_probe").await.unwrap();
        assert_eq!(left.rows.len(), 1);
        assert_eq!(left.rows[0][1], serde_json::json!("z"));
        execute(&pool, "DROP TABLE txui_probe").await.unwrap();

        // The existing data is untouched by all of that.
        let after = execute(&pool, "SELECT count(*) FROM snapshots").await.unwrap()
            .rows[0][0].as_i64().unwrap();
        assert_eq!(before, after);
        pool.close().await;

        // Same file, READONLY connection: SQLite itself refuses.
        let mut ro = ConnectionConfig::new(Engine::Sqlite, "copy-ro");
        ro.file_path = Some(copy.to_string_lossy().into_owned());
        ro.read_only = true;
        let pool = open(&ro).await.unwrap();
        assert!(execute(&pool, "SELECT count(*) FROM snapshots").await.is_ok());
        for stmt in ["INSERT INTO snapshots (session_id, captured_at) VALUES ('x','y')",
                     "CREATE TABLE nope (a INTEGER)",
                     "DROP TABLE snapshots",
                     "UPDATE snapshots SET row_count = 0"] {
            let err = execute(&pool, stmt).await.unwrap_err().to_string().to_lowercase();
            assert!(err.contains("readonly") || err.contains("read-only"),
                    "`{stmt}` was not refused: {err}");
        }
        pool.close().await;

        // The user's own file was never opened for writing.
        let _ = std::fs::remove_file(&copy);
    }

    #[tokio::test]
    async fn a_read_only_session_never_modifies_the_sample_file() {
        let Some(pool) = sample(true).await else { return };
        let before = std::fs::metadata(SAMPLE).unwrap();
        let _ = execute(&pool, "SELECT count(*) FROM events").await;
        let _ = list_objects(&pool, "main").await;
        pool.close().await;
        let after = std::fs::metadata(SAMPLE).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    }
}

#[cfg(test)]
mod probe {
    use super::*;
    use super::super::types::Engine;

    /// Not a test of the app — a probe that prints which catalog queries the
    /// bundled SQLite actually supports, so the DBA views only ship ones that
    /// work. Run with: cargo test --lib probe:: -- --nocapture --ignored
    #[tokio::test]
    #[ignore]
    async fn what_works() {
        let mut c = ConnectionConfig::new(Engine::Sqlite, "s");
        c.file_path = Some("../../txui-data/gcp-prod-sql-cz-web-877f.db".into());
        c.read_only = true;
        let pool = open(&c).await.unwrap();
        for (name, sql) in [
            ("dbstat", "SELECT name, sum(pgsize) FROM dbstat GROUP BY name LIMIT 3"),
            ("pragma_table_info fn", "SELECT m.name, p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' LIMIT 3"),
            ("pragma_index_list fn", "SELECT m.name, i.name FROM sqlite_master m JOIN pragma_index_list(m.name) i WHERE m.type='table' LIMIT 3"),
            ("pragma_index_xinfo", "SELECT m.name, i.name, x.name FROM sqlite_master m JOIN pragma_index_list(m.name) i JOIN pragma_index_xinfo(i.name) x WHERE m.type='table' LIMIT 3"),
            ("pragma_foreign_key_list", "SELECT m.name, f.\"table\" FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f LIMIT 3"),
            ("page_count fn", "SELECT * FROM pragma_page_count"),
            ("freelist", "SELECT * FROM pragma_freelist_count"),
            ("compile_options", "SELECT * FROM pragma_compile_options LIMIT 5"),
            ("integrity_check", "SELECT * FROM pragma_quick_check(1)"),
            ("fk_check", "SELECT * FROM pragma_foreign_key_check LIMIT 3"),
            ("stat1", "SELECT * FROM sqlite_stat1 LIMIT 3"),
            ("sqlite_schema", "SELECT count(*) FROM sqlite_schema"),
            ("journal/sync", "SELECT (SELECT * FROM pragma_journal_mode) AS j, (SELECT * FROM pragma_synchronous) AS s"),
            ("optimize view", "SELECT sqlite_version(), sqlite_source_id()"),
        ] {
            match execute(&pool, sql).await {
                Ok(r) => eprintln!("ok    {name:<24} {} rows, {} cols", r.rows.len(), r.columns.len()),
                Err(e) => eprintln!("FAIL  {name:<24} {}", e.to_string().lines().next().unwrap_or("")),
            }
        }
        pool.close().await;
    }
}

/// Runs every shipped SQLite DBA view against the sample database, through the
/// real driver. The view SQL is exported from src/utils/dbaViews.ts by
/// `dev/probe_file_views.mjs`, so a view that does not run cannot ship.
#[cfg(test)]
mod view_tests {
    use super::*;
    use super::super::types::Engine;

    #[tokio::test]
    #[ignore] // needs /tmp/txui_views.json — see dev/probe_file_views.mjs
    async fn every_sqlite_dba_view_runs() {
        let Ok(raw) = std::fs::read_to_string("/tmp/txui_views.json") else {
            eprintln!("skipping: run dev/probe_file_views.mjs first");
            return;
        };
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut c = ConnectionConfig::new(Engine::Sqlite, "s");
        c.file_path = Some("../../txui-data/gcp-prod-sql-cz-web-877f.db".into());
        c.read_only = true;
        let pool = open(&c).await.unwrap();

        let mut failed = 0;
        for v in doc["sqlite"].as_array().unwrap() {
            let (id, sql) = (v["id"].as_str().unwrap(), v["sql"].as_str().unwrap());
            match execute(&pool, sql).await {
                Ok(r) => eprintln!("ok    {id:<18} {:>5} rows x {} cols", r.rows.len(), r.columns.len()),
                Err(e) => {
                    let msg = e.to_string();
                    // sqlite_stat1 only exists after ANALYZE. Its absence is a
                    // finding the panel explains (see utils/dbaGuidance.ts), not
                    // a broken view — but it must fail for exactly that reason.
                    if id == "sq-analyze" && msg.contains("no such table: sqlite_stat1") {
                        eprintln!("ok    {id:<18} (no ANALYZE yet — guidance shown)");
                        continue;
                    }
                    eprintln!("FAIL  {id:<18} {}", msg.lines().next().unwrap_or(""));
                    failed += 1;
                }
            }
        }
        pool.close().await;
        assert_eq!(failed, 0, "{failed} SQLite DBA view(s) failed");
    }
}

/// Every SQL statement the editor's completion pipeline issues for SQLite,
/// run against the sample database. These are built by string interpolation in
/// useSchemaCompletions.ts; a typo there produces silently empty hints, which
/// is exactly the failure ClickHouse shipped with. Keeping the statements here
/// means a broken one fails a test instead of quietly hinting nothing.
#[cfg(test)]
mod completion_tests {
    use super::*;
    use super::super::types::Engine;

    #[tokio::test]
    async fn every_hinting_query_returns_what_the_editor_expects() {
        if !Path::new("../../txui-data/gcp-prod-sql-cz-web-877f.db").exists() {
            eprintln!("skipping: sample database not present");
            return;
        }
        let mut c = ConnectionConfig::new(Engine::Sqlite, "s");
        c.file_path = Some("../../txui-data/gcp-prod-sql-cz-web-877f.db".into());
        c.read_only = true;
        let pool = open(&c).await.unwrap();

        // 1. Databases (sweepSchemas).
        let dbs = execute(&pool, "SELECT name FROM pragma_database_list ORDER BY seq").await.unwrap();
        assert!(!dbs.rows.is_empty());
        assert_eq!(dbs.rows[0][0], serde_json::json!("main"));

        // 2. Objects (sweep) — the UNION the hook builds per attached database.
        let objs = execute(&pool,
            "SELECT 'main' AS db, name, type FROM \"main\".sqlite_master \
             WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' LIMIT 20000")
            .await.unwrap();
        let names: Vec<String> = objs.rows.iter()
            .map(|r| r[1].as_str().unwrap_or("").to_string()).collect();
        assert!(names.contains(&"events".to_string()), "{names:?}");
        assert!(!names.iter().any(|n| n.starts_with("sqlite_")));

        // 3. `db.` → tables (getSchemaTables).
        let t = execute(&pool,
            "SELECT name, upper(type) FROM \"main\".sqlite_master \
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .await.unwrap();
        assert_eq!(t.rows.len(), 4, "sample has 4 tables");
        assert_eq!(t.rows[0][1], serde_json::json!("TABLE"));

        // 4. Indexed columns (getIndexedColumns) — drives the "no index" hint.
        let idx = execute(&pool,
            "SELECT x.name FROM pragma_index_list('events') i \
             JOIN pragma_index_xinfo(i.name) x ON x.key = 1 AND x.seqno = 0 \
             UNION SELECT p.name FROM pragma_table_info('events') p WHERE p.pk > 0")
            .await.unwrap();
        let cols: Vec<String> = idx.rows.iter()
            .map(|r| r[0].as_str().unwrap_or("").to_string()).collect();
        eprintln!("events indexed-first columns: {cols:?}");
        assert!(cols.contains(&"id".to_string()), "the PK must be reported: {cols:?}");
        assert!(cols.len() > 1, "sample has 4 indexes on events: {cols:?}");

        // 5. Foreign keys (getFks) — none declared here, but the query must
        //    run and return the five columns the parser reads by position.
        let fk = execute(&pool,
            "SELECT m.name || '#' || f.id AS con, \
                    'main' || '.' || m.name AS from_t, f.\"from\" AS from_c, \
                    'main' || '.' || f.\"table\" AS to_t, f.\"to\" AS to_c \
             FROM \"main\".sqlite_master m JOIN pragma_foreign_key_list(m.name) f \
             WHERE m.type = 'table' AND (m.name = 'events' COLLATE NOCASE \
                                      OR f.\"table\" = 'events' COLLATE NOCASE) \
             ORDER BY m.name, f.id, f.seq").await;
        assert!(fk.is_ok(), "FK query failed: {:?}", fk.err());

        pool.close().await;
    }

    /// The same FK query on a schema that HAS foreign keys, including a
    /// composite one — the case the constraint-grouping logic exists for.
    #[tokio::test]
    async fn composite_foreign_keys_group_by_constraint() {
        let dir = std::env::temp_dir().join(format!("txui-fk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fk.db");
        let _ = std::fs::remove_file(&path);
        {
            let opts = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
            let pool = SqlitePoolOptions::new().connect_with(opts).await.unwrap();
            sqlx::raw_sql(
                "CREATE TABLE orders (a INTEGER, b INTEGER, PRIMARY KEY (a, b));
                 CREATE TABLE lines (
                    x INTEGER, y INTEGER, note TEXT,
                    FOREIGN KEY (x, y) REFERENCES orders(a, b));",
            ).execute(&pool).await.unwrap();
            pool.close().await;
        }
        let mut c = ConnectionConfig::new(Engine::Sqlite, "fk");
        c.file_path = Some(path.to_string_lossy().into_owned());
        let pool = open(&c).await.unwrap();

        let r = execute(&pool,
            "SELECT m.name || '#' || f.id AS con, \
                    'main' || '.' || m.name AS from_t, f.\"from\" AS from_c, \
                    'main' || '.' || f.\"table\" AS to_t, f.\"to\" AS to_c \
             FROM \"main\".sqlite_master m JOIN pragma_foreign_key_list(m.name) f \
             WHERE m.type = 'table' AND (m.name = 'lines' COLLATE NOCASE \
                                      OR f.\"table\" = 'lines' COLLATE NOCASE) \
             ORDER BY m.name, f.id, f.seq").await.unwrap();

        // Two rows, ONE constraint — they must share a `con` key so the
        // grouping produces a single two-column edge, not two one-column ones.
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][0], r.rows[1][0], "both columns are one constraint");
        // …and in declaration order, so x pairs with a and y with b.
        assert_eq!(r.rows[0][2], serde_json::json!("x"));
        assert_eq!(r.rows[0][4], serde_json::json!("a"));
        assert_eq!(r.rows[1][2], serde_json::json!("y"));
        assert_eq!(r.rows[1][4], serde_json::json!("b"));
        assert_eq!(r.rows[0][1], serde_json::json!("main.lines"));
        assert_eq!(r.rows[0][3], serde_json::json!("main.orders"));

        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod create_tests {
    use super::*;
    use super::super::types::Engine;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-create-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(dir.join(format!("{name}-wal")));
        let _ = std::fs::remove_file(dir.join(format!("{name}-shm")));
        p
    }

    #[tokio::test]
    async fn a_new_database_is_usable_immediately_and_has_sane_settings() {
        let path = tmp("new.db");
        create(&path).await.unwrap();
        assert!(path.exists());
        // Not zero bytes: an empty file is not a recognisable database.
        assert!(std::fs::metadata(&path).unwrap().len() > 0);

        // It opens through the ordinary path — no special-casing downstream.
        let mut c = ConnectionConfig::new(Engine::Sqlite, "new");
        c.file_path = Some(path.to_string_lossy().into_owned());
        let pool = open(&c).await.unwrap();

        // The settings a database should have started with.
        let jm = execute(&pool, "SELECT * FROM pragma_journal_mode").await.unwrap();
        assert_eq!(jm.rows[0][0], serde_json::json!("wal"));

        // And it is a real, writable database from the first statement.
        execute(&pool, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").await.unwrap();
        let ins = execute(&pool, "INSERT INTO t (v) VALUES ('hello')").await.unwrap();
        assert_eq!(ins.rows_affected, Some(1));
        let r = execute(&pool, "SELECT v FROM t").await.unwrap();
        assert_eq!(r.rows[0][0], serde_json::json!("hello"));

        let objs = list_objects(&pool, "main").await.unwrap();
        assert!(objs.iter().any(|n| matches!(n, SchemaNode::Table { name, .. } if name == "t")));

        pool.close().await;
    }

    #[tokio::test]
    async fn creating_over_an_existing_file_is_refused() {
        let path = tmp("exists.db");
        create(&path).await.unwrap();
        // Silently reopening — or worse, truncating — someone's database
        // because the name collided is not an option.
        let err = create(&path).await.unwrap_err().to_string();
        assert!(err.contains("already exists"), "{err}");
    }

    #[tokio::test]
    async fn creating_in_a_missing_directory_says_which_one() {
        let err = create(std::path::Path::new("/nope/not/here/x.db")).await.unwrap_err().to_string();
        assert!(err.contains("no such directory"), "{err}");
    }
}

#[cfg(test)]
mod bundled_version_tests {
    use super::*;

    /// The SQLite that actually ships, asserted rather than assumed.
    ///
    /// The version is not chosen — it falls out of
    /// `rust-toolchain → sqlx → libsqlite3-sys` (docs/SQLITE_PRAGMAS.md §1),
    /// and it went stale for two years without anything noticing because
    /// nothing checked. This is what notices: a dependency bump that moves
    /// SQLite has to come here and say so.
    #[tokio::test]
    async fn the_bundled_sqlite_is_the_version_the_docs_describe() {
        let opts = SqliteConnectOptions::new().filename(":memory:").create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
        let v: String = sqlx::query_scalar("SELECT sqlite_version()").fetch_one(&pool).await.unwrap();
        assert_eq!(v, "3.51.3", "bundled SQLite moved — update docs/SQLITE_PRAGMAS.md §1");

        // dbstat backs the Space usage and Table sizes views; it is a compile
        // option, so its absence would be a silent feature loss on whichever
        // platform lost it rather than a build failure.
        let has_dbstat: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pragma_compile_options WHERE compile_options = 'ENABLE_DBSTAT_VTAB'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(has_dbstat, 1, "dbstat is gone — the Space usage views cannot work");
        pool.close().await;
    }
}
