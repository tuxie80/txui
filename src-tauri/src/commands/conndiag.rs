//! Staged connection diagnostics (W3.1) — `connect_test_staged`.
//!
//! A plain Test button answers "ok" or "no" and leaves the user to guess which
//! of the six things between the UI and the server broke. This command runs
//! the same connect as discrete stages — DNS → TCP → SSH tunnel → TLS → auth →
//! probe — each with its own ok/fail/skipped, elapsed ms and detail,
//! short-circuiting on the first failure (later stages are reported
//! `skipped` with "not reached", never silently omitted: a checklist UI needs
//! a stable shape).
//!
//! Honesty rules, because a fabricated stage is worse than no stage:
//! - sqlx (MySQL/PG) negotiates TLS *inside* connect and exposes no handshake
//!   readout, so the TLS stage there is measured by a post-auth probe
//!   (`Ssl_*` status / `pg_stat_ssl`) and says so;
//! - Redis/MongoDB report the scheme decision the W1.6 dial actually made
//!   (including a Preferred plaintext fallback);
//! - ClickHouse (scheme-by-port, no negotiation) and SQL Server (TLS inside
//!   the TDS login, no cipher readout from tiberius) report the configured
//!   posture once auth has proven the connection — the detail names what was
//!   and was not measured.
//!
//! Credentials never appear in stage details: errors come from the drivers'
//! already-sanitized formatters (sqlx connect errors run through
//! `fmt_conn_error` inside `connect_bounded`).

use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::State;

use crate::db::types::{ConnectionConfig, Engine, LiveSession, SslMode};
use crate::db::{clickhouse, connection, duckdb, mongodb, mysql, parquet, postgres, redis, sqlite, sqlserver};
use crate::state::AppState;

use super::connections::{
    open_tunnel, resolve_test_password, resolve_test_secret, stored_ssh_password, with_default_timeout,
};

/// One stage's outcome, exactly as serialized to the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StageStatus {
    Ok,
    Fail,
    /// Not applicable to this config/engine, or not reached because an
    /// earlier stage failed — `detail` says which.
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectStage {
    /// Stable machine id: "dns" | "tcp" | "ssh" | "tls" | "auth" | "probe".
    pub id: &'static str,
    pub label: String,
    pub status: StageStatus,
    pub ms: u64,
    /// What was measured, where it connected, or why it failed/was skipped.
    /// Absent (not null) when there is nothing worth saying.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectVerdict {
    /// Every applicable stage passed.
    Ok,
    /// The first failing stage stopped the run.
    Fail,
}

#[derive(Debug, Clone, Serialize)]
pub struct StagedConnectResult {
    pub stages: Vec<ConnectStage>,
    pub total_ms: u64,
    pub verdict: ConnectVerdict,
}

/// What the TLS stage can honestly measure on a given engine — see the module
/// docs for why these differ.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TlsMeasure {
    /// sqlx (MySQL/PG): negotiated inside connect; measured by a probe query
    /// on the authed connection (Ssl_* status / pg_stat_ssl).
    ProbeAfterAuth,
    /// Redis/MongoDB: the scheme the dial actually used (W1.6 fallback) —
    /// known once auth has run, at no extra cost.
    SchemeFromAuth,
    /// SQL Server: TLS rides the TDS login; tiberius exposes no negotiated
    /// cipher. The detail states the configured EncryptionLevel.
    SqlServer,
    /// ClickHouse: TLS is the URL scheme, chosen by ssl_mode + port
    /// (ch_scheme); computed at fill time because an SSH tunnel rewrites the
    /// effective port.
    ClickHouse,
}

/// One stage in the plan. `skip_reason: Some` stages are reported `skipped`
/// without running. The plan always contains all six stages in canonical
/// order — the runner fills in outcomes.
#[derive(Debug, Clone)]
struct PlannedStage {
    id: &'static str,
    label: String,
    skip_reason: Option<String>,
    /// dns/tcp: the dial target, named in the detail line. With an SSH tunnel
    /// configured this is the SSH ENDPOINT — the DB host resolves and answers
    /// on the far side of the tunnel, so dialing it from here would measure
    /// the wrong thing entirely.
    target: Option<(String, u16, bool /* via_ssh */)>,
    tls: Option<TlsMeasure>,
}

