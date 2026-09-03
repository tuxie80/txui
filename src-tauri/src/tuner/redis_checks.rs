//! Redis rule set: pure functions over collected [`RedisTunerData`] (+ EOL
//! info), unit-testable with synthetic INFO/CONFIG maps.
//!
//! Uses the SAME scoring model and category buckets as the MySQL and
//! PostgreSQL rules, so one panel renders all three engines:
//!   severity → points_lost: critical 10, warn 5, advice 2, info/ok 0.
//!   category → bucket: performance|config → Performance /40,
//!                      security          → Security /30,
//!                      resilience|schema → Resilience /30.
//!
//! Fix statements are GENERATED ONLY — the tuner never executes them. Where a
//! `CONFIG SET` would not survive a restart the fix also names the
//! redis.conf line, because `CONFIG SET` alone is lost on the next restart
//! unless `CONFIG REWRITE` follows.

use std::fmt::Write as _;

use super::redis_collectors::RedisTunerData;
use super::{EolInfo, Finding};

use super::MIB;

use super::{f, Sev};

use super::fmt_bytes;

fn fmt_uptime(secs: u64) -> String {
    let d = secs / 86400;
    let h = (secs % 86400) / 3600;
    let m = (secs % 3600) / 60;
    if d > 0 { format!("{d}d {h}h") } else if h > 0 { format!("{h}h {m}m") } else { format!("{m}m") }
}

/// `CONFIG SET` applies immediately but is lost on restart unless rewritten.
fn cfg_set(param: &str, value: &str) -> String {
    format!("CONFIG SET {param} {value}\n-- then persist it:\nCONFIG REWRITE")
}

pub fn run_checks(d: &RedisTunerData, eol: Option<&EolInfo>) -> Vec<Finding> {
    let mut out = Vec::new();
    check_version(d, eol, &mut out);
    check_memory(d, &mut out);
    check_eviction(d, &mut out);
    check_persistence(d, &mut out);
    check_performance(d, &mut out);
    check_slowlog(d, &mut out);
    check_clients(d, &mut out);
    check_replication(d, &mut out);
    check_security(d, &mut out);
    out
}

// ── Version / lifecycle ──────────────────────────────────────────────────────

fn check_version(d: &RedisTunerData, eol: Option<&EolInfo>, out: &mut Vec<Finding>) {
    out.push(f("r-version", "config", Sev::Info,
        format!("Redis {} ({})", d.version, d.mode),
        format!("{}\nUptime {}.", d.os, fmt_uptime(d.uptime_secs)),
        None, vec![], vec![]));

    if d.uptime_secs < 3600 {
        out.push(f("r-uptime-short", "config", Sev::Info,
            "Server restarted recently",
            format!("Uptime is {} — the cumulative counters (hit rate, evictions, \
                     command stats) have barely accumulated, so ratio-based findings below \
                     are provisional.", fmt_uptime(d.uptime_secs)),
            Some("Re-run after a representative workload period.".into()), vec![], vec![]));
    }

    if let Some(e) = eol {
        match e.status.as_str() {
            "eol" => out.push(f("r-eol", "resilience", Sev::Critical,
                format!("Redis {} is end-of-life", e.cycle),
                format!("Support ended {}. No further fixes are published, including security \
                         fixes.", e.eol_date.clone().unwrap_or_else(|| "(date unknown)".into())),
                Some("Upgrade to a supported release.".into()), vec![], vec![])),
            "eol-soon" => out.push(f("r-eol-soon", "resilience", Sev::Warn,
                format!("Redis {} reaches end-of-life soon", e.cycle),
                format!("Support ends {}.", e.eol_date.clone().unwrap_or_default()),
                Some("Plan the upgrade.".into()), vec![], vec![])),
            _ => {}
        }
    }
}

// ── Memory ───────────────────────────────────────────────────────────────────

