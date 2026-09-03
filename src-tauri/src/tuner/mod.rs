//! MySQL-family configuration tuner — a read-only, Rust-native reimagining of
//! MySQLTuner-perl, wired into TxUI sessions instead of screen-scraping a
//! local client. Beyond the original it adds: cloud-instance autodiscovery,
//! endoflife.date lifecycle tracking with an air-gapped fallback, 8.4/9.x LTS
//! migration advisories, and copy-pasteable fix SQL / my.cnf lines (generated
//! only — NEVER executed).
//!
//! Report contract (frontend builds against this — do not change shape):
//!   tuner_analyze(sessionId) -> TunerReport
//!
//! Scoring: each finding's severity maps to points_lost
//! (critical 10 / warn 5 / advice 2 / info,ok 0), subtracted from its
//! category bucket — performance|config /40, security /30, resilience|schema
//! /30 — floored at 0. total = sum. See checks.rs for the rules.

pub mod ch_checks;
pub mod ch_collectors;
pub mod checks;
pub mod collectors;
pub mod eol;
pub mod mssql_checks;
pub mod mssql_collectors;
pub mod pg_checks;
pub mod pg_collectors;
pub mod redis_checks;
pub mod redis_collectors;
pub mod sqlite_checks;
pub mod sqlite_collectors;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ServerInfo {
    pub version: String,
    pub version_comment: String,
    /// "mysql" | "mariadb" | "percona"
    pub flavor: String,
    pub arch: String,
    pub uptime_secs: u64,
    /// "aws-rds" | "aws-aurora" | "gcp-cloudsql" | "azure" | "digitalocean"
    pub cloud: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EolInfo {
    /// "mysql" | "mariadb"
    pub product: String,
    pub cycle: String,
    pub eol_date: Option<String>,
    /// "supported" | "eol-soon" | "eol" | "unknown"
    pub status: String,
    pub latest: Option<String>,
    /// "endoflife.date" | "cache" | "builtin-fallback"
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Score {
    pub total: u8,
    /// out of 40
    pub performance: u8,
    /// out of 30
    pub security: u8,
    /// out of 30
    pub resilience: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub id: String,
    /// "performance" | "security" | "resilience" | "schema" | "config"
    pub category: String,
    /// "ok" | "info" | "advice" | "warn" | "critical"
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub recommendation: Option<String>,
    /// Runtime-settable statements, values computed from live data.
    /// GENERATED ONLY — the tuner never executes them.
    pub fix_sql: Vec<String>,
    /// my.cnf lines for the same change.
    pub fix_config: Vec<String>,
    pub points_lost: u8,
}

#[derive(Debug, Serialize)]
pub struct TunerReport {
    /// RFC 3339 local timestamp
    pub generated_at: String,
    pub server: ServerInfo,
    pub eol: Option<EolInfo>,
    pub score: Score,
    pub findings: Vec<Finding>,
}

/// Run the full analysis against an open MySQL-family pool. Read-only:
/// every probe is SHOW/SELECT against system schemas.
pub async fn analyze(pool: &sqlx::MySqlPool, data_dir: &std::path::Path) -> anyhow::Result<TunerReport> {
    let data = collectors::collect(pool).await?;
    let eol_info = eol::lookup(data.flavor.eol_product(), &data.cycle(), data_dir).await;
    let mut findings = checks::run_checks(&data, Some(&eol_info));
    checks::sort_findings(&mut findings);
    let score = checks::compute_score(&findings);
    Ok(TunerReport {
        generated_at: chrono::Local::now().to_rfc3339(),
        server: ServerInfo {
            version: data.version.clone(),
            version_comment: data.version_comment.clone(),
            flavor: data.flavor.as_str().to_string(),
            arch: data.arch.clone(),
            uptime_secs: data.uptime_secs,
            cloud: data.cloud.clone(),
        },
        eol: Some(eol_info),
        score,
        findings,
    })
}

/// Run the full analysis against an open PostgreSQL pool. Read-only: every
/// probe is a SELECT against pg_catalog / the statistics views, and the
/// returned fix_sql is generated, never executed.
///
/// Shares the report contract, scoring and ordering with the MySQL path, so
/// the panel renders both engines without branching.
pub async fn analyze_pg(pool: &sqlx::PgPool, data_dir: &std::path::Path) -> anyhow::Result<TunerReport> {
    let data = pg_collectors::collect(pool).await?;
    let eol_info = eol::lookup("postgresql", &data.cycle(), data_dir).await;
    let mut findings = pg_checks::run_checks(&data, Some(&eol_info));
    checks::sort_findings(&mut findings);
    let score = checks::compute_score(&findings);
    Ok(TunerReport {
        generated_at: chrono::Local::now().to_rfc3339(),
        server: ServerInfo {
            version: data.version.clone(),
            // PostgreSQL has no version_comment; the full version() banner
            // already carries the build details the panel shows.
            version_comment: data.version.clone(),
            flavor: "postgres".to_string(),
            arch: String::new(),
            uptime_secs: data.uptime_secs,
            cloud: data.cloud.clone(),
        },
        eol: Some(eol_info),
        score,
        findings,
    })
}

/// Run the full analysis against an open Redis connection. Read-only: every
/// probe is INFO / CONFIG GET / SLOWLOG GET / ACL LIST, and the returned
/// fix_sql is generated, never executed.
///
/// Shares the report contract, scoring and ordering with the SQL engines, so
/// the panel renders all three without branching.
pub async fn analyze_redis(
    mgr: &::redis::aio::ConnectionManager,
    data_dir: &std::path::Path,
) -> anyhow::Result<TunerReport> {
    let data = redis_collectors::collect(mgr).await?;
    let eol_info = eol::lookup("redis", &data.cycle(), data_dir).await;
    let mut findings = redis_checks::run_checks(&data, Some(&eol_info));
    checks::sort_findings(&mut findings);
    let score = checks::compute_score(&findings);
    Ok(TunerReport {
        generated_at: chrono::Local::now().to_rfc3339(),
        server: ServerInfo {
            version: data.version.clone(),
            // Redis has no version_comment; the INFO `os` line is the closest
            // equivalent build detail the panel can show.
            version_comment: data.os.clone(),
            flavor: "redis".to_string(),
            arch: data.i("arch_bits").unwrap_or("").to_string(),
            uptime_secs: data.uptime_secs,
            // Managed Redis providers do not advertise themselves the way the
            // SQL engines do; left unset rather than guessed.
            cloud: None,
        },
        eol: Some(eol_info),
        score,
        findings,
    })
}

/// Run the analysis against an open SQLite file. Read-only: every probe is a
/// `PRAGMA`, and the freelist / auto_vacuum / integrity fixes it generates are
/// never executed. SQLite has no server lifecycle, so uptime is 0 and there is
/// no EOL cycle to look up.
pub async fn analyze_sqlite(pool: &sqlx::SqlitePool) -> anyhow::Result<TunerReport> {
    let data = sqlite_collectors::collect(pool).await?;
    let mut findings = sqlite_checks::run_checks(&data);
    checks::sort_findings(&mut findings);
    let score = checks::compute_score(&findings);
    Ok(TunerReport {
        generated_at: chrono::Local::now().to_rfc3339(),
        server: ServerInfo {
            version: data.version.clone(),
            version_comment: format!("{} encoding", if data.encoding.is_empty() { "UTF-8" } else { &data.encoding }),
            flavor: "sqlite".to_string(),
            arch: String::new(),
            uptime_secs: 0,
            cloud: None,
        },
        eol: None,
        score,
        findings,
    })
}

/// Run the full analysis against an open ClickHouse session. Read-only: every
/// probe is a SELECT against the `system.*` operational tables, and the
/// returned fix_sql is generated, never executed.
///
/// Shares the report contract, scoring and ordering with the other engines, so
/// the panel renders ClickHouse without branching.
/// Run the full analysis against an open SQL Server session. Read-only: every
/// probe is a SELECT against `sys.*`, a DMV or `msdb.dbo.backupset`, and the
/// remediation the checks produce is generated and never executed.
///
/// Shares the report contract, scoring and ordering with the other engines, so
/// the panel renders SQL Server without branching.
pub async fn analyze_mssql(
    session: &crate::db::sqlserver::SqlServerSession,
    data_dir: &std::path::Path,
) -> anyhow::Result<TunerReport> {
    let data = mssql_collectors::collect(session).await?;
    let eol_info = eol::lookup("mssqlserver", &data.cycle(), data_dir).await;
    let mut findings = mssql_checks::run_checks(&data, Some(&eol_info));
    checks::sort_findings(&mut findings);
    let score = checks::compute_score(&findings);
    Ok(TunerReport {
        generated_at: chrono::Local::now().to_rfc3339(),
        server: ServerInfo {
            version: data.product_version.clone(),
            // The edition IS the identity here in a way a MySQL comment is not:
            // Standard caps memory and cores, and several findings only apply
            // to one edition, so it belongs where the panel already shows it.
            version_comment: format!("{} ({})", data.edition, data.product_level),
            flavor: "sqlserver".to_string(),
            arch: String::new(),
            uptime_secs: data.uptime_secs,
            // EngineEdition 5 is Azure SQL Database, 8 a Managed Instance —
            // the server telling us it is managed, rather than a guess.
            cloud: match data.engine_edition {
                5 => Some("Azure SQL Database".to_string()),
                8 => Some("Azure SQL Managed Instance".to_string()),
                _ => None,
            },
        },
        eol: Some(eol_info),
        score,
        findings,
    })
}

pub async fn analyze_ch(
    session: &crate::db::clickhouse::ChSession,
    data_dir: &std::path::Path,
) -> anyhow::Result<TunerReport> {
    let data = ch_collectors::collect(session).await?;
    let eol_info = eol::lookup("clickhouse", &data.cycle(), data_dir).await;
    let mut findings = ch_checks::run_checks(&data, Some(&eol_info));
    checks::sort_findings(&mut findings);
    let score = checks::compute_score(&findings);
    Ok(TunerReport {
        generated_at: chrono::Local::now().to_rfc3339(),
        server: ServerInfo {
            version: data.version.clone(),
            // ClickHouse has no version_comment; the bare version() string is
            // the whole build identity the panel can show.
            version_comment: data.version.clone(),
            flavor: "clickhouse".to_string(),
            arch: String::new(),
            uptime_secs: data.uptime_secs,
            // Managed ClickHouse providers do not fingerprint reliably over the
            // HTTP interface; left unset rather than guessed.
            cloud: data.cloud.clone(),
        },
        eol: Some(eol_info),
        score,
        findings,
    })
}


// ── Shared check scaffolding (WP-16 16.4) ────────────────────────────────────
//
// Every engine's check file carried its own copy of the severity ladder, the
// `f()` Finding constructor and `fmt_bytes` — five near-verbatim copies. One
// definition here; the ~50 rules' outputs are unchanged (severity strings,
// points and byte formatting are byte-identical to what each copy produced).

/// Severity ladder shared by every engine's checks.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Sev { Critical, Warn, Advice, Info, Ok }

impl Sev {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Sev::Critical => "critical",
            Sev::Warn     => "warn",
            Sev::Advice   => "advice",
            Sev::Info     => "info",
            Sev::Ok       => "ok",
        }
    }
    pub(crate) fn points(self) -> u8 {
        match self {
            Sev::Critical => 10,
            Sev::Warn     => 5,
            Sev::Advice   => 2,
            Sev::Info | Sev::Ok => 0,
        }
    }
}

