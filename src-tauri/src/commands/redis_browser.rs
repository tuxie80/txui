/// Redis-specific browser commands:
/// redis_scan, redis_key_info, redis_get_value, redis_set_string,
/// redis_set_ttl, redis_delete_keys, redis_server_info,
/// redis_key_audit, redis_sentinel_overview
use tauri::State;
use uuid::Uuid;
use serde::Serialize;
use redis::AsyncCommands;

use crate::db::connection::get_session_pub;
use crate::db::types::LiveSession;
use crate::state::AppState;

// ── Public types (serialised to frontend) ─────────────────────────────────────

#[derive(Serialize)]
pub struct RedisScanResult {
    pub cursor: u64,
    pub keys:   Vec<String>,
}

#[derive(Serialize)]
pub struct RedisKeyInfo {
    pub key:      String,
    pub key_type: String,   // "string" | "list" | "hash" | "set" | "zset" | "stream" | "none"
    pub ttl:      i64,      // -1 = persistent, -2 = key doesn't exist
    pub size:     i64,      // STRLEN / LLEN / HLEN / SCARD / ZCARD / XLEN
    /// OBJECT ENCODING — None when the server returned nothing (gone key,
    /// a module type with no encoding concept).
    pub encoding: Option<String>,
}

#[derive(Serialize)]
pub struct HashField   { pub field:  String, pub value: String }
#[derive(Serialize)]
pub struct ZsetEntry   { pub member: String, pub score: f64 }
#[derive(Serialize)]
pub struct StreamEntry { pub id: String, pub fields: std::collections::HashMap<String, String> }

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RedisValue {
    String { value: Option<String> },
    List   { items:   Vec<String> },
    Hash   { fields:  Vec<HashField> },
    Set    { members: Vec<String> },
    Zset   { entries: Vec<ZsetEntry> },
    Stream { entries: Vec<StreamEntry> },
    None,
}

// ── Helper ────────────────────────────────────────────────────────────────────

/// Refuse a mutating Redis command on a read-only connection. Redis has no
/// server-side session read-only mode to lean on (unlike MySQL's
/// `transaction_read_only` and PostgreSQL's `default_transaction_read_only`),
/// so this client-side check is the only thing standing between a read-only
/// connection and a DEL.
async fn guard_read_only(session_id: Uuid, state: &State<'_, AppState>, action: &str) -> Result<(), crate::apperror::AppError> {
    if state.is_read_only(&session_id).await {
        return Err(format!("Connection is read-only — {action} is blocked.").into());
    }
    Ok(())
}

async fn get_mgr(
    session_id: Uuid,
    state: &State<'_, AppState>,
) -> Result<redis::aio::ConnectionManager, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    match session.as_ref() {
        LiveSession::Redis(mgr, _) => Ok(mgr.clone()),
        _ => Err("Not a Redis session".into()),
    }
}

