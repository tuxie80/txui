//! SQLite tuner — data collection.
//!
//! SQLite has no server, no memory pools and no connection limits, so most of
//! what the MySQL/PG tuners look at does not exist. What *does* exist and is
//! worth acting on lives in the file header and the freelist: how much dead
//! space a file is carrying (reclaimable with VACUUM), whether the file is set
//! to reclaim it automatically (`auto_vacuum`), the page size it was built
//! with, and the durability/journalling mode of this connection.
//!
//! Everything here is a read-only `PRAGMA`. No mutation, no VACUUM — the checks
//! only *generate* the maintenance SQL.

use sqlx::SqlitePool;

/// The file/connection facts the checks reason over. Sizes are in bytes unless
/// named `_count` (pages) or `_pages`.
#[derive(Debug, Clone)]
pub struct SqliteData {
    pub version: String,
    pub page_size: u64,
    pub page_count: u64,
    pub freelist_count: u64,
    /// "wal" | "delete" | "truncate" | "persist" | "memory" | "off"
    pub journal_mode: String,
    /// 0 = OFF, 1 = NORMAL, 2 = FULL
    pub synchronous: i64,
    /// 0 = NONE, 1 = FULL, 2 = INCREMENTAL
    pub auto_vacuum: i64,
    /// per-connection FK enforcement (the app turns this on at connect)
    pub foreign_keys: bool,
    pub encoding: String,
    /// per-connection page cache: negative = that many KiB, positive = pages
    pub cache_size: i64,
    /// User tables (no views, no sqlite_% internals).
    pub user_tables: Vec<String>,
    /// Tables with a row in sqlite_stat1. `None` when sqlite_stat1 does not
    /// exist at all — i.e. ANALYZE has never been run on this file.
    pub analyzed_tables: Option<Vec<String>>,
    /// (child_table, child_column, parent_table) whose child column starts no
    /// index — the query shape of the "sq-unindexed-fks" DBA view.
    pub unindexed_fks: Vec<(String, String, String)>,
    /// User tables with no declared PRIMARY KEY (implicit rowid only).
    pub no_pk_tables: Vec<String>,
    /// quick_check output rows; `None` when the probe itself failed. A healthy
    /// file answers exactly ["ok"].
    pub quick_check: Option<Vec<String>>,
}

impl SqliteData {
    /// Total file size implied by the header: page_size × page_count.
    pub fn size_bytes(&self) -> u64 { self.page_size * self.page_count }
    /// Reclaimable space held on the freelist.
    pub fn freelist_bytes(&self) -> u64 { self.page_size * self.freelist_count }
    /// Fraction of the file that is free pages (0.0–1.0).
    pub fn freelist_frac(&self) -> f64 {
        if self.page_count == 0 { 0.0 } else { self.freelist_count as f64 / self.page_count as f64 }
    }
    /// Effective page-cache size in bytes, decoding the two cache_size units.
    pub fn cache_bytes(&self) -> u64 {
        if self.cache_size < 0 { (-self.cache_size) as u64 * 1024 }
        else { self.cache_size.max(0) as u64 * self.page_size.max(1) }
    }
}

async fn scalar_i64(pool: &SqlitePool, pragma: &'static str) -> i64 {
    sqlx::query_scalar::<_, i64>(pragma).fetch_one(pool).await.unwrap_or(0)
}

async fn scalar_str(pool: &SqlitePool, pragma: &'static str) -> String {
    sqlx::query_scalar::<_, String>(pragma).fetch_one(pool).await.unwrap_or_default()
}

/// String-list probe: any error degrades to an empty list.
async fn str_list(pool: &SqlitePool, sql: &'static str) -> Vec<String> {
    sqlx::query_scalar::<_, String>(sql).fetch_all(pool).await.unwrap_or_default()
}

