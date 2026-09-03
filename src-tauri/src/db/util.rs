//! Shared driver helpers (WP-16 16.2) — the small utilities every engine had
//! its own copy of, hoisted so they cannot drift again.

use anyhow::Result;

/// Percent-encode a userinfo component so a password containing `@`, `:`, `/`
/// or `#` cannot break the URL apart — an unencoded credential produced an
/// unparseable URL, or worse, silently truncated the secret. (Was duplicated
/// verbatim in the redis and mongodb drivers.)
pub fn userinfo_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// The macOS ::1 trap, in one place: after a network change "localhost" can
/// resolve to ::1 ONLY, failing later re-dials with ENETUNREACH although the
/// session connected fine. Pinning the IPv4 loopback removes DNS from every
/// re-dial; a TCP peer at 127.0.0.1 maps to the same server account either
/// way. Callers keep their own guards (an SSH tunnel override, a MySQL/PG
/// socket path) and pin only when those do not apply.
pub fn pin_localhost(host: &str) -> &str {
    if host.eq_ignore_ascii_case("localhost") { "127.0.0.1" } else { host }
}

/// Bound a pool's initial connect — sqlx has no per-options connect timeout
/// (steady-state acquires are covered by acquire_timeout), and unbounded
/// means sitting on the OS's SYN retries when the host is simply off. Never
/// unbounded: `None` falls back to DEFAULT_CONNECT_TIMEOUT_SECS. Errors are
/// rendered through `fmt_err` (the driver's fmt_conn_error) — this unifies
/// the drift where PG returned sqlx's two-line Display while MySQL rendered
/// one actionable line (unified on the MySQL behavior).
pub async fn connect_bounded<T>(
    connect: impl std::future::Future<Output = std::result::Result<T, sqlx::Error>>,
    connect_timeout_secs: Option<u32>,
    fmt_err: impl Fn(&sqlx::Error) -> String,
) -> Result<T> {
    let secs = connect_timeout_secs
        .map(u64::from)
        .unwrap_or(super::types::DEFAULT_CONNECT_TIMEOUT_SECS);
    tokio::time::timeout(std::time::Duration::from_secs(secs), connect)
        .await
        .map_err(|_| anyhow::anyhow!("connection timed out after {secs}s"))?
        .map_err(|e| anyhow::anyhow!("{}", fmt_err(&e)))
}

/// JSON-row string cell (duckdb/sqlserver catalog readers share this shape).
pub fn col_str(row: &super::types::Row, i: usize) -> String {
    row.get(i).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

/// JSON-row boolean cell. Union of the two drivers\' historical readings —
/// DuckDB catalogs deliver real JSON booleans (occasionally "true" text from
/// an expression), SQL Server delivers `bit` as bool and numeric 0/1 — so one
/// reader accepts all three spellings.
pub fn col_bool(row: &super::types::Row, i: usize) -> bool {
    match row.get(i) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_i64() == Some(1),
        Some(serde_json::Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn userinfo_encoding_survives_hostile_passwords() {
        assert_eq!(userinfo_encode("p@ss:w/rd#1"), "p%40ss%3Aw%2Frd%231");
        assert_eq!(userinfo_encode("plain-2.0_~"), "plain-2.0_~");
    }

    #[test]
    fn localhost_pins_case_insensitively() {
        assert_eq!(pin_localhost("localhost"), "127.0.0.1");
        assert_eq!(pin_localhost("LOCALHOST"), "127.0.0.1");
        assert_eq!(pin_localhost("db.internal"), "db.internal");
    }

    #[test]
    fn col_readers_accept_every_engine_spelling() {
        let row: super::super::types::Row = vec![
            serde_json::json!("x"), serde_json::json!(true),
            serde_json::json!(1), serde_json::json!("TRUE"), serde_json::json!(0),
        ];
        assert_eq!(col_str(&row, 0), "x");
        assert!(col_bool(&row, 1));
        assert!(col_bool(&row, 2));
        assert!(col_bool(&row, 3));
        assert!(!col_bool(&row, 4));
        assert!(!col_bool(&row, 9));
    }
}
