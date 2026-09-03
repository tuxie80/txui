//! ClickHouse rule set: pure functions over collected [`ChTunerData`] (+ EOL
//! info), so every threshold is unit-testable with synthetic data — no live
//! server required.
//!
//! Uses the SAME scoring model and category buckets as the other engines
//! (`checks.rs`), so one panel renders ClickHouse without branching:
//!   severity → points_lost: critical 10, warn 5, advice 2, info/ok 0.
//!   category → bucket: performance|config → Performance /40,
//!                      security          → Security /30,
//!                      resilience|schema → Resilience /30.
//!
//! The failure modes are ClickHouse's own, drawn from `system.*`:
//!   - "Too many parts": active parts in one partition approaching
//!     `parts_to_delay_insert` / `parts_to_throw_insert`, and over-partitioned
//!     tables made of many tiny parts.
//!   - long-running merges and stuck / backlogged mutations.
//!   - replica queue depth, read-only replicas, replication delay.
//!   - accumulating detached parts.
//!   - schema smells: `LowCardinality` left entirely unused.
//!   - password posture of the account list, when readable.
//!
//! Fix statements are GENERATED ONLY — the tuner never executes them. Where a
//! change is a server-config edit (XML/YAML, not a statement) the guidance is
//! carried in the recommendation text rather than `fix_config`, whose panel
//! rendering assumes a MySQL `[mysqld]` / PostgreSQL `.conf` line.

use super::ch_collectors::{ChReplica, ChTunerData};
use super::{EolInfo, Finding};

/// Only the tests build synthetic byte sizes with these; the rules quote part
/// counts and durations, not bytes.
#[cfg(test)]
const GIB: u64 = 1024 * 1024 * 1024;
#[cfg(test)]
const MIB: u64 = 1024 * 1024;

// ── Thresholds (all in one place so the rules read as policy) ───────────────
/// A single partition holding this fraction of `parts_to_delay_insert` is
/// worth an early heads-up, well before inserts are throttled.
const PARTS_ADVICE_FLOOR: u64 = 300;
/// Over-partitioning: this many active parts on one table…
const SMALL_PARTS_MIN: u64 = 50;
/// …each averaging fewer than this many rows signals tiny parts / a partition
/// key that is too granular.
const SMALL_PART_ROWS: u64 = 10_000;
/// Merge that has been running longer than this is worth surfacing…
const MERGE_LONG_SECS: u64 = 600;
/// …and one past this is almost certainly stuck or starved.
const MERGE_STUCK_SECS: u64 = 3600;
/// Unfinished-mutation count that indicates a backlog the merges cannot drain.
const MUTATION_BACKLOG: usize = 20;
/// A single mutation older than this without finishing is a warning.
const MUTATION_OLD_SECS: u64 = 3600;
/// Replica queue this deep is falling behind.
const REPLICA_QUEUE_WARN: u64 = 100;
/// Replication delay bands, seconds.
const REPLICA_DELAY_ADVICE: u64 = 60;
const REPLICA_DELAY_WARN: u64 = 300;
/// Detached-part accumulation bands.
const DETACHED_ADVICE: u64 = 1;
const DETACHED_WARN: u64 = 50;

use super::{f, Sev};

fn fmt_uptime(secs: u64) -> String {
    let d = secs / 86400;
    let h = (secs % 86400) / 3600;
    let m = (secs % 3600) / 60;
    if d > 0 { format!("{d}d {h}h") } else if h > 0 { format!("{h}h {m}m") } else { format!("{m}m") }
}

fn fmt_dur(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 { format!("{h}h {m}m") } else if m > 0 { format!("{m}m {s}s") } else { format!("{s}s") }
}

pub fn run_checks(d: &ChTunerData, eol: Option<&EolInfo>) -> Vec<Finding> {
    let mut out = Vec::new();
    check_version(d, eol, &mut out);
    check_parts(d, &mut out);
    check_partitioning(d, &mut out);
    check_merges(d, &mut out);
    check_mutations(d, &mut out);
    check_replicas(d, &mut out);
    check_detached(d, &mut out);
    check_schema(d, &mut out);
    check_security(d, &mut out);
    out
}

// ── Version / lifecycle ────────────────────────────────────────────────────

