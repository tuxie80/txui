//! PostgreSQL rule set: pure functions over collected [`PgTunerData`] (+ EOL
//! info), so every threshold is unit-testable with synthetic settings maps —
//! no live server required.
//!
//! Uses the SAME scoring model and category buckets as the MySQL rules
//! (`checks.rs`), so one panel renders both engines:
//!   severity → points_lost: critical 10, warn 5, advice 2, info/ok 0.
//!   category → bucket: performance|config → Performance /40,
//!                      security          → Security /30,
//!                      resilience|schema → Resilience /30.
//!
//! Fix statements are GENERATED ONLY — the tuner never executes them. Where a
//! change needs a restart the `fix_config` block says so, because `ALTER
//! SYSTEM SET` on such a parameter silently stages it until the next restart.

use std::fmt::Write as _;

use super::pg_collectors::PgTunerData;
use super::{EolInfo, Finding};

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

use super::{f, Sev};

use super::fmt_bytes;

/// `ALTER SYSTEM SET` writes postgresql.auto.conf; reload picks up anything
/// that is not restart-only.
fn alter(param: &str, value: &str) -> String {
    format!("ALTER SYSTEM SET {param} = '{value}';\nSELECT pg_reload_conf();")
}

pub fn run_checks(d: &PgTunerData, eol: Option<&EolInfo>) -> Vec<Finding> {
    let mut out = Vec::new();
    check_version(d, eol, &mut out);
    check_memory(d, &mut out);
    check_planner(d, &mut out);
    check_cache_and_temp(d, &mut out);
    check_checkpoints(d, &mut out);
    check_connections(d, &mut out);
    check_autovacuum(d, &mut out);
    check_wraparound(d, &mut out);
    check_durability(d, &mut out);
    check_replication(d, &mut out);
    check_security(d, &mut out);
    check_schema(d, &mut out);
    check_observability(d, &mut out);
    out
}

// ── Version / lifecycle ──────────────────────────────────────────────────────

fn check_version(d: &PgTunerData, eol: Option<&EolInfo>, out: &mut Vec<Finding>) {
    let cloud = d.cloud.as_deref().map(|c| format!(" ({c})")).unwrap_or_default();
    out.push(f("pg-version", "config", Sev::Info,
        format!("PostgreSQL {}{}", d.major, cloud),
        format!("{}\nUptime {}.", d.version.trim(), fmt_uptime(d.uptime_secs)),
        None, vec![], vec![]));

    if d.uptime_secs < 3600 {
        out.push(f("pg-uptime-short", "config", Sev::Info,
            "Server restarted recently",
            format!("Uptime is {} — the cumulative counters (cache hit ratio, checkpoints, \
                     temp files, index usage) have barely accumulated, so ratio-based findings \
                     below are provisional.", fmt_uptime(d.uptime_secs)),
            Some("Re-run the analysis after a representative workload period.".into()),
            vec![], vec![]));
    }

    if let Some(e) = eol {
        match e.status.as_str() {
            "eol" => out.push(f("pg-eol", "resilience", Sev::Critical,
                format!("PostgreSQL {} is end-of-life", e.cycle),
                format!("Community support ended {}. No further fixes are published — \
                         including security fixes.",
                        e.eol_date.clone().unwrap_or_else(|| "(date unknown)".into())),
                Some(format!("Upgrade to a supported major release{}.",
                    e.latest.as_ref().map(|l| format!(" (latest in this line: {l})")).unwrap_or_default())),
                vec![], vec![])),
            "eol-soon" => out.push(f("pg-eol-soon", "resilience", Sev::Warn,
                format!("PostgreSQL {} reaches end-of-life soon", e.cycle),
                format!("Support ends {}. PostgreSQL majors get five years; plan the upgrade now.",
                        e.eol_date.clone().unwrap_or_default()),
                Some("Schedule a major-version upgrade (pg_upgrade or logical replication).".into()),
                vec![], vec![])),
            _ => {}
        }
    }

    if !d.pending_restart.is_empty() {
        let mut list = d.pending_restart.clone();
        list.sort();
        out.push(f("pg-pending-restart", "config", Sev::Warn,
            format!("{} setting(s) changed but not applied", list.len()),
            format!("These parameters have a new value staged that only takes effect after a \
                     restart, so the running server is NOT using them: {}.", list.join(", ")),
            Some("Restart the server during a maintenance window to apply them.".into()),
            vec![], vec![]));
    }
}

fn fmt_uptime(secs: u64) -> String {
    let d = secs / 86400;
    let h = (secs % 86400) / 3600;
    let m = (secs % 3600) / 60;
    if d > 0 { format!("{d}d {h}h") } else if h > 0 { format!("{h}h {m}m") } else { format!("{m}m") }
}

// ── Memory ───────────────────────────────────────────────────────────────────

fn check_memory(d: &PgTunerData, out: &mut Vec<Finding>) {
    let shared = d.bytes("shared_buffers").unwrap_or(0);
    let eff    = d.bytes("effective_cache_size").unwrap_or(0);
    let work   = d.bytes("work_mem").unwrap_or(0);
    let maint  = d.bytes("maintenance_work_mem").unwrap_or(0);
    let maxc   = d.su("max_connections").unwrap_or(0);

    // PostgreSQL exposes no machine RAM, so absolute "% of RAM" advice is not
    // possible from a client connection. Anchor on the defaults instead —
    // 128 MiB is the shipped default and a strong signal nobody tuned this —
    // and on the size of the data actually being served.
    if shared > 0 {
        if shared <= 128 * MIB && d.db_bytes > GIB {
            out.push(f("pg-shared-buffers-default", "performance", Sev::Warn,
                "shared_buffers is at (or near) the default",
                format!("shared_buffers = {} while the cluster holds {} of data. 128 MiB is \
                         PostgreSQL's shipped default and is almost always too small for a real \
                         workload — every page not cached here relies on the OS page cache.",
                        fmt_bytes(shared), fmt_bytes(d.db_bytes)),
                Some("A common starting point is 25% of machine RAM (leave the rest for the OS \
                      page cache and work_mem). This parameter needs a restart.".into()),
                vec![], vec!["# postgresql.conf — requires restart\nshared_buffers = 4GB".into()]));
        } else {
            out.push(f("pg-shared-buffers", "performance", Sev::Ok,
                format!("shared_buffers = {}", fmt_bytes(shared)),
                format!("Cluster data size is {}.", fmt_bytes(d.db_bytes)),
                None, vec![], vec![]));
        }
    }

    // effective_cache_size is a PLANNER HINT, not an allocation. Left at the
    // 4 GiB default on a large machine it makes index scans look expensive.
    if eff > 0 && shared > 0 && eff <= shared {
        out.push(f("pg-effective-cache-size", "performance", Sev::Warn,
            "effective_cache_size is not larger than shared_buffers",
            format!("effective_cache_size = {} vs shared_buffers = {}. This setting allocates \
                     nothing — it tells the planner how much memory the OS page cache is likely \
                     to have. Setting it too low makes index scans look expensive and pushes the \
                     planner toward sequential scans.",
                    fmt_bytes(eff), fmt_bytes(shared)),
            Some("Typically 50–75% of machine RAM. Safe to change at runtime.".into()),
            vec![alter("effective_cache_size", "12GB")], vec![]));
    }

    // Worst case is per-SORT, not per-connection: a single query can open
    // several work_mem allocations at once.
    if work > 0 && maxc > 0 {
        let worst = work.saturating_mul(maxc);
        let sev = if worst > 64 * GIB { Sev::Warn } else { Sev::Info };
        out.push(f("pg-work-mem-headroom", "performance", sev,
            format!("work_mem × max_connections = {}", fmt_bytes(worst)),
            format!("work_mem = {} and max_connections = {}. work_mem is allocated PER SORT OR \
                     HASH NODE, not per connection, so a single complex query can consume several \
                     multiples of it — treat {} as a floor on the worst case, not a ceiling.",
                    fmt_bytes(work), maxc, fmt_bytes(worst)),
            Some("Keep work_mem modest globally and raise it per-session for known-heavy \
                  reporting queries (SET LOCAL work_mem).".into()),
            vec![], vec![]));
    }

    if maint > 0 && maint <= 64 * MIB && d.db_bytes > 10 * GIB {
        out.push(f("pg-maintenance-work-mem", "performance", Sev::Advice,
            "maintenance_work_mem is small for this data size",
            format!("maintenance_work_mem = {} with {} of data. VACUUM, CREATE INDEX and ALTER \
                     TABLE all use this; a small value makes them markedly slower.",
                    fmt_bytes(maint), fmt_bytes(d.db_bytes)),
            Some("512 MiB–2 GiB is typical on a dedicated server. Only a few maintenance \
                  operations run at once, so this is far less risky than work_mem.".into()),
            vec![alter("maintenance_work_mem", "1GB")], vec![]));
    }
}

