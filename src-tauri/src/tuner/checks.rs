//! The rule set: pure functions over collected [`TunerData`] (+ EOL info),
//! so every threshold is unit-testable with synthetic variable maps — no live
//! server required. Formulas are adapted from MySQLTuner-perl's internals
//! (buffer pool hit rate, thread cache hit rate, max-memory estimate, temp
//! table ratio, …) with cloud/LTS/migration checks the original lacks.
//!
//! Scoring model (deterministic, documented here AND in mod.rs):
//!   severity → points_lost: critical 10, warn 5, advice 2, info/ok 0.
//!   category → bucket: performance|config → Performance /40,
//!                      security          → Security /30,
//!                      resilience|schema → Resilience /30.
//!   Bucket score = max(0, bucket_max − Σ points_lost); total = sum (max 100).

use std::fmt::Write as _;

use super::collectors::{Flavor, FragTable, TunerData};
use super::{EolInfo, Finding, Score};

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

use super::{f, Sev};

use super::fmt_bytes;

/// my.cnf-style size literal ("4G", "512M").
fn cfg_size(bytes: u64) -> String {
    if bytes >= GIB { format!("{}G", bytes.div_ceil(GIB)) }
    else { format!("{}M", bytes.div_ceil(MIB).max(1)) }
}

fn pct(part: u64, whole: u64) -> f64 {
    if whole == 0 { 0.0 } else { part as f64 * 100.0 / whole as f64 }
}

/// Suggested buffer pool: ~125% of actual InnoDB data (headroom for growth),
/// rounded up to 128 MiB, min 512 MiB. Falls back to doubling the current
/// pool when data size is unknown.
fn suggest_pool_bytes(d: &TunerData) -> Option<u64> {
    let cur = d.vu("innodb_buffer_pool_size")?;
    let data = d.schema.as_ref().map(|s| s.innodb_bytes).unwrap_or(0);
    let target = if data > 0 {
        (data * 5 / 4).div_ceil(128 * MIB).max(512 * MIB)
    } else {
        cur.saturating_mul(2)
    };
    Some(target.max(cur))
}

/// MySQLTuner-style max memory estimate:
///   global buffers + per-thread buffers × max_connections.
/// Machine RAM is NOT knowable over SQL — callers must note the assumption.
fn max_memory_estimate(d: &TunerData) -> Option<(u64, u64, u64)> {
    let max_conn = d.vu("max_connections")?;
    let global = d.vu("innodb_buffer_pool_size").unwrap_or(0)
        + d.vu("innodb_log_buffer_size").unwrap_or(0)
        + d.vu("key_buffer_size").unwrap_or(0)
        + d.vu("query_cache_size").unwrap_or(0); // 5.7 only
    let tmp = d.vu("tmp_table_size").unwrap_or(0)
        .min(d.vu("max_heap_table_size").unwrap_or(u64::MAX));
    let per_thread = d.vu("sort_buffer_size").unwrap_or(0)
        + d.vu("join_buffer_size").unwrap_or(0)
        + d.vu("read_buffer_size").unwrap_or(0)
        + d.vu("read_rnd_buffer_size").unwrap_or(0)
        + d.vu("thread_stack").unwrap_or(0)
        + if d.von("log_bin").unwrap_or(false) { d.vu("binlog_cache_size").unwrap_or(0) } else { 0 }
        + tmp;
    Some((global, per_thread, global + per_thread.saturating_mul(max_conn)))
}

pub fn run_checks(d: &TunerData, eol: Option<&EolInfo>) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();
    perf_checks(d, &mut out);
    security_checks(d, &mut out);
    resilience_checks(d, eol, &mut out);
    schema_checks(d, &mut out);
    config_checks(d, &mut out);
    out
}

// ── Performance ──────────────────────────────────────────────────────────────

/// The MySQL performance audit — one topic per function (WP-16 16.4, the
/// shape pg_checks.rs already has). Pure moves: the ~18 numbered rules and
/// their outputs are unchanged.
fn perf_checks(d: &TunerData, out: &mut Vec<Finding>) {


    // Short uptime makes every rate-based check unreliable.
    if d.uptime_secs < 3600 {
        out.push(f("perf.uptime_low", "performance", Sev::Info,
            "Server restarted recently",
            format!("Uptime is only {} s — status-counter ratios below are not yet representative.", d.uptime_secs),
            Some("Re-run the tuner after at least a few hours of typical load.".into()),
            vec![], vec![]));
    }

    perf_memory_checks(d, out);
    perf_connection_checks(d, out);
    perf_workload_checks(d, out);
    perf_slowlog_checks(d, out);
    perf_redo_checks(d, out);
    perf_statement_checks(d, out);
}

/// Buffer pool sizing and the max-memory estimate (rules 1–3).
fn perf_memory_checks(d: &TunerData, out: &mut Vec<Finding>) {
    // 1. Buffer pool hit rate (MySQLTuner: <99% is the classic warning line).
    if let (Some(reads), Some(reqs)) = (d.s("innodb_buffer_pool_reads"), d.s("innodb_buffer_pool_read_requests")) {
        if reqs > 1000 {
            let hit = 100.0 - pct(reads, reqs);
            if hit < 99.0 {
                let (mut sql, mut cfg) = (vec![], vec![]);
                if let Some(b) = suggest_pool_bytes(d) {
                    sql.push(format!("SET GLOBAL innodb_buffer_pool_size = {};", b));
                    cfg.push(format!("innodb_buffer_pool_size = {}", cfg_size(b)));
                }
                out.push(f("perf.buffer_pool_hit_rate", "performance", Sev::Warn,
                    format!("InnoDB buffer pool hit rate is low ({:.2}%)", hit),
                    format!("{} of {} logical reads went to disk. The working set does not fit the {} pool.",
                        reads, reqs, d.vu("innodb_buffer_pool_size").map(fmt_bytes).unwrap_or_else(|| "?".into())),
                    Some("Grow innodb_buffer_pool_size so the hot dataset fits in memory.".into()),
                    sql, cfg));
            } else if hit < 99.9 {
                out.push(f("perf.buffer_pool_hit_rate", "performance", Sev::Advice,
                    format!("InnoDB buffer pool hit rate could be better ({:.2}%)", hit),
                    format!("{} disk reads out of {} logical reads.", reads, reqs),
                    Some("Consider a larger innodb_buffer_pool_size if the dataset is growing.".into()),
                    vec![], vec![]));
            } else {
                out.push(f("perf.buffer_pool_hit_rate", "performance", Sev::Ok,
                    format!("InnoDB buffer pool hit rate is healthy ({:.3}%)", hit),
                    String::new(), None, vec![], vec![]));
            }
        }
    }

    // 2. Pool size vs actual InnoDB data.
    if let (Some(pool), Some(schema)) = (d.vu("innodb_buffer_pool_size"), d.schema.as_ref()) {
        if schema.innodb_bytes > 0 {
            if schema.innodb_bytes > pool.saturating_mul(5) / 4 {
                let sug = suggest_pool_bytes(d).unwrap_or(pool);
                out.push(f("perf.buffer_pool_vs_data", "performance", Sev::Warn,
                    "InnoDB data does not fit the buffer pool",
                    format!("InnoDB data+indexes are {}, pool is {}. Expect physical reads under load.",
                        fmt_bytes(schema.innodb_bytes), fmt_bytes(pool)),
                    Some("Size the pool to ~125% of the hot dataset.".into()),
                    vec![format!("SET GLOBAL innodb_buffer_pool_size = {};", sug)],
                    vec![format!("innodb_buffer_pool_size = {}", cfg_size(sug))]));
            } else if schema.innodb_bytes < pool / 4 && pool >= 2 * GIB {
                out.push(f("perf.buffer_pool_vs_data", "performance", Sev::Advice,
                    "Buffer pool is much larger than the data",
                    format!("InnoDB data is {} but the pool is {} — RAM is parked unused.",
                        fmt_bytes(schema.innodb_bytes), fmt_bytes(pool)),
                    Some("Either shrink the pool or leave headroom for growth — just do it deliberately.".into()),
                    vec![], vec![]));
            } else {
                out.push(f("perf.buffer_pool_vs_data", "performance", Sev::Ok,
                    "Buffer pool sizing matches the dataset",
                    format!("InnoDB data {} vs pool {}.", fmt_bytes(schema.innodb_bytes), fmt_bytes(pool)),
                    None, vec![], vec![]));
            }
        }
    }

    // 3. Max memory estimate. RAM is unknowable over SQL; compare against the
    //    P_S-tracked allocation when available, always as advice (assumption noted).
    if let Some((global, per_thread, max_mem)) = max_memory_estimate(d) {
        let max_conn = d.vu("max_connections").unwrap_or(0);
        let mut detail = format!(
            "Global buffers {} + {} MiB/thread × {} max_connections ⇒ up to {} if every connection allocates everything.",
            fmt_bytes(global), per_thread / MIB, max_conn, fmt_bytes(max_mem));
        let sev = match d.mem_tracked {
            Some(tracked) if max_mem as f64 > tracked * 3.0 => {
                let _ = write!(detail, " Current P_S-tracked allocation is {}.", fmt_bytes(tracked as u64));
                Sev::Advice
            }
            _ => Sev::Info,
        };
        let _ = write!(detail, " Machine RAM is unknown to the tuner — verify this fits the host.");
        out.push(f("perf.max_memory_estimate", "performance", sev,
            format!("Max theoretical memory usage: {}", fmt_bytes(max_mem)),
            detail,
            Some("Keep this comfortably below host RAM (MySQLTuner suggests ≤ 85%) to leave room for the OS page cache.".into()),
            vec![], vec![]));
    }
}

