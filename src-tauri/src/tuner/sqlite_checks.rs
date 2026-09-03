//! SQLite tuner — the rule set.
//!
//! Each rule turns one collected fact into a ranked Finding with generated,
//! never-executed maintenance SQL. Scoring mirrors the other engines
//! (critical 10 / warn 5 / advice 2), so the panel renders SQLite without
//! branching. Categories map to the same three score buckets: "performance",
//! "resilience" (durability / integrity), "config", "schema".

use super::Finding;
use super::sqlite_collectors::SqliteData;

const MIB: u64 = 1024 * 1024;

use super::Sev;

/// SQLite findings carry no config-file fixes (there is no server config) —
/// a thin adapter over the shared constructor (super::f).
fn f(
    id: &str, category: &str, sev: Sev,
    title: impl Into<String>, detail: impl Into<String>,
    recommendation: Option<String>, fix_sql: Vec<String>,
) -> Finding {
    super::f(id, category, sev, title, detail, recommendation, fix_sql, vec![])
}

use super::fmt_bytes;

pub fn run_checks(d: &SqliteData) -> Vec<Finding> {
    let mut out = Vec::new();

    // 1. Freelist bloat — the one thing VACUUM actually fixes. Both a fraction
    //    and an absolute floor, so a small file with a big free ratio and a
    //    huge file with a modest ratio both surface, but a tiny file doesn't
    //    nag over a few KiB.
    let frac = d.freelist_frac();
    let free = d.freelist_bytes();
    if free >= 8 * MIB && frac >= 0.25 {
        out.push(f(
            "sqlite.freelist.high", "performance", Sev::Warn,
            "File is carrying a lot of free space",
            format!("{} of {} ({:.0}%) is on the freelist — dead pages left behind by \
                     deletes and updates. They inflate every full scan and the file on disk.",
                    fmt_bytes(free), fmt_bytes(d.size_bytes()), frac * 100.0),
            Some("VACUUM rewrites the file without the free pages. It takes an exclusive \
                  lock and needs free disk equal to the file size while it runs.".into()),
            vec!["VACUUM;".into()],
        ));
    } else if free >= MIB && frac >= 0.10 {
        out.push(f(
            "sqlite.freelist.moderate", "performance", Sev::Advice,
            "Some reclaimable free space",
            format!("{} ({:.0}%) is on the freelist.", fmt_bytes(free), frac * 100.0),
            Some("VACUUM reclaims it; on a busy file, INCREMENTAL auto_vacuum reclaims \
                  gradually without a full rewrite.".into()),
            vec!["VACUUM;".into()],
        ));
    }

    // 2. auto_vacuum mode — NONE means the freelist only ever grows until a
    //    manual VACUUM. INCREMENTAL is the low-impact middle ground.
    match d.auto_vacuum {
        0 => out.push(f(
            "sqlite.autovacuum.none", "config", Sev::Advice,
            "auto_vacuum is NONE",
            "Free pages are never returned to the OS on their own; the file only shrinks \
             on an explicit VACUUM.",
            Some("Switch to INCREMENTAL, then reclaim in bounded steps with \
                  PRAGMA incremental_vacuum. Changing the mode requires a one-time VACUUM.".into()),
            vec!["PRAGMA auto_vacuum = INCREMENTAL;".into(), "VACUUM;".into()],
        )),
        2 => out.push(f(
            "sqlite.autovacuum.incremental", "config", Sev::Ok,
            "auto_vacuum is INCREMENTAL",
            "Free pages can be reclaimed in bounded steps without a full rewrite.",
            None, vec![],
        )),
        _ => {}
    }

    // 3. Page size — the modern default is 4096; a file built with 512/1024
    //    does more I/O per row. Only changeable by a VACUUM after the PRAGMA.
    if d.page_size > 0 && d.page_size < 4096 {
        out.push(f(
            "sqlite.pagesize.small", "performance", Sev::Advice,
            format!("Small page size ({} B)", d.page_size),
            "A page size below 4096 B increases the number of pages — and page reads — \
             for the same data.",
            Some("Rebuild with a 4096 B page: set the PRAGMA, then VACUUM.".into()),
            vec!["PRAGMA page_size = 4096;".into(), "VACUUM;".into()],
        ));
    }

    // 4. Journalling / durability of this connection. WAL is the app default
    //    and the right answer for almost every desktop workload.
    match d.journal_mode.as_str() {
        "wal" => out.push(f(
            "sqlite.journal.wal", "resilience", Sev::Ok,
            "Journal mode is WAL",
            "Write-ahead logging: readers don't block the writer, and vice versa.",
            None, vec![],
        )),
        "off" => out.push(f(
            "sqlite.journal.off", "resilience", Sev::Critical,
            "Journalling is OFF",
            "With journal_mode = OFF there is no rollback journal: a crash or power loss \
             mid-write can corrupt the database.",
            Some("Use WAL (or at least DELETE) unless this is a throwaway file.".into()),
            vec!["PRAGMA journal_mode = WAL;".into()],
        )),
        other if !other.is_empty() => out.push(f(
            "sqlite.journal.rollback", "resilience", Sev::Advice,
            format!("Rollback journal mode ({})", other.to_uppercase()),
            "A classic rollback journal is safe but makes readers and the writer \
             contend more than WAL does.",
            Some("WAL lets reads and writes proceed concurrently.".into()),
            vec!["PRAGMA journal_mode = WAL;".into()],
        )),
        _ => {}
    }

    // 5. synchronous = OFF is a real durability hole (this connection).
    if d.synchronous == 0 {
        out.push(f(
            "sqlite.synchronous.off", "resilience", Sev::Warn,
            "synchronous is OFF",
            "With synchronous = OFF, SQLite does not wait for writes to reach disk — a \
             power loss can corrupt the file, not just lose the last transaction.",
            Some("NORMAL is the safe default under WAL; FULL is safest.".into()),
            vec!["PRAGMA synchronous = NORMAL;".into()],
        ));
    }

    // 6. Integrity. The collector ran quick_check (it reads the whole file,
    //    but the report is user-invoked); only a failed probe falls back to
    //    the one-click suggestion.
    match &d.quick_check {
        Some(rows) if rows.iter().all(|r| r == "ok") => out.push(f(
            "sqlite.integrity.ok", "resilience", Sev::Ok,
            "Integrity check passed",
            "quick_check verified every page and index is internally consistent.",
            None, vec![],
        )),
        Some(rows) => out.push(f(
            "sqlite.integrity.corrupt", "resilience", Sev::Critical,
            "Integrity check FAILED",
            format!("quick_check reported: {}. The file is damaged; do not write to it \
                     until it is recovered.", rows.join("; ")),
            Some("Dump what is readable into a new file (.dump | sqlite3 new.db), or \
                  restore from backup. integrity_check gives the full error list.".into()),
            vec!["PRAGMA integrity_check;".into()],
        )),
        None => out.push(f(
            "sqlite.integrity.check", "resilience", Sev::Info,
            "Verify structural integrity",
            format!("This file is {}. The automatic quick_check did not run; SQLite can \
                     still verify every page and index is internally consistent — worth \
                     doing after a crash, a bad copy, or flaky storage.",
                    fmt_bytes(d.size_bytes())),
            Some("quick_check is fast and catches most damage; integrity_check is \
                  exhaustive but reads the whole file.".into()),
            vec!["PRAGMA quick_check;".into(), "PRAGMA integrity_check;".into(),
                 "PRAGMA foreign_key_check;".into()],
        )),
    }

    // 7. Planner statistics. Without ANALYZE the query planner chooses plans
    //    from built-in guesses; sqlite_stat1 missing entirely means it has
    //    never been run on this file.
    match &d.analyzed_tables {
        None if !d.user_tables.is_empty() => out.push(f(
            "sqlite.analyze.never", "performance", Sev::Advice,
            "ANALYZE has never been run",
            "There is no sqlite_stat1 table, so the query planner is choosing every \
             plan from built-in guesses.",
            Some("Run ANALYZE once and after large data changes; it records table and \
                  index statistics the planner uses to pick indexes and join order.".into()),
            vec!["ANALYZE;".into()],
        )),
        Some(analyzed) => {
            let missing: Vec<&String> = d.user_tables.iter()
                .filter(|t| !analyzed.contains(t)).collect();
            if !missing.is_empty() {
                out.push(f(
                    "sqlite.analyze.stale", "performance", Sev::Advice,
                    format!("{} of {} tables have no planner statistics",
                            missing.len(), d.user_tables.len()),
                    format!("Never analyzed since the last ANALYZE run: {}.",
                            join_names(&missing)),
                    Some("Run ANALYZE to refresh statistics for every table.".into()),
                    vec!["ANALYZE;".into()],
                ));
            } else if !d.user_tables.is_empty() {
                out.push(f(
                    "sqlite.analyze.ok", "performance", Sev::Ok,
                    "Planner statistics are current",
                    "Every table has a row in sqlite_stat1.",
                    None, vec![],
                ));
            }
        }
        _ => {}
    }

    // 8. Unindexed foreign keys — the classic SQLite performance bug. With FK
    //    enforcement ON (this app turns it on) every parent DELETE or key
    //    UPDATE scans the whole child table.
    if !d.unindexed_fks.is_empty() {
        let shown: Vec<String> = d.unindexed_fks.iter().take(5)
            .map(|(child, col, parent)| format!("{child}.{col} → {parent}")).collect();
        let more = if d.unindexed_fks.len() > 5 {
            format!(" (+ {} more)", d.unindexed_fks.len() - 5)
        } else { String::new() };
        out.push(f(
            "sqlite.fk.unindexed", "performance", Sev::Warn,
            format!("{} foreign key column(s) without an index", d.unindexed_fks.len()),
            format!("{}.{more} Each parent-side DELETE or key UPDATE on these \
                     relationships full-scans the child table.", shown.join(", ")),
            Some("Index the child column of each foreign key. SQLite never creates \
                  these indexes itself, unlike the ones backing PRIMARY KEY/UNIQUE.".into()),
            d.unindexed_fks.iter().map(|(child, col, _)| format!(
                "CREATE INDEX \"idx_{child}_{col}\" ON \"{child}\" (\"{col}\");")).collect(),
        ));
    }

    // 9. Page cache vs file size. The default cache is ~2 MiB; on a file many
    //    times that size, repeated queries re-read pages from disk.
    if d.size_bytes() >= 32 * MIB && d.cache_bytes() < 4 * MIB {
        out.push(f(
            "sqlite.cache.small", "performance", Sev::Advice,
            format!("Small page cache ({}) for a {} file",
                    fmt_bytes(d.cache_bytes()), fmt_bytes(d.size_bytes())),
            "The page cache holds far less than the working set, so repeated queries \
             re-read pages from disk.",
            Some("Raise the cache for this connection. A negative value is KiB, so \
                  -16384 is 16 MiB.".into()),
            vec!["PRAGMA cache_size = -16384;".into()],
        ));
    }

    // 10. FK enforcement off. SQLite defaults it OFF per connection; a schema
    //     full of declared FKs may never have enforced one.
    if !d.foreign_keys {
        out.push(f(
            "sqlite.fk.enforcement-off", "resilience", Sev::Warn,
            "Foreign key enforcement is OFF",
            "PRAGMA foreign_keys is OFF on this connection, so declared foreign keys \
             are not enforced and violations can accumulate silently.",
            Some("Turn it on (TxUI does so for its own connections) and check for \
                  existing violations.".into()),
            vec!["PRAGMA foreign_keys = ON;".into(), "PRAGMA foreign_key_check;".into()],
        ));
    }

    // 11. Tables with no declared PRIMARY KEY live on the implicit rowid,
    //     which is not stable across VACUUM. Legal and fast — informational.
    if !d.no_pk_tables.is_empty() {
        let shown: Vec<&String> = d.no_pk_tables.iter().take(5).collect();
        let more = if d.no_pk_tables.len() > 5 {
            format!(" (+ {} more)", d.no_pk_tables.len() - 5)
        } else { String::new() };
        out.push(f(
            "sqlite.schema.no-pk", "schema", Sev::Info,
            format!("{} table(s) without a PRIMARY KEY", d.no_pk_tables.len()),
            format!("{}.{more} These rely on the implicit rowid, which is not stable \
                     across VACUUM — anything storing it as a reference will silently \
                     point somewhere else afterwards.", join_names(&shown)),
            None, vec![],
        ));
    }

    out
}

