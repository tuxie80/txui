//! Statements that changed name between MySQL versions.
//!
//! Rust port of `src/utils/syncCompat.ts`. Conformance is asserted by golden
//! vectors — see `sync/mod.rs`.
//!
//! MySQL 8.4 removed the master/slave vocabulary outright: the old spellings
//! are **syntax errors** there, not deprecations. Every row below was verified
//! against a live pair (8.0.46 and 8.4.10, both on 127.0.0.1) by issuing the
//! statement and recording whether the server accepted it:
//!
//! | Statement                     | 8.0 | 8.4 |
//! |-------------------------------|-----|-----|
//! | `SHOW MASTER STATUS`          | ok  | —   |
//! | `SHOW BINARY LOG STATUS`      | —   | ok  |
//! | `RESET MASTER`                | ok  | —   |
//! | `RESET BINARY LOGS AND GTIDS` | —   | ok  |
//! | `SHOW REPLICA STATUS`         | ok  | ok  |
//! | `RESET REPLICA`               | ok  | ok  |
//!
//! The last two matter as much as the first four: where a modern spelling works
//! on **both**, it is used unconditionally. Version-gating a statement that
//! does not need it is a branch that can only ever be wrong.

use serde::{Deserialize, Serialize};

/// A parsed `major.minor.patch`, so comparisons are numeric not lexicographic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    /// The string the server reported, kept for reports.
    pub raw: String,
}

/// Parse `@@version`.
///
/// Real values carry suffixes — `8.4.10`, `8.0.46-0ubuntu0.22.04.1`,
/// `10.11.6-MariaDB` — so parsing stops at the first non-numeric component
/// rather than assuming a clean triple.
pub fn parse_version(raw: &str) -> ServerVersion {
    let trimmed = raw.trim();
    let mut nums = [0u32; 3];
    let mut idx = 0usize;
    let mut cur = String::new();
    for c in trimmed.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else if c == '.' && idx < 2 && !cur.is_empty() {
            nums[idx] = cur.parse().unwrap_or(0);
            idx += 1;
            cur.clear();
        } else {
            break;
        }
    }
    if !cur.is_empty() && idx < 3 {
        nums[idx] = cur.parse().unwrap_or(0);
    }
    ServerVersion {
        major: nums[0],
        minor: nums[1],
        patch: nums[2],
        raw: trimmed.to_string(),
    }
}

/// True when `v` is at least `major.minor`.
pub fn at_least(v: &ServerVersion, major: u32, minor: u32) -> bool {
    v.major > major || (v.major == major && v.minor >= minor)
}

/// MariaDB keeps the legacy vocabulary and diverges elsewhere entirely.
pub fn is_maria_db(v: &ServerVersion) -> bool {
    v.raw.to_lowercase().contains("mariadb")
}

/// The statement that reads this server's own binary-log coordinates.
pub fn binlog_status_statement(v: &ServerVersion) -> &'static str {
    if !is_maria_db(v) && at_least(v, 8, 4) {
        "SHOW BINARY LOG STATUS"
    } else {
        "SHOW MASTER STATUS"
    }
}

/// The statement that clears the binary logs and `gtid_executed`.
///
/// Needed on the target before `gtid_purged` can be set. Destructive, so the
/// tool generates it for review rather than running it.
pub fn reset_binlog_statement(v: &ServerVersion) -> &'static str {
    if !is_maria_db(v) && at_least(v, 8, 4) {
        "RESET BINARY LOGS AND GTIDS"
    } else {
        "RESET MASTER"
    }
}

/// Accepted by both servers tested — no fork needed.
pub const REPLICA_STATUS_STATEMENT: &str = "SHOW REPLICA STATUS";
/// Likewise.
pub const RESET_REPLICA_STATEMENT: &str = "RESET REPLICA";

/// `gtid_mode` has four values, and only one means "every transaction has a GTID".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GtidAvailability {
    Complete,
    /// A mid-migration state where the GTID set is *incomplete* — worse than
    /// `off` for seeding, because the value looks usable and is not.
    Partial,
    Off,
    Unknown,
}

pub fn gtid_availability(gtid_mode: Option<&str>) -> GtidAvailability {
    match gtid_mode.unwrap_or("").trim().to_uppercase().as_str() {
        "ON" => GtidAvailability::Complete,
        "ON_PERMISSIVE" | "OFF_PERMISSIVE" => GtidAvailability::Partial,
        "OFF" => GtidAvailability::Off,
        _ => GtidAvailability::Unknown,
    }
}

/// Can a GTID-based replica be seeded from this server?
pub fn can_seed_by_gtid(gtid_mode: Option<&str>) -> bool {
    gtid_availability(gtid_mode) == GtidAvailability::Complete
}

/// What the run manifest records about seeding, in plain words.
pub fn seed_capability(gtid_mode: Option<&str>) -> String {
    match gtid_availability(gtid_mode) {
        GtidAvailability::Complete =>
            "GTID set captured — the target can follow with SOURCE_AUTO_POSITION = 1.".into(),
        GtidAvailability::Partial => format!(
            "gtid_mode is {} — a mid-migration state where the GTID set is INCOMPLETE. \
             Seeding by GTID would silently skip or replay transactions; use the \
             binary-log coordinates instead.",
            gtid_mode.unwrap_or("")),
        GtidAvailability::Off =>
            "gtid_mode is OFF — no GTIDs exist. Seeding uses binary-log coordinates \
             with SOURCE_AUTO_POSITION = 0.".into(),
        GtidAvailability::Unknown =>
            "gtid_mode could not be read — seeding capability is unknown and must not \
             be assumed.".into(),
    }
}

/// A captured replication position.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CapturedPosition {
    pub gtid_executed: Option<String>,
    pub log_file: Option<String>,
    pub log_pos: Option<u64>,
}

/// Connection details for the generated statement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceConn {
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
}

/// The `CHANGE REPLICATION SOURCE TO` statement for a captured position.
///
/// Modern spelling only: `CHANGE MASTER TO` is a syntax error on 8.4, and the
/// modern form has been accepted since 8.0.23 — older than any server this tool
/// supports copying between.
///
/// Generated for review, never executed. Starting replication is a topology
/// change, and this application's precedent for those is the users panel: emit
/// the exact statements, put them in the editor, let a person run them.
pub fn change_source_statement(pos: &CapturedPosition, conn: &SourceConn) -> String {
    let esc = |s: &str| s.replace('\'', "''");
    let mut lines = vec![
        "CHANGE REPLICATION SOURCE TO".to_string(),
        format!("  SOURCE_HOST = '{}',", esc(&conn.host)),
        format!("  SOURCE_PORT = {},", conn.port.unwrap_or(3306)),
        format!("  SOURCE_USER = '{}',", esc(&conn.user)),
        "  SOURCE_PASSWORD = '<password>',".to_string(),
    ];
    match (&pos.gtid_executed, &pos.log_file, pos.log_pos) {
        (Some(g), _, _) if !g.is_empty() => {
            lines.push("  SOURCE_AUTO_POSITION = 1;".to_string());
        }
        (_, Some(f), Some(p)) => {
            lines.push(format!("  SOURCE_LOG_FILE = '{}',", esc(f)));
            lines.push(format!("  SOURCE_LOG_POS = {p};"));
        }
        _ => {
            // Neither form available: emit something that cannot be run by
            // accident.
            return "-- No replication position was captured; this copy cannot seed a replica."
                .to_string();
        }
    }
    lines.join("\n")
}
