//! SQL Server tuner — data collection.
//!
//! Every probe here is a `SELECT` against `sys.*`, `msdb.dbo.backupset` or a
//! dynamic management view. Nothing is written, no configuration is changed,
//! and the remediation SQL the checks produce is generated and never executed.
//!
//! ## What this looks at, and why those things
//!
//! SQL Server's defaults are the oldest of the three engines TxUI tunes, and
//! several of them have been wrong since the 1990s and were never changed for
//! backwards compatibility. `cost threshold for parallelism` still defaults to
//! 5 — a figure calibrated against a Pentium Pro. `max server memory` still
//! defaults to "all of it", which lets the buffer pool starve the operating
//! system. Those are not exotic misconfigurations; they are what every
//! unattended instance has, which is exactly what a tuner should say out loud.
//!
//! The rest is the durability half: a database in FULL recovery whose log has
//! never been backed up grows until the disk fills, and it is the single most
//! common way a SQL Server falls over. `AUTO_SHRINK` and `AUTO_CLOSE` are the
//! two settings whose names sound helpful and are not.
//!
//! ## Collection is best-effort, one probe at a time
//!
//! A permission-denied DMV or a view that does not exist on this version must
//! not lose the whole report — the parts that worked are still worth showing.
//! Every optional probe therefore lands in an `Option`, and a `None` means "not
//! readable", which the checks treat as *no finding* rather than as a problem.
//! Reporting "no backups" because `msdb` was unreadable would be worse than
//! saying nothing.

use anyhow::Result;

use crate::db::sqlserver::{self, SqlServerSession};
use crate::db::types::QueryResult;

/// One database's settings and health.
#[derive(Debug, Clone)]
pub struct MssqlDatabase {
    pub name: String,
    pub auto_close: bool,
    pub auto_shrink: bool,
    /// CHECKSUM / TORN_PAGE_DETECTION / NONE
    pub page_verify: String,
    /// FULL / BULK_LOGGED / SIMPLE
    pub recovery_model: String,
    pub compatibility_level: i64,
    pub rcsi: bool,
    pub state: String,
    pub query_store_on: bool,
    /// Last successful full backup, as `YYYY-MM-DD HH:MM:SS`; empty if never.
    pub last_full_backup: String,
    /// Last successful log backup; empty if never. Only meaningful in FULL.
    pub last_log_backup: String,
    /// Age of the last full backup in days; `None` when there has never been one.
    pub full_backup_age_days: Option<i64>,
}

/// One data or log file.
#[derive(Debug, Clone)]
pub struct MssqlFile {
    pub database: String,
    pub name: String,
    /// ROWS / LOG
    pub file_type: String,
    pub is_percent_growth: bool,
    /// Pages when fixed, percent when `is_percent_growth`.
    pub growth: i64,
    pub size_mb: i64,
    /// 0 means unlimited.
    pub max_size_mb: i64,
}

/// The facts the checks reason over.
#[derive(Debug, Clone)]
pub struct MssqlData {
    pub version: String,
    pub product_version: String,
    pub edition: String,
    pub product_level: String,
    /// 2 = Standard, 3 = Enterprise, 5 = Azure SQL Database, 8 = Managed Instance.
    pub engine_edition: i64,
    pub machine_name: String,
    pub collation: String,
    pub uptime_secs: u64,

    pub cpu_count: i64,
    pub scheduler_count: i64,
    pub physical_memory_mb: i64,
    pub memory_in_use_mb: i64,

    /// `sys.configurations` name → value_in_use, lower-cased names.
    pub config: std::collections::HashMap<String, i64>,

    /// tempdb data file count and their sizes in MB.
    pub tempdb_files: i64,
    pub tempdb_min_mb: i64,
    pub tempdb_max_mb: i64,

    pub databases: Vec<MssqlDatabase>,
    pub files: Vec<MssqlFile>,

    /// Cached plans by objtype: (objtype, count, MB, single-use count).
    pub plan_cache: Vec<(String, i64, i64, i64)>,

    /// `None` when `sys.dm_server_services` is unreadable — common in
    /// containers, where the engine is not registered as a service.
    pub instant_file_init: Option<bool>,

    /// Virtual log file count per database; empty when `sys.dm_db_log_info`
    /// could not be read (it needs 2016+ and VIEW DATABASE STATE).
    pub vlf_counts: Vec<(String, i64)>,