/// The unindexed-foreign-key probe — the same query shape as the
/// "sq-unindexed-fks" DBA view: a declared FK whose child column is not the
/// first column of any index.
async fn unindexed_fks(pool: &SqlitePool) -> Vec<(String, String, String)> {
    sqlx::query_as::<_, (String, String, String)>(
        "SELECT m.name, f.\"from\", f.\"table\"
         FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
         WHERE m.type = 'table'
           AND NOT EXISTS (
             SELECT 1 FROM pragma_index_list(m.name) i
             JOIN pragma_index_xinfo(i.name) x ON x.key = 1 AND x.seqno = 0
             WHERE x.name = f.\"from\")
         ORDER BY m.name, f.id, f.seq")
        .fetch_all(pool).await.unwrap_or_default()
}

/// Tables holding planner statistics. `None` (not empty) when sqlite_stat1
/// does not exist: ANALYZE has never been run, so the check can tell
/// "never analyzed" apart from "analyzed, nothing recorded".
async fn analyzed_tables(pool: &SqlitePool) -> Option<Vec<String>> {
    sqlx::query_scalar::<_, String>("SELECT DISTINCT tbl FROM sqlite_stat1")
        .fetch_all(pool).await.ok()
}

/// quick_check reads every page of the file, so a failure or a huge result
/// degrades to `None` / a capped list rather than failing the run.
async fn quick_check(pool: &SqlitePool) -> Option<Vec<String>> {
    let mut rows: Vec<String> = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_all(pool).await.ok()?;
    rows.truncate(5);
    Some(rows)
}

/// Read the tunable facts off an open SQLite pool. Best-effort per field: a
/// PRAGMA that a given build does not answer falls back to a neutral default
/// rather than failing the whole report.
pub async fn collect(pool: &SqlitePool) -> anyhow::Result<SqliteData> {
    let version = sqlx::query_scalar::<_, String>("SELECT sqlite_version()")
        .fetch_one(pool).await.unwrap_or_default();
    Ok(SqliteData {
        version,
        page_size: scalar_i64(pool, "PRAGMA page_size").await.max(0) as u64,
        page_count: scalar_i64(pool, "PRAGMA page_count").await.max(0) as u64,
        freelist_count: scalar_i64(pool, "PRAGMA freelist_count").await.max(0) as u64,
        journal_mode: scalar_str(pool, "PRAGMA journal_mode").await.to_lowercase(),
        synchronous: scalar_i64(pool, "PRAGMA synchronous").await,
        auto_vacuum: scalar_i64(pool, "PRAGMA auto_vacuum").await,
        foreign_keys: scalar_i64(pool, "PRAGMA foreign_keys").await != 0,
        encoding: scalar_str(pool, "PRAGMA encoding").await,
        cache_size: scalar_i64(pool, "PRAGMA cache_size").await,
        user_tables: str_list(pool,
            "SELECT name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").await,
        analyzed_tables: analyzed_tables(pool).await,
        unindexed_fks: unindexed_fks(pool).await,
        no_pk_tables: str_list(pool,
            "SELECT m.name FROM sqlite_master m \
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' \
               AND (SELECT count(*) FROM pragma_table_info(m.name) p WHERE p.pk > 0) = 0 \
             ORDER BY m.name").await,
        quick_check: quick_check(pool).await,
    })
}

#[cfg(test)]
mod tests {
    //! The collector against a real file: the pragma/table-function queries
    //! must actually run on the bundled SQLite, and ANALYZE must flip
    //! `analyzed_tables` from None to Some.
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn collect_file(name: &str, setup: &'static str) -> super::SqliteData {
        let dir = std::env::temp_dir().join(format!("txui-tuner-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let _ = std::fs::remove_file(&path);
        let opts = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
        let pool = SqlitePoolOptions::new().connect_with(opts).await.unwrap();
        sqlx::raw_sql(setup).execute(&pool).await.unwrap();
        let d = super::collect(&pool).await.unwrap();
        pool.close().await;
        let _ = std::fs::remove_file(&path);
        d
    }

    #[tokio::test]
    async fn collector_reads_a_real_file() {
        let d = collect_file("tuner-basic.db",
            "CREATE TABLE parent (id INTEGER PRIMARY KEY);
             CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id));
             CREATE TABLE heap (note TEXT);
             INSERT INTO parent VALUES (1), (2);
             INSERT INTO child VALUES (1, 1), (2, 2);").await;

        assert!(!d.version.is_empty());
        assert!(d.page_size >= 512);
        assert!(d.page_count > 0);
        assert_eq!(d.user_tables, vec!["child", "heap", "parent"]);
        // ANALYZE was never run: sqlite_stat1 does not exist yet.
        assert_eq!(d.analyzed_tables, None);
        // child.pid references parent but starts no index.
        assert_eq!(d.unindexed_fks,
                   vec![("child".to_string(), "pid".to_string(), "parent".to_string())]);
        // heap has no declared PRIMARY KEY.
        assert_eq!(d.no_pk_tables, vec!["heap".to_string()]);
        // A fresh file is structurally sound.
        assert_eq!(d.quick_check, Some(vec!["ok".to_string()]));
    }

    #[tokio::test]
    async fn analyze_flips_the_planner_stats_probe() {
        let d = collect_file("tuner-analyze.db",
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
             CREATE INDEX t_v ON t(v);
             INSERT INTO t VALUES (1, 'a'), (2, 'b');
             ANALYZE;").await;

        let analyzed = d.analyzed_tables.expect("sqlite_stat1 must exist after ANALYZE");
        assert_eq!(analyzed, vec!["t".to_string()], "analyzed: {analyzed:?}");
        // The index gives planner stats something to record, and t has a PK,
        // so neither schema finding should have data behind it.
        assert!(d.unindexed_fks.is_empty());
        assert!(d.no_pk_tables.is_empty());
    }
}