/// Thread cache, peak connections, aborted connects (rules 4–6).
fn perf_connection_checks(d: &TunerData, out: &mut Vec<Finding>) {
    // 4. Thread cache hit rate.
    if let (Some(created), Some(conns)) = (d.s("threads_created"), d.s("connections")) {
        if conns > 100 {
            let hit = 100.0 - pct(created, conns);
            let cur = d.vu("thread_cache_size").unwrap_or(0);
            let suggested = d.s("max_used_connections").unwrap_or(16).clamp(16, 100).max(cur * 2);
            if hit < 70.0 {
                out.push(f("perf.thread_cache", "performance", Sev::Warn,
                    format!("Thread cache hit rate is poor ({:.1}%)", hit),
                    format!("{} threads created for {} connections (cache size {}).", created, conns, cur),
                    Some("Raise thread_cache_size so reconnects reuse cached threads.".into()),
                    vec![format!("SET GLOBAL thread_cache_size = {};", suggested)],
                    vec![format!("thread_cache_size = {}", suggested)]));
            } else if hit < 90.0 {
                out.push(f("perf.thread_cache", "performance", Sev::Advice,
                    format!("Thread cache hit rate is {:.1}%", hit),
                    format!("{} threads created for {} connections (cache size {}).", created, conns, cur),
                    Some("A modest thread_cache_size bump avoids thread creation churn.".into()),
                    vec![format!("SET GLOBAL thread_cache_size = {};", suggested)],
                    vec![format!("thread_cache_size = {}", suggested)]));
            } else {
                out.push(f("perf.thread_cache", "performance", Sev::Ok,
                    format!("Thread cache hit rate is healthy ({:.1}%)", hit),
                    String::new(), None, vec![], vec![]));
            }
        }
    }

    // 5. Peak connection usage.
    if let (Some(used), Some(max_conn)) = (d.s("max_used_connections"), d.vu("max_connections")) {
        if max_conn > 0 {
            let used_pct = pct(used, max_conn);
            let suggested = ((used * 5 / 4).max(used + 10)).max(20);
            if used_pct >= 95.0 {
                out.push(f("perf.connection_usage", "performance", Sev::Warn,
                    format!("Connections nearly exhausted (peak {}% of max)", used_pct as u64),
                    format!("Max_used_connections = {} of {} — refused connections are imminent under a spike.", used, max_conn),
                    Some("Raise max_connections (and check the pool hit rate — more connections need more per-thread RAM).".into()),
                    vec![format!("SET GLOBAL max_connections = {};", suggested)],
                    vec![format!("max_connections = {}", suggested)]));
            } else if used_pct >= 85.0 {
                out.push(f("perf.connection_usage", "performance", Sev::Advice,
                    format!("Connection usage peaked at {}%", used_pct as u64),
                    format!("Max_used_connections = {} of {}.", used, max_conn),
                    Some("Headroom is thin; consider raising max_connections or pooling on the client side.".into()),
                    vec![format!("SET GLOBAL max_connections = {};", suggested)],
                    vec![format!("max_connections = {}", suggested)]));
            } else {
                out.push(f("perf.connection_usage", "performance", Sev::Ok,
                    format!("Connection usage is comfortable (peak {}%)", used_pct as u64),
                    String::new(), None, vec![], vec![]));
            }
        }
    }

    // 6. Aborted connects/clients.
    if let (Some(aborted), Some(conns)) = (d.s("aborted_connects"), d.s("connections")) {
        let rate = pct(aborted, conns);
        if rate >= 5.0 {
            out.push(f("perf.aborted_connects", "performance", Sev::Warn,
                format!("{:.1}% of connection attempts aborted", rate),
                format!("{} aborted of {} attempts — bad credentials, slow handshakes, or max_connect_errors lockouts.", aborted, conns),
                Some("Check the error log for 'Aborted connection' causes; verify clients send correct credentials.".into()),
                vec![], vec![]));
        } else if rate >= 1.0 {
            out.push(f("perf.aborted_connects", "performance", Sev::Advice,
                format!("{:.1}% of connection attempts aborted", rate),
                format!("{} aborted of {} attempts.", aborted, conns),
                Some("Investigate failing clients before they trip max_connect_errors host blocks.".into()),
                vec![], vec![]));
        }
    }
}

/// Temp-table spill, index-less joins, scans, sorts, table cache (rules 7–11).
fn perf_workload_checks(d: &TunerData, out: &mut Vec<Finding>) {
    let uptime_h = (d.uptime_secs.max(1) as f64) / 3600.0;

    // 7. Temp tables spilling to disk (MySQLTuner: >25% is the warning line).
    if let (Some(disk), Some(tmp)) = (d.s("created_tmp_disk_tables"), d.s("created_tmp_tables")) {
        if tmp > 100 {
            let ratio = pct(disk, tmp);
            let cur_tmp = d.vu("tmp_table_size").unwrap_or(0);
            let cur_heap = d.vu("max_heap_table_size").unwrap_or(0);
            let suggested = (cur_tmp.max(cur_heap) * 2).max(64 * MIB);
            let fix = (
                vec![format!("SET GLOBAL tmp_table_size = {0}; SET GLOBAL max_heap_table_size = {0};", suggested)],
                vec![format!("tmp_table_size = {0}\nmax_heap_table_size = {0}", cfg_size(suggested))],
            );
            if ratio > 50.0 {
                out.push(f("perf.tmp_disk_tables", "performance", Sev::Warn,
                    format!("{:.0}% of temp tables go to disk", ratio),
                    format!("{} of {} temp tables exceeded tmp_table_size/max_heap_table_size ({}).",
                        disk, tmp, fmt_bytes(cur_tmp.max(cur_heap))),
                    Some("Raise both variables, and look for BLOB/TEXT columns or big GROUP BYs forcing on-disk temp tables.".into()),
                    fix.0, fix.1));
            } else if ratio > 25.0 {
                out.push(f("perf.tmp_disk_tables", "performance", Sev::Advice,
                    format!("{:.0}% of temp tables go to disk", ratio),
                    format!("{} of {} temp tables spilled to disk (limit {}).", disk, tmp, fmt_bytes(cur_tmp.max(cur_heap))),
                    Some("Raise tmp_table_size and max_heap_table_size together (the smaller one wins).".into()),
                    fix.0, fix.1));
            } else {
                out.push(f("perf.tmp_disk_tables", "performance", Sev::Ok,
                    format!("Temp table disk spill is low ({:.0}%)", ratio),
                    String::new(), None, vec![], vec![]));
            }
        }
    }

    // 8. Joins without indexes (Select_full_join per hour).
    if let Some(fj) = d.s("select_full_join") {
        let per_h = fj as f64 / uptime_h;
        if per_h >= 100.0 {
            out.push(f("perf.full_join_scans", "performance", Sev::Warn,
                format!("{:.0} full joins per hour", per_h),
                format!("{} joins executed without index support since startup. Each one nested-loops the full inner table.", fj),
                Some("Add indexes on join columns; inspect slow queries with EXPLAIN.".into()),
                vec![], vec![]));
        } else if fj > 0 && per_h >= 1.0 {
            out.push(f("perf.full_join_scans", "performance", Sev::Advice,
                format!("{:.1} full joins per hour", per_h),
                format!("{} joins without index support since startup.", fj),
                Some("Review join queries — unindexed joins scale quadratically.".into()),
                vec![], vec![]));
        }
    }

    // 9. Full table scans relative to SELECTs.
    if let (Some(scans), Some(selects)) = (d.s("select_scan"), d.s("com_select")) {
        if selects > 100 && pct(scans, selects) > 25.0 {
            out.push(f("perf.full_table_scans", "performance", Sev::Advice,
                format!("Full scans on {:.0}% of SELECTs", pct(scans, selects)),
                format!("{} select scans for {} SELECT statements.", scans, selects),
                Some("Some of these are fine (small lookup tables) — verify the big ones carry proper indexes.".into()),
                vec![], vec![]));
        }
    }

    // 10. Sort merge passes.
    if let (Some(passes), Some(sorts)) = (d.s("sort_merge_passes"),
        d.s("sort_range").and_then(|r| d.s("sort_scan").map(|s| r + s))) {
        if sorts > 100 && pct(passes, sorts) > 1.0 {
            let cur = d.vu("sort_buffer_size").unwrap_or(0);
            let suggested = (cur * 2).clamp(2 * MIB, 16 * MIB);
            out.push(f("perf.sort_merge_passes", "performance", Sev::Advice,
                format!("{:.1}% of sorts need merge passes", pct(passes, sorts)),
                format!("{} merge passes over {} sorted result sets (sort_buffer_size {}).", passes, sorts, fmt_bytes(cur)),
                Some("Raise sort_buffer_size moderately — beyond ~16 MiB per session rarely pays off.".into()),
                vec![format!("SET GLOBAL sort_buffer_size = {};", suggested)],
                vec![format!("sort_buffer_size = {}", cfg_size(suggested))]));
        }
    }

    // 11. Table open cache efficiency (8.0+ exposes hits/misses directly).
    if let (Some(hits), Some(misses)) = (d.s("table_open_cache_hits"), d.s("table_open_cache_misses")) {
        let total = hits + misses;
        if total > 1000 && pct(misses, total) > 1.0 {
            let cur = d.vu("table_open_cache").unwrap_or(0);
            let suggested = (cur * 2).min(65536);
            out.push(f("perf.table_open_cache", "performance", Sev::Advice,
                format!("Table open cache miss rate {:.1}%", pct(misses, total)),
                format!("{} misses of {} lookups (cache holds {}).", misses, total, cur),
                Some("Raise table_open_cache — misses cost open/close syscalls per query.".into()),
                vec![format!("SET GLOBAL table_open_cache = {};", suggested)],
                vec![format!("table_open_cache = {}", suggested)]));
        }
    } else if let Some(opened) = d.s("opened_tables") {
        // 5.7 heuristic: sustained churn of opened tables.
        if opened as f64 / uptime_h > 400.0 {
            let cur = d.vu("table_open_cache").unwrap_or(0);
            out.push(f("perf.table_open_cache", "performance", Sev::Advice,
                "Table cache is churning",
                format!("{} tables opened since startup (cache holds {}).", opened, cur),
                Some("Raise table_open_cache.".into()),
                vec![format!("SET GLOBAL table_open_cache = {};", (cur * 2).min(65536))],
                vec![format!("table_open_cache = {}", (cur * 2).min(65536))]));
        }
    }
}