// ── Planner ──────────────────────────────────────────────────────────────────

fn check_planner(d: &PgTunerData, out: &mut Vec<Finding>) {
    // The 4.0 default assumes a spinning disk where random I/O costs 4× a
    // sequential read. On SSD/NVMe that is simply wrong.
    if let Some(rpc) = d.sf("random_page_cost") {
        if rpc >= 4.0 {
            out.push(f("pg-random-page-cost", "performance", Sev::Advice,
                format!("random_page_cost = {rpc}"),
                "The default of 4.0 models a rotating disk, where a random read costs about four \
                 times a sequential one. On SSD or NVMe the real ratio is close to 1, and leaving \
                 4.0 in place biases the planner against index scans.",
                Some("On SSD/NVMe set 1.1; on a SAN with a large cache 2.0 is a reasonable \
                      middle ground. Safe at runtime.".into()),
                vec![alter("random_page_cost", "1.1")], vec![]));
        }
    }

    if let Some(dst) = d.su("default_statistics_target") {
        if dst <= 100 && d.db_bytes > 50 * GIB {
            out.push(f("pg-statistics-target", "performance", Sev::Advice,
                format!("default_statistics_target = {dst}"),
                format!("With {} of data the default sample can under-represent skewed columns, \
                         producing bad row estimates and bad plans.", fmt_bytes(d.db_bytes)),
                Some("Raise to 250–500 globally, or per-column with ALTER TABLE … ALTER COLUMN \
                      … SET STATISTICS, then ANALYZE.".into()),
                vec![alter("default_statistics_target", "250")], vec![]));
        }
    }

    if d.sb("jit") == Some(true) && d.at_least(11) {
        out.push(f("pg-jit", "performance", Sev::Info,
            "JIT compilation is enabled",
            "JIT helps long analytical queries but adds fixed compilation overhead to every plan \
             that crosses the cost threshold. On OLTP workloads it is a common cause of sudden \
             latency regressions after an upgrade.",
            Some("If short queries regressed, disable it (jit = off) or raise jit_above_cost.".into()),
            vec![alter("jit", "off")], vec![]));
    }
}

// ── Cache / temp files ───────────────────────────────────────────────────────

fn check_cache_and_temp(d: &PgTunerData, out: &mut Vec<Finding>) {
    if let Some(hit) = d.cache_hit_pct() {
        let (sev, note) = if hit < 90.0 {
            (Sev::Warn, "Below 90% means most reads miss shared_buffers and fall through to the OS.")
        } else if hit < 99.0 {
            (Sev::Advice, "Healthy OLTP clusters usually sit above 99%.")
        } else {
            (Sev::Ok, "Reads are being served from shared_buffers.")
        };
        out.push(f("pg-cache-hit", "performance", sev,
            format!("Shared buffer cache hit rate {hit:.2}%"),
            format!("{note} Measured across all databases since the last stats reset \
                     ({} hits / {} disk reads). This counts shared_buffers only — a miss here may \
                     still be served by the OS page cache rather than real disk I/O.",
                    d.blks_hit, d.blks_read),
            if hit < 99.0 { Some("Raise shared_buffers, or reduce the working set.".into()) } else { None },
            vec![], vec![]));
    }

    if d.temp_files > 0 {
        let avg = d.temp_bytes / d.temp_files.max(1);
        let sev = if d.temp_bytes > 10 * GIB { Sev::Warn } else { Sev::Advice };
        out.push(f("pg-temp-files", "performance", sev,
            format!("{} temp files written ({})", d.temp_files, fmt_bytes(d.temp_bytes)),
            format!("Sorts and hashes that exceed work_mem spill to disk. Average spill is {}, \
                     so a work_mem above that would have kept them in memory.", fmt_bytes(avg)),
            Some("Raise work_mem (per-session for the offending queries is safer than globally), \
                  and set log_temp_files to find them.".into()),
            vec![alter("log_temp_files", "0")], vec![]));
    }

    if d.deadlocks > 0 {
        out.push(f("pg-deadlocks", "resilience", Sev::Warn,
            format!("{} deadlock(s) recorded", d.deadlocks),
            "Deadlocks are resolved by killing one transaction, so the application saw errors. \
             They indicate two code paths taking the same locks in different orders.",
            Some("Enable log_lock_waits and deadlock logging, then align lock ordering in the \
                  application.".into()),
            vec![alter("log_lock_waits", "on")], vec![]));
    }

    // Rollback ratio is a cheap proxy for application-level errors.
    let txns = d.xact_commit + d.xact_rollback;
    if txns > 10_000 {
        let pct = d.xact_rollback as f64 * 100.0 / txns as f64;
        if pct > 5.0 {
            out.push(f("pg-rollback-ratio", "resilience", Sev::Advice,
                format!("{pct:.1}% of transactions roll back"),
                format!("{} rollbacks out of {} transactions. A high ratio usually means the \
                         application is erroring out mid-transaction rather than deliberately \
                         aborting.", d.xact_rollback, txns),
                Some("Check the server log for the dominant error.".into()), vec![], vec![]));
        }
    }
}

// ── Checkpoints / WAL ────────────────────────────────────────────────────────

fn check_checkpoints(d: &PgTunerData, out: &mut Vec<Finding>) {
    // A standby performs RESTARTPOINTS, not checkpoints, and those are counted
    // in separate columns — so the ratio below is meaningless there and would
    // read as "no data" rather than as a verdict. Skip it explicitly.
    if d.in_recovery { return; }
    let total = d.ckpt_timed + d.ckpt_req;
    if total > 20 {
        let req_pct = d.ckpt_req as f64 * 100.0 / total as f64;
        if req_pct > 20.0 {
            out.push(f("pg-checkpoints-requested", "performance", Sev::Warn,
                format!("{req_pct:.0}% of checkpoints are demand-driven"),
                format!("{} requested vs {} timed. A 'requested' checkpoint fires because WAL \
                         hit max_wal_size before checkpoint_timeout elapsed — the server is being \
                         forced to flush on WAL volume, which bunches I/O and stalls writes.",
                        d.ckpt_req, d.ckpt_timed),
                Some("Raise max_wal_size so checkpoints are driven by time, not volume.".into()),
                vec![alter("max_wal_size", "8GB")], vec![]));
        } else {
            out.push(f("pg-checkpoints", "performance", Sev::Ok,
                "Checkpoints are time-driven",
                format!("{} timed vs {} requested — WAL volume is not forcing early checkpoints.",
                        d.ckpt_timed, d.ckpt_req),
                None, vec![], vec![]));
        }
    }

    if let Some(t) = d.sf("checkpoint_completion_target") {
        if t < 0.7 {
            out.push(f("pg-checkpoint-completion", "performance", Sev::Advice,
                format!("checkpoint_completion_target = {t}"),
                "This spreads checkpoint writes across the interval. A low value concentrates \
                 them into a burst, causing periodic latency spikes.",
                Some("0.9 is the modern default (and the value PostgreSQL 14+ ships).".into()),
                vec![alter("checkpoint_completion_target", "0.9")], vec![]));
        }
    }

    if let Some(wal) = d.bytes("wal_buffers") {
        if wal > 0 && wal < 4 * MIB {
            out.push(f("pg-wal-buffers", "performance", Sev::Advice,
                format!("wal_buffers = {}", fmt_bytes(wal)),
                "Small WAL buffers force more frequent flushes on write-heavy workloads.",
                Some("16 MB is a good default on any modern server (needs a restart).".into()),
                vec![], vec!["# postgresql.conf — requires restart\nwal_buffers = 16MB".into()]));
        }
    }
}

// ── Connections ──────────────────────────────────────────────────────────────