fn bulk_to_string(v: &redis::Value) -> Option<String> {
    match v {
        redis::Value::BulkString(b) => Some(String::from_utf8_lossy(b).into_owned()),
        redis::Value::SimpleString(s) => Some(s.clone()),
        redis::Value::VerbatimString { text, .. } => Some(text.clone()),
        _ => None,
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// SCAN with MATCH pattern. Returns (next_cursor, keys).
#[tauri::command]
pub async fn redis_scan(
    session_id: Uuid,
    pattern:    String,
    cursor:     u64,
    count:      u64,
    state:      State<'_, AppState>,
) -> Result<RedisScanResult, crate::apperror::AppError> {
    let mut mgr = get_mgr(session_id, &state).await?;

    let raw: redis::Value = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH").arg(&pattern)
        .arg("COUNT").arg(count)
        .query_async(&mut mgr)
        .await
        ?;

    // SCAN returns [cursor_bulk, [key, key, ...]]
    let (next_cursor, keys) = match raw {
        redis::Value::Array(ref items) if items.len() == 2 => {
            let cur: u64 = match &items[0] {
                redis::Value::BulkString(b) =>
                    String::from_utf8_lossy(b).parse().unwrap_or(0),
                redis::Value::Int(n) => *n as u64,
                redis::Value::SimpleString(s) => s.parse().unwrap_or(0),
                _ => 0,
            };
            let ks = match &items[1] {
                redis::Value::Array(arr) =>
                    arr.iter().filter_map(bulk_to_string).collect(),
                _ => vec![],
            };
            (cur, ks)
        }
        _ => (0, vec![]),
    };

    Ok(RedisScanResult { cursor: next_cursor, keys })
}

/// The size command for a key type (STRLEN/LLEN/HLEN/SCARD/ZCARD/XLEN), or
/// None for a type with no cardinality concept.
fn size_command(key_type: &str) -> Option<&'static str> {
    match key_type {
        "string" => Some("STRLEN"),
        "list"   => Some("LLEN"),
        "hash"   => Some("HLEN"),
        "set"    => Some("SCARD"),
        "zset"   => Some("ZCARD"),
        "stream" => Some("XLEN"),
        _ => None,
    }
}

/// OBJECT ENCODING as an Option — nil (gone key, module type) becomes None.
async fn object_encoding(mgr: &mut redis::aio::ConnectionManager, key: &str) -> Option<String> {
    let raw: redis::Value = redis::cmd("OBJECT").arg("ENCODING").arg(key)
        .query_async(mgr).await.ok()?;
    bulk_to_string(&raw)
}

/// TYPE + TTL + size + encoding for a single key (4 round trips; acceptable for single-key lookup).
#[tauri::command]
pub async fn redis_key_info(
    session_id: Uuid,
    key:        String,
    state:      State<'_, AppState>,
) -> Result<RedisKeyInfo, crate::apperror::AppError> {
    let mut mgr = get_mgr(session_id, &state).await?;

    let type_str: String = redis::cmd("TYPE").arg(&key)
        .query_async(&mut mgr).await?;
    let ttl: i64 = redis::cmd("TTL").arg(&key)
        .query_async(&mut mgr).await?;

    let size: i64 = match size_command(&type_str) {
        Some(cmd) => redis::cmd(cmd).arg(&key)
            .query_async(&mut mgr).await.unwrap_or(0),
        None => 0,
    };

    let encoding = object_encoding(&mut mgr, &key).await;

    Ok(RedisKeyInfo { key, key_type: type_str, ttl, size, encoding })
}

/// Type-aware value fetch (up to 100 / 200 items for collections).
#[tauri::command]
pub async fn redis_get_value(
    session_id: Uuid,
    key:        String,
    state:      State<'_, AppState>,
) -> Result<RedisValue, crate::apperror::AppError> {
    let mut mgr = get_mgr(session_id, &state).await?;

    let type_str: String = redis::cmd("TYPE").arg(&key)
        .query_async(&mut mgr).await?;

    let val = match type_str.as_str() {
        "string" => {
            let v: Option<String> = mgr.get(&key).await?;
            RedisValue::String { value: v }
        }

        "list" => {
            let items: Vec<String> = mgr.lrange(&key, 0, 199).await?;
            RedisValue::List { items }
        }

        "hash" => {
            // HSCAN, not HGETALL: a multi-million-field hash would block the
            // single-threaded server for one O(N) command and materialize the
            // whole collection here. Accumulate up to the same 200-item cap
            // the list/zset arms use, then stop — capped like the others.
            let mut fields: Vec<HashField> = Vec::new();
            let mut cursor: u64 = 0;
            loop {
                let (next, flat): (u64, Vec<String>) = redis::cmd("HSCAN")
                    .arg(&key).arg(cursor).arg("COUNT").arg(200i64)
                    .query_async(&mut mgr).await?;
                for c in flat.chunks(2) {
                    if c.len() == 2 && fields.len() < 200 {
                        fields.push(HashField { field: c[0].clone(), value: c[1].clone() });
                    }
                }
                cursor = next;
                if cursor == 0 || fields.len() >= 200 { break; }
            }
            fields.sort_by(|a, b| a.field.cmp(&b.field));
            RedisValue::Hash { fields }
        }

        "set" => {
            // SSCAN for the same reason as HSCAN above; same 200-item cap.
            let mut members: Vec<String> = Vec::new();
            let mut cursor: u64 = 0;
            loop {
                let (next, batch): (u64, Vec<String>) = redis::cmd("SSCAN")
                    .arg(&key).arg(cursor).arg("COUNT").arg(200i64)
                    .query_async(&mut mgr).await?;
                for m in batch {
                    if members.len() < 200 { members.push(m); }
                }
                cursor = next;
                if cursor == 0 || members.len() >= 200 { break; }
            }
            members.sort();
            RedisValue::Set { members }
        }

        "zset" => {
            let raw: redis::Value = redis::cmd("ZRANGE")
                .arg(&key).arg(0i64).arg(199i64).arg("WITHSCORES")
                .query_async(&mut mgr).await?;
            let flat: Vec<String> = match raw {
                redis::Value::Array(arr) =>
                    arr.iter().filter_map(bulk_to_string).collect(),
                _ => vec![],
            };
            let entries = flat.chunks(2).filter_map(|c| {
                if c.len() == 2 {
                    Some(ZsetEntry { member: c[0].clone(), score: c[1].parse().unwrap_or(0.0) })
                } else { None }
            }).collect();
            RedisValue::Zset { entries }
        }

        "stream" => {
            let raw: redis::Value = redis::cmd("XRANGE")
                .arg(&key).arg("-").arg("+").arg("COUNT").arg(50i64)
                .query_async(&mut mgr).await?;
            let entries = parse_stream_entries(raw);
            RedisValue::Stream { entries }
        }

        "none" => RedisValue::None,
        _ => RedisValue::None,
    };

    Ok(val)
}

fn parse_stream_entries(raw: redis::Value) -> Vec<StreamEntry> {
    let outer = match raw { redis::Value::Array(a) => a, _ => return vec![] };
    outer.into_iter().filter_map(|entry| {
        let pair = match entry { redis::Value::Array(a) => a, _ => return None };
        if pair.len() < 2 { return None; }
        let id = bulk_to_string(&pair[0])?;
        let field_arr = match &pair[1] { redis::Value::Array(a) => a, _ => return None };
        let flat: Vec<String> = field_arr.iter().filter_map(bulk_to_string).collect();
        let fields = flat.chunks(2)
            .filter_map(|c| if c.len() == 2 { Some((c[0].clone(), c[1].clone())) } else { None })
            .collect();
        Some(StreamEntry { id, fields })
    }).collect()
}

/// SET key value [EX ttl_secs]. Pass ttl_secs = None for no expiry.
#[tauri::command]
pub async fn redis_set_string(
    session_id: Uuid,
    key:        String,
    value:      String,
    ttl_secs:   Option<i64>,
    state:      State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    guard_read_only(session_id, &state, "writing keys").await?;
    let mut mgr = get_mgr(session_id, &state).await?;
    match ttl_secs {
        Some(secs) if secs > 0 => {
            let _: () = mgr.set_ex(&key, &value, secs as u64)
                .await?;
        }
        _ => {
            let _: () = mgr.set(&key, &value)
                .await?;
        }
    }
    Ok(())
}

/// Set TTL. ttl_secs = -1 means PERSIST (remove expiry).
#[tauri::command]
pub async fn redis_set_ttl(
    session_id: Uuid,
    key:        String,
    ttl_secs:   i64,
    state:      State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    guard_read_only(session_id, &state, "changing TTLs").await?;
    let mut mgr = get_mgr(session_id, &state).await?;
    if ttl_secs < 0 {
        let _: i64 = redis::cmd("PERSIST").arg(&key)
            .query_async(&mut mgr).await?;
    } else {
        let _: i64 = mgr.expire(&key, ttl_secs)
            .await?;
    }
    Ok(())
}

/// DEL one or more keys. Returns count of deleted keys.
#[tauri::command]
pub async fn redis_delete_keys(
    session_id: Uuid,
    keys:       Vec<String>,
    state:      State<'_, AppState>,
) -> Result<i64, crate::apperror::AppError> {
    guard_read_only(session_id, &state, "deleting keys").await?;
    let mut mgr = get_mgr(session_id, &state).await?;
    let mut cmd = redis::cmd("DEL");
    for k in &keys { cmd.arg(k); }
    let n: i64 = cmd.query_async(&mut mgr).await?;
    Ok(n)
}

/// INFO [section] — returns raw INFO string for frontend parsing.
#[tauri::command]
pub async fn redis_server_info(
    session_id: Uuid,
    section:    Option<String>,
    state:      State<'_, AppState>,
) -> Result<String, crate::apperror::AppError> {
    let mut mgr = get_mgr(session_id, &state).await?;
    let mut cmd = redis::cmd("INFO");
    if let Some(s) = section { cmd.arg(s); }
    let info: String = cmd.query_async(&mut mgr).await?;
    Ok(info)
}

// ── Key audit ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct RedisKeyAudit {
    pub key:      String,
    pub key_type: String,
    pub ttl:      i64,
    pub encoding: Option<String>,
    pub size:     i64,
}