/// The stage plan for a config: which stages apply, which are skipped (with
/// the reason on the stage), and what dns/tcp will dial. Pure — the unit
/// tests drive this without any network.
fn plan_stages(config: &ConnectionConfig) -> Vec<PlannedStage> {
    let file_backed = config.engine.is_file_backed();
    // A Unix socket replaces the whole network path (MySQL/PG only — the
    // field is ignored by every other driver). A tunnel overrides the socket.
    let socket = matches!(config.engine, Engine::Mysql | Engine::Postgres)
        && !config.use_ssh
        && config.socket_path.as_deref().is_some_and(|s| !s.trim().is_empty());
    // mongodb+srv resolves its seed list through DNS SRV records in the
    // driver; the host is a discovery domain, not an endpoint (dialing it
    // would measure nothing — see build_uri_tls).
    let srv = config.engine == Engine::MongoDb
        && !config.use_ssh
        && config.extra_params.get("srv")
            .map(|v| { let v = v.trim(); v.eq_ignore_ascii_case("true") || v == "1" })
            .unwrap_or(false);

    let (host, port, via_ssh) = if config.use_ssh && !file_backed {
        (
            config.ssh_host.clone().unwrap_or_default(),
            config.ssh_port.unwrap_or(22),
            true,
        )
    } else {
        (
            config.host.clone().unwrap_or_else(|| "localhost".into()),
            config.port.unwrap_or(config.engine.default_port()),
            false,
        )
    };
    // The drivers pin localhost → 127.0.0.1 on plain TCP dials (the macOS
    // ::1 trap); mirror that or the DNS stage would measure a resolution the
    // dial never performs.
    let host = if !via_ssh && !socket && !srv {
        crate::db::util::pin_localhost(&host).to_string()
    } else {
        host
    };
    let host_missing = host.trim().is_empty();
    let literal_ip = host.parse::<std::net::IpAddr>().is_ok();
    let target = || Some((host.clone(), port, via_ssh));

    let dns_skip = if file_backed {
        Some("file-backed engine — nothing to resolve".to_string())
    } else if socket {
        Some("Unix socket connection — no DNS lookup".to_string())
    } else if srv {
        Some("mongodb+srv — the driver resolves the seed list via DNS SRV records".to_string())
    } else if host_missing {
        Some(if via_ssh { "SSH host is not configured".to_string() } else { "no host configured".to_string() })
    } else if literal_ip {
        Some(format!("{host} is a literal IP — nothing to resolve"))
    } else {
        None
    };

    let tcp_skip = if file_backed {
        Some("file-backed engine — nothing to dial".to_string())
    } else if socket {
        Some(format!("Unix socket connection ({}) — no TCP dial",
            config.socket_path.as_deref().unwrap_or_default()))
    } else if srv {
        Some("mongodb+srv — the driver dials the hosts the SRV lookup returns".to_string())
    } else if host_missing {
        Some(if via_ssh { "SSH host is not configured".to_string() } else { "no host configured".to_string() })
    } else {
        None
    };

    let ssh_skip = if !config.use_ssh {
        Some("no SSH tunnel configured".to_string())
    } else if file_backed {
        Some("file-backed engine — a tunnel has nothing to forward".to_string())
    } else {
        None
    };

    let tls_measure: Option<TlsMeasure>;
    let tls_skip: Option<String>;
    if file_backed {
        tls_measure = None;
        tls_skip = Some("file-backed engine — no transport encryption".to_string());
    } else if matches!(config.ssl_mode, SslMode::Disable) {
        tls_measure = None;
        tls_skip = Some("ssl_mode=disable — plaintext by configuration".to_string());
    } else {
        tls_skip = None;
        tls_measure = Some(match config.engine {
            Engine::Mysql | Engine::Postgres => TlsMeasure::ProbeAfterAuth,
            Engine::Redis | Engine::MongoDb => TlsMeasure::SchemeFromAuth,
            Engine::SqlServer => TlsMeasure::SqlServer,
            Engine::Clickhouse => TlsMeasure::ClickHouse,
            // Unreachable: file engines returned above.
            Engine::Sqlite | Engine::Parquet | Engine::Duckdb => TlsMeasure::SchemeFromAuth,
        });
    }

    vec![
        PlannedStage {
            id: "dns", label: "DNS resolution".into(),
            skip_reason: dns_skip,
            target: if file_backed || socket || srv { None } else { target() },
            tls: None,
        },
        PlannedStage {
            id: "tcp", label: "TCP connect".into(),
            skip_reason: tcp_skip,
            target: if file_backed || socket || srv { None } else { target() },
            tls: None,
        },
        PlannedStage {
            id: "ssh", label: "SSH tunnel".into(),
            skip_reason: ssh_skip, target: None, tls: None,
        },
        PlannedStage {
            id: "tls", label: "TLS handshake".into(),
            skip_reason: tls_skip, target: None, tls: tls_measure,
        },
        PlannedStage {
            id: "auth",
            label: if file_backed { "Open file".into() } else { "Authenticate".into() },
            skip_reason: None, target: None, tls: None,
        },
        PlannedStage {
            id: "probe", label: "Version probe".into(),
            skip_reason: None, target: None, tls: None,
        },
    ]
}

/// Diagnose a connection attempt in stages — DNS, TCP, SSH tunnel, TLS, auth,
/// probe — reporting each stage's status, elapsed ms and detail, and stopping
/// at the first failure. Used by the connection form's diagnostics view and
/// the sidebar's health indicator. Secrets follow the Test-button rules: an
/// explicit password wins, a blank one on a saved (non-nil id) config falls
/// back to the stored secret, and nothing is persisted.
///
/// A failed verdict is DATA, not a command error — this returns Ok with
/// `verdict: "fail"` and the failing stage carrying the detail.
#[tauri::command]
pub async fn connect_test_staged(
    config: ConnectionConfig,
    password: Option<String>,
    ssh_password: Option<String>,
    state: State<'_, AppState>,
) -> Result<StagedConnectResult, crate::apperror::AppError> {
    // The app-wide connect timeout, as on every connect path.
    let config = with_default_timeout(&config, &state);
    let saved = !config.id.is_nil();
    // A password-exec mint failure is not a command error — it becomes the
    // auth stage's failure detail (a failed verdict is DATA, above).
    let password = resolve_test_password(&config, password, &state.data_dir).await;
    let ssh_password = resolve_test_secret(
        ssh_password,
        if saved { stored_ssh_password(&config, &state.data_dir) } else { None },
        saved,
    );
    Ok(run_staged(&config, password, ssh_password).await)
}