fn check_connections(d: &PgTunerData, out: &mut Vec<Finding>) {
    let maxc = d.su("max_connections").unwrap_or(0);
    if maxc == 0 { return; }

    // Every PostgreSQL connection is an OS process, so a high ceiling is far
    // more expensive here than the MySQL equivalent.
    if maxc > 300 {
        out.push(f("pg-max-connections", "performance", Sev::Warn,
            format!("max_connections = {maxc}"),
            format!("PostgreSQL forks a process per connection, so a high ceiling costs memory \
                     and scheduler time even when idle — and each one can allocate work_mem \
                     several times over. Currently {} client backends are connected.", d.conns),
            Some("Put a pooler (PgBouncer / pgcat) in front and lower max_connections to roughly \
                  4× CPU cores. This parameter needs a restart.".into()),
            vec![], vec!["# postgresql.conf — requires restart\nmax_connections = 200".into()]));
    }

    let used = d.conns as f64 * 100.0 / maxc as f64;
    if used > 80.0 {
        out.push(f("pg-connection-usage", "resilience", Sev::Warn,
            format!("{used:.0}% of max_connections in use"),
            format!("{} of {} connection slots are occupied. At 100% only superuser_reserved \
                     slots remain and normal logins start failing.", d.conns, maxc),
            Some("Add a connection pooler, or find the client leaking connections.".into()),
            vec![], vec![]));
    }

    if d.idle_in_txn > 0 && d.max_idle_in_txn_secs > 300 {
        out.push(f("pg-idle-in-transaction", "resilience", Sev::Warn,
            format!("{} session(s) idle in transaction, oldest {}",
                    d.idle_in_txn, fmt_uptime(d.max_idle_in_txn_secs)),
            "An open transaction holds its snapshot, which blocks VACUUM from reclaiming dead \
             rows cluster-wide and can hold locks other sessions need. This is the single most \
             common cause of runaway bloat.",
            Some("Set idle_in_transaction_session_timeout so the server reaps them, and fix the \
                  client that leaves transactions open.".into()),
            vec![alter("idle_in_transaction_session_timeout", "60s")], vec![]));
    }

    if d.millis("idle_in_transaction_session_timeout") == Some(0) {
        out.push(f("pg-idle-txn-timeout-unset", "resilience", Sev::Advice,
            "idle_in_transaction_session_timeout is disabled",
            "With no timeout, one forgotten transaction can block VACUUM indefinitely and bloat \
             every table in the cluster.",
            Some("A few minutes is safe for most applications.".into()),
            vec![alter("idle_in_transaction_session_timeout", "5min")], vec![]));
    }

    if d.millis("statement_timeout") == Some(0) {
        out.push(f("pg-statement-timeout-unset", "resilience", Sev::Advice,
            "statement_timeout is disabled",
            "Any single query can run forever, holding locks and connection slots.",
            Some("Set a global ceiling and raise it per-session for known-long jobs.".into()),
            vec![alter("statement_timeout", "60s")], vec![]));
    }
}

// ── Autovacuum ───────────────────────────────────────────────────────────────

fn check_autovacuum(d: &PgTunerData, out: &mut Vec<Finding>) {
    if d.sb("autovacuum") == Some(false) {
        out.push(f("pg-autovacuum-off", "resilience", Sev::Critical,
            "autovacuum is DISABLED",
            "Dead rows are never reclaimed and the transaction ID counter is never advanced. \
             This ends in unbounded bloat and, eventually, a forced shutdown to prevent \
             transaction ID wraparound.",
            Some("Turn it back on. Disabling autovacuum is almost never the right fix for the \
                  problem it is usually reached for.".into()),
            vec![alter("autovacuum", "on")], vec![]));
    }

    if !d.bloated.is_empty() {
        let mut detail = String::from("Tables where dead tuples exceed 20% of live rows:\n");
        for t in d.bloated.iter().take(5) {
            let pct = if t.live > 0 { t.dead as f64 * 100.0 / t.live as f64 } else { 0.0 };
            let staleness = match t.vacuum_age_secs {
                Some(age) => format!("last vacuumed {} ago", fmt_uptime(age.max(0) as u64)),
                None => "never vacuumed".to_string(),
            };
            let _ = writeln!(detail, "  {} — {} dead / {} live ({pct:.0}%), {staleness}", t.name, t.dead, t.live);
        }
        detail.push_str("Bloat wastes storage and makes every scan read more pages.");
        out.push(f("pg-bloat", "schema", Sev::Warn,
            format!("{} table(s) with heavy dead-tuple bloat", d.bloated.len()),
            detail,
            Some("Check for long-running transactions or unused replication slots holding the \
                  snapshot back; then VACUUM (or VACUUM FULL in a maintenance window — it takes \
                  an ACCESS EXCLUSIVE lock and rewrites the table).".into()),
            d.bloated.iter().take(3).map(|t| format!("VACUUM (ANALYZE, VERBOSE) {};", t.name)).collect(),
            vec![]));
    }

    // Autovacuum falling behind: dead tuples outrun the table's own effective
    // threshold (threshold + scale_factor × live rows, reloptions honored), so
    // the launcher should already have fired — or is configured too lax to.
    if !d.vacuum_laggards.is_empty() {
        let worst = d.vacuum_laggards.iter()
            .map(|t| if t.threshold > 0 { t.dead as f64 / t.threshold as f64 } else { 0.0 })
            .fold(0.0, f64::max);
        let sev = if worst > 5.0 { Sev::Warn } else { Sev::Advice };
        let mut detail = String::from("Dead tuples vs the effective autovacuum threshold:\n");
        for t in d.vacuum_laggards.iter().take(5) {
            let ratio = if t.threshold > 0 { t.dead as f64 / t.threshold as f64 } else { 0.0 };
            let staleness = match t.vacuum_age_secs {
                Some(age) => format!("last vacuumed {} ago", fmt_uptime(age.max(0) as u64)),
                None => "never vacuumed".to_string(),
            };
            let _ = writeln!(detail, "  {} — {} dead vs threshold {} ({ratio:.1}×), {staleness}",
                t.name, t.dead, t.threshold);
        }
        detail.push_str("Autovacuum fires at the threshold, so these tables are either being \
                         outrun by their write rate or throttled below it — dead tuples are \
                         accumulating faster than they are reclaimed.");
        let mut fix: Vec<String> = d.vacuum_laggards.iter().take(3)
            .map(|t| format!("VACUUM (ANALYZE, VERBOSE) {};", t.name)).collect();
        if let Some(t) = d.vacuum_laggards.first() {
            fix.push(format!(
                "-- keep autovacuum ahead of this table's write rate:\n\
                 ALTER TABLE {} SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000);",
                t.name));
        }
        out.push(f("pg-autovacuum-behind", "resilience", sev,
            format!("{} table(s) outrunning autovacuum (worst {:.1}× threshold)",
                d.vacuum_laggards.len(), worst),
            detail,
            Some("Lower autovacuum_vacuum_scale_factor per table (large tables need 0.02, not \
                  the 0.2 default), and raise autovacuum_vacuum_cost_limit if workers cannot \
                  keep up. Also check for idle-in-transaction sessions or inactive slots \
                  pinning the vacuum horizon.".into()),
            fix, vec![]));
    }

    if d.never_analyzed > 0 {
        out.push(f("pg-never-analyzed", "schema", Sev::Warn,
            format!("{} table(s) have never been analyzed", d.never_analyzed),
            "Without statistics the planner guesses row counts, which reliably produces bad join \
             orders and bad index choices.",
            Some("Run ANALYZE across the database, and confirm autovacuum is keeping up.".into()),
            vec!["ANALYZE;".into()], vec![]));
    }

    if let Some(nap) = d.millis("autovacuum_naptime") {
        if nap > 300_000 {
            out.push(f("pg-autovacuum-naptime", "resilience", Sev::Advice,
                format!("autovacuum_naptime = {}s", nap / 1000),
                "Long naps let dead tuples pile up between runs on a busy cluster.",
                Some("60s is the default and works for most workloads.".into()),
                vec![alter("autovacuum_naptime", "60s")], vec![]));
        }
    }

    if let Some(limit) = d.su("autovacuum_vacuum_cost_limit") {
        // -1 means "inherit vacuum_cost_limit", normally 200 — quite throttled.
        if limit != 0 && limit <= 200 && d.db_bytes > 50 * GIB {
            out.push(f("pg-autovacuum-throttle", "performance", Sev::Advice,
                format!("autovacuum_vacuum_cost_limit = {limit}"),
                format!("With {} of data the default cost limit throttles autovacuum hard, so it \
                         can fall permanently behind the write rate.", fmt_bytes(d.db_bytes)),
                Some("Raise to 1000–3000 on modern storage, and consider more \
                      autovacuum_max_workers.".into()),
                vec![alter("autovacuum_vacuum_cost_limit", "2000")], vec![]));
        }
    }
}

// ── Transaction ID wraparound ────────────────────────────────────────────────