/// Finding constructor every check file uses.
#[allow(clippy::too_many_arguments)]
pub(crate) fn f(
    id: &str, category: &str, sev: Sev,
    title: impl Into<String>, detail: impl Into<String>,
    recommendation: Option<String>, fix_sql: Vec<String>, fix_config: Vec<String>,
) -> Finding {
    Finding {
        id: id.into(),
        category: category.into(),
        severity: sev.as_str().into(),
        title: title.into(),
        detail: detail.into(),
        recommendation,
        fix_sql,
        fix_config,
        points_lost: sev.points(),
    }
}

pub(crate) const GIB: u64 = 1024 * 1024 * 1024;
pub(crate) const MIB: u64 = 1024 * 1024;

pub fn fmt_bytes(b: u64) -> String {
    if b >= GIB { format!("{:.1} GiB", b as f64 / GIB as f64) }
    else if b >= MIB { format!("{:.0} MiB", b as f64 / MIB as f64) }
    else { format!("{} B", b) }
}

#[cfg(test)]
mod tests {
    /// The real thing, against a real server. Password comes from the same
    /// encrypted store as the GUI (never a literal):
    ///
    ///   TXUI_TEST_CONN=Lo80 cargo test --lib tuner_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn tuner_live_report() {
        let Ok(name) = std::env::var("TXUI_TEST_CONN") else { return };
        let dir = crate::storage::default_data_dir();
        let configs = crate::storage::load(&dir).expect("read connections.json");
        let config = configs.values().find(|c| c.name == name).expect("connection not found").clone();
        let password = crate::secretstore::get(&dir, &config.keychain_key());
        let pool = crate::db::mysql::open_pool(&config, password, None, 4).await.unwrap();

        let report = super::analyze(&pool, &dir).await.unwrap();

        println!("\n=== TUNER REPORT: {} ({}, {}, uptime {}s) ===",
            config.name, report.server.version, report.server.flavor, report.server.uptime_secs);
        println!("cloud: {:?}  arch: {}", report.server.cloud, report.server.arch);
        if let Some(e) = &report.eol {
            println!("eol:   {} {} → {} (date {:?}, latest {:?}, source {})",
                e.product, e.cycle, e.status, e.eol_date, e.latest, e.source);
        }
        println!("score: {} total (perf {}/40, sec {}/30, res {}/30)",
            report.score.total, report.score.performance, report.score.security, report.score.resilience);
        for f in &report.findings {
            println!("  [{:8}] {:28} {}", f.severity, f.id, f.title);
        }

        // Contract sanity: every field the frontend reads must serialize.
        let json = serde_json::to_value(&report).unwrap();
        assert!(json.get("generated_at").is_some());
        assert!(json.pointer("/server/uptime_secs").is_some());
        assert!(json.pointer("/score/performance").is_some());
        for f in report.findings.iter() {
            assert!(["performance", "security", "resilience", "schema", "config"].contains(&f.category.as_str()), "bad category {}", f.category);
            assert!(["ok", "info", "advice", "warn", "critical"].contains(&f.severity.as_str()), "bad severity {}", f.severity);
            assert_eq!(f.points_lost, match f.severity.as_str() {
                "critical" => 10, "warn" => 5, "advice" => 2, _ => 0,
            }, "points_lost/severity mismatch on {}", f.id);
        }

        assert!(!report.findings.is_empty(), "no findings at all — collectors broken?");
        assert!(report.eol.is_some(), "EOL must resolve via live API, cache, or builtin fallback");
        assert!(report.score.total <= 100);
        // These dev servers are far from perfectly tuned; but a total collapse
        // means a collector is silently failing everything.
        assert!(report.score.total > 0);
        pool.close().await;
    }
}