/// Time-box one stage's future; on timeout the stage fails with a plain
/// "timed out" detail. Every stage is bounded by the connection's connect
/// timeout, so the whole run is bounded by (stages × timeout).
async fn bounded<T>(
    timeout: Duration,
    what: &str,
    fut: impl std::future::Future<Output = Result<T, String>>,
) -> (u64, Result<T, String>) {
    let start = Instant::now();
    let r = tokio::time::timeout(timeout, fut).await;
    let ms = start.elapsed().as_millis() as u64;
    match r {
        Ok(r) => (ms, r),
        Err(_) => (ms, Err(format!("{what} timed out after {}s", timeout.as_secs()))),
    }
}

async fn exec_dns(host: &str) -> Result<String, String> {
    // Port 0 — resolution only, no dial.
    let addrs: Vec<_> = tokio::net::lookup_host(format!("{host}:0"))
        .await
        .map_err(|e| format!("could not resolve {host}: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("{host} resolved to no addresses"));
    }
    let mut shown = addrs.iter().take(3).map(|a| a.ip().to_string()).collect::<Vec<_>>();
    if addrs.len() > 3 {
        shown.push(format!("(+{} more)", addrs.len() - 3));
    }
    Ok(format!("{host} → {}", shown.join(", ")))
}

async fn exec_tcp(host: &str, port: u16, via_ssh: bool) -> Result<String, String> {
    let stream = tokio::net::TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("TCP connect to {host}:{port} failed: {e}"))?;
    let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_else(|_| format!("{host}:{port}"));
    Ok(format!("connected to {peer}{}", if via_ssh { " (SSH endpoint)" } else { "" }))
}

/// The auth stage: the engine driver's REAL connect, on a throwaway
/// one-connection pool (sqlx) or a dedicated client. Returns the session
/// (kept for the TLS probe + version probe, then torn down), whether the
/// connection that succeeded uses TLS where the dial knows (Redis/MongoDB),
/// and an optional detail note (IAM).
async fn auth_open(
    config: &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,
) -> Result<(LiveSession, Option<bool>, Option<String>), String> {
    // Cloud SQL IAM: the mint is an HTTPS round trip inside the auth stage;
    // its cost lands in the stage's ms and its failures name the credential
    // file, not "Access denied" (see connection::iam_password).
    let iam = config.use_iam_auth && matches!(config.engine, Engine::Mysql | Engine::Postgres);
    let password = connection::iam_password(config, password)
        .await
        .map_err(|e| format!("{e:#}"))?;
    let note = iam.then(|| "authenticated with a freshly minted IAM token".to_string());

    let one_line = |e: anyhow::Error| format!("{e:#}");
    let (session, tls_used) = match config.engine {
        // max_connections(1): a throwaway pool proving one real dial, not a
        // session-sized pool.
        Engine::Mysql => (
            LiveSession::Mysql(mysql::open_pool(config, password, host_override, 1)
                .await.map_err(one_line)?),
            None,
        ),
        Engine::Postgres => (
            LiveSession::Postgres(postgres::open_pool(config, password, host_override, 1)
                .await.map_err(one_line)?),
            None,
        ),
        Engine::Redis => {
            let (mgr, client, tls) = redis::dial(config, password, host_override)
                .await.map_err(one_line)?;
            (LiveSession::Redis(mgr, client), Some(tls))
        }
        Engine::Clickhouse => {
            let s = clickhouse::open(config, password, host_override).map_err(one_line)?;
            // HTTP is stateless — building the client proves nothing, so the
            // auth stage includes the same SELECT 1 round trip open_session
            // runs.
            clickhouse::probe(&s).await.map_err(one_line)?;
            (LiveSession::Clickhouse(s), None)
        }
        Engine::Sqlite => (
            LiveSession::Sqlite(sqlite::open(config).await.map_err(one_line)?),
            None,
        ),
        Engine::Parquet => (
            LiveSession::Parquet(std::sync::Arc::new(
                parquet::open_async(config).await.map_err(one_line)?)),
            None,
        ),
        Engine::Duckdb => (
            LiveSession::Duckdb(std::sync::Arc::new(
                duckdb::open(config).await.map_err(one_line)?)),
            None,
        ),
        Engine::MongoDb => {
            let (client, tls) = mongodb::connect(config, password, host_override)
                .await.map_err(one_line)?;
            (LiveSession::MongoDb(client), Some(tls))
        }
        Engine::SqlServer => {
            // The driver takes host/port from the config; an active tunnel is
            // applied by rewriting them to the local forward (the same swap
            // connection::open_session does).
            let cfg = match host_override {
                Some((host, port)) => {
                    let mut c = config.clone();
                    c.host = Some(host.to_string());
                    c.port = Some(port);
                    c
                }
                None => config.clone(),
            };
            (
                LiveSession::SqlServer(sqlserver::open(&cfg, password).await.map_err(one_line)?),
                None,
            )
        }
    };
    Ok((session, tls_used, note))
}

async fn exec_probe(session: &LiveSession) -> Result<String, String> {
    connection::probe_session(session)
        .await
        .map(|v| v.unwrap_or_else(|| "PING answered (no version string on this engine)".into()))
        .map_err(|e| format!("connected, but the probe query failed: {e:#}"))
}

