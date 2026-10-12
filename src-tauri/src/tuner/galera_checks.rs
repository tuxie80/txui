//! Galera (wsrep) rule pack for the MySQL-family tuner — MariaDB Galera
//! Cluster and Percona XtraDB Cluster. Pure functions over the collected
//! [`TunerData`], gated on `data.galera` being Some (i.e. the `wsrep_on`
//! VARIABLE said ON — MariaDB carries no STATUS row for it, verified live on
//! 11.8).
//!
//! Every finding id starts with `galera.` — the frontend groups those into
//! their own report section while the category stays one of the scoring
//! buckets (performance / resilience / config), so the health-score math is
//! unchanged. Fixes follow the MariaDB reality: `wsrep_provider_options` is
//! READ-ONLY over SQL there (SET fails with ERROR 1238, verified live), so
//! provider-option fixes are config-file lines; `wsrep_slave_threads` and the
//! SST donor list ARE dynamic and get fix_sql.

use super::collectors::{Flavor, TunerData};
use super::{f, fmt_bytes, Finding, Sev};

const MIB: u64 = 1024 * 1024;

/// Provider-option lookup with a bool parse ("yes/no", "true/false", "1/0").
fn opt_on(d: &TunerData, key: &str) -> Option<bool> {
    let v = d.galera.as_ref()?.provider_options.get(key)?;
    match v.to_ascii_lowercase().as_str() {
        "yes" | "true" | "1" | "on" => Some(true),
        "no" | "false" | "0" | "off" => Some(false),
        _ => None,
    }
}

/// my.cnf value for a provider option: `wsrep_provider_options = "k=v"`.
fn provider_cfg(key: &str, value: &str) -> String {
    format!("wsrep_provider_options = \"{key}={value}\"")
}

pub fn run(d: &TunerData, out: &mut Vec<Finding>) {
    if d.galera.is_none() {
        return;
    }
    node_state(d, out);
    gcache_window(d, out);
    slave_threads(d, out);
    apply_parallelism(d, out);
    flow_control(d, out);
    recv_queue(d, out);
    write_conflicts(d, out);
    sst_method(d, out);
    provider_options_readonly(d, out);
}

/// Cluster membership and node state: non-Primary component, non-Synced node,
/// and the single-point cases (size 1, and size 2 without an arbitrator).
fn node_state(d: &TunerData, out: &mut Vec<Finding>) {
    let status = d.s("wsrep_cluster_size");
    let component = d.status.get("wsrep_cluster_status").map(String::as_str);
    let state = d.status.get("wsrep_local_state_comment").map(String::as_str);

    if let Some(c) = component {
        if c != "Primary" {
            out.push(f("galera.node_state", "resilience", Sev::Critical,
                format!("Node is in a non-Primary component ({c})"),
                "wsrep_cluster_status is not Primary — this component cannot certify writes. \
                 The node is partitioned from the quorum or the cluster never formed.",
                Some("Check the other members BEFORE writing here; if quorum is truly lost, \
                      bootstrap the surviving component (pc.bootstrap) from the most advanced node.".into()),
                vec![], vec![]));
            return;
        }
    }
    match state {
        Some("Synced") | None => {}
        Some(s) if s == "Donor/Desynced" || s == "Donor-Desynced" => {
            out.push(f("galera.node_state", "resilience", Sev::Info,
                "Node is a donor (Donor/Desynced)",
                "Serving a state transfer to a joining node, or manually desynced via \
                 wsrep_desync. Writes here are degraded while it streams.",
                Some("Verify the node returns to Synced when the transfer/desync ends.".into()),
                vec![], vec![]));
        }
        Some(s) => {
            out.push(f("galera.node_state", "resilience", Sev::Warn,
                format!("Node state is {s}, not Synced"),
                "A Joining/Joined node is mid-transfer or catching up on the apply backlog \
                 and should not take production traffic yet.",
                Some("Watch wsrep_local_recv_queue drain to zero; the node flips to Synced on its own.".into()),
                vec![], vec![]));
        }
    }

    if let Some(size) = status {
        match size {
            1 if component == Some("Primary") => out.push(f("galera.cluster_size", "resilience", Sev::Warn,
                "Cluster of ONE node — no redundancy",
                "wsrep_cluster_size is 1: this node is the entire cluster. Any failure is \
                 a full outage, and every rejoin needs an IST/SST from a gcache that has \
                 no peer to serve it.",
                Some("Bring the other members up (or add a garbd arbitrator for quorum).".into()),
                vec![], vec![])),
            2 => out.push(f("galera.cluster_size", "resilience", Sev::Advice,
                "Two-node cluster has no quorum tiebreaker",
                "With 2 members, losing the link between them leaves neither side with \
                 quorum — both go non-Primary. A third node or a garbd arbitrator breaks the tie.",
                Some("Add a third node, or run galera arbitrator (garbd) on a third host.".into()),
                vec![], vec![])),
            n => out.push(f("galera.cluster_size", "resilience", Sev::Ok,
                format!("Cluster has {n} nodes"),
                String::new(), None, vec![], vec![])),
        }
    }
}