/// Server-side ceiling on one audit batch. The frontend only ever sends keys
/// it has already SCANned, but the pipeline is O(keys) on a single-threaded
/// server, so the bound lives here where it cannot be talked out of.
const AUDIT_MAX_KEYS: usize = 2_000;

/// TYPE + TTL + OBJECT ENCODING + size for a batch of keys, in two pipelines
/// (the size command depends on the type, so it needs the first batch's
/// answer). Read-only — safe on a read-only connection.
#[tauri::command]
pub async fn redis_key_audit(
    session_id: Uuid,
    keys:       Vec<String>,
    state:      State<'_, AppState>,
) -> Result<Vec<RedisKeyAudit>, crate::apperror::AppError> {
    let mut mgr = get_mgr(session_id, &state).await?;
    let keys: Vec<String> = keys.into_iter().take(AUDIT_MAX_KEYS).collect();
    if keys.is_empty() { return Ok(vec![]); }

    // Pass 1: TYPE, TTL, OBJECT ENCODING per key — three replies per key.
    let mut pipe = redis::pipe();
    for k in &keys {
        pipe.cmd("TYPE").arg(k)
            .cmd("TTL").arg(k)
            .cmd("OBJECT").arg("ENCODING").arg(k);
    }
    let raw: Vec<redis::Value> = pipe.query_async(&mut mgr).await?;

    let mut rows: Vec<RedisKeyAudit> = Vec::with_capacity(keys.len());
    for (i, k) in keys.iter().enumerate() {
        let key_type = raw.get(3 * i).and_then(bulk_to_string).unwrap_or_else(|| "none".into());
        let ttl = match raw.get(3 * i + 1) {
            Some(redis::Value::Int(n)) => *n,
            _ => -2,
        };
        let encoding = raw.get(3 * i + 2).and_then(bulk_to_string);
        rows.push(RedisKeyAudit { key: k.clone(), key_type, ttl, encoding, size: 0 });
    }

    // Pass 2: the size command depends on the type pass 1 just learned.
    let mut pipe = redis::pipe();
    let mut size_idx: Vec<usize> = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        if let Some(cmd) = size_command(&r.key_type) {
            pipe.cmd(cmd).arg(&r.key);
            size_idx.push(i);
        }
    }
    if !size_idx.is_empty() {
        let sizes: Vec<redis::Value> = pipe.query_async(&mut mgr).await?;
        for (j, i) in size_idx.into_iter().enumerate() {
            if let Some(redis::Value::Int(n)) = sizes.get(j) {
                rows[i].size = *n;
            }
        }
    }

    Ok(rows)
}