fn check_wraparound(d: &PgTunerData, out: &mut Vec<Finding>) {
    // Hard stop is 2^31; PostgreSQL refuses new transactions well before that.
    const DANGER: i64 = 1_500_000_000;
    const WARN: i64 = 1_000_000_000;
    const NOTE: i64 = 500_000_000;

    let age = d.max_db_age.max(d.max_table_age);
    if age >= DANGER {
        out.push(f("pg-wraparound", "resilience", Sev::Critical,
            format!("Transaction ID age {age} — wraparound risk"),
            "PostgreSQL stops accepting write transactions at roughly 2.1 billion to protect \
             data, and recovery from that state requires a single-user-mode VACUUM. This is one \
             of the few PostgreSQL failure modes that takes the cluster fully offline.",
            Some("Vacuum the oldest tables NOW and find what is blocking freezing — usually a \
                  long transaction, an abandoned prepared transaction, or an inactive \
                  replication slot.".into()),
            vec!["VACUUM (FREEZE, VERBOSE);".into()], vec![]));
    } else if age >= WARN {
        out.push(f("pg-wraparound-warn", "resilience", Sev::Warn,
            format!("Transaction ID age {age}"),
            "Freezing is falling behind. There is headroom, but the trend matters more than the \
             number.",
            Some("Confirm autovacuum is completing, and check for anything holding an old \
                  snapshot.".into()),
            vec![], vec![]));
    } else if age >= NOTE {
        out.push(f("pg-wraparound-note", "resilience", Sev::Advice,
            format!("Transaction ID age {age}"),
            "Within normal range, but worth watching if it keeps climbing.",
            None, vec![], vec![]));
    }
}

// ── Durability ───────────────────────────────────────────────────────────────

fn check_durability(d: &PgTunerData, out: &mut Vec<Finding>) {
    if d.sb("fsync") == Some(false) {
        out.push(f("pg-fsync-off", "resilience", Sev::Critical,
            "fsync is OFF — data loss on crash is guaranteed",
            "With fsync off PostgreSQL does not force writes to durable storage. An OS crash or \
             power loss leaves the cluster corrupt, not merely missing recent transactions. This \
             is only ever acceptable on a throwaway instance.",
            Some("Turn fsync on unless this cluster's entire contents are disposable.".into()),
            vec![alter("fsync", "on")], vec![]));
    }

    if d.sb("full_page_writes") == Some(false) {
        out.push(f("pg-full-page-writes-off", "resilience", Sev::Critical,
            "full_page_writes is OFF",
            "This protects against torn pages when the OS writes a partial block during a crash. \
             Disabling it risks unrecoverable corruption on any storage that is not \
             atomic-write-safe.",
            Some("Turn it on unless the storage layer guarantees atomic 8 kB writes.".into()),
            vec![alter("full_page_writes", "on")], vec![]));
    }

    if let Some("off") = d.s("synchronous_commit") { out.push(f("pg-synchronous-commit-off", "resilience", Sev::Warn,
    "synchronous_commit is OFF",
    "Commits return before WAL reaches disk. The cluster stays consistent after a crash, \
     but the most recent transactions are lost — a deliberate trade that must be an \
     explicit choice, not a leftover.",
    Some("Turn it on for anything transactional; keep it off only for bulk-load or \
          loss-tolerant data.".into()),
    vec![alter("synchronous_commit", "on")], vec![])) }

    if d.sb("data_checksums") == Some(false) {
        out.push(f("pg-data-checksums", "resilience", Sev::Advice,
            "Data checksums are not enabled",
            "Without checksums, silent storage corruption is discovered only when the damaged \
             data is read and misinterpreted.",
            Some("Checksums are set at initdb time; enabling later needs pg_checksums with the \
                  cluster stopped (PG 12+).".into()),
            vec![], vec![]));
    }

    if let Some("minimal") = d.s("wal_level") { out.push(f("pg-wal-level-minimal", "resilience", Sev::Critical,
    "wal_level = minimal — no PITR, no replication",
    "'minimal' logs only what crash recovery needs. Point-in-time recovery and streaming \
     replication are both impossible, so the only recovery path is the last full \
     backup.",
    Some("Use 'replica' for physical replication/PITR, or 'logical' if you need logical \
          decoding. Needs a restart.".into()),
    vec![], vec!["# postgresql.conf — requires restart\nwal_level = replica".into()])) }

    if d.sb("archive_mode") == Some(false) && !d.in_recovery {
        out.push(f("pg-archive-mode-off", "resilience", Sev::Warn,
            "archive_mode is off — no point-in-time recovery",
            "WAL segments are recycled rather than archived, so recovery can only go back to the \
             last base backup. Any window between backups is unrecoverable.",
            Some("Enable WAL archiving (or a tool that manages it: pgBackRest, barman, wal-g). \
                  Needs a restart.".into()),
            vec![], vec!["# postgresql.conf — requires restart\narchive_mode = on\narchive_command = '…'".into()]));
    }
}

// ── Replication ──────────────────────────────────────────────────────────────

fn check_replication(d: &PgTunerData, out: &mut Vec<Finding>) {
    // The classic PostgreSQL outage: a slot nobody removed pins WAL forever
    // and fills the disk.
    if d.slots_inactive > 0 {
        let sev = if d.slot_retained_bytes > 10 * GIB { Sev::Critical } else { Sev::Warn };
        out.push(f("pg-inactive-slots", "resilience", sev,
            format!("{} inactive replication slot(s) retaining {}",
                    d.slots_inactive, fmt_bytes(d.slot_retained_bytes)),
            "An inactive slot still pins WAL. PostgreSQL will keep every segment the slot has not \
             confirmed — until the WAL volume fills and the server shuts down. It also holds back \
             the vacuum horizon, so bloat grows at the same time.",
            Some("Drop slots left behind by decommissioned replicas, and set \
                  max_slot_wal_keep_size (PG 13+) so a stuck slot can never fill the disk.".into()),
            vec!["SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained\n  FROM pg_replication_slots WHERE NOT active;".into(),
                 "-- then, for each one confirmed dead:\n-- SELECT pg_drop_replication_slot('<slot_name>');".into()],
            vec![]));
    }

    if d.at_least(13) && d.slots_total > 0 {
        if let Some(keep) = d.bytes("max_slot_wal_keep_size") {
            if keep == 0 && d.s("max_slot_wal_keep_size") == Some("-1") {
                out.push(f("pg-slot-wal-keep", "resilience", Sev::Advice,
                    "max_slot_wal_keep_size is unlimited",
                    "With no cap, a stalled replication slot can retain WAL until the disk is \
                     full and the server stops.",
                    Some("Set a bound the volume can absorb; a slot that exceeds it is \
                          invalidated instead of taking the primary down.".into()),
                    vec![alter("max_slot_wal_keep_size", "50GB")], vec![]));
            }
        }
    }

    if d.max_replica_lag_bytes > GIB {
        out.push(f("pg-replica-lag", "resilience", Sev::Warn,
            format!("Replica lag up to {}", fmt_bytes(d.max_replica_lag_bytes)),
            format!("{} streaming replica(s) connected; the furthest behind has not replayed \
                     {} of WAL. A failover now would lose that much.",
                    d.replica_count, fmt_bytes(d.max_replica_lag_bytes)),
            Some("Check network throughput and replica disk I/O.".into()), vec![], vec![]));
    }

    if d.in_recovery {
        out.push(f("pg-in-recovery", "config", Sev::Info,
            "This server is a standby",
            "The cluster is in recovery, so it is read-only and several tuning parameters apply \
             only to the primary.",
            None, vec![], vec![]));
    }
}

// ── Security ─────────────────────────────────────────────────────────────────