fn check_memory(d: &RedisTunerData, out: &mut Vec<Finding>) {
    let used = d.iu("used_memory").unwrap_or(0);
    let rss  = d.iu("used_memory_rss").unwrap_or(0);
    let peak = d.iu("used_memory_peak").unwrap_or(0);
    let maxmem = d.cu("maxmemory").or_else(|| d.iu("maxmemory")).unwrap_or(0);

    // The single most common Redis outage: no ceiling at all. The dataset grows
    // until the OS OOM-killer takes the process, losing everything not persisted.
    if maxmem == 0 {
        out.push(f("r-maxmemory-unset", "resilience", Sev::Critical,
            "maxmemory is not set — no memory ceiling",
            format!("Redis will keep allocating until the machine runs out and the OS kills \
                     the process. Currently using {}, peak {}. There is no graceful \
                     degradation path: eviction only happens when a ceiling exists.",
                    fmt_bytes(used), fmt_bytes(peak)),
            Some("Set maxmemory to roughly 60–75% of the machine's RAM (leave room for \
                  replication buffers, COW during a fork, and the OS), and pick an eviction \
                  policy to match the workload.".into()),
            vec![cfg_set("maxmemory", "4gb")],
            vec!["# redis.conf\nmaxmemory 4gb".into()]));
    } else {
        let pct = used as f64 * 100.0 / maxmem as f64;
        let sev = if pct >= 95.0 { Sev::Critical } else if pct >= 80.0 { Sev::Warn } else { Sev::Ok };
        out.push(f("r-memory-usage", "performance", sev,
            format!("Memory at {pct:.0}% of maxmemory"),
            format!("{} used of {} ceiling (peak {}).{}",
                    fmt_bytes(used), fmt_bytes(maxmem), fmt_bytes(peak),
                    if pct >= 80.0 { " At the ceiling behaviour depends entirely on the \
                                      eviction policy — with noeviction, writes start failing." }
                    else { "" }),
            if pct >= 80.0 { Some("Raise maxmemory, shed data, or confirm the eviction policy \
                                   does what you expect.".into()) } else { None },
            vec![], vec![]));
    }

    // Fragmentation cuts both ways and the LOW side is the dangerous one:
    // below 1.0 means part of the dataset has been swapped to disk, which
    // turns every access into a page fault.
    if let Some(frag) = d.if_("mem_fragmentation_ratio") {
        if frag < 1.0 && used > 64 * MIB {
            out.push(f("r-swapping", "performance", Sev::Critical,
                format!("Fragmentation ratio {frag:.2} — Redis is swapping"),
                "A ratio below 1.0 means the RSS is smaller than the allocated dataset: part of \
                 it lives in swap. Redis is single-threaded, so a page fault stalls every \
                 client, and latency becomes unpredictable.",
                Some("Reduce memory use or add RAM; disable swap for this process. This is a \
                      machine-level problem, not a Redis setting.".into()),
                vec![], vec![]));
        } else if frag > 1.5 && rss > 256 * MIB {
            out.push(f("r-fragmentation", "performance", Sev::Warn,
                format!("Fragmentation ratio {frag:.2}"),
                format!("RSS is {} while the dataset is {} — the allocator is holding memory it \
                         is not using. Common after a large deletion or eviction burst.",
                        fmt_bytes(rss), fmt_bytes(used)),
                Some("Enable activedefrag, or restart during a maintenance window. \
                      Check the allocator is jemalloc — defrag needs it.".into()),
                vec![cfg_set("activedefrag", "yes")], vec![]));
        }
    }

    if let Some(alloc) = d.i("mem_allocator") {
        if !alloc.contains("jemalloc") {
            out.push(f("r-allocator", "performance", Sev::Advice,
                format!("Memory allocator is {alloc}"),
                "Redis is tuned for jemalloc; other allocators typically fragment more and \
                 cannot use active defragmentation.",
                Some("Prefer a jemalloc build for production.".into()), vec![], vec![]));
        }
    }
}

// ── Eviction policy ──────────────────────────────────────────────────────────

fn check_eviction(d: &RedisTunerData, out: &mut Vec<Finding>) {
    let Some(policy) = d.c("maxmemory-policy") else { return };
    let maxmem = d.cu("maxmemory").unwrap_or(0);

    if maxmem > 0 && policy == "noeviction" {
        out.push(f("r-noeviction", "resilience", Sev::Critical,
            "maxmemory reached will make WRITES FAIL (policy noeviction)",
            "With a ceiling set and `noeviction`, Redis returns OOM errors for every write once \
             the limit is hit — reads keep working, so the failure looks like a partial outage \
             and is easy to misdiagnose. That is the correct policy for a datastore, and the \
             wrong one for a cache.",
            Some("If this instance is a cache, use allkeys-lru (or allkeys-lfu). If it is a \
                  datastore, keep noeviction — but then maxmemory must be monitored, because \
                  hitting it is an outage.".into()),
            vec![cfg_set("maxmemory-policy", "allkeys-lru")], vec![]));
    }

    // A volatile-* policy can only evict keys that carry a TTL. With few or no
    // volatile keys there is nothing to evict, so the instance behaves exactly
    // like noeviction — but silently, because the policy looks correct.
    if policy.starts_with("volatile-") && d.total_keys > 0 {
        let pct = d.volatile_keys as f64 * 100.0 / d.total_keys as f64;
        if pct < 10.0 {
            out.push(f("r-volatile-policy-no-ttls", "resilience", Sev::Critical,
                format!("Policy is {policy} but only {pct:.0}% of keys have a TTL"),
                format!("{} of {} keys carry an expiry. A volatile-* policy evicts ONLY keys \
                         with a TTL, so at the memory ceiling there is almost nothing eligible \
                         — the instance will start returning OOM errors on writes exactly like \
                         noeviction, while the configuration looks correct.",
                        d.volatile_keys, d.total_keys),
                Some("Either set TTLs on the cacheable keys, or switch to an allkeys-* policy."
                     .into()),
                vec![cfg_set("maxmemory-policy", "allkeys-lru")], vec![]));
        }
    }

    if let Some(evicted) = d.iu("evicted_keys") {
        if evicted > 0 {
            out.push(f("r-evictions", "performance", Sev::Warn,
                format!("{evicted} key(s) evicted"),
                format!("Redis has hit the memory ceiling and discarded data under the \
                         {policy} policy. For a cache that is normal; for a datastore it is \
                         silent data loss.", ),
                Some("Confirm this instance is a cache. If it is, watch the eviction rate as a \
                      capacity signal; if it is not, raise maxmemory now.".into()),
                vec![], vec![]));
        }
    }
}

// ── Persistence ──────────────────────────────────────────────────────────────

