//! W5.3 — local service auto-discovery (the RedisInsight welcome-screen move).
//!
//! Probes the well-known localhost port of every networked engine TxUI
//! supports and reports which ones answer, so the empty/welcome state can
//! offer one-click "add this server" entries. Pure-portable: a TCP connect to
//! 127.0.0.1 with a short timeout, nothing platform-specific, nothing spawned.
//!
//! What "answering" means per engine is deliberately the CHEAPEST honest
//! check. A TCP accept alone proves a listener, not a database — but reading
//! a banner is only free where the protocol volunteers one (MySQL speaks
//! first; ClickHouse's HTTP port answers GET /ping). Where the protocol waits
//! for the client (PostgreSQL, Redis, MongoDB, SQL Server) we send NOTHING:
//! probing with a half-guessed handshake can trip auth-failure lockouts and
//! IDS noise, and "accepting connections" is exactly the honest report.
//! (Redis could take a RESP `PING` — deliberately not sent, same reason.)

use serde::Serialize;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::db::types::Engine;

/// One answered probe — the wire contract with the frontend.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DiscoveredService {
    /// The TxUI engine id ("mysql", "postgres", …) — Engine::wire_name().
    pub engine: String,
    pub port: u16,
    /// Short human text: a version banner where the protocol gives one for
    /// free, else "accepting connections".
    pub detail: String,
}

/// Per-port connect timeout. Localhost answers in milliseconds or refuses
/// instantly; 250 ms only ever bites on a firewall-dropped port.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

/// Bound on the banner read (MySQL) / HTTP round trip (ClickHouse) AFTER the
/// connect. Separate from the connect timeout: a listener that accepts but
/// never speaks must not stretch the probe.
const BANNER_TIMEOUT: Duration = Duration::from_millis(400);

/// Hard bound on the whole discovery run, well under the 2 s budget: the six
/// probes run concurrently, so this is ~connect + banner + slack, not a sum.
const TOTAL_TIMEOUT: Duration = Duration::from_millis(1_500);

/// What a probe may do beyond the bare connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeKind {
    /// Accept is the whole answer; send nothing, read nothing.
    ConnectOnly,
    /// MySQL speaks first: the handshake packet carries the server version.
    ReadBanner,
    /// ClickHouse's HTTP port (8123): GET /ping answers "Ok.\n" when alive.
    HttpPing,
}

/// The probe plan: which port answers for which engine, and what the probe
/// may do there. Pure — the unit tests pin this table, because a wrong row
/// here is a wrong "we found your server" on the welcome screen.
fn probe_plan() -> Vec<(Engine, u16, ProbeKind)> {
    vec![
        (Engine::Mysql,      3306, ProbeKind::ReadBanner),
        (Engine::Postgres,   5432, ProbeKind::ConnectOnly),
        (Engine::Redis,      6379, ProbeKind::ConnectOnly),
        (Engine::Clickhouse, 8123, ProbeKind::HttpPing),
        (Engine::MongoDb,    27017, ProbeKind::ConnectOnly),
        (Engine::SqlServer,  1433, ProbeKind::ConnectOnly),
    ]
}

/// The detail line when nothing richer was learned.
const ACCEPTING: &str = "accepting connections";

/// Probe every planned port concurrently and report the ones that answered,
/// in plan order. Never fails and never hangs: every probe is individually
/// time-boxed and the whole run is capped at TOTAL_TIMEOUT.
#[tauri::command]
pub async fn discover_local_services() -> Result<Vec<DiscoveredService>, crate::apperror::AppError> {
    let plan = probe_plan();
    let mut tasks = Vec::with_capacity(plan.len());
    for (engine, port, kind) in plan {
        tasks.push(tokio::spawn(async move {
            probe_one(port, kind).await.map(|detail| DiscoveredService {
                engine: engine.wire_name().to_string(),
                port,
                detail,
            })
        }));
    }
    let mut found = Vec::new();
    let collect = async {
        for t in tasks {
            if let Ok(Some(svc)) = t.await {
                found.push(svc);
            }
        }
    };
    // The total cap is belt-and-braces — each probe is bounded already, but a
    // wedged local network stack must not pin the welcome screen.
    let _ = tokio::time::timeout(TOTAL_TIMEOUT, collect).await;
    Ok(found)
}

