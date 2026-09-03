//! Dolphie **replay recordings** — reading a `daemon.db` as a time-series of a
//! live MySQL/MariaDB server rather than as four opaque SQLite tables.
//!
//! A Dolphie recording is a SQLite file with a fixed shape:
//!
//! * `metadata` — one row: host/port/version + a **ZSTD compression
//!   dictionary** (`compression_dict`, ~42 KB) used to compress every snapshot.
//! * `replay_data(id, timestamp, data)` — one row **per second**; `data` is a
//!   ZSTD-with-dictionary blob that decompresses to a JSON object = the full
//!   snapshot of the server at that second (`global_status`, `processlist`,
//!   `metric_manager`, `metadata_locks`, …).
//! * `variable_changes` — a log of `SHOW GLOBAL VARIABLES` changes.
//!
//! This module is the decode core (Wave 1): fingerprint a file, read its
//! metadata, and decode a single snapshot. Ingest-to-columnar-cache and the
//! Tauri commands build on top of it.
//!
//! Everything here opens the file **read-only** (`mode=ro`) — a recording is
//! evidence and is never mutated, the same posture as the generic SQLite
//! engine.

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::path::Path;

/// The four tables that make a SQLite file a Dolphie recording. The presence
/// of all three "real" tables plus a non-null compression dictionary is the
/// fingerprint — `sqlite_sequence` is incidental.
const REQUIRED_TABLES: &[&str] = &["replay_data", "metadata", "variable_changes"];

/// A safe upper bound for a single decompressed snapshot. Observed snapshots
/// are ~11 KB compressed → well under 1 MB decompressed; 8 MB leaves generous
/// headroom for large processlists without the bulk decompressor erroring on a
/// too-small output buffer.
/// A single decompressed snapshot is ~200 KB (from ~11 KB compressed). The
/// decompressor allocates a buffer of THIS size per call, and the allocator
/// keeps ~`threads × this` resident, so an over-generous bound (it was 8 MiB)
/// needlessly inflated RSS during and after the build. 2 MiB is ~10× real-world
/// headroom; a rare larger snapshot just decodes to NaN for that row.
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;

/// Result of fingerprinting a `.db` file: is it a Dolphie recording, and if so
/// its headline metadata. Cheap — no snapshot is decoded.
#[derive(Debug, Clone, Serialize)]
pub struct ReplayProbe {
    pub is_recording: bool,
    pub metadata: Option<ReplayMetadata>,
    /// Number of rows in `replay_data` (== number of recorded seconds).
    pub snapshot_count: i64,
    /// Inclusive time range of the recording, ISO-ish as stored by Dolphie.
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
}

/// The single `metadata` row, minus the dictionary blob itself.
#[derive(Debug, Clone, Serialize)]
pub struct ReplayMetadata {
    pub schema_version: i64,
    pub host: String,
    pub port: i64,
    pub host_distro: String,
    pub connection_source: String,
    pub dolphie_version: String,
    /// Byte length of the compression dictionary (0 if absent).
    pub dict_bytes: i64,
    // ── Server identity, read once from a sample snapshot's global_variables ──
    /// e.g. "8.0.43-google" / "10.11.6-MariaDB".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_hostname: Option<String>,
    /// True when the instance was read-only (or super-read-only) at record time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
}

/// Open a Dolphie recording strictly read-only. `immutable` is intentionally
/// left off: recordings can be appended to while the daemon runs, so we want
/// SQLite to see fresh rows on reconnect.
pub async fn open_ro(path: &Path) -> Result<SqlitePool> {
    if !path.exists() {
        bail!("recording not found: {}", path.display());
    }
    let opts = SqliteConnectOptions::new().filename(path).read_only(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await
        .with_context(|| format!("opening recording {}", path.display()))?;
    Ok(pool)
}

/// Does this SQLite database carry the Dolphie recording tables?
async fn has_recording_tables(pool: &SqlitePool) -> Result<bool> {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT name FROM sqlite_master WHERE type='table'",
    )
    .fetch_all(pool)
    .await?;
    Ok(REQUIRED_TABLES.iter().all(|t| rows.iter().any(|r| r == t)))
}