/// Slow-query log state, granularity and volume (rules 12–14).
fn perf_slowlog_checks(d: &TunerData, out: &mut Vec<Finding>) {
    // 12. Slow query log state.
    match d.von("slow_query_log") {
        Some(false) => out.push(f("perf.slow_log_off", "performance", Sev::Advice,
            "Slow query log is OFF",
            "Without it there is no record of which queries hurt — tuning is guesswork.",
            Some("Enable it (and log_queries_not_using_indexes for a week) to build a tuning baseline.".into()),
            vec!["SET GLOBAL slow_query_log = 'ON';".into()],
            vec!["slow_query_log = 1\nlong_query_time = 1".into()])),
        Some(true) => out.push(f("perf.slow_log_off", "performance", Sev::Ok,
            "Slow query log is enabled", String::new(), None, vec![], vec![])),
        None => {}
    }

    // 13. long_query_time granularity.
    if let Some(lqt) = d.vf("long_query_time") {
        if lqt > 2.0 {
            out.push(f("perf.long_query_time", "performance", Sev::Advice,
                format!("long_query_time is {} s", lqt),
                "Modern workloads should treat >1 s as slow; a high threshold hides real problems.",
                Some("Lower to 1 (0.1–0.5 for latency-sensitive OLTP).".into()),
                vec!["SET GLOBAL long_query_time = 1;".into()],
                vec!["long_query_time = 1".into()]));
        }
    }

    // 14. Slow query volume.
    if let (Some(slow), Some(q)) = (d.s("slow_queries"), d.s("queries").or_else(|| d.s("questions"))) {
        if q > 1000 && pct(slow, q) > 5.0 {
            out.push(f("perf.slow_queries", "performance", Sev::Warn,
                format!("{:.1}% of queries are slow", pct(slow, q)),
                format!("{} slow of {} queries at long_query_time={} s.", slow, q, d.v("long_query_time").unwrap_or("?")),
                Some("Analyze the slow log with pt-query-digest; fix the top offenders first.".into()),
                vec![], vec![]));
        }
    }
}

/// InnoDB log buffer and redo capacity (rules 15–16).
fn perf_redo_checks(d: &TunerData, out: &mut Vec<Finding>) {
    // 15. InnoDB log buffer stalls.
    if let Some(waits) = d.s("innodb_log_waits") {
        if waits > 0 {
            let cur = d.vu("innodb_log_buffer_size").unwrap_or(0);
            let suggested = (cur * 2).clamp(16 * MIB, 512 * MIB);
            out.push(f("perf.innodb_log_waits", "performance", Sev::Advice,
                format!("InnoDB log buffer stalled {} times", waits),
                format!("Transactions waited for the {} log buffer to flush — buffer too small for write bursts.", fmt_bytes(cur)),
                Some("Raise innodb_log_buffer_size (requires restart on < 8.0.28).".into()),
                vec![],
                vec![format!("innodb_log_buffer_size = {}", cfg_size(suggested))]));
        }
    }

    // 16. Redo log capacity vs measured write rate (target: ≥ 1h of writes).
    let redo_capacity = d.vu("innodb_redo_log_capacity").or_else(|| {
        // pre-8.0.30: file size × files in group
        match (d.vu("innodb_log_file_size"), d.vu("innodb_log_files_in_group")) {
            (Some(sz), Some(n)) => Some(sz * n),
            (Some(sz), None) => Some(sz * 2),
            _ => None,
        }
    });
    if let (Some(cap), Some(written)) = (redo_capacity, d.s("innodb_os_log_written")) {
        if d.uptime_secs > 1800 {
            let rate = written as f64 / d.uptime_secs as f64; // bytes/s
            if rate > 0.0 {
                let coverage_h = cap as f64 / rate / 3600.0;
                let dynamic = d.at_least(8, 0, 30) && d.flavor != Flavor::Mariadb;
                if coverage_h < 10.0 / 60.0 {
                    let suggested = (rate * 3600.0 * 2.0) as u64; // 2h of writes
                    out.push(f("perf.redo_log_capacity", "performance", Sev::Warn,
                        format!("Redo log covers only {:.0} min of writes", coverage_h * 60.0),
                        format!("{} redo at {:.1}/s — InnoDB is forced into aggressive checkpointing.",
                            fmt_bytes(cap), fmt_bytes(rate as u64)),
                        Some("Grow the redo log to hold ≥1 hour of writes.".into()),
                        if dynamic { vec![format!("SET GLOBAL innodb_redo_log_capacity = {};", suggested)] } else { vec![] },
                        if dynamic { vec![format!("innodb_redo_log_capacity = {}", cfg_size(suggested))] }
                        else { vec![format!("innodb_log_file_size = {}", cfg_size(suggested / 2))] }));
                } else if coverage_h < 1.0 {
                    out.push(f("perf.redo_log_capacity", "performance", Sev::Advice,
                        format!("Redo log covers {:.1} h of writes", coverage_h),
                        format!("{} redo at {:.1}/s. Under write bursts this tightens checkpointing.",
                            fmt_bytes(cap), fmt_bytes(rate as u64)),
                        Some("~1–2 hours of redo coverage is the usual sweet spot.".into()),
                        vec![], vec![]));
                }
            }
        }
    }
}

/// Query cache (5.7) and the top statement by time (rules 17–18).
fn perf_statement_checks(d: &TunerData, out: &mut Vec<Finding>) {
    // 17. Query cache (5.7 only — removed in 8.0).
    if let Some(qc) = d.von("query_cache_type").or_else(|| d.vu("query_cache_size").map(|s| s > 0)) {
        if d.major < 8 {
            if !qc {
                out.push(f("perf.query_cache", "performance", Sev::Advice,
                    "Query cache is disabled",
                    "On 5.7 a small query cache can help read-heavy workloads with repetitive SELECTs.",
                    Some("Enable with query_cache_type=1, query_cache_size=64M — or skip it and plan the 8.0 upgrade (where it is removed).".into()),
                    vec![],
                    vec!["query_cache_type = 1\nquery_cache_size = 64M".into()]));
            } else if let (Some(prunes), Some(inserts)) = (d.s("qcache_lowmem_prunes"), d.s("qcache_inserts")) {
                if inserts > 1000 && pct(prunes, inserts) > 20.0 {
                    out.push(f("perf.query_cache", "performance", Sev::Advice,
                        "Query cache is thrashing",
                        format!("{} prunes for {} inserts — the cache is too small to be useful.", prunes, inserts),
                        Some("Raise query_cache_size or disable the cache entirely.".into()),
                        vec![], vec![]));
                }
            }
        }
    }

    // 18. Top statement by cumulative time (when P_S digest consumer is on).
    if let Some(stmts) = &d.top_statements {
        if let Some(top) = stmts.first() {
            let digest = if top.digest.len() > 120 { format!("{}…", &top.digest[..120]) } else { top.digest.clone() };
            out.push(f("perf.top_statement", "performance", Sev::Info,
                format!("Hottest statement class: {:.1} s total", top.total_secs),
                format!("{} executions — {}", top.count, digest),
                Some("EXPLAIN this statement class first — it dominates server time.".into()),
                vec![], vec![]));
        }
    }
}

// ── Security ─────────────────────────────────────────────────────────────────

/// The MySQL security audit — accounts, then transport (WP-16 16.4,
/// pg_checks.rs's shape). Pure moves: rules 19–29 and their outputs are
/// unchanged.
fn security_checks(d: &TunerData, out: &mut Vec<Finding>) {

    // Historical behavior kept deliberately: an unreadable mysql.user skips
    // the WHOLE security audit, transport checks included.
    if d.users.is_none() {
        out.push(f("sec.accounts_unreadable", "security", Sev::Info,
            "Account checks skipped",
            "mysql.user is not readable with this session's privileges.",
            Some("Run the tuner with an account that has SELECT on mysql.user for the full security audit.".into()),
            vec![], vec![]));
        return;
    }

    sec_account_checks(d, out);
    sec_transport_checks(d, out);
}