/// gcache.size vs the observed write rate: how long a stopped node can stay
/// down before its rejoin needs a full SST instead of an IST. The rate is
/// wsrep_replicated_bytes / uptime — an AVERAGE since startup, stated as such
/// in the finding; bursts shorten the real window.
fn gcache_window(d: &TunerData, out: &mut Vec<Finding>) {
    let Some(g) = &d.galera else { return };
    let Some(size) = g.gcache_size_bytes else { return }; // options string absent → degrade
    let Some(replicated) = d.s("wsrep_replicated_bytes") else { return };
    if d.uptime_secs < 300 {
        out.push(f("galera.gcache_window", "resilience", Sev::Info,
            "gcache window not yet measurable",
            format!("gcache.size is {} but uptime is only {} s — the average write rate is not representative yet.",
                fmt_bytes(size), d.uptime_secs),
            Some("Re-run after a few hours of typical load.".into()),
            vec![], vec![]));
        return;
    }
    let burn = replicated as f64 / d.uptime_secs as f64; // bytes/s, average since startup
    if burn < 1.0 {
        out.push(f("galera.gcache_window", "resilience", Sev::Ok,
            format!("gcache ({}), no write load observed", fmt_bytes(size)),
            "wsrep_replicated_bytes is ~flat since startup, so the IST window is effectively \
             unbounded at the current rate.",
            None, vec![], vec![]));
        return;
    }
    let window_secs = size as f64 / burn;
    let window_min = window_secs / 60.0;
    let assumption = format!(
        "gcache.size = {} vs {} replicated over {} s uptime (avg {}/s — an average; \
         bursts shorten the real window). A node down LONGER than this window cannot \
         catch up incrementally (IST) and needs a full state transfer (SST).",
        fmt_bytes(size), fmt_bytes(replicated), d.uptime_secs, fmt_bytes(burn as u64));
    // Suggested size: 2 h of the average burn, never below the current size.
    let suggested = ((burn * 7200.0) as u64).max(size).div_ceil(MIB) * MIB;
    let suggested_text = format!("{}M", suggested / MIB);
    // On MariaDB wsrep_provider_options is read-only over SQL (ERROR 1238,
    // verified live on 11.8) — config file only. PXC accepts the SET GLOBAL.
    let fix_sql = if d.flavor == Flavor::Mariadb { vec![] } else {
        vec![format!("SET GLOBAL wsrep_provider_options = 'gcache.size={suggested_text}';")]
    };
    let fix_cfg = vec![provider_cfg("gcache.size", &suggested_text)];

    if window_min < 10.0 {
        out.push(f("galera.gcache_window", "resilience", Sev::Warn,
            format!("gcache covers only ≈{window_min:.0} min of writes"),
            assumption,
            Some(format!("Grow gcache.size to ≈{suggested_text} (2 h at the observed average) \
                          so routine restarts stay IST-cheap.")),
            fix_sql, fix_cfg));
    } else if window_min < 60.0 {
        out.push(f("galera.gcache_window", "resilience", Sev::Advice,
            format!("gcache covers ≈{window_min:.0} min of writes"),
            assumption,
            Some(format!("Enough for a quick restart, tight for a maintenance window. \
                          ≈{suggested_text} would hold 2 h at the observed average.")),
            fix_sql, fix_cfg));
    } else {
        out.push(f("galera.gcache_window", "resilience", Sev::Ok,
            format!("gcache covers ≈{:.1} h of writes", window_secs / 3600.0),
            assumption, None, vec![], vec![]));
    }
}

