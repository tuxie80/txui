//! Read-only data collection for the PostgreSQL tuner.
//!
//! Mirrors the discipline of the MySQL twin in `collectors.rs`: only
//! `pg_settings` and `version()` are required; every other probe is
//! failure-tolerant, so a restricted role, a managed-cloud instance that hides
//! catalogs, or an older major version degrades the affected checks rather
//! than failing the whole report.
//!
//! Version sensitivity is explicit — checkpoint counters moved from
//! `pg_stat_bgwriter` to `pg_stat_checkpointer` in PG 17, and naming a column
//! that does not exist fails the entire statement, not just that column.

use sqlx::AssertSqlSafe;
use std::collections::HashMap;

use sqlx::{PgPool, Row};

#[derive(Debug, Clone, Default)]
pub struct PgRole {
    pub name: String,
    pub superuser: bool,
    pub can_login: bool,
    /// No `VALID UNTIL` — the password never expires.
    pub no_expiry: bool,
    /// rolpassword IS NULL: no password set at all (relies on hba alone).
    pub no_password: bool,
    /// Password stored as an md5 hash rather than SCRAM.
    pub md5_password: bool,
}

#[derive(Debug, Clone, Default)]
pub struct PgTableStat {
    pub name: String,
    pub live: i64,
    pub dead: i64,
    pub seq_scan: i64,
    pub seq_tup_read: i64,
    /// Age in seconds of the most recent vacuum/autovacuum; None = never vacuumed.
    pub vacuum_age_secs: Option<i64>,
}

/// A table whose dead tuples outrun its effective autovacuum threshold
/// (global settings, per-table reloptions override): autovacuum is behind.
#[derive(Debug, Clone, Default)]
pub struct PgVacuumLaggard {
    pub name: String,
    pub live: i64,
    pub dead: i64,
    /// threshold + scale_factor × live tuples, per-table reloptions honored.
    pub threshold: i64,
    pub vacuum_age_secs: Option<i64>,
}

/// An index that looks bloated. `leaf_density` is the REAL measurement from
/// pgstattuple's pgstatindex (avg_leaf_density), present only when the
/// extension is installed and the index is small enough to scan.
#[derive(Debug, Clone, Default)]
pub struct PgIndexBloat {
    pub name: String,        // "schema.index"
    pub size_bytes: u64,
    pub table_bytes: u64,    // owning heap — index larger than heap is the heuristic signal
    pub leaf_density: Option<f64>,
}

/// Everything the PostgreSQL checks need. Optionals mean "could not be
/// collected"; the corresponding check degrades to info instead of guessing.
#[derive(Debug, Default)]
pub struct PgTunerData {
    /// pg_settings: name → current value (raw, unconverted).
    pub settings: HashMap<String, String>,
    /// pg_settings: name → unit ("8kB", "kB", "ms", "s", …), empty when none.
    pub units: HashMap<String, String>,
    /// Settings whose change is staged but needs a restart.
    pub pending_restart: Vec<String>,

    pub version: String,
    pub version_num: i32,
    pub major: u32,
    pub uptime_secs: u64,
    pub in_recovery: bool,
    /// "aws-rds" | "aws-aurora" | "gcp-cloudsql" | "azure" | None
    pub cloud: Option<String>,

    // ── Cluster-wide activity (summed across databases) ─────────────────
    pub blks_hit: u64,
    pub blks_read: u64,
    pub xact_commit: u64,
    pub xact_rollback: u64,
    pub deadlocks: u64,
    pub temp_files: u64,
    pub temp_bytes: u64,

    pub conns: u32,
    pub idle_in_txn: u32,
    pub max_idle_in_txn_secs: u64,
    pub db_bytes: u64,

    /// Checkpoints since stats reset: (timed, requested).
    pub ckpt_timed: u64,
    pub ckpt_req: u64,

    // ── Security ────────────────────────────────────────────────────────
    /// None = pg_authid unreadable (not superuser) → account checks degrade.
    pub roles: Option<Vec<PgRole>>,
    /// pg_hba_file_rules: auth_method → rule count. None = unreadable.
    pub hba: Option<Vec<(String, u32)>>,
    pub ssl_in_use: bool,
    pub extensions: Vec<String>,
    /// PUBLIC still holds CREATE on schema public (the pre-PG-15 default).
    pub public_create: Option<bool>,