fn check_version(d: &ChTunerData, eol: Option<&EolInfo>, out: &mut Vec<Finding>) {
    let cloud = d.cloud.as_deref().map(|c| format!(" ({c})")).unwrap_or_default();
    out.push(f("ch-version", "config", Sev::Info,
        format!("ClickHouse {}{}", d.version.trim(), cloud),
        format!("Version {}. Uptime {}.", d.version.trim(), fmt_uptime(d.uptime_secs)),
        None, vec![], vec![]));

    if d.uptime_secs < 3600 {
        out.push(f("ch-uptime-short", "config", Sev::Info,
            "Server restarted recently",
            format!("Uptime is {} — merges, mutations and replica queues have barely had time \
                     to accumulate, so the operational findings below are a provisional snapshot.",
                    fmt_uptime(d.uptime_secs)),
            Some("Re-run the analysis after a representative workload period.".into()),
            vec![], vec![]));
    }

    if let Some(e) = eol {
        match e.status.as_str() {
            "eol" => out.push(f("ch-eol", "resilience", Sev::Critical,
                format!("ClickHouse {} is end-of-life", e.cycle),
                format!("Support for this release ended {}. ClickHouse moves fast and only the \
                         recent releases receive fixes — including security fixes.",
                        e.eol_date.clone().unwrap_or_else(|| "(date unknown)".into())),
                Some(format!("Upgrade to a supported release{}.",
                    e.latest.as_ref().map(|l| format!(" (latest in this line: {l})")).unwrap_or_default())),
                vec![], vec![])),
            "eol-soon" => out.push(f("ch-eol-soon", "resilience", Sev::Warn,
                format!("ClickHouse {} reaches end-of-life soon", e.cycle),
                format!("Support ends {}. Plan the upgrade now — ClickHouse's support windows are \
                         short.", e.eol_date.clone().unwrap_or_default()),
                Some("Schedule an upgrade to a current stable release.".into()),
                vec![], vec![])),
            _ => {}
        }
    }
}

// ── Too many parts ──────────────────────────────────────────────────────────

fn check_parts(d: &ChTunerData, out: &mut Vec<Finding>) {
    let Some(p) = &d.worst_partition else {
        // No user parts at all — nothing to say, and saying "healthy" would be
        // misleading on an empty server.
        return;
    };
    let throw = d.parts_to_throw_insert.max(1);
    let delay = d.parts_to_delay_insert.max(1);
    let n = p.parts;
    let where_ = format!("{}.{} partition {}", p.database, p.table, p.partition_id);

    if n >= throw {
        out.push(f("ch-too-many-parts", "performance", Sev::Critical,
            format!("{n} active parts in one partition — inserts will be REJECTED"),
            format!("{where_} has {n} active parts, at or above parts_to_throw_insert = {throw}. \
                     ClickHouse throws the classic \"Too many parts\" error and refuses new inserts \
                     into this partition until background merges bring the count down. This is the \
                     canonical ClickHouse outage: inserts fail while merges catch up.",),
            Some("Insert in larger batches (tens of thousands of rows, not row-by-row), reduce \
                  insert concurrency, and check that merges are keeping up (system.merges). If the \
                  partition key is too granular, that is the root cause — see the partitioning \
                  finding. As a stopgap, OPTIMIZE TABLE ... FINAL forces a merge.".into()),
            vec![format!("-- Inspect the offending table (review only):\n\
                          SELECT partition_id, count() AS parts, sum(rows) AS rows\n\
                          FROM system.parts WHERE active AND database = '{}' AND table = '{}'\n\
                          GROUP BY partition_id ORDER BY parts DESC;", p.database, p.table)],
            vec![]));
    } else if n >= delay {
        out.push(f("ch-too-many-parts", "performance", Sev::Warn,
            format!("{n} active parts in one partition — inserts are being throttled"),
            format!("{where_} has {n} active parts, at or above parts_to_delay_insert = {delay} \
                     (rejection begins at parts_to_throw_insert = {throw}). ClickHouse is \
                     artificially slowing inserts to let merges catch up; sustained, this reaches \
                     the throw threshold and inserts start failing.",),
            Some("Batch inserts more aggressively and lower insert parallelism. Confirm merges are \
                  progressing in system.merges; if the partition key produces one partition per \
                  insert, fix that first.".into()),
            vec![], vec![]));
    } else if n >= PARTS_ADVICE_FLOOR.min(delay / 2) {
        out.push(f("ch-too-many-parts", "performance", Sev::Advice,
            format!("{n} active parts in the busiest partition"),
            format!("{where_} holds {n} active parts. Still well below the throttle at {delay}, but \
                     climbing part counts are the leading indicator of the \"Too many parts\" \
                     failure, usually from too-frequent small inserts.",),
            Some("Keep an eye on insert batch size; ClickHouse strongly prefers few large inserts \
                  over many small ones.".into()),
            vec![], vec![]));
    } else {
        out.push(f("ch-too-many-parts", "performance", Sev::Ok,
            format!("Part counts are healthy (busiest partition: {n})"),
            format!("The busiest partition ({where_}) holds {n} active parts, comfortably below the \
                     throttle at {delay} and rejection at {throw}.",),
            None, vec![], vec![]));
    }
}