/// wsrep_slave_threads vs wsrep_cert_deps_distance: the certification
/// dependency distance is how wide apply COULD parallelize; the thread count
/// is how wide it DOES. deps ≫ threads starves apply; threads ≫ deps parks
/// server threads for nothing.
fn slave_threads(d: &TunerData, out: &mut Vec<Finding>) {
    let (Some(threads), Some(deps)) = (d.vu("wsrep_slave_threads"), d.sf("wsrep_cert_deps_distance"))
        else { return };
    let t = threads.max(1) as f64;
    let suggested = (deps.ceil() as u64).clamp(threads + 1, 512);
    let fix_sql = vec![format!("SET GLOBAL wsrep_slave_threads = {suggested};")];
    let fix_cfg = vec![format!("wsrep_slave_threads = {suggested}")];
    let evidence = format!(
        "wsrep_cert_deps_distance is {deps:.2} (the average parallel-apply window — an EWMA, \
         so it reflects recent load, not this instant) against wsrep_slave_threads = {threads}.");
    if deps >= 2.0 * t && deps >= 2.0 {
        let sev = if deps >= 4.0 * t && deps >= 8.0 { Sev::Warn } else { Sev::Advice };
        out.push(f("galera.slave_threads", "performance", sev,
            format!("Apply could parallelize ≈{deps:.0}× but only {threads} thread(s) configured"),
            format!("{evidence} Apply is the bottleneck this starves — recv queues and flow \
                     control follow when write load returns."),
            Some(format!("Raise wsrep_slave_threads toward the dependency distance (≈{suggested}); \
                          it is dynamic. Past ~2× the CPU core count stops paying.")),
            fix_sql, fix_cfg));
    } else if threads > 4 && t > 4.0 * deps && deps > 0.0 {
        out.push(f("galera.slave_threads", "performance", Sev::Advice,
            format!("{threads} applier threads for a ≈{deps:.1}× parallel window"),
            format!("{evidence} Most appliers sit idle; each still costs a server thread."),
            Some(format!("Consider lowering wsrep_slave_threads toward ≈{} (dynamic).",
                (deps.ceil() as u64).clamp(2, threads))),
            vec![format!("SET GLOBAL wsrep_slave_threads = {};", (deps.ceil() as u64).clamp(2, threads))],
            vec![format!("wsrep_slave_threads = {}", (deps.ceil() as u64).clamp(2, threads))]));
    } else {
        out.push(f("galera.slave_threads", "performance", Sev::Ok,
            format!("Apply parallelism matches the workload ({threads} thread(s), window ≈{deps:.1})"),
            evidence, None, vec![], vec![]));
    }
}

/// deps_distance ≈ 0 under real write load: nothing to parallelize — apply is
/// effectively serial no matter how many threads are configured.
fn apply_parallelism(d: &TunerData, out: &mut Vec<Finding>) {
    let Some(deps) = d.sf("wsrep_cert_deps_distance") else { return };
    let writes = d.s("wsrep_replicated").unwrap_or(0);
    if deps < 1.0 && writes >= 1000 {
        out.push(f("galera.apply_serial", "performance", Sev::Advice,
            "Write-sets certify serially — parallel apply has no window",
            format!("wsrep_cert_deps_distance is {deps:.2} over {writes} replicated write-sets: \
                     transactions almost never overlap in certification, so extra applier \
                     threads cannot help. Typical causes: single-row autocommit writes, or one \
                     writer thread feeding the cluster."),
            Some("Batch writes into larger transactions, or accept serial apply and keep \
                  wsrep_slave_threads low — raising it changes nothing here.".into()),
            vec![], vec![]));
    }
}