/// Account hygiene: anonymous users, exposed root, empty passwords, legacy
/// auth plugins (rules 19–23).
fn sec_account_checks(d: &TunerData, out: &mut Vec<Finding>) {
    let Some(users) = &d.users else { return };

    // 19. Anonymous users.
    let anon: Vec<_> = users.iter().filter(|u| u.user.is_empty()).collect();
    if anon.is_empty() {
        out.push(f("sec.anonymous_users", "security", Sev::Ok,
            "No anonymous accounts", String::new(), None, vec![], vec![]));
    } else {
        out.push(f("sec.anonymous_users", "security", Sev::Critical,
            format!("{} anonymous account(s) exist", anon.len()),
            format!("Empty-user accounts ({}) match ANY username from their host and bypass named-account controls.",
                anon.iter().map(|u| format!("''@'{}'", u.host)).collect::<Vec<_>>().join(", ")),
            Some("Drop them — they are a leftover of old installers/test setups.".into()),
            anon.iter().map(|u| format!("DROP USER ''@'{}';", u.host)).collect(),
            vec![]));
    }

    // 20. root reachable from any host.
    let remote_root: Vec<_> = users.iter().filter(|u| u.user == "root" && u.host == "%").collect();
    if remote_root.is_empty() {
        out.push(f("sec.root_remote", "security", Sev::Ok,
            "root is not remotely reachable", String::new(), None, vec![], vec![]));
    } else {
        out.push(f("sec.root_remote", "security", Sev::Critical,
            "root can log in from any host",
            "root@'%' exposes the superuser to the whole network — brute-force and credential-stuffing target #1.",
            Some("Restrict root to localhost and administer through named per-DBA accounts with least privilege.".into()),
            vec!["-- example: replace root@'%' with a named admin account\nCREATE USER IF NOT EXISTS 'admin'@'10.%' IDENTIFIED BY '…';\nGRANT ALL PRIVILEGES ON *.* TO 'admin'@'10.%' WITH GRANT OPTION;\nDROP USER 'root'@'%';".into()],
            vec![]));
    }

    // 21. Passwordless accounts (password-capable plugin, empty auth string).
    let pwless: Vec<_> = users.iter()
        .filter(|u| u.no_password == Some(true)
            && !u.plugin.is_empty()
            && !u.plugin.contains("auth_socket")
            && !u.plugin.contains("unix_socket"))
        .collect();
    if !pwless.is_empty() {
        out.push(f("sec.empty_password", "security", Sev::Critical,
            format!("{} account(s) have an empty password", pwless.len()),
            pwless.iter().map(|u| format!("'{}'@'{}' (plugin {})", u.user, u.host, u.plugin)).collect::<Vec<_>>().join(", "),
            Some("Set a password or drop the account immediately.".into()),
            pwless.iter().map(|u| format!("ALTER USER '{}'@'{}' IDENTIFIED BY '<strong-password>';", u.user, u.host)).collect(),
            vec![]));
    }

    // 22. mysql_native_password — deprecated in 8.4, gone in innovation/LTS 9.x.
    let native: Vec<_> = users.iter().filter(|u| u.plugin == "mysql_native_password").collect();
    if !native.is_empty() && d.flavor != Flavor::Mariadb {
        let list = native.iter().map(|u| format!("'{}'@'{}'", u.user, u.host)).collect::<Vec<_>>().join(", ");
        if d.at_least(8, 4, 0) {
            out.push(f("sec.mysql_native_password", "security", Sev::Warn,
                format!("{} account(s) still use mysql_native_password", native.len()),
                format!("{} — the plugin is deprecated since 8.4 and removed in newer releases; these accounts break on upgrade.", list),
                Some("Migrate each account to caching_sha2_password before upgrading.".into()),
                vec!["ALTER USER '<user>'@'<host>' IDENTIFIED WITH caching_sha2_password BY '<password>';".into()],
                vec![]));
        } else {
            out.push(f("sec.mysql_native_password", "security", Sev::Advice,
                format!("{} account(s) use mysql_native_password", native.len()),
                format!("{} — fine on {}, but a hard blocker for 8.4/9.x migration.", list, d.version),
                Some("Migrate to caching_sha2_password at leisure; it also gives SHA-256-grade hashing.".into()),
                vec![], vec![]));
        }
    }

    // 23. sha256_password — superseded by caching_sha2.
    let sha: Vec<_> = users.iter().filter(|u| u.plugin == "sha256_password").collect();
    if !sha.is_empty() {
        out.push(f("sec.sha256_password", "security", Sev::Info,
            format!("{} account(s) use sha256_password", sha.len()),
            "caching_sha2_password is the faster, current default with equivalent strength.",
            Some("Re-identify those accounts with caching_sha2_password.".into()),
            vec![], vec![]));
    }
}

/// Transport and server hardening: secure transport, TLS versions, this
/// session's own encryption, local_infile, skip_name_resolve (rules 24–29).
fn sec_transport_checks(d: &TunerData, out: &mut Vec<Finding>) {
    // 24. require_secure_transport.
    match d.von("require_secure_transport") {
        Some(false) => {
            let sev = if d.cloud.is_some() { Sev::Info } else { Sev::Advice };
            out.push(f("sec.require_secure_transport", "security", sev,
                "Plain-text connections are accepted",
                "require_secure_transport is OFF — clients can connect without TLS and send credentials in the clear.",
                Some("Turn it on once all clients support TLS (skip if this is a local/dev box).".into()),
                vec!["SET GLOBAL require_secure_transport = 'ON';".into()],
                vec!["require_secure_transport = ON".into()]));
        }
        Some(true) => out.push(f("sec.require_secure_transport", "security", Sev::Ok,
            "TLS is required for new connections", String::new(), None, vec![], vec![])),
        None => {}
    }

    // 25. Weak TLS protocol versions allowed.
    if let Some(tls) = d.v("tls_version") {
        let weak: Vec<&str> = ["TLSv1", "TLSv1.1"].iter()
            .filter(|v| tls.split(',').any(|t| t.trim() == **v))
            .copied().collect();
        if !weak.is_empty() {
            let mut sql = vec![];
            if d.at_least(8, 0, 16) {
                sql.push("SET GLOBAL tls_version = 'TLSv1.2,TLSv1.3';".to_string());
            }
            out.push(f("sec.tls_old", "security", Sev::Warn,
                format!("Deprecated TLS versions enabled: {}", weak.join(", ")),
                format!("tls_version = '{}' — TLSv1/1.1 are RFC-deprecated and fail PCI-DSS.", tls),
                Some("Restrict to TLSv1.2,TLSv1.3.".into()),
                sql,
                vec!["tls_version = TLSv1.2,TLSv1.3".into()]));
        }
    }

    // 26. SSL compiled out entirely.
    if d.v("have_ssl").map(|v| v.eq_ignore_ascii_case("disabled")) == Some(true) {
        out.push(f("sec.ssl_disabled", "security", Sev::Advice,
            "SSL support is DISABLED in this build",
            "No TLS is possible at all — every connection is plain text.",
            Some("Use a distribution with OpenSSL support, or terminate TLS in a proxy.".into()),
            vec![], vec![]));
    }

    // 27. This very session is unencrypted (Unix socket is fine).
    if let Some(ssl) = &d.session_ssl_version {
        if ssl.is_empty() && d.v("have_ssl").map(|v| v.eq_ignore_ascii_case("yes")).unwrap_or(false) {
            out.push(f("sec.session_unencrypted", "security", Sev::Info,
                "This analysis session is not using TLS",
                "Ssl_version is empty for the current connection (fine over unix socket, risky over TCP).",
                Some("Set SSL mode to REQUIRED on TCP connections.".into()),
                vec![], vec![]));
        }
    }

    // 27b. TxUI's own session is pinned to UTC and the server is not.
    //
    // Not a server misconfiguration — a client one, and ours. sqlx defaults
    // `MySqlConnectOptions::timezone` to `+00:00` so that TIMESTAMP values
    // decode consistently (the MySQL protocol carries no offset with them).
    // The cost is that `NOW()`, `CURDATE()` and every TIMESTAMP render in UTC
    // here while the `mysql` CLI, DBeaver and the application itself see the
    // server's zone. Measured on a UTC+2 host: TxUI 07:36, CLI 09:35, same
    // instant. Someone comparing a screenshot to a log will lose an hour to
    // this, so it is worth saying out loud rather than leaving to be
    // discovered.
    if let Some((session_tz, global_tz)) = &d.session_time_zone {
        let server_is_elsewhere = !global_tz.eq_ignore_ascii_case(session_tz)
            && !matches!(global_tz.as_str(), "+00:00" | "UTC");
        if session_tz == "+00:00" && server_is_elsewhere {
            out.push(f("tz.session_differs_from_server", "config", Sev::Info,
                "TxUI reads this server in UTC, other clients do not",
                format!("This session runs with time_zone = '{session_tz}' while the server's \
                         global time_zone is '{global_tz}'. NOW(), CURDATE() and TIMESTAMP \
                         columns therefore render in UTC in TxUI and in the server's zone in \
                         the mysql CLI or DBeaver — the same row can show two different times."),
                Some("Nothing is wrong with the server. Read timestamps here as UTC, or \
                      SELECT CONVERT_TZ(col, '+00:00', @@global.time_zone) when comparing \
                      against another client's output.".into()),
                vec![], vec![]));
        }
    }

    // 28. local_infile — LOAD DATA LOCAL injection vector.
    if d.von("local_infile") == Some(true) {
        out.push(f("sec.local_infile", "security", Sev::Advice,
            "local_infile is ON",
            "A rogue server (or MITM on plain-text links) can read arbitrary client files via LOAD DATA LOCAL.",
            Some("Disable unless CSV imports depend on it.".into()),
            vec!["SET GLOBAL local_infile = 'OFF';".into()],
            vec!["local_infile = 0".into()]));
    }

    // 29. skip_name_resolve off → DNS in the connect path.
    if d.von("skip_name_resolve") == Some(false) {
        out.push(f("sec.skip_name_resolve", "security", Sev::Info,
            "DNS reverse lookups are enabled",
            "Every TCP connect waits on reverse DNS; a slow resolver stalls logins. Host-based grants also become ambiguous.",
            Some("Set skip_name_resolve=ON and grant by IP (note: host-name grants stop working).".into()),
            vec![],
            vec!["skip_name_resolve = ON".into()]));
    }
}

// ── Resilience ───────────────────────────────────────────────────────────────