/// Read the `metadata` row and the compression dictionary. Returns
/// `(metadata, dict_bytes)`. The dictionary is required — a recording without
/// one cannot be decoded.
async fn read_metadata(pool: &SqlitePool) -> Result<(ReplayMetadata, Vec<u8>)> {
    let row = sqlx::query(
        "SELECT schema_version, host, port, host_distro, connection_source, \
         dolphie_version, compression_dict FROM metadata LIMIT 1",
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow!("recording has no metadata row"))?;

    let dict: Vec<u8> = row.try_get::<Option<Vec<u8>>, _>("compression_dict")?.unwrap_or_default();
    let meta = ReplayMetadata {
        schema_version: row.try_get::<Option<i64>, _>("schema_version")?.unwrap_or(1),
        host: row.try_get::<Option<String>, _>("host")?.unwrap_or_default(),
        port: row.try_get::<Option<i64>, _>("port")?.unwrap_or(0),
        host_distro: row.try_get::<Option<String>, _>("host_distro")?.unwrap_or_default(),
        connection_source: row.try_get::<Option<String>, _>("connection_source")?.unwrap_or_default(),
        dolphie_version: row.try_get::<Option<String>, _>("dolphie_version")?.unwrap_or_default(),
        dict_bytes: dict.len() as i64,
        server_version: None,
        server_id: None,
        server_uuid: None,
        server_hostname: None,
        read_only: None,
    };
    Ok((meta, dict))
}

/// Fingerprint a file: is it a recording, and its headline metadata + range.
/// Opens read-only and runs three tiny queries; never decodes a snapshot.
pub async fn probe(path: &Path) -> Result<ReplayProbe> {
    let pool = open_ro(path).await?;
    if !has_recording_tables(&pool).await? {
        return Ok(ReplayProbe {
            is_recording: false,
            metadata: None,
            snapshot_count: 0,
            first_timestamp: None,
            last_timestamp: None,
        });
    }
    let (meta, dict) = read_metadata(&pool).await?;
    // A recording must have a dictionary to be decodable; without one we still
    // report it as "not a (usable) recording" so the caller falls back to the
    // raw SQLite browser rather than opening an undecodable Replay window.
    if dict.is_empty() {
        return Ok(ReplayProbe {
            is_recording: false,
            metadata: None,
            snapshot_count: 0,
            first_timestamp: None,
            last_timestamp: None,
        });
    }

    let (count, first, last): (i64, Option<String>, Option<String>) = {
        let row = sqlx::query(
            "SELECT COUNT(*) AS c, MIN(timestamp) AS f, MAX(timestamp) AS l FROM replay_data",
        )
        .fetch_one(&pool)
        .await?;
        (
            row.try_get("c")?,
            row.try_get("f")?,
            row.try_get("l")?,
        )
    };

    Ok(ReplayProbe {
        is_recording: true,
        metadata: Some(meta),
        snapshot_count: count,
        first_timestamp: first,
        last_timestamp: last,
    })
}

/// A decoder bound to a recording's dictionary. Build once, reuse for every
/// snapshot — constructing the dictionary is the expensive part.
pub struct SnapshotDecoder {
    dict: Vec<u8>,
}

impl SnapshotDecoder {
    /// Load the dictionary from a recording's `metadata` row.
    pub async fn from_pool(pool: &SqlitePool) -> Result<Self> {
        let (_, dict) = read_metadata(pool).await?;
        if dict.is_empty() {
            bail!("recording has no compression dictionary — cannot decode");
        }
        Ok(Self { dict })
    }

    /// Decompress one `replay_data.data` blob and parse it as JSON.
    pub fn decode(&self, blob: &[u8]) -> Result<Value> {
        // A fresh bulk decompressor per call: `zstd::bulk::Decompressor` is not
        // `Sync`, and building it from an already-owned dictionary is cheap
        // relative to the JSON parse that follows.
        let mut dctx = zstd::bulk::Decompressor::with_dictionary(&self.dict)
            .context("building zstd decompressor from recording dictionary")?;
        let raw = dctx
            .decompress(blob, MAX_SNAPSHOT_BYTES)
            .context("decompressing snapshot blob")?;
        let value: Value = serde_json::from_slice(&raw).context("parsing snapshot JSON")?;
        Ok(value)
    }
}

