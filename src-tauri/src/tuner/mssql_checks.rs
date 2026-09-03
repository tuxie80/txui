//! SQL Server tuner — the rule set.
//!
//! Each rule turns one collected fact into a ranked Finding with generated,
//! never-executed remediation. Scoring mirrors the other engines (critical 10 /
//! warn 5 / advice 2), so the panel renders SQL Server without branching.
//!
//! ## Why so many rules are about defaults
//!
//! SQL Server's defaults are the oldest TxUI tunes, and several have been wrong
//! since the 1990s and were kept for backwards compatibility. `cost threshold
//! for parallelism` is still 5, a number calibrated on hardware from 1997.
//! `max server memory` is still "everything", which lets the buffer pool starve
//! the operating system it is running on. These are not exotic
//! misconfigurations found on neglected servers — they are what a fresh install
//! has, which is exactly what a tuner exists to say out loud.
//!
//! ## What is deliberately not here
//!
//! No rule fires on a fact that was not readable. A denied DMV or a missing
//! `msdb` yields `None`, and `None` produces no finding — reporting "no
//! backups" because the backup history could not be read would be worse than
//! saying nothing, because it is the kind of wrong that gets acted on.

use super::mssql_collectors::MssqlData;
use super::{EolInfo, Finding, Sev};

/// SQL Server has no configuration file to edit — everything is `sp_configure`
/// or `ALTER DATABASE` — so `fix_config` is always empty and this thin adapter
/// keeps the call sites from repeating an empty vec.
fn f(
    id: &str, category: &str, sev: Sev,
    title: impl Into<String>, detail: impl Into<String>,
    recommendation: Option<String>, fix_sql: Vec<String>,
) -> Finding {
    super::f(id, category, sev, title, detail, recommendation, fix_sql, vec![])
}