    // ── Schema health ───────────────────────────────────────────────────
    pub tables_total: u64,
    pub tables_no_pk: u64,
    pub no_pk_sample: Vec<String>,
    pub never_analyzed: u64,
    pub unused_idx: u64,
    pub unused_idx_bytes: u64,
    pub unused_idx_sample: Vec<String>,
    pub dup_idx: u64,
    /// Tables whose dead tuples exceed the bloat threshold, worst first.
    pub bloated: Vec<PgTableStat>,
    /// Large tables taking sequential scans, worst first.
    pub seqscan: Vec<PgTableStat>,
    /// Tables where dead tuples exceed 1.5× the effective autovacuum
    /// threshold — autovacuum is configured to allow this and still behind.
    pub vacuum_laggards: Vec<PgVacuumLaggard>,
    /// Large indexes bigger than their heap (bloat heuristic), worst first.
    pub bloated_indexes: Vec<PgIndexBloat>,
    /// pgstattuple extension installed → real index bloat % via pgstatindex.
    pub pgstattuple_installed: bool,

    // ── Resilience ──────────────────────────────────────────────────────
    pub max_db_age: i64,
    pub max_table_age: i64,
    pub slots_total: u32,
    pub slots_inactive: u32,
    pub slot_retained_bytes: u64,
    pub replica_count: u32,
    pub max_replica_lag_bytes: u64,
}

impl PgTunerData {
    pub fn cycle(&self) -> String { self.major.to_string() }

    pub fn at_least(&self, major: u32) -> bool { self.major >= major }

    pub fn s(&self, key: &str) -> Option<&str> { self.settings.get(key).map(String::as_str) }
    pub fn su(&self, key: &str) -> Option<u64> { self.s(key)?.parse().ok() }
    pub fn sf(&self, key: &str) -> Option<f64> { self.s(key)?.parse().ok() }

    /// on/off setting → bool.
    pub fn sb(&self, key: &str) -> Option<bool> {
        match self.s(key)?.to_ascii_lowercase().as_str() {
            "on" | "true" | "yes" | "1" => Some(true),
            "off" | "false" | "no" | "0" => Some(false),
            _ => None,
        }
    }

    /// Setting converted to bytes using its declared unit. PostgreSQL reports
    /// memory settings in odd units — `shared_buffers` is a count of 8 kB
    /// blocks, `work_mem` is kB — so the raw number is meaningless alone.
    pub fn bytes(&self, key: &str) -> Option<u64> {
        let raw: f64 = self.s(key)?.parse().ok()?;
        let unit = self.units.get(key).map(String::as_str).unwrap_or("");
        let mult = unit_bytes(unit)?;
        Some((raw * mult as f64) as u64)
    }

    /// Setting converted to milliseconds using its declared unit.
    pub fn millis(&self, key: &str) -> Option<u64> {
        let raw: f64 = self.s(key)?.parse().ok()?;
        let mult = match self.units.get(key).map(String::as_str).unwrap_or("ms") {
            "ms" => 1.0,
            "s" => 1000.0,
            "min" => 60_000.0,
            "h" => 3_600_000.0,
            "d" => 86_400_000.0,
            _ => return None,
        };
        Some((raw * mult) as u64)
    }

    pub fn cache_hit_pct(&self) -> Option<f64> {
        let total = self.blks_hit + self.blks_read;
        if total == 0 { return None; }
        Some(self.blks_hit as f64 * 100.0 / total as f64)
    }
}

/// Bytes per unit for pg_settings memory units ("8kB" = 8192, "kB" = 1024…).
fn unit_bytes(unit: &str) -> Option<u64> {
    if unit.is_empty() { return Some(1); }
    let (mult_str, base) = unit.split_at(unit.len() - unit.trim_start_matches(char::is_numeric).len());
    let mult: u64 = if mult_str.is_empty() { 1 } else { mult_str.parse().ok()? };
    let base_bytes = match base {
        "B"  => 1,
        "kB" => 1024,
        "MB" => 1024 * 1024,
        "GB" => 1024 * 1024 * 1024,
        "TB" => 1024_u64.pow(4),
        _ => return None,
    };
    Some(mult * base_bytes)
}