fn resilience_checks(d: &TunerData, eol: Option<&EolInfo>, out: &mut Vec<Finding>) {
    // 30. EOL status (feeds score: eol = critical, eol-soon = warn).
    if let Some(e) = eol {
        match e.status.as_str() {
            "eol" => out.push(f("res.eol", "resilience", Sev::Critical,
                format!("{} {} is END OF LIFE", e.product, e.cycle),
                format!("Support ended {}. No more security patches — every new CVE is permanent.",
                    e.eol_date.clone().unwrap_or_default()),
                Some("Plan an urgent upgrade to a supported LTS release.".into()),
                vec![], vec![])),
            "eol-soon" => out.push(f("res.eol", "resilience", Sev::Warn,
                format!("{} {} approaches end of life", e.product, e.cycle),
                format!("Support ends {} (< 180 days).", e.eol_date.clone().unwrap_or_default()),
                Some("Schedule the upgrade now, while there is room to test.".into()),
                vec![], vec![])),
            "supported" => out.push(f("res.eol", "resilience", Sev::Ok,
                format!("{} {} is in support", e.product, e.cycle),
                match (&e.eol_date, &e.latest) {
                    (Some(date), Some(latest)) => format!("Supported until {}. Latest in cycle: {} (running {}).", date, latest, d.version),
                    _ => String::new(),
                },
                None, vec![], vec![])),
            _ => out.push(f("res.eol", "resilience", Sev::Info,
                format!("EOL status of {} {} unknown", e.product, e.cycle),
                format!("Cycle not found in the {} data source — the release may be too new or too old.", e.source),
                None, vec![], vec![])),
        }
    }

    let binlog_on = d.von("log_bin").unwrap_or(false);

    // 31. sync_binlog durability.
    if binlog_on {
        match d.vu("sync_binlog") {
            Some(1) => out.push(f("res.sync_binlog", "resilience", Sev::Ok,
                "sync_binlog = 1 (crash-safe)", String::new(), None, vec![], vec![])),
            Some(n) => out.push(f("res.sync_binlog", "resilience", Sev::Warn,
                format!("sync_binlog = {} — binlog can lose transactions", n),
                "On OS crash, up to N commit groups may vanish from the binlog — replicas then diverge silently.",
                Some("Set sync_binlog = 1 unless you accept replica rebuilds after crashes.".into()),
                vec!["SET GLOBAL sync_binlog = 1;".into()],
                vec!["sync_binlog = 1".into()])),
            None => {}
        }
    }

    // 32. innodb_flush_log_at_trx_commit.
    match d.vu("innodb_flush_log_at_trx_commit") {
        Some(1) => out.push(f("res.flush_log", "resilience", Sev::Ok,
            "innodb_flush_log_at_trx_commit = 1 (ACID)", String::new(), None, vec![], vec![])),
        Some(n) => out.push(f("res.flush_log", "resilience", Sev::Advice,
            format!("innodb_flush_log_at_trx_commit = {}", n),
            "Faster commits, but up to ~1 s of committed transactions can be lost on OS crash.",
            Some("Keep 1 for financial/consistency-critical data; 2 is acceptable for reproducible/analytics workloads.".into()),
            vec!["SET GLOBAL innodb_flush_log_at_trx_commit = 1;".into()],
            vec!["innodb_flush_log_at_trx_commit = 1".into()])),
        None => {}
    }

    // 33. Binary logging itself.
    if !binlog_on {
        out.push(f("res.binlog_off", "resilience", Sev::Advice,
            "Binary logging is OFF",
            "No point-in-time recovery and no replication possible. A bad DROP at 15:00 means restoring last night's backup.",
            Some("Enable log_bin on anything you cannot afford to lose a day of.".into()),
            vec![],
            vec!["log_bin = mysql-bin\nbinlog_expire_logs_seconds = 604800".into()]));
    } else {
        // 34. Binlog retention.
        let expire_secs = d.vu("binlog_expire_logs_seconds")
            .or_else(|| d.vu("expire_logs_days").map(|days| days * 86400));
        match expire_secs {
            Some(0) => out.push(f("res.binlog_retention", "resilience", Sev::Warn,
                "Binlogs never expire",
                "binlog_expire_logs_seconds = 0 — the disk fills until the server dies.",
                Some("Set a retention window (7 days = 604800 s is a sane default).".into()),
                vec!["SET GLOBAL binlog_expire_logs_seconds = 604800;".into()],
                vec!["binlog_expire_logs_seconds = 604800".into()])),
            Some(s) if s > 30 * 86400 => out.push(f("res.binlog_retention", "resilience", Sev::Advice,
                format!("Binlog retention is {} days", s / 86400),
                "Long retention eats disk; most PITR windows need ≤ 7–14 days.",
                Some("Verify the retention matches your backup cadence.".into()),
                vec!["SET GLOBAL binlog_expire_logs_seconds = 1209600;".into()],
                vec!["binlog_expire_logs_seconds = 1209600".into()])),
            _ => {}
        }
    }

    // 35/36. Replica health.
    if !d.replicas.is_empty() {
        let mut all_ok = true;
        for ch in &d.replicas {
            let label = if ch.name.is_empty() { "default channel".to_string() } else { format!("channel '{}'", ch.name) };
            let io_ok = ch.io_running.eq_ignore_ascii_case("yes");
            let sql_ok = ch.sql_running.eq_ignore_ascii_case("yes");
            if !io_ok || !sql_ok {
                all_ok = false;
                out.push(f("res.replica_threads", "resilience", Sev::Critical,
                    format!("Replication is broken on {}", label),
                    format!("IO thread: {}, SQL thread: {}. The replica is drifting from the source.",
                        ch.io_running, ch.sql_running),
                    Some("SHOW REPLICA STATUS has Last_Errno/Last_Error — fix and START REPLICA.".into()),
                    vec![], vec![]));
            } else if let Some(lag) = ch.seconds_behind {
                if lag > 300 {
                    all_ok = false;
                    out.push(f("res.replica_lag", "resilience", Sev::Warn,
                        format!("Replica lag is {} s on {}", lag, label),
                        "Reads from this replica are stale; failover would lose recent writes.",
                        Some("Find the bottleneck: long transactions, single-threaded apply (raise replica_parallel_workers), or write bursts.".into()),
                        vec![], vec![]));
                } else if lag > 60 {
                    out.push(f("res.replica_lag", "resilience", Sev::Advice,
                        format!("Replica lag is {} s on {}", lag, label),
                        String::new(),
                        Some("Watch the trend — growing lag means apply capacity < write rate.".into()),
                        vec![], vec![]));
                }
            }
        }
        if all_ok {
            out.push(f("res.replica_threads", "resilience", Sev::Ok,
                format!("Replication threads running on {} channel(s)", d.replicas.len()),
                String::new(), None, vec![], vec![]));
        }
    }

    // 37. InnoDB forced recovery mode — someone is nursing corruption.
    match d.vu("innodb_force_recovery") {
        Some(n) if n > 0 => out.push(f("res.force_recovery", "resilience", Sev::Critical,
            format!("innodb_force_recovery = {} is ACTIVE", n),
            "The server runs in corruption-recovery mode. InnoDB is not fully functional; data may be silently unreadable.",
            Some("Dump everything NOW, rebuild the instance from the dump, then remove the setting.".into()),
            vec![],
            vec!["# remove after rebuild: innodb_force_recovery = 0".into()])),
        _ => {}
    }

    // 38. InnoDB auto-recovery of redo... covered by force_recovery; add crash-recovery signal:
    if let Some(recovered) = d.s("innodb_redo_log_recovery_in_progress") {
        if recovered > 0 {
            out.push(f("res.recovery_in_progress", "resilience", Sev::Warn,
                "InnoDB crash recovery in progress",
                "The server recently crashed and is replaying redo logs.",
                Some("Check the error log for the crash cause before trusting this instance.".into()),
                vec![], vec![]));
        }
    }
}

// ── Schema ───────────────────────────────────────────────────────────────────