/// One probe: connect, then whatever the kind allows. `None` = nothing there
/// (refused, timed out, garbled) — the everyday case, not an error.
async fn probe_one(port: u16, kind: ProbeKind) -> Option<String> {
    let mut stream = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    ).await.ok()?.ok()?;
    match kind {
        ProbeKind::ConnectOnly => Some(ACCEPTING.to_string()),
        ProbeKind::ReadBanner => {
            let mut buf = vec![0u8; 512];
            let n = tokio::time::timeout(BANNER_TIMEOUT, stream.read(&mut buf)).await.ok()?.ok()?;
            Some(parse_mysql_banner(&buf[..n]).unwrap_or_else(|| ACCEPTING.to_string()))
        }
        ProbeKind::HttpPing => {
            let io = async {
                stream.write_all(b"GET /ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").await.ok()?;
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.ok()?;
                Some(parse_clickhouse_ping(&buf[..n]))
            };
            tokio::time::timeout(BANNER_TIMEOUT, io).await.ok().flatten().flatten()
        }
    }
}

/// Extract the server version from a MySQL/MariaDB initial handshake packet:
/// 3-byte little-endian length + 1-byte sequence, then the payload whose
/// first byte is the protocol version and whose next field is the
/// NUL-terminated server version string. Anything unparseable is `None` —
/// the probe then reports the plain "accepting connections".
fn parse_mysql_banner(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 6 {
        return None;
    }
    let payload = &bytes[4..];
    let protocol = payload[0];
    // 10 is the only protocol version the initial handshake has ever had; a
    // 0xff first byte is an ERR packet (server refusing the connection).
    if protocol != 10 {
        return None;
    }
    let rest = &payload[1..];
    let end = rest.iter().position(|b| *b == 0)?;
    let version = std::str::from_utf8(&rest[..end]).ok()?;
    let version = version.trim();
    if version.is_empty() {
        return None;
    }
    Some(format!("MySQL {version}"))
}