/// The SQL Server tuner against a real instance.
///
/// Every rule reasons over data only a live server produces — configuration
/// defaults, backup history, file growth settings — so a unit test with a
/// hand-built struct would confirm the arithmetic and nothing about whether the
/// collectors read the right columns. Skipped, not failed, without an endpoint;
/// see docs/MSSQL_DEV.md.
#[cfg(test)]
mod mssql_live_tests {
    use crate::db::sqlserver::live_tests::live_session;

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn analyze_a_real_instance() {
        let Some(s) = live_session().await else {
            println!("no endpoint configured — see docs/MSSQL_DEV.md");
            return;
        };
        let dir = std::env::temp_dir();
        let report = super::analyze_mssql(&s, &dir).await.expect("analyze");

        // Identity came back, and the edition is part of it — several rules
        // only apply to one edition, and the panel shows it.
        assert!(report.server.version.starts_with("16.")
                || report.server.version.starts_with("15.")
                || report.server.version.starts_with("14."),
                "unexpected version {:?}", report.server.version);
        assert!(report.server.version_comment.contains("Edition"),
                "{:?}", report.server.version_comment);
        assert_eq!(report.server.flavor, "sqlserver");

        let ids: Vec<&str> = report.findings.iter().map(|f| f.id.as_str()).collect();

        // A stock container has every one of these, which is the point: they
        // are not exotic misconfigurations, they are what a fresh install has.
        assert!(ids.contains(&"mssql.memory.unbounded"),
                "max server memory defaults to unlimited: {ids:?}");
        assert!(ids.contains(&"mssql.parallelism.threshold"),
                "cost threshold defaults to 5: {ids:?}");
        // Deliberately NOT asserting on backup HISTORY. `msdb.dbo.backupset` is
        // mutable server state — anyone taking a backup, including another test,
        // changes it — and a test that pins it fails for a reason that has
        // nothing to do with the code. (It did: an earlier probe took a backup
        // and `mssql.backup.never` correctly stopped firing.)
        //
        // A database left in FULL recovery whose log is never backed up is a
        // *configuration* default, and that one is stable.
        assert!(ids.contains(&"mssql.recovery.no-log-backup")
                || ids.contains(&"mssql.backup.never")
                || ids.contains(&"mssql.backup.stale"),
                "no resilience finding at all on an unbacked-up dev instance: {ids:?}");

        // Every finding has to be actionable: a title, a detail that is not the
        // title, and — unless it is informational — something to do about it.
        for f in &report.findings {
            assert!(!f.title.is_empty(), "{f:?}");
            assert!(f.detail.len() > f.title.len(), "detail is not saying more: {f:?}");
            if f.severity != "info" && f.severity != "ok" {
                assert!(f.recommendation.is_some(), "no recommendation: {}", f.id);
            }
            // The remediation is GENERATED, never run — but it must at least be
            // the kind of statement it claims to be.
            for sql in &f.fix_sql {
                let up = sql.to_uppercase();
                assert!(up.contains("ALTER") || up.contains("SP_CONFIGURE")
                        || up.contains("BACKUP") || up.contains("DBCC")
                        // Index findings remediate by creating or dropping one.
                        || up.contains("CREATE INDEX") || up.contains("NONCLUSTERED INDEX")
                        || up.contains("DROP INDEX")
                        || up.starts_with("--"),
                        "{}: unexpected fix {sql:?}", f.id);
            }
        }

        for f2 in &report.findings {
            println!("[{:8}] {:34} {}", f2.severity, f2.id, f2.title);
        }
        println!("score: total {} perf {} sec {} res {}",
                 report.score.total, report.score.performance,
                 report.score.security, report.score.resilience);

        // Scores are percentages of a fixed budget; an out-of-range one means
        // the shared scorer was handed a category it does not know.
        assert!(report.score.total <= 100);
        assert!(report.score.performance <= 40);
        assert!(report.score.security <= 30);
        assert!(report.score.resilience <= 30);
    }

    /// The index findings, against the DMVs that produce them.
    ///
    /// The generated `CREATE INDEX` is executed and then dropped, because a
    /// remediation that does not parse is worse than no remediation — the DBA
    /// pastes it into a maintenance window and finds out there.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn the_suggested_index_statement_actually_runs() {
        use crate::db::sqlserver;
        let Some(s) = crate::db::sqlserver::live_tests::live_session().await else {
            println!("no endpoint configured — see docs/MSSQL_DEV.md");
            return;
        };
        // Its OWN table: the suggested index is CREATED below to prove it
        // parses, and DDL on the shared `sales.orders` deadlocks against the
        // catalog reads other live tests are doing at the same time (Msg 1205).
        sqlserver::execute(&s,
            "IF OBJECT_ID('dbo.zz_mi_orders') IS NOT NULL DROP TABLE dbo.zz_mi_orders")
            .await.ok();
        sqlserver::execute(&s,
            "SELECT id, currency, total INTO dbo.zz_mi_orders FROM sales.orders")
            .await.expect("own table");
        // Give the optimiser something to wish for.
        for _ in 0..3 {
            sqlserver::execute(&s,
                "SELECT COUNT(*) FROM dbo.zz_mi_orders WHERE currency = 'EUR' AND total > 500")
                .await.expect("query");
        }
        let data = super::mssql_collectors::collect(&s).await.expect("collect");
        let mine: Vec<_> = data.missing_indexes.iter()
            .filter(|m| m.object.ends_with("zz_mi_orders")).cloned().collect();
        if mine.is_empty() {
            // The DMVs reset on restart and the optimiser decides what to
            // record; an empty list is a legitimate outcome, not a failure.
            // The table still goes — an early return that skips its own
            // cleanup leaves the fixture dirty for every later run.
            sqlserver::execute(&s, "DROP TABLE dbo.zz_mi_orders").await.ok();
            println!("no missing-index suggestions recorded — nothing to assert");
            return;
        }
        for mi in mine.iter().take(3) {
            let sql = mi.create_sql();
            assert!(sql.starts_with("CREATE NONCLUSTERED INDEX "), "{sql}");
            // Brackets must not be doubled: the DMV hands them over quoted.
            assert!(!sql.contains("[["), "{sql}");
            sqlserver::execute(&s, &sql).await
                .unwrap_or_else(|e| panic!("suggested index did not run: {e}\n{sql}"));
            // Take it straight back out — the fixture is shared.
            let name = sql.split('[').nth(1).and_then(|x| x.split(']').next())
                .expect("index name");
            sqlserver::execute(&s, &format!("DROP INDEX [{name}] ON {}", mi.object))
                .await.expect("drop the index again");
        }
        sqlserver::execute(&s, "DROP TABLE dbo.zz_mi_orders").await.ok();
    }

    /// The memory suggestion is computed from THIS machine, not quoted.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn the_memory_cap_is_derived_from_real_physical_memory() {
        let Some(s) = live_session().await else { return };
        let data = super::mssql_collectors::collect(&s).await.expect("collect");
        assert!(data.physical_memory_mb > 0, "no physical memory reported");
        assert!(data.cpu_count > 0, "no CPU count reported");

        let report = super::analyze_mssql(&s, &std::env::temp_dir()).await.expect("analyze");
        let mem = report.findings.iter().find(|f| f.id == "mssql.memory.unbounded");
        if let Some(mem) = mem {
            let sql = mem.fix_sql.join(" ");
            // The number must be below physical memory — a cap above it is not
            // a cap, which is the very thing the neighbouring rule reports.
            // The value is the number after the option name: `sp_configure
            // 'max server memory (MB)', 5248;`
            let n: i64 = sql
                .split("'max server memory (MB)',").nth(1).unwrap_or("")
                .trim()
                .chars().take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse().unwrap_or(0);
            assert!(n > 0 && n < data.physical_memory_mb,
                    "suggested {n} MB against {} MB physical, from {sql:?}",
                    data.physical_memory_mb);
        }
    }
}

