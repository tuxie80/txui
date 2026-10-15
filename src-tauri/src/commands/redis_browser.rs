/// Redis-specific browser commands:
/// redis_scan, redis_key_info, redis_get_value, redis_set_string,
/// redis_set_ttl, redis_delete_keys, redis_server_info,
/// redis_key_audit, redis_sentinel_overview
///
/// Every command is a thin `tauri::command` shell (session lookup, read-only
/// guard) over a `pub(crate)` body taking the ConnectionManager — the same
/// factored-body convention as `do_kill_processes`, and what makes the bodies
/// drivable from the live tests at the bottom of this file.
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

#[derive(Serialize, Debug)]
pub struct RedisKeyInfo {
    pub key:      String,
    pub key_type: String,   // "string" | "list" | "hash" | "set" | "zset" | "stream" | "none"
    pub ttl:      i64,      // -1 = persistent, -2 = key doesn't exist
    pub size:     i64,      // STRLEN / LLEN / HLEN / SCARD / ZCARD / XLEN
    /// OBJECT ENCODING — None when the server returned nothing (gone key,
    /// a module type with no encoding concept).
    pub encoding: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct HashField   { pub field:  String, pub value: String }
#[derive(Serialize, Debug)]
pub struct ZsetEntry   { pub member: String, pub score: f64 }
#[derive(Serialize, Debug)]
pub struct StreamEntry { pub id: String, pub fields: std::collections::HashMap<String, String> }

#[derive(Serialize, Debug)]
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
pub(crate) async fn guard_read_only(session_id: Uuid, state: &AppState, action: &str) -> Result<(), crate::apperror::AppError> {
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
    scan_body(&mut mgr, &pattern, cursor, count).await
}

pub(crate) async fn scan_body(
    mgr:        &mut redis::aio::ConnectionManager,
    pattern:    &str,
    cursor:     u64,
    count:      u64,
) -> Result<RedisScanResult, crate::apperror::AppError> {
    let raw: redis::Value = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH").arg(pattern)
        .arg("COUNT").arg(count)
        .query_async(mgr)
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
    key_info_body(&mut mgr, &key).await
}

pub(crate) async fn key_info_body(
    mgr: &mut redis::aio::ConnectionManager,
    key: &str,
) -> Result<RedisKeyInfo, crate::apperror::AppError> {
    let type_str: String = redis::cmd("TYPE").arg(key)
        .query_async(mgr).await?;
    let ttl: i64 = redis::cmd("TTL").arg(key)
        .query_async(mgr).await?;

    let size: i64 = match size_command(&type_str) {
        Some(cmd) => redis::cmd(cmd).arg(key)
            .query_async(mgr).await.unwrap_or(0),
        None => 0,
    };

    let encoding = object_encoding(mgr, key).await;

    Ok(RedisKeyInfo { key: key.to_string(), key_type: type_str, ttl, size, encoding })
}

/// Type-aware value fetch (up to 100 / 200 items for collections).
#[tauri::command]
pub async fn redis_get_value(
    session_id: Uuid,
    key:        String,
    state:      State<'_, AppState>,
) -> Result<RedisValue, crate::apperror::AppError> {
    let mut mgr = get_mgr(session_id, &state).await?;
    get_value_body(&mut mgr, &key).await
}

pub(crate) async fn get_value_body(
    mgr: &mut redis::aio::ConnectionManager,
    key: &str,
) -> Result<RedisValue, crate::apperror::AppError> {
    let type_str: String = redis::cmd("TYPE").arg(key)
        .query_async(mgr).await?;

    let val = match type_str.as_str() {
        "string" => {
            let v: Option<String> = mgr.get(key).await?;
            RedisValue::String { value: v }
        }

        "list" => {
            let items: Vec<String> = mgr.lrange(key, 0, 199).await?;
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
                    .arg(key).arg(cursor).arg("COUNT").arg(200i64)
                    .query_async(mgr).await?;
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
                    .arg(key).arg(cursor).arg("COUNT").arg(200i64)
                    .query_async(mgr).await?;
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
                .arg(key).arg(0i64).arg(199i64).arg("WITHSCORES")
                .query_async(mgr).await?;
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
                .arg(key).arg("-").arg("+").arg("COUNT").arg(50i64)
                .query_async(mgr).await?;
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
    guard_read_only(session_id, state.inner(), "writing keys").await?;
    let mut mgr = get_mgr(session_id, &state).await?;
    set_string_body(&mut mgr, &key, &value, ttl_secs).await
}

pub(crate) async fn set_string_body(
    mgr:      &mut redis::aio::ConnectionManager,
    key:      &str,
    value:    &str,
    ttl_secs: Option<i64>,
) -> Result<(), crate::apperror::AppError> {
    match ttl_secs {
        Some(secs) if secs > 0 => {
            let _: () = mgr.set_ex(key, value, secs as u64)
                .await?;
        }
        _ => {
            let _: () = mgr.set(key, value)
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
    guard_read_only(session_id, state.inner(), "changing TTLs").await?;
    let mut mgr = get_mgr(session_id, &state).await?;
    set_ttl_body(&mut mgr, &key, ttl_secs).await
}

pub(crate) async fn set_ttl_body(
    mgr:      &mut redis::aio::ConnectionManager,
    key:      &str,
    ttl_secs: i64,
) -> Result<(), crate::apperror::AppError> {
    if ttl_secs < 0 {
        let _: i64 = redis::cmd("PERSIST").arg(key)
            .query_async(mgr).await?;
    } else {
        let _: i64 = mgr.expire(key, ttl_secs)
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
    guard_read_only(session_id, state.inner(), "deleting keys").await?;
    let mut mgr = get_mgr(session_id, &state).await?;
    delete_keys_body(&mut mgr, &keys).await
}

pub(crate) async fn delete_keys_body(
    mgr:  &mut redis::aio::ConnectionManager,
    keys: &[String],
) -> Result<i64, crate::apperror::AppError> {
    let mut cmd = redis::cmd("DEL");
    for k in keys { cmd.arg(k); }
    let n: i64 = cmd.query_async(mgr).await?;
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
    server_info_body(&mut mgr, section.as_deref()).await
}

pub(crate) async fn server_info_body(
    mgr:     &mut redis::aio::ConnectionManager,
    section: Option<&str>,
) -> Result<String, crate::apperror::AppError> {
    let mut cmd = redis::cmd("INFO");
    if let Some(s) = section { cmd.arg(s); }
    let info: String = cmd.query_async(mgr).await?;
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
    key_audit_body(&mut mgr, keys).await
}

pub(crate) async fn key_audit_body(
    mgr:  &mut redis::aio::ConnectionManager,
    keys: Vec<String>,
) -> Result<Vec<RedisKeyAudit>, crate::apperror::AppError> {
    let keys: Vec<String> = keys.into_iter().take(AUDIT_MAX_KEYS).collect();
    if keys.is_empty() { return Ok(vec![]); }

    // Pass 1: TYPE, TTL, OBJECT ENCODING per key — three replies per key.
    let mut pipe = redis::pipe();
    for k in &keys {
        pipe.cmd("TYPE").arg(k)
            .cmd("TTL").arg(k)
            .cmd("OBJECT").arg("ENCODING").arg(k);
    }
    let raw: Vec<redis::Value> = pipe.query_async(mgr).await?;

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
        let sizes: Vec<redis::Value> = pipe.query_async(mgr).await?;
        for (j, i) in size_idx.into_iter().enumerate() {
            if let Some(redis::Value::Int(n)) = sizes.get(j) {
                rows[i].size = *n;
            }
        }
    }

    Ok(rows)
}

// ── Sentinel awareness ────────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct SentinelReplica {
    pub ip:     String,
    pub port:   String,
    pub status: String,
}

#[derive(Serialize, Debug)]
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
    sentinel_overview_body(&mut mgr).await
}

pub(crate) async fn sentinel_overview_body(
    mgr: &mut redis::aio::ConnectionManager,
) -> Result<RedisSentinelOverview, crate::apperror::AppError> {
    let info: String = redis::cmd("INFO").arg("server")
        .query_async(mgr).await?;
    let mode = parse_redis_mode(&info);
    if mode != "sentinel" {
        return Ok(RedisSentinelOverview { mode, masters: vec![] });
    }

    let raw: redis::Value = redis::cmd("SENTINEL").arg("MASTERS")
        .query_async(mgr).await?;
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
            .query_async(mgr).await {
            Ok(v) => v,
            Err(_) => redis::cmd("SENTINEL").arg("SLAVES").arg(&name)
                .query_async(mgr).await.unwrap_or(redis::Value::Array(vec![])),
        };
        let replica_entries = match replicas_raw { redis::Value::Array(a) => a, _ => vec![] };
        let replicas = replica_entries.iter().map(|r| {
            let rm = value_to_str_map(r);
            SentinelReplica {
                ip:     rm.get("ip").cloned().unwrap_or_default(),
                port:   rm.get("port").cloned().unwrap_or_default(),
                status: entry_status(&rm),
            }
        }).collect();

        masters.push(SentinelMaster {
            name,
            ip:     m.get("ip").cloned().unwrap_or_default(),
            port:   m.get("port").cloned().unwrap_or_default(),
            status: entry_status(&m),
            replicas,
        });
    }

    Ok(RedisSentinelOverview { mode, masters })
}

// ── "View as geo" (GEO indexes are zsets) ────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct RedisGeoPoint {
    pub member: String,
    pub lon:    f64,
    pub lat:    f64,
}

#[derive(Serialize, Debug)]
pub struct RedisGeoResult {
    pub key:       String,
    /// ZCARD — how many members the key holds in total.
    pub total:     i64,
    /// How many members GEOPOS was asked about (≤ total when capped).
    pub scanned:   usize,
    /// GEOPOS answered nil for these (member gone between ZRANGE and GEOPOS,
    /// or an undecodable score). points.len() = scanned - missing.
    pub missing:   usize,
    /// total > scanned — the view shows a prefix of the key, capped at
    /// GEO_MAX_POINTS like the app map caps its layers.
    pub truncated: bool,
    pub points:    Vec<RedisGeoPoint>,
}

/// Server-side ceiling on one geo resolution, mirroring the map's point cap.
pub const GEO_MAX_POINTS: usize = 5_000;
/// GEOPOS takes a variadic member list; batch it so a 5 000-member page is
/// ten round trips, not one 5 000-argument command.
const GEOPOS_BATCH: usize = 500;

/// Resolve a zset's members to coordinates with GEOPOS — user-initiated from
/// the key browser's "view as geo" action, never a guess from the scores
/// (a leaderboard's scores ARE decodable geohash52 bits; GEOPOS happily
/// returns corner-clustered garbage for them, so detection is the user's
/// click and honesty is the missing/truncated counters).
///
/// Read-only: TYPE + ZCARD + ZRANGE + GEOPOS are all reads, safe on a
/// read-only connection.
#[tauri::command]
pub async fn redis_geo_points(
    session_id: Uuid,
    key:        String,
    limit:      Option<u32>,
    state:      State<'_, AppState>,
) -> Result<RedisGeoResult, crate::apperror::AppError> {
    let mut mgr = get_mgr(session_id, &state).await?;
    geo_points_body(&mut mgr, &key, limit).await
}

pub(crate) async fn geo_points_body(
    mgr:   &mut redis::aio::ConnectionManager,
    key:   &str,
    limit: Option<u32>,
) -> Result<RedisGeoResult, crate::apperror::AppError> {
    let type_str: String = redis::cmd("TYPE").arg(key)
        .query_async(mgr).await?;
    if type_str != "zset" {
        return Err(format!(
            "\"{key}\" is a {type_str} — Redis geo indexes are zsets; only a zset can be viewed as geo."
        ).into());
    }

    let total: i64 = redis::cmd("ZCARD").arg(key)
        .query_async(mgr).await?;
    let cap = limit.unwrap_or(GEO_MAX_POINTS as u32).clamp(1, GEO_MAX_POINTS as u32) as usize;
    // ZRANGE by rank, not ZSCAN: the page is deterministic (a zset's rank
    // order is stable) and one command, and GEOPOS needs the member NAMES,
    // which a cursor scan would hand us just the same.
    let members: Vec<String> = redis::cmd("ZRANGE")
        .arg(key).arg(0i64).arg(cap.saturating_sub(1) as i64)
        .query_async(mgr).await?;

    let mut points: Vec<RedisGeoPoint> = Vec::new();
    let mut missing = 0usize;
    for chunk in members.chunks(GEOPOS_BATCH) {
        let mut cmd = redis::cmd("GEOPOS");
        cmd.arg(key);
        for m in chunk { cmd.arg(m); }
        let raw: redis::Value = cmd.query_async(mgr).await?;
        let (mut pts, miss) = parse_geopos_reply(raw, chunk);
        points.append(&mut pts);
        missing += miss;
    }

    Ok(RedisGeoResult {
        key: key.to_string(),
        total,
        scanned: members.len(),
        missing,
        truncated: total > members.len() as i64,
        points,
    })
}

/// One GEOPOS reply against the member chunk that produced it: an array
/// parallel to `members`, each entry nil (member not found) or a two-element
/// [lon, lat] array of bulk strings. A reply whose shape does not match the
/// request (a module answer, a protocol surprise) resolves nothing rather
/// than misaligning members with coordinates.
fn parse_geopos_reply(raw: redis::Value, members: &[String]) -> (Vec<RedisGeoPoint>, usize) {
    let entries = match raw {
        redis::Value::Array(a) => a,
        _ => return (vec![], members.len()),
    };
    let mut points = Vec::new();
    let mut missing = 0usize;
    for (i, member) in members.iter().enumerate() {
        let coord = entries.get(i).and_then(|e| match e {
            redis::Value::Array(pair) if pair.len() == 2 => {
                let lon = bulk_to_string(&pair[0])?.parse::<f64>().ok()?;
                let lat = bulk_to_string(&pair[1])?.parse::<f64>().ok()?;
                Some((lon, lat))
            }
            _ => None,
        });
        match coord {
            Some((lon, lat)) => points.push(RedisGeoPoint { member: member.clone(), lon, lat }),
            None => missing += 1,
        }
    }
    (points, missing)
}

/// The health/role word of a SENTINEL MASTERS / REPLICAS entry. Modern
/// Sentinels have no `status` field at all — the state lives in `flags`
/// ("master", "slave", "master,o_down", "slave,disconnected") — so a reply
/// without `status` falls back to `flags` rather than rendering blank.
fn entry_status(m: &std::collections::HashMap<String, String>) -> String {
    m.get("status").or_else(|| m.get("flags")).cloned().unwrap_or_default()
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

    #[test]
    fn geopos_reply_resolves_coordinates_and_counts_nils() {
        let members = vec!["Palermo".to_string(), "gone".to_string(), "Paris".to_string()];
        let raw = redis::Value::Array(vec![
            redis::Value::Array(vec![bulk("13.361389"), bulk("38.115556")]),
            redis::Value::Nil,
            redis::Value::Array(vec![bulk("2.349014"), bulk("48.864716")]),
        ]);
        let (points, missing) = parse_geopos_reply(raw, &members);
        assert_eq!(missing, 1);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].member, "Palermo");
        assert!((points[0].lon - 13.361389).abs() < 1e-6);
        assert!((points[0].lat - 38.115556).abs() < 1e-6);
        assert_eq!(points[1].member, "Paris");
    }

    #[test]
    fn geopos_all_nil_is_the_not_a_geo_key_case() {
        // Members vanished (or scores undecodable): every entry nil → zero
        // points, every member counted missing. The frontend reads this exact
        // combination as "not a geo key".
        let members = vec!["a".to_string(), "b".to_string()];
        let raw = redis::Value::Array(vec![redis::Value::Nil, redis::Value::Nil]);
        let (points, missing) = parse_geopos_reply(raw, &members);
        assert!(points.is_empty());
        assert_eq!(missing, 2);
    }

    #[test]
    fn geopos_shape_surprises_resolve_nothing_rather_than_misalign() {
        let members = vec!["a".to_string(), "b".to_string()];
        // A non-array reply must not align member[0] with whatever it holds.
        let (points, missing) = parse_geopos_reply(redis::Value::Nil, &members);
        assert!(points.is_empty());
        assert_eq!(missing, 2);
        // A short reply (server answered fewer entries than asked) counts the
        // uncovered tail as missing, never shifts coordinates onto the wrong
        // member.
        let short = redis::Value::Array(vec![
            redis::Value::Array(vec![bulk("1.5"), bulk("2.5")]),
        ]);
        let (points, missing) = parse_geopos_reply(short, &members);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].member, "a");
        assert_eq!(missing, 1);
        // An unparsable coordinate pair counts as missing, not as (0, 0).
        let junk = redis::Value::Array(vec![
            redis::Value::Array(vec![bulk("not-a-number"), bulk("2.5")]),
            redis::Value::Array(vec![bulk("1.5")]),  // one-element pair
        ]);
        let (points, missing) = parse_geopos_reply(junk, &members);
        assert!(points.is_empty());
        assert_eq!(missing, 2);
    }

    #[test]
    fn geo_point_cap_matches_the_map_doctrine() {
        assert_eq!(GEO_MAX_POINTS, 5_000);
    }

    #[test]
    fn entry_status_falls_back_to_flags() {
        // A modern Sentinel (live-verified against Redis 8.10) has no
        // `status` field; its flags word carries role + health.
        let mut m = std::collections::HashMap::new();
        m.insert("flags".to_string(), "master,o_down".to_string());
        assert_eq!(entry_status(&m), "master,o_down");
        m.insert("status".to_string(), "ok".to_string());
        assert_eq!(entry_status(&m), "ok", "an explicit status wins");
        assert_eq!(entry_status(&std::collections::HashMap::new()), "");
    }

    /// The read-only guard consults only session_meta, so it provably fires
    /// before any server round trip — no Redis needed for this one.
    #[tokio::test]
    async fn read_only_guard_blocks_writes_before_any_server() {
        let dir = std::env::temp_dir()
            .join(format!("txui-redis-guard-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, dir.clone(), std::collections::HashMap::new());

        let id = Uuid::new_v4();
        state.session_meta.write().await.insert(id, crate::state::SessionGuard {
            read_only: true,
            engine: crate::db::types::Engine::Redis,
            environment: None,
            log_dir: None,
            prod_allow_ddl: false,
            prod_allow_unfiltered_write: false,
            autocommit: true,
            query_timeout_secs: None,
        });
        let err = guard_read_only(id, &state, "deleting keys").await.unwrap_err();
        assert!(crate::apperror::AppError::display(&err).contains("read-only"), "{err:?}");

        state.session_meta.write().await.get_mut(&id).unwrap().read_only = false;
        assert!(guard_read_only(id, &state, "deleting keys").await.is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod live_tests {
    //! Drive the real command bodies against real servers. Every test skips
    //! silently when its env var is unset or nothing is listening there.
    //!
    //!   TXUI_REDIS_TEST_PORT           standalone/Valkey with the fixture
    //!                                  (`sh dev/redis_fixture.sh 127.0.0.1 <port>`)
    //!   TXUI_REDIS_TEST_CLUSTER_PORT   any node of a Redis cluster
    //!                                  (`redis-server --cluster-enabled yes` × N
    //!                                   + `redis-cli --cluster create …`)
    //!   TXUI_REDIS_TEST_SENTINEL_PORT  a Sentinel monitoring a master/replica
    //!                                  pair named "mymaster"
    //!
    //!   TXUI_REDIS_TEST_PORT=7790 cargo test --lib redis_browser -- --ignored --nocapture
    use super::*;
    use crate::db::types::{ConnectionConfig, Engine, SslMode};

    fn env_port(name: &str) -> Option<u16> {
        std::env::var(name).ok()?.parse().ok()
    }

    async fn open_on(port: u16) -> Option<(redis::aio::ConnectionManager, redis::Client)> {
        let mut c = ConnectionConfig::new(Engine::Redis, "live");
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.ssl_mode = SslMode::Disable;
        match crate::db::redis::open(&c, None, None).await.ok()? {
            LiveSession::Redis(m, client) => Some((m, client)),
            _ => None,
        }
    }

    /// The full browse path the key browser drives, against the fixture.
    #[tokio::test]
    #[ignore]
    async fn live_standalone_browse_round_trip() {
        let Some(port) = env_port("TXUI_REDIS_TEST_PORT") else { return };
        let Some((mut mgr, _)) = open_on(port).await else { println!("nothing on {port} — skipping"); return };

        // SCAN with MATCH pages the keyspace.
        let scan = scan_body(&mut mgr, "session:*", 0, 100).await.expect("scan");
        assert!(!scan.keys.is_empty(), "fixture session:* keys not found");
        assert!(scan.keys.iter().all(|k| k.starts_with("session:")));
        println!("  scan: {} keys, cursor {}", scan.keys.len(), scan.cursor);

        // Single-key info: type, TTL, size, encoding all real.
        let info = key_info_body(&mut mgr, "user:1").await.expect("key info");
        assert_eq!(info.key_type, "hash");
        assert_eq!(info.ttl, -1, "fixture user:1 is persistent");
        assert_eq!(info.size, 3, "name/email/age");
        assert!(info.encoding.is_some());
        println!("  key info: {} {} size={} encoding={:?}", info.key, info.key_type, info.size, info.encoding);

        // Type-aware fetch across the fixture's types.
        match get_value_body(&mut mgr, "user:1").await.expect("hash value") {
            RedisValue::Hash { fields } =>
                assert!(fields.iter().any(|f| f.field == "name" && f.value == "Ada Lovelace")),
            other => panic!("user:1 not a hash: {other:?}"),
        }
        match get_value_body(&mut mgr, "queue:jobs").await.expect("list value") {
            RedisValue::List { items } => assert_eq!(items.len(), 4),
            other => panic!("queue:jobs not a list: {other:?}"),
        }
        match get_value_body(&mut mgr, "leaderboard").await.expect("zset value") {
            RedisValue::Zset { entries } =>
                assert!(entries.iter().any(|e| e.member == "alice" && e.score == 100.0)),
            other => panic!("leaderboard not a zset: {other:?}"),
        }
        println!("  get_value: hash/list/zset decode");

        // Write path: SET with TTL → info reflects it → PERSIST → DEL.
        set_string_body(&mut mgr, "dbgui:browser:live", "v", Some(60)).await.expect("set");
        let info = key_info_body(&mut mgr, "dbgui:browser:live").await.expect("info after set");
        assert_eq!(info.key_type, "string");
        assert!(info.ttl > 0 && info.ttl <= 60, "ttl {} not in 1..=60", info.ttl);
        set_ttl_body(&mut mgr, "dbgui:browser:live", -1).await.expect("persist");
        let info = key_info_body(&mut mgr, "dbgui:browser:live").await.expect("info after persist");
        assert_eq!(info.ttl, -1);
        let n = delete_keys_body(&mut mgr, &["dbgui:browser:live".to_string()]).await.expect("del");
        assert_eq!(n, 1);
        println!("  set/ttl/persist/del round trip");

        // Key audit pipelines TYPE+TTL+ENCODING then the size command.
        let audit = key_audit_body(&mut mgr, vec!["user:1".into(), "counter".into(), "gone".into()])
            .await.expect("audit");
        assert_eq!(audit.len(), 3);
        assert_eq!(audit[0].key_type, "hash");
        assert_eq!(audit[0].size, 3);
        assert_eq!(audit[1].key_type, "string");
        assert_eq!(audit[1].size, 2, "STRLEN of \"42\"");
        assert_eq!(audit[2].key_type, "none", "a missing key audits as none");
        println!("  key audit: {:?}", audit.iter().map(|a| (&a.key, &a.key_type, a.size)).collect::<Vec<_>>());

        // INFO is the server panel's source.
        let info = server_info_body(&mut mgr, Some("server")).await.expect("info");
        assert!(info.contains("redis_version:"), "INFO server has no version");
    }

    /// Cluster topology through a single-node connection: browse works for
    /// what the node owns, cross-slot access fails loudly with MOVED (the
    /// client follows no redirects), and only db0 exists.
    #[tokio::test]
    #[ignore]
    async fn live_cluster_node_browse_and_moved() {
        let Some(port) = env_port("TXUI_REDIS_TEST_CLUSTER_PORT") else { return };
        let Some((mut mgr, client)) = open_on(port).await else { println!("no cluster node on {port} — skipping"); return };

        // The node knows it is in cluster mode.
        let info = server_info_body(&mut mgr, Some("server")).await.expect("info");
        assert!(info.contains("redis_mode:cluster"), "not a cluster node:\n{info}");

        // Seed keys until at least one lands on THIS node's slots and at
        // least one is refused with MOVED — the split is the finding.
        let mut local_key: Option<String> = None;
        let mut moved_key: Option<String> = None;
        for i in 0..64 {
            let key = format!("dbgui:cluster:probe:{i}");
            match set_string_body(&mut mgr, &key, "v", None).await {
                Ok(()) => { local_key = local_key.or(Some(key)); }
                Err(e) => {
                    let msg = crate::apperror::AppError::display(&e);
                    assert!(msg.contains("MOVED"), "unexpected cluster error: {msg}");
                    moved_key = moved_key.or(Some(key));
                }
            }
        }
        let local_key = local_key.expect("64 keys, none local — is this really a cluster?");
        let moved_key = moved_key.expect("64 keys, no MOVED — single-node cluster?");
        println!("  local key: {local_key} · cross-slot write refused (MOVED): {moved_key}");

        // Browse works for keys the connected node owns…
        let info = key_info_body(&mut mgr, &local_key).await.expect("local key info");
        assert_eq!(info.key_type, "string");
        // …and fails loudly with MOVED, never silently wrong, for a key whose
        // slot lives on another node — the client follows no redirects.
        let err = key_info_body(&mut mgr, &moved_key).await.unwrap_err();
        assert!(crate::apperror::AppError::display(&err).contains("MOVED"),
                "cross-slot read must surface MOVED: {err:?}");
        println!("  cross-slot read: {}", crate::apperror::AppError::display(&err));

        // SCAN only ever sees the connected node's own slots.
        let scan = scan_body(&mut mgr, "dbgui:cluster:probe:*", 0, 100).await.expect("scan");
        assert!(scan.keys.contains(&local_key));

        // Cluster mode has exactly one logical database: INFO keyspace shows
        // db0 only, so the tree never offers a db3 for SELECT to fail on.
        let dbs = crate::db::redis::list_schema(mgr.clone()).await.expect("list_schema");
        let names: Vec<String> = dbs.iter().filter_map(|n| match n {
            crate::db::types::SchemaNode::Database { name } => Some(name.clone()),
            _ => None,
        }).collect();
        assert!(names.iter().all(|n| n.starts_with("db0")), "cluster must expose db0 only: {names:?}");

        // Belt and braces: if a db>0 label ever arrives, SELECT must fail
        // rather than silently reading the wrong database.
        let err = crate::db::redis::list_prefixes(&client, "db3 (1 keys)").await.unwrap_err();
        println!("  SELECT 3 in cluster mode: {err}");

        // Cleanup: DEL is single-slot per key; delete only the local probe.
        delete_keys_body(&mut mgr, &[local_key]).await.ok();
    }

    /// Sentinel: connecting to the Sentinel PORT (not through it — there is
    /// no master-discovery client path) gives the monitored topology; data
    /// commands fail cleanly instead of hanging.
    #[tokio::test]
    #[ignore]
    async fn live_sentinel_overview_lists_topology() {
        let Some(port) = env_port("TXUI_REDIS_TEST_SENTINEL_PORT") else { return };
        let Some((mut mgr, _)) = open_on(port).await else { println!("no sentinel on {port} — skipping"); return };

        let ov = sentinel_overview_body(&mut mgr).await.expect("overview");
        assert_eq!(ov.mode, "sentinel");
        assert_eq!(ov.masters.len(), 1, "expected the mymaster entry: {:?}", ov.masters.len());
        let m = &ov.masters[0];
        assert_eq!(m.name, "mymaster");
        assert_eq!(m.ip, "127.0.0.1");
        assert!(m.port.parse::<u16>().is_ok(), "master port {m:?}");
        // Redis ≥ 6-era Sentinels have no `status` field — the state is the
        // `flags` word; either way the banner must not render blank.
        assert!(!m.status.is_empty(), "master status/flags missing: {m:?}");
        assert_eq!(m.replicas.len(), 1, "the replica must be listed");
        assert_eq!(m.replicas[0].ip, "127.0.0.1");
        assert!(!m.replicas[0].status.is_empty(), "replica status/flags missing");
        println!("  sentinel: master {}:{} status={} + replica :{}",
                 m.ip, m.port, m.status, m.replicas[0].port);

        // A Sentinel is not a data node: GET must error, not hang or pretend.
        let err = crate::db::redis::execute(mgr.clone(), "GET anything").await.unwrap_err();
        println!("  GET on a sentinel port: {err}");
    }

    /// "View as geo" end to end: GEOADD real members, resolve them through
    /// geo_points_body, verify coordinates round-trip within geohash52
    /// precision, then prove the leaderboard trap is reported, not hidden —
    /// GEOPOS decodes ANY zset score, so a plain zset yields garbage points
    /// clustered at the (-180, -85) corner and the counters are the honesty.
    #[tokio::test]
    #[ignore]
    async fn live_geo_points_round_trip() {
        let Some(port) = env_port("TXUI_REDIS_TEST_PORT") else { return };
        let Some((mut mgr, _)) = open_on(port).await else { println!("nothing on {port} — skipping"); return };

        let key = "dbgui:geo:live";
        let _: i64 = redis::cmd("GEOADD").arg(key)
            .arg(13.361389).arg(38.115556).arg("Palermo")
            .arg(15.087269).arg(37.502669).arg("Catania")
            .arg(2.349014).arg(48.864716).arg("Paris")
            .query_async(&mut mgr).await.expect("GEOADD");

        let r = geo_points_body(&mut mgr, key, None).await.expect("geo points");
        assert_eq!(r.total, 3);
        assert_eq!(r.scanned, 3);
        assert_eq!(r.missing, 0);
        assert!(!r.truncated);
        assert_eq!(r.points.len(), 3);
        let palermo = r.points.iter().find(|p| p.member == "Palermo").expect("Palermo");
        // geohash52 quantizes to well under a metre — 1e-4° (~11 m) is generous.
        assert!((palermo.lon - 13.361389).abs() < 1e-4, "lon {}", palermo.lon);
        assert!((palermo.lat - 38.115556).abs() < 1e-4, "lat {}", palermo.lat);
        println!("  geo round trip: {:?}", r.points.iter()
            .map(|p| (&p.member, p.lon, p.lat)).collect::<Vec<_>>());

        // The cap: limit 2 of 3 → truncated, and the result says so.
        let capped = geo_points_body(&mut mgr, key, Some(2)).await.expect("capped");
        assert!(capped.truncated);
        assert_eq!(capped.total, 3);
        assert_eq!(capped.scanned, 2);

        // The trap: a leaderboard IS a zset and GEOPOS decodes its scores
        // into corner garbage. The action is user-initiated, the counters
        // stay honest, and this test pins that no "not geo" refusal fires.
        let lb = "dbgui:geo:leaderboard";
        let _: i64 = redis::cmd("ZADD").arg(lb).arg(100.0).arg("alice")
            .query_async(&mut mgr).await.expect("ZADD");
        let r = geo_points_body(&mut mgr, lb, None).await.expect("leaderboard geopos");
        assert_eq!(r.missing, 0, "GEOPOS decodes any score — no nils here");
        assert_eq!(r.points.len(), 1);
        assert!(r.points[0].lat < -85.0 && r.points[0].lon < -179.0,
                "score 100 decodes to the corner: {:?}", r.points[0]);
        println!("  leaderboard decode (garbage, honestly counted): {:?}", r.points[0]);

        // Not a zset at all is refused with an honest reason.
        let err = geo_points_body(&mut mgr, "user:1", None).await.unwrap_err();
        assert!(crate::apperror::AppError::display(&err).contains("geo indexes are zsets"),
                "{err:?}");

        delete_keys_body(&mut mgr, &[key.to_string(), lb.to_string()]).await.ok();
    }

    /// On a non-sentinel server the overview is just the mode — the frontend
    /// uses it to decide whether the Sentinel card renders at all.
    #[tokio::test]
    #[ignore]
    async fn live_standalone_overview_reports_mode_only() {
        let Some(port) = env_port("TXUI_REDIS_TEST_PORT") else { return };
        let Some((mut mgr, _)) = open_on(port).await else { println!("nothing on {port} — skipping"); return };
        let ov = sentinel_overview_body(&mut mgr).await.expect("overview");
        assert!(ov.masters.is_empty());
        assert!(ov.mode == "standalone" || ov.mode == "cluster", "unexpected mode {}", ov.mode);
        println!("  mode-only overview: {}", ov.mode);
    }
}