/// Flow control: wsrep_flow_control_paused is the fraction of time the cluster
/// throttled THIS node. The ladder mirrors the dashboard's: >1% advice, >10%
/// warn, >50% critical. The ratio resets on FLUSH STATUS — the detail quotes
/// the cumulative paused_ns alongside so a stale ratio is visible as such.
fn flow_control(d: &TunerData, out: &mut Vec<Finding>) {
    let Some(paused) = d.sf("wsrep_flow_control_paused") else { return };
    let paused_ns = d.s("wsrep_flow_control_paused_ns").unwrap_or(0);
    let fc_limit = d.galera.as_ref()
        .and_then(|g| g.provider_options.get("gcs.fc_limit")).cloned()
        .unwrap_or_else(|| "?".into());
    let fc_factor = d.galera.as_ref()
        .and_then(|g| g.provider_options.get("gcs.fc_factor")).cloned()
        .unwrap_or_else(|| "?".into());
    let pct = paused * 100.0;
    let evidence = format!(
        "wsrep_flow_control_paused = {pct:.3}% (cumulative paused time {paused_ns} ns; the \
         ratio resets on FLUSH STATUS). Flow control engages when a member's recv queue \
         passes gcs.fc_limit = {fc_limit} and releases at fc_limit × gcs.fc_factor = {fc_factor}.");
    let rec = "Find the slowest node first: poll wsrep_local_recv_queue on every member — \
               the one with the persistent queue is why everyone pauses. Raise its \
               wsrep_slave_threads or fix its I/O. Only then tune gcs.fc_limit up \
               (more buffering before throttling) or gcs.fc_factor down (release earlier); \
               on MariaDB both move via wsrep_provider_options in the config file, \
               not SET GLOBAL (provider options are read-only over SQL there — ERROR 1238).";
    if paused > 0.5 {
        out.push(f("galera.flow_control", "performance", Sev::Critical,
            format!("Flow control paused this node {pct:.0}% of the time"),
            evidence, Some(rec.into()), vec![],
            vec![provider_cfg("gcs.fc_limit", "256"), provider_cfg("gcs.fc_factor", "0.8")]));
    } else if paused > 0.1 {
        out.push(f("galera.flow_control", "performance", Sev::Warn,
            format!("Flow control paused this node {pct:.1}% of the time"),
            evidence, Some(rec.into()), vec![], vec![]));
    } else if paused > 0.01 {
        out.push(f("galera.flow_control", "performance", Sev::Advice,
            format!("Flow control has throttled this node ({pct:.2}% of the time)"),
            evidence, Some(rec.into()), vec![], vec![]));
    } else {
        out.push(f("galera.flow_control", "performance", Sev::Ok,
            "Flow control is effectively idle",
            evidence, None, vec![], vec![]));
    }
}

/// Apply backlog. The EWMA (wsrep_local_recv_queue_avg) stays hot for ~30 min
/// after a rejoin's catch-up burst (verified live on MariaDB 11.8), so it only
/// fires corroborated by a non-empty CURRENT queue — a hot average with an
/// empty queue is residue, not a backlog.
fn recv_queue(d: &TunerData, out: &mut Vec<Finding>) {
    let queue = d.s("wsrep_local_recv_queue");
    let avg = d.sf("wsrep_local_recv_queue_avg");
    if let Some(q) = queue {
        if q > 8 {
            out.push(f("galera.recv_queue", "performance", Sev::Warn,
                format!("{q} write-sets queued for apply"),
                format!("wsrep_local_recv_queue = {q}: the node received writes it has not \
                         applied yet, so its reads are stale relative to the cluster."),
                Some("Growing queues mean this is the slowest node — raise wsrep_slave_threads \
                      or find the I/O bottleneck before flow control throttles everyone.".into()),
                vec![], vec![]));
        }
    }
    if let Some(a) = avg {
        // Unreadable current queue (None) cannot corroborate — unknown-means-allowed.
        if a > 1.0 && queue != Some(0) {
            out.push(f("galera.recv_queue_avg", "performance", Sev::Advice,
                format!("Apply backlog persists (recv queue average {a:.2})"),
                "wsrep_local_recv_queue_avg is an EWMA: an average above 1.0 WITH a non-empty \
                 current queue means apply is slower than the cluster's write rate. (A hot \
                 average with an EMPTY queue is residue from a past catch-up and is ignored.)",
                Some("Raise wsrep_slave_threads or find the I/O bottleneck on this node.".into()),
                vec![], vec![]));
        }
    }
}

/// Certification conflicts: wsrep_local_bf_aborts (local transactions killed
/// by a conflicting certified write-set) + wsrep_local_cert_failures. A
/// climbing rate points at hot rows written from several nodes at once — an
/// application shape, not a server knob.
fn write_conflicts(d: &TunerData, out: &mut Vec<Finding>) {
    let bf = d.s("wsrep_local_bf_aborts");
    let cert = d.s("wsrep_local_cert_failures");
    let (Some(bf), Some(cert)) = (bf, cert) else { return };
    let total = bf + cert;
    if total == 0 {
        return;
    }
    let per_h = if d.uptime_secs > 0 { total as f64 / (d.uptime_secs as f64 / 3600.0) } else { 0.0 };
    let detail = format!(
        "wsrep_local_bf_aborts = {bf}, wsrep_local_cert_failures = {cert} since startup \
         (≈{per_h:.1}/h). These are transactions rolled back because a conflicting write \
         won certification — the hot-row/multi-writer signature. The fix is in the \
         application: retry-on-deadlock (error 1213) logic, or write affinity so one \
         row set is owned by one node.");
    if per_h >= 60.0 {
        out.push(f("galera.write_conflicts", "performance", Sev::Warn,
            format!("{total} certification conflicts (≈{per_h:.0}/h)"),
            detail,
            Some("Find the contested rows in the application log; add retry loops and \
                  consider routing writes for the same rows to one node.".into()),
            vec![], vec![]));
    } else {
        out.push(f("galera.write_conflicts", "performance", Sev::Advice,
            format!("{total} certification conflicts since startup"),
            detail,
            Some("Occasional conflicts are normal under Galera; watch the rate, not the total.".into()),
            vec![], vec![]));
    }
}