fn check_persistence(d: &RedisTunerData, out: &mut Vec<Finding>) {
    let aof = d.cb("appendonly").unwrap_or(false);
    let save = d.c("save").unwrap_or("").trim().to_string();
    let rdb_enabled = !save.is_empty();

    if !aof && !rdb_enabled {
        out.push(f("r-no-persistence", "resilience", Sev::Critical,
            "No persistence — a restart loses everything",
            "Both RDB snapshots (`save`) and the AOF are disabled, so the dataset exists only in \
             RAM. A restart, a crash, or an OOM kill discards all of it.",
            Some("Deliberate for a pure cache. For anything else enable AOF \
                  (appendonly yes) — it loses at most one second of writes with the default \
                  appendfsync everysec.".into()),
            vec![cfg_set("appendonly", "yes")],
            vec!["# redis.conf\nappendonly yes\nappendfsync everysec".into()]));
    } else if !aof && rdb_enabled {
        out.push(f("r-rdb-only", "resilience", Sev::Advice,
            "RDB snapshots only, no AOF",
            format!("Persistence relies on periodic snapshots (save {save}). Everything written \
                     since the last snapshot is lost on a crash — that window can be minutes."),
            Some("Enable AOF alongside RDB for a bounded loss window.".into()),
            vec![cfg_set("appendonly", "yes")], vec![]));
    }

    match d.c("appendfsync") {
        Some("no") if aof => out.push(f("r-appendfsync-no", "resilience", Sev::Warn,
            "appendfsync no — the OS decides when to flush",
            "The AOF is written but never explicitly flushed, so up to 30 seconds of writes can \
             be lost on a crash. This is barely better than no AOF.",
            Some("Use everysec: a one-second worst case, at negligible cost.".into()),
            vec![cfg_set("appendfsync", "everysec")], vec![])),
        Some("always") if aof => out.push(f("r-appendfsync-always", "performance", Sev::Advice,
            "appendfsync always — an fsync on every write",
            "The strongest durability Redis offers, and the slowest: every write waits for the \
             disk. Throughput can drop by an order of magnitude.",
            Some("Unless the workload genuinely cannot lose one second, everysec is the usual \
                  trade.".into()),
            vec![cfg_set("appendfsync", "everysec")], vec![])),
        _ => {}
    }

    // A failing background save is easy to miss — Redis keeps serving.
    if d.i("rdb_last_bgsave_status").is_some_and(|s| s != "ok") {
        out.push(f("r-bgsave-failing", "resilience", Sev::Critical,
            "The last RDB background save FAILED",
            "Snapshots are not being written. The usual cause is the fork failing for want of \
             memory, or the disk being full or read-only. Redis keeps serving reads and writes \
             meanwhile, so nothing looks wrong until a restart.",
            Some("Check the Redis log, free disk space, and vm.overcommit_memory=1 — a fork \
                  needs to be able to reserve as much again as the dataset.".into()),
            vec![], vec![]));
    }
    if d.i("aof_last_write_status").is_some_and(|s| s != "ok") {
        out.push(f("r-aof-failing", "resilience", Sev::Critical,
            "The last AOF write FAILED",
            "The append-only file is not being written; the durability guarantee is gone.",
            Some("Check disk space and permissions on the AOF directory.".into()), vec![], vec![]));
    }

    if let Some(pending) = d.iu("rdb_changes_since_last_save") {
        if pending > 100_000 && rdb_enabled {
            out.push(f("r-unsaved-changes", "resilience", Sev::Warn,
                format!("{pending} writes since the last snapshot"),
                "All of these are lost if the process dies before the next save.",
                Some("Tighten the `save` thresholds, or enable AOF.".into()), vec![], vec![]));
        }
    }
}

// ── Performance ──────────────────────────────────────────────────────────────

fn check_performance(d: &RedisTunerData, out: &mut Vec<Finding>) {
    if let Some(hit) = d.hit_rate() {
        let (sev, note) = if hit < 80.0 {
            (Sev::Warn, "Most lookups miss, so the cache is doing little work for its memory.")
        } else if hit < 95.0 {
            (Sev::Advice, "Healthy caches usually sit above 95%.")
        } else {
            (Sev::Ok, "Lookups are being served from cache.")
        };
        out.push(f("r-hit-rate", "performance", sev,
            format!("Keyspace hit rate {hit:.1}%"),
            format!("{note} {} hits / {} misses since start.",
                    d.iu("keyspace_hits").unwrap_or(0), d.iu("keyspace_misses").unwrap_or(0)),
            if hit < 95.0 { Some("Check TTLs are not too short and that the miss path is not \
                                  caching negatives.".into()) } else { None },
            vec![], vec![]));
    }

    // A fork is used for every RDB save and AOF rewrite. On a large dataset a
    // slow fork stalls the whole server, because Redis is single-threaded.
    if let Some(fork_us) = d.iu("latest_fork_usec") {
        if fork_us > 500_000 {
            out.push(f("r-slow-fork", "performance", Sev::Warn,
                format!("Last fork took {:.0} ms", fork_us as f64 / 1000.0),
                "Redis forks for RDB saves and AOF rewrites, and the fork blocks every client \
                 for its duration. Above a few hundred milliseconds this shows up directly as a \
                 latency spike.",
                Some("Usually a symptom of a large dataset on a host without huge-page-aware \
                      copy-on-write. Confirm Transparent Huge Pages are DISABLED — THP makes \
                      fork latency dramatically worse.".into()),
                vec![], vec![]));
        }
    }

    if d.at_least(6, 0) {
        if let Some(io) = d.cu("io-threads") {
            if io == 1 {
                out.push(f("r-io-threads", "performance", Sev::Advice,
                    "io-threads is 1 (single-threaded I/O)",
                    "Command execution is single-threaded by design, but reading and writing \
                     sockets can be parallelised. On a multi-core host with many clients this \
                     is often the cheapest throughput win available.",
                    Some("Try 2–4 on a machine with spare cores. Needs a restart.".into()),
                    vec![], vec!["# redis.conf — requires restart\nio-threads 4".into()]));
            }
        }
    }
}