fn check_security(d: &PgTunerData, out: &mut Vec<Finding>) {
    match &d.roles {
        None => out.push(f("pg-roles-unreadable", "security", Sev::Info,
            "Role details not readable",
            "pg_authid requires superuser, so password-shape and expiry checks were skipped. \
             This is expected on managed instances (RDS, Cloud SQL).",
            None, vec![], vec![])),
        Some(roles) => {
            let supers: Vec<&str> = roles.iter()
                .filter(|r| r.superuser && r.can_login)
                .map(|r| r.name.as_str()).collect();
            if supers.len() > 2 {
                out.push(f("pg-superusers", "security", Sev::Warn,
                    format!("{} login roles have SUPERUSER", supers.len()),
                    format!("Superusers bypass every permission check, including row-level \
                             security: {}.", supers.join(", ")),
                    Some("Grant the specific privilege instead — or the predefined roles \
                          (pg_read_all_data, pg_monitor) which cover most reasons people reach \
                          for superuser.".into()),
                    vec![], vec![]));
            }

            let no_pw: Vec<&str> = roles.iter()
                .filter(|r| r.can_login && r.no_password)
                .map(|r| r.name.as_str()).collect();
            if !no_pw.is_empty() {
                out.push(f("pg-roles-no-password", "security", Sev::Warn,
                    format!("{} login role(s) have no password set", no_pw.len()),
                    format!("These roles can log in with no password of their own: {}. Whether \
                             that is exploitable depends entirely on pg_hba.conf — if any rule \
                             for them is 'trust', anyone who can reach the port is that role.",
                            no_pw.join(", ")),
                    Some("Set passwords, or restrict them to peer/cert authentication.".into()),
                    vec![], vec![]));
            }

            let md5: Vec<&str> = roles.iter()
                .filter(|r| r.md5_password)
                .map(|r| r.name.as_str()).collect();
            if !md5.is_empty() {
                out.push(f("pg-md5-passwords", "security", Sev::Warn,
                    format!("{} role(s) still use md5 password hashes", md5.len()),
                    format!("md5 is deprecated and its hashes are trivially crackable offline: \
                             {}. PostgreSQL has defaulted to scram-sha-256 since version 14.",
                            md5.join(", ")),
                    Some("Set password_encryption = scram-sha-256, then have each role set its \
                          password again — the hash only changes on a new \\password.".into()),
                    vec![alter("password_encryption", "scram-sha-256")], vec![]));
            }
        }
    }

    if let Some(pe) = d.s("password_encryption") {
        if pe.eq_ignore_ascii_case("md5") {
            out.push(f("pg-password-encryption", "security", Sev::Warn,
                "password_encryption = md5",
                "Every password set from now on is stored as a weak md5 hash.",
                Some("Switch to scram-sha-256; existing hashes are upgraded as each role resets \
                      its password.".into()),
                vec![alter("password_encryption", "scram-sha-256")], vec![]));
        }
    }

    if let Some(hba) = &d.hba {
        let trust = hba.iter().find(|(m, _)| m == "trust").map(|(_, c)| *c).unwrap_or(0);
        if trust > 0 {
            out.push(f("pg-hba-trust", "security", Sev::Critical,
                format!("{trust} pg_hba.conf rule(s) use 'trust' authentication"),
                "'trust' accepts ANY connection matching the rule as the requested role, with no \
                 password whatsoever. If one of these rules covers a network address rather than \
                 a local socket, the cluster is effectively unauthenticated.",
                Some("Replace with scram-sha-256 (or peer for local socket connections), then \
                      reload.".into()),
                vec!["SELECT type, database, user_name, address, auth_method\n  FROM pg_hba_file_rules ORDER BY line_number;".into()],
                vec!["# pg_hba.conf\nhost  all  all  127.0.0.1/32  scram-sha-256".into()]));
        }
        let md5_rules = hba.iter().find(|(m, _)| m == "md5").map(|(_, c)| *c).unwrap_or(0);
        if md5_rules > 0 {
            out.push(f("pg-hba-md5", "security", Sev::Advice,
                format!("{md5_rules} pg_hba.conf rule(s) use md5 authentication"),
                "md5 authentication is deprecated; scram-sha-256 resists offline cracking and \
                 replay.",
                Some("Move the rules to scram-sha-256 once every affected role has a SCRAM \
                      password, then reload.".into()),
                vec![], vec![]));
        }
    }

    if d.sb("ssl") == Some(false) {
        out.push(f("pg-ssl-off", "security", Sev::Warn,
            "SSL is disabled server-side",
            "All client traffic — including passwords on non-SCRAM auth — crosses the network in \
             clear text.",
            Some("Enable ssl with a certificate and key. Harmless for a local-socket-only \
                  cluster, serious for anything reachable over a network.".into()),
            vec![], vec!["# postgresql.conf — requires restart\nssl = on\nssl_cert_file = 'server.crt'\nssl_key_file = 'server.key'".into()]));
    } else if !d.ssl_in_use && d.sb("ssl") == Some(true) {
        out.push(f("pg-ssl-not-in-use", "security", Sev::Info,
            "This session is not encrypted",
            "The server supports SSL but the current connection is not using it.",
            Some("Connect with sslmode=require or stronger.".into()), vec![], vec![]));
    }

    if d.public_create == Some(true) {
        let sev = if d.at_least(15) { Sev::Warn } else { Sev::Advice };
        out.push(f("pg-public-schema-create", "security", sev,
            "PUBLIC can create objects in schema public",
            format!("Any role that can connect may create tables and functions in the public \
                     schema. PostgreSQL 15 removed this default precisely because it enables \
                     search_path-based privilege escalation.{}",
                    if d.at_least(15) { " This cluster is on 15+, so the grant was made deliberately \
                                          or carried over by pg_upgrade." } else { "" }),
            Some("Revoke it unless something depends on it.".into()),
            vec!["REVOKE CREATE ON SCHEMA public FROM PUBLIC;".into()], vec![]));
    }
}

// ── Schema ───────────────────────────────────────────────────────────────────

fn check_schema(d: &PgTunerData, out: &mut Vec<Finding>) {
    if d.tables_total == 0 { return; }

    if d.tables_no_pk > 0 {
        out.push(f("pg-no-pk", "schema", Sev::Warn,
            format!("{} of {} tables have no primary key", d.tables_no_pk, d.tables_total),
            format!("A table without a primary key cannot be replicated logically (REPLICA \
                     IDENTITY FULL turns every update into a full-table match), cannot be safely \
                     deduplicated, and gives ORM/tooling nothing to key on. Largest: {}.",
                    d.no_pk_sample.join(", ")),
            Some("Add a primary key, or at least a UNIQUE NOT NULL column and REPLICA IDENTITY.".into()),
            vec![], vec![]));
    }

    if d.unused_idx > 0 {
        out.push(f("pg-unused-indexes", "schema", Sev::Advice,
            format!("{} unused index(es) occupying {}", d.unused_idx, fmt_bytes(d.unused_idx_bytes)),
            format!("Indexes with zero scans since the last stats reset. Every one still costs \
                     write amplification on INSERT/UPDATE/DELETE and slows VACUUM. Largest: {}. \
                     Primary-key and unique indexes are excluded — they enforce constraints, so \
                     a zero scan count is not a reason to drop them.",
                    d.unused_idx_sample.join(", ")),
            Some("Confirm the counters cover a full business cycle (monthly reports!) before \
                  dropping. Use DROP INDEX CONCURRENTLY so no lock is taken.".into()),
            d.unused_idx_sample.iter().take(3).map(|i| format!("DROP INDEX CONCURRENTLY {i};")).collect(),
            vec![]));
    }

    if d.dup_idx > 0 {
        out.push(f("pg-duplicate-indexes", "schema", Sev::Advice,
            format!("{} duplicate index group(s)", d.dup_idx),
            "Two or more indexes cover the identical column list on the same table. The extra \
             copies add write cost and storage for no read benefit.",
            Some("Drop the redundant copy, keeping whichever a constraint depends on.".into()),
            vec![], vec![]));
    }

    // Index bloat. Exact numbers need pgstattuple (pgstatindex); without it the
    // collector flags the strong heuristic — a large index bigger than the heap
    // it serves. Measured leaf density decides the severity when available.
    if !d.bloated_indexes.is_empty() {
        let measured = d.bloated_indexes.iter().filter(|i| i.leaf_density.is_some()).count();
        let worst_waste = d.bloated_indexes.iter()
            .filter_map(|i| i.leaf_density.map(|ld| 100.0 - ld))
            .fold(0.0, f64::max);
        let sev = if worst_waste >= 50.0 { Sev::Warn } else { Sev::Advice };
        let mut detail = String::new();
        for i in d.bloated_indexes.iter().take(5) {
            let line = format!("  {} — {} vs {} heap", i.name, fmt_bytes(i.size_bytes), fmt_bytes(i.table_bytes));
            match i.leaf_density {
                Some(ld) => { let _ = writeln!(detail, "{line}, measured leaf density {ld:.0}% ({:.0}% wasted)", 100.0 - ld); }
                None => { let _ = writeln!(detail, "{line} (index larger than its table — bloat heuristic)"); }
            }
        }
        let concurrently = d.at_least(12);
        let reindex = |n: &str| if concurrently {
            format!("-- builds a new index alongside the old one; no write lock\nREINDEX INDEX CONCURRENTLY {n};")
        } else {
            format!("-- takes a write lock for the duration (pre-12 has no CONCURRENTLY)\nREINDEX INDEX {n};")
        };
        let mut rec = String::from("REINDEX rebuilds the index from the heap and reclaims the \
                                    wasted space. VACUUM alone cannot shrink an index.");
        if !d.pgstattuple_installed {
            rec.push_str(" These sizes are a heuristic — install pgstattuple \
                          (CREATE EXTENSION pgstattuple) and re-run for measured bloat \
                          percentages per index.");
        } else if measured == 0 {
            rec.push_str(" pgstattuple is installed but the flagged indexes were too large or \
                          not readable to scan — measure manually with pgstatindex('<index>').");
        }
        out.push(f("pg-index-bloat", "schema", sev,
            format!("{} large index(es) show bloat ({} total)",
                d.bloated_indexes.len(),
                fmt_bytes(d.bloated_indexes.iter().map(|i| i.size_bytes).sum())),
            detail, Some(rec),
            d.bloated_indexes.iter().take(3).map(|i| reindex(&i.name)).collect(),
            vec![]));
    }

    if !d.seqscan.is_empty() {
        let mut detail = String::from("Large tables read mostly by sequential scan:\n");
        for t in d.seqscan.iter().take(5) {
            let _ = writeln!(detail, "  {} — {} scans, {} rows read, {} live rows",
                             t.name, t.seq_scan, t.seq_tup_read, t.live);
        }
        detail.push_str("A sequential scan on a large table is not automatically wrong — it is \
                         the right plan for a query touching most rows — but it is where missing \
                         indexes show up.");
        out.push(f("pg-seq-scans", "performance", Sev::Advice,
            format!("{} large table(s) dominated by sequential scans", d.seqscan.len()),
            detail,
            Some("Check the actual queries (pg_stat_statements) before adding indexes.".into()),
            vec![], vec![]));
    }
}