/// SST method and donor selection. rsync is a legitimate choice — but the
/// donor is BLOCKED (Donor/Desynced) for the whole transfer, so the finding
/// phrases it as a tradeoff, not an error. Also the donor-pinning sanity:
/// with wsrep_sst_donor empty the cluster picks the donor itself.
fn sst_method(d: &TunerData, out: &mut Vec<Finding>) {
    let Some(method) = d.v("wsrep_sst_method") else { return };
    let donor_list = d.v("wsrep_sst_donor").unwrap_or("");
    let sync_donor = opt_on(d, "gcs.sync_donor");
    let donor_note = if donor_list.trim().is_empty() {
        "wsrep_sst_donor is empty, so any node may be picked as donor — including the \
         busiest one. Pin it to a preferred node (or list) to make donations predictable."
    } else {
        "wsrep_sst_donor pins the donor — donations are predictable."
    };
    let sync_note = match sync_donor {
        Some(true) => " gcs.sync_donor = yes keeps the donor in the flow-control loop \
                        (it throttles with the cluster instead of falling behind).",
        Some(false) => "",
        None => "",
    };
    match method {
        "rsync" | "rsync_wan" => out.push(f("galera.sst_method", "resilience", Sev::Info,
            format!("SST method is {method} — the donor is blocked for the whole transfer"),
            format!("An rsync SST puts the donor into Donor/Desynced and blocks ITS writes \
                     until the copy finishes — cheap to set up and fine for small datasets \
                     or quiet hours, painful for big ones. mariabackup streams without \
                     blocking the donor's reads for most of the run, at the cost of backup \
                     credentials, extra disk I/O and its own failure modes. {donor_note}{sync_note}"),
            Some("If donor blocking has never bitten you, rsync is a defensible default; \
                  if it has, rehearse mariabackup before you need it at 3 a.m.".into()),
            vec![],
            vec!["# wsrep_sst_method = mariabackup\n# wsrep_sst_auth = 'sstuser:<password>'".into()])),
        "mysqldump" => out.push(f("galera.sst_method", "resilience", Sev::Advice,
            "SST method is mysqldump — slow and logical",
            format!("mysqldump SST is a logical dump/reload: slow, and the donor is read-only \
                     for the duration. It exists for exotic storage layouts, not for routine \
                     use. {donor_note}"),
            Some("Switch to rsync (simple) or mariabackup (non-blocking donor) unless you \
                  specifically need a logical transfer.".into()),
            vec![],
            vec!["wsrep_sst_method = rsync".into()])),
        _ => out.push(f("galera.sst_method", "resilience", Sev::Ok,
            format!("SST method is {method}"),
            format!("Physical, streaming transfer — the donor keeps serving for most of it. {donor_note}"),
            None, vec![], vec![])),
    }
}

