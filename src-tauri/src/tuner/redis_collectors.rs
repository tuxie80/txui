//! Read-only data collection for the Redis tuner.
//!
//! Same discipline as the MySQL and PostgreSQL twins: only `INFO` and
//! `CONFIG GET` are required; everything else is failure-tolerant, so an
//! ACL-restricted user or a managed instance that hides commands degrades the
//! affected checks instead of failing the whole report.
//!
//! Redis has no `pg_settings`-style typed catalog — `INFO` is a text blob of
//! `# Section` headers and `key:value` lines, and `CONFIG GET` is a flat
//! array. Both are parsed here into maps so the rules can stay pure.

use std::collections::HashMap;

use redis::aio::ConnectionManager;

#[derive(Debug, Clone, Default)]
pub struct SlowEntry {
    pub duration_us: i64,
    pub command: String,
}

/// Everything the Redis checks need.
#[derive(Debug, Default)]
pub struct RedisTunerData {
    /// Flattened `INFO all`: "used_memory" → "2186640". Section headers are
    /// dropped because field names are unique across sections.
    pub info: HashMap<String, String>,
    /// `CONFIG GET *`: "maxmemory" → "0".
    pub config: HashMap<String, String>,

    pub version: String,
    /// (major, minor) — the endoflife.date cycle is "major.minor".
    pub major: u32,
    pub minor: u32,
    /// "standalone" | "sentinel" | "cluster"
    pub mode: String,
    pub uptime_secs: u64,
    pub os: String,

    /// Recent slowlog entries, newest first. Empty when unreadable.
    pub slowlog: Vec<SlowEntry>,
    pub slowlog_len: i64,

    /// Number of keys across all databases, and how many carry a TTL.
    pub total_keys: i64,
    pub volatile_keys: i64,

    /// True when `ACL WHOAMI` reports a user other than `default`, or when
    /// `ACL LIST` shows the default user requires a password.
    pub default_user_nopass: Option<bool>,
    pub acl_users: Vec<String>,
}

impl RedisTunerData {
    pub fn cycle(&self) -> String { format!("{}.{}", self.major, self.minor) }
    pub fn at_least(&self, maj: u32, min: u32) -> bool { (self.major, self.minor) >= (maj, min) }

    pub fn i(&self, key: &str) -> Option<&str> { self.info.get(key).map(String::as_str) }
    pub fn iu(&self, key: &str) -> Option<u64> { self.i(key)?.parse().ok() }
    pub fn ii(&self, key: &str) -> Option<i64> { self.i(key)?.parse().ok() }
    pub fn if_(&self, key: &str) -> Option<f64> { self.i(key)?.parse().ok() }

    pub fn c(&self, key: &str) -> Option<&str> { self.config.get(key).map(String::as_str) }
    pub fn cu(&self, key: &str) -> Option<u64> { self.c(key)?.parse().ok() }
    /// yes/no config value → bool.
    pub fn cb(&self, key: &str) -> Option<bool> {
        match self.c(key)?.to_ascii_lowercase().as_str() {
            "yes" | "true" | "1" => Some(true),
            "no" | "false" | "0" => Some(false),
            _ => None,
        }
    }

    /// Cache hit rate over the server's lifetime, None when nothing was read.
    pub fn hit_rate(&self) -> Option<f64> {
        let hits = self.iu("keyspace_hits")? as f64;
        let misses = self.iu("keyspace_misses")? as f64;
        if hits + misses == 0.0 { return None; }
        Some(hits * 100.0 / (hits + misses))
    }

    pub fn is_replica(&self) -> bool { self.i("role") == Some("slave") }
}

/// Parse the `INFO` text format: `# Section` headers, then `key:value` lines.
fn parse_info(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if let Some((k, v)) = line.split_once(':') {
            out.insert(k.to_string(), v.to_string());
        }
    }
    out
}

/// `major.minor` from a "8.10.0" version string.
fn parse_version(v: &str) -> (u32, u32) {
    let mut it = v.split('.');
    (
        it.next().and_then(|x| x.parse().ok()).unwrap_or(0),
        it.next().and_then(|x| x.parse().ok()).unwrap_or(0),
    )
}