/// The TLS stage for engines that can only report it once auth has run
/// (sqlx probe, scheme decision, merged posture). `session` is the authed
/// connection; `eff_port` is the port the driver dialed (the tunnel's local
/// port when tunnelled) for ClickHouse's scheme decision.
async fn measure_tls(
    measure: &TlsMeasure,
    session: &LiveSession,
    tls_used: Option<bool>,
    config: &ConnectionConfig,
    eff_port: u16,
    timeout: Duration,
) -> (StageStatus, u64, Option<String>) {
    let preferred = matches!(config.ssl_mode, SslMode::Preferred);
    match measure {
        TlsMeasure::ProbeAfterAuth => {
            match session {
                LiveSession::Mysql(pool) => {
                    let pool = pool.clone();
                    let (ms, r) = bounded(timeout, "TLS probe", async move {
                        let cipher: Option<(String, String)> =
                            sqlx::query_as("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
                                .fetch_optional(&pool).await.map_err(|e| format!("{e}"))?;
                        let version: Option<(String, String)> =
                            sqlx::query_as("SHOW SESSION STATUS LIKE 'Ssl_version'")
                                .fetch_optional(&pool).await.map_err(|e| format!("{e}"))?;
                        Ok((
                            cipher.map(|(_, v)| v).unwrap_or_default(),
                            version.map(|(_, v)| v).unwrap_or_default(),
                        ))
                    }).await;
                    tls_probe_verdict(r, preferred, ms, "SHOW SESSION STATUS")
                }
                LiveSession::Postgres(pool) => {
                    let pool = pool.clone();
                    let (ms, r) = bounded(timeout, "TLS probe", async move {
                        let row: Option<(bool, Option<String>, Option<String>)> = sqlx::query_as(
                            "SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
                            .fetch_optional(&pool).await.map_err(|e| format!("{e}"))?;
                        Ok(row)
                    }).await;
                    match r {
                        Err(e) => tls_probe_verdict(Err(e), preferred, ms, "pg_stat_ssl"),
                        Ok(None) => tls_probe_verdict(Ok((String::new(), String::new())), preferred, ms, "pg_stat_ssl"),
                        Ok(Some((ssl, version, cipher))) => {
                            let (c, v) = if ssl {
                                (cipher.unwrap_or_default(), version.unwrap_or_default())
                            } else {
                                (String::new(), String::new())
                            };
                            tls_probe_verdict(Ok((c, v)), preferred, ms, "pg_stat_ssl")
                        }
                    }
                }
                // Unreachable by construction (the planner only assigns
                // ProbeAfterAuth to MySQL/PG) — refuse to fabricate.
                _ => (StageStatus::Skipped, 0, Some("TLS probe is only defined for MySQL/PostgreSQL".into())),
            }
        }
        TlsMeasure::SchemeFromAuth => {
            let scheme = match config.engine {
                Engine::Redis => "rediss://",
                _ => "mongodb:// TLS",
            };
            let detail = match tls_used {
                Some(true) => {
                    let mut d = format!("TLS ({scheme}) — established during auth");
                    if preferred {
                        d.push_str("; ssl_mode=preferred, server accepted");
                    } else {
                        d.push_str("; required by ssl_mode");
                    }
                    if config.engine == Engine::MongoDb && config.trust_server_cert {
                        d.push_str(" · certificate verification OFF (trust_server_cert)");
                    }
                    d
                }
                Some(false) => "plaintext — the TLS attempt failed and ssl_mode=preferred \
                                 fell back (the downgrade is logged)".to_string(),
                None => "TLS state unknown — the dial did not report it".to_string(),
            };
            (StageStatus::Ok, 0, Some(detail))
        }
        TlsMeasure::SqlServer => {
            let level = sqlserver::encryption_level(&config.ssl_mode);
            let mut d = match level {
                tiberius::EncryptionLevel::Required => format!(
                    "TLS required (ssl_mode={}) and established — a TDS login at \
                     EncryptionLevel::Required cannot succeed without it; tiberius \
                     exposes no negotiated-cipher readout",
                    ssl_mode_name(&config.ssl_mode)),
                _ => "encryption requested (ssl_mode=preferred); TDS negotiates it inside \
                      the login and tiberius does not report the outcome".to_string(),
            };
            if config.trust_server_cert {
                d.push_str(" · certificate verification OFF (trust_server_cert)");
            }
            (StageStatus::Ok, 0, Some(d))
        }
        TlsMeasure::ClickHouse => {
            match clickhouse::ch_scheme(&config.ssl_mode, eff_port) {
                "https" => {
                    let verify = if matches!(config.ssl_mode, SslMode::Require) {
                        "OFF (ssl_mode=require is encrypt-without-verify on ClickHouse)"
                    } else {
                        "on"
                    };
                    (StageStatus::Ok, 0, Some(format!(
                        "https — TLS runs inside the auth request (reqwest, no separate \
                         handshake to time); certificate verification {verify}")))
                }
                _ => (StageStatus::Skipped, 0, Some(format!(
                    "http scheme — ssl_mode={} on port {eff_port} (the plaintext interface)",
                    ssl_mode_name(&config.ssl_mode)))),
            }
        }
    }
}

/// The verdict for a MySQL/PG post-auth TLS probe: (cipher, version) or the
/// probe's failure. A Preferred connection reporting no cipher is a legitimate
/// plaintext outcome; a Require-family mode reporting none is a genuine
/// contradiction and fails the stage.
fn tls_probe_verdict(
    r: Result<(String, String), String>,
    preferred: bool,
    ms: u64,
    source: &str,
) -> (StageStatus, u64, Option<String>) {
    match r {
        Ok((cipher, version)) if !cipher.is_empty() => (
            StageStatus::Ok, ms,
            Some(format!("TLS {version}, cipher {cipher} — reported by a post-auth probe \
                          ({source}); sqlx negotiates TLS inside connect and exposes no \
                          handshake timing")),
        ),
        Ok(_) if preferred => (
            StageStatus::Ok, ms,
            Some(format!("not negotiated — plaintext, which ssl_mode=preferred permits \
                          (measured via {source})")),
        ),
        Ok(_) => (
            StageStatus::Fail, ms,
            Some(format!("ssl_mode requires TLS but the session reports no cipher ({source})")),
        ),
        Err(e) if preferred => (
            StageStatus::Ok, ms,
            Some(format!("TLS state unknown — the {source} probe failed: {e}")),
        ),
        Err(e) => (
            StageStatus::Ok, ms,
            Some(format!("TLS established (enforced by ssl_mode at the driver); the {source} \
                          cipher probe failed: {e}")),
        ),
    }
}

fn ssl_mode_name(mode: &SslMode) -> &'static str {
    match mode {
        SslMode::Disable => "disable",
        SslMode::Preferred => "preferred",
        SslMode::Require => "require",
        SslMode::VerifyCa => "verify_ca",
        SslMode::VerifyFull => "verify_full",
    }
}

/// The runner: execute the plan, short-circuit on the first failure, tear
/// down the throwaway session and tunnel.
async fn run_staged(
    config: &ConnectionConfig,
    password: Result<Option<String>, String>,
    ssh_password: Option<String>,
) -> StagedConnectResult {
    let total_start = Instant::now();
    let timeout = Duration::from_secs(u64::from(
        config.connect_timeout_secs
            .unwrap_or(crate::db::types::DEFAULT_CONNECT_TIMEOUT_SECS as u32)
            .max(1),
    ));

    let plan = plan_stages(config);
    // Outcome slots, pre-filled for planned skips; `None` = pending.
    let mut outcomes: Vec<Option<(StageStatus, u64, Option<String>)>> = plan.iter()
        .map(|p| p.skip_reason.clone().map(|r| (StageStatus::Skipped, 0, Some(r))))
        .collect();
    let mut failed_label: Option<String> = None;

    let mut tunnel: Option<crate::db::ssh::SshTunnel> = None;
    let mut session: Option<LiveSession> = None;
    let mut tls_used: Option<bool> = None;

    // In plan order; the TLS stage (index 3) is deferred — it is measured
    // from the authed connection, so it is filled after auth (index 4).
    for i in 0..plan.len() {
        if outcomes[i].is_some() || failed_label.is_some() {
            continue;
        }
        let planned = &plan[i];
        let outcome: (StageStatus, u64, Option<String>) = match planned.id {
            "dns" => {
                let (host, _, _) = planned.target.clone().unwrap_or_default();
                let (ms, r) = bounded(timeout, "DNS resolution", exec_dns(&host)).await;
                outcome_of(r, ms)
            }
            "tcp" => {
                let (host, port, via_ssh) = planned.target.clone().unwrap_or_default();
                let (ms, r) = bounded(timeout, "TCP connect", exec_tcp(&host, port, via_ssh)).await;
                outcome_of(r, ms)
            }
            "ssh" => {
                let (ms, r) = bounded(timeout, "SSH tunnel bring-up",
                    open_tunnel(config, ssh_password.as_deref())).await;
                match r {
                    Ok(t) => {
                        let mut d = t.as_ref().map(|t| format!(
                            "127.0.0.1:{} → {}:{}",
                            t.local_port,
                            config.host.as_deref().unwrap_or("localhost"),
                            config.port.unwrap_or(config.engine.default_port()),
                        ));
                        if let Some(note) = t.as_ref().and_then(|t| t.host_key_note.clone()) {
                            d = Some(format!("{} · {note}", d.unwrap_or_default()));
                        }
                        tunnel = t;
                        (StageStatus::Ok, ms, d)
                    }
                    Err(e) => (StageStatus::Fail, ms, Some(e)),
                }
            }
            "auth" => {
                // A password-exec mint failure means the credential never
                // existed — fail auth with that reason instead of dialing.
                let password = match &password {
                    Ok(pw) => pw.clone(),
                    Err(e) => {
                        let outcome = (StageStatus::Fail, 0, Some(e.clone()));
                        failed_label = Some(planned.label.clone());
                        outcomes[i] = Some(outcome);
                        continue;
                    }
                };
                let host_override: Option<(&str, u16)> = tunnel.as_ref()
                    .map(|t| ("127.0.0.1", t.local_port));
                let (ms, r) = bounded(timeout, "authentication",
                    auth_open(config, password, host_override)).await;
                match r {
                    Ok((s, tls, note)) => {
                        session = Some(s);
                        tls_used = tls;
                        (StageStatus::Ok, ms, note)
                    }
                    Err(e) => {
                        // The driver errors are already one-line/friendly
                        // (sqlx via fmt_conn_error inside connect_bounded);
                        // prefix the target so a failure stands alone.
                        (StageStatus::Fail, ms, Some(format!(
                            "{} — {}", super::connections::describe(config), e)))
                    }
                }
            }
            "probe" => {
                match session.as_ref() {
                    Some(s) => {
                        let (ms, r) = bounded(timeout, "version probe", exec_probe(s)).await;
                        outcome_of(r, ms)
                    }
                    None => (StageStatus::Skipped, 0, Some("not reached — auth did not complete".into())),
                }
            }
            // "tls" — deferred, filled below.
            _ => continue,
        };
        if outcome.0 == StageStatus::Fail && failed_label.is_none() {
            failed_label = Some(planned.label.clone());
        }
        outcomes[i] = Some(outcome);
    }

    // The deferred TLS stage: measurable only once auth has run.
    if failed_label.is_none() {
        if let Some(i) = plan.iter().position(|p| p.id == "tls") {
            if outcomes[i].is_none() {
                if let (Some(measure), Some(s)) = (&plan[i].tls, session.as_ref()) {
                    let eff_port = tunnel.as_ref().map(|t| t.local_port)
                        .unwrap_or_else(|| config.port.unwrap_or(config.engine.default_port()));
                    outcomes[i] = Some(
                        measure_tls(measure, s, tls_used, config, eff_port, timeout).await);
                }
            }
        }
    }

    // Every stage still pending after a failure is reported skipped with the
    // reason — never omitted, so the checklist keeps its shape.
    if let Some(label) = &failed_label {
        for slot in outcomes.iter_mut() {
            if slot.is_none() {
                *slot = Some((StageStatus::Skipped, 0, Some(format!(
                    "not reached — stage '{}' failed", label.to_lowercase()))));
            }
        }
    }

    // Teardown: the throwaway session and the tunnel. Bounded — a wedged pool
    // close must not hang a diagnostic.
    if let Some(s) = session.take() {
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            match &s {
                LiveSession::Mysql(p) => p.close().await,
                LiveSession::Postgres(p) => p.close().await,
                LiveSession::Sqlite(p) => p.close().await,
                // Single socket / file handle / driver-managed pool — Drop
                // closes them (mirrors connection::close_session).
                _ => {}
            }
        }).await;
    }
    drop(tunnel); // Drop kills the ssh child

    let stages: Vec<ConnectStage> = plan.iter().zip(outcomes).map(|(p, o)| {
        let (status, ms, detail) = o.unwrap_or((StageStatus::Skipped, 0, Some("not run".into())));
        ConnectStage { id: p.id, label: p.label.clone(), status, ms, detail }
    }).collect();
    let verdict = if stages.iter().any(|s| s.status == StageStatus::Fail) {
        ConnectVerdict::Fail
    } else {
        ConnectVerdict::Ok
    };
    StagedConnectResult {
        stages,
        total_ms: total_start.elapsed().as_millis() as u64,
        verdict,
    }
}