// ── Sentinel awareness ────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct SentinelReplica {
    pub ip:     String,
    pub port:   String,
    pub status: String,
}

#[derive(Serialize)]
pub struct SentinelMaster {
    pub name:     String,
    pub ip:       String,
    pub port:     String,
    pub status:   String,
    pub replicas: Vec<SentinelReplica>,
}

#[derive(Serialize)]
pub struct RedisSentinelOverview {
    /// The `redis_mode` from INFO server: "standalone" | "sentinel" | "cluster".
    pub mode:    String,
    /// Empty unless mode == "sentinel".
    pub masters: Vec<SentinelMaster>,
}

/// `redis_mode` from an INFO server body, defaulting to "standalone" — an INFO
/// without the field is a pre-2.8 server, and those are all standalone.
fn parse_redis_mode(info: &str) -> String {
    for line in info.lines() {
        if let Some(v) = line.trim().strip_prefix("redis_mode:") {
            return v.trim().to_string();
        }
    }
    "standalone".into()
}

/// A SENTINEL MASTERS / REPLICAS entry: a flat k,v array in RESP2 or a Map in
/// RESP3. Anything else yields an empty map rather than an error — Sentinel
/// adds fields between versions and a missing one must not fail the overview.
fn value_to_str_map(v: &redis::Value) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    match v {
        redis::Value::Map(pairs) => {
            for (k, val) in pairs {
                if let (Some(k), Some(val)) = (bulk_to_string(k), value_scalar(val)) {
                    out.insert(k, val);
                }
            }
        }
        redis::Value::Array(items) => {
            for pair in items.chunks(2) {
                if pair.len() == 2 {
                    if let (Some(k), Some(val)) = (bulk_to_string(&pair[0]), value_scalar(&pair[1])) {
                        out.insert(k, val);
                    }
                }
            }
        }
        _ => {}
    }
    out
}