pub async fn collect(mgr: &ConnectionManager) -> anyhow::Result<RedisTunerData> {
    let mut m = mgr.clone();
    let mut d = RedisTunerData::default();

    // ── Required ────────────────────────────────────────────────────────
    let info_text: String = redis::cmd("INFO").arg("all").query_async(&mut m).await?;
    d.info = parse_info(&info_text);

    d.version = d.i("redis_version").unwrap_or("").to_string();
    let (maj, min) = parse_version(&d.version);
    d.major = maj;
    d.minor = min;
    d.mode = d.i("redis_mode").unwrap_or("standalone").to_string();
    d.uptime_secs = d.iu("uptime_in_seconds").unwrap_or(0);
    d.os = d.i("os").unwrap_or("").to_string();

    // CONFIG GET can be denied by ACL; the affected checks degrade.
    if let Ok(pairs) = redis::cmd("CONFIG").arg("GET").arg("*")
        .query_async::<Vec<String>>(&mut m).await
    {
        for c in pairs.chunks(2) {
            if c.len() == 2 { d.config.insert(c[0].clone(), c[1].clone()); }
        }
    }

    // ── Keyspace totals, straight from INFO keyspace ────────────────────
    // Format: `db0:keys=1014,expires=1,avg_ttl=…`
    for (k, v) in &d.info {
        if !k.starts_with("db") || !k[2..].chars().next().is_some_and(|c| c.is_ascii_digit()) {
            continue;
        }
        for part in v.split(',') {
            if let Some(n) = part.strip_prefix("keys=") {
                d.total_keys += n.parse::<i64>().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("expires=") {
                d.volatile_keys += n.parse::<i64>().unwrap_or(0);
            }
        }
    }

    // ── Slowlog ─────────────────────────────────────────────────────────
    d.slowlog_len = redis::cmd("SLOWLOG").arg("LEN")
        .query_async::<i64>(&mut m).await.unwrap_or(-1);
    if let Ok(redis::Value::Array(entries)) = redis::cmd("SLOWLOG").arg("GET").arg(32)
        .query_async::<redis::Value>(&mut m).await
    {
        for e in entries {
            let redis::Value::Array(f) = e else { continue };
            let duration_us = match f.get(2) {
                Some(redis::Value::Int(n)) => *n,
                _ => 0,
            };
            let command = match f.get(3) {
                Some(redis::Value::Array(argv)) => argv.iter().map(|a| match a {
                    redis::Value::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
                    redis::Value::SimpleString(s) => s.clone(),
                    other => format!("{other:?}"),
                }).collect::<Vec<_>>().join(" "),
                _ => String::new(),
            };
            d.slowlog.push(SlowEntry { duration_us, command });
        }
    }

    // ── ACL ─────────────────────────────────────────────────────────────
    // `ACL LIST` needs admin rights; absence just means the check degrades.
    if let Ok(rules) = redis::cmd("ACL").arg("LIST")
        .query_async::<Vec<String>>(&mut m).await
    {
        for line in &rules {
            // "user default on nopass sanitize-payload ~* &* +@all"
            let mut it = line.split_whitespace();
            if it.next() != Some("user") { continue; }
            let Some(name) = it.next() else { continue };
            d.acl_users.push(name.to_string());
            if name == "default" {
                d.default_user_nopass = Some(line.split_whitespace().any(|t| t == "nopass"));
            }
        }
    }

    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_text_parses_into_a_flat_map() {
        let text = "# Server\r\nredis_version:8.10.0\r\nuptime_in_seconds:42\r\n\r\n# Memory\r\nused_memory:2186640\r\n";
        let m = parse_info(text);
        assert_eq!(m.get("redis_version").map(String::as_str), Some("8.10.0"));
        assert_eq!(m.get("used_memory").map(String::as_str), Some("2186640"));
        // Section headers must not become entries.
        assert!(!m.contains_key("# Server"));
        assert_eq!(m.len(), 3);
    }

    #[test]
    fn info_values_containing_colons_survive() {
        // `db0:keys=…` and `allocator_frag_ratio` style lines only split once.
        let m = parse_info("db0:keys=1014,expires=1,avg_ttl=0\nexecutable:/usr/bin/redis-server");
        assert_eq!(m.get("db0").map(String::as_str), Some("keys=1014,expires=1,avg_ttl=0"));
        assert_eq!(m.get("executable").map(String::as_str), Some("/usr/bin/redis-server"));
    }

    #[test]
    fn version_splits_to_major_minor() {
        assert_eq!(parse_version("8.10.0"), (8, 10));
        assert_eq!(parse_version("6.2.23"), (6, 2));
        assert_eq!(parse_version(""), (0, 0));
    }

    fn data(info: &[(&str, &str)], config: &[(&str, &str)]) -> RedisTunerData {
        let mut d = RedisTunerData::default();
        for (k, v) in info { d.info.insert((*k).into(), (*v).into()); }
        for (k, v) in config { d.config.insert((*k).into(), (*v).into()); }
        d
    }

    #[test]
    fn config_booleans_parse_yes_no() {
        let d = data(&[], &[("appendonly", "no"), ("protected-mode", "yes"), ("save", "3600 1")]);
        assert_eq!(d.cb("appendonly"), Some(false));
        assert_eq!(d.cb("protected-mode"), Some(true));
        assert_eq!(d.cb("save"), None, "a non-boolean must not be coerced");
    }

    #[test]
    fn hit_rate_needs_traffic() {
        let mut d = data(&[], &[]);
        assert_eq!(d.hit_rate(), None, "no reads yet → unknown, not 0%");
        d.info.insert("keyspace_hits".into(), "99".into());
        d.info.insert("keyspace_misses".into(), "1".into());
        assert_eq!(d.hit_rate(), Some(99.0));
        d.info.insert("keyspace_hits".into(), "0".into());
        d.info.insert("keyspace_misses".into(), "0".into());
        assert_eq!(d.hit_rate(), None);
    }

    #[test]
    fn replica_detection_uses_the_info_role() {
        assert!(!data(&[("role", "master")], &[]).is_replica());
        assert!(data(&[("role", "slave")], &[]).is_replica());
    }

    #[test]
    fn cycle_is_major_minor_for_endoflife_lookup() {
        let mut d = data(&[], &[]);
        d.major = 8; d.minor = 10;
        assert_eq!(d.cycle(), "8.10");
        assert!(d.at_least(8, 0) && d.at_least(8, 10) && !d.at_least(8, 11));
    }
}