    /// Indexes the optimiser wished for, best first.
    pub missing_indexes: Vec<MissingIndex>,
    /// Nonclustered indexes that cost writes and served no reads.
    pub unused_indexes: Vec<UnusedIndex>,
    /// Seconds since the index-usage counters were last reset (service start).
    ///
    /// Both of the lists above are **cumulative since startup**, so a short
    /// uptime makes an index look unused when it is merely unexercised. The
    /// checks refuse to fire below a threshold rather than reporting a number
    /// that is technically true and practically a lie.
    pub index_stats_age_secs: u64,
}

/// One entry from `sys.dm_db_missing_index_details`.
#[derive(Debug, Clone)]
pub struct MissingIndex {
    pub object: String,
    /// Columns the optimiser wanted to seek on — the leading key.
    pub equality: String,
    /// Columns it wanted to range-scan — these follow the equality columns.
    pub inequality: String,
    /// Columns it wanted alongside, to avoid going back to the table.
    pub included: String,
    /// The DMV's own `avg_total_user_cost × avg_user_impact × (seeks + scans)`.
    pub impact: f64,
    /// Estimated percentage cost reduction for the queries that wanted it.
    pub avg_impact_pct: f64,
    pub seeks: i64,
    pub scans: i64,
}

impl MissingIndex {
    /// The `CREATE INDEX` the DMV is describing.
    ///
    /// The column lists arrive already bracket-quoted (`[status], [total]`), so
    /// they are used verbatim — re-quoting them would double the brackets.
    pub fn create_sql(&self) -> String {
        let mut key = String::new();
        if !self.equality.is_empty() { key.push_str(&self.equality); }
        if !self.inequality.is_empty() {
            if !key.is_empty() { key.push_str(", "); }
            key.push_str(&self.inequality);
        }
        let name = format!(
            "ix_{}_{}",
            self.object.split('.').next_back().unwrap_or("t"),
            // A name a person can read back to the columns it covers.
            key.replace(['[', ']', ' '], "").replace(',', "_"));
        let include = if self.included.is_empty() {
            String::new()
        } else {
            format!(" INCLUDE ({})", self.included)
        };
        format!("CREATE NONCLUSTERED INDEX [{}] ON {} ({}){};",
                name.chars().take(120).collect::<String>(), self.object, key, include)
    }
}

/// One entry from `sys.dm_db_index_usage_stats`, or the absence of one.
#[derive(Debug, Clone)]
pub struct UnusedIndex {
    pub object: String,
    pub index: String,
    pub reads: i64,
    pub writes: i64,
    pub size_mb: i64,
}

impl MssqlData {
    /// A `sys.configurations` value, or the fallback when it was not readable.
    pub fn cfg(&self, name: &str, fallback: i64) -> i64 {
        *self.config.get(name).unwrap_or(&fallback)
    }

    /// The endoflife.date cycle for this build — the major version.
    ///
    /// SQL Server's product version is `16.0.4265.3` for 2022; the cycle the
    /// EOL feed uses is the marketing year, so the major number is mapped
    /// rather than passed through. An unmapped major returns the bare major,
    /// which yields no EOL data instead of a wrong date.
    pub fn cycle(&self) -> String {
        let major = self.product_version.split('.').next().unwrap_or("");
        match major {
            "16" => "2022".into(),
            "15" => "2019".into(),
            "14" => "2017".into(),
            "13" => "2016".into(),
            "12" => "2014".into(),
            "11" => "2012".into(),
            "10" => "2008".into(),
            other => other.to_string(),
        }
    }

    /// Total single-use ad-hoc plans and the memory they hold, in MB.
    pub fn adhoc_single_use(&self) -> (i64, i64) {
        self.plan_cache.iter()
            .find(|(t, _, _, _)| t.eq_ignore_ascii_case("Adhoc"))
            .map(|(_, n, mb, single)| {
                // Attribute memory proportionally: the DMV reports size per
                // objtype, not per plan, and claiming the whole Adhoc bucket is
                // single-use would overstate it whenever some plans are reused.
                let share = if *n > 0 { (*mb * *single) / *n } else { 0 };
                (*single, share)
            })
            .unwrap_or((0, 0))
    }
}