// ── Slowlog ──────────────────────────────────────────────────────────────────

fn check_slowlog(d: &RedisTunerData, out: &mut Vec<Finding>) {
    match d.c("slowlog-log-slower-than") {
        Some("0") => out.push(f("r-slowlog-all", "performance", Sev::Warn,
            "slowlog-log-slower-than is 0 — every command is logged",
            "The slowlog ring is being filled by normal traffic, so the genuinely slow commands \
             are pushed out before anyone reads them, and there is a small cost on every \
             command.",
            Some("10000 (10 ms) is a sensible starting threshold.".into()),
            vec![cfg_set("slowlog-log-slower-than", "10000")], vec![])),
        Some("-1") => out.push(f("r-slowlog-off", "performance", Sev::Advice,
            "The slowlog is disabled",
            "Nothing is recorded, so a latency investigation has no starting point.",
            Some("Enable it at 10 ms — the overhead is negligible.".into()),
            vec![cfg_set("slowlog-log-slower-than", "10000")], vec![])),
        _ => {}
    }

    if d.slowlog.is_empty() { return; }

    // Surface the worst offenders, and call out the O(N) commands by name —
    // on a single-threaded server one of these blocks everything.
    let mut worst: Vec<&super::redis_collectors::SlowEntry> = d.slowlog.iter().collect();
    worst.sort_by_key(|e| std::cmp::Reverse(e.duration_us));
    let top = &worst[..worst.len().min(5)];

    let mut detail = String::new();
    for e in top {
        let head = e.command.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
        let _ = writeln!(detail, "  {:.1} ms  {}", e.duration_us as f64 / 1000.0,
                         if e.command.len() > 90 { format!("{}…", &e.command[..90]) }
                         else { e.command.clone() });
        let _ = head;
    }
    let blocking: Vec<&str> = top.iter()
        .filter_map(|e| e.command.split_whitespace().next())
        .filter(|c| matches!(c.to_ascii_uppercase().as_str(),
                             "KEYS" | "FLUSHALL" | "FLUSHDB" | "SMEMBERS" | "HGETALL"
                             | "LRANGE" | "ZRANGE" | "SORT" | "SUNION" | "SINTER"))
        .collect();

    let sev = if top.first().is_some_and(|e| e.duration_us > 100_000) { Sev::Warn } else { Sev::Advice };
    out.push(f("r-slow-commands", "performance", sev,
        format!("{} slow command(s) recorded", d.slowlog.len()),
        format!("Slowest first:\n{detail}{}",
                if blocking.is_empty() { "" }
                else { "\nSome of these are O(N) over a whole key or keyspace. Redis executes \
                        commands one at a time, so a single slow one delays EVERY other client \
                        for its full duration." }),
        Some("Replace whole-collection reads with their cursor equivalents (SCAN, HSCAN, \
              SSCAN, ZSCAN) and range-limited variants.".into()),
        vec!["SLOWLOG GET 128".into()], vec![]));
}

// ── Clients ──────────────────────────────────────────────────────────────────

fn check_clients(d: &RedisTunerData, out: &mut Vec<Finding>) {
    let connected = d.iu("connected_clients").unwrap_or(0);
    let maxclients = d.cu("maxclients").or_else(|| d.iu("maxclients")).unwrap_or(0);

    if maxclients > 0 {
        let pct = connected as f64 * 100.0 / maxclients as f64;
        if pct > 80.0 {
            out.push(f("r-client-usage", "resilience", Sev::Warn,
                format!("{pct:.0}% of maxclients in use"),
                format!("{connected} of {maxclients} connection slots. New connections are \
                         refused at the limit."),
                Some("Raise maxclients, or put a connection pool in front.".into()),
                vec![cfg_set("maxclients", "20000")], vec![]));
        }
    }

    if let Some(rejected) = d.iu("rejected_connections") {
        if rejected > 0 {
            out.push(f("r-rejected-connections", "resilience", Sev::Critical,
                format!("{rejected} connection(s) refused"),
                "Redis turned clients away because maxclients was reached. Every one of those \
                 was an application error.",
                Some("Raise maxclients and find what is opening so many connections.".into()),
                vec![], vec![]));
        }
    }

    if let Some(blocked) = d.iu("blocked_clients") {
        if blocked > 0 {
            out.push(f("r-blocked-clients", "performance", Sev::Info,
                format!("{blocked} client(s) blocked on a blocking command"),
                "BLPOP / BRPOP / XREAD BLOCK and friends. Expected for a queue worker; \
                 unexpected otherwise.",
                None, vec![], vec![]));
        }
    }

    // An idle connection that is never reaped holds a slot and its buffers.
    if d.c("timeout") == Some("0") {
        out.push(f("r-no-timeout", "resilience", Sev::Advice,
            "timeout is 0 — idle clients are never disconnected",
            "A client that goes away without closing cleanly holds its slot and buffers until \
             the TCP stack notices, which can take a very long time.",
            Some("300 seconds is a common choice; combine with tcp-keepalive.".into()),
            vec![cfg_set("timeout", "300")], vec![]));
    }
}