// ── Over-partitioning / tiny parts ──────────────────────────────────────────

fn check_partitioning(d: &ChTunerData, out: &mut Vec<Finding>) {
    // Tables made of many active parts that are each tiny: the signature of a
    // partition key that is too granular or row-by-row inserts. High
    // confidence only — require both a high part count AND small average size.
    let mut culprits: Vec<&super::ch_collectors::ChTableParts> = d.tables.iter()
        .filter(|t| t.active_parts >= SMALL_PARTS_MIN
                 && t.rows > 0
                 && t.avg_rows_per_part() < SMALL_PART_ROWS)
        .collect();
    culprits.sort_by_key(|t| std::cmp::Reverse(t.active_parts));

    if culprits.is_empty() { return; }

    let worst = culprits[0];
    let names: Vec<String> = culprits.iter().take(5)
        .map(|t| format!("{} ({} parts, ~{} rows/part, {} partitions)",
                         t.qname(), t.active_parts, t.avg_rows_per_part(), t.partitions))
        .collect();

    out.push(f("ch-over-partitioning", "schema", Sev::Advice,
        format!("{} table(s) made of many tiny parts", culprits.len()),
        format!("These tables carry a large number of small active parts, which forces constant \
                 merges and slows reads (every query touches more part files): {}. \
                 A part averaging only ~{} rows almost always means the partition key is too \
                 granular (e.g. PARTITION BY a full timestamp instead of toYYYYMM) or inserts are \
                 too small.",
                names.join("; "), worst.avg_rows_per_part()),
        Some("Partition by month or day, not by hour/minute or a high-cardinality key; a few \
              hundred partitions per table is plenty. Insert in large batches so each insert makes \
              one sizeable part. Existing tables can be consolidated with OPTIMIZE TABLE ... FINAL \
              (expensive — run off-peak).".into()),
        vec![format!("-- Review parts for the worst table (review only):\n\
                      SELECT partition_id, count() AS parts, sum(rows) AS rows\n\
                      FROM system.parts WHERE active AND database = '{}' AND table = '{}'\n\
                      GROUP BY partition_id ORDER BY parts DESC;", worst.database, worst.table)],
        vec![]));
}

// ── Merges ────────────────────────────────────────────────────────────────

fn check_merges(d: &ChTunerData, out: &mut Vec<Finding>) {
    let Some(longest) = d.merges.iter().max_by_key(|m| m.elapsed_secs) else { return };
    if longest.elapsed_secs < MERGE_LONG_SECS { return; }

    let kind = if longest.is_mutation { "mutation-merge" } else { "merge" };
    let (sev, lead) = if longest.elapsed_secs >= MERGE_STUCK_SECS {
        (Sev::Warn, "has been running long enough to be stuck or starved of resources")
    } else {
        (Sev::Advice, "has been running a long time")
    };
    out.push(f("ch-long-merge", "performance", sev,
        format!("Long-running {kind} on {} ({}, {:.0}% done)",
                longest.qname(), fmt_dur(longest.elapsed_secs), longest.progress * 100.0),
        format!("A {kind} on {} merging {} part(s) {lead}: elapsed {}, progress {:.0}%. \
                 A merge that never finishes lets part counts climb toward the \"Too many parts\" \
                 threshold.",
                longest.qname(), longest.num_parts, fmt_dur(longest.elapsed_secs),
                longest.progress * 100.0),
        Some("Check system.merges for progress and memory use, and system.merge_tree_settings for \
              max_bytes_to_merge_at_max_space_in_pool. A merge stalled on disk space or memory \
              needs those resources freed before part counts recover.".into()),
        vec!["-- What is merging right now (review only):\n\
              SELECT database, table, elapsed, progress, num_parts, is_mutation, memory_usage\n\
              FROM system.merges ORDER BY elapsed DESC;".into()],
        vec![]));
}

// ── Mutations ────────────────────────────────────────────────────────────