/// One value from a single-row query, best-effort.
async fn scalar<T>(pool: &PgPool, sql: &str) -> Option<T>
where
    T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin,
{
    sqlx::query_scalar::<_, T>(AssertSqlSafe(sql)).fetch_one(pool).await.ok()
}

pub async fn collect(pool: &PgPool) -> anyhow::Result<PgTunerData> {
    let mut d = PgTunerData::default();

    // ── Required: settings + version ────────────────────────────────────
    let rows = sqlx::query("SELECT name, setting, COALESCE(unit,''), pending_restart FROM pg_settings")
        .fetch_all(pool).await?;
    for r in &rows {
        let name: String = r.try_get(0).unwrap_or_default();
        let setting: String = r.try_get(1).unwrap_or_default();
        let unit: String = r.try_get(2).unwrap_or_default();
        let pending: bool = r.try_get(3).unwrap_or(false);
        if pending { d.pending_restart.push(name.clone()); }
        if !unit.is_empty() { d.units.insert(name.clone(), unit); }
        d.settings.insert(name, setting);
    }

    d.version = scalar::<String>(pool, "SELECT version()").await.unwrap_or_default();
    d.version_num = d.s("server_version_num").and_then(|s| s.parse().ok()).unwrap_or(0);
    d.major = (d.version_num / 10_000).max(0) as u32;
    d.uptime_secs = scalar::<i64>(pool, "SELECT extract(epoch FROM now()-pg_postmaster_start_time())::bigint")
        .await.unwrap_or(0).max(0) as u64;
    d.in_recovery = scalar::<bool>(pool, "SELECT pg_is_in_recovery()").await.unwrap_or(false);
    d.cloud = detect_cloud(&d);

    // ── Cluster activity ────────────────────────────────────────────────
    if let Ok(r) = sqlx::query(
        "SELECT COALESCE(sum(blks_hit),0)::bigint, COALESCE(sum(blks_read),0)::bigint, \
                COALESCE(sum(xact_commit),0)::bigint, COALESCE(sum(xact_rollback),0)::bigint, \
                COALESCE(sum(deadlocks),0)::bigint, COALESCE(sum(temp_files),0)::bigint, \
                COALESCE(sum(temp_bytes),0)::bigint \
         FROM pg_stat_database"
    ).fetch_one(pool).await {
        d.blks_hit      = r.try_get::<i64, _>(0).unwrap_or(0).max(0) as u64;
        d.blks_read     = r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u64;
        d.xact_commit   = r.try_get::<i64, _>(2).unwrap_or(0).max(0) as u64;
        d.xact_rollback = r.try_get::<i64, _>(3).unwrap_or(0).max(0) as u64;
        d.deadlocks     = r.try_get::<i64, _>(4).unwrap_or(0).max(0) as u64;
        d.temp_files    = r.try_get::<i64, _>(5).unwrap_or(0).max(0) as u64;
        d.temp_bytes    = r.try_get::<i64, _>(6).unwrap_or(0).max(0) as u64;
    }

    if let Ok(r) = sqlx::query(
        "SELECT count(*)::bigint, \
                count(*) FILTER (WHERE state = 'idle in transaction')::bigint, \
                COALESCE(max(extract(epoch FROM now()-xact_start)) \
                         FILTER (WHERE state = 'idle in transaction'), 0)::bigint \
         FROM pg_stat_activity WHERE backend_type = 'client backend'"
    ).fetch_one(pool).await {
        d.conns                = r.try_get::<i64, _>(0).unwrap_or(0).max(0) as u32;
        d.idle_in_txn          = r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u32;
        d.max_idle_in_txn_secs = r.try_get::<i64, _>(2).unwrap_or(0).max(0) as u64;
    }

    d.db_bytes = scalar::<i64>(pool,
        "SELECT COALESCE(sum(pg_database_size(datname)),0)::bigint FROM pg_database WHERE datallowconn")
        .await.unwrap_or(0).max(0) as u64;

    // ── Checkpoints: the counters moved to pg_stat_checkpointer in PG 17 ─
    let ckpt_sql = if d.at_least(17) {
        "SELECT num_timed::bigint, num_requested::bigint FROM pg_stat_checkpointer"
    } else {
        "SELECT checkpoints_timed::bigint, checkpoints_req::bigint FROM pg_stat_bgwriter"
    };
    if let Ok(r) = sqlx::query(ckpt_sql).fetch_one(pool).await {
        d.ckpt_timed = r.try_get::<i64, _>(0).unwrap_or(0).max(0) as u64;
        d.ckpt_req   = r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u64;
    }

    // ── Security ────────────────────────────────────────────────────────
    // pg_authid needs superuser; pg_roles alone cannot reveal password shape.
    if let Ok(rows) = sqlx::query(
        "SELECT r.rolname, r.rolsuper, r.rolcanlogin, r.rolvaliduntil IS NULL, \
                a.rolpassword IS NULL, COALESCE(a.rolpassword LIKE 'md5%', false) \
         FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid \
         ORDER BY r.rolname"
    ).fetch_all(pool).await {
        d.roles = Some(rows.iter().map(|r| PgRole {
            name:         r.try_get(0).unwrap_or_default(),
            superuser:    r.try_get(1).unwrap_or(false),
            can_login:    r.try_get(2).unwrap_or(false),
            no_expiry:    r.try_get(3).unwrap_or(true),
            no_password:  r.try_get(4).unwrap_or(false),
            md5_password: r.try_get(5).unwrap_or(false),
        }).collect());
    }

    if let Ok(rows) = sqlx::query(
        "SELECT auth_method, count(*)::bigint FROM pg_hba_file_rules \
         WHERE auth_method IS NOT NULL GROUP BY 1"
    ).fetch_all(pool).await {
        d.hba = Some(rows.iter().map(|r| (
            r.try_get::<String, _>(0).unwrap_or_default(),
            r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u32,
        )).collect());
    }

    d.ssl_in_use = scalar::<bool>(pool,
        "SELECT COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false)")
        .await.unwrap_or(false);

    if let Ok(rows) = sqlx::query_scalar::<_, String>("SELECT extname FROM pg_extension ORDER BY 1")
        .fetch_all(pool).await { d.extensions = rows; }

    d.public_create = scalar::<bool>(pool, "SELECT has_schema_privilege('public', 'public', 'CREATE')").await;

    // ── Schema health ───────────────────────────────────────────────────
    const USER_NS: &str = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'";

    d.tables_total = scalar::<i64>(pool, &format!(
        "SELECT count(*)::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ('r','p') AND {USER_NS}"))
        .await.unwrap_or(0).max(0) as u64;

    if let Ok(rows) = sqlx::query(AssertSqlSafe(format!(
        "SELECT n.nspname || '.' || c.relname FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind = 'r' AND {USER_NS} \
           AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) \
         ORDER BY pg_total_relation_size(c.oid) DESC")
)).fetch_all(pool).await {
        d.tables_no_pk = rows.len() as u64;
        d.no_pk_sample = rows.iter().take(5).filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
    }

    d.never_analyzed = scalar::<i64>(pool,
        "SELECT count(*)::bigint FROM pg_stat_user_tables \
         WHERE last_analyze IS NULL AND last_autoanalyze IS NULL")
        .await.unwrap_or(0).max(0) as u64;

    // Unused secondary indexes. PK/unique indexes are excluded: they enforce
    // a constraint, so a zero scan count is not a reason to drop them.
    if let Ok(r) = sqlx::query(
        "SELECT count(*)::bigint, COALESCE(sum(pg_relation_size(s.indexrelid)),0)::bigint \
         FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid \
         WHERE s.idx_scan = 0 AND NOT i.indisprimary AND NOT i.indisunique"
    ).fetch_one(pool).await {
        d.unused_idx       = r.try_get::<i64, _>(0).unwrap_or(0).max(0) as u64;
        d.unused_idx_bytes = r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u64;
    }
    if let Ok(rows) = sqlx::query_scalar::<_, String>(
        "SELECT s.schemaname || '.' || s.indexrelname \
         FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid \
         WHERE s.idx_scan = 0 AND NOT i.indisprimary AND NOT i.indisunique \
         ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 5"
    ).fetch_all(pool).await { d.unused_idx_sample = rows; }

    d.dup_idx = scalar::<i64>(pool,
        "SELECT count(*)::bigint FROM ( \
           SELECT indrelid, indkey::text FROM pg_index GROUP BY 1, 2 HAVING count(*) > 1) t")
        .await.unwrap_or(0).max(0) as u64;

    if let Ok(rows) = sqlx::query(
        "SELECT schemaname || '.' || relname, n_live_tup, n_dead_tup, \
                EXTRACT(EPOCH FROM now() - GREATEST(last_vacuum, last_autovacuum))::bigint \
         FROM pg_stat_user_tables \
         WHERE n_live_tup > 1000 AND n_dead_tup > n_live_tup * 0.2 \
         ORDER BY n_dead_tup DESC LIMIT 10"
    ).fetch_all(pool).await {
        d.bloated = rows.iter().map(|r| PgTableStat {
            name: r.try_get(0).unwrap_or_default(),
            live: r.try_get(1).unwrap_or(0),
            dead: r.try_get(2).unwrap_or(0),
            vacuum_age_secs: r.try_get::<Option<i64>, _>(3).unwrap_or(None),
            ..Default::default()
        }).collect();
    }

    // Autovacuum backlog: dead tuples vs the table's EFFECTIVE threshold
    // (per-table reloptions override the global settings — same shape as the
    // dbaViews 'Autovacuum backlog vs threshold' view).
    if let Ok(rows) = sqlx::query(
        "WITH t AS ( \
           SELECT s.schemaname || '.' || s.relname AS name, s.n_live_tup, s.n_dead_tup, \
                  (COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions) \
                             WHERE option_name = 'autovacuum_vacuum_threshold'), \
                            current_setting('autovacuum_vacuum_threshold'))::numeric \
                 + COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions) \
                             WHERE option_name = 'autovacuum_vacuum_scale_factor'), \
                            current_setting('autovacuum_vacuum_scale_factor'))::numeric \
                   * s.n_live_tup)::bigint AS threshold, \
                  EXTRACT(EPOCH FROM now() - GREATEST(s.last_vacuum, s.last_autovacuum))::bigint AS vacuum_age \
           FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid) \
         SELECT name, n_live_tup, n_dead_tup, threshold, vacuum_age FROM t \
         WHERE threshold > 0 AND n_dead_tup > threshold * 1.5 \
         ORDER BY n_dead_tup::numeric / threshold DESC LIMIT 10"
    ).fetch_all(pool).await {
        d.vacuum_laggards = rows.iter().map(|r| PgVacuumLaggard {
            name: r.try_get(0).unwrap_or_default(),
            live: r.try_get(1).unwrap_or(0),
            dead: r.try_get(2).unwrap_or(0),
            threshold: r.try_get(3).unwrap_or(0),
            vacuum_age_secs: r.try_get::<Option<i64>, _>(4).unwrap_or(None),
        }).collect();
    }

    // Index bloat. Without pgstattuple there is no exact number, so the
    // heuristic flags large indexes bigger than the heap they serve — a
    // healthy secondary index is normally a fraction of its table.
    d.pgstattuple_installed = d.extensions.iter().any(|e| e == "pgstattuple");
    if let Ok(rows) = sqlx::query(
        "SELECT s.schemaname || '.' || s.indexrelname, \
                pg_relation_size(s.indexrelid)::bigint, pg_relation_size(s.relid)::bigint \
         FROM pg_stat_user_indexes s \
         WHERE pg_relation_size(s.indexrelid) >= 67108864 \
           AND pg_relation_size(s.indexrelid) > pg_relation_size(s.relid) \
         ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 10"
    ).fetch_all(pool).await {
        d.bloated_indexes = rows.iter().map(|r| PgIndexBloat {
            name: r.try_get(0).unwrap_or_default(),
            size_bytes: r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u64,
            table_bytes: r.try_get::<i64, _>(2).unwrap_or(0).max(0) as u64,
            leaf_density: None,
        }).collect();
    }

    // With pgstattuple installed, measure the flagged indexes for real:
    // pgstatindex's avg_leaf_density is the percentage of each leaf page
    // actually holding tuples. It scans the whole index, so cap the effort —
    // 5 indexes, 4 GiB each — and tolerate privilege errors (pgstatindex
    // needs superuser / pg_read_all_stats on older majors).
    if d.pgstattuple_installed {
        const MAX_SCAN: u64 = 4 * 1024 * 1024 * 1024;
        for idx in d.bloated_indexes.iter_mut().take(5) {
            if idx.size_bytes > MAX_SCAN { continue; }
            let escaped = idx.name.replace('\'', "''");
            // avg_leaf_density is float4 — cast so the f64 decode is valid.
            idx.leaf_density = scalar::<f64>(pool,
                &format!("SELECT avg_leaf_density::float8 FROM pgstatindex('{escaped}')")).await;
        }
    }

    if let Ok(rows) = sqlx::query(
        "SELECT schemaname || '.' || relname, n_live_tup, seq_scan, seq_tup_read \
         FROM pg_stat_user_tables \
         WHERE seq_scan > 50 AND n_live_tup > 50000 \
           AND seq_tup_read > COALESCE(idx_tup_fetch, 0) \
         ORDER BY seq_tup_read DESC LIMIT 10"
    ).fetch_all(pool).await {
        d.seqscan = rows.iter().map(|r| PgTableStat {
            name: r.try_get(0).unwrap_or_default(),
            live: r.try_get(1).unwrap_or(0),
            seq_scan: r.try_get(2).unwrap_or(0),
            seq_tup_read: r.try_get(3).unwrap_or(0),
            ..Default::default()
        }).collect();
    }

    // ── Resilience ──────────────────────────────────────────────────────
    d.max_db_age = scalar::<i64>(pool, "SELECT COALESCE(max(age(datfrozenxid)),0)::bigint FROM pg_database")
        .await.unwrap_or(0);
    d.max_table_age = scalar::<i64>(pool,
        "SELECT COALESCE(max(age(relfrozenxid)),0)::bigint FROM pg_class WHERE relkind IN ('r','m','t')")
        .await.unwrap_or(0);

    if let Ok(r) = sqlx::query(
        "SELECT count(*)::bigint, count(*) FILTER (WHERE NOT active)::bigint, \
                COALESCE(max(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)), 0)::bigint \
         FROM pg_replication_slots"
    ).fetch_one(pool).await {
        d.slots_total          = r.try_get::<i64, _>(0).unwrap_or(0).max(0) as u32;
        d.slots_inactive       = r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u32;
        d.slot_retained_bytes  = r.try_get::<i64, _>(2).unwrap_or(0).max(0) as u64;
    }

    if let Ok(r) = sqlx::query(
        "SELECT count(*)::bigint, \
                COALESCE(max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)), 0)::bigint \
         FROM pg_stat_replication"
    ).fetch_one(pool).await {
        d.replica_count         = r.try_get::<i64, _>(0).unwrap_or(0).max(0) as u32;
        d.max_replica_lag_bytes = r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u64;
    }

    Ok(d)
}