fn schema_checks(d: &TunerData, out: &mut Vec<Finding>) {
    let Some(schema) = &d.schema else { return };
    if schema.total_tables == 0 { return }

    // 39. Non-InnoDB tables.
    if schema.non_innodb == 0 {
        out.push(f("schema.non_innodb", "schema", Sev::Ok,
            "All user tables are InnoDB", String::new(), None, vec![], vec![]));
    } else {
        let sev = if schema.non_innodb > 10 { Sev::Warn } else { Sev::Advice };
        out.push(f("schema.non_innodb", "schema", sev,
            format!("{} table(s) are not InnoDB", schema.non_innodb),
            format!("MyISAM/Aria/etc. lack transactions, crash recovery and row locking. Largest: {}.",
                schema.non_innodb_sample.join(", ")),
            Some("Convert to InnoDB: ALTER TABLE t ENGINE=InnoDB.".into()),
            schema.non_innodb_sample.iter().take(3)
                .map(|t| format!("ALTER TABLE {} ENGINE = InnoDB;", t.split(" (").next().unwrap_or(t)))
                .collect(),
            vec![]));
    }

    // 40. Tables without PRIMARY KEY.
    if schema.no_pk > 0 {
        let (sev, count_str) = if schema.no_pk > 10 {
            (Sev::Warn, format!("more than 10 (showing largest {})", schema.no_pk_sample.len()))
        } else {
            (Sev::Advice, format!("{}", schema.no_pk))
        };
        let gipk_hint = if d.at_least(8, 0, 30) && d.flavor != Flavor::Mariadb && d.von("sql_generate_invisible_primary_key") == Some(false) {
            " Consider sql_generate_invisible_primary_key=ON for new tables."
        } else { "" };
        out.push(f("schema.no_primary_key", "schema", sev,
            format!("{} table(s) have no PRIMARY KEY", count_str),
            format!("Row-based replication degrades to full scans on replicas and HA tools refuse these tables: {}.{}",
                schema.no_pk_sample.join(", "), gipk_hint),
            Some("Add a PRIMARY KEY (surrogate BIGINT AUTO_INCREMENT is fine).".into()),
            vec!["ALTER TABLE <db>.<table> ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;".into()],
            vec![]));
    }

    // 41. utf8mb3 — deprecated alias of the 3-byte UTF-8 subset.
    if schema.utf8mb3 > 0 {
        out.push(f("schema.utf8mb3", "schema", Sev::Advice,
            format!("{} table(s) still use utf8mb3", schema.utf8mb3),
            "utf8mb3 is deprecated, stores only 3-byte UTF-8 (no emoji, no CJK ext-B), and is scheduled for removal.",
            Some("Convert to utf8mb4: ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci.".into()),
            vec!["ALTER TABLE <db>.<table> CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;".into()],
            vec![]));
    }

    // 42. AUTO_INCREMENT exhaustion.
    if let Some(cols) = &d.auto_inc {
        for c in cols {
            if c.pct_used >= 90.0 {
                out.push(f("schema.auto_increment", "schema", Sev::Critical,
                    format!("{}.{} AUTO_INCREMENT is {:.1}% exhausted", c.table, c.column, c.pct_used),
                    format!("Column type {} is about to wrap — inserts will start failing hard.", c.col_type),
                    Some("Widen the column to BIGINT before it wraps.".into()),
                    vec![format!("ALTER TABLE {} MODIFY COLUMN {} BIGINT NOT NULL AUTO_INCREMENT;", c.table, c.column)],
                    vec![]));
            } else if c.pct_used >= 80.0 {
                out.push(f("schema.auto_increment", "schema", Sev::Warn,
                    format!("{}.{} AUTO_INCREMENT is {:.1}% used", c.table, c.column, c.pct_used),
                    format!("Column type {} will exhaust its range; plan the widening now.", c.col_type),
                    Some("Widen to BIGINT (or UNSIGNED of the current type to double the range).".into()),
                    vec![format!("ALTER TABLE {} MODIFY COLUMN {} BIGINT NOT NULL AUTO_INCREMENT;", c.table, c.column)],
                    vec![]));
            }
        }
    }

    // 42b. InnoDB table fragmentation: DATA_FREE relative to the table size,
    // per table and schema-wide. DATA_FREE is only per-table truthful for
    // file-per-table tablespaces; with innodb_file_per_table=OFF (or tables in
    // a general tablespace) it is the shared tablespace's free space repeated
    // on every table — the finding text says so instead of pretending precision.
    if let Some(frag) = &d.frag_tables {
        const WARN_MIN_FREE: u64 = 100 * MIB;
        const ADVICE_MIN_FREE: u64 = 10 * MIB;
        let scored: Vec<(&FragTable, f64)> = frag.iter()
            .map(|t| (t, pct(t.free_bytes, t.total_bytes)))
            .filter(|(t, p)| *p >= 10.0 && t.free_bytes >= ADVICE_MIN_FREE)
            .collect();
        let shared = d.von("innodb_file_per_table") == Some(false);
        let caveat = if shared {
            " innodb_file_per_table is OFF, so DATA_FREE is the SHARED system tablespace's free \
             space attributed to every table — treat these numbers as a system-tablespace signal, \
             not per-table, and rebuilding one file-per-table table will not reclaim it."
        } else {
            " If a table lives in a general tablespace, DATA_FREE reflects that whole tablespace \
             rather than the table alone."
        };
        let schema_ratio = pct(d.frag_total_free_bytes, d.frag_total_bytes);
        if !scored.is_empty() {
            let worst = scored.iter().any(|(_, p)| *p >= 20.0) ;
            let big = scored.iter().any(|(t, _)| t.free_bytes >= WARN_MIN_FREE);
            let sev = if worst && big { Sev::Warn } else { Sev::Advice };
            let mut detail = String::new();
            for (t, p) in scored.iter().take(5) {
                let _ = writeln!(detail, "  {} — {} reclaimable of {} ({:.0}%)",
                    t.table, fmt_bytes(t.free_bytes), fmt_bytes(t.total_bytes), p);
            }
            let _ = write!(detail, "Schema-wide: {} free of {} InnoDB data ({:.1}%).{}",
                fmt_bytes(d.frag_total_free_bytes), fmt_bytes(d.frag_total_bytes), schema_ratio, caveat);
            out.push(f("schema.table_fragmentation", "schema", sev,
                format!("{} InnoDB table(s) fragmented, {} reclaimable",
                    scored.len(), fmt_bytes(scored.iter().map(|(t, _)| t.free_bytes).sum::<u64>())),
                detail,
                Some("Rebuild the worst tables to return the space to the OS. On InnoDB \
                      OPTIMIZE TABLE maps to a table rebuild (ALGORITHM=INPLACE); it needs free \
                      disk ≈ the table's size, blocks writes briefly at the cutover, and applies \
                      serially on each replica.".into()),
                scored.iter().take(3).map(|(t, _)| format!(
                    "-- online rebuild: ALGORITHM=INPLACE, brief LOCK=NONE phases; needs ~{} free disk\n\
                     ALTER TABLE {} ENGINE=InnoDB;",
                    fmt_bytes(t.total_bytes), t.table)).collect(),
                vec![]));
        } else if schema_ratio >= 10.0 && d.frag_total_free_bytes >= ADVICE_MIN_FREE {
            out.push(f("schema.table_fragmentation", "schema", Sev::Advice,
                format!("InnoDB schema holds {} of free space", fmt_bytes(d.frag_total_free_bytes)),
                format!("{:.1}% of InnoDB data+index bytes are reclaimable ({} of {}), spread \
                         across many tables rather than concentrated in one.{}",
                        schema_ratio, fmt_bytes(d.frag_total_free_bytes), fmt_bytes(d.frag_total_bytes), caveat),
                Some("Rebuild tables during the next maintenance window, or accept the overhead — \
                      fragmentation under ~10% per table rarely pays for the rebuild.".into()),
                vec![], vec![]));
        }
    }

    // 42c. Unused secondary indexes: zero recorded reads since server start
    // (sys.schema_unused_indexes), but every INSERT/UPDATE/DELETE still
    // maintains them — pure write amplification and buffer-pool waste.
    match &d.unused_indexes {
        None => out.push(f("schema.unused_indexes", "schema", Sev::Info,
            "Unused-index check skipped",
            "sys.schema_unused_indexes is not available (the sys schema is missing or unreadable).",
            Some("Install the sys schema (default since 5.7) to enable this check.".into()),
            vec![], vec![])),
        Some(idx) if !idx.is_empty() => {
            let fresh = d.uptime_secs < 7 * 86400;
            let sev = if idx.iter().any(|i| i.table_bytes >= GIB) && !fresh { Sev::Warn } else { Sev::Advice };
            let mut detail = format!("{} secondary index(es) with zero reads since server start", idx.len());
            if fresh {
                let _ = write!(detail, " — uptime is only {} s, so this reflects a short window \
                                        and may catch indexes used by weekly/monthly jobs", d.uptime_secs);
            }
            detail.push_str(": ");
            let _ = write!(detail, "{}. Every write still maintains them: extra I/O, extra redo, \
                                    extra buffer-pool pressure on tables totalling {}.",
                idx.iter().take(5).map(|i| format!("{} ({})", i.index, i.table)).collect::<Vec<_>>().join(", "),
                fmt_bytes(idx.iter().map(|i| i.table_bytes).sum()));
            out.push(f("schema.unused_indexes", "schema", sev,
                format!("{} unused secondary index(es) feed write amplification", idx.len()),
                detail,
                Some("Confirm the counters cover a full business cycle (they reset on server \
                      restart), check no replica/reporting workload reads them, then drop. \
                      Dropping an index is an online operation (ALGORITHM=INPLACE, LOCK=NONE) — \
                      no table rebuild.".into()),
                idx.iter().take(3).map(|i| format!(
                    "-- online: ALGORITHM=INPLACE, LOCK=NONE\nALTER TABLE {} DROP INDEX {};", i.table, i.index)).collect(),
                vec![]));
        }
        Some(_) => {}
    }
}

// ── Config / upgrade advisories ──────────────────────────────────────────────

fn config_checks(d: &TunerData, out: &mut Vec<Finding>) {
    // 43. LTS migration advisor — the thing MySQLTuner never tells you.
    if d.flavor == Flavor::Mysql {
        if d.major == 8 && d.minor == 0 {
            out.push(f("config.lts_migration", "config", Sev::Advice,
                "8.0 is a dead end — plan the move to 8.4 / 9.7 LTS",
                "8.0 stopped getting new features in 2023 and reaches EOL 2026-04-30. Migration watch-list: \
                 mysql_native_password accounts (removed), query_cache_* / innodb_log_file_size settings (gone), \
                 and clients too old for caching_sha2_password.",
                Some("Fix the mysql_native_password accounts from the security section first, then rehearse an 8.4 upgrade on a replica.".into()),
                vec![], vec![]));
        } else if d.major >= 9 && !(d.minor == 7 || d.minor == 4) {
            // innovation train (9.0–9.6, and anything odd ahead): ~3-month support
            let known_lts = d.at_least(9, 7, 0);
            if !known_lts {
                out.push(f("config.lts_migration", "config", Sev::Advice,
                    format!("{}.{} is an innovation release", d.major, d.minor),
                    "Innovation releases get ~3 months of support — they are for trying new features, not for steady production.",
                    Some("Track the next release closely, or standardize on an LTS (8.4, 9.7).".into()),
                    vec![], vec![]));
            }
        }
    }

    // 44. Deprecated redo configuration (8.0.30+: capacity replaces file size).
    if d.flavor != Flavor::Mariadb && d.at_least(8, 0, 30) && d.v("innodb_log_file_size").is_some() && d.v("innodb_redo_log_capacity").is_some() {
        out.push(f("config.deprecated_redo_vars", "config", Sev::Info,
            "Redo log config uses deprecated variables",
            "innodb_log_file_size / innodb_log_files_in_group are deprecated since 8.0.30; innodb_redo_log_capacity is now authoritative.",
            Some("Drop the old settings from my.cnf to avoid confusing which one wins.".into()),
            vec![],
            vec![format!("innodb_redo_log_capacity = {}", cfg_size(d.vu("innodb_redo_log_capacity").unwrap_or(2 * GIB)))]));
    }

    // 45. innodb_dedicated_server auto-tuning (8.0+).
    if d.flavor != Flavor::Mariadb && d.at_least(8, 0, 0) && d.von("innodb_dedicated_server") == Some(false) {
        out.push(f("config.dedicated_server", "config", Sev::Advice,
            "innodb_dedicated_server is OFF",
            "On a dedicated DB host, enabling it lets InnoDB auto-size buffer pool, redo and flush behavior as RAM changes.",
            Some("Enable it if this host runs only MySQL; keep OFF on shared hosts (it would claim ~75% of RAM).".into()),
            vec![],
            vec!["innodb_dedicated_server = ON".into()]));
    }

    // 46. performance_schema off blinds most DBA tooling (including this app).
    if d.von("performance_schema") == Some(false) {
        out.push(f("config.performance_schema_off", "config", Sev::Advice,
            "performance_schema is OFF",
            "Statement digests, memory instrumentation and lock introspection are all unavailable.",
            Some("Enable it (default since 5.7) — overhead is a few percent at most.".into()),
            vec![],
            vec!["performance_schema = ON".into()]));
    }
}

