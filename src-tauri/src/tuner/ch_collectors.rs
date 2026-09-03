//! Read-only data collection for the ClickHouse tuner.
//!
//! Same discipline as the MySQL / PostgreSQL / Redis twins: only `version()`
//! and `uptime()` are required; every probe over `system.*` is
//! failure-tolerant, so a restricted user, a managed cloud instance that hides
//! a table, or an older server that lacks one degrades the affected check
//! rather than failing the whole report.
//!
//! ClickHouse has no `pg_settings`-style typed catalog for the things that
//! matter here — the signal lives in the `system.*` operational tables
//! (`parts`, `merges`, `mutations`, `replicas`, `detached_parts`) — so this
//! module summarises each into small structs the pure rules in `ch_checks`
//! consume, and every threshold stays unit-testable without a live server.
//!
//! Queries run through the existing HTTP executor
//! (`crate::db::clickhouse::execute`), which returns JSONCompact rows; the
//! extractor helpers below tolerate ClickHouse's habit of quoting 64-bit
//! integers as strings while leaving floats and small ints as JSON numbers.

use serde_json::Value;

use crate::db::clickhouse::ChSession;

/// System databases that are never a tuning target — noise if flagged.
const SKIP_DBS: &str =
    "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";

/// ClickHouse's shipped defaults for the two MergeTree insert guards, used
/// when `system.merge_tree_settings` cannot be read.
pub const DEFAULT_PARTS_TO_THROW: u64 = 3000;
pub const DEFAULT_PARTS_TO_DELAY: u64 = 1000;

/// One (table, partition) with its active-part count — the unit the "Too many
/// parts" failure mode is measured in.
#[derive(Debug, Clone, Default)]
pub struct ChPartition {
    pub database: String,
    pub table: String,
    pub partition_id: String,
    pub parts: u64,
    pub rows: u64,
    pub bytes: u64,
}

/// Per-table active-part rollup used for the over-partitioning / tiny-parts
/// checks. `partitions` is the number of distinct active partitions.
#[derive(Debug, Clone, Default)]
pub struct ChTableParts {
    pub database: String,
    pub table: String,
    pub active_parts: u64,
    pub partitions: u64,
    pub rows: u64,
    pub bytes: u64,
}

impl ChTableParts {
    pub fn qname(&self) -> String { format!("{}.{}", self.database, self.table) }
    /// Average rows per active part — 0 when the table has no parts.
    pub fn avg_rows_per_part(&self) -> u64 {
        self.rows.checked_div(self.active_parts).unwrap_or(0)
    }
}

/// One in-flight entry from `system.merges` (a merge, or a mutation applied as
/// a merge when `is_mutation`).
#[derive(Debug, Clone, Default)]
pub struct ChMerge {
    pub database: String,
    pub table: String,
    pub elapsed_secs: u64,
    /// 0.0–1.0.
    pub progress: f64,
    pub num_parts: u64,
    pub is_mutation: bool,
}

impl ChMerge {
    pub fn qname(&self) -> String { format!("{}.{}", self.database, self.table) }
}

/// One unfinished row from `system.mutations`. `fail_reason` is empty unless
/// the mutation has raised and is being retried in a loop.
#[derive(Debug, Clone, Default)]
pub struct ChMutation {
    pub database: String,
    pub table: String,
    pub mutation_id: String,
    pub parts_to_do: u64,
    pub fail_reason: String,
    pub age_secs: u64,
}

impl ChMutation {
    pub fn qname(&self) -> String { format!("{}.{}", self.database, self.table) }
    pub fn is_failing(&self) -> bool { !self.fail_reason.is_empty() }
}

/// One row from `system.replicas`. Only the resilience-relevant columns.
#[derive(Debug, Clone, Default)]
pub struct ChReplica {
    pub database: String,
    pub table: String,
    pub is_readonly: bool,
    pub is_session_expired: bool,
    pub queue_size: u64,
    pub inserts_in_queue: u64,
    pub merges_in_queue: u64,
    /// Seconds this replica trails the leader.
    pub absolute_delay: u64,
}

impl ChReplica {
    pub fn qname(&self) -> String { format!("{}.{}", self.database, self.table) }
}