#[cfg(test)]
mod pg_live_tests {
    //! The PostgreSQL tuner against the local 16/17/18 servers. Catches the
    //! things unit tests cannot: catalog queries that do not exist on a given
    //! major (checkpoint counters moved to pg_stat_checkpointer in 17), and
    //! the report contract the panel reads.
    //!
    //!   cargo test --lib pg_tuner_live -- --ignored --nocapture

    use crate::db::types::{ConnectionConfig, Engine, SslMode};

    const PORTS: [u16; 4] = [5435, 5432, 5433, 5434];

    fn config(port: u16) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Postgres, format!("pg-{port}"));
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.user = Some("root".into());
        c.database = Some("postgres".into());
        c.ssl_mode = SslMode::Disable;
        c
    }

    #[tokio::test]
    #[ignore]
    async fn pg_tuner_live_report_on_every_major() {
        let dir = std::env::temp_dir();
        for port in PORTS {
            let pool = crate::db::postgres::open_pool(&config(port), Some("root".into()), None, 2)
                .await.unwrap_or_else(|e| panic!("connect {port}: {e}"));
            let report = super::analyze_pg(&pool, &dir).await
                .unwrap_or_else(|e| panic!("analyze {port}: {e}"));

            println!("\n=== pg on :{port} — {} ===", report.server.version.lines().next().unwrap_or(""));
            if let Some(e) = &report.eol {
                println!("eol:   {} {} → {} (date {:?}, source {})",
                         e.product, e.cycle, e.status, e.eol_date, e.source);
            }
            println!("score: {} total (perf {}/40, sec {}/30, res {}/30)",
                     report.score.total, report.score.performance,
                     report.score.security, report.score.resilience);
            for f in &report.findings {
                println!("  [{:8}] {:32} {}", f.severity, f.id, f.title);
            }

            // ── Report contract the frontend builds against ──────────────
            let json = serde_json::to_value(&report).unwrap();
            assert!(json.get("generated_at").is_some());
            assert!(json.pointer("/server/uptime_secs").is_some());
            assert!(json.pointer("/score/performance").is_some());
            for f in &report.findings {
                assert!(["performance", "security", "resilience", "schema", "config"]
                    .contains(&f.category.as_str()), "{port}: bad category {}", f.category);
                assert!(["ok", "info", "advice", "warn", "critical"]
                    .contains(&f.severity.as_str()), "{port}: bad severity {}", f.severity);
                assert_eq!(f.points_lost, match f.severity.as_str() {
                    "critical" => 10, "warn" => 5, "advice" => 2, _ => 0,
                }, "{port}: points/severity mismatch on {}", f.id);
            }

            assert_eq!(report.server.flavor, "postgres");
            assert!(report.eol.as_ref().is_some_and(|e| e.status != "unknown"),
                    "{port}: EOL must resolve for a current major");
            assert!(report.score.total <= 100 && report.score.total > 0, "{port}: score");

            // Collectors must actually have run: a silent failure would leave
            // only the static findings behind.
            let ids: Vec<&str> = report.findings.iter().map(|f| f.id.as_str()).collect();
            assert!(ids.contains(&"pg-version"), "{port}: no version finding");
            assert!(ids.contains(&"pg-cache-hit"),
                    "{port}: no cache-hit finding — pg_stat_database collector failed");
            assert!(ids.contains(&"pg-pg-stat-statements-ok"),
                    "{port}: extension list not collected");

            // The dev fixture deliberately leaves `trust` rules in pg_hba and
            // one PK-less table, so these must be detected on every version.
            assert!(ids.contains(&"pg-hba-trust"),
                    "{port}: pg_hba_file_rules collector failed — trust rules not seen");
            assert!(ids.contains(&"pg-no-pk"), "{port}: schema collector failed");

            pool.close().await;
        }
    }

    #[tokio::test]
    #[ignore]
    async fn pg_tuner_live_checkpoint_counters_survive_the_pg17_move() {
        // pg_stat_bgwriter lost its checkpoint columns in PG 17. If the gating
        // is wrong the collector silently returns zeros, so assert the counter
        // is actually populated on every major.
        for port in PORTS {
            let pool = crate::db::postgres::open_pool(&config(port), Some("root".into()), None, 2)
                .await.unwrap();
            let d = super::pg_collectors::collect(&pool).await.unwrap();
            assert!(d.ckpt_timed + d.ckpt_req > 0,
                    "{port} (major {}): checkpoint counters are zero — wrong catalog view",
                    d.major);
            assert!(d.major >= 14, "{port}: unexpected major {}", d.major);
            assert!(d.db_bytes > 0, "{port}: database size not collected");
            assert!(!d.settings.is_empty(), "{port}: pg_settings not collected");
            assert!(d.roles.is_some(), "{port}: pg_authid unreadable as superuser");
            assert!(d.hba.is_some(), "{port}: pg_hba_file_rules unreadable as superuser");
            println!("  :{port} major={} ckpt timed={} req={} settings={}",
                     d.major, d.ckpt_timed, d.ckpt_req, d.settings.len());
            pool.close().await;
        }
    }
}

#[cfg(test)]
mod pg_standby_tests {
    //! Against a REAL streaming standby (port 5436, replicating from 5434).
    //! Standby code paths cannot be exercised on a primary — and one of them
    //! shipped broken for exactly that reason: the replication panel
    //! propagated `pg_is_wal_replay_paused()`'s "recovery is not in progress"
    //! error on every primary.
    //!
    //!   cargo test --lib pg_standby -- --ignored --nocapture
    //!
    //! Skipped when nothing is listening on 5436.

    use crate::db::types::{ConnectionConfig, Engine, SslMode};