// ── Scoring + ordering ───────────────────────────────────────────────────────

/// Deterministic score: bucket max minus Σ points_lost of that bucket's
/// findings, floored at 0. Mapping documented at the top of this file.
pub fn compute_score(findings: &[Finding]) -> Score {
    let mut perf: i32 = 40;
    let mut sec: i32 = 30;
    let mut res: i32 = 30;
    for f in findings {
        let lost = f.points_lost as i32;
        match f.category.as_str() {
            "security" => sec -= lost,
            "resilience" | "schema" => res -= lost,
            _ => perf -= lost, // "performance" | "config"
        }
    }
    let performance = perf.clamp(0, 40) as u8;
    let security = sec.clamp(0, 30) as u8;
    let resilience = res.clamp(0, 30) as u8;
    Score { total: performance + security + resilience, performance, security, resilience }
}

/// Worst-first ordering for the panel: critical → warn → advice → info → ok.
pub fn sort_findings(findings: &mut [Finding]) {
    fn rank(sev: &str) -> u8 {
        match sev {
            "critical" => 0,
            "warn" => 1,
            "advice" => 2,
            "info" => 3,
            _ => 4,
        }
    }
    findings.sort_by(|a, b| rank(&a.severity).cmp(&rank(&b.severity)).then_with(|| a.id.cmp(&b.id)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::collectors::*;

    fn base() -> TunerData {
        let mut d = TunerData {
            major: 8, minor: 0, patch: 46,
            version: "8.0.46".into(),
            version_comment: "Homebrew".into(),
            flavor: Flavor::Mysql,
            uptime_secs: 86400,
            users: Some(vec![]),
            ..Default::default()
        };
        for (k, v) in [
            ("innodb_buffer_pool_size", "134217728"),
            ("max_connections", "151"),
            ("thread_cache_size", "9"),
            ("tmp_table_size", "16777216"),
            ("max_heap_table_size", "16777216"),
            ("long_query_time", "10.000000"),
            ("slow_query_log", "OFF"),
            ("sort_buffer_size", "262144"),
            ("join_buffer_size", "262144"),
            ("read_buffer_size", "131072"),
            ("read_rnd_buffer_size", "262144"),
            ("thread_stack", "286720"),
            ("innodb_log_buffer_size", "16777216"),
            ("key_buffer_size", "8388608"),
            ("innodb_flush_log_at_trx_commit", "1"),
            ("sync_binlog", "1"),
            ("log_bin", "OFF"),
            ("local_infile", "ON"),
            ("skip_name_resolve", "OFF"),
            ("require_secure_transport", "OFF"),
            ("have_ssl", "YES"),
            ("tls_version", "TLSv1.2,TLSv1.3"),
            ("performance_schema", "ON"),
            ("innodb_dedicated_server", "OFF"),
        ] {
            d.vars.insert(k.into(), v.into());
        }
        d
    }

    fn set_status(d: &mut TunerData, pairs: &[(&str, &str)]) {
        for (k, v) in pairs { d.status.insert((*k).into(), (*v).into()); }
    }

    fn by_id<'a>(out: &'a [Finding], id: &str) -> Option<&'a Finding> {
        out.iter().find(|f| f.id == id)
    }

    mod session_time_zone {
        use super::*;

        fn with_tz(session: &str, global: &str) -> Vec<Finding> {
            let mut d = base();
            d.session_time_zone = Some((session.into(), global.into()));
            run_checks(&d, None)
        }
        const ID: &str = "tz.session_differs_from_server";

        /// The case that costs someone an hour: server on UTC+2, TxUI reading
        /// it in UTC, no indication anywhere that the two clocks disagree.
        #[test]
        fn a_server_in_another_zone_is_reported() {
            let out = with_tz("+00:00", "+02:00");
            let f = by_id(&out, ID).expect("no finding for a UTC/UTC+2 mismatch");
            assert_eq!(f.severity, "info", "this is information, not a server fault");
            assert!(f.detail.contains("+02:00"), "the server zone must appear: {}", f.detail);
            assert!(f.recommendation.as_deref().unwrap_or("").contains("CONVERT_TZ"),
                    "offer the way to reconcile the two");
        }

        /// SYSTEM is the default and means "whatever the host is set to",
        /// which is exactly the ambiguous case worth flagging.
        #[test]
        fn a_server_on_system_is_reported() {
            assert!(by_id(&with_tz("+00:00", "SYSTEM"), ID).is_some());
        }

        /// A server already on UTC agrees with us, so there is nothing to say.
        /// Firing here would put a permanent notice on every UTC server.
        #[test]
        fn a_server_already_on_utc_is_silent() {
            assert!(by_id(&with_tz("+00:00", "+00:00"), ID).is_none());
            assert!(by_id(&with_tz("+00:00", "UTC"), ID).is_none());
        }

        /// If the session is not the pinned UTC one, this check is not about
        /// the situation it was written for and must stay quiet.
        #[test]
        fn a_session_that_is_not_utc_is_not_this_checks_business() {
            assert!(by_id(&with_tz("+02:00", "+02:00"), ID).is_none());
        }

        /// Servers that did not answer the query must not produce a finding
        /// built out of nothing.
        #[test]
        fn no_data_means_no_finding() {
            let out = run_checks(&base(), None);
            assert!(by_id(&out, ID).is_none());
        }
    }

    #[test]
    fn buffer_pool_hit_rate_thresholds() {
        let mut d = base();
        set_status(&mut d, &[("innodb_buffer_pool_reads", "5000"), ("innodb_buffer_pool_read_requests", "100000")]);
        let out = run_checks(&d, None);
        assert_eq!(by_id(&out, "perf.buffer_pool_hit_rate").unwrap().severity, "warn"); // 95%

        let mut d = base();
        set_status(&mut d, &[("innodb_buffer_pool_reads", "5"), ("innodb_buffer_pool_read_requests", "100000")]);
        let out = run_checks(&d, None);
        assert_eq!(by_id(&out, "perf.buffer_pool_hit_rate").unwrap().severity, "ok"); // 99.995%
    }

    #[test]
    fn connection_usage_warns_near_limit() {
        let mut d = base();
        set_status(&mut d, &[("max_used_connections", "150")]);
        let out = run_checks(&d, None);
        let f = by_id(&out, "perf.connection_usage").unwrap();
        assert_eq!(f.severity, "warn"); // 150/151 = 99%
        assert!(f.fix_sql[0].contains("SET GLOBAL max_connections"));
    }

    #[test]
    fn tmp_table_ratio_and_fix() {
        let mut d = base();
        set_status(&mut d, &[("created_tmp_disk_tables", "600"), ("created_tmp_tables", "1000")]);
        let out = run_checks(&d, None);
        let f = by_id(&out, "perf.tmp_disk_tables").unwrap();
        assert_eq!(f.severity, "warn"); // 60%
        assert!(f.fix_config[0].contains("tmp_table_size"));
        assert!(f.fix_sql[0].contains("max_heap_table_size"));
    }

    #[test]
    fn anonymous_and_remote_root_are_critical() {
        let mut d = base();
        d.users = Some(vec![
            UserAcct { user: "".into(), host: "localhost".into(), ..Default::default() },
            UserAcct { user: "root".into(), host: "%".into(), plugin: "caching_sha2_password".into(), no_password: Some(false), ..Default::default() },
        ]);
        let out = run_checks(&d, None);
        assert_eq!(by_id(&out, "sec.anonymous_users").unwrap().severity, "critical");
        assert_eq!(by_id(&out, "sec.root_remote").unwrap().severity, "critical");
        assert!(by_id(&out, "sec.anonymous_users").unwrap().fix_sql[0].starts_with("DROP USER"));
    }

    #[test]
    fn native_password_severity_depends_on_version() {
        let mk = |maj, min| {
            let mut d = base();
            d.major = maj; d.minor = min;
            d.users = Some(vec![UserAcct {
                user: "app".into(), host: "%".into(), plugin: "mysql_native_password".into(),
                no_password: Some(false), ..Default::default()
            }]);
            run_checks(&d, None)
        };
        assert_eq!(by_id(&mk(8, 0), "sec.mysql_native_password").unwrap().severity, "advice");
        assert_eq!(by_id(&mk(8, 4), "sec.mysql_native_password").unwrap().severity, "warn");
        assert_eq!(by_id(&mk(9, 7), "sec.mysql_native_password").unwrap().severity, "warn");
    }

    #[test]
    fn eol_maps_to_severity() {
        let e = |status: &str| EolInfo {
            product: "mysql".into(), cycle: "8.0".into(),
            eol_date: Some("2026-04-30".into()), status: status.into(),
            latest: None, source: "test".into(),
        };
        let d = base();
        assert_eq!(by_id(&run_checks(&d, Some(&e("eol"))), "res.eol").unwrap().severity, "critical");
        assert_eq!(by_id(&run_checks(&d, Some(&e("eol-soon"))), "res.eol").unwrap().severity, "warn");
        assert_eq!(by_id(&run_checks(&d, Some(&e("supported"))), "res.eol").unwrap().severity, "ok");
    }

    #[test]
    fn replica_broken_is_critical() {
        let mut d = base();
        d.replicas = vec![ReplicaChannel {
            name: "".into(), io_running: "Yes".into(), sql_running: "No".into(), seconds_behind: None,
        }];
        let out = run_checks(&d, None);
        assert_eq!(by_id(&out, "res.replica_threads").unwrap().severity, "critical");
    }

    #[test]
    fn auto_inc_critical_over_90() {
        let mut d = base();
        d.schema = Some(SchemaStats { total_tables: 10, ..Default::default() });
        d.auto_inc = Some(vec![AutoIncCol {
            table: "shop.orders".into(), column: "id".into(), col_type: "int".into(), pct_used: 93.5,
        }]);
        let out = run_checks(&d, None);
        let f = by_id(&out, "schema.auto_increment").unwrap();
        assert_eq!(f.severity, "critical");
        assert!(f.fix_sql[0].contains("BIGINT"));
    }

    #[test]
    fn score_math_is_deterministic() {
        // critical(-10) security + warn(-5) resilience + advice(-2) perf
        let findings = vec![
            f("a", "security", Sev::Critical, "", "", None, vec![], vec![]),
            f("b", "resilience", Sev::Warn, "", "", None, vec![], vec![]),
            f("c", "schema", Sev::Warn, "", "", None, vec![], vec![]),
            f("d", "performance", Sev::Advice, "", "", None, vec![], vec![]),
            f("e", "config", Sev::Advice, "", "", None, vec![], vec![]),
            f("g", "security", Sev::Ok, "", "", None, vec![], vec![]),
        ];
        let s = compute_score(&findings);
        assert_eq!(s.security, 20);      // 30 - 10
        assert_eq!(s.resilience, 20);    // 30 - 5 - 5 (schema counts here)
        assert_eq!(s.performance, 36);   // 40 - 2 - 2 (config counts here)
        assert_eq!(s.total, 76);
    }

    #[test]
    fn score_floors_at_zero() {
        let findings: Vec<Finding> = (0..10)
            .map(|i| f(&format!("x{}", i), "security", Sev::Critical, "", "", None, vec![], vec![]))
            .collect();
        let s = compute_score(&findings);
        assert_eq!(s.security, 0);
        assert_eq!(s.total, 70);
    }

    #[test]
    fn max_memory_estimate_formula() {
        let d = base();
        let (global, per_thread, max_mem) = max_memory_estimate(&d).unwrap();
        assert_eq!(global, 134217728 + 16777216 + 8388608);
        let expected_pt = 262144 + 262144 + 131072 + 262144 + 286720 + 16777216; // tmp=min(tmp,heap); no binlog
        assert_eq!(per_thread, expected_pt);
        assert_eq!(max_mem, global + expected_pt * 151);
    }

    #[test]
    fn sync_binlog_and_durability() {
        let mut d = base();
        d.vars.insert("log_bin".into(), "ON".into());
        d.vars.insert("sync_binlog".into(), "100".into());
        d.vars.insert("innodb_flush_log_at_trx_commit".into(), "2".into());
        d.vars.insert("binlog_expire_logs_seconds".into(), "0".into());
        let out = run_checks(&d, None);
        assert_eq!(by_id(&out, "res.sync_binlog").unwrap().severity, "warn");
        assert_eq!(by_id(&out, "res.flush_log").unwrap().severity, "advice");
        assert_eq!(by_id(&out, "res.binlog_retention").unwrap().severity, "warn");
    }

    #[test]
    fn binlog_off_is_advice() {
        let out = run_checks(&base(), None);
        assert_eq!(by_id(&out, "res.binlog_off").unwrap().severity, "advice");
    }

    #[test]
    fn weak_tls_flagged() {
        let mut d = base();
        d.vars.insert("tls_version".into(), "TLSv1,TLSv1.1,TLSv1.2,TLSv1.3".into());
        let out = run_checks(&d, None);
        let f = by_id(&out, "sec.tls_old").unwrap();
        assert_eq!(f.severity, "warn");
        assert!(f.fix_sql[0].contains("TLSv1.2,TLSv1.3"));
    }

    #[test]
    fn fragmentation_warns_and_offers_online_rebuild() {
        let mut d = base();
        d.schema = Some(SchemaStats { total_tables: 10, ..Default::default() });
        d.frag_tables = Some(vec![FragTable {
            table: "shop.orders".into(), total_bytes: 2 * GIB, free_bytes: 800 * MIB,
        }]);
        d.frag_total_free_bytes = 800 * MIB;
        d.frag_total_bytes = 4 * GIB;
        let out = run_checks(&d, None);
        let fr = by_id(&out, "schema.table_fragmentation").unwrap();
        assert_eq!(fr.severity, "warn");
        assert!(fr.detail.contains("shop.orders"));
        assert!(fr.fix_sql.iter().any(|s| s.contains("ALTER TABLE shop.orders ENGINE=InnoDB;")
            && s.contains("ALGORITHM=INPLACE")), "fix must name the online-DDL shape");
    }

    #[test]
    fn fragmentation_advice_at_lower_ratio_and_shared_tablespace_caveat() {
        let mut d = base();
        d.schema = Some(SchemaStats { total_tables: 10, ..Default::default() });
        d.vars.insert("innodb_file_per_table".into(), "OFF".into());
        d.frag_tables = Some(vec![FragTable {
            table: "app.logs".into(), total_bytes: 120 * MIB, free_bytes: 15 * MIB,
        }]);
        d.frag_total_free_bytes = 15 * MIB;
        d.frag_total_bytes = 120 * MIB;
        let out = run_checks(&d, None);
        let fr = by_id(&out, "schema.table_fragmentation").unwrap();
        assert_eq!(fr.severity, "advice");
        assert!(fr.detail.contains("SHARED"), "shared-tablespace caveat must be stated");
    }

    #[test]
    fn fragmentation_schema_wide_only() {
        let mut d = base();
        d.schema = Some(SchemaStats { total_tables: 10, ..Default::default() });
        d.frag_tables = Some(vec![]); // no single table crosses the per-table bar
        d.frag_total_free_bytes = 600 * MIB;
        d.frag_total_bytes = 4 * GIB;
        let out = run_checks(&d, None);
        let fr = by_id(&out, "schema.table_fragmentation").unwrap();
        assert_eq!(fr.severity, "advice");
        assert!(fr.fix_sql.is_empty(), "no specific table to rebuild");
    }

    #[test]
    fn no_fragmentation_data_means_no_finding() {
        let mut d = base();
        d.schema = Some(SchemaStats { total_tables: 10, ..Default::default() });
        let out = run_checks(&d, None);
        assert!(by_id(&out, "schema.table_fragmentation").is_none());
    }

    #[test]
    fn unused_indexes_flagged_with_online_drop_sql() {
        let mut d = base();
        d.uptime_secs = 30 * 86400; // counters must cover a business cycle to escalate
        d.schema = Some(SchemaStats { total_tables: 10, ..Default::default() });
        d.unused_indexes = Some(vec![
            UnusedIndex { table: "shop.orders".into(), index: "idx_old".into(), table_bytes: 3 * GIB },
            UnusedIndex { table: "shop.users".into(), index: "idx_legacy".into(), table_bytes: 10 * MIB },
        ]);
        let out = run_checks(&d, None);
        let ui = by_id(&out, "schema.unused_indexes").unwrap();
        assert_eq!(ui.severity, "warn"); // an unused index on a GiB-scale table, long uptime
        assert!(ui.fix_sql.iter().any(|s| s.contains("ALTER TABLE shop.orders DROP INDEX idx_old;")
            && s.contains("LOCK=NONE")));
    }

    #[test]
    fn unused_indexes_short_uptime_stays_advice() {
        let mut d = base();
        d.uptime_secs = 3600;
        d.schema = Some(SchemaStats { total_tables: 10, ..Default::default() });
        d.unused_indexes = Some(vec![
            UnusedIndex { table: "shop.orders".into(), index: "idx_old".into(), table_bytes: 3 * GIB },
        ]);
        let out = run_checks(&d, None);
        let ui = by_id(&out, "schema.unused_indexes").unwrap();
        assert_eq!(ui.severity, "advice", "counters covering one hour must not escalate to warn");
        assert!(ui.detail.contains("short window"));
    }

    #[test]
    fn missing_sys_schema_degrades_unused_index_check_to_info() {
        let mut d = base();
        d.schema = Some(SchemaStats { total_tables: 10, ..Default::default() });
        d.unused_indexes = None; // probe failed
        let out = run_checks(&d, None);
        let ui = by_id(&out, "schema.unused_indexes").unwrap();
        assert_eq!(ui.severity, "info");
        assert_eq!(ui.points_lost, 0);
    }

    #[test]
    fn healthy_server_scores_high() {        let mut d = base();
        d.vars.insert("log_bin".into(), "ON".into());
        d.vars.insert("require_secure_transport".into(), "ON".into());
        d.vars.insert("local_infile".into(), "OFF".into());
        d.vars.insert("skip_name_resolve".into(), "ON".into());
        d.vars.insert("slow_query_log".into(), "ON".into());
        d.vars.insert("long_query_time".into(), "1.000000".into());
        d.vars.insert("binlog_expire_logs_seconds".into(), "604800".into());
        set_status(&mut d, &[
            ("innodb_buffer_pool_reads", "10"), ("innodb_buffer_pool_read_requests", "10000000"),
            ("threads_created", "5"), ("connections", "10000"),
            ("max_used_connections", "40"),
            ("created_tmp_disk_tables", "100"), ("created_tmp_tables", "10000"),
        ]);
        d.schema = Some(SchemaStats {
            total_tables: 50, innodb_bytes: 64 * MIB, total_bytes: 64 * MIB, ..Default::default()
        });
        let eol = EolInfo {
            product: "mysql".into(), cycle: "8.0".into(), eol_date: Some("2030-01-01".into()),
            status: "supported".into(), latest: None, source: "test".into(),
        };
        let out = run_checks(&d, Some(&eol));
        let s = compute_score(&out);
        assert!(s.total >= 85, "healthy server should score high, got {} ({:?})",
            s.total, out.iter().filter(|f| f.points_lost > 0).map(|f| f.id.clone()).collect::<Vec<_>>());
        assert!(out.iter().any(|f| f.severity == "ok"), "panel needs passing checks too");
    }
}