fn check_mutations(d: &ChTunerData, out: &mut Vec<Finding>) {
    // Failing mutations first — a mutation that raises is retried forever and
    // silently blocks everything queued behind it.
    let failing: Vec<&super::ch_collectors::ChMutation> =
        d.mutations.iter().filter(|m| m.is_failing()).collect();
    if let Some(m) = failing.first() {
        out.push(f("ch-mutation-failed", "resilience", Sev::Critical,
            format!("{} mutation(s) are failing and retrying", failing.len()),
            format!("Mutation {} on {} has been retrying for {} and reports: {}. ClickHouse retries \
                     a failing mutation indefinitely, so it never completes and blocks the mutations \
                     queued behind it on that table.",
                    m.mutation_id, m.qname(), fmt_dur(m.age_secs),
                    m.fail_reason.lines().next().unwrap_or(&m.fail_reason)),
            Some("Fix the underlying cause (a bad type cast, a missing column, an OOM), or cancel \
                  the mutation with KILL MUTATION and reissue it correctly.".into()),
            vec![format!("-- Inspect, then optionally cancel (review only):\n\
                          SELECT mutation_id, command, latest_fail_reason\n\
                          FROM system.mutations WHERE is_done = 0 AND table = '{}';\n\
                          -- KILL MUTATION WHERE mutation_id = '{}' AND table = '{}';",
                          m.table, m.mutation_id, m.table)],
            vec![]));
    }

    // Backlog of (non-failing) unfinished mutations.
    let pending = d.mutations.len();
    let oldest = d.mutations.iter().map(|m| m.age_secs).max().unwrap_or(0);
    if failing.is_empty() && pending >= MUTATION_BACKLOG {
        out.push(f("ch-mutation-backlog", "performance", Sev::Warn,
            format!("{pending} mutations still in progress"),
            format!("{pending} mutations are unfinished (oldest running {}). Mutations rewrite whole \
                     parts and run in the background; a large backlog means they are being issued \
                     faster than the server can apply them, adding steady merge/IO load.",
                    fmt_dur(oldest)),
            Some("Batch ALTER ... UPDATE/DELETE work instead of issuing many small mutations, and \
                  let the queue drain before adding more. Lightweight DELETE is cheaper than a \
                  mutation for row removal.".into()),
            vec!["-- Outstanding mutations (review only):\n\
                  SELECT database, table, count() AS pending, min(create_time) AS oldest\n\
                  FROM system.mutations WHERE is_done = 0 GROUP BY database, table\n\
                  ORDER BY pending DESC;".into()],
            vec![]));
    } else if failing.is_empty() && oldest >= MUTATION_OLD_SECS {
        out.push(f("ch-mutation-slow", "performance", Sev::Advice,
            format!("A mutation has been running for {}", fmt_dur(oldest)),
            format!("{pending} mutation(s) in progress, the oldest for {}. Not failing, but a \
                     mutation this long-lived rewrites a lot of data and competes with merges.",
                    fmt_dur(oldest)),
            Some("Confirm it is progressing (parts_to_do falling); if it is effectively stuck, \
                  treat it like a failing mutation.".into()),
            vec![], vec![]));
    }
}

// ── Replicas ────────────────────────────────────────────────────────────

fn check_replicas(d: &ChTunerData, out: &mut Vec<Finding>) {
    if d.replicas.is_empty() { return; }

    let readonly: Vec<&ChReplica> = d.replicas.iter().filter(|r| r.is_readonly).collect();
    if let Some(r) = readonly.first() {
        out.push(f("ch-replica-readonly", "resilience", Sev::Critical,
            format!("{} replicated table(s) are READ-ONLY", readonly.len()),
            format!("{} is in read-only mode — the replica cannot accept writes. This is almost \
                     always lost contact with (Zoo)Keeper or a metadata mismatch, and it silently \
                     stops replication and inserts for the affected table.",
                    r.qname()),
            Some("Check ClickHouse Keeper / ZooKeeper connectivity (system.zookeeper) and the \
                  server log. SYSTEM RESTORE REPLICA <table> recovers a replica whose metadata was \
                  lost after Keeper data loss.".into()),
            vec!["-- Which replicas are read-only and why (review only):\n\
                  SELECT database, table, is_readonly, is_session_expired, \
                  zookeeper_exception\n\
                  FROM system.replicas WHERE is_readonly;".into()],
            vec![]));
    }

    let expired: Vec<&ChReplica> = d.replicas.iter()
        .filter(|r| r.is_session_expired && !r.is_readonly).collect();
    if let Some(r) = expired.first() {
        out.push(f("ch-replica-session-expired", "resilience", Sev::Warn,
            format!("{} replica(s) have an expired Keeper session", expired.len()),
            format!("{} shows is_session_expired — its session with ClickHouse Keeper / ZooKeeper \
                     has dropped. Until it reconnects the replica cannot coordinate, and it is one \
                     step from going read-only.", r.qname()),
            Some("Investigate Keeper health and network stability between this node and the Keeper \
                  ensemble.".into()),
            vec![], vec![]));
    }

    // Deepest queue.
    if let Some(r) = d.replicas.iter().max_by_key(|r| r.queue_size) {
        if r.queue_size >= REPLICA_QUEUE_WARN {
            out.push(f("ch-replica-queue", "resilience", Sev::Warn,
                format!("Replication queue is {} deep on {}", r.queue_size, r.qname()),
                format!("{} has {} entries in its replication queue ({} inserts, {} merges pending). \
                         A queue that keeps growing means the replica cannot fetch/merge as fast as \
                         the leader produces work, and it will drift further behind.",
                        r.qname(), r.queue_size, r.inserts_in_queue, r.merges_in_queue),
                Some("Check network throughput to the other replicas and disk/merge capacity on \
                      this node; system.replication_queue shows what is stuck.".into()),
                vec!["-- What the replica is waiting on (review only):\n\
                      SELECT database, table, type, num_tries, last_exception\n\
                      FROM system.replication_queue ORDER BY num_tries DESC;".into()],
                vec![]));
        }
    }

    // Worst absolute delay.
    if let Some(r) = d.replicas.iter().max_by_key(|r| r.absolute_delay) {
        if r.absolute_delay >= REPLICA_DELAY_WARN {
            out.push(f("ch-replica-delay", "resilience", Sev::Warn,
                format!("Replica {} is {} behind", r.qname(), fmt_dur(r.absolute_delay)),
                format!("{} reports an absolute delay of {}. Reads served from this replica return \
                         stale data and a failover to it would lose the un-replicated tail.",
                        r.qname(), fmt_dur(r.absolute_delay)),
                Some("Trace the cause via the queue depth above; a delay this large usually rides \
                      along with a growing replication queue.".into()),
                vec![], vec![]));
        } else if r.absolute_delay >= REPLICA_DELAY_ADVICE {
            out.push(f("ch-replica-delay", "resilience", Sev::Advice,
                format!("Replica {} is {} behind", r.qname(), fmt_dur(r.absolute_delay)),
                format!("{} reports an absolute delay of {} — minor, but worth noting if reads are \
                         served from replicas.", r.qname(), fmt_dur(r.absolute_delay)),
                None, vec![], vec![]));
        }
    }
}