/// Which top-level panels this recording actually carries (the "subset"
/// problem — different recordings enable different panels). Computed from a
/// sample of snapshots so the UI can grey out panels that were never recorded.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PanelPresence {
    pub global_status: bool,
    pub global_variables: bool,
    pub processlist: bool,
    pub metric_manager: bool,
    pub binlog_status: bool,
    pub innodb_metrics: bool,
    pub metadata_locks: bool,
    pub replica_manager: bool,
    pub table_io_waits_data: bool,
    pub file_io_data: bool,
}

impl PanelPresence {
    /// OR a decoded snapshot's present keys into the running presence set.
    pub fn observe(&mut self, snap: &Value) {
        let has = |k: &str| snap.get(k).map(|v| !v.is_null()).unwrap_or(false);
        self.global_status |= has("global_status");
        self.global_variables |= has("global_variables");
        self.processlist |= has("processlist");
        self.metric_manager |= has("metric_manager");
        self.binlog_status |= has("binlog_status");
        self.innodb_metrics |= has("innodb_metrics");
        self.metadata_locks |= has("metadata_locks");
        self.replica_manager |= has("replica_manager");
        self.table_io_waits_data |= has("table_io_waits_data");
        self.file_io_data |= has("file_io_data");
    }
}

/// Fetch and decode the snapshot at (or nearest at-or-before) a timestamp.
/// Dolphie stores one row per second; an exact match is the common case, and
/// the fallback keeps scrubbing robust across recording gaps.
pub async fn snapshot_at(pool: &SqlitePool, decoder: &SnapshotDecoder, ts: &str) -> Result<Value> {
    let row = sqlx::query(
        "SELECT data FROM replay_data WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT 1",
    )
    .bind(ts)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow!("no snapshot at or before {ts}"))?;
    let blob: Vec<u8> = row.try_get("data")?;
    decoder.decode(&blob)
}

// ── Ingest → in-memory columnar cache ───────────────────────────────────────
//
// A recording is 10⁴–10⁵ per-second JSON blobs. Decoding them per chart render
// is impossible; decoding them per scrub is wasteful. So on first open we scan
// the whole file once, pull every numeric `metric_manager` metric into aligned
// f64 columns (the "convert to a faster format" the design calls for), and keep
// the result in memory keyed by a path+size+mtime fingerprint. Charts then read
// columns; only the detail panels (processlist/locks) touch a blob, one at a
// time, on demand.

use std::collections::HashMap;
use std::sync::Arc;

/// The heavy part of an ingested recording: aligned time-series columns. Built
/// lazily (and in parallel) on first use, then reused for every chart slice.
pub struct BuiltSeries {
    /// `group.metric` → one value per snapshot (NaN where absent). Aligned to
    /// the cache's `timestamps` by index.
    pub series: HashMap<String, Vec<f64>>,
}

/// An opened recording. Opening reads only the cheap parts (metadata, the
/// timestamp axis, a small sample for panel/metric discovery); the expensive
/// aligned columns in `built` are constructed on demand by `ensure_series`, so
/// the UI is usable in milliseconds and the graphs fill in a moment later.
pub struct ReplayCache {
    pub key: String,
    pub pool: SqlitePool,
    pub decoder: SnapshotDecoder,
    pub meta: ReplayMetadata,
    /// Wall-clock timestamp of each snapshot, as stored (`YYYY-MM-DD HH:MM:SS`).
    pub timestamps: Vec<String>,
    /// Unix epoch seconds parallel to `timestamps`, for range slicing.
    pub epochs: Vec<i64>,
    /// Metric series names discovered from a sample at open time — enough for
    /// the manifest's panel/graph layout before the full columns exist.
    pub metric_names: Vec<String>,
    pub presence: PanelPresence,
    /// The full columnar series, built once on first `ensure_series` and then
    /// shared. Concurrent builds are serialized by the write lock.
    pub built: tokio::sync::RwLock<Option<Arc<BuiltSeries>>>,
    /// Seconds the one-time build took (for the audit log). Set when built.
    pub build_secs: std::sync::Mutex<Option<f64>>,
}