/// Text of a cell, whatever JSON shape it arrived as.
fn s(r: &crate::db::types::Row, i: usize) -> String {
    match r.get(i) {
        Some(serde_json::Value::String(v)) => v.clone(),
        Some(serde_json::Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn n(r: &crate::db::types::Row, i: usize) -> i64 {
    match r.get(i) {
        Some(serde_json::Value::Number(v)) => v.as_i64().unwrap_or(0),
        Some(serde_json::Value::String(v)) => v.parse().unwrap_or(0),
        Some(serde_json::Value::Bool(b)) => i64::from(*b),
        _ => 0,
    }
}

fn f(r: &crate::db::types::Row, i: usize) -> f64 {
    match r.get(i) {
        Some(serde_json::Value::Number(v)) => v.as_f64().unwrap_or(0.0),
        Some(serde_json::Value::String(v)) => v.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn b(r: &crate::db::types::Row, i: usize) -> bool {
    match r.get(i) {
        Some(serde_json::Value::Bool(v)) => *v,
        Some(serde_json::Value::Number(v)) => v.as_i64().unwrap_or(0) != 0,
        Some(serde_json::Value::String(v)) => v == "1" || v.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// Run one optional probe; a failure yields `None` rather than aborting.
async fn maybe(session: &SqlServerSession, sql: &str) -> Option<QueryResult> {
    sqlserver::execute(session, sql).await.ok()
}

pub async fn collect(session: &SqlServerSession) -> Result<MssqlData> {
    // ── identity ─────────────────────────────────────────────────────────
    // Everything here is a SERVERPROPERTY, which needs no special permission —
    // so if this fails, nothing else will work either and the error is worth
    // propagating rather than swallowing.
    let ident = sqlserver::execute(session, "SELECT \
        CONVERT(varchar(200), @@VERSION), \
        CONVERT(varchar(50), SERVERPROPERTY('ProductVersion')), \
        CONVERT(varchar(120), SERVERPROPERTY('Edition')), \
        CONVERT(varchar(30), SERVERPROPERTY('ProductLevel')), \
        CONVERT(int, SERVERPROPERTY('EngineEdition')), \
        CONVERT(varchar(60), SERVERPROPERTY('MachineName')), \
        CONVERT(varchar(60), SERVERPROPERTY('Collation'))").await?;
    let ir = ident.rows.first().cloned().unwrap_or_default();

    // ── hardware and uptime ──────────────────────────────────────────────
    // dm_os_sys_info needs VIEW SERVER STATE; without it the report still has
    // the configuration half, so zeros here mean "unknown" and the checks that
    // depend on a CPU count simply do not fire.
    let sys = maybe(session, "SELECT cpu_count, scheduler_count, \
        physical_memory_kb / 1024, \
        DATEDIFF(second, sqlserver_start_time, GETDATE()) \
        FROM sys.dm_os_sys_info").await;
    let sr = sys.and_then(|r| r.rows.first().cloned()).unwrap_or_default();

    let mem = maybe(session, "SELECT physical_memory_in_use_kb / 1024 FROM sys.dm_os_process_memory").await;
    let memory_in_use_mb = mem.and_then(|r| r.rows.first().map(|row| n(row, 0))).unwrap_or(0);

    // ── configuration ────────────────────────────────────────────────────
    // sys.configurations is readable by anyone; `value_in_use` rather than
    // `value` because a changed-but-not-reconfigured setting is not in effect.
    let mut config = std::collections::HashMap::new();
    if let Some(r) = maybe(session,
        "SELECT LOWER(name), CONVERT(bigint, value_in_use) FROM sys.configurations").await
    {
        for row in &r.rows {
            config.insert(s(row, 0), n(row, 1));
        }
    }

    // ── tempdb ───────────────────────────────────────────────────────────
    let tempdb = maybe(session, "SELECT COUNT(*), \
        ISNULL(MIN(CONVERT(bigint, size)) * 8 / 1024, 0), \
        ISNULL(MAX(CONVERT(bigint, size)) * 8 / 1024, 0) \
        FROM sys.master_files WHERE database_id = 2 AND type = 0").await;
    let tr = tempdb.and_then(|r| r.rows.first().cloned()).unwrap_or_default();

    // ── databases, with their last backups ───────────────────────────────
    // The LEFT JOIN to msdb keeps a database with no backup history in the
    // list; an INNER JOIN would silently drop exactly the ones that matter.
    // `database_id > 4` skips master/tempdb/model/msdb: their settings are not
    // the user's to tune, and tempdb has no backups by design.
    let mut databases = Vec::new();
    if let Some(r) = maybe(session, "SELECT d.name, \
        CONVERT(int, d.is_auto_close_on), CONVERT(int, d.is_auto_shrink_on), \
        d.page_verify_option_desc, d.recovery_model_desc, d.compatibility_level, \
        CONVERT(int, d.is_read_committed_snapshot_on), d.state_desc, \
        CONVERT(int, d.is_query_store_on), \
        ISNULL(CONVERT(varchar(30), bk.last_full, 120), ''), \
        ISNULL(CONVERT(varchar(30), bk.last_log, 120), ''), \
        ISNULL(DATEDIFF(day, bk.last_full, GETDATE()), -1) \
        FROM sys.databases d \
        OUTER APPLY (SELECT MAX(CASE WHEN b.type = 'D' THEN b.backup_finish_date END) AS last_full, \
                            MAX(CASE WHEN b.type = 'L' THEN b.backup_finish_date END) AS last_log \
                     FROM msdb.dbo.backupset b WHERE b.database_name = d.name) bk \
        WHERE d.database_id > 4 \
        ORDER BY d.name").await
    {
        for row in &r.rows {
            let age = n(row, 11);
            databases.push(MssqlDatabase {
                name: s(row, 0),
                auto_close: b(row, 1),
                auto_shrink: b(row, 2),
                page_verify: s(row, 3),
                recovery_model: s(row, 4),
                compatibility_level: n(row, 5),
                rcsi: b(row, 6),
                state: s(row, 7),
                query_store_on: b(row, 8),
                last_full_backup: s(row, 9),
                last_log_backup: s(row, 10),
                full_backup_age_days: if age < 0 { None } else { Some(age) },
            });
        }
    }

    // ── files and their growth settings ──────────────────────────────────
    let mut files = Vec::new();
    if let Some(r) = maybe(session, "SELECT DB_NAME(database_id), name, type_desc, \
        CONVERT(int, is_percent_growth), CONVERT(bigint, growth), \
        CONVERT(bigint, size) * 8 / 1024, \
        CASE WHEN max_size <= 0 THEN 0 ELSE CONVERT(bigint, max_size) * 8 / 1024 END \
        FROM sys.master_files WHERE database_id > 4").await
    {
        for row in &r.rows {
            files.push(MssqlFile {
                database: s(row, 0),
                name: s(row, 1),
                file_type: s(row, 2),
                is_percent_growth: b(row, 3),
                growth: n(row, 4),
                size_mb: n(row, 5),
                max_size_mb: n(row, 6),
            });
        }
    }

    // ── plan cache ───────────────────────────────────────────────────────
    let mut plan_cache = Vec::new();
    if let Some(r) = maybe(session, "SELECT objtype, COUNT(*), \
        SUM(CONVERT(bigint, size_in_bytes)) / 1048576, \
        SUM(CASE WHEN usecounts = 1 THEN 1 ELSE 0 END) \
        FROM sys.dm_exec_cached_plans GROUP BY objtype").await
    {
        for row in &r.rows {
            plan_cache.push((s(row, 0), n(row, 1), n(row, 2), n(row, 3)));
        }
    }

    // ── instant file initialization ──────────────────────────────────────
    // `sys.dm_server_services` lists the engine only when it is registered as
    // one, which it is not in a container — so a missing row is "unknown", not
    // "disabled". Saying IFI is off when it could not be checked would send
    // someone chasing a Windows privilege on a Linux host.
    let instant_file_init = maybe(session,
        "SELECT instant_file_initialization_enabled FROM sys.dm_server_services \
         WHERE servicename LIKE 'SQL Server (%'").await
        .and_then(|r| r.rows.first().map(|row| s(row, 0).eq_ignore_ascii_case("Y")));

    // ── virtual log files ────────────────────────────────────────────────
    // One call per database: `sys.dm_db_log_info` is a function of a database
    // id, and there is no all-databases form. Bounded to the user databases
    // already collected, so the cost is proportional to what the report shows.
    let mut vlf_counts = Vec::new();
    for db in &databases {
        if db.state != "ONLINE" { continue; }
        let sql = format!(
            "SELECT COUNT(*) FROM sys.dm_db_log_info(DB_ID({}))",
            sqlserver::tsql_literal(&db.name));
        if let Some(r) = maybe(session, &sql).await {
            if let Some(row) = r.rows.first() {
                vlf_counts.push((db.name.clone(), n(row, 0)));
            }
        }
    }

    // ── indexes the optimiser wished for ─────────────────────────────────
    // These are per-query suggestions and are NOT deduplicated against each
    // other or against existing indexes — see the check, which says so rather
    // than handing over a list to apply blindly.
    let mut missing_indexes = Vec::new();
    if let Some(r) = maybe(session, "SELECT TOP (20) \
        OBJECT_SCHEMA_NAME(mid.object_id) + '.' + OBJECT_NAME(mid.object_id), \
        ISNULL(mid.equality_columns, ''), ISNULL(mid.inequality_columns, ''), \
        ISNULL(mid.included_columns, ''), \
        CONVERT(float, migs.avg_total_user_cost * migs.avg_user_impact \
                       * (migs.user_seeks + migs.user_scans)), \
        CONVERT(float, migs.avg_user_impact), \
        migs.user_seeks, migs.user_scans \
        FROM sys.dm_db_missing_index_group_stats migs \
        JOIN sys.dm_db_missing_index_groups mig ON mig.index_group_handle = migs.group_handle \
        JOIN sys.dm_db_missing_index_details mid ON mid.index_handle = mig.index_handle \
        WHERE mid.database_id = DB_ID() \
        ORDER BY 5 DESC").await
    {
        for row in &r.rows {
            missing_indexes.push(MissingIndex {
                object: s(row, 0),
                equality: s(row, 1),
                inequality: s(row, 2),
                included: s(row, 3),
                impact: f(row, 4),
                avg_impact_pct: f(row, 5),
                seeks: n(row, 6),
                scans: n(row, 7),
            });
        }
    }

    // ── indexes that only cost ───────────────────────────────────────────
    let mut unused_indexes = Vec::new();
    if let Some(r) = maybe(session, "SELECT TOP (20) \
        sch.name + '.' + t.name, i.name, \
        ISNULL(us.user_seeks, 0) + ISNULL(us.user_scans, 0) + ISNULL(us.user_lookups, 0), \
        ISNULL(us.user_updates, 0), \
        ISNULL((SELECT SUM(ps.used_page_count) * 8 / 1024 FROM sys.dm_db_partition_stats ps \
                WHERE ps.object_id = i.object_id AND ps.index_id = i.index_id), 0) \
        FROM sys.indexes i \
        JOIN sys.tables t ON t.object_id = i.object_id \
        JOIN sys.schemas sch ON sch.schema_id = t.schema_id \
        LEFT JOIN sys.dm_db_index_usage_stats us \
          ON us.object_id = i.object_id AND us.index_id = i.index_id \
         AND us.database_id = DB_ID() \
        WHERE i.type_desc = 'NONCLUSTERED' \
          AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 \
          AND t.is_ms_shipped = 0 \
          AND ISNULL(us.user_seeks, 0) + ISNULL(us.user_scans, 0) \
              + ISNULL(us.user_lookups, 0) = 0 \
          AND ISNULL(us.user_updates, 0) > 0 \
        ORDER BY 4 DESC").await
    {
        for row in &r.rows {
            unused_indexes.push(UnusedIndex {
                object: s(row, 0), index: s(row, 1),
                reads: n(row, 2), writes: n(row, 3), size_mb: n(row, 4),
            });
        }
    }

    Ok(MssqlData {
        version: s(&ir, 0).lines().next().unwrap_or_default().trim().to_string(),
        product_version: s(&ir, 1),
        edition: s(&ir, 2),
        product_level: s(&ir, 3),
        engine_edition: n(&ir, 4),
        machine_name: s(&ir, 5),
        collation: s(&ir, 6),
        uptime_secs: n(&sr, 3).max(0) as u64,
        cpu_count: n(&sr, 0),
        scheduler_count: n(&sr, 1),
        physical_memory_mb: n(&sr, 2),
        memory_in_use_mb,
        config,
        tempdb_files: n(&tr, 0),
        tempdb_min_mb: n(&tr, 1),
        tempdb_max_mb: n(&tr, 2),
        databases,
        files,
        plan_cache,
        instant_file_init,
        vlf_counts,
        missing_indexes,
        unused_indexes,
        // The usage counters live as long as the instance does, so uptime IS
        // their age.
        index_stats_age_secs: n(&sr, 3).max(0) as u64,
    })
}