/// A scalar field of a sentinel entry: strings pass through, ints stringify.
fn value_scalar(v: &redis::Value) -> Option<String> {
    match v {
        redis::Value::Int(n) => Some(n.to_string()),
        other => bulk_to_string(other),
    }
}

/// Sentinel awareness, minimally modelled: INFO server tells us the mode, and
/// on a Sentinel port SENTINEL MASTERS / REPLICAS describe the monitored
/// topology. On any other mode the answer is just the mode — no cluster
/// modelling, no Sentinel write commands.
#[tauri::command]
pub async fn redis_sentinel_overview(
    session_id: Uuid,
    state:      State<'_, AppState>,
) -> Result<RedisSentinelOverview, crate::apperror::AppError> {
    let mut mgr = get_mgr(session_id, &state).await?;

    let info: String = redis::cmd("INFO").arg("server")
        .query_async(&mut mgr).await?;
    let mode = parse_redis_mode(&info);
    if mode != "sentinel" {
        return Ok(RedisSentinelOverview { mode, masters: vec![] });
    }

    let raw: redis::Value = redis::cmd("SENTINEL").arg("MASTERS")
        .query_async(&mut mgr).await?;
    let entries = match raw { redis::Value::Array(a) => a, _ => vec![] };

    let mut masters = Vec::new();
    for e in entries {
        let m = value_to_str_map(&e);
        let name = m.get("name").cloned().unwrap_or_default();
        if name.is_empty() { continue; }

        // SENTINEL REPLICAS is the Redis 5+ name; older Sentinels only know
        // SLAVES. A failure on both leaves the replica list empty rather than
        // failing the whole overview.
        let replicas_raw: redis::Value = match redis::cmd("SENTINEL").arg("REPLICAS").arg(&name)
            .query_async(&mut mgr).await {
            Ok(v) => v,
            Err(_) => redis::cmd("SENTINEL").arg("SLAVES").arg(&name)
                .query_async(&mut mgr).await.unwrap_or(redis::Value::Array(vec![])),
        };
        let replica_entries = match replicas_raw { redis::Value::Array(a) => a, _ => vec![] };
        let replicas = replica_entries.iter().map(|r| {
            let rm = value_to_str_map(r);
            SentinelReplica {
                ip:     rm.get("ip").cloned().unwrap_or_default(),
                port:   rm.get("port").cloned().unwrap_or_default(),
                status: rm.get("status").cloned().unwrap_or_default(),
            }
        }).collect();

        masters.push(SentinelMaster {
            name,
            ip:     m.get("ip").cloned().unwrap_or_default(),
            port:   m.get("port").cloned().unwrap_or_default(),
            status: m.get("status").cloned().unwrap_or_default(),
            replicas,
        });
    }

    Ok(RedisSentinelOverview { mode, masters })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bulk(s: &str) -> redis::Value {
        redis::Value::BulkString(s.as_bytes().to_vec())
    }

    #[test]
    fn mode_parses_from_info_server() {
        let info = "# Server\r\nredis_version:7.2.4\r\nredis_mode:sentinel\r\nrun_id:abc\r\n";
        assert_eq!(parse_redis_mode(info), "sentinel");
        let standalone = "# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n";
        assert_eq!(parse_redis_mode(standalone), "standalone");
        // No field at all = a server too old to have modes, i.e. standalone.
        assert_eq!(parse_redis_mode("# Server\r\nredis_version:2.6.0\r\n"), "standalone");
    }

    #[test]
    fn sentinel_resp2_flat_arrays_parse_to_maps() {
        // RESP2: each master is a flat [k, v, k, v, ...] array.
        let entry = redis::Value::Array(vec![
            bulk("name"), bulk("mymaster"),
            bulk("ip"), bulk("10.0.0.1"),
            bulk("port"), bulk("6379"),
            bulk("num-other-sentinels"), bulk("2"),
        ]);
        let m = value_to_str_map(&entry);
        assert_eq!(m.get("name").map(String::as_str), Some("mymaster"));
        assert_eq!(m.get("port").map(String::as_str), Some("6379"));
        assert_eq!(m.get("num-other-sentinels").map(String::as_str), Some("2"));
    }

    #[test]
    fn sentinel_resp3_maps_parse_too() {
        let entry = redis::Value::Map(vec![
            (bulk("name"), bulk("mymaster")),
            (bulk("port"), redis::Value::Int(6379)),
        ]);
        let m = value_to_str_map(&entry);
        assert_eq!(m.get("name").map(String::as_str), Some("mymaster"));
        assert_eq!(m.get("port").map(String::as_str), Some("6379"));
    }

    #[test]
    fn sentinel_odd_length_and_junk_entries_do_not_panic() {
        // A trailing key without a value (or a non-map reply) must not abort
        // the overview — Sentinel fields change between versions.
        let odd = redis::Value::Array(vec![bulk("name"), bulk("m"), bulk("dangling")]);
        let m = value_to_str_map(&odd);
        assert_eq!(m.len(), 1);
        assert!(value_to_str_map(&redis::Value::Nil).is_empty());
    }

    #[test]
    fn size_command_covers_the_six_types() {
        for (t, cmd) in [("string", "STRLEN"), ("list", "LLEN"), ("hash", "HLEN"),
                         ("set", "SCARD"), ("zset", "ZCARD"), ("stream", "XLEN")] {
            assert_eq!(size_command(t), Some(cmd));
        }
        assert_eq!(size_command("none"), None);
        assert_eq!(size_command("module-type"), None);
    }
}