/// Comma-join table names for finding prose.
fn join_names(names: &[&String]) -> String {
    names.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::tuner::sqlite_collectors::SqliteData;

    /// A healthy, boring baseline: WAL, FULL-ish durability, stats collected,
    /// every FK indexed, quick_check ok. Individual tests mutate one field.
    fn base() -> SqliteData {
        SqliteData {
            version: "3.51.3".into(),
            page_size: 4096,
            page_count: 1024, // 4 MiB
            freelist_count: 0,
            journal_mode: "wal".into(),
            synchronous: 2,
            auto_vacuum: 2,
            foreign_keys: true,
            encoding: "UTF-8".into(),
            cache_size: -2000, // ~2 MiB
            user_tables: vec!["parent".into(), "child".into()],
            analyzed_tables: Some(vec!["parent".into(), "child".into()]),
            unindexed_fks: vec![],
            no_pk_tables: vec![],
            quick_check: Some(vec!["ok".into()]),
        }
    }

    fn ids(fs: &[Finding]) -> Vec<&str> { fs.iter().map(|f| f.id.as_str()).collect() }
    fn sev<'a>(fs: &'a [Finding], id: &str) -> Option<&'a str> {
        fs.iter().find(|f| f.id == id).map(|f| f.severity.as_str())
    }

    #[test]
    fn a_healthy_file_scores_no_problem_findings() {
        let out = run_checks(&base());
        assert!(out.iter().all(|f| f.severity == "ok" || f.severity == "info"),
                "unexpected problems: {:?}", ids(&out));
        assert!(ids(&out).contains(&"sqlite.journal.wal"));
        assert!(ids(&out).contains(&"sqlite.integrity.ok"));
        assert!(ids(&out).contains(&"sqlite.analyze.ok"));
    }

    // ── Freelist ─────────────────────────────────────────────────────────

    #[test]
    fn freelist_ladder() {
        let mut d = base();
        d.page_count = 4096; // 16 MiB
        d.freelist_count = 2048; // 50 %, 8 MiB
        assert_eq!(sev(&run_checks(&d), "sqlite.freelist.high"), Some("warn"));

        d.freelist_count = 614; // 15 %, ~2.4 MiB
        let out = run_checks(&d);
        assert_eq!(sev(&out, "sqlite.freelist.moderate"), Some("advice"));
        assert!(!ids(&out).contains(&"sqlite.freelist.high"));

        // A tiny file with a high ratio stays quiet below the absolute floor.
        d.page_count = 100;
        d.freelist_count = 50;
        let out = run_checks(&d);
        assert!(!ids(&out).contains(&"sqlite.freelist.high"));
        assert!(!ids(&out).contains(&"sqlite.freelist.moderate"));
    }

    // ── Durability ───────────────────────────────────────────────────────

    #[test]
    fn journal_off_is_critical_and_rollback_is_advice() {
        let mut d = base();
        d.journal_mode = "off".into();
        assert_eq!(sev(&run_checks(&d), "sqlite.journal.off"), Some("critical"));

        d.journal_mode = "delete".into();
        assert_eq!(sev(&run_checks(&d), "sqlite.journal.rollback"), Some("advice"));
    }

    #[test]
    fn synchronous_off_is_flagged() {
        let mut d = base();
        d.synchronous = 0;
        assert_eq!(sev(&run_checks(&d), "sqlite.synchronous.off"), Some("warn"));
    }

    // ── Integrity ────────────────────────────────────────────────────────

    #[test]
    fn quick_check_drives_the_integrity_finding() {
        let mut d = base();
        d.quick_check = Some(vec!["row 7 missing from index t_v".into()]);
        let out = run_checks(&d);
        assert_eq!(sev(&out, "sqlite.integrity.corrupt"), Some("critical"));
        assert!(out.iter().find(|f| f.id == "sqlite.integrity.corrupt")
            .unwrap().detail.contains("row 7 missing"));

        // A failed probe degrades to the suggestion, not a broken run.
        d.quick_check = None;
        let out = run_checks(&d);
        assert_eq!(sev(&out, "sqlite.integrity.check"), Some("info"));
        assert!(!ids(&out).contains(&"sqlite.integrity.ok"));
    }

    // ── Planner statistics ───────────────────────────────────────────────

    #[test]
    fn never_analyzed_and_partially_analyzed() {
        let mut d = base();
        d.analyzed_tables = None;
        assert_eq!(sev(&run_checks(&d), "sqlite.analyze.never"), Some("advice"));

        d.analyzed_tables = Some(vec!["parent".into()]); // child missing
        let out = run_checks(&d);
        assert_eq!(sev(&out, "sqlite.analyze.stale"), Some("advice"));
        assert!(out.iter().find(|f| f.id == "sqlite.analyze.stale")
            .unwrap().detail.contains("child"));

        // An empty database has nothing to analyze — silence, not advice.
        d.analyzed_tables = None;
        d.user_tables = vec![];
        assert!(!ids(&run_checks(&d)).contains(&"sqlite.analyze.never"));
    }

    // ── Unindexed foreign keys ───────────────────────────────────────────

    #[test]
    fn unindexed_fk_is_warned_with_a_create_index_fix() {
        let mut d = base();
        d.unindexed_fks = vec![("child".into(), "pid".into(), "parent".into())];
        let out = run_checks(&d);
        let f = out.iter().find(|f| f.id == "sqlite.fk.unindexed").unwrap();
        assert_eq!(f.severity, "warn");
        assert!(f.detail.contains("child.pid → parent"), "detail: {}", f.detail);
        assert_eq!(f.fix_sql,
                   vec!["CREATE INDEX \"idx_child_pid\" ON \"child\" (\"pid\");".to_string()]);
    }

    // ── Cache size ───────────────────────────────────────────────────────

    #[test]
    fn small_cache_only_matters_on_a_large_file() {
        let mut d = base();
        d.page_count = 64 * 1024; // 256 MiB file
        d.cache_size = -2000; // ~2 MiB
        assert_eq!(sev(&run_checks(&d), "sqlite.cache.small"), Some("advice"));

        // Same cache on a small file: nothing to say.
        d.page_count = 1024;
        assert!(!ids(&run_checks(&d)).contains(&"sqlite.cache.small"));

        // A generous cache on the large file: nothing to say. Positive
        // cache_size is in PAGES, so this also pins the unit decode.
        d.page_count = 64 * 1024;
        d.cache_size = 4096; // 4096 pages × 4096 B = 16 MiB
        assert!(!ids(&run_checks(&d)).contains(&"sqlite.cache.small"));
    }

    // ── FK enforcement / schema ──────────────────────────────────────────

    #[test]
    fn foreign_keys_off_is_flagged() {
        let mut d = base();
        d.foreign_keys = false;
        assert_eq!(sev(&run_checks(&d), "sqlite.fk.enforcement-off"), Some("warn"));
    }

    #[test]
    fn pk_less_tables_are_informational() {
        let mut d = base();
        d.user_tables.push("heap".into());
        d.analyzed_tables = Some(vec!["parent".into(), "child".into(), "heap".into()]);
        d.no_pk_tables = vec!["heap".into()];
        let out = run_checks(&d);
        assert_eq!(sev(&out, "sqlite.schema.no-pk"), Some("info"));
        // Info costs no points — a legal design must not hurt the score.
        assert_eq!(out.iter().find(|f| f.id == "sqlite.schema.no-pk").unwrap().points_lost, 0);
    }

    #[test]
    fn every_finding_respects_the_report_contract() {
        let mut d = base();
        // Turn everything wrong at once.
        d.journal_mode = "off".into();
        d.synchronous = 0;
        d.auto_vacuum = 0;
        d.page_size = 1024;
        d.page_count = 64 * 1024; // 64 MiB
        d.freelist_count = 32 * 1024;
        d.cache_size = -1000;
        d.foreign_keys = false;
        d.analyzed_tables = None;
        d.unindexed_fks = vec![("child".into(), "pid".into(), "parent".into())];
        d.no_pk_tables = vec!["heap".into()];
        d.quick_check = Some(vec!["corrupt".into()]);

        for f in run_checks(&d) {
            assert!(["performance", "security", "resilience", "schema", "config"]
                .contains(&f.category.as_str()), "bad category {}", f.category);
            assert!(["ok", "info", "advice", "warn", "critical"]
                .contains(&f.severity.as_str()), "bad severity {}", f.severity);
            assert_eq!(f.points_lost, match f.severity.as_str() {
                "critical" => 10, "warn" => 5, "advice" => 2, _ => 0,
            }, "points/severity mismatch on {}", f.id);
        }
    }
}