// ── Detached parts ──────────────────────────────────────────────────────

fn check_detached(d: &ChTunerData, out: &mut Vec<Finding>) {
    let n = d.detached_parts;
    if n >= DETACHED_WARN {
        out.push(f("ch-detached-parts", "resilience", Sev::Warn,
            format!("{n} detached parts are accumulating"),
            format!("system.detached_parts holds {n} parts. Detached parts are excluded from \
                     queries and merges but still occupy disk. A large, growing count usually \
                     means parts are being quarantined faster than anyone is reviewing them — \
                     after a failed ATTACH, a corrupted part, or a manual DETACH that was never \
                     cleaned up.",),
            Some("Review each part's reason in system.detached_parts. Re-ATTACH the good ones and \
                  DROP DETACHED PARTITION the rest once verified — they never leave on their own.".into()),
            vec!["-- Detached parts and why (review only):\n\
                  SELECT database, table, reason, count() AS parts\n\
                  FROM system.detached_parts GROUP BY database, table, reason\n\
                  ORDER BY parts DESC;".into()],
            vec![]));
    } else if n >= DETACHED_ADVICE {
        out.push(f("ch-detached-parts", "resilience", Sev::Advice,
            format!("{n} detached part(s) present"),
            format!("system.detached_parts holds {n} part(s). Not urgent, but detached parts are \
                     invisible to queries and never removed automatically, so they only ever \
                     accumulate.",),
            Some("Review them in system.detached_parts and either re-ATTACH or DROP once verified.".into()),
            vec![], vec![]));
    }
}

// ── Schema smells ──────────────────────────────────────────────────────

fn check_schema(d: &ChTunerData, out: &mut Vec<Finding>) {
    // LowCardinality is one of ClickHouse's biggest cheap wins for low-distinct
    // string columns (enums, statuses, country codes). Flag only the
    // high-confidence case: many String columns and NOT ONE LowCardinality
    // column anywhere — i.e. the optimisation is entirely unused. Per-column
    // advice would need distinct counts, which are too expensive to probe here.
    if d.string_columns >= 10 && d.lowcard_columns == 0 {
        out.push(f("ch-low-cardinality", "schema", Sev::Advice,
            "LowCardinality is not used anywhere",
            format!("{} plain String column(s) across user tables and zero LowCardinality columns. \
                     For a String with relatively few distinct values (statuses, categories, \
                     country/currency codes, hostnames), LowCardinality(String) dictionary-encodes \
                     it — usually a large drop in storage and a speed-up on GROUP BY and filters.",
                    d.string_columns),
            Some("Convert low-distinct String columns: `... LowCardinality(String)`. Rule of thumb: \
                  worth it under ~10k distinct values; not worth it for high-cardinality columns \
                  like unique IDs or free text.".into()),
            vec!["-- Candidate String columns to review (review only):\n\
                  SELECT database, table, name FROM system.columns\n\
                  WHERE type = 'String'\n\
                    AND database NOT IN ('system','INFORMATION_SCHEMA','information_schema')\n\
                  ORDER BY database, table;".into()],
            vec![]));
    }
}