/// Everything the ClickHouse checks need. Optionals / empties mean "could not
/// be collected"; the corresponding rule degrades instead of guessing.
#[derive(Debug, Default)]
pub struct ChTunerData {
    pub version: String,
    pub major: u32,
    pub minor: u32,
    pub uptime_secs: u64,
    /// Managed providers do not advertise themselves reliably over the HTTP
    /// interface; left unset rather than guessed, like Redis.
    pub cloud: Option<String>,

    /// MergeTree insert guards, from `system.merge_tree_settings` (server
    /// default; a per-table override is not read).
    pub parts_to_throw_insert: u64,
    pub parts_to_delay_insert: u64,

    /// Busiest partition by active-part count, if any user parts exist.
    pub worst_partition: Option<ChPartition>,
    /// Per-table active-part rollups, busiest first (user tables only).
    pub tables: Vec<ChTableParts>,

    /// In-flight merges, longest-running first.
    pub merges: Vec<ChMerge>,
    /// Unfinished mutations, oldest first.
    pub mutations: Vec<ChMutation>,

    /// Replicated-table status rows. Empty on a server with no Replicated
    /// tables (or when `system.replicas` is unreadable).
    pub replicas: Vec<ChReplica>,

    /// Total detached parts across user tables.
    pub detached_parts: u64,

    // ── Schema smells (user tables only) ────────────────────────────────
    /// Plain `String` / `Nullable(String)` columns.
    pub string_columns: u64,
    /// `LowCardinality(...)` columns.
    pub lowcard_columns: u64,
    /// Data-skipping indices declared.
    pub skip_indices: u64,

    // ── Security (best-effort; None = system.users unreadable) ──────────
    pub users_readable: bool,
    pub no_password_users: Vec<String>,
    pub plaintext_password_users: Vec<String>,
}

impl ChTunerData {
    /// endoflife.date cycle for ClickHouse is `YY.M` (e.g. "24.8").
    pub fn cycle(&self) -> String { format!("{}.{}", self.major, self.minor) }
    pub fn at_least(&self, maj: u32, min: u32) -> bool { (self.major, self.minor) >= (maj, min) }
}

// ── JSONCompact cell extractors ────────────────────────────────────────────
// ClickHouse quotes 64-bit integers as strings by default but leaves floats
// and small ints (UInt8 bools) as JSON numbers, so every getter accepts both.

fn cell(row: &[Value], i: usize) -> Option<&Value> { row.get(i) }

fn as_str(row: &[Value], i: usize) -> String {
    match cell(row, i) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn as_u64(row: &[Value], i: usize) -> u64 {
    match cell(row, i) {
        Some(Value::String(s)) => s.trim().parse().ok().or_else(|| {
            // A float rendered as text ("12.0") still means 12.
            s.trim().parse::<f64>().ok().map(|f| f.max(0.0) as u64)
        }).unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64()
            .or_else(|| n.as_f64().map(|f| f.max(0.0) as u64))
            .unwrap_or(0),
        _ => 0,
    }
}

fn as_f64(row: &[Value], i: usize) -> f64 {
    match cell(row, i) {
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// ClickHouse UInt8 flags arrive as `1`/`0` (number) or `"1"`/`"0"` (string).
fn as_bool(row: &[Value], i: usize) -> bool {
    match cell(row, i) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0) != 0,
        Some(Value::String(s)) => matches!(s.trim(), "1" | "true" | "True"),
        _ => false,
    }
}

/// `major.minor` from a "24.8.4.13" version string.
fn parse_version(v: &str) -> (u32, u32) {
    let mut it = v.split('.');
    (
        it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0),
        it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0),
    )
}

/// Run a query, returning its rows or an empty vec on any failure. Every probe
/// here is best-effort — a missing `system` table must not sink the report.
async fn rows(session: &ChSession, sql: &str) -> Vec<Vec<Value>> {
    match crate::db::clickhouse::execute(session, sql).await {
        Ok(r) => r.rows,
        Err(e) => {
            log::info!("ch tuner probe failed ({e})");
            vec![]
        }
    }
}