    fn config(port: u16) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Postgres, format!("pg-{port}"));
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.user = Some("root".into());
        c.database = Some("postgres".into());
        c.ssl_mode = SslMode::Disable;
        c
    }

    async fn pool(port: u16) -> Option<sqlx::PgPool> {
        crate::db::postgres::open_pool(&config(port), Some("root".into()), None, 2).await.ok()
    }

    #[tokio::test]
    #[ignore]
    async fn pg_standby_tuner_knows_it_is_a_replica() {
        let Some(p) = pool(5436).await else { println!("no standby on 5436 — skipping"); return };
        let report = super::analyze_pg(&p, &std::env::temp_dir()).await.expect("analyze standby");
        let ids: Vec<&str> = report.findings.iter().map(|f| f.id.as_str()).collect();

        assert!(ids.contains(&"pg-in-recovery"), "standby not detected: {ids:?}");
        // A standby does not archive WAL — flagging it would be noise. The
        // unit test for this could only use synthetic data.
        assert!(!ids.contains(&"pg-archive-mode-off"),
                "archive_mode must not be flagged on a standby");
        println!("  standby score {} · {} findings · in-recovery detected",
                 report.score.total, report.findings.len());
        p.close().await;
    }

    #[tokio::test]
    #[ignore]
    async fn pg_standby_primary_reports_the_connected_replica() {
        let Some(primary) = pool(5434).await else { return };
        let Some(standby) = pool(5436).await else { println!("no standby — skipping"); return };

        let d = super::pg_collectors::collect(&primary).await.expect("collect primary");
        assert!(!d.in_recovery, "5434 should be the primary");
        assert!(d.replica_count >= 1, "primary sees no replica (count={})", d.replica_count);
        println!("  primary sees {} replica(s), max lag {} bytes",
                 d.replica_count, d.max_replica_lag_bytes);

        let s = super::pg_collectors::collect(&standby).await.expect("collect standby");
        assert!(s.in_recovery, "5436 should be in recovery");
        // Several collector probes are primary-only functions that RAISE
        // rather than return NULL, so a standby is the only way to prove the
        // whole collection survives one.
        assert!(!s.settings.is_empty(), "settings not collected on standby");
        assert!(s.db_bytes > 0, "database size not collected on standby");
        assert!(s.roles.is_some(), "roles not collected on standby");
        // NOT asserted: checkpoint counters. A standby performs RESTARTPOINTS,
        // which are counted separately (restartpoints_timed/_req), so
        // num_timed/num_requested legitimately stay at zero on a replica.
        println!("  standby collected {} settings, {} bytes, ckpt {}+{} (restartpoints not counted here)",
                 s.settings.len(), s.db_bytes, s.ckpt_timed, s.ckpt_req);

        primary.close().await;
        standby.close().await;
    }

    #[tokio::test]
    #[ignore]
    async fn pg_standby_replication_query_succeeds_on_both_roles() {
        // The exact statement commands/ops.rs runs — it must return a row on a
        // primary AND on a standby.
        for port in [5434_u16, 5436] {
            let Some(p) = pool(port).await else { continue };
            let r = crate::db::postgres::execute(&p, crate::commands::ops::PG_STANDBY_SQL_FOR_TEST)
                .await.unwrap_or_else(|e| panic!("{port}: replication query failed: {e}"));
            assert_eq!(r.rows.len(), 1, "{port}: expected exactly one row");
            println!("  :{port} in_recovery={:?}", r.rows[0][0]);
            p.close().await;
        }
    }
}

#[cfg(test)]
mod redis_live_tests {
    //! The Redis tuner against the local server (127.0.0.1:6379).
    //!
    //!   cargo test --lib redis_tuner_live -- --ignored --nocapture
    use crate::db::types::{ConnectionConfig, Engine, LiveSession, SslMode};

    async fn mgr() -> Option<::redis::aio::ConnectionManager> {
        let mut c = ConnectionConfig::new(Engine::Redis, "redis");
        c.host = Some("127.0.0.1".into());
        c.port = Some(6379);
        c.ssl_mode = SslMode::Disable;
        match crate::db::redis::open(&c, None, None).await.ok()? {
            LiveSession::Redis(m, _) => Some(m),
            _ => None,
        }
    }

    #[tokio::test]
    #[ignore]
    async fn redis_tuner_live_report() {
        let Some(m) = mgr().await else { println!("no redis on 6379 — skipping"); return };
        let report = super::analyze_redis(&m, &std::env::temp_dir()).await.expect("analyze");

        println!("\n=== Redis {} ({}) ===", report.server.version, report.server.flavor);
        if let Some(e) = &report.eol {
            println!("eol:   {} {} → {} (date {:?}, source {})",
                     e.product, e.cycle, e.status, e.eol_date, e.source);
        }
        println!("score: {} total (perf {}/40, sec {}/30, res {}/30)",
                 report.score.total, report.score.performance,
                 report.score.security, report.score.resilience);
        for f in &report.findings {
            println!("  [{:8}] {:26} {}", f.severity, f.id, f.title);
        }

        // ── Report contract, identical to the SQL engines ────────────────
        let json = serde_json::to_value(&report).unwrap();
        assert!(json.get("generated_at").is_some());
        assert!(json.pointer("/server/uptime_secs").is_some());
        assert!(json.pointer("/score/performance").is_some());
        for f in &report.findings {
            assert!(["performance", "security", "resilience", "schema", "config"]
                .contains(&f.category.as_str()), "bad category {}", f.category);
            assert!(["ok", "info", "advice", "warn", "critical"]
                .contains(&f.severity.as_str()), "bad severity {}", f.severity);
            assert_eq!(f.points_lost, match f.severity.as_str() {
                "critical" => 10, "warn" => 5, "advice" => 2, _ => 0,
            }, "points/severity mismatch on {}", f.id);
        }
        assert_eq!(report.server.flavor, "redis");
        assert!(report.score.total <= 100);

        // Collectors must actually have run.
        let ids: Vec<&str> = report.findings.iter().map(|f| f.id.as_str()).collect();
        assert!(ids.contains(&"r-version"), "no version finding — INFO failed");
        assert!(ids.contains(&"r-hit-rate"), "no hit rate — INFO stats not parsed");

        // The dev server ships maxmemory=0, noeviction, no password and no
        // AOF, so these must be detected on it specifically.
        assert!(ids.contains(&"r-maxmemory-unset"), "maxmemory=0 not detected: {ids:?}");
        assert!(ids.contains(&"r-no-password"), "empty requirepass not detected: {ids:?}");
    }

    #[tokio::test]
    #[ignore]
    async fn redis_tuner_live_collector_reads_everything() {
        let Some(m) = mgr().await else { return };
        let d = super::redis_collectors::collect(&m).await.expect("collect");
        assert!(!d.info.is_empty(), "INFO not parsed");
        assert!(!d.config.is_empty(), "CONFIG GET not parsed");
        assert!(d.major >= 5, "version not parsed: {}", d.version);
        assert!(d.total_keys > 0, "keyspace totals not parsed");
        assert!(d.slowlog_len >= 0, "SLOWLOG LEN unreadable");
        assert!(!d.acl_users.is_empty(), "ACL LIST unreadable");
        println!("  redis {} · {} INFO fields · {} config · {} keys ({} volatile) · {} acl users",
                 d.version, d.info.len(), d.config.len(), d.total_keys, d.volatile_keys,
                 d.acl_users.len());
    }
}

#[cfg(test)]
mod bloat_live_tests {
    //! Live validation of the index-fragmentation & bloat advisor
    //! (plan-priorities.md #25 / plan-dba-focus.md Workstream 3 Part A) against
    //! the local dev servers: MySQL 8.4 on 3307, PostgreSQL 18 on 5432,
    //! PostgreSQL 13 on 55423, PostgreSQL 12 on 55422 (all root/root).
    //! Every test PROVOKES the state its rule detects and asserts the finding;
    //! fixtures are dropped up front (so re-runs are clean) and at the end.
    //!
    //!   cargo test --lib bloat_live -- --ignored --nocapture
    //!
    //! A server that is not listening is skipped with a printed note.
    //!
    //! Documented-only (cannot be provoked in a test):
    //!   - MySQL `schema.unused_indexes` WARN escalation requires server uptime
    //!     ≥ 7 days (checks.rs 42c) — a dev server restarted for the run can
    //!     never satisfy that. The advice path is asserted live; the warn gate
    //!     is covered by unit tests in checks.rs.
    //!   - A clean-fixture ABSENCE assertion for the MySQL findings is not
    //!     meaningful on a shared dev server (other schemas may already be
    //!     fragmented); attribution is proven via information_schema instead.
    //!     The PG findings DO get absence assertions — pg_stat_user_tables is
    //!     per-database, so a freshly created fixture DB is provably clean.

    use crate::db::types::{ConnectionConfig, Engine, SslMode};