// ── Replication ──────────────────────────────────────────────────────────────

fn check_replication(d: &RedisTunerData, out: &mut Vec<Finding>) {
    if d.is_replica() {
        out.push(f("r-is-replica", "config", Sev::Info,
            "This server is a replica",
            format!("Replicating from {}:{}.",
                    d.i("master_host").unwrap_or("?"), d.i("master_port").unwrap_or("?")),
            None, vec![], vec![]));

        if d.i("master_link_status").is_some_and(|s| s != "up") {
            out.push(f("r-replica-link-down", "resilience", Sev::Critical,
                "Replication link is DOWN",
                format!("master_link_status is {}. The replica is serving data that is \
                         getting staler by the second.",
                        d.i("master_link_status").unwrap_or("?")),
                Some("Check connectivity and the primary's log.".into()), vec![], vec![]));
        }
        if let Some(secs) = d.ii("master_last_io_seconds_ago") {
            if secs > 30 {
                out.push(f("r-replica-stale", "resilience", Sev::Warn,
                    format!("No data from the primary for {secs}s"),
                    "The link reports up but nothing is arriving.",
                    None, vec![], vec![]));
            }
        }
        if d.cb("replica-read-only") == Some(false) {
            out.push(f("r-replica-writable", "resilience", Sev::Warn,
                "This replica accepts writes",
                "Writes made directly to a replica are silently discarded on the next full \
                 resync, and diverge from the primary until then.",
                Some("Set replica-read-only yes unless something genuinely depends on this."
                     .into()),
                vec![cfg_set("replica-read-only", "yes")], vec![]));
        }
    } else {
        let replicas = d.iu("connected_slaves").unwrap_or(0);
        if replicas == 0 && d.mode == "standalone" {
            out.push(f("r-no-replica", "resilience", Sev::Advice,
                "No replicas attached",
                "A single instance has no failover path: losing it means losing availability, \
                 and losing the data too if persistence is off.",
                Some("Add a replica, and Sentinel or Cluster to fail over to it.".into()),
                vec![], vec![]));
        } else if replicas > 0 {
            out.push(f("r-replicas", "resilience", Sev::Ok,
                format!("{replicas} replica(s) connected"),
                "Replication is active.", None, vec![], vec![]));
        }
    }
}

// ── Security ─────────────────────────────────────────────────────────────────