// ── Security ──────────────────────────────────────────────────────────────

fn check_security(d: &ChTunerData, out: &mut Vec<Finding>) {
    // Best-effort: only speak when system.users was actually readable.
    if !d.users_readable { return; }

    if !d.no_password_users.is_empty() {
        let mut names = d.no_password_users.clone();
        names.sort();
        out.push(f("ch-user-no-password", "security", Sev::Warn,
            format!("{} account(s) have no password", names.len()),
            format!("These users authenticate with no_password: {}. Anyone who can reach the server \
                     as one of them is in, so the network ACL is the only thing standing between \
                     the internet and the data.", names.join(", ")),
            Some("Give each account a password (or a certificate / Kerberos identity), and keep the \
                  listen interface and host ACLs tight. no_password is only defensible on a socket \
                  no untrusted network can reach.".into()),
            vec!["-- Review authentication per user (review only):\n\
                  SELECT name, auth_type FROM system.users ORDER BY name;".into()],
            vec![]));
    }

    if !d.plaintext_password_users.is_empty() {
        let mut names = d.plaintext_password_users.clone();
        names.sort();
        out.push(f("ch-user-plaintext-password", "security", Sev::Warn,
            format!("{} account(s) use a plaintext password", names.len()),
            format!("These users authenticate with plaintext_password: {}. The password is stored \
                     and compared in the clear, so anyone who can read the server config or users \
                     metadata learns it.", names.join(", ")),
            Some("Switch to sha256_password (or double_sha1_password for the native protocol) so \
                  only a hash is stored.".into()),
            vec![], vec![]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::ch_collectors::{ChMerge, ChMutation, ChPartition, ChReplica, ChTableParts, ChTunerData};

    fn ids(out: &[Finding]) -> Vec<&str> { out.iter().map(|f| f.id.as_str()).collect() }
    fn sev<'a>(out: &'a [Finding], id: &str) -> Option<&'a str> {
        out.iter().find(|f| f.id == id).map(|f| f.severity.as_str())
    }

    /// A minimally-populated, healthy server: real version, one small partition.
    fn healthy() -> ChTunerData {
        ChTunerData {
            version: "24.8.4.13".into(),
            major: 24, minor: 8,
            uptime_secs: 5 * 86400,
            parts_to_throw_insert: 3000,
            parts_to_delay_insert: 1000,
            worst_partition: Some(ChPartition {
                database: "app".into(), table: "events".into(), partition_id: "202408".into(),
                parts: 8, rows: 5_000_000, bytes: 500 * MIB,
            }),
            ..Default::default()
        }
    }

    // ── Too many parts ─────────────────────────────────────────────────

    #[test]
    fn parts_at_throw_threshold_is_critical() {
        let mut d = healthy();
        d.worst_partition.as_mut().unwrap().parts = 3000;
        let mut out = Vec::new();
        check_parts(&d, &mut out);
        assert_eq!(sev(&out, "ch-too-many-parts"), Some("critical"));
    }

    #[test]
    fn parts_at_delay_threshold_is_a_warning() {
        let mut d = healthy();
        d.worst_partition.as_mut().unwrap().parts = 1200;
        let mut out = Vec::new();
        check_parts(&d, &mut out);
        assert_eq!(sev(&out, "ch-too-many-parts"), Some("warn"));
    }

    #[test]
    fn parts_climbing_but_safe_is_advice_and_healthy_is_ok() {
        let mut d = healthy();
        d.worst_partition.as_mut().unwrap().parts = 400;
        let mut out = Vec::new();
        check_parts(&d, &mut out);
        assert_eq!(sev(&out, "ch-too-many-parts"), Some("advice"));

        let mut out2 = Vec::new();
        check_parts(&healthy(), &mut out2); // 8 parts
        assert_eq!(sev(&out2, "ch-too-many-parts"), Some("ok"));
    }

    #[test]
    fn a_per_table_override_lowering_the_throw_limit_is_respected() {
        // A table that set parts_to_throw_insert low would trip earlier; the
        // collector reads the server default, so prove the rule reads the field
        // rather than a hardcoded 3000.
        let mut d = healthy();
        d.parts_to_throw_insert = 600;
        d.parts_to_delay_insert = 300;
        d.worst_partition.as_mut().unwrap().parts = 600;
        let mut out = Vec::new();
        check_parts(&d, &mut out);
        assert_eq!(sev(&out, "ch-too-many-parts"), Some("critical"));
    }

    // ── Over-partitioning ──────────────────────────────────────────────

    #[test]
    fn many_tiny_parts_flags_over_partitioning() {
        let mut d = healthy();
        d.tables = vec![ChTableParts {
            database: "app".into(), table: "hourly".into(),
            active_parts: 200, partitions: 200, rows: 400_000, bytes: 40 * MIB,
        }];
        let mut out = Vec::new();
        check_partitioning(&d, &mut out);
        assert_eq!(sev(&out, "ch-over-partitioning"), Some("advice"));
        assert!(out[0].detail.contains("app.hourly"));
    }

    #[test]
    fn a_few_large_parts_is_not_flagged() {
        let mut d = healthy();
        // 200 parts but averaging 5M rows each — legitimately large table.
        d.tables = vec![ChTableParts {
            database: "app".into(), table: "big".into(),
            active_parts: 200, partitions: 12, rows: 1_000_000_000, bytes: 100 * GIB,
        }];
        let mut out = Vec::new();
        check_partitioning(&d, &mut out);
        assert!(!ids(&out).contains(&"ch-over-partitioning"));
    }

    // ── Merges ──────────────────────────────────────────────────────────

    #[test]
    fn a_very_long_merge_warns_and_a_brief_one_is_silent() {
        let mut d = healthy();
        d.merges = vec![ChMerge {
            database: "app".into(), table: "events".into(),
            elapsed_secs: 7200, progress: 0.4, num_parts: 12, is_mutation: false,
        }];
        let mut out = Vec::new();
        check_merges(&d, &mut out);
        assert_eq!(sev(&out, "ch-long-merge"), Some("warn"));

        d.merges[0].elapsed_secs = 30;
        let mut out2 = Vec::new();
        check_merges(&d, &mut out2);
        assert!(!ids(&out2).contains(&"ch-long-merge"));
    }

    // ── Mutations ────────────────────────────────────────────────────────

    #[test]
    fn a_failing_mutation_is_critical() {
        let mut d = healthy();
        d.mutations = vec![ChMutation {
            database: "app".into(), table: "events".into(), mutation_id: "0000000042".into(),
            parts_to_do: 3, fail_reason: "Cannot parse: bad cast".into(), age_secs: 1800,
        }];
        let mut out = Vec::new();
        check_mutations(&d, &mut out);
        assert_eq!(sev(&out, "ch-mutation-failed"), Some("critical"));
        // A failing mutation suppresses the plain-backlog finding (it is the
        // real problem, not the count).
        assert!(!ids(&out).contains(&"ch-mutation-backlog"));
    }

    #[test]
    fn a_large_backlog_of_healthy_mutations_warns() {
        let mut d = healthy();
        d.mutations = (0..25).map(|i| ChMutation {
            database: "app".into(), table: "events".into(),
            mutation_id: format!("{i:010}"), parts_to_do: 1,
            fail_reason: String::new(), age_secs: 120,
        }).collect();
        let mut out = Vec::new();
        check_mutations(&d, &mut out);
        assert_eq!(sev(&out, "ch-mutation-backlog"), Some("warn"));
    }

    // ── Replicas ────────────────────────────────────────────────────────

    #[test]
    fn a_readonly_replica_is_critical() {
        let mut d = healthy();
        d.replicas = vec![ChReplica {
            database: "app".into(), table: "events".into(),
            is_readonly: true, ..Default::default()
        }];
        let mut out = Vec::new();
        check_replicas(&d, &mut out);
        assert_eq!(sev(&out, "ch-replica-readonly"), Some("critical"));
    }

    #[test]
    fn replica_delay_and_queue_bands() {
        let mut d = healthy();
        d.replicas = vec![ChReplica {
            database: "app".into(), table: "events".into(),
            queue_size: 250, absolute_delay: 600, ..Default::default()
        }];
        let mut out = Vec::new();
        check_replicas(&d, &mut out);
        assert_eq!(sev(&out, "ch-replica-queue"), Some("warn"));
        assert_eq!(sev(&out, "ch-replica-delay"), Some("warn"));

        d.replicas[0].queue_size = 5;
        d.replicas[0].absolute_delay = 90;
        let mut out2 = Vec::new();
        check_replicas(&d, &mut out2);
        assert!(!ids(&out2).contains(&"ch-replica-queue"));
        assert_eq!(sev(&out2, "ch-replica-delay"), Some("advice"));
    }

    #[test]
    fn no_replicated_tables_produces_no_replica_findings() {
        let mut out = Vec::new();
        check_replicas(&healthy(), &mut out);
        assert!(out.is_empty());
    }

    // ── Detached ────────────────────────────────────────────────────────

    #[test]
    fn detached_parts_bands() {
        let mut d = healthy();
        d.detached_parts = 100;
        let mut out = Vec::new();
        check_detached(&d, &mut out);
        assert_eq!(sev(&out, "ch-detached-parts"), Some("warn"));

        d.detached_parts = 3;
        let mut out2 = Vec::new();
        check_detached(&d, &mut out2);
        assert_eq!(sev(&out2, "ch-detached-parts"), Some("advice"));

        d.detached_parts = 0;
        let mut out3 = Vec::new();
        check_detached(&d, &mut out3);
        assert!(out3.is_empty());
    }

    // ── Schema ──────────────────────────────────────────────────────────

    #[test]
    fn lowcardinality_flagged_only_when_entirely_unused() {
        let mut d = healthy();
        d.string_columns = 40;
        d.lowcard_columns = 0;
        let mut out = Vec::new();
        check_schema(&d, &mut out);
        assert_eq!(sev(&out, "ch-low-cardinality"), Some("advice"));

        // Any usage at all clears the flag — we do not second-guess per column.
        d.lowcard_columns = 1;
        let mut out2 = Vec::new();
        check_schema(&d, &mut out2);
        assert!(!ids(&out2).contains(&"ch-low-cardinality"));
    }

    // ── Security ──────────────────────────────────────────────────────

    #[test]
    fn password_posture_only_speaks_when_users_are_readable() {
        let mut d = healthy();
        d.users_readable = false;
        d.no_password_users = vec!["default".into()];
        let mut out = Vec::new();
        check_security(&d, &mut out);
        assert!(out.is_empty(), "must stay silent when system.users was denied");

        d.users_readable = true;
        let mut out2 = Vec::new();
        check_security(&d, &mut out2);
        assert_eq!(sev(&out2, "ch-user-no-password"), Some("warn"));
    }

    // ── Contract + scoring ─────────────────────────────────────────────

    #[test]
    fn every_finding_obeys_the_shared_contract() {
        let mut d = healthy();
        d.worst_partition.as_mut().unwrap().parts = 5000;
        d.tables = vec![ChTableParts {
            database: "app".into(), table: "hourly".into(),
            active_parts: 300, partitions: 300, rows: 300_000, bytes: 30 * MIB,
        }];
        d.merges = vec![ChMerge {
            database: "app".into(), table: "events".into(),
            elapsed_secs: 7200, progress: 0.1, num_parts: 20, is_mutation: true,
        }];
        d.mutations = vec![ChMutation {
            database: "app".into(), table: "events".into(), mutation_id: "0000000001".into(),
            parts_to_do: 5, fail_reason: "boom".into(), age_secs: 9000,
        }];
        d.replicas = vec![ChReplica {
            database: "app".into(), table: "events".into(),
            is_readonly: true, queue_size: 500, absolute_delay: 900, ..Default::default()
        }];
        d.detached_parts = 80;
        d.string_columns = 30;
        d.lowcard_columns = 0;
        d.users_readable = true;
        d.no_password_users = vec!["default".into()];
        d.plaintext_password_users = vec!["legacy".into()];

        let out = run_checks(&d, None);
        assert!(!out.is_empty());
        for fi in &out {
            assert!(["performance", "security", "resilience", "schema", "config"]
                .contains(&fi.category.as_str()), "bad category on {}: {}", fi.id, fi.category);
            assert!(["ok", "info", "advice", "warn", "critical"]
                .contains(&fi.severity.as_str()), "bad severity on {}", fi.id);
            assert_eq!(fi.points_lost, match fi.severity.as_str() {
                "critical" => 10, "warn" => 5, "advice" => 2, _ => 0,
            }, "points/severity mismatch on {}", fi.id);
            assert!(!fi.title.is_empty() && !fi.detail.is_empty(), "empty text on {}", fi.id);
        }
        let mut seen = std::collections::HashSet::new();
        for fi in &out { assert!(seen.insert(fi.id.clone()), "duplicate id {}", fi.id); }
    }

    #[test]
    fn a_troubled_server_scores_far_below_a_healthy_one() {
        let good = run_checks(&healthy(), None);
        let gs = crate::tuner::checks::compute_score(&good);

        let mut bad = healthy();
        bad.worst_partition.as_mut().unwrap().parts = 5000; // critical
        bad.mutations = vec![ChMutation {
            database: "a".into(), table: "t".into(), mutation_id: "1".into(),
            parts_to_do: 1, fail_reason: "err".into(), age_secs: 9000,
        }]; // critical resilience
        bad.replicas = vec![ChReplica {
            database: "a".into(), table: "t".into(),
            is_readonly: true, queue_size: 500, absolute_delay: 900, ..Default::default()
        }]; // critical + warns
        bad.detached_parts = 100;
        let bs = crate::tuner::checks::compute_score(&run_checks(&bad, None));

        assert!(bs.total < gs.total, "bad {} should score below good {}", bs.total, gs.total);
        assert!(gs.total >= 95, "a healthy server scored only {}", gs.total);
    }
}