/// Headline facts about an ingested recording — handed to the UI so it can lay
/// out the scrubber and grey out panels that were never recorded.
#[derive(Debug, Clone, Serialize)]
pub struct ReplayManifest {
    pub metadata: ReplayMetadata,
    pub snapshot_count: usize,
    pub timestamps: Vec<String>,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    /// Sorted list of available `group.metric` series names.
    pub metrics: Vec<String>,
    pub presence: PanelPresence,
}

impl ReplayCache {
    pub fn manifest(&self) -> ReplayManifest {
        ReplayManifest {
            metadata: self.meta.clone(),
            snapshot_count: self.timestamps.len(),
            timestamps: self.timestamps.clone(),
            first_timestamp: self.timestamps.first().cloned(),
            last_timestamp: self.timestamps.last().cloned(),
            metrics: self.metric_names.clone(),
            presence: self.presence.clone(),
        }
    }
}

/// The fingerprint that keys the cache: path + size + mtime. A grown or
/// replaced file gets a new key and is re-ingested.
pub fn cache_key(path: &Path) -> Result<String> {
    let md = std::fs::metadata(path)?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(format!("{}|{}|{}", path.display(), md.len(), mtime))
}

fn parse_epoch(ts: &str) -> i64 {
    // Recording timestamps are `YYYY-MM-DD HH:MM:SS` (UTC as stored by Dolphie).
    chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S")
        .map(|dt| dt.and_utc().timestamp())
        .unwrap_or(0)
}

/// Read stable server identity from a snapshot's `global_variables`.
fn fill_identity(meta: &mut ReplayMetadata, snap: &Value) {
    let Some(gv) = snap.get("global_variables").and_then(|v| v.as_object()) else {
        return;
    };
    let s = |k: &str| {
        gv.get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };
    meta.server_version = s("version");
    meta.server_uuid = s("server_uuid");
    meta.server_hostname = s("hostname").filter(|h| h != "localhost");
    meta.server_id = gv
        .get("server_id")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    let onoff = |k: &str| gv.get(k).and_then(|v| v.as_str()).map(|s| s.eq_ignore_ascii_case("on"));
    match (onoff("read_only"), onoff("super_read_only")) {
        (None, None) => {}
        (a, b) => meta.read_only = Some(a.unwrap_or(false) || b.unwrap_or(false)),
    }
}

/// Pull every numeric metric out of one snapshot's `metric_manager` into a flat
/// `group.metric → value` map. Groups `datetimes` and `_delta` are metadata,
/// not series, and are skipped.
fn extract_metrics(snap: &Value, out: &mut HashMap<String, f64>) {
    out.clear();
    let Some(mm) = snap.get("metric_manager").and_then(|v| v.as_object()) else {
        return;
    };
    for (group, gv) in mm {
        if group == "datetimes" || group == "_delta" {
            continue;
        }
        let Some(metrics) = gv.as_object() else { continue };
        for (metric, mv) in metrics {
            // Each metric is a 1-element list holding this second's value.
            let val = match mv {
                Value::Array(a) => a.first().and_then(|x| x.as_f64()),
                Value::Number(n) => n.as_f64(),
                _ => None,
            };
            if let Some(v) = val {
                out.insert(format!("{group}.{metric}"), v);
            }
        }
    }
}

// ── Fast targeted decode for the columnar build ──────────────────────────────
//
// Parsing every snapshot as a full `serde_json::Value` allocates a whole tree
// for `global_variables` (~600 keys) and the processlist (query strings up to
// ~1 KB each) on every one of 10⁴–10⁵ rows — and almost all of it is thrown
// away. Deserializing into `MetricsOnly` makes serde **skip** everything except
// `metric_manager` (a token scan, no allocation), which is the bulk of the
// build speed-up.

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct MetricsOnly {
    metric_manager: MetricManager,
}

#[derive(Default)]
struct MetricManager(HashMap<String, HashMap<String, f64>>);