/// Bracket-quote a database name for the generated remediation.
fn q(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

/// `sp_configure` needs the option enabled, set and reconfigured — three
/// statements, and leaving any of them out produces something that looks like
/// it worked and did not.
fn sp_configure(option: &str, value: i64) -> Vec<String> {
    vec![
        "EXEC sp_configure 'show advanced options', 1; RECONFIGURE;".into(),
        format!("EXEC sp_configure '{option}', {value}; RECONFIGURE;"),
    ]
}

pub fn run_checks(d: &MssqlData, eol: Option<&EolInfo>) -> Vec<Finding> {
    let mut out = Vec::new();

    // ── 1. max server memory ─────────────────────────────────────────────
    // The default is 2147483647 MB — "all of it". The buffer pool then grows
    // until Windows or Linux starts reclaiming, and the OS and SQL Server end
    // up fighting over the same pages. This is the single most common
    // misconfiguration on an unattended instance.
    let max_mem = d.cfg("max server memory (mb)", 2147483647);
    if d.physical_memory_mb > 0 {
        if max_mem >= 2147483647 {
            // Leave the OS the larger of 1 GB or 10%, then round to 128 MB —
            // the shape Microsoft's own guidance takes, computed from THIS
            // machine rather than quoted as a rule of thumb.
            let reserve = (d.physical_memory_mb / 10).max(1024);
            let suggest = ((d.physical_memory_mb - reserve) / 128 * 128).max(1024);
            out.push(f(
                "mssql.memory.unbounded", "performance", Sev::Critical,
                "max server memory is unlimited",
                format!("The instance may use all {} MB of physical memory. The buffer pool \
                         grows until the operating system starts reclaiming pages, and then \
                         the two compete for the same memory — which shows up as unexplained \
                         stalls rather than as an out-of-memory error.",
                        d.physical_memory_mb),
                Some(format!("Cap it at {suggest} MB, leaving {reserve} MB for the OS, the \
                              filesystem cache and anything else on this host. It takes effect \
                              immediately and needs no restart.")),
                sp_configure("max server memory (MB)", suggest),
            ));
        } else if max_mem > d.physical_memory_mb {
            out.push(f(
                "mssql.memory.over-physical", "performance", Sev::Warn,
                "max server memory exceeds physical memory",
                format!("The cap is {max_mem} MB on a machine with {} MB. It is not a cap at \
                         all — the setting is doing nothing.", d.physical_memory_mb),
                Some("Set it below physical memory, leaving room for the OS.".into()),
                sp_configure("max server memory (MB)",
                    ((d.physical_memory_mb - (d.physical_memory_mb / 10).max(1024)) / 128 * 128).max(1024)),
            ));
        }
    }

    // ── 2. cost threshold for parallelism ────────────────────────────────
    // Default 5, unchanged since SQL Server 7 and calibrated on 1997 hardware.
    // At 5 almost every non-trivial query goes parallel, including ones that
    // finish faster on one core — the coordination costs more than the work.
    let ctfp = d.cfg("cost threshold for parallelism", 5);
    if ctfp <= 5 {
        out.push(f(
            "mssql.parallelism.threshold", "performance", Sev::Warn,
            "cost threshold for parallelism is still the 1997 default",
            format!("It is {ctfp}. Any query the optimiser costs above that goes parallel, \
                     which at 5 means almost all of them — including short queries where \
                     splitting the work across cores costs more than doing it on one, and \
                     shows up as CXPACKET/CXCONSUMER waits."),
            Some("50 is the widely used starting point; raise it further if parallel waits \
                  stay high. It applies to new plans immediately and needs no restart.".into()),
            sp_configure("cost threshold for parallelism", 50),
        ));
    }

    // ── 3. MAXDOP ────────────────────────────────────────────────────────
    // 0 means "use every scheduler". On a many-core machine that hands one
    // query the whole box.
    let maxdop = d.cfg("max degree of parallelism", 0);
    if maxdop == 0 && d.cpu_count >= 8 {
        // Microsoft's guidance: up to 8 for a single NUMA node. Without NUMA
        // topology in hand, the conservative 8 is right for anything larger.
        let suggest = d.cpu_count.min(8);
        out.push(f(
            "mssql.parallelism.maxdop", "performance", Sev::Warn,
            "MAXDOP is unlimited on a many-core machine",
            format!("max degree of parallelism is 0 with {} logical processors, so one query \
                     can take every scheduler. Under concurrency they queue behind each other \
                     instead of running side by side.", d.cpu_count),
            Some(format!("Set it to {suggest}. A single query can still ask for less with \
                          OPTION (MAXDOP n), and this is the ceiling rather than a target.")),
            sp_configure("max degree of parallelism", suggest),
        ));
    }

    // ── 4. optimize for ad hoc workloads ─────────────────────────────────
    // Only fires when there is evidence: single-use plans actually taking up
    // memory. The setting is harmless but a finding with no measurement behind
    // it is noise.
    let (single_use, single_mb) = d.adhoc_single_use();
    if d.cfg("optimize for ad hoc workloads", 0) == 0 && single_use >= 50 && single_mb >= 50 {
        out.push(f(
            "mssql.plancache.adhoc", "performance", Sev::Advice,
            "The plan cache is full of plans used once",
            format!("{single_use} ad-hoc plans have been used exactly once and hold about \
                     {single_mb} MB. That memory is not available to the buffer pool, and \
                     none of those plans will be reused."),
            Some("`optimize for ad hoc workloads` stores a small stub on first execution and \
                  the full plan only on the second, so single-use statements stop costing \
                  cache. It is safe to turn on and takes effect immediately.".into()),
            sp_configure("optimize for ad hoc workloads", 1),
        ));
    }

    // ── 5. tempdb data files ─────────────────────────────────────────────
    // One file serialises allocation-bitmap contention on a busy instance.
    // 2016+ creates several automatically, so a single file means someone
    // installed it long ago or built the container by hand.
    if d.tempdb_files == 1 && d.cpu_count >= 4 {
        let suggest = d.cpu_count.min(8);
        out.push(f(
            "mssql.tempdb.files", "performance", Sev::Warn,
            "tempdb has a single data file",
            format!("One data file on a machine with {} logical processors. Every session \
                     that needs tempdb space contends on the same allocation pages, which \
                     shows up as PAGELATCH_UP waits on 2:1:1 and looks like a storage \
                     problem when it is not.", d.cpu_count),
            Some(format!("Add files until there are {suggest}, all the same size and with the \
                          same growth increment — uneven files defeat the proportional-fill \
                          algorithm that makes this work. Requires a restart to rebalance.")),
            vec![format!("-- Repeat until tempdb has {suggest} data files, all equal in size:\n\
                          ALTER DATABASE tempdb ADD FILE (NAME = N'tempdev2', \
                          FILENAME = N'<same folder as tempdev>', SIZE = {}MB, FILEGROWTH = 64MB);",
                         d.tempdb_max_mb.max(64))],
        ));
    } else if d.tempdb_files > 1 && d.tempdb_min_mb != d.tempdb_max_mb {
        out.push(f(
            "mssql.tempdb.uneven", "performance", Sev::Advice,
            "tempdb files are different sizes",
            format!("{} data files ranging from {} MB to {} MB. SQL Server fills them \
                     proportionally to free space, so the largest file takes most of the \
                     traffic and the contention the extra files were added to spread \
                     stays concentrated.",
                    d.tempdb_files, d.tempdb_min_mb, d.tempdb_max_mb),
            Some("Size them equally. Growing the small ones is safe; shrinking the large one \
                  needs a quiet moment.".into()),
            vec![format!("ALTER DATABASE tempdb MODIFY FILE (NAME = N'<each file>', SIZE = {}MB);",
                         d.tempdb_max_mb)],
        ));
    }

    // ── 6. backups ───────────────────────────────────────────────────────
    // The most consequential rules here. A database with no full backup has no
    // recovery path at all; a FULL-recovery database with no log backup grows
    // its log until the disk fills, which is the commonest way a SQL Server
    // stops serving.
    for db in &d.databases {
        if db.state != "ONLINE" { continue; }
        match db.full_backup_age_days {
            None => out.push(f(
                "mssql.backup.never", "resilience", Sev::Critical,
                format!("{} has never been backed up", db.name),
                format!("`msdb` has no full backup recorded for {}. There is no point to \
                         restore to — not an old one, none.", db.name),
                Some("Take a full backup now, then schedule one. If backups are taken by a \
                      tool that does not write to msdb, this finding is a false alarm and \
                      worth confirming either way.".into()),
                vec![format!("BACKUP DATABASE {} TO DISK = N'<path>\\{}.bak' \
                              WITH INIT, CHECKSUM, COMPRESSION;", q(&db.name), db.name)],
            )),
            Some(age) if age > 7 => out.push(f(
                "mssql.backup.stale", "resilience", Sev::Critical,
                format!("{}'s last full backup is {} days old", db.name, age),
                format!("The most recent full backup finished {} ({} days ago). Everything \
                         since then depends on log backups existing and being findable.",
                        db.last_full_backup, age),
                Some("Take a full backup and check why the schedule stopped.".into()),
                vec![format!("BACKUP DATABASE {} TO DISK = N'<path>\\{}.bak' \
                              WITH INIT, CHECKSUM, COMPRESSION;", q(&db.name), db.name)],
            )),
            Some(age) if age > 1 => out.push(f(
                "mssql.backup.aging", "resilience", Sev::Warn,
                format!("{}'s last full backup is {} days old", db.name, age),
                format!("Most recent full backup: {}.", db.last_full_backup),
                Some("Confirm the schedule is running.".into()),
                vec![],
            )),
            _ => {}
        }

        // FULL recovery with no log backup: the log can never truncate.
        if db.recovery_model == "FULL" && db.last_log_backup.is_empty() {
            out.push(f(
                "mssql.recovery.no-log-backup", "resilience", Sev::Critical,
                format!("{} is in FULL recovery with no log backups", db.name),
                format!("In FULL recovery the transaction log is only truncated by a log \
                         backup, and {} has never had one. The log will grow until the disk \
                         is full, and until then the point-in-time recovery FULL exists to \
                         provide is not actually available.", db.name),
                Some("Either schedule log backups — which is what FULL is for — or switch to \
                      SIMPLE recovery if point-in-time restore is not needed. Doing neither \
                      is the one combination that has the costs of both.".into()),
                vec![
                    format!("-- Either: back the log up on a schedule\n\
                             BACKUP LOG {} TO DISK = N'<path>\\{}_log.trn' WITH COMPRESSION;",
                            q(&db.name), db.name),
                    format!("-- Or: stop paying for what is not being used\n\
                             ALTER DATABASE {} SET RECOVERY SIMPLE;", q(&db.name)),
                ],
            ));
        }
    }

    // ── 7. AUTO_SHRINK and AUTO_CLOSE ────────────────────────────────────
    // The two settings whose names sound helpful and are not.
    for db in &d.databases {
        if db.auto_shrink {
            out.push(f(
                "mssql.db.auto-shrink", "performance", Sev::Critical,
                format!("{} has AUTO_SHRINK on", db.name),
                "Shrinking moves pages to the front of the file, which fragments every index \
                 it touches. The file then grows again — because the workload that filled it \
                 has not changed — and shrinks again, fragmenting further each time. It is a \
                 loop that spends I/O to make queries slower.".to_string(),
                Some("Turn it off. If the file genuinely needs to be smaller, shrink it once, \
                      deliberately, and rebuild the indexes afterwards.".into()),
                vec![format!("ALTER DATABASE {} SET AUTO_SHRINK OFF;", q(&db.name))],
            ));
        }
        if db.auto_close {
            out.push(f(
                "mssql.db.auto-close", "performance", Sev::Warn,
                format!("{} has AUTO_CLOSE on", db.name),
                "The database is shut down when the last user disconnects and reopened on the \
                 next connection, discarding its cached plans and buffer pages each time. On \
                 anything but a rarely-touched database this turns the first query after every \
                 idle period into a cold start."
                    .to_string(),
                Some("Turn it off unless this is a desktop-style database that is genuinely \
                      idle most of the time.".into()),
                vec![format!("ALTER DATABASE {} SET AUTO_CLOSE OFF;", q(&db.name))],
            ));
        }
        if db.page_verify != "CHECKSUM" && !db.page_verify.is_empty() {
            out.push(f(
                "mssql.db.page-verify", "resilience", Sev::Warn,
                format!("{} uses page verify {}", db.name, db.page_verify),
                format!("Page verification is {} rather than CHECKSUM. Storage corruption \
                         that CHECKSUM would catch on the next read goes undetected until \
                         something else notices — which is usually a restore that does not \
                         work.", db.page_verify),
                Some("Set it to CHECKSUM. It applies to pages as they are next written, so \
                      the protection arrives gradually; a full DBCC CHECKDB confirms what is \
                      there now.".into()),
                vec![format!("ALTER DATABASE {} SET PAGE_VERIFY CHECKSUM;", q(&db.name))],
            ));
        }
    }

    // ── 8. percent autogrowth ────────────────────────────────────────────
    // A percentage grows in ever-larger steps: each growth takes longer than
    // the last, and on a log file every growth also adds VLFs.
    for file in &d.files {
        if file.is_percent_growth {
            out.push(f(
                "mssql.file.percent-growth", "performance", Sev::Warn,
                format!("{}.{} grows by percentage", file.database, file.name),
                format!("The file grows in {}% steps from {} MB. Each growth is larger than \
                         the last, so the pauses get longer as the database gets bigger — and \
                         on a log file every growth also adds virtual log files.",
                        file.growth, file.size_mb),
                Some("Use a fixed increment sized for the file: 64–256 MB for a log, larger \
                      for data. Fixed steps stay predictable however large the file gets.".into()),
                vec![format!(
                    "ALTER DATABASE {} MODIFY FILE (NAME = N'{}', FILEGROWTH = {}MB);",
                    q(&file.database), file.name.replace('\'', "''"),
                    if file.file_type == "LOG" { 128 } else { 256 })],
            ));
        } else if file.growth > 0 && file.growth * 8 / 1024 < 16 && file.size_mb > 1024 {
            // Growth is in pages (8 KB) when not a percentage.
            out.push(f(
                "mssql.file.small-growth", "performance", Sev::Advice,
                format!("{}.{} grows in small steps", file.database, file.name),
                format!("A {} MB file growing {} MB at a time will autogrow constantly, and \
                         every growth is a pause for whatever triggered it.",
                        file.size_mb, file.growth * 8 / 1024),
                Some("Raise the increment so growth is occasional rather than continuous.".into()),
                vec![format!(
                    "ALTER DATABASE {} MODIFY FILE (NAME = N'{}', FILEGROWTH = 256MB);",
                    q(&file.database), file.name.replace('\'', "''"))],
            ));
        }
    }

    // ── 9. VLF count ─────────────────────────────────────────────────────
    // Thousands of virtual log files slow recovery and log backups, and are
    // almost always the fossil record of percentage autogrowth.
    for (db, vlfs) in &d.vlf_counts {
        if *vlfs > 1000 {
            out.push(f(
                "mssql.log.vlf-high", "performance", Sev::Warn,
                format!("{db} has {vlfs} virtual log files"),
                format!("The transaction log is divided into {vlfs} VLFs. Recovery, log \
                         backups and replication all walk that list, so startup after a \
                         restart or a failover takes proportionally longer."),
                Some("Back up the log, shrink it, then grow it back in a few large steps — \
                      each growth creates a bounded number of VLFs, so a handful of big \
                      steps leaves far fewer than hundreds of small ones.".into()),
                vec![format!(
                    "-- With the database quiet:\n\
                     BACKUP LOG {} TO DISK = N'<path>\\{}_log.trn';\n\
                     DBCC SHRINKFILE (N'<log file name>', 0);\n\
                     ALTER DATABASE {} MODIFY FILE (NAME = N'<log file name>', SIZE = 8GB);",
                    q(db), db, q(db))],
            ));
        }
    }

    // ── 10. backup compression ───────────────────────────────────────────
    if d.cfg("backup compression default", 0) == 0 {
        out.push(f(
            "mssql.backup.compression", "resilience", Sev::Advice,
            "Backups are not compressed by default",
            "Backup compression typically halves both the size and the time, at some CPU \
             during the backup. It is available in every supported edition."
                .to_string(),
            Some("Turn it on as the default; an individual backup can still override it.".into()),
            sp_configure("backup compression default", 1),
        ));
    }

    // ── 11. dedicated admin connection ───────────────────────────────────
    if d.cfg("remote admin connections", 0) == 0 {
        out.push(f(
            "mssql.dac.disabled", "resilience", Sev::Advice,
            "The dedicated admin connection is local-only",
            "The DAC is the reserved connection that still works when the instance is too \
             busy to accept a normal one. With remote DAC off it can only be used from the \
             server's own console — which is exactly where nobody is when it is needed."
                .to_string(),
            Some("Enable remote admin connections. It listens on a separate port and still \
                  requires sysadmin, so it adds a way in for the person who already has \
                  every other one.".into()),
            sp_configure("remote admin connections", 1),
        ));
    }

    // ── 12. instant file initialization ──────────────────────────────────
    // Only when it was actually readable — see the collector's note.
    if d.instant_file_init == Some(false) {
        out.push(f(
            "mssql.ifi.disabled", "performance", Sev::Warn,
            "Instant file initialization is off",
            "Data files are zero-filled before use, so every growth and every restore blocks \
             for as long as it takes to write zeros over the whole new extent. On a large \
             file that is minutes during which nothing else happens."
                .to_string(),
            Some("Grant the service account 'Perform volume maintenance tasks' (Windows) or \
                  the equivalent capability, then restart the instance. Log files are always \
                  zeroed regardless — this only affects data files.".into()),
            vec![],
        ));
    }

    // ── 13. compatibility level ──────────────────────────────────────────
    // A database still on an old compatibility level does not get the current
    // cardinality estimator or query-processing features, whatever version the
    // engine is.
    let engine_level = match d.product_version.split('.').next().unwrap_or("") {
        "16" => 160, "15" => 150, "14" => 140, "13" => 130, _ => 0,
    };
    for db in &d.databases {
        if engine_level > 0 && db.compatibility_level > 0 && db.compatibility_level < engine_level - 10 {
            out.push(f(
                "mssql.db.compat-level", "performance", Sev::Advice,
                format!("{} runs at compatibility level {}", db.name, db.compatibility_level),
                format!("The instance is level {engine_level}; this database is pinned to {}. \
                         It is running an older cardinality estimator and misses query \
                         processing improvements shipped since.", db.compatibility_level),
                Some("Raising the level changes plans, so it is not a silent upgrade — with \
                      Query Store on you can raise it and compare, and force the old plan for \
                      anything that regresses. That is what Query Store is for.".into()),
                vec![format!("ALTER DATABASE {} SET COMPATIBILITY_LEVEL = {engine_level};", q(&db.name))],
            ));
        }

        // Query Store is how a plan regression gets diagnosed after the fact.
        if !db.query_store_on && engine_level >= 130 {
            out.push(f(
                "mssql.db.query-store-off", "performance", Sev::Advice,
                format!("Query Store is off for {}", db.name),
                "Query Store records every plan and its runtime history, which is the only \
                 way to answer \"this was fast last week\" after the fact. Without it, a plan \
                 regression leaves no evidence once the plan ages out of cache."
                    .to_string(),
                Some("Turn it on in READ_WRITE. It costs a small amount of write overhead and \
                      a bounded amount of space, and it is what makes a compatibility-level \
                      change safe to try.".into()),
                vec![format!(
                    "ALTER DATABASE {} SET QUERY_STORE = ON;\n\
                     ALTER DATABASE {} SET QUERY_STORE (OPERATION_MODE = READ_WRITE);",
                    q(&db.name), q(&db.name))],
            ));
        }
    }

    // ── 14. indexes the optimiser asked for ──────────────────────────────
    //
    // SQL Server is the only engine here that TELLS you which index it wanted,
    // with its own estimate of the improvement. That makes this the most
    // actionable finding in the set — and the easiest to act on badly, which is
    // why the wording matters more than usual.
    //
    // The suggestions are per-query and naive: they are not merged with each
    // other, not checked against the indexes that already exist, and reset when
    // the service restarts. Applying the whole list is how a table ends up with
    // forty overlapping indexes that make every write slower.
    const INDEX_STATS_MIN_UPTIME: u64 = 6 * 3600;
    if d.index_stats_age_secs >= INDEX_STATS_MIN_UPTIME {
        for (i, mi) in d.missing_indexes.iter().take(5).enumerate() {
            let sev = if i == 0 && mi.impact > 1000.0 { Sev::Warn } else { Sev::Advice };
            out.push(f(
                "mssql.index.missing", "performance", sev,
                format!("{} wants an index on {}", mi.object,
                        if mi.equality.is_empty() { &mi.inequality } else { &mi.equality }),
                format!("The optimiser estimates {:.0}% less cost for the queries that wanted \
                         it, over {} seek(s) and {} scan(s) since startup. Equality columns: \
                         {}. Range columns: {}. Covering columns: {}.",
                        mi.avg_impact_pct,
                        mi.seeks, mi.scans,
                        if mi.equality.is_empty() { "none" } else { &mi.equality },
                        if mi.inequality.is_empty() { "none" } else { &mi.inequality },
                        if mi.included.is_empty() { "none" } else { &mi.included }),
                Some("Read it before you run it. These suggestions are PER QUERY: they are not \
                      merged with each other, not compared against the indexes that already \
                      exist, and the column order is the optimiser's for one query rather than \
                      the best order for your workload. Applying a whole list is how a table \
                      ends up with a dozen overlapping indexes that slow every write. Check \
                      whether an existing index already leads with these columns first."
                    .into()),
                vec![mi.create_sql()],
            ));
        }

        // ── 15. indexes that only cost ───────────────────────────────────
        for ui in d.unused_indexes.iter().take(5) {
            out.push(f(
                "mssql.index.unused", "performance", Sev::Advice,
                format!("{}.{} has served no reads and {} writes",
                        ui.object, ui.index, ui.writes),
                format!("Since the last restart this index has answered zero seeks, scans and \
                         lookups, while being maintained through {} write(s){}. Every INSERT, \
                         UPDATE and DELETE on {} pays for it and nothing reads it back.",
                        ui.writes,
                        if ui.size_mb > 0 { format!(" and occupying {} MB", ui.size_mb) }
                        else { String::new() },
                        ui.object),
                Some("Disable it before dropping it — `ALTER INDEX … DISABLE` keeps the \
                      definition, so putting it back is a REBUILD rather than remembering what \
                      it was. Check first that it does not exist for a monthly or quarterly \
                      job: these counters only go back to the last service restart."
                    .into()),
                vec![
                    format!("ALTER INDEX [{}] ON {} DISABLE;", ui.index, ui.object),
                    format!("-- …and once you are sure:\n-- DROP INDEX [{}] ON {};",
                            ui.index, ui.object),
                ],
            ));
        }
    } else if !d.missing_indexes.is_empty() || !d.unused_indexes.is_empty() {
        // Reporting an index as unused after twenty minutes of uptime is
        // technically true and practically a lie.
        out.push(f(
            "mssql.index.too-soon", "config", Sev::Info,
            "Index usage statistics are too young to judge",
            format!("The instance has been up for {} minutes. `dm_db_index_usage_stats` and \
                     the missing-index DMVs are cumulative since startup, so an index looks \
                     unused simply because nothing has needed it yet, and a missing-index \
                     suggestion reflects a handful of queries rather than the workload.",
                    d.index_stats_age_secs / 60),
            Some("Re-run after the server has seen a representative period — including any \
                  weekly or monthly job.".into()),
            vec![],
        ));
    }

    // ── 16. end of life ──────────────────────────────────────────────────
    if let Some(e) = eol {
        match e.status.as_str() {
            "eol" => out.push(f(
                "mssql.version.eol", "security", Sev::Critical,
                format!("SQL Server {} is out of support", e.cycle),
                format!("Mainstream and extended support ended {}. No security updates are \
                         published for it.",
                        e.eol_date.clone().unwrap_or_else(|| "(date unknown)".into())),
                Some("Plan an upgrade. Extended Security Updates buy time on Azure, but they \
                      are a runway, not a destination.".into()),
                vec![],
            )),
            "eol-soon" => out.push(f(
                "mssql.version.eol-soon", "resilience", Sev::Warn,
                format!("SQL Server {} reaches end of support soon", e.cycle),
                format!("Support ends {}.", e.eol_date.clone().unwrap_or_default()),
                Some("Schedule the upgrade now — an in-place major upgrade needs a \
                      maintenance window and a tested rollback.".into()),
                vec![],
            )),
            _ => {}
        }
    }

    // ── 17. uptime ───────────────────────────────────────────────────────
    // Not a problem, but the caveat every other finding depends on: the plan
    // cache and wait statistics say nothing yet.
    if d.uptime_secs < 3600 {
        out.push(f(
            "mssql.uptime.short", "config", Sev::Info,
            "The instance restarted recently",
            format!("Up for {} minutes. The plan cache, wait statistics and index usage \
                     counters were all reset by the restart, so anything above that reasons \
                     from them is measuring a warm-up rather than the workload.",
                    d.uptime_secs / 60),
            None, vec![],
        ));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::super::mssql_collectors::MissingIndex;

    fn mi(eq: &str, ineq: &str, incl: &str) -> MissingIndex {
        MissingIndex {
            object: "sales.orders".into(),
            equality: eq.into(), inequality: ineq.into(), included: incl.into(),
            impact: 100.0, avg_impact_pct: 90.0, seeks: 10, scans: 0,
        }
    }

    #[test]
    fn the_generated_index_puts_equality_columns_first() {
        // The order is not cosmetic: an index leads with the columns a query
        // can SEEK on, and a range column after them still narrows. Reversed,
        // the equality predicate cannot use the index at all.
        let sql = mi("[status]", "[total]", "").create_sql();
        assert!(sql.contains("([status], [total])"), "{sql}");
    }

    #[test]
    fn included_columns_go_in_INCLUDE_not_in_the_key() {
        // A covering column in the key makes the index wider and no more
        // seekable — INCLUDE stores it at the leaf only.
        let sql = mi("[status]", "", "[total]").create_sql();
        assert!(sql.contains("([status]) INCLUDE ([total])"), "{sql}");
    }

    #[test]
    fn the_dmv_column_lists_are_used_verbatim_not_requoted() {
        // They arrive already bracket-quoted; quoting them again would emit
        // [[status]] and the statement would not run.
        let sql = mi("[status]", "", "").create_sql();
        assert!(!sql.contains("[[") && !sql.contains("]]"), "{sql}");
        assert!(sql.starts_with("CREATE NONCLUSTERED INDEX "), "{sql}");
        assert!(sql.ends_with(';'), "{sql}");
    }

    #[test]
    fn the_name_reads_back_to_the_columns_it_covers() {
        let sql = mi("[currency]", "[total]", "").create_sql();
        assert!(sql.contains("[ix_orders_currency_total]"), "{sql}");
    }

    #[test]
    fn an_inequality_only_suggestion_still_produces_a_key() {
        // `equality_columns` is NULL when the query only had a range predicate.
        let sql = mi("", "[total]", "").create_sql();
        assert!(sql.contains("([total])"), "{sql}");
        assert!(!sql.contains("(, "), "{sql}");
    }
}