/// On MariaDB, wsrep_provider_options is READ-ONLY over SQL (SET fails with
/// ERROR 1238, verified live on 11.8; information_schema.SYSTEM_VARIABLES
/// agrees). Every provider-option fix in this pack is therefore a config-file
/// line — this finding says so once, so the missing SET GLOBAL buttons are
/// explained rather than looking like an omission.
fn provider_options_readonly(d: &TunerData, out: &mut Vec<Finding>) {
    if d.flavor != Flavor::Mariadb {
        return;
    }
    out.push(f("galera.provider_options_readonly", "config", Sev::Info,
        "Provider options change via the config file on MariaDB, not SET GLOBAL",
        "wsrep_provider_options is read-only over SQL on MariaDB (SET GLOBAL fails with \
         ERROR 1238). gcache.size, gcs.fc_limit, gcs.fc_factor and friends move through \
         wsrep_provider_options in my.cnf plus a rolling restart — one node at a time, \
         so the cluster never drops below quorum.",
        None,
        vec![],
        vec!["# under [mysqld], one node at a time:\n# wsrep_provider_options = \"gcache.size=256M; gcs.fc_limit=256\"".into()]));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tuner::collectors::{GaleraInfo, TunerData};
    use std::collections::HashMap;

    /// A healthy 3-node MariaDB Galera baseline — mirrors the live 11.8
    /// cluster's readings (idle, 6 h uptime, rsync SST, 64M gcache).
    fn base() -> TunerData {
        let mut d = TunerData {
            flavor: Flavor::Mariadb,
            major: 11, minor: 8, patch: 8,
            uptime_secs: 22080,
            ..Default::default()
        };
        for (k, v) in [
            ("wsrep_on", "ON"),
            ("wsrep_slave_threads", "1"),
            ("wsrep_sst_method", "rsync"),
            ("wsrep_sst_donor", ""),
            ("wsrep_provider_options", "gcache.size = 64M; gcs.fc_limit = 16; gcs.fc_factor = 1.0; gcs.sync_donor = no"),
        ] {
            d.vars.insert(k.into(), v.into());
        }
        for (k, v) in [
            ("wsrep_cluster_size", "3"),
            ("wsrep_cluster_status", "Primary"),
            ("wsrep_local_state_comment", "Synced"),
            ("wsrep_replicated_bytes", "578103640"),
            ("wsrep_flow_control_paused", "0.000000155482"),
            ("wsrep_flow_control_paused_ns", "3433000"),
            ("wsrep_cert_deps_distance", "2.98193"),
            ("wsrep_local_recv_queue", "0"),
            ("wsrep_local_recv_queue_avg", "0.00934579"),
            ("wsrep_local_bf_aborts", "0"),
            ("wsrep_local_cert_failures", "0"),
        ] {
            d.status.insert(k.into(), v.into());
        }
        d.galera = Some(GaleraInfo {
            provider_options: crate::tuner::collectors::parse_provider_options(
                "gcache.size = 64M; gcs.fc_limit = 16; gcs.fc_factor = 1.0; gcs.sync_donor = no"),
            gcache_size_bytes: Some(64 * MIB),
        });
        d
    }

    fn by_id<'a>(out: &'a [Finding], id: &str) -> Option<&'a Finding> {
        out.iter().find(|f| f.id == id)
    }

    fn run_base(d: &TunerData) -> Vec<Finding> {
        let mut out = Vec::new();
        run(d, &mut out);
        out
    }

    #[test]
    fn no_galera_means_no_findings() {
        let d = TunerData::default(); // galera: None
        assert!(run_base(&d).is_empty());
    }

    #[test]
    fn healthy_cluster_is_quiet_but_present() {
        let out = run_base(&base());
        // size 3 + Synced + Primary → ok; no single-node warning
        assert_eq!(by_id(&out, "galera.cluster_size").unwrap().severity, "ok");
        assert!(by_id(&out, "galera.node_state").is_none(), "Synced/Primary stays silent");
        // flow control at 1.5e-7 → ok, not advice
        assert_eq!(by_id(&out, "galera.flow_control").unwrap().severity, "ok");
        // recv queue avg 0.009 with an empty queue → nothing
        assert!(by_id(&out, "galera.recv_queue_avg").is_none());
        assert!(by_id(&out, "galera.recv_queue").is_none());
        // zero conflicts → nothing
        assert!(by_id(&out, "galera.write_conflicts").is_none());
        // every finding carries the galera. prefix the frontend groups on
        assert!(out.iter().all(|f| f.id.starts_with("galera.")), "{:?}",
            out.iter().map(|f| f.id.clone()).collect::<Vec<_>>());
    }

    #[test]
    fn single_node_primary_is_a_warning() {
        let mut d = base();
        d.status.insert("wsrep_cluster_size".into(), "1".into());
        let out = run_base(&d);
        let f = by_id(&out, "galera.cluster_size").unwrap();
        assert_eq!(f.severity, "warn");
        assert!(f.detail.contains("no redundancy") || f.title.contains("no redundancy"));
    }

    #[test]
    fn two_nodes_is_advice_not_warn() {
        let mut d = base();
        d.status.insert("wsrep_cluster_size".into(), "2".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.cluster_size").unwrap().severity, "advice");
    }

    #[test]
    fn non_primary_component_is_critical() {
        let mut d = base();
        d.status.insert("wsrep_cluster_status".into(), "Non-Primary".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.node_state").unwrap().severity, "critical");
    }

    #[test]
    fn donor_state_is_info_not_warn() {
        let mut d = base();
        d.status.insert("wsrep_local_state_comment".into(), "Donor/Desynced".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.node_state").unwrap().severity, "info");
    }

    #[test]
    fn gcache_window_math_is_the_average_burn() {
        // 64 MiB at 578103640 B / 22080 s ≈ 26 KB/s → ≈42.7 min → advice.
        let out = run_base(&base());
        let f = by_id(&out, "galera.gcache_window").unwrap();
        assert_eq!(f.severity, "advice", "{f:?}");
        assert!(f.title.contains("≈43 min") || f.title.contains("≈42 min"), "{}", f.title);
        assert!(f.detail.contains("64 MiB"), "evidence quotes the size: {}", f.detail);
        // MariaDB: provider options are read-only → config fix, no SET GLOBAL.
        assert!(f.fix_sql.is_empty(), "MariaDB must not offer SET GLOBAL: {:?}", f.fix_sql);
        assert!(f.fix_config.iter().any(|c| c.contains("gcache.size")), "{:?}", f.fix_config);
    }

    #[test]
    fn gcache_window_warns_under_ten_minutes() {
        let mut d = base();
        // 64 MiB at 200 KB/s → ≈5.6 min
        d.status.insert("wsrep_replicated_bytes".into(), (200_000u64 * 22080).to_string());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.gcache_window").unwrap().severity, "warn");
    }

    #[test]
    fn gcache_window_idle_cluster_is_ok() {
        let mut d = base();
        d.status.insert("wsrep_replicated_bytes".into(), "0".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.gcache_window").unwrap().severity, "ok");
    }

    #[test]
    fn pxc_gets_a_set_global_fix_for_gcache() {
        let mut d = base();
        d.flavor = Flavor::Percona;
        let out = run_base(&d);
        let f = by_id(&out, "galera.gcache_window").unwrap();
        assert!(f.fix_sql.iter().any(|s| s.contains("SET GLOBAL wsrep_provider_options")),
            "PXC allows the live SET: {:?}", f.fix_sql);
    }

    #[test]
    fn starved_apply_threads_advise_a_raise() {
        // baseline: deps 2.98 vs 1 thread → advice with a dynamic fix
        let out = run_base(&base());
        let f = by_id(&out, "galera.slave_threads").unwrap();
        assert_eq!(f.severity, "advice");
        assert!(f.fix_sql.iter().any(|s| s.starts_with("SET GLOBAL wsrep_slave_threads")),
            "{:?}", f.fix_sql);

        // deps 8 vs 1 thread → warn
        let mut d = base();
        d.status.insert("wsrep_cert_deps_distance".into(), "8.0".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.slave_threads").unwrap().severity, "warn");
    }

    #[test]
    fn overprovisioned_threads_advise_a_lower() {
        let mut d = base();
        d.vars.insert("wsrep_slave_threads".into(), "32".into());
        d.status.insert("wsrep_cert_deps_distance".into(), "2.0".into());
        let out = run_base(&d);
        let f = by_id(&out, "galera.slave_threads").unwrap();
        assert_eq!(f.severity, "advice");
        assert!(f.detail.contains("idle"), "{}", f.detail);
    }

    #[test]
    fn serial_certification_only_fires_under_real_load() {
        let mut d = base();
        d.status.insert("wsrep_cert_deps_distance".into(), "0.2".into());
        d.status.insert("wsrep_replicated".into(), "5000".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.apply_serial").unwrap().severity, "advice");

        // near-zero deps but no write volume → silent (an idle cluster is not serial-apply risk)
        let mut d = base();
        d.status.insert("wsrep_cert_deps_distance".into(), "0.2".into());
        d.status.insert("wsrep_replicated".into(), "10".into());
        let out = run_base(&d);
        assert!(by_id(&out, "galera.apply_serial").is_none());
    }

    #[test]
    fn flow_control_ladder() {
        for (ratio, sev) in [(0.6, "critical"), (0.2, "warn"), (0.05, "advice"), (0.001, "ok")] {
            let mut d = base();
            d.status.insert("wsrep_flow_control_paused".into(), ratio.to_string());
            let out = run_base(&d);
            let f = by_id(&out, "galera.flow_control").unwrap();
            assert_eq!(f.severity, sev, "ratio {ratio}");
            assert!(f.detail.contains("gcs.fc_limit = 16"), "evidence quotes fc_limit: {}", f.detail);
        }
        // the critical run carries a config fix (provider options → config file)
        let mut d = base();
        d.status.insert("wsrep_flow_control_paused".into(), "0.6".into());
        let out = run_base(&d);
        let f = by_id(&out, "galera.flow_control").unwrap();
        assert!(f.fix_config.iter().any(|c| c.contains("gcs.fc_limit")), "{:?}", f.fix_config);
    }

    #[test]
    fn recv_queue_avg_needs_a_live_queue_to_fire() {
        // hot EWMA + empty current queue = residue from a past catch-up → silent
        let mut d = base();
        d.status.insert("wsrep_local_recv_queue_avg".into(), "3.14".into());
        d.status.insert("wsrep_local_recv_queue".into(), "0".into());
        let out = run_base(&d);
        assert!(by_id(&out, "galera.recv_queue_avg").is_none());

        // same EWMA with events actually queued → advice
        let mut d = base();
        d.status.insert("wsrep_local_recv_queue_avg".into(), "3.14".into());
        d.status.insert("wsrep_local_recv_queue".into(), "5".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.recv_queue_avg").unwrap().severity, "advice");

        // a queue above the warn line fires on its own
        let mut d = base();
        d.status.insert("wsrep_local_recv_queue".into(), "40".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.recv_queue").unwrap().severity, "warn");
    }

    #[test]
    fn write_conflicts_are_rate_based() {
        // 600 conflicts over 6 h ≈ 98/h → warn
        let mut d = base();
        d.status.insert("wsrep_local_bf_aborts".into(), "100".into());
        d.status.insert("wsrep_local_cert_failures".into(), "500".into());
        let out = run_base(&d);
        let f = by_id(&out, "galera.write_conflicts").unwrap();
        assert_eq!(f.severity, "warn");
        assert!(f.detail.contains("bf_aborts") && f.detail.contains("cert_failures"));

        // 3 conflicts over 6 h → advice
        let mut d = base();
        d.status.insert("wsrep_local_cert_failures".into(), "3".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.write_conflicts").unwrap().severity, "advice");
    }

    #[test]
    fn rsync_is_a_tradeoff_not_an_error() {
        let out = run_base(&base());
        let f = by_id(&out, "galera.sst_method").unwrap();
        assert_eq!(f.severity, "info", "rsync is a deliberate choice on many clusters");
        assert_eq!(f.points_lost, 0);
        assert!(f.detail.contains("Donor/Desynced"), "the tradeoff must be named: {}", f.detail);
        assert!(f.detail.contains("mariabackup"), "the alternative must be named: {}", f.detail);
        assert!(f.detail.contains("wsrep_sst_donor"), "donor pinning sanity: {}", f.detail);

        let mut d = base();
        d.vars.insert("wsrep_sst_method".into(), "mariabackup".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.sst_method").unwrap().severity, "ok");

        let mut d = base();
        d.vars.insert("wsrep_sst_method".into(), "mysqldump".into());
        let out = run_base(&d);
        assert_eq!(by_id(&out, "galera.sst_method").unwrap().severity, "advice");
    }

    #[test]
    fn provider_options_readonly_note_is_mariadb_only() {
        let out = run_base(&base());
        assert_eq!(by_id(&out, "galera.provider_options_readonly").unwrap().severity, "info");

        let mut d = base();
        d.flavor = Flavor::Percona;
        let out = run_base(&d);
        assert!(by_id(&out, "galera.provider_options_readonly").is_none());
    }

    #[test]
    fn missing_keys_degrade_silently() {
        // A node where only wsrep_on parsed (minimal build, partial privileges):
        // no finding may be built out of nothing, and nothing may panic.
        let mut d = TunerData { flavor: Flavor::Mariadb, ..Default::default() };
        d.vars.insert("wsrep_on".into(), "ON".into());
        d.galera = Some(GaleraInfo { provider_options: HashMap::new(), gcache_size_bytes: None });
        let out = run_base(&d);
        assert!(out.iter().all(|f| f.id.starts_with("galera.")));
        // only the provider-options note has everything it needs
        assert_eq!(out.len(), 1, "{:?}", out.iter().map(|f| f.id.clone()).collect::<Vec<_>>());
    }
}