impl<'de> serde::Deserialize<'de> for MetricManager {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        use serde::de::{IgnoredAny, MapAccess, Visitor};
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = MetricManager;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("the metric_manager object")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<MetricManager, A::Error> {
                let mut out = HashMap::new();
                while let Some(k) = map.next_key::<String>()? {
                    // datetimes is an array; _delta a map of bools — neither is a
                    // metric group, so skip their values without allocating.
                    if k == "datetimes" || k == "_delta" {
                        map.next_value::<IgnoredAny>()?;
                    } else {
                        let g: HashMap<String, FirstNum> = map.next_value()?;
                        out.insert(k, g.into_iter().map(|(mk, c)| (mk, c.0)).collect());
                    }
                }
                Ok(MetricManager(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// One metric cell: `[n, …]` → first element, bare `n` → itself, else NaN.
struct FirstNum(f64);
impl<'de> serde::Deserialize<'de> for FirstNum {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = f64;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a number or an array of numbers")
            }
            fn visit_f64<E>(self, v: f64) -> std::result::Result<f64, E> { Ok(v) }
            fn visit_i64<E>(self, v: i64) -> std::result::Result<f64, E> { Ok(v as f64) }
            fn visit_u64<E>(self, v: u64) -> std::result::Result<f64, E> { Ok(v as f64) }
            fn visit_bool<E>(self, _: bool) -> std::result::Result<f64, E> { Ok(f64::NAN) }
            fn visit_str<E>(self, _: &str) -> std::result::Result<f64, E> { Ok(f64::NAN) }
            fn visit_unit<E>(self) -> std::result::Result<f64, E> { Ok(f64::NAN) }
            fn visit_none<E>(self) -> std::result::Result<f64, E> { Ok(f64::NAN) }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<f64, A::Error> {
                let mut first = f64::NAN;
                let mut got = false;
                while let Some(x) = seq.next_element::<FirstNum>()? {
                    if !got {
                        first = x.0;
                        got = true;
                    }
                }
                Ok(first)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<f64, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(f64::NAN)
            }
        }
        Ok(FirstNum(d.deserialize_any(V)?))
    }
}

/// `group.metric` names → nested `group → metric → column index`, for filling a
/// row vector directly without per-metric string formatting.
fn build_index(names: &[String]) -> HashMap<String, HashMap<String, usize>> {
    let mut index: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for (col, full) in names.iter().enumerate() {
        if let Some(dot) = full.find('.') {
            index
                .entry(full[..dot].to_string())
                .or_default()
                .insert(full[dot + 1..].to_string(), col);
        }
    }
    index
}

/// Open a recording reading only the cheap parts: metadata, the full timestamp
/// axis (a projection scan — **no blob decode**), and a small spread-out sample
/// of snapshots to learn which panels/metrics exist. The heavy aligned columns
/// are built later by `ensure_series`. This is what makes opening feel instant.
pub async fn open_light(path: &Path) -> Result<ReplayCache> {
    let key = cache_key(path)?;
    let pool = open_ro(path).await?;
    let (meta, dict) = read_metadata(&pool).await?;
    if dict.is_empty() {
        bail!("recording has no compression dictionary — cannot open");
    }
    let decoder = SnapshotDecoder { dict };

    // Timestamp axis: a projection scan, no decode. Fast even for 10⁵ rows.
    let ts_rows = sqlx::query("SELECT timestamp FROM replay_data ORDER BY id")
        .fetch_all(&pool)
        .await?;
    let mut timestamps: Vec<String> = Vec::with_capacity(ts_rows.len());
    let mut epochs: Vec<i64> = Vec::with_capacity(ts_rows.len());
    for r in &ts_rows {
        let ts: String = r.try_get("timestamp").unwrap_or_default();
        epochs.push(parse_epoch(&ts));
        timestamps.push(ts);
    }

    // Sample ~24 rows spread across the recording. Early rows are often empty
    // (the session was warming up), so spreading catches populated snapshots
    // for accurate panel-presence + metric-name discovery.
    let n = timestamps.len();
    let mut presence = PanelPresence::default();
    let mut names: std::collections::BTreeSet<String> = Default::default();
    let mut meta = meta;
    if n > 0 {
        const SAMPLES: usize = 24;
        let step = (n / SAMPLES).max(1);
        let mut scratch = HashMap::new();
        let mut i = 0usize;
        while i < n {
            if let Some(row) = sqlx::query("SELECT data FROM replay_data ORDER BY id LIMIT 1 OFFSET ?")
                .bind(i as i64)
                .fetch_optional(&pool)
                .await?
            {
                let blob: Vec<u8> = row.try_get("data").unwrap_or_default();
                if let Ok(snap) = decoder.decode(&blob) {
                    presence.observe(&snap);
                    extract_metrics(&snap, &mut scratch);
                    for k in scratch.keys() {
                        names.insert(k.clone());
                    }
                    // Server identity: read once from the first sample that has
                    // global_variables. Stable across the recording.
                    if meta.server_version.is_none() {
                        fill_identity(&mut meta, &snap);
                    }
                }
            }
            i += step;
        }
    }

    Ok(ReplayCache {
        key,
        pool,
        decoder,
        meta,
        timestamps,
        epochs,
        metric_names: names.into_iter().collect(),
        presence,
        built: tokio::sync::RwLock::new(None),
        build_secs: std::sync::Mutex::new(None),
    })
}

impl ReplayCache {
    /// Build (once) and return the full aligned columnar series, decoding every
    /// snapshot **in parallel** across all cores. Concurrent callers share the
    /// single build via the write lock. `progress(done, total)` fires between
    /// batches so a command can forward it to the UI.
    pub async fn ensure_series<F: FnMut(usize, usize)>(
        &self,
        mut progress: F,
    ) -> Result<Arc<BuiltSeries>> {
        if let Some(b) = self.built.read().await.clone() {
            return Ok(b);
        }
        let mut guard = self.built.write().await;
        if let Some(b) = guard.clone() {
            return Ok(b);
        }

        let t0 = std::time::Instant::now();
        let total = self.timestamps.len();

        // Fixed column layout, learned from the open-time sample. Each row
        // decodes straight into a `Vec<f64>` of this width (no per-row hashmaps,
        // no string formatting, no backfill), which we then transpose into
        // columns. Metrics that never appeared in the sample are dropped.
        let names = self.metric_names.clone();
        let ncols = names.len();
        let index = Arc::new(build_index(&names));
        let mut columns: Vec<Vec<f64>> = (0..ncols).map(|_| Vec::with_capacity(total)).collect();
        let mut done = 0usize;
        let mut last_id = 0i64;
        // Smaller batches bound peak memory (blobs held in flight) without
        // hurting throughput — rayon still saturates the cores within a batch.
        const BATCH: i64 = 2000;

        loop {
            let rows = sqlx::query("SELECT id, data FROM replay_data WHERE id > ? ORDER BY id LIMIT ?")
                .bind(last_id)
                .bind(BATCH)
                .fetch_all(&self.pool)
                .await?;
            if rows.is_empty() {
                break;
            }
            last_id = rows.last().unwrap().try_get::<i64, _>("id")?;
            let blobs: Vec<Vec<u8>> = rows
                .iter()
                .map(|r| r.try_get::<Vec<u8>, _>("data").unwrap_or_default())
                .collect();
            drop(rows); // release the sqlx rows (a second copy of the blobs) at once
            let dict = self.decoder.dict.clone();
            let idx = index.clone();

            // CPU-bound: decompress + targeted-parse + fill row, fanned across
            // all cores. map_init builds one decompressor per worker thread (the
            // dictionary digest is the expensive part), reused across its rows.
            let batch_rows: Vec<Vec<f64>> = tokio::task::spawn_blocking(move || {
                use rayon::prelude::*;
                blobs
                    .par_iter()
                    .map_init(
                        || zstd::bulk::Decompressor::with_dictionary(&dict).ok(),
                        |dctx, blob| {
                            let mut row = vec![f64::NAN; ncols];
                            if let Some(dc) = dctx.as_mut() {
                                if let Ok(raw) = dc.decompress(blob, MAX_SNAPSHOT_BYTES) {
                                    if let Ok(mo) = serde_json::from_slice::<MetricsOnly>(&raw) {
                                        for (g, metrics) in &mo.metric_manager.0 {
                                            if let Some(gi) = idx.get(g) {
                                                for (m, val) in metrics {
                                                    if let Some(&col) = gi.get(m) {
                                                        row[col] = *val;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            row
                        },
                    )
                    .collect()
            })
            .await?;

            // Transpose row-vectors into columns (aligned to `names` by index).
            for row in batch_rows {
                for (col, val) in row.into_iter().enumerate() {
                    columns[col].push(val);
                }
                done += 1;
            }
            progress(done, total);
        }

        let series: HashMap<String, Vec<f64>> = names.into_iter().zip(columns).collect();
        let built = Arc::new(BuiltSeries { series });
        *guard = Some(built.clone());
        if let Ok(mut bs) = self.build_secs.lock() {
            *bs = Some(t0.elapsed().as_secs_f64());
        }
        progress(total.max(done), total);
        Ok(built)
    }
}

/// A downsampled slice of one or more metric columns over a time window.
#[derive(Debug, Clone, Serialize)]
pub struct SeriesSlice {
    pub timestamps: Vec<String>,
    /// `metric name → downsampled values`, aligned to `timestamps`.
    pub series: HashMap<String, Vec<f64>>,
    /// Points before downsampling (so the UI can show "1s / 10s / 1m").
    pub raw_points: usize,
    pub bucket_seconds: i64,
    /// Seconds the one-time columnar build took — present only on the response
    /// that triggered the build, so the UI can log "converted in N.Ns". None
    /// when the series were already cached (an instant re-open).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_secs: Option<f64>,
}

impl ReplayCache {
    /// Slice `metrics` between epoch bounds (inclusive) from an already-built
    /// series, bucket-averaging down to at most `max_points` so a chart never
    /// draws more lines than pixels.
    pub fn slice(
        &self,
        built: &BuiltSeries,
        from_epoch: i64,
        to_epoch: i64,
        metrics: &[String],
        max_points: usize,
    ) -> SeriesSlice {
        let lo = self.epochs.partition_point(|&e| e < from_epoch);
        let hi = self.epochs.partition_point(|&e| e <= to_epoch);
        let (lo, hi) = (lo.min(self.epochs.len()), hi.min(self.epochs.len()));
        let raw_points = hi.saturating_sub(lo);
        let max_points = max_points.max(1);

        let bucket = raw_points.div_ceil(max_points).max(1);
        let mut timestamps = Vec::new();
        let mut out: HashMap<String, Vec<f64>> = metrics.iter().map(|m| (m.clone(), Vec::new())).collect();

        let mut b = lo;
        while b < hi {
            let end = (b + bucket).min(hi);
            timestamps.push(self.timestamps[b].clone());
            for m in metrics {
                let col = built.series.get(m);
                let mut sum = 0.0;
                let mut n = 0u32;
                if let Some(col) = col {
                    for v in &col[b..end] {
                        if v.is_finite() {
                            sum += *v;
                            n += 1;
                        }
                    }
                }
                let avg = if n > 0 { sum / n as f64 } else { f64::NAN };
                out.get_mut(m).unwrap().push(avg);
            }
            b = end;
        }

        let bucket_seconds = if timestamps.len() >= 2 {
            (to_epoch - from_epoch) / timestamps.len().max(1) as i64
        } else {
            1
        };
        SeriesSlice { timestamps, series: out, raw_points, bucket_seconds, build_secs: None }
    }

    pub fn epoch_bounds(&self) -> (i64, i64) {
        (
            self.epochs.first().copied().unwrap_or(0),
            self.epochs.last().copied().unwrap_or(0),
        )
    }
}

/// Convert a stored `YYYY-MM-DD HH:MM:SS` timestamp to epoch seconds — the UI
/// hands back timestamps it got from the manifest.
pub fn epoch_of(ts: &str) -> i64 {
    parse_epoch(ts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The real recording lives at the repo root. Tests run from `src-tauri/`,
    /// so it is one directory up. Skip (not fail) when it is absent, so the
    /// suite stays green on a checkout without the sample.
    fn sample_path() -> Option<PathBuf> {
        let p = PathBuf::from("../../txui-data/daemon.db");
        p.exists().then_some(p)
    }

    #[tokio::test]
    async fn probe_recognises_the_real_recording() {
        let Some(path) = sample_path() else {
            eprintln!("skipping: ../../txui-data/daemon.db not present");
            return;
        };
        let probe = probe(&path).await.unwrap();
        assert!(probe.is_recording, "daemon.db should fingerprint as a recording");
        let meta = probe.metadata.expect("metadata present");
        assert_eq!(meta.port, 3306);
        assert!(meta.dict_bytes > 0, "dictionary must be present");
        assert!(!meta.dolphie_version.is_empty());
        assert!(probe.snapshot_count > 0, "should have recorded seconds");
        assert!(probe.first_timestamp.is_some() && probe.last_timestamp.is_some());
    }

    #[tokio::test]
    async fn decodes_a_snapshot_into_expected_panels() {
        let Some(path) = sample_path() else {
            eprintln!("skipping: ../../txui-data/daemon.db not present");
            return;
        };
        let pool = open_ro(&path).await.unwrap();
        let decoder = SnapshotDecoder::from_pool(&pool).await.unwrap();

        // Decode a mid-recording row (row 1 is often empty — the session just
        // started), so metric groups are populated.
        let row = sqlx::query("SELECT timestamp, data FROM replay_data ORDER BY id LIMIT 1 OFFSET 5000")
            .fetch_one(&pool)
            .await
            .unwrap();
        let ts: String = row.try_get("timestamp").unwrap();
        let blob: Vec<u8> = row.try_get("data").unwrap();
        let snap = decoder.decode(&blob).unwrap();

        assert!(snap.is_object());
        assert!(snap.get("global_status").is_some(), "global_status expected");
        assert!(snap.get("processlist").is_some(), "processlist expected");
        assert!(snap.get("metric_manager").is_some(), "metric_manager expected");

        // Presence tracking sees at least the core panels.
        let mut presence = PanelPresence::default();
        presence.observe(&snap);
        assert!(presence.global_status && presence.processlist && presence.metric_manager);

        // snapshot_at returns the same shape for the same timestamp.
        let by_ts = snapshot_at(&pool, &decoder, &ts).await.unwrap();
        assert!(by_ts.get("global_status").is_some());
    }

    #[tokio::test]
    async fn ingest_builds_aligned_columns_and_slices() {
        let Some(path) = sample_path() else {
            eprintln!("skipping: ../../txui-data/daemon.db not present");
            return;
        };
        // Light open is cheap and gives the timestamp axis + metric names.
        let cache = open_light(&path).await.unwrap();
        assert!(cache.timestamps.len() > 1000);
        assert_eq!(cache.timestamps.len(), cache.epochs.len());
        assert!(cache.metric_names.iter().any(|m| m == "dml.Queries"));
        // Server identity is read from a sample snapshot's global_variables.
        assert!(cache.meta.server_version.as_deref().is_some_and(|v| v.contains("8.0")));
        assert!(cache.meta.server_uuid.is_some());
        assert_eq!(cache.meta.read_only, Some(false));

        // Building the series decodes everything in parallel.
        let mut last = (0usize, 0usize);
        let built = cache.ensure_series(|d, t| last = (d, t)).await.unwrap();
        assert_eq!(last.0, last.1, "progress should reach total");

        // Every column is aligned to the timestamp axis.
        for (name, col) in &built.series {
            assert_eq!(col.len(), cache.timestamps.len(), "column {name} misaligned");
        }
        assert!(built.series.contains_key("threads.Threads_running"));
        assert!(built.series.contains_key("dml.Queries"));

        // Second call returns the cached build instantly (same Arc).
        let again = cache.ensure_series(|_, _| {}).await.unwrap();
        assert!(Arc::ptr_eq(&built, &again));

        // A slice over the whole range downsamples to <= max_points.
        let (lo, hi) = cache.epoch_bounds();
        let s = cache.slice(&built, lo, hi, &["dml.Queries".to_string()], 500);
        assert!(s.timestamps.len() <= 500);
        assert_eq!(s.series["dml.Queries"].len(), s.timestamps.len());
        assert!(s.raw_points > 500);
    }
}