    const MYSQL_PORT: u16 = 3307;
    /// 12.22 / 13.23 / 18 — the catalogs the bloat probes read predate 12,
    /// so a finding on every port proves reachability across supported majors.
    const PG_PORTS: [u16; 3] = [55422, 55423, 5432];

    fn mysql_config(db: Option<&str>) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Mysql, format!("mysql-{MYSQL_PORT}"));
        c.host = Some("127.0.0.1".into());
        c.port = Some(MYSQL_PORT);
        c.user = Some("root".into());
        c.database = db.map(str::to_string);
        c.ssl_mode = SslMode::Disable;
        c
    }

    async fn mysql_pool(db: Option<&str>) -> Option<sqlx::MySqlPool> {
        crate::db::mysql::open_pool(&mysql_config(db), Some("root".into()), None, 2).await.ok()
    }

    fn pg_config(port: u16, db: &str) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Postgres, format!("pg-{port}"));
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.user = Some("root".into());
        c.database = Some(db.into());
        c.ssl_mode = SslMode::Disable;
        c
    }

    async fn pg_pool(port: u16, db: &str) -> Option<sqlx::PgPool> {
        crate::db::postgres::open_pool(&pg_config(port, db), Some("root".into()), None, 2).await.ok()
    }

    /// Test-only fixture SQL — every string is a literal or built from the
    /// constant fixture names above, hence the AssertSqlSafe wrap.
    async fn pg_exec(pool: &sqlx::PgPool, sql: impl Into<String>) {
        let sql = sql.into();
        sqlx::query(sqlx::AssertSqlSafe(sql.clone())).execute(pool).await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    /// Tolerating variant for best-effort cleanup.
    async fn pg_try(pool: &sqlx::PgPool, sql: impl Into<String>) {
        let _ = sqlx::query(sqlx::AssertSqlSafe(sql.into())).execute(pool).await;
    }

    /// Drop + recreate the fixture DB and return a pool connected to it.
    /// PG 12 has no DROP DATABASE ... WITH (FORCE), so stragglers are
    /// terminated explicitly.
    async fn pg_fresh_db(port: u16, db: &str) -> Option<sqlx::PgPool> {
        let admin = pg_pool(port, "postgres").await?;
        let _ = sqlx::query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
             WHERE datname = $1 AND pid <> pg_backend_pid()")
            .bind(db).execute(&admin).await;
        pg_try(&admin, format!("DROP DATABASE IF EXISTS {db}")).await;
        pg_exec(&admin, format!("CREATE DATABASE {db}")).await;
        admin.close().await;
        pg_pool(port, db).await
    }

    async fn pg_drop_db(port: u16, db: &str) {
        if let Some(admin) = pg_pool(port, "postgres").await {
            let _ = sqlx::query(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
                 WHERE datname = $1 AND pid <> pg_backend_pid()")
                .bind(db).execute(&admin).await;
            pg_try(&admin, format!("DROP DATABASE IF EXISTS {db}")).await;
            admin.close().await;
        }
    }

    /// n_live_tup/n_dead_tup only move once the stats are flushed: 15+ can be
    /// forced with pg_stat_force_next_flush(), on 12/13 the collector latency
    /// is ~1 s — so poll (up to 30 s) instead of sleeping a fixed amount.
    async fn pg_wait_dead_tuples(pool: &sqlx::PgPool, table: &str, min_dead: i64) -> i64 {
        for _ in 0..60 {
            let _ = sqlx::query("SELECT pg_stat_force_next_flush()").execute(pool).await;
            let dead: i64 = sqlx::query_scalar(
                "SELECT COALESCE((SELECT n_dead_tup FROM pg_stat_user_tables \
                  WHERE relname = $1), 0)")
                .bind(table).fetch_one(pool).await.unwrap_or(0);
            if dead >= min_dead { return dead; }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        panic!("stats never showed {min_dead} dead tuples on {table}");
    }

    /// The index-bloat probe reads pg_stat_user_indexes, whose rows only exist
    /// once the relation has been touched through the stats subsystem.
    async fn pg_wait_stat_index(pool: &sqlx::PgPool, table: &str, index: &str) {
        for _ in 0..60 {
            pg_try(pool, format!("SELECT 1 FROM {table} LIMIT 1")).await;
            let _ = sqlx::query("SELECT pg_stat_force_next_flush()").execute(pool).await;
            let n: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_user_indexes WHERE indexrelname = $1")
                .bind(index).fetch_one(pool).await.unwrap_or(0);
            if n > 0 { return; }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        panic!("pg_stat_user_indexes never listed {index}");
    }

    /// checks.rs 42b: per-table DATA_FREE ≥10% AND ≥10 MiB lists the table;
    /// ≥20% AND ≥100 MiB escalates to warn. Provoke both: ~330 MiB of rows,
    /// then delete the contiguous top half — only CONTIGUOUS deletes free whole
    /// extents, and DATA_FREE counts free extents (verified on 8.4: an
    /// interleaved id%2=0 delete of half the rows moved DATA_FREE by nothing).
    #[tokio::test]
    #[ignore]
    async fn mysql_live_table_fragmentation_warns_after_mass_delete() {
        let Some(admin) = mysql_pool(None).await else {
            println!("no MySQL on {MYSQL_PORT} — skipping"); return;
        };
        // information_schema_stats_expiry caches TABLES stats for up to
        // 86400 s — set the global default to 0 BEFORE opening the analyzer
        // pool so its sessions read live tablespace stats. Restored below.
        // (BIGINT UNSIGNED — decode as u64.)
        let prev_expiry: u64 = sqlx::query_scalar("SELECT @@GLOBAL.information_schema_stats_expiry")
            .fetch_one(&admin).await.expect("read information_schema_stats_expiry");
        pgless_exec(&admin, "SET GLOBAL information_schema_stats_expiry = 0").await;
        pgless_exec(&admin, "DROP DATABASE IF EXISTS txui_bloat_frag").await;
        pgless_exec(&admin, "CREATE DATABASE txui_bloat_frag").await;

        let fx = mysql_pool(Some("txui_bloat_frag")).await.expect("fixture pool");
        pgless_exec(&fx, "CREATE TABLE frag (id BIGINT AUTO_INCREMENT PRIMARY KEY, payload MEDIUMTEXT) ENGINE=InnoDB").await;
        // 500 rows × 16 KiB per batch ≈ 8 MiB — well under max_allowed_packet.
        for _ in 0..20 {
            pgless_exec(&fx,
                "INSERT INTO frag (payload) SELECT REPEAT('x', 16000) FROM \
                 (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) a, \
                 (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) b, \
                 (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) c, \
                 (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) d").await;
        }
        pgless_exec(&fx, "DELETE FROM frag WHERE id > 5000").await;
        pgless_exec(&fx, "ANALYZE TABLE frag").await;

        // Deleted pages only become free EXTENTS (which is what DATA_FREE
        // counts) once InnoDB purge has removed the delete-marked records —
        // poll until the freed space shows up (session expiry is 0, so every
        // read is fresh). The ids have small auto-increment gaps from
        // INSERT...SELECT chunk allocation, so don't assert exact counts.
        let mut total = 0.0_f64;
        let mut free = 0.0_f64;
        for _ in 0..120 {
            (total, free) = sqlx::query_as(
                "SELECT CAST(DATA_LENGTH + INDEX_LENGTH AS DOUBLE), CAST(DATA_FREE AS DOUBLE) \
                 FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = 'txui_bloat_frag' AND TABLE_NAME = 'frag'")
                .fetch_one(&fx).await.expect("fixture row in information_schema");
            if free >= 100.0 * 1024.0 * 1024.0 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let pct = free * 100.0 / total;
        println!("  provoked: {} free of {} ({pct:.1}%)", free as u64, total as u64);
        assert!(free >= 100.0 * 1024.0 * 1024.0, "provocation failed: DATA_FREE {free}");
        assert!(pct >= 20.0, "provocation failed: {pct}% fragmented");

        let report = super::analyze(&fx, &std::env::temp_dir()).await.expect("analyze");
        let f = report.findings.iter().find(|f| f.id == "schema.table_fragmentation")
            .expect("no schema.table_fragmentation finding");
        assert_eq!(f.severity, "warn", "20% AND 100 MiB both provoked — must warn: {f:?}");
        assert!(f.detail.contains("txui_bloat_frag.frag"),
                "fixture table not the top offender: {}", f.detail);
        assert!(f.fix_sql.iter().any(|s| s.contains("ALGORITHM=INPLACE")),
                "fix SQL must mention ALGORITHM=INPLACE: {:?}", f.fix_sql);
        println!("  [{}] {} — {}", f.severity, f.id, f.title);

        fx.close().await;
        pgless_exec(&admin, "DROP DATABASE IF EXISTS txui_bloat_frag").await;
        pgless_exec(&admin, &format!("SET GLOBAL information_schema_stats_expiry = {prev_expiry}")).await;
        admin.close().await;
    }

    /// checks.rs 42c: secondary indexes with zero reads since server start.
    /// The fixture index is written but never read, so sys.schema_unused_indexes
    /// lists it immediately (verified: count_star stays 0 for write-only use).
    #[tokio::test]
    #[ignore]
    async fn mysql_live_unused_indexes_advice_for_never_read_index() {
        let Some(admin) = mysql_pool(None).await else {
            println!("no MySQL on {MYSQL_PORT} — skipping"); return;
        };
        pgless_exec(&admin, "DROP DATABASE IF EXISTS txui_bloat_unused").await;
        pgless_exec(&admin, "CREATE DATABASE txui_bloat_unused").await;
        let fx = mysql_pool(Some("txui_bloat_unused")).await.expect("fixture pool");
        pgless_exec(&fx, "CREATE TABLE t (id BIGINT AUTO_INCREMENT PRIMARY KEY, k BIGINT, KEY never_read (k)) ENGINE=InnoDB").await;
        pgless_exec(&fx, "INSERT INTO t (k) VALUES (1),(2),(3)").await;

        // Attribution: the sys view must list OUR index (server-wide absence
        // is not assertable — other schemas on a dev server legitimately have
        // unused indexes of their own).
        let listed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sys.schema_unused_indexes \
             WHERE object_schema = 'txui_bloat_unused' AND index_name = 'never_read'")
            .fetch_one(&fx).await.unwrap_or(0);
        assert_eq!(listed, 1, "fixture index not visible in sys.schema_unused_indexes");

        let report = super::analyze(&fx, &std::env::temp_dir()).await.expect("analyze");
        let f = report.findings.iter().find(|f| f.id == "schema.unused_indexes")
            .expect("no schema.unused_indexes finding");
        assert!(!f.fix_sql.is_empty(), "advice must carry DROP INDEX fix SQL");
        assert!(f.fix_sql.iter().all(|s| s.contains("ALGORITHM=INPLACE")),
                "drop fixes must be online: {:?}", f.fix_sql);
        // Warn escalation needs a ≥1 GiB table AND uptime ≥ 7 days; the 7-day
        // gate cannot be provoked on a freshly restarted dev server, so the
        // warn path is unit-tested in checks.rs and only the advice path is
        // asserted here (guarded, in case this box is ever left up that long).
        if report.server.uptime_secs < 7 * 86400 {
            assert_eq!(f.severity, "advice",
                       "uptime {} < 7d — warn gate must not fire", report.server.uptime_secs);
            assert!(f.detail.contains("uptime is only"),
                    "short-uptime caveat missing: {}", f.detail);
        } else {
            println!("  uptime {} ≥ 7d — warn gate legitimately active, severity not asserted",
                     report.server.uptime_secs);
        }
        println!("  [{}] {} — {}", f.severity, f.id, f.title);

        fx.close().await;
        pgless_exec(&admin, "DROP DATABASE IF EXISTS txui_bloat_unused").await;
        admin.close().await;
    }

    /// pg_checks.rs `pg-bloat`: n_dead_tup > 20% of n_live_tup (min 1000 live).
    /// autovacuum is disabled per table, and last_vacuum/last_autovacuum stay
    /// NULL — so the "never vacuumed" staleness wording must appear.
    #[tokio::test]
    #[ignore]
    async fn pg_bloat_live_dead_tuples_never_vacuumed() {
        for port in PG_PORTS {
            let Some(fx) = pg_fresh_db(port, "txui_bloat_dt").await else {
                println!("no PG on {port} — skipping"); continue;
            };
            // Clean-fixture absence: a fresh database must NOT report bloat.
            let clean = super::analyze_pg(&fx, &std::env::temp_dir()).await.expect("analyze clean");
            assert!(!clean.findings.iter().any(|f| f.id == "pg-bloat"),
                    "{port}: pg-bloat on a freshly created database?");

            // High threshold keeps this table out of the autovacuum-behind
            // check — isolation between findings, not part of the provocation.
            pg_exec(&fx, "CREATE TABLE bloated (id bigint GENERATED ALWAYS AS IDENTITY, pad text) \
                          WITH (autovacuum_enabled = false, autovacuum_vacuum_threshold = 100000, \
                                autovacuum_vacuum_scale_factor = 0)").await;
            pg_exec(&fx, "INSERT INTO bloated (pad) SELECT md5(g::text) FROM generate_series(1, 3000) g").await;
            pg_exec(&fx, "DELETE FROM bloated WHERE id % 2 = 0").await; // 1500 dead / 1500 live
            let dead = pg_wait_dead_tuples(&fx, "bloated", 1500).await;

            let report = super::analyze_pg(&fx, &std::env::temp_dir()).await.expect("analyze");
            let f = report.findings.iter().find(|f| f.id == "pg-bloat")
                .unwrap_or_else(|| panic!("{port}: no pg-bloat finding (dead={dead})"));
            assert_eq!(f.severity, "warn", "{port}: pg-bloat is warn by construction");
            assert!(f.detail.contains("public.bloated"), "{port}: {}", f.detail);
            assert!(f.detail.contains("never vacuumed"), "{port}: staleness wording: {}", f.detail);
            assert!(f.fix_sql.iter().any(|s| s.contains("VACUUM (ANALYZE, VERBOSE) public.bloated;")),
                    "{port}: fix SQL: {:?}", f.fix_sql);
            println!("  :{port} {} — [{}] pg-bloat, dead={dead}",
                     report.server.version.split_whitespace().take(2).collect::<Vec<_>>().join(" "),
                     f.severity);

            fx.close().await;
            pg_drop_db(port, "txui_bloat_dt").await;
        }
    }

    /// pg_checks.rs `pg-autovacuum-behind`: dead tuples > 1.5× the EFFECTIVE
    /// threshold (reloptions honored: threshold=50, scale_factor=0 → 50).
    /// lag_small at 3× provokes the listing, lag_big at 6× the warn (>5×).
    #[tokio::test]
    #[ignore]
    async fn pg_autovacuum_behind_live_reloptions_threshold() {
        for port in PG_PORTS {
            let Some(fx) = pg_fresh_db(port, "txui_bloat_av").await else {
                println!("no PG on {port} — skipping"); continue;
            };
            let clean = super::analyze_pg(&fx, &std::env::temp_dir()).await.expect("analyze clean");
            assert!(!clean.findings.iter().any(|f| f.id == "pg-autovacuum-behind"),
                    "{port}: autovacuum-behind on a freshly created database?");

            let relopts = "WITH (autovacuum_enabled = false, autovacuum_vacuum_threshold = 50, \
                                 autovacuum_vacuum_scale_factor = 0)";
            pg_exec(&fx, &format!("CREATE TABLE lag_small (id int) {relopts}")).await;
            pg_exec(&fx, &format!("CREATE TABLE lag_big (id int) {relopts}")).await;
            pg_exec(&fx, "INSERT INTO lag_small SELECT generate_series(1, 200)").await;
            pg_exec(&fx, "DELETE FROM lag_small WHERE id <= 150").await; // 150 dead = 3× threshold
            pg_exec(&fx, "INSERT INTO lag_big SELECT generate_series(1, 400)").await;
            pg_exec(&fx, "DELETE FROM lag_big WHERE id <= 300").await;   // 300 dead = 6× threshold
            pg_wait_dead_tuples(&fx, "lag_small", 150).await;
            pg_wait_dead_tuples(&fx, "lag_big", 300).await;

            let report = super::analyze_pg(&fx, &std::env::temp_dir()).await.expect("analyze");
            let f = report.findings.iter().find(|f| f.id == "pg-autovacuum-behind")
                .unwrap_or_else(|| panic!("{port}: no pg-autovacuum-behind finding"));
            assert_eq!(f.severity, "warn", "{port}: worst ratio 6× > 5× must warn: {}", f.title);
            assert!(f.title.contains("6.0×"), "{port}: worst ratio in title: {}", f.title);
            assert!(f.detail.contains("public.lag_small") && f.detail.contains("public.lag_big"),
                    "{port}: {}", f.detail);
            assert!(f.fix_sql.iter().any(|s| s.contains("autovacuum_vacuum_scale_factor")),
                    "{port}: tuning fix missing: {:?}", f.fix_sql);
            println!("  :{port} [{}] {}", f.severity, f.title);

            fx.close().await;
            pg_drop_db(port, "txui_bloat_av").await;
        }
    }

    /// pg_checks.rs `pg-index-bloat` / pg_collectors.rs: without pgstattuple a
    /// large index bigger than its heap is the heuristic flag (advice); with it,
    /// pgstatindex measures leaf density and ≥50% waste escalates to warn.
    ///
    /// The heuristic is provoked with ~400-char text keys: a single-column
    /// table's btree outgrows its heap (index tuple overhead on top of the
    /// same bytes — verified 103 MiB index vs 91 MiB heap on PG 12 and 18).
    /// The keys must stay well under the index-tuple size limit (~1/3 page):
    /// at 700 chars the btree compresses them in place and the index SHRINKS
    /// to ~50 B/entry on every major — an earlier version of this fixture
    /// failed exactly that way.
    ///
    /// pgstattuple availability on this box: PG 18 (Homebrew) ships it; the
    /// source-built 12/13 installs do not — so the measured path is asserted on
    /// 5432 and the missing-extension hint on 55422/55423, with the branch
    /// chosen at runtime from pg_available_extensions.
    #[tokio::test]
    #[ignore]
    async fn pg_index_bloat_live_heuristic_and_pgstattuple() {
        for port in PG_PORTS {
            let Some(fx) = pg_fresh_db(port, "txui_bloat_ib").await else {
                println!("no PG on {port} — skipping"); continue;
            };
            let clean = super::analyze_pg(&fx, &std::env::temp_dir()).await.expect("analyze clean");
            assert!(!clean.findings.iter().any(|f| f.id == "pg-index-bloat"),
                    "{port}: index bloat on a freshly created database?");

            pg_exec(&fx, "CREATE TABLE idx_bloat (id bigint GENERATED ALWAYS AS IDENTITY, k text)").await;
            pg_exec(&fx, "INSERT INTO idx_bloat (k) \
                          SELECT repeat('x', 400) || g::text FROM generate_series(1, 200000) g").await;
            pg_exec(&fx, "CREATE INDEX idx_bloat_k ON idx_bloat (k)").await;

            // The provocation itself: index ≥ 64 MiB AND larger than the heap.
            let (heap, idx): (i64, i64) = sqlx::query_as(
                "SELECT pg_relation_size('idx_bloat'), pg_relation_size('idx_bloat_k')")
                .fetch_one(&fx).await.expect("relation sizes");
            println!("  :{port} provoked: index {} vs heap {}", idx, heap);
            assert!(idx >= 64 * 1024 * 1024 && idx > heap,
                    "{port}: fixture failed — heap={heap} index={idx}");
            pg_wait_stat_index(&fx, "idx_bloat", "idx_bloat_k").await;

            let ext_avail: bool = sqlx::query_scalar(
                "SELECT count(*) > 0 FROM pg_available_extensions WHERE name = 'pgstattuple'")
                .fetch_one(&fx).await.unwrap_or(false);
            if ext_avail {
                pg_exec(&fx, "CREATE EXTENSION pgstattuple").await;
                // Measured bloat: delete 90% then VACUUM — dead entries are
                // removed but sparse pages stay, so leaf density collapses
                // (measured: 14% → 86% waste, over the 50% warn line).
                pg_exec(&fx, "DELETE FROM idx_bloat WHERE id % 10 <> 0").await;
                pg_exec(&fx, "VACUUM idx_bloat").await;
            }

            let report = super::analyze_pg(&fx, &std::env::temp_dir()).await.expect("analyze");
            let f = report.findings.iter().find(|f| f.id == "pg-index-bloat")
                .unwrap_or_else(|| panic!("{port}: no pg-index-bloat finding"));
            assert!(f.detail.contains("public.idx_bloat_k"), "{port}: {}", f.detail);
            assert!(f.fix_sql.iter().any(|s| s.contains("REINDEX INDEX")),
                    "{port}: fix SQL: {:?}", f.fix_sql);
            if ext_avail {
                assert!(f.detail.contains("measured leaf density"),
                        "{port}: pgstatindex measurement missing: {}", f.detail);
                assert_eq!(f.severity, "warn",
                           "{port}: 90% delete + VACUUM leaves ≥50% waste — must warn: {}", f.detail);
                println!("  :{port} [{}] pg-index-bloat measured via pgstattuple", f.severity);
            } else {
                assert_eq!(f.severity, "advice", "{port}: heuristic-only must stay advice");
                assert!(f.detail.contains("bloat heuristic"), "{port}: {}", f.detail);
                let rec = f.recommendation.as_deref().unwrap_or("");
                assert!(rec.contains("CREATE EXTENSION pgstattuple"),
                        "{port}: missing-extension hint absent: {rec}");
                println!("  :{port} [{}] pg-index-bloat heuristic — pgstattuple not available, hint asserted",
                         f.severity);
            }

            fx.close().await;
            pg_drop_db(port, "txui_bloat_ib").await;
        }
    }

    /// sqlx::query(...).execute for the MySQL pool — named to keep the two
    /// drivers' call sites visually distinct in this module. Same AssertSqlSafe
    /// rationale as pg_exec: test-only literal fixture SQL.
    async fn pgless_exec(pool: &sqlx::MySqlPool, sql: impl Into<String>) {
        let sql = sql.into();
        sqlx::query(sqlx::AssertSqlSafe(sql.clone())).execute(pool).await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
}