/// The ClickHouse HTTP ping: a 200 whose body is "Ok." (trailing newline).
/// Any other answer — a proxy's error page, a different HTTP service squatting
/// on 8123 — is not ClickHouse, and the probe says so by returning None… but
/// the port DID answer TCP, so the caller still reports the bare accept.
fn parse_clickhouse_ping(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let body = text.split("\r\n\r\n").nth(1)?.trim();
    if text.starts_with("HTTP/1.0 200") || text.starts_with("HTTP/1.1 200") {
        if body == "Ok." {
            return Some("Ok.".to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plan is the contract: the six networked engines, their default
    /// ports (pinned against Engine::default_port), the ClickHouse probe on
    /// the HTTP port, and a kind that never speaks first except where the
    /// protocol does.
    #[test]
    fn the_plan_covers_the_six_networked_engines_on_their_default_ports() {
        let plan = probe_plan();
        assert_eq!(plan.len(), 6);
        for (engine, port, _) in &plan {
            assert_eq!(*port, engine.default_port(), "{engine:?}");
            assert!(!engine.is_file_backed(), "{engine:?}");
        }
        let by_engine = |e: Engine| plan.iter().find(|(x, _, _)| *x == e).unwrap();
        assert_eq!(by_engine(Engine::Mysql).2, ProbeKind::ReadBanner);
        assert_eq!(by_engine(Engine::Clickhouse).2, ProbeKind::HttpPing);
        for e in [Engine::Postgres, Engine::Redis, Engine::MongoDb, Engine::SqlServer] {
            assert_eq!(by_engine(e).2, ProbeKind::ConnectOnly,
                "{e:?} waits for the client — we send nothing");
        }
    }

    #[test]
    fn mysql_banner_parses_the_server_version() {
        // A real MySQL 8.0 handshake prefix: len, seq 0, protocol 10, version.
        let version = b"8.0.46\0";
        let mut pkt = vec![0u8; 4];
        pkt.push(10);
        pkt.extend_from_slice(version);
        assert_eq!(parse_mysql_banner(&pkt).as_deref(), Some("MySQL 8.0.46"));
        // MariaDB's banner the same way.
        let mut pkt = vec![0u8; 4];
        pkt.push(10);
        pkt.extend_from_slice(b"11.4.2-MariaDB\0");
        assert_eq!(parse_mysql_banner(&pkt).as_deref(), Some("MySQL 11.4.2-MariaDB"));
        // An ERR packet (0xff — e.g. "too many connections") is not a banner.
        let mut pkt = vec![0u8; 4];
        pkt.push(0xff);
        pkt.extend_from_slice(b"\x04\x08#08004too many connections");
        assert_eq!(parse_mysql_banner(&pkt), None);
        // Truncated garbage is not a banner either.
        assert_eq!(parse_mysql_banner(b"\x00\x01"), None);
        assert_eq!(parse_mysql_banner(b""), None);
    }

    #[test]
    fn clickhouse_ping_accepts_only_a_200_ok_body() {
        assert_eq!(
            parse_clickhouse_ping(b"HTTP/1.0 200 OK\r\nContent-Length: 4\r\n\r\nOk.\n")
                .as_deref(),
            Some("Ok."));
        assert_eq!(
            parse_clickhouse_ping(b"HTTP/1.1 200 OK\r\n\r\nOk.").as_deref(),
            Some("Ok."));
        // Another HTTP service on the port is not ClickHouse.
        assert_eq!(parse_clickhouse_ping(b"HTTP/1.1 404 Not Found\r\n\r\nnope"), None);
        assert_eq!(parse_clickhouse_ping(b"HTTP/1.1 200 OK\r\n\r\nhello"), None);
        assert_eq!(parse_clickhouse_ping(b"garbage"), None);
    }

    /// A real loopback accept is seen — no database needed, just a listener.
    #[tokio::test]
    async fn a_listening_port_reports_accepting_connections() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let detail = probe_one(port, ProbeKind::ConnectOnly).await;
        assert_eq!(detail.as_deref(), Some(ACCEPTING));
    }

    /// A closed loopback port refuses instantly — the probe is None, fast.
    #[tokio::test]
    async fn a_closed_port_is_a_quick_none() {
        // Bind then drop to find a port that is (almost certainly) closed.
        let port = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap()
            .local_addr().unwrap().port();
        let start = std::time::Instant::now();
        assert_eq!(probe_one(port, ProbeKind::ConnectOnly).await, None);
        assert!(start.elapsed() < Duration::from_secs(2), "the probe must not linger");
    }

    /// The discovery command runs bounded and never fails, whatever is or is
    /// not listening on this machine.
    #[tokio::test]
    async fn discovery_is_bounded_and_never_fails() {
        let start = std::time::Instant::now();
        let found = discover_local_services().await.unwrap();
        assert!(start.elapsed() < Duration::from_secs(2),
            "total runtime must stay under the 2 s budget (took {:?})", start.elapsed());
        // Whatever was found must be one of the planned ports, in plan order.
        let plan = probe_plan();
        let mut last = 0;
        for svc in &found {
            let idx = plan.iter().position(|(e, p, _)| e.wire_name() == svc.engine && *p == svc.port)
                .expect("an unplanned service was reported");
            assert!(idx >= last, "results stay in plan order");
            last = idx;
            assert!(!svc.detail.is_empty());
        }
    }
}