// ── Observability ────────────────────────────────────────────────────────────

fn check_observability(d: &PgTunerData, out: &mut Vec<Finding>) {
    let has_pgss = d.extensions.iter().any(|e| e == "pg_stat_statements");
    if !has_pgss {
        out.push(f("pg-pg-stat-statements", "performance", Sev::Warn,
            "pg_stat_statements is not installed",
            "Without it there is no per-query workload history, which makes every \
             'why is the database slow' investigation guesswork.",
            Some("Preload the library (needs a restart), then create the extension in each \
                  database you want to inspect.".into()),
            vec!["CREATE EXTENSION IF NOT EXISTS pg_stat_statements;".into()],
            vec!["# postgresql.conf — requires restart\nshared_preload_libraries = 'pg_stat_statements'".into()]));
    } else {
        out.push(f("pg-pg-stat-statements-ok", "performance", Sev::Ok,
            "pg_stat_statements is installed",
            "Per-query workload history is being collected.", None, vec![], vec![]));
    }

    if let Some(ms) = d.millis("log_min_duration_statement") {
        if d.s("log_min_duration_statement") == Some("-1") {
            out.push(f("pg-slow-query-log", "performance", Sev::Advice,
                "No slow-query logging",
                "log_min_duration_statement is -1, so nothing is logged by duration and slow \
                 statements leave no trace.",
                Some("Start around 1s and lower it as the noise drops.".into()),
                vec![alter("log_min_duration_statement", "1s")], vec![]));
        } else if ms == 0 {
            out.push(f("pg-log-all-statements", "performance", Sev::Warn,
                "Every statement is being logged",
                "log_min_duration_statement = 0 logs all statements. On a busy server this is a \
                 significant I/O cost in its own right and fills the disk quickly.",
                Some("Raise it to a threshold that captures only genuinely slow queries.".into()),
                vec![alter("log_min_duration_statement", "1s")], vec![]));
        }
    }

    if d.sb("log_checkpoints") == Some(false) {
        out.push(f("pg-log-checkpoints", "performance", Sev::Advice,
            "log_checkpoints is off",
            "Checkpoint timing and volume are the first thing to check for periodic write \
             stalls. PostgreSQL 15 turned this on by default.",
            None, vec![alter("log_checkpoints", "on")], vec![]));
    }

    if d.sb("log_lock_waits") == Some(false) {
        out.push(f("pg-log-lock-waits", "resilience", Sev::Advice,
            "log_lock_waits is off",
            "Sessions blocked past deadlock_timeout are not logged, so lock contention is \
             invisible after the fact.",
            None, vec![alter("log_lock_waits", "on")], vec![]));
    }

    if d.sb("track_io_timing") == Some(false) {
        out.push(f("pg-track-io-timing", "performance", Sev::Advice,
            "track_io_timing is off",
            "Without it, EXPLAIN (ANALYZE, BUFFERS) and pg_stat_statements cannot attribute time \
             to I/O, so you cannot tell a slow query from a slow disk.",
            Some("Overhead is negligible on any platform with a fast clock source.".into()),
            vec![alter("track_io_timing", "on")], vec![]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tuner::pg_collectors::{PgIndexBloat, PgRole, PgTableStat, PgTunerData, PgVacuumLaggard};

    /// Build data from (name, setting, unit) triples.
    fn data(pairs: &[(&str, &str, &str)]) -> PgTunerData {
        let mut d = PgTunerData::default();
        d.major = 16;
        d.version_num = 160010;
        d.uptime_secs = 7 * 86400;
        for (k, v, u) in pairs {
            d.settings.insert((*k).into(), (*v).into());
            if !u.is_empty() { d.units.insert((*k).into(), (*u).into()); }
        }
        d
    }

    fn ids(findings: &[Finding]) -> Vec<&str> {
        findings.iter().map(|f| f.id.as_str()).collect()
    }

    fn sev_of<'a>(findings: &'a [Finding], id: &str) -> Option<&'a str> {
        findings.iter().find(|f| f.id == id).map(|f| f.severity.as_str())
    }

    // ── Durability: the things that lose data ────────────────────────────

    #[test]
    fn fsync_off_is_critical() {
        let d = data(&[("fsync", "off", "")]);
        let mut out = Vec::new();
        check_durability(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-fsync-off"), Some("critical"));
    }

    #[test]
    fn fsync_on_produces_no_finding() {
        let d = data(&[("fsync", "on", ""), ("full_page_writes", "on", "")]);
        let mut out = Vec::new();
        check_durability(&d, &mut out);
        assert!(!ids(&out).contains(&"pg-fsync-off"));
        assert!(!ids(&out).contains(&"pg-full-page-writes-off"));
    }

    #[test]
    fn wal_level_minimal_blocks_pitr() {
        let d = data(&[("wal_level", "minimal", "")]);
        let mut out = Vec::new();
        check_durability(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-wal-level-minimal"), Some("critical"));

        let ok = data(&[("wal_level", "replica", "")]);
        let mut out2 = Vec::new();
        check_durability(&ok, &mut out2);
        assert!(!ids(&out2).contains(&"pg-wal-level-minimal"));
    }

    #[test]
    fn archive_mode_is_not_flagged_on_a_standby() {
        // A standby does not archive; flagging it would be noise.
        let mut d = data(&[("archive_mode", "off", "")]);
        d.in_recovery = true;
        let mut out = Vec::new();
        check_durability(&d, &mut out);
        assert!(!ids(&out).contains(&"pg-archive-mode-off"));

        d.in_recovery = false;
        let mut out2 = Vec::new();
        check_durability(&d, &mut out2);
        assert!(ids(&out2).contains(&"pg-archive-mode-off"));
    }

    // ── Autovacuum + wraparound ──────────────────────────────────────────

    #[test]
    fn autovacuum_off_is_critical() {
        let d = data(&[("autovacuum", "off", "")]);
        let mut out = Vec::new();
        check_autovacuum(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-autovacuum-off"), Some("critical"));
    }

    #[test]
    fn wraparound_severity_ladder() {
        let mut d = data(&[]);
        for (age, expect) in [
            (100_000_000_i64, None),
            (600_000_000, Some("advice")),
            (1_200_000_000, Some("warn")),
            (1_800_000_000, Some("critical")),
        ] {
            d.max_db_age = age;
            let mut out = Vec::new();
            check_wraparound(&d, &mut out);
            let got = out.first().map(|f| f.severity.as_str());
            assert_eq!(got, expect, "age {age}");
        }
    }

    #[test]
    fn wraparound_uses_the_worse_of_db_and_table_age() {
        let mut d = data(&[]);
        d.max_db_age = 10;
        d.max_table_age = 1_800_000_000;
        let mut out = Vec::new();
        check_wraparound(&d, &mut out);
        assert_eq!(out[0].severity, "critical");
    }

    // ── Replication slots: the classic disk-full outage ──────────────────

    #[test]
    fn inactive_slot_escalates_with_retained_wal() {
        let mut d = data(&[]);
        d.slots_total = 2;
        d.slots_inactive = 1;
        d.slot_retained_bytes = 2 * GIB;
        let mut out = Vec::new();
        check_replication(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-inactive-slots"), Some("warn"));

        d.slot_retained_bytes = 40 * GIB;
        let mut out2 = Vec::new();
        check_replication(&d, &mut out2);
        assert_eq!(sev_of(&out2, "pg-inactive-slots"), Some("critical"));
    }

    #[test]
    fn active_slots_alone_do_not_warn() {
        let mut d = data(&[]);
        d.slots_total = 2;
        d.slots_inactive = 0;
        let mut out = Vec::new();
        check_replication(&d, &mut out);
        assert!(!ids(&out).contains(&"pg-inactive-slots"));
    }

    // ── Security ─────────────────────────────────────────────────────────

    #[test]
    fn trust_auth_is_critical() {
        let mut d = data(&[]);
        d.hba = Some(vec![("trust".into(), 2), ("scram-sha-256".into(), 4)]);
        let mut out = Vec::new();
        check_security(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-hba-trust"), Some("critical"));
        assert!(!ids(&out).contains(&"pg-hba-md5"));
    }

    #[test]
    fn md5_hba_is_advice_not_critical() {
        let mut d = data(&[]);
        d.hba = Some(vec![("md5".into(), 4)]);
        let mut out = Vec::new();
        check_security(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-hba-md5"), Some("advice"));
    }

    #[test]
    fn unreadable_roles_degrade_to_info_not_a_false_pass() {
        let d = data(&[]); // roles = None
        let mut out = Vec::new();
        check_security(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-roles-unreadable"), Some("info"));
        assert!(!ids(&out).contains(&"pg-superusers"));
    }

    #[test]
    fn superuser_count_only_flags_login_roles() {
        let mut d = data(&[]);
        d.roles = Some(vec![
            PgRole { name: "a".into(), superuser: true, can_login: true, ..Default::default() },
            PgRole { name: "b".into(), superuser: true, can_login: true, ..Default::default() },
            PgRole { name: "c".into(), superuser: true, can_login: false, ..Default::default() },
        ]);
        let mut out = Vec::new();
        check_security(&d, &mut out);
        // 2 login superusers is at the threshold, not over it
        assert!(!ids(&out).contains(&"pg-superusers"));

        d.roles.as_mut().unwrap().push(
            PgRole { name: "d".into(), superuser: true, can_login: true, ..Default::default() });
        let mut out2 = Vec::new();
        check_security(&d, &mut out2);
        assert_eq!(sev_of(&out2, "pg-superusers"), Some("warn"));
    }

    #[test]
    fn public_create_is_worse_on_pg15_plus() {
        let mut d = data(&[]);
        d.public_create = Some(true);
        d.major = 14;
        let mut out = Vec::new();
        check_security(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-public-schema-create"), Some("advice"));

        d.major = 16;
        let mut out2 = Vec::new();
        check_security(&d, &mut out2);
        assert_eq!(sev_of(&out2, "pg-public-schema-create"), Some("warn"));
    }

    // ── Performance ──────────────────────────────────────────────────────

    #[test]
    fn cache_hit_ladder() {
        for (hit, read, expect) in [
            (999_u64, 1_u64, "ok"),
            (95, 5, "advice"),
            (80, 20, "warn"),
        ] {
            let mut d = data(&[]);
            d.blks_hit = hit; d.blks_read = read;
            let mut out = Vec::new();
            check_cache_and_temp(&d, &mut out);
            assert_eq!(sev_of(&out, "pg-cache-hit"), Some(expect), "hit={hit} read={read}");
        }
    }

    #[test]
    fn cache_hit_is_skipped_with_no_traffic() {
        let d = data(&[]);
        let mut out = Vec::new();
        check_cache_and_temp(&d, &mut out);
        assert!(!ids(&out).contains(&"pg-cache-hit"), "must not divide by zero or claim 0%");
    }

    #[test]
    fn requested_checkpoints_flag_small_max_wal_size() {
        let mut d = data(&[]);
        d.ckpt_timed = 10; d.ckpt_req = 40;
        let mut out = Vec::new();
        check_checkpoints(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-checkpoints-requested"), Some("warn"));

        d.ckpt_timed = 100; d.ckpt_req = 2;
        let mut out2 = Vec::new();
        check_checkpoints(&d, &mut out2);
        assert_eq!(sev_of(&out2, "pg-checkpoints"), Some("ok"));
    }

    #[test]
    fn checkpoints_are_not_judged_on_a_standby() {
        // Restartpoints are counted in different columns, so the primary's
        // ratio does not apply to a replica.
        let mut d = data(&[]);
        d.ckpt_timed = 10; d.ckpt_req = 40;
        d.in_recovery = true;
        let mut out = Vec::new();
        check_checkpoints(&d, &mut out);
        assert!(out.is_empty(), "no checkpoint verdict on a standby");
    }

    #[test]
    fn checkpoint_ratio_needs_a_sample() {
        // A freshly reset counter must not produce a verdict.
        let mut d = data(&[]);
        d.ckpt_timed = 1; d.ckpt_req = 1;
        let mut out = Vec::new();
        check_checkpoints(&d, &mut out);
        assert!(!ids(&out).contains(&"pg-checkpoints-requested"));
        assert!(!ids(&out).contains(&"pg-checkpoints"));
    }

    #[test]
    fn effective_cache_size_must_exceed_shared_buffers() {
        let d = data(&[
            ("shared_buffers", "16384", "8kB"),        // 128 MiB
            ("effective_cache_size", "16384", "8kB"),  // 128 MiB — equal, wrong
        ]);
        let mut out = Vec::new();
        check_memory(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-effective-cache-size"), Some("warn"));

        let ok = data(&[
            ("shared_buffers", "16384", "8kB"),
            ("effective_cache_size", "524288", "8kB"), // 4 GiB
        ]);
        let mut out2 = Vec::new();
        check_memory(&ok, &mut out2);
        assert!(!ids(&out2).contains(&"pg-effective-cache-size"));
    }

    #[test]
    fn default_shared_buffers_only_flagged_with_real_data() {
        // 128 MiB is fine for an empty cluster; it is a problem at scale.
        let mut d = data(&[("shared_buffers", "16384", "8kB")]);
        d.db_bytes = 10 * MIB;
        let mut out = Vec::new();
        check_memory(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-shared-buffers"), Some("ok"));

        d.db_bytes = 50 * GIB;
        let mut out2 = Vec::new();
        check_memory(&d, &mut out2);
        assert_eq!(sev_of(&out2, "pg-shared-buffers-default"), Some("warn"));
    }

    #[test]
    fn random_page_cost_default_is_flagged_for_ssd() {
        let d = data(&[("random_page_cost", "4", "")]);
        let mut out = Vec::new();
        check_planner(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-random-page-cost"), Some("advice"));

        let tuned = data(&[("random_page_cost", "1.1", "")]);
        let mut out2 = Vec::new();
        check_planner(&tuned, &mut out2);
        assert!(!ids(&out2).contains(&"pg-random-page-cost"));
    }

    #[test]
    fn timeouts_flagged_only_when_disabled() {
        let d = data(&[
            ("max_connections", "100", ""),
            ("statement_timeout", "0", "ms"),
            ("idle_in_transaction_session_timeout", "0", "ms"),
        ]);
        let mut out = Vec::new();
        check_connections(&d, &mut out);
        assert!(ids(&out).contains(&"pg-statement-timeout-unset"));
        assert!(ids(&out).contains(&"pg-idle-txn-timeout-unset"));

        let set = data(&[
            ("max_connections", "100", ""),
            ("statement_timeout", "30000", "ms"),
            ("idle_in_transaction_session_timeout", "60000", "ms"),
        ]);
        let mut out2 = Vec::new();
        check_connections(&set, &mut out2);
        assert!(!ids(&out2).contains(&"pg-statement-timeout-unset"));
        assert!(!ids(&out2).contains(&"pg-idle-txn-timeout-unset"));
    }

    #[test]
    fn high_max_connections_warns() {
        let d = data(&[("max_connections", "1000", "")]);
        let mut out = Vec::new();
        check_connections(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-max-connections"), Some("warn"));
    }

    // ── Schema ───────────────────────────────────────────────────────────

    #[test]
    fn schema_checks_need_tables() {
        let d = data(&[]); // tables_total = 0
        let mut out = Vec::new();
        check_schema(&d, &mut out);
        assert!(out.is_empty(), "an empty cluster must not be scolded");
    }

    #[test]
    fn no_pk_and_unused_indexes_are_reported() {
        let mut d = data(&[]);
        d.tables_total = 10;
        d.tables_no_pk = 3;
        d.no_pk_sample = vec!["public.audit".into()];
        d.unused_idx = 2;
        d.unused_idx_bytes = 500 * MIB;
        d.unused_idx_sample = vec!["public.idx_a".into(), "public.idx_b".into()];
        let mut out = Vec::new();
        check_schema(&d, &mut out);
        assert_eq!(sev_of(&out, "pg-no-pk"), Some("warn"));
        assert_eq!(sev_of(&out, "pg-unused-indexes"), Some("advice"));
        // Drops must be CONCURRENTLY so the suggestion cannot lock a table.
        let fix = out.iter().find(|f| f.id == "pg-unused-indexes").unwrap();
        assert!(fix.fix_sql.iter().all(|s| s.contains("DROP INDEX CONCURRENTLY")));
    }

    #[test]
    fn bloat_reports_the_worst_tables_with_vacuum_sql() {
        let mut d = data(&[]);
        d.bloated = vec![
            PgTableStat { name: "public.orders".into(), live: 10_000, dead: 8_000, ..Default::default() },
        ];
        let mut out = Vec::new();
        check_autovacuum(&d, &mut out);
        let bl = out.iter().find(|f| f.id == "pg-bloat").expect("bloat finding");
        assert_eq!(bl.severity, "warn");
        assert!(bl.detail.contains("public.orders"));
        assert!(bl.detail.contains("never vacuumed"), "staleness must be stated: {}", bl.detail);
        assert!(bl.fix_sql[0].contains("VACUUM"));
    }

    #[test]
    fn bloat_detail_says_how_stale_the_last_vacuum_is() {
        let mut d = data(&[]);
        d.bloated = vec![
            PgTableStat { name: "public.events".into(), live: 10_000, dead: 5_000,
                          vacuum_age_secs: Some(3 * 86400), ..Default::default() },
        ];
        let mut out = Vec::new();
        check_autovacuum(&d, &mut out);
        let bl = out.iter().find(|f| f.id == "pg-bloat").expect("bloat finding");
        assert!(bl.detail.contains("3d"), "vacuum age missing from detail: {}", bl.detail);
    }

    #[test]
    fn autovacuum_behind_severity_follows_the_threshold_ratio() {
        let mut d = data(&[]);
        d.vacuum_laggards = vec![
            PgVacuumLaggard { name: "public.orders".into(), live: 1_000_000, dead: 250_000,
                              threshold: 100_000, vacuum_age_secs: Some(7200) },
        ];
        let mut out = Vec::new();
        check_autovacuum(&d, &mut out);
        let lag = out.iter().find(|f| f.id == "pg-autovacuum-behind").expect("laggard finding");
        assert_eq!(lag.severity, "advice"); // 2.5× threshold
        assert!(lag.detail.contains("2.5×"), "ratio missing: {}", lag.detail);
        assert!(lag.fix_sql.iter().any(|s| s.contains("VACUUM (ANALYZE, VERBOSE) public.orders;")));
        assert!(lag.fix_sql.iter().any(|s| s.contains("autovacuum_vacuum_scale_factor")),
                "per-table tuning fix missing");

        d.vacuum_laggards[0].dead = 600_000; // 6× threshold
        let mut out2 = Vec::new();
        check_autovacuum(&d, &mut out2);
        assert_eq!(sev_of(&out2, "pg-autovacuum-behind"), Some("warn"));

        d.vacuum_laggards.clear();
        let mut out3 = Vec::new();
        check_autovacuum(&d, &mut out3);
        assert!(!ids(&out3).contains(&"pg-autovacuum-behind"));
    }

    #[test]
    fn index_bloat_heuristic_offers_concurrent_reindex() {
        let mut d = data(&[]);
        d.tables_total = 10;
        d.bloated_indexes = vec![
            PgIndexBloat { name: "public.orders_created_idx".into(),
                           size_bytes: 800 * MIB, table_bytes: 600 * MIB, leaf_density: None },
        ];
        let mut out = Vec::new();
        check_schema(&d, &mut out);
        let ib = out.iter().find(|f| f.id == "pg-index-bloat").expect("index bloat finding");
        assert_eq!(ib.severity, "advice");
        assert!(ib.fix_sql.iter().any(|s| s.contains("REINDEX INDEX CONCURRENTLY public.orders_created_idx;")));
        assert!(ib.recommendation.as_deref().unwrap_or("").contains("pgstattuple"),
                "missing pgstattuple must come with the upgrade hint");
    }

    #[test]
    fn measured_index_bloat_escalates_and_skips_the_hint() {
        let mut d = data(&[]);
        d.tables_total = 10;
        d.pgstattuple_installed = true;
        d.bloated_indexes = vec![
            PgIndexBloat { name: "public.orders_created_idx".into(),
                           size_bytes: 800 * MIB, table_bytes: 600 * MIB,
                           leaf_density: Some(38.0) },
        ];
        let mut out = Vec::new();
        check_schema(&d, &mut out);
        let ib = out.iter().find(|f| f.id == "pg-index-bloat").expect("index bloat finding");
        assert_eq!(ib.severity, "warn", "62% wasted must escalate");
        assert!(ib.detail.contains("62% wasted"), "measured waste missing: {}", ib.detail);
        assert!(!ib.recommendation.as_deref().unwrap_or("").contains("CREATE EXTENSION"));
    }

    #[test]
    fn reindex_has_no_concurrently_before_pg12() {
        let mut d = data(&[]);
        d.major = 11;
        d.tables_total = 10;
        d.bloated_indexes = vec![
            PgIndexBloat { name: "public.idx".into(), size_bytes: 800 * MIB,
                           table_bytes: 600 * MIB, leaf_density: None },
        ];
        let mut out = Vec::new();
        check_schema(&d, &mut out);
        let ib = out.iter().find(|f| f.id == "pg-index-bloat").expect("index bloat finding");
        assert!(ib.fix_sql.iter().all(|s| !s.contains("REINDEX INDEX CONCURRENTLY")));
        assert!(ib.fix_sql.iter().any(|s| s.contains("REINDEX INDEX public.idx;")));
    }

    // ── Contract ─────────────────────────────────────────────────────────

    #[test]
    fn every_finding_obeys_the_shared_contract() {
        // Same category/severity vocabulary as the MySQL rules, so one panel
        // and one scoring function serve both engines.
        let mut d = data(&[
            ("fsync", "off", ""), ("autovacuum", "off", ""), ("wal_level", "minimal", ""),
            ("max_connections", "1000", ""), ("work_mem", "4096", "kB"),
            ("shared_buffers", "16384", "8kB"), ("random_page_cost", "4", ""),
            ("statement_timeout", "0", "ms"),
        ]);
        d.tables_total = 5;
        d.tables_no_pk = 1;
        d.blks_hit = 50; d.blks_read = 50;
        d.max_db_age = 1_800_000_000;
        d.hba = Some(vec![("trust".into(), 1)]);
        let out = run_checks(&d, None);

        assert!(!out.is_empty());
        for f in &out {
            assert!(["performance", "security", "resilience", "schema", "config"]
                .contains(&f.category.as_str()), "bad category on {}: {}", f.id, f.category);
            assert!(["ok", "info", "advice", "warn", "critical"]
                .contains(&f.severity.as_str()), "bad severity on {}: {}", f.id, f.severity);
            assert_eq!(f.points_lost, match f.severity.as_str() {
                "critical" => 10, "warn" => 5, "advice" => 2, _ => 0,
            }, "points_lost/severity mismatch on {}", f.id);
            assert!(!f.title.is_empty() && !f.detail.is_empty(), "empty text on {}", f.id);
        }

        // IDs must be unique — the panel keys rows by them.
        let mut seen = std::collections::HashSet::new();
        for f in &out { assert!(seen.insert(f.id.clone()), "duplicate finding id {}", f.id); }
    }

    #[test]
    fn a_badly_configured_server_scores_far_below_a_good_one() {
        let mut bad = data(&[
            ("fsync", "off", ""), ("autovacuum", "off", ""), ("wal_level", "minimal", ""),
            ("archive_mode", "off", ""), ("max_connections", "2000", ""),
            ("statement_timeout", "0", "ms"), ("idle_in_transaction_session_timeout", "0", "ms"),
        ]);
        bad.hba = Some(vec![("trust".into(), 3)]);
        bad.max_db_age = 1_900_000_000;
        bad.tables_total = 50; bad.tables_no_pk = 20;
        bad.blks_hit = 50; bad.blks_read = 50;

        let good = data(&[
            ("fsync", "on", ""), ("full_page_writes", "on", ""), ("autovacuum", "on", ""),
            ("wal_level", "replica", ""), ("archive_mode", "on", ""),
            ("max_connections", "200", ""), ("statement_timeout", "30000", "ms"),
            ("idle_in_transaction_session_timeout", "60000", "ms"),
            ("random_page_cost", "1.1", ""), ("checkpoint_completion_target", "0.9", ""),
            ("log_checkpoints", "on", ""), ("log_lock_waits", "on", ""),
            ("track_io_timing", "on", ""), ("synchronous_commit", "on", ""),
            ("shared_buffers", "524288", "8kB"), ("effective_cache_size", "2097152", "8kB"),
        ]);

        let bad_score = crate::tuner::checks::compute_score(&run_checks(&bad, None));
        let good_score = crate::tuner::checks::compute_score(&run_checks(&good, None));
        assert!(bad_score.total < good_score.total,
                "bad {} should score below good {}", bad_score.total, good_score.total);
        assert!(bad_score.total <= 60, "a server with fsync off scored {}", bad_score.total);
    }
}