/// Managed-provider fingerprints. Each provider injects settings no vanilla
/// build has, which is more reliable than parsing version().
fn detect_cloud(d: &PgTunerData) -> Option<String> {
    if d.settings.keys().any(|k| k.starts_with("rds.")) {
        // Aurora reports itself through an extra setting/function.
        if d.settings.contains_key("aurora_stat_utils.enabled")
            || d.version.to_lowercase().contains("aurora") {
            return Some("aws-aurora".into());
        }
        return Some("aws-rds".into());
    }
    if d.settings.keys().any(|k| k.starts_with("cloudsql.")) { return Some("gcp-cloudsql".into()); }
    if d.settings.keys().any(|k| k.starts_with("azure.")) { return Some("azure".into()); }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_convert_to_bytes() {
        // PostgreSQL reports shared_buffers in 8 kB blocks and work_mem in kB,
        // so the raw setting number is meaningless without its unit.
        assert_eq!(unit_bytes("8kB"), Some(8192));
        assert_eq!(unit_bytes("16kB"), Some(16384));
        assert_eq!(unit_bytes("kB"), Some(1024));
        assert_eq!(unit_bytes("MB"), Some(1024 * 1024));
        assert_eq!(unit_bytes("GB"), Some(1024 * 1024 * 1024));
        assert_eq!(unit_bytes("B"), Some(1));
        assert_eq!(unit_bytes(""), Some(1));
        assert_eq!(unit_bytes("ms"), None); // time units are not bytes
    }

    fn data(pairs: &[(&str, &str, &str)]) -> PgTunerData {
        let mut d = PgTunerData::default();
        for (k, v, u) in pairs {
            d.settings.insert((*k).into(), (*v).into());
            if !u.is_empty() { d.units.insert((*k).into(), (*u).into()); }
        }
        d
    }

    #[test]
    fn bytes_applies_the_declared_unit() {
        let d = data(&[
            ("shared_buffers", "16384", "8kB"),   // 128 MiB
            ("work_mem", "4096", "kB"),           // 4 MiB
            ("max_wal_size", "1024", "MB"),       // 1 GiB
        ]);
        assert_eq!(d.bytes("shared_buffers"), Some(128 * 1024 * 1024));
        assert_eq!(d.bytes("work_mem"), Some(4 * 1024 * 1024));
        assert_eq!(d.bytes("max_wal_size"), Some(1024 * 1024 * 1024));
        assert_eq!(d.bytes("nope"), None);
    }

    #[test]
    fn millis_applies_time_units() {
        let d = data(&[
            ("statement_timeout", "0", "ms"),
            ("checkpoint_timeout", "5", "min"),
            ("idle_in_transaction_session_timeout", "30", "s"),
        ]);
        assert_eq!(d.millis("statement_timeout"), Some(0));
        assert_eq!(d.millis("checkpoint_timeout"), Some(300_000));
        assert_eq!(d.millis("idle_in_transaction_session_timeout"), Some(30_000));
    }

    #[test]
    fn on_off_settings_parse() {
        let d = data(&[("fsync", "on", ""), ("archive_mode", "off", ""), ("wal_level", "replica", "")]);
        assert_eq!(d.sb("fsync"), Some(true));
        assert_eq!(d.sb("archive_mode"), Some(false));
        assert_eq!(d.sb("wal_level"), None); // not a boolean
    }

    #[test]
    fn cache_hit_pct_needs_traffic() {
        let mut d = PgTunerData::default();
        assert_eq!(d.cache_hit_pct(), None);      // no reads at all → unknown
        d.blks_hit = 99; d.blks_read = 1;
        assert_eq!(d.cache_hit_pct(), Some(99.0));
    }

    #[test]
    fn major_version_from_version_num() {
        let mut d = PgTunerData::default();
        d.version_num = 160010; d.major = (d.version_num / 10_000) as u32;
        assert_eq!(d.major, 16);
        assert_eq!(d.cycle(), "16");
        assert!(d.at_least(16) && !d.at_least(17));
    }

    #[test]
    fn cloud_detection_uses_provider_settings() {
        let mut d = data(&[("rds.extensions", "pgaudit", "")]);
        assert_eq!(detect_cloud(&d), Some("aws-rds".into()));
        d.settings.insert("aurora_stat_utils.enabled".into(), "on".into());
        assert_eq!(detect_cloud(&d), Some("aws-aurora".into()));

        let g = data(&[("cloudsql.iam_authentication", "on", "")]);
        assert_eq!(detect_cloud(&g), Some("gcp-cloudsql".into()));

        let a = data(&[("azure.extensions", "", "")]);
        assert_eq!(detect_cloud(&a), Some("azure".into()));

        let v = data(&[("shared_buffers", "16384", "8kB")]);
        assert_eq!(detect_cloud(&v), None);
    }
}