pub async fn collect(session: &ChSession) -> anyhow::Result<ChTunerData> {
    let mut d = ChTunerData {
        parts_to_throw_insert: DEFAULT_PARTS_TO_THROW,
        parts_to_delay_insert: DEFAULT_PARTS_TO_DELAY,
        ..Default::default()
    };

    // ── Required: version + uptime ──────────────────────────────────────
    let vr = rows(session, "SELECT version(), toUInt64(uptime())").await;
    if let Some(r) = vr.first() {
        d.version = as_str(r, 0);
        d.uptime_secs = as_u64(r, 1);
    }
    let (maj, min) = parse_version(&d.version);
    d.major = maj;
    d.minor = min;

    // ── MergeTree insert guards (server default) ────────────────────────
    for r in rows(session,
        "SELECT name, value FROM system.merge_tree_settings \
         WHERE name IN ('parts_to_throw_insert', 'parts_to_delay_insert')").await
    {
        let v: u64 = as_str(&r, 1).parse().unwrap_or(0);
        if v == 0 { continue; }
        match as_str(&r, 0).as_str() {
            "parts_to_throw_insert" => d.parts_to_throw_insert = v,
            "parts_to_delay_insert" => d.parts_to_delay_insert = v,
            _ => {}
        }
    }

    // ── Busiest partition by active-part count ──────────────────────────
    let part_rows = rows(session, &format!(
        "SELECT database, table, partition_id, count() AS parts, \
                sum(rows) AS rows, sum(bytes_on_disk) AS bytes \
         FROM system.parts \
         WHERE active AND {SKIP_DBS} \
         GROUP BY database, table, partition_id \
         ORDER BY parts DESC LIMIT 20")).await;
    if let Some(r) = part_rows.first() {
        d.worst_partition = Some(ChPartition {
            database: as_str(r, 0),
            table: as_str(r, 1),
            partition_id: as_str(r, 2),
            parts: as_u64(r, 3),
            rows: as_u64(r, 4),
            bytes: as_u64(r, 5),
        });
    }

    // ── Per-table active-part rollup ────────────────────────────────────
    for r in rows(session, &format!(
        "SELECT database, table, count() AS active_parts, \
                uniqExact(partition_id) AS partitions, \
                sum(rows) AS rows, sum(bytes_on_disk) AS bytes \
         FROM system.parts \
         WHERE active AND {SKIP_DBS} \
         GROUP BY database, table \
         ORDER BY active_parts DESC LIMIT 25")).await
    {
        d.tables.push(ChTableParts {
            database: as_str(&r, 0),
            table: as_str(&r, 1),
            active_parts: as_u64(&r, 2),
            partitions: as_u64(&r, 3),
            rows: as_u64(&r, 4),
            bytes: as_u64(&r, 5),
        });
    }

    // ── In-flight merges / mutations-as-merges ──────────────────────────
    for r in rows(session,
        "SELECT database, table, toUInt64(elapsed) AS elapsed, progress, \
                num_parts, is_mutation \
         FROM system.merges ORDER BY elapsed DESC LIMIT 20").await
    {
        d.merges.push(ChMerge {
            database: as_str(&r, 0),
            table: as_str(&r, 1),
            elapsed_secs: as_u64(&r, 2),
            progress: as_f64(&r, 3),
            num_parts: as_u64(&r, 4),
            is_mutation: as_bool(&r, 5),
        });
    }

    // ── Unfinished mutations (backlog + stuck) ──────────────────────────
    for r in rows(session,
        "SELECT database, table, mutation_id, parts_to_do, \
                latest_fail_reason, \
                toUInt64(dateDiff('second', create_time, now())) AS age \
         FROM system.mutations \
         WHERE is_done = 0 \
         ORDER BY create_time ASC LIMIT 100").await
    {
        d.mutations.push(ChMutation {
            database: as_str(&r, 0),
            table: as_str(&r, 1),
            mutation_id: as_str(&r, 2),
            parts_to_do: as_u64(&r, 3),
            fail_reason: as_str(&r, 4),
            age_secs: as_u64(&r, 5),
        });
    }

    // ── Replica health ──────────────────────────────────────────────────
    for r in rows(session,
        "SELECT database, table, is_readonly, is_session_expired, \
                queue_size, inserts_in_queue, merges_in_queue, absolute_delay \
         FROM system.replicas").await
    {
        d.replicas.push(ChReplica {
            database: as_str(&r, 0),
            table: as_str(&r, 1),
            is_readonly: as_bool(&r, 2),
            is_session_expired: as_bool(&r, 3),
            queue_size: as_u64(&r, 4),
            inserts_in_queue: as_u64(&r, 5),
            merges_in_queue: as_u64(&r, 6),
            absolute_delay: as_u64(&r, 7),
        });
    }

    // ── Detached parts ──────────────────────────────────────────────────
    if let Some(r) = rows(session, &format!(
        "SELECT count() FROM system.detached_parts WHERE {SKIP_DBS}")).await.first()
    {
        d.detached_parts = as_u64(r, 0);
    }

    // ── Schema smells: column typing + skip indices ─────────────────────
    if let Some(r) = rows(session, &format!(
        "SELECT countIf(type = 'String' OR type = 'Nullable(String)') AS strings, \
                countIf(type LIKE 'LowCardinality(%') AS lowcard \
         FROM system.columns WHERE {SKIP_DBS}")).await.first()
    {
        d.string_columns = as_u64(r, 0);
        d.lowcard_columns = as_u64(r, 1);
    }
    if let Some(r) = rows(session, &format!(
        "SELECT count() FROM system.data_skipping_indices WHERE {SKIP_DBS}")).await.first()
    {
        d.skip_indices = as_u64(r, 0);
    }

    // ── Security: password posture (best-effort) ────────────────────────
    // system.users needs access_management; the whole security check degrades
    // to silence when it is denied rather than guessing.
    let users = rows(session, "SELECT name, toString(auth_type) FROM system.users").await;
    if !users.is_empty() {
        d.users_readable = true;
        for r in &users {
            let name = as_str(r, 0);
            // auth_type may be a scalar or, on newer servers, an array
            // rendered as text — substring matching handles both.
            let auth = as_str(r, 1);
            if auth.contains("no_password") {
                d.no_password_users.push(name.clone());
            }
            if auth.contains("plaintext_password") {
                d.plaintext_password_users.push(name);
            }
        }
    }

    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_splits_to_major_minor() {
        assert_eq!(parse_version("24.8.4.13"), (24, 8));
        assert_eq!(parse_version("23.3.19.32"), (23, 3));
        assert_eq!(parse_version(""), (0, 0));
    }

    #[test]
    fn cycle_is_major_minor_for_endoflife_lookup() {
        let mut d = ChTunerData::default();
        d.major = 24; d.minor = 8;
        assert_eq!(d.cycle(), "24.8");
        assert!(d.at_least(24, 0) && d.at_least(24, 8) && !d.at_least(24, 9));
        assert!(!d.at_least(25, 0));
    }

    #[test]
    fn extractors_tolerate_quoted_and_numeric_cells() {
        // ClickHouse quotes 64-bit ints, leaves UInt8 flags and floats numeric.
        let row = vec![
            Value::String("4096".into()),          // UInt64 as string
            Value::Number(serde_json::Number::from(1)), // UInt8 flag = true
            Value::Number(serde_json::Number::from_f64(0.75).unwrap()), // Float64
            Value::String("nope".into()),
        ];
        assert_eq!(as_u64(&row, 0), 4096);
        assert!(as_bool(&row, 1));
        assert!((as_f64(&row, 2) - 0.75).abs() < 1e-9);
        assert_eq!(as_str(&row, 3), "nope");
        // Out-of-range indexes are zero/empty, never a panic.
        assert_eq!(as_u64(&row, 99), 0);
        assert_eq!(as_str(&row, 99), "");
        assert!(!as_bool(&row, 99));
    }

    #[test]
    fn avg_rows_per_part_never_divides_by_zero() {
        let t = ChTableParts { active_parts: 0, rows: 100, ..Default::default() };
        assert_eq!(t.avg_rows_per_part(), 0);
        let t = ChTableParts { active_parts: 4, rows: 100, ..Default::default() };
        assert_eq!(t.avg_rows_per_part(), 25);
    }
}