fn check_security(d: &RedisTunerData, out: &mut Vec<Finding>) {
    let no_pass = d.c("requirepass").is_some_and(|p| p.is_empty());
    let bind = d.c("bind").unwrap_or("").to_string();
    let protected = d.cb("protected-mode").unwrap_or(true);
    // Bound only to loopback is the mitigating factor for everything below.
    let loopback_only = !bind.is_empty()
        && bind.split_whitespace().all(|a| a == "127.0.0.1" || a == "::1" || a == "localhost");

    if no_pass {
        let (sev, extra) = if loopback_only {
            (Sev::Warn, " This instance is bound to loopback only, which is what keeps it from \
                         being trivially reachable — the moment `bind` changes, it is open.")
        } else {
            (Sev::Critical, " Combined with a non-loopback bind, anyone who can reach the port \
                             has full access — including FLUSHALL and CONFIG SET.")
        };
        out.push(f("r-no-password", "security", sev,
            "No password is set (requirepass is empty)",
            format!("Redis accepts unauthenticated connections.{extra}"),
            Some("Set requirepass, or better, define ACL users with only the commands and key \
                  patterns each needs.".into()),
            vec![cfg_set("requirepass", "<a long random secret>")],
            vec!["# redis.conf\nrequirepass <a long random secret>".into()]));
    }

    if !protected && no_pass {
        out.push(f("r-protected-mode-off", "security", Sev::Critical,
            "protected-mode is off AND no password is set",
            "Protected mode is the last safeguard that stops an unauthenticated Redis from \
             answering non-loopback clients. With it off and no password, the instance is fully \
             open to anyone who can route to it.",
            Some("Turn protected-mode back on and set a password.".into()),
            vec![cfg_set("protected-mode", "yes")], vec![]));
    }

    if bind.split_whitespace().any(|a| a == "0.0.0.0" || a == "*") {
        out.push(f("r-bind-all", "security", if no_pass { Sev::Critical } else { Sev::Warn },
            "Listening on all interfaces",
            format!("bind is `{bind}`. The port is reachable from every network the host is on."),
            Some("Bind to the specific interface that needs it, and keep the port behind a \
                  firewall.".into()),
            vec![], vec![]));
    }

    if d.default_user_nopass == Some(true) && !no_pass {
        out.push(f("r-acl-default-nopass", "security", Sev::Warn,
            "The `default` ACL user requires no password",
            "Even with requirepass set, a `default` user carrying `nopass` accepts \
             unauthenticated connections — the ACL overrides requirepass.",
            Some("Give the default user a password, or disable it (`ACL SETUSER default off`) \
                  once named users exist.".into()),
            vec!["ACL SETUSER default >your-password".into()], vec![]));
    }

    if d.acl_users.len() <= 1 && !d.acl_users.is_empty() {
        out.push(f("r-single-acl-user", "security", Sev::Advice,
            "Only the `default` ACL user exists",
            "Every client shares one identity with full command access, so a compromised or \
             buggy application can run FLUSHALL, CONFIG SET or KEYS.",
            Some("Define per-application users limited to the commands and key patterns they \
                  need (Redis 6+).".into()),
            vec!["ACL SETUSER app on >secret ~app:* +@read +@write -@dangerous".into()], vec![]));
    }

    // Renaming or disabling the footguns is standard hardening.
    let unrenamed: Vec<&str> = ["FLUSHALL", "FLUSHDB", "CONFIG", "KEYS", "DEBUG", "SHUTDOWN"]
        .into_iter()
        .filter(|c| !d.config.contains_key(&format!("rename-command {c}")))
        .collect();
    if unrenamed.len() == 6 && !d.acl_users.is_empty() {
        out.push(f("r-dangerous-commands", "security", Sev::Advice,
            "Destructive commands are available to every client",
            "FLUSHALL, FLUSHDB, CONFIG, KEYS, DEBUG and SHUTDOWN are all callable. One stray \
             FLUSHALL from an application is unrecoverable without a backup.",
            Some("Restrict them per user with ACLs (`-@dangerous`), which is the modern \
                  replacement for rename-command.".into()),
            vec!["ACL SETUSER app on >secret ~* +@all -@dangerous -flushall -flushdb".into()],
            vec![]));
    }

    if d.cb("tls-port").is_none() && d.c("tls-port").is_some_and(|p| p == "0") && !loopback_only {
        out.push(f("r-no-tls", "security", Sev::Warn,
            "TLS is not enabled",
            "Traffic, including the AUTH password on a non-ACL setup, crosses the network in \
             clear text.",
            Some("Enable tls-port with a certificate, or keep Redis on a private network.".into()),
            vec![], vec![]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tuner::redis_collectors::{RedisTunerData, SlowEntry};

    fn data(info: &[(&str, &str)], config: &[(&str, &str)]) -> RedisTunerData {
        let mut d = RedisTunerData::default();
        d.version = "8.10.0".into();
        d.major = 8; d.minor = 10;
        d.mode = "standalone".into();
        d.uptime_secs = 7 * 86400;
        for (k, v) in info { d.info.insert((*k).into(), (*v).into()); }
        for (k, v) in config { d.config.insert((*k).into(), (*v).into()); }
        d
    }

    fn ids(fs: &[Finding]) -> Vec<&str> { fs.iter().map(|f| f.id.as_str()).collect() }
    fn sev<'a>(fs: &'a [Finding], id: &str) -> Option<&'a str> {
        fs.iter().find(|f| f.id == id).map(|f| f.severity.as_str())
    }

    // ── Memory: the most common Redis outage ─────────────────────────────

    #[test]
    fn unset_maxmemory_is_critical() {
        let d = data(&[("used_memory", "1000")], &[("maxmemory", "0")]);
        let mut out = Vec::new();
        check_memory(&d, &mut out);
        assert_eq!(sev(&out, "r-maxmemory-unset"), Some("critical"));
    }

    #[test]
    fn memory_usage_ladder() {
        for (used, expect) in [(1_000_000_u64, "ok"), (850_000_000, "warn"), (990_000_000, "critical")] {
            let d = data(&[("used_memory", &used.to_string())], &[("maxmemory", "1000000000")]);
            let mut out = Vec::new();
            check_memory(&d, &mut out);
            assert_eq!(sev(&out, "r-memory-usage"), Some(expect), "used={used}");
        }
    }

    #[test]
    fn swapping_is_worse_than_fragmentation() {
        // Ratio < 1.0 means part of the dataset is in swap — on a
        // single-threaded server that stalls every client.
        let d = data(&[("used_memory", "200000000"), ("used_memory_rss", "100000000"),
                       ("mem_fragmentation_ratio", "0.5")], &[("maxmemory", "0")]);
        let mut out = Vec::new();
        check_memory(&d, &mut out);
        assert_eq!(sev(&out, "r-swapping"), Some("critical"));
        assert!(!ids(&out).contains(&"r-fragmentation"));

        let frag = data(&[("used_memory", "200000000"), ("used_memory_rss", "500000000"),
                          ("mem_fragmentation_ratio", "2.5")], &[("maxmemory", "0")]);
        let mut o2 = Vec::new();
        check_memory(&frag, &mut o2);
        assert_eq!(sev(&o2, "r-fragmentation"), Some("warn"));
        assert!(!ids(&o2).contains(&"r-swapping"));
    }

    // ── Eviction: the subtle one ─────────────────────────────────────────

    #[test]
    fn noeviction_with_a_ceiling_is_critical() {
        let d = data(&[], &[("maxmemory", "1000000"), ("maxmemory-policy", "noeviction")]);
        let mut out = Vec::new();
        check_eviction(&d, &mut out);
        assert_eq!(sev(&out, "r-noeviction"), Some("critical"));
    }

    #[test]
    fn noeviction_without_a_ceiling_is_not_flagged_here() {
        // Nothing to evict against — the missing ceiling is the real finding.
        let d = data(&[], &[("maxmemory", "0"), ("maxmemory-policy", "noeviction")]);
        let mut out = Vec::new();
        check_eviction(&d, &mut out);
        assert!(!ids(&out).contains(&"r-noeviction"));
    }

    #[test]
    fn volatile_policy_with_no_ttls_behaves_like_noeviction() {
        // The configuration LOOKS right, which is what makes this dangerous.
        let mut d = data(&[], &[("maxmemory", "1000000"), ("maxmemory-policy", "volatile-lru")]);
        d.total_keys = 1000;
        d.volatile_keys = 5;
        let mut out = Vec::new();
        check_eviction(&d, &mut out);
        assert_eq!(sev(&out, "r-volatile-policy-no-ttls"), Some("critical"));

        // With most keys carrying a TTL the policy works as intended.
        d.volatile_keys = 900;
        let mut o2 = Vec::new();
        check_eviction(&d, &mut o2);
        assert!(!ids(&o2).contains(&"r-volatile-policy-no-ttls"));
    }

    // ── Persistence ──────────────────────────────────────────────────────

    #[test]
    fn no_persistence_at_all_is_critical() {
        let d = data(&[], &[("appendonly", "no"), ("save", "")]);
        let mut out = Vec::new();
        check_persistence(&d, &mut out);
        assert_eq!(sev(&out, "r-no-persistence"), Some("critical"));
    }

    #[test]
    fn rdb_only_is_advice_not_critical() {
        let d = data(&[], &[("appendonly", "no"), ("save", "3600 1 300 100")]);
        let mut out = Vec::new();
        check_persistence(&d, &mut out);
        assert_eq!(sev(&out, "r-rdb-only"), Some("advice"));
        assert!(!ids(&out).contains(&"r-no-persistence"));
    }

    #[test]
    fn a_failing_bgsave_is_critical() {
        let d = data(&[("rdb_last_bgsave_status", "err")], &[("appendonly", "yes")]);
        let mut out = Vec::new();
        check_persistence(&d, &mut out);
        assert_eq!(sev(&out, "r-bgsave-failing"), Some("critical"));
    }

    #[test]
    fn appendfsync_extremes_are_judged_only_when_aof_is_on() {
        let off = data(&[], &[("appendonly", "no"), ("appendfsync", "no"), ("save", "900 1")]);
        let mut o1 = Vec::new();
        check_persistence(&off, &mut o1);
        assert!(!ids(&o1).contains(&"r-appendfsync-no"), "irrelevant when AOF is off");

        let on = data(&[], &[("appendonly", "yes"), ("appendfsync", "no")]);
        let mut o2 = Vec::new();
        check_persistence(&on, &mut o2);
        assert_eq!(sev(&o2, "r-appendfsync-no"), Some("warn"));
    }

    // ── Security ─────────────────────────────────────────────────────────

    #[test]
    fn missing_password_severity_depends_on_the_bind() {
        // Loopback-only is the mitigating factor; exposed is not.
        let local = data(&[], &[("requirepass", ""), ("bind", "127.0.0.1 ::1"), ("protected-mode", "yes")]);
        let mut o1 = Vec::new();
        check_security(&local, &mut o1);
        assert_eq!(sev(&o1, "r-no-password"), Some("warn"));

        let exposed = data(&[], &[("requirepass", ""), ("bind", "0.0.0.0"), ("protected-mode", "yes")]);
        let mut o2 = Vec::new();
        check_security(&exposed, &mut o2);
        assert_eq!(sev(&o2, "r-no-password"), Some("critical"));
        assert_eq!(sev(&o2, "r-bind-all"), Some("critical"));
    }

    #[test]
    fn protected_mode_off_only_matters_without_a_password() {
        let with_pass = data(&[], &[("requirepass", "s3cret"), ("protected-mode", "no"), ("bind", "10.0.0.1")]);
        let mut o1 = Vec::new();
        check_security(&with_pass, &mut o1);
        assert!(!ids(&o1).contains(&"r-protected-mode-off"));

        let without = data(&[], &[("requirepass", ""), ("protected-mode", "no"), ("bind", "10.0.0.1")]);
        let mut o2 = Vec::new();
        check_security(&without, &mut o2);
        assert_eq!(sev(&o2, "r-protected-mode-off"), Some("critical"));
    }

    #[test]
    fn a_nopass_default_user_defeats_requirepass() {
        let mut d = data(&[], &[("requirepass", "s3cret"), ("bind", "127.0.0.1")]);
        d.default_user_nopass = Some(true);
        d.acl_users = vec!["default".into()];
        let mut out = Vec::new();
        check_security(&d, &mut out);
        assert_eq!(sev(&out, "r-acl-default-nopass"), Some("warn"));
    }

    // ── Slowlog + clients ────────────────────────────────────────────────

    #[test]
    fn slowlog_logging_everything_is_flagged() {
        let d = data(&[], &[("slowlog-log-slower-than", "0")]);
        let mut out = Vec::new();
        check_slowlog(&d, &mut out);
        assert_eq!(sev(&out, "r-slowlog-all"), Some("warn"));
    }

    #[test]
    fn slow_commands_name_the_blocking_ones() {
        let mut d = data(&[], &[("slowlog-log-slower-than", "10000")]);
        d.slowlog = vec![
            SlowEntry { duration_us: 250_000, command: "KEYS *".into() },
            SlowEntry { duration_us: 12_000,  command: "GET x".into() },
        ];
        let mut out = Vec::new();
        check_slowlog(&d, &mut out);
        let fi = out.iter().find(|f| f.id == "r-slow-commands").expect("finding");
        assert_eq!(fi.severity, "warn", "a 250ms command is a warning");
        assert!(fi.detail.contains("KEYS *"));
        assert!(fi.detail.contains("one at a time"), "must explain the single-threaded impact");
    }

    #[test]
    fn refused_connections_are_critical() {
        let d = data(&[("rejected_connections", "42"), ("connected_clients", "10")],
                     &[("maxclients", "10000")]);
        let mut out = Vec::new();
        check_clients(&d, &mut out);
        assert_eq!(sev(&out, "r-rejected-connections"), Some("critical"));
    }

    // ── Replication ──────────────────────────────────────────────────────

    #[test]
    fn a_down_replication_link_is_critical() {
        let d = data(&[("role", "slave"), ("master_link_status", "down"),
                       ("master_host", "10.0.0.1"), ("master_port", "6379")], &[]);
        let mut out = Vec::new();
        check_replication(&d, &mut out);
        assert_eq!(sev(&out, "r-replica-link-down"), Some("critical"));
        assert!(ids(&out).contains(&"r-is-replica"));
    }

    #[test]
    fn a_writable_replica_is_flagged() {
        let d = data(&[("role", "slave"), ("master_link_status", "up")],
                     &[("replica-read-only", "no")]);
        let mut out = Vec::new();
        check_replication(&d, &mut out);
        assert_eq!(sev(&out, "r-replica-writable"), Some("warn"));
    }

    // ── Contract ─────────────────────────────────────────────────────────

    #[test]
    fn every_finding_obeys_the_shared_contract() {
        let mut d = data(&[
            ("used_memory", "900000000"), ("used_memory_rss", "400000000"),
            ("mem_fragmentation_ratio", "0.4"), ("keyspace_hits", "10"),
            ("keyspace_misses", "90"), ("rejected_connections", "3"),
            ("connected_clients", "9500"), ("rdb_last_bgsave_status", "err"),
            ("role", "master"), ("evicted_keys", "500"), ("latest_fork_usec", "900000"),
        ], &[
            ("maxmemory", "1000000000"), ("maxmemory-policy", "noeviction"),
            ("appendonly", "no"), ("save", ""), ("requirepass", ""),
            ("bind", "0.0.0.0"), ("protected-mode", "no"), ("maxclients", "10000"),
            ("timeout", "0"), ("slowlog-log-slower-than", "0"), ("io-threads", "1"),
        ]);
        d.acl_users = vec!["default".into()];
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
    fn a_bad_instance_scores_far_below_a_good_one() {
        let mut bad = data(&[
            ("used_memory", "990000000"), ("mem_fragmentation_ratio", "0.4"),
            ("keyspace_hits", "10"), ("keyspace_misses", "90"),
            ("rejected_connections", "3"), ("rdb_last_bgsave_status", "err"),
            ("role", "master"),
        ], &[
            ("maxmemory", "1000000000"), ("maxmemory-policy", "noeviction"),
            ("appendonly", "no"), ("save", ""), ("requirepass", ""),
            ("bind", "0.0.0.0"), ("protected-mode", "no"), ("timeout", "0"),
        ]);
        bad.acl_users = vec!["default".into()];

        let good = data(&[
            ("used_memory", "300000000"), ("used_memory_rss", "330000000"),
            ("mem_fragmentation_ratio", "1.1"), ("keyspace_hits", "990"),
            ("keyspace_misses", "10"), ("rejected_connections", "0"),
            ("rdb_last_bgsave_status", "ok"), ("aof_last_write_status", "ok"),
            ("role", "master"), ("connected_slaves", "2"), ("mem_allocator", "jemalloc-5.3.0"),
            ("latest_fork_usec", "1000"), ("connected_clients", "50"),
        ], &[
            ("maxmemory", "1000000000"), ("maxmemory-policy", "allkeys-lru"),
            ("appendonly", "yes"), ("appendfsync", "everysec"), ("save", "900 1"),
            ("requirepass", "s3cret"), ("bind", "10.0.0.5"), ("protected-mode", "yes"),
            ("maxclients", "10000"), ("timeout", "300"),
            ("slowlog-log-slower-than", "10000"), ("io-threads", "4"),
        ]);

        let bs = crate::tuner::checks::compute_score(&run_checks(&bad, None));
        let gs = crate::tuner::checks::compute_score(&run_checks(&good, None));
        assert!(bs.total < gs.total, "bad {} should score below good {}", bs.total, gs.total);
        assert!(bs.total <= 50, "an unauthenticated, unpersisted, swapping instance scored {}", bs.total);
        assert!(gs.total >= 85, "a well-configured instance scored only {}", gs.total);
    }
}