fn outcome_of(r: Result<String, String>, ms: u64) -> (StageStatus, u64, Option<String>) {
    match r {
        Ok(detail) => (StageStatus::Ok, ms, Some(detail)),
        Err(err) => (StageStatus::Fail, ms, Some(err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mysql_config() -> ConnectionConfig {
        ConnectionConfig::new(Engine::Mysql, "t")
    }

    fn stage<'a>(plan: &'a [PlannedStage], id: &str) -> &'a PlannedStage {
        plan.iter().find(|p| p.id == id).expect("stage present")
    }

    /// The planner always emits all six stages in canonical order — the
    /// checklist UI depends on the stable shape.
    #[test]
    fn plan_always_has_six_stages_in_order() {
        for engine in [Engine::Mysql, Engine::Postgres, Engine::Redis, Engine::Clickhouse,
                       Engine::Sqlite, Engine::Parquet, Engine::Duckdb, Engine::MongoDb,
                       Engine::SqlServer] {
            let plan = plan_stages(&ConnectionConfig::new(engine, "t"));
            let ids: Vec<_> = plan.iter().map(|p| p.id).collect();
            assert_eq!(ids, ["dns", "tcp", "ssh", "tls", "auth", "probe"], "{engine:?}");
        }
    }

    /// File engines skip the whole network half; their auth stage is opening
    /// the file.
    #[test]
    fn file_engines_skip_the_network_stages() {
        let mut c = ConnectionConfig::new(Engine::Duckdb, "f");
        c.file_path = Some(":memory:".into());
        let plan = plan_stages(&c);
        for id in ["dns", "tcp", "ssh", "tls"] {
            assert!(stage(&plan, id).skip_reason.is_some(), "{id} must be skipped");
        }
        assert_eq!(stage(&plan, "auth").label, "Open file");
        assert!(stage(&plan, "auth").skip_reason.is_none());
        assert!(stage(&plan, "probe").skip_reason.is_none());
    }

    /// A literal IP needs no DNS stage; localhost is pinned to 127.0.0.1 by
    /// the drivers, so it counts as literal too. TCP still runs.
    #[test]
    fn literal_ips_and_localhost_skip_dns_only() {
        let mut c = mysql_config();
        c.host = Some("192.0.2.10".into());
        let plan = plan_stages(&c);
        assert!(stage(&plan, "dns").skip_reason.is_some());
        assert!(stage(&plan, "tcp").skip_reason.is_none());

        c.host = Some("localhost".into());
        let plan = plan_stages(&c);
        let reason = stage(&plan, "dns").skip_reason.clone().unwrap_or_default();
        assert!(reason.contains("127.0.0.1"), "localhost pins to a literal: {reason}");
        assert_eq!(stage(&plan, "tcp").target.as_ref().map(|t| t.0.as_str()), Some("127.0.0.1"));
    }

    /// A Unix socket replaces DNS+TCP (MySQL/PG); a tunnel would override it.
    #[test]
    fn socket_connections_skip_dns_and_tcp() {
        let mut c = mysql_config();
        c.socket_path = Some("/var/run/mysqld.sock".into());
        let plan = plan_stages(&c);
        assert!(stage(&plan, "dns").skip_reason.is_some());
        assert!(stage(&plan, "tcp").skip_reason.is_some());

        c.use_ssh = true;
        c.ssh_host = Some("bastion.example.com".into());
        let plan = plan_stages(&c);
        assert!(stage(&plan, "tcp").skip_reason.is_none(), "the tunnel overrides the socket");
    }

    /// With a tunnel, dns/tcp target the SSH endpoint — the DB host resolves
    /// on the far side and is not ours to measure.
    #[test]
    fn tunnelled_configs_dial_the_ssh_endpoint() {
        let mut c = mysql_config();
        c.use_ssh = true;
        c.ssh_host = Some("bastion.example.com".into());
        c.ssh_port = Some(2222);
        let plan = plan_stages(&c);
        let (host, port, via_ssh) = stage(&plan, "tcp").target.clone().unwrap_or_default();
        assert_eq!((host.as_str(), port, via_ssh), ("bastion.example.com", 2222, true));
        assert!(stage(&plan, "ssh").skip_reason.is_none());
    }

    /// mongodb+srv: the host is a discovery domain — neither DNS-A nor a TCP
    /// dial against it measures anything real.
    #[test]
    fn srv_configs_skip_dns_and_tcp() {
        let mut c = ConnectionConfig::new(Engine::MongoDb, "srv");
        c.host = Some("cluster0.example.net".into());
        c.extra_params.insert("srv".into(), "true".into());
        let plan = plan_stages(&c);
        assert!(stage(&plan, "dns").skip_reason.is_some());
        assert!(stage(&plan, "tcp").skip_reason.is_some());
    }

    /// ssl_mode=disable skips TLS everywhere; file engines regardless.
    #[test]
    fn tls_skip_follows_ssl_mode_and_engine() {
        let mut c = mysql_config();
        c.ssl_mode = SslMode::Disable;
        assert!(stage(&plan_stages(&c), "tls").skip_reason.is_some());

        c.ssl_mode = SslMode::Require;
        let plan = plan_stages(&c);
        assert!(stage(&plan, "tls").skip_reason.is_none());
        assert_eq!(stage(&plan, "tls").tls, Some(TlsMeasure::ProbeAfterAuth));

        let r = ConnectionConfig::new(Engine::Redis, "r");
        assert_eq!(stage(&plan_stages(&r), "tls").tls, Some(TlsMeasure::SchemeFromAuth));
        let m = ConnectionConfig::new(Engine::SqlServer, "m");
        assert_eq!(stage(&plan_stages(&m), "tls").tls, Some(TlsMeasure::SqlServer));
        let ch = ConnectionConfig::new(Engine::Clickhouse, "ch");
        assert_eq!(stage(&plan_stages(&ch), "tls").tls, Some(TlsMeasure::ClickHouse));
    }

    /// The wire shape: snake_case status/verdict strings, snake_case fields,
    /// `detail` absent (not null) when there is nothing to say.
    #[test]
    fn wire_shape_is_snake_case_with_absent_detail() {
        let r = StagedConnectResult {
            stages: vec![
                ConnectStage { id: "dns", label: "DNS resolution".into(),
                               status: StageStatus::Ok, ms: 3, detail: Some("h → 1.2.3.4".into()) },
                ConnectStage { id: "ssh", label: "SSH tunnel".into(),
                               status: StageStatus::Skipped, ms: 0, detail: None },
            ],
            total_ms: 3,
            verdict: ConnectVerdict::Ok,
        };
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["verdict"], "ok");
        assert_eq!(json["stages"][0]["status"], "ok");
        assert_eq!(json["stages"][1]["status"], "skipped");
        assert_eq!(json["stages"][0]["detail"], "h → 1.2.3.4");
        assert!(json["stages"][1].get("detail").is_none(), "None detail is absent, not null");
        assert!(json.get("total_ms").is_some());
    }

    /// TLS probe verdicts: plaintext is legitimate under Preferred and a
    /// contradiction under Require.
    #[test]
    fn tls_probe_verdict_reads_negotiation_honestly() {
        let (s, _, d) = tls_probe_verdict(Ok(("TLS_AES_256_GCM_SHA384".into(), "TLSv1.3".into())), true, 1, "probe");
        assert_eq!(s, StageStatus::Ok);
        assert!(d.unwrap_or_default().contains("TLSv1.3"));

        let (s, _, _) = tls_probe_verdict(Ok((String::new(), String::new())), true, 1, "probe");
        assert_eq!(s, StageStatus::Ok, "plaintext is a legitimate Preferred outcome");

        let (s, _, _) = tls_probe_verdict(Ok((String::new(), String::new())), false, 1, "probe");
        assert_eq!(s, StageStatus::Fail, "ssl_mode=require + no cipher is a contradiction");

        // A broken probe never fails a connection that authed fine.
        let (s, _, _) = tls_probe_verdict(Err("denied".into()), false, 1, "probe");
        assert_eq!(s, StageStatus::Ok);
    }

    /// End-to-end without a server: a DuckDB :memory: connection runs auth +
    /// probe for real and skips the network stages.
    #[tokio::test]
    async fn staged_run_on_memory_duckdb_is_ok() {
        let mut c = ConnectionConfig::new(Engine::Duckdb, "mem");
        c.file_path = Some(":memory:".into());
        c.connect_timeout_secs = Some(5);
        let r = run_staged(&c, Ok(None), None).await;
        assert_eq!(r.verdict, ConnectVerdict::Ok, "stages: {:?}", r.stages.iter().map(|s| (s.id, s.status, s.detail.clone())).collect::<Vec<_>>());
        let by_id = |id: &str| r.stages.iter().find(|s| s.id == id).expect("stage");
        for id in ["dns", "tcp", "ssh", "tls"] {
            assert_eq!(by_id(id).status, StageStatus::Skipped, "{id}");
        }
        assert_eq!(by_id("auth").status, StageStatus::Ok);
        assert_eq!(by_id("probe").status, StageStatus::Ok);
        assert!(by_id("probe").detail.as_deref().unwrap_or("").contains("DuckDB"),
            "probe detail carries the version: {:?}", by_id("probe").detail);
    }

    /// A failing run: auth fails (missing file), the probe is reported
    /// skipped with "not reached" — not omitted, not ok.
    #[tokio::test]
    async fn staged_run_short_circuits_on_failure() {
        let mut c = ConnectionConfig::new(Engine::Duckdb, "gone");
        c.file_path = Some("/nonexistent/definitely-not-here.duckdb".into());
        c.connect_timeout_secs = Some(5);
        let r = run_staged(&c, Ok(None), None).await;
        assert_eq!(r.verdict, ConnectVerdict::Fail);
        let by_id = |id: &str| r.stages.iter().find(|s| s.id == id).expect("stage");
        assert_eq!(by_id("auth").status, StageStatus::Fail);
        assert!(by_id("auth").detail.as_deref().unwrap_or("").contains("no such file"));
        assert_eq!(by_id("probe").status, StageStatus::Skipped);
        assert!(by_id("probe").detail.as_deref().unwrap_or("").contains("not reached"));
    }

    /// A password-exec mint failure (W5.1) fails the AUTH stage with the mint
    /// error — no dial is attempted with a credential that never existed.
    #[tokio::test]
    async fn a_password_mint_failure_fails_auth_without_dialing() {
        let mut c = ConnectionConfig::new(Engine::Duckdb, "mem");
        c.file_path = Some(":memory:".into());
        c.connect_timeout_secs = Some(5);
        let r = run_staged(&c, Err("password command failed (exit 3)".into()), None).await;
        assert_eq!(r.verdict, ConnectVerdict::Fail);
        let by_id = |id: &str| r.stages.iter().find(|s| s.id == id).expect("stage");
        assert_eq!(by_id("auth").status, StageStatus::Fail);
        assert_eq!(by_id("auth").detail.as_deref(), Some("password command failed (exit 3)"));
        assert_eq!(by_id("probe").status, StageStatus::Skipped);
    }

    /// Failure injection without a server: port 1 on the loopback refuses
    /// instantly everywhere. dns skips (literal IP), tcp fails, everything
    /// after is not-reached.
    #[tokio::test]
    async fn staged_run_reports_a_refused_tcp() {
        let mut c = mysql_config();
        c.host = Some("127.0.0.1".into());
        c.port = Some(1);
        c.connect_timeout_secs = Some(2);
        let r = run_staged(&c, Ok(None), None).await;
        assert_eq!(r.verdict, ConnectVerdict::Fail);
        let by_id = |id: &str| r.stages.iter().find(|s| s.id == id).expect("stage");
        assert_eq!(by_id("dns").status, StageStatus::Skipped);
        assert_eq!(by_id("tcp").status, StageStatus::Fail);
        for id in ["tls", "auth", "probe"] {
            assert_eq!(by_id(id).status, StageStatus::Skipped, "{id}");
            assert!(by_id(id).detail.as_deref().unwrap_or("").contains("not reached"), "{id}");
        }
    }

    /// Live: a full staged run against a real server, including the TLS probe
    /// where the engine has one.
    ///   TXUI_TEST_CONN=Lo80 cargo test --lib conndiag -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn staged_run_live() {
        let Ok(name) = std::env::var("TXUI_TEST_CONN") else { return };
        let dir = crate::storage::default_data_dir();
        let configs = crate::storage::load(&dir).expect("read connections.json");
        let config = configs.values().find(|c| c.name == name).expect("connection not found").clone();
        let password = crate::secretstore::get(&dir, &config.keychain_key());
        let ssh_password = if config.use_ssh && config.use_ssh_password {
            crate::secretstore::get(&dir, &config.ssh_keychain_key())
        } else {
            None
        };
        let r = run_staged(&config, Ok(password), ssh_password).await;
        for s in &r.stages {
            eprintln!("{:?} {:?} {}ms {:?}", s.id, s.status, s.ms, s.detail);
        }
        assert_eq!(r.verdict, ConnectVerdict::Ok);
    }
}
