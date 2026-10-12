//! Read-only data collection for the tuner. Every probe beyond the two
//! fundamental `SHOW GLOBAL VARIABLES/STATUS` is failure-tolerant: missing
//! privileges, absent `sys`/`performance_schema` views, or old server
//! versions degrade the affected checks instead of failing the report.

use sqlx::AssertSqlSafe;
use std::collections::HashMap;

use sqlx::Row;

/// Server flavor, detected from version string + version_comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Flavor {
    #[default]
    Mysql,
    Mariadb,
    Percona,
}

impl Flavor {
    pub fn as_str(&self) -> &'static str {
        match self {
            Flavor::Mysql   => "mysql",
            Flavor::Mariadb => "mariadb",
            Flavor::Percona => "percona",
        }
    }
    /// endoflife.date product — Percona Server tracks the MySQL lifecycle.
    pub fn eol_product(&self) -> &'static str {
        match self {
            Flavor::Mariadb => "mariadb",
            _ => "mysql",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct UserAcct {
    pub user: String,
    pub host: String,
    pub plugin: String,
    pub locked: Option<bool>,
    pub expired: Option<bool>,
    /// authentication_string present and empty
    pub no_password: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct SchemaStats {
    pub total_tables: u64,
    pub non_innodb: u64,
    pub non_innodb_sample: Vec<String>,  // "db.table (ENGINE)"
    pub no_pk: u64,
    pub no_pk_sample: Vec<String>,
    pub utf8mb3: u64,
    pub total_bytes: u64,
    pub innodb_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct AutoIncCol {
    pub table: String,       // "db.table"
    pub column: String,
    pub col_type: String,    // e.g. "int unsigned"
    pub pct_used: f64,       // 0..100
}

#[derive(Debug, Clone)]
pub struct FragTable {
    pub table: String,       // "db.table"
    pub total_bytes: u64,    // DATA_LENGTH + INDEX_LENGTH
    pub free_bytes: u64,     // DATA_FREE (reclaimable by a table rebuild)
}

#[derive(Debug, Clone)]
pub struct UnusedIndex {
    pub table: String,       // "db.table"
    pub index: String,
    pub table_bytes: u64,    // size of the owning table (bigger table → more write amplification)
}

#[derive(Debug, Clone)]
pub struct ReplicaChannel {
    pub name: String,
    pub io_running: String,
    pub sql_running: String,
    pub seconds_behind: Option<i64>,
}

/// The Galera (wsrep) view of the already-collected maps. Present only when
/// the provider is loaded AND active: detection reads the `wsrep_on`
/// VARIABLE — on MariaDB there is no STATUS row for it at all (verified live
/// on 11.8), so a status-only probe would never detect a MariaDB node.
/// The two base probes (`SHOW GLOBAL VARIABLES/STATUS`) already return every
/// wsrep key, so no extra round-trip is needed; this struct holds what needs
/// actual PARSING — the `wsrep_provider_options` "k=v; k=v; …" string, where
/// gcache.size and the gcs.fc_* knobs live.
#[derive(Debug, Clone, Default)]
pub struct GaleraInfo {
    /// wsrep_provider_options parsed into a lowercase-keyed map.
    pub provider_options: HashMap<String, String>,
    /// gcache.size in bytes, parsed out of provider_options ("64M", "1G", …).
    pub gcache_size_bytes: Option<u64>,
}

/// Size literal → bytes: "64M", "1.5G", "128M", plain bytes, optional B
/// suffix. None when the value is not a size literal.
pub fn parse_size_bytes(v: &str) -> Option<u64> {
    let v = v.trim();
    let (num, mult) = match v.chars().last() {
        Some('B') | Some('b') => (&v[..v.len() - 1], 1u64),
        _ => (v, 1),
    };
    let (num, mult) = match num.chars().last() {
        Some('K') | Some('k') => (&num[..num.len() - 1], 1024 * mult),
        Some('M') | Some('m') => (&num[..num.len() - 1], 1024u64.pow(2) * mult),
        Some('G') | Some('g') => (&num[..num.len() - 1], 1024u64.pow(3) * mult),
        Some('T') | Some('t') => (&num[..num.len() - 1], 1024u64.pow(4) * mult),
        _ => (num, mult),
    };
    Some((num.trim().parse::<f64>().ok()? * mult as f64) as u64)
}

/// Parse wsrep_provider_options ("k=v; k=v; …") into a lowercase-keyed map.
pub fn parse_provider_options(raw: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for part in raw.split(';') {
        let Some(eq) = part.find('=') else { continue };
        let k = part[..eq].trim().to_ascii_lowercase();
        let v = part[eq + 1..].trim().to_string();
        if !k.is_empty() { m.insert(k, v); }
    }
    m
}

/// Build the Galera view from the collected maps. None unless `wsrep_on` is
/// ON — the checks module keys entirely off this, so a non-Galera server gets
/// zero Galera findings.
fn derive_galera(data: &TunerData) -> Option<GaleraInfo> {
    if data.von("wsrep_on") != Some(true) {
        return None;
    }
    let provider_options = data.v("wsrep_provider_options").map(parse_provider_options).unwrap_or_default();
    let gcache_size_bytes = provider_options.get("gcache.size").and_then(|v| parse_size_bytes(v));
    Some(GaleraInfo { provider_options, gcache_size_bytes })
}

#[derive(Debug, Clone)]
pub struct TopStmt {
    pub digest: String,
    pub count: u64,
    pub total_secs: f64,
}

/// Everything the checks need. `vars`/`status` keys are lowercased.
#[derive(Debug, Default)]
pub struct TunerData {
    pub vars:   HashMap<String, String>,
    pub status: HashMap<String, String>,

    pub flavor: Flavor,
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub version: String,
    pub version_comment: String,
    pub arch: String,
    pub uptime_secs: u64,
    pub cloud: Option<String>,

    /// None = mysql.user not readable (privileges) → account checks degrade
    pub users: Option<Vec<UserAcct>>,
    pub engines: Vec<String>,
    pub schema: Option<SchemaStats>,
    pub auto_inc: Option<Vec<AutoIncCol>>,
    /// P_S-tracked current allocation (sys.memory_global_total) — a usage
    /// datapoint, NOT machine RAM. Checks must note the assumption.
    pub mem_tracked: Option<f64>,
    pub replicas: Vec<ReplicaChannel>,
    pub session_ssl_version: Option<String>,
    /// `(@@session.time_zone, @@global.time_zone)`. Collected because sqlx
    /// pins our session to UTC while other clients inherit the server's zone —
    /// see the `tz.session_differs_from_server` check.
    pub session_time_zone: Option<(String, String)>,
    pub top_statements: Option<Vec<TopStmt>>,
    /// InnoDB tables with reclaimable DATA_FREE, worst first. None = probe failed.
    pub frag_tables: Option<Vec<FragTable>>,
    /// Schema-wide InnoDB DATA_FREE / total bytes (for the ratio even when no
    /// single table crosses the per-table threshold).
    pub frag_total_free_bytes: u64,
    pub frag_total_bytes: u64,
    /// sys.schema_unused_indexes (never-read secondary indexes since server
    /// start). None = sys schema missing/unreadable → the check degrades.
    pub unused_indexes: Option<Vec<UnusedIndex>>,
    /// Parsed Galera/wsrep view — Some only when wsrep_on is ON (the VARIABLE;
    /// MariaDB has no STATUS row for it). All wsrep keys themselves stay in
    /// `vars`/`status`; this holds what needed parsing.
    pub galera: Option<GaleraInfo>,
}

impl TunerData {
    pub fn cycle(&self) -> String { format!("{}.{}", self.major, self.minor) }

    /// Version >= (maj, min, patch). Meaningless across MariaDB's numbering —
    /// callers gate MySQL-specific version checks with `flavor != Mariadb`.
    pub fn at_least(&self, maj: u32, min: u32, patch: u32) -> bool {
        (self.major, self.minor, self.patch) >= (maj, min, patch)
    }

    pub fn v(&self, key: &str) -> Option<&str> { self.vars.get(key).map(String::as_str) }
    pub fn vu(&self, key: &str) -> Option<u64> { self.v(key)?.parse().ok() }
    pub fn vf(&self, key: &str) -> Option<f64> { self.v(key)?.parse().ok() }
    /// ON/OFF-style variable → bool (accepts ON/OFF/YES/NO/1/0).
    pub fn von(&self, key: &str) -> Option<bool> {
        match self.v(key)?.to_ascii_uppercase().as_str() {
            "ON" | "YES" | "1" | "TRUE" | "ENABLED" => Some(true),
            "OFF" | "NO" | "0" | "FALSE" | "DISABLED" => Some(false),
            _ => None,
        }
    }
    pub fn s(&self, key: &str) -> Option<u64> { self.status.get(key)?.parse().ok() }
    pub fn sf(&self, key: &str) -> Option<f64> { self.status.get(key)?.parse().ok() }
}

pub fn parse_version(version: &str) -> (u32, u32, u32) {
    let base = version.split('-').next().unwrap_or(version);
    let mut parts = base.split('.').map(|p| {
        // tolerate "8.0.46rc1"-style suffixes by trimming non-digits
        let digits: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().unwrap_or(0)
    });
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

pub fn detect_flavor(version: &str, comment: &str) -> Flavor {
    let v = version.to_ascii_lowercase();
    let c = comment.to_ascii_lowercase();
    if v.contains("mariadb") || c.contains("mariadb") {
        Flavor::Mariadb
    } else if c.contains("percona") {
        Flavor::Percona
    } else {
        Flavor::Mysql
    }
}

/// Cloud-managed instance autodiscovery (better than MySQLTuner, which has
/// none): version_comment giveaways plus Aurora's telltale extra variable.
pub fn detect_cloud(comment: &str, vars: &HashMap<String, String>) -> Option<String> {
    if vars.contains_key("aurora_version") {
        return Some("aws-aurora".into());
    }
    let c = comment.to_ascii_lowercase();
    if c.contains("aurora") {
        Some("aws-aurora".into())
    } else if c.contains("rds") || c.contains("amazon") {
        Some("aws-rds".into())
    } else if c.contains("google") {
        Some("gcp-cloudsql".into())
    } else if c.contains("azure") {
        Some("azure".into())
    } else if c.contains("digitalocean") {
        Some("digitalocean".into())
    } else {
        None
    }
}

const SYSTEM_SCHEMAS: &str = "('mysql','sys','information_schema','performance_schema')";

/// Collect everything. Fails only if the server can't answer SHOW GLOBAL
/// VARIABLES/STATUS at all — in which case there is nothing to analyze.
pub async fn collect(pool: &sqlx::MySqlPool) -> anyhow::Result<TunerData> {
    let mut data = TunerData {
        vars:   show_kv(pool, "SHOW GLOBAL VARIABLES").await?,
        status: show_kv(pool, "SHOW GLOBAL STATUS").await?,
        ..Default::default()
    };

    data.version = data.v("version").unwrap_or("").to_string();
    data.version_comment = data.v("version_comment").unwrap_or("").to_string();
    data.arch = data.v("version_compile_machine").unwrap_or("").to_string();
    data.flavor = detect_flavor(&data.version, &data.version_comment);
    let (maj, min, patch) = parse_version(&data.version);
    data.major = maj; data.minor = min; data.patch = patch;
    data.uptime_secs = data.s("uptime").unwrap_or(0);
    data.cloud = detect_cloud(&data.version_comment, &data.vars);

    data.users = collect_users(pool).await;
    data.engines = collect_engines(pool).await.unwrap_or_default();
    data.schema = collect_schema_stats(pool).await;
    data.auto_inc = collect_auto_inc(pool).await;
    data.mem_tracked = collect_tracked_memory(pool).await;
    data.replicas = collect_replicas(pool).await;
    data.session_ssl_version = collect_session_ssl(pool).await;
    data.session_time_zone = collect_session_time_zone(pool).await;
    data.top_statements = collect_top_statements(pool).await;
    collect_fragmentation(pool, &mut data).await;
    data.unused_indexes = collect_unused_indexes(pool).await;
    data.galera = derive_galera(&data);

    Ok(data)
}

/// `SHOW …`-style two-column result into a lowercase-keyed map.
async fn show_kv(pool: &sqlx::MySqlPool, sql: &str) -> anyhow::Result<HashMap<String, String>> {
    let rows = sqlx::query(AssertSqlSafe(sql)).fetch_all(pool).await?;
    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
        let k: String = row.try_get(0)?;
        let v: Option<String> = row.try_get(1).ok();
        map.insert(k.to_ascii_lowercase(), v.unwrap_or_default());
    }
    Ok(map)
}

/// One tolerant probe: run `sql`, return None on ANY error.
async fn try_rows(pool: &sqlx::MySqlPool, sql: &str) -> Option<Vec<sqlx::mysql::MySqlRow>> {
    sqlx::query(AssertSqlSafe(sql)).fetch_all(pool).await.ok()
}

fn cell(row: &sqlx::mysql::MySqlRow, i: usize) -> String {
    // System-schema columns with *_bin collations (e.g. mysql.user.user)
    // surface as SQL BINARY, which sqlx refuses to decode as String —
    // fall back to raw bytes + lossy UTF-8. A failed decode must become "",
    // never masquerade as a real value.
    // Numeric columns (COUNT/SUM aggregates, information_schema DATA_FREE, …)
    // arrive as BIGINT/DECIMAL/DOUBLE over the binary protocol, which sqlx
    // likewise refuses as String — decode them numerically and render the
    // exact value (integers and Decimal render losslessly). Without these
    // fallbacks every numeric cell parsed to 0, total_tables came out 0 and
    // the entire schema_checks family silently never fired on a live server.
    row.try_get::<String, _>(i).ok()
        .or_else(|| row.try_get::<i64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<u64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<rust_decimal::Decimal, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<f64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<Vec<u8>, _>(i).ok().map(|b| String::from_utf8_lossy(&b).into_owned()))
        .unwrap_or_default()
}

/// mysql.user, degrading column sets for older servers / MariaDB views.
async fn collect_users(pool: &sqlx::MySqlPool) -> Option<Vec<UserAcct>> {
    if let Some(rows) = try_rows(pool,
        "SELECT user, host, plugin, account_locked, password_expired, authentication_string FROM mysql.user").await
    {
        return Some(rows.iter().map(|r| UserAcct {
            user: cell(r, 0), host: cell(r, 1), plugin: cell(r, 2),
            locked: Some(cell(r, 3).eq_ignore_ascii_case("y") || cell(r, 3) == "1"),
            expired: Some(cell(r, 4).eq_ignore_ascii_case("y") || cell(r, 4) == "1"),
            no_password: Some(cell(r, 5).is_empty()),
        }).collect());
    }
    if let Some(rows) = try_rows(pool,
        "SELECT user, host, plugin, password_expired, authentication_string FROM mysql.user").await
    {
        return Some(rows.iter().map(|r| UserAcct {
            user: cell(r, 0), host: cell(r, 1), plugin: cell(r, 2),
            locked: None,
            expired: Some(cell(r, 3).eq_ignore_ascii_case("y") || cell(r, 3) == "1"),
            no_password: Some(cell(r, 4).is_empty()),
        }).collect());
    }
    // Ancient (pre-5.7): password column, no plugin.
    try_rows(pool, "SELECT user, host, password FROM mysql.user").await.map(|rows| {
        rows.iter().map(|r| UserAcct {
            user: cell(r, 0), host: cell(r, 1), plugin: String::new(),
            locked: None, expired: None,
            no_password: Some(cell(r, 2).is_empty()),
        }).collect()
    })
}

async fn collect_engines(pool: &sqlx::MySqlPool) -> Option<Vec<String>> {
    let rows = try_rows(pool,
        "SELECT ENGINE FROM information_schema.ENGINES WHERE SUPPORT IN ('YES','DEFAULT') ORDER BY ENGINE").await?;
    Some(rows.iter().map(|r| cell(r, 0)).collect())
}

async fn collect_schema_stats(pool: &sqlx::MySqlPool) -> Option<SchemaStats> {
    let agg = format!(
        "SELECT COUNT(*), \
                COALESCE(SUM(ENGINE <> 'InnoDB'),0), \
                COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH),0), \
                COALESCE(SUM(IF(ENGINE = 'InnoDB', DATA_LENGTH + INDEX_LENGTH, 0)),0), \
                COALESCE(SUM(TABLE_COLLATION LIKE 'utf8\\_%' OR TABLE_COLLATION LIKE 'utf8mb3%'),0) \
         FROM information_schema.TABLES \
         WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN {SYSTEM_SCHEMAS}");
    let rows = try_rows(pool, &agg).await?;
    let r = rows.first()?;
    let num = |i: usize| cell(r, i).parse::<f64>().unwrap_or(0.0);
    let mut st = SchemaStats {
        total_tables: num(0) as u64,
        non_innodb:   num(1) as u64,
        total_bytes:  num(2) as u64,
        innodb_bytes: num(3) as u64,
        utf8mb3:      num(4) as u64,
        ..Default::default()
    };

    if st.non_innodb > 0 {
        let q = format!(
            "SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME), ENGINE \
             FROM information_schema.TABLES \
             WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN {SYSTEM_SCHEMAS} \
               AND ENGINE <> 'InnoDB' \
             ORDER BY DATA_LENGTH + INDEX_LENGTH DESC LIMIT 5");
        if let Some(rows) = try_rows(pool, &q).await {
            st.non_innodb_sample = rows.iter().map(|r| format!("{} ({})", cell(r, 0), cell(r, 1))).collect();
        }
    }

    // Tables without a PRIMARY KEY via TABLE_CONSTRAINTS — robust across
    // 5.7/8.x and MariaDB (no dependence on STATISTICS quirks).
    let q = format!(
        "SELECT x.name FROM ( \
           SELECT CONCAT(t.TABLE_SCHEMA, '.', t.TABLE_NAME) AS name, \
                  t.DATA_LENGTH + t.INDEX_LENGTH AS bytes \
           FROM information_schema.TABLES t \
           LEFT JOIN information_schema.TABLE_CONSTRAINTS tc \
             ON tc.TABLE_SCHEMA = t.TABLE_SCHEMA AND tc.TABLE_NAME = t.TABLE_NAME \
            AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY' \
           WHERE t.TABLE_TYPE = 'BASE TABLE' AND t.TABLE_SCHEMA NOT IN {SYSTEM_SCHEMAS} \
             AND tc.CONSTRAINT_NAME IS NULL \
           ORDER BY bytes DESC LIMIT 11) x");
    if let Some(rows) = try_rows(pool, &q).await {
        st.no_pk = rows.len() as u64; // capped at 11 → ">10" display logic lives in checks
        st.no_pk_sample = rows.iter().take(10).map(|r| cell(r, 0)).collect();
    }

    Some(st)
}

/// sys.schema_auto_increment_columns (MySQL 5.7+/8.x ship `sys`; missing or
/// unreadable → None and the check is skipped).
async fn collect_auto_inc(pool: &sqlx::MySqlPool) -> Option<Vec<AutoIncCol>> {
    let rows = try_rows(pool,
        "SELECT table_schema, table_name, column_name, column_type, \
                ROUND(auto_increment_ratio * 100, 1) \
         FROM sys.schema_auto_increment_columns \
         WHERE auto_increment_ratio >= 0.5 \
         ORDER BY auto_increment_ratio DESC LIMIT 10").await?;
    Some(rows.iter().map(|r| AutoIncCol {
        table: format!("{}.{}", cell(r, 0), cell(r, 1)),
        column: cell(r, 2),
        col_type: cell(r, 3),
        pct_used: cell(r, 4).parse().unwrap_or(0.0),
    }).collect())
}

async fn collect_tracked_memory(pool: &sqlx::MySqlPool) -> Option<f64> {
    let rows = try_rows(pool, "SELECT total_allocated FROM sys.memory_global_total").await?;
    rows.first().map(|r| cell(r, 0).parse().unwrap_or(0.0)).filter(|v| *v > 0.0)
}

/// Replica channels via SHOW REPLICA STATUS (8.0.22+) / SHOW SLAVE STATUS,
/// reusing the same tolerant execution path as ops::replication_status.
async fn collect_replicas(pool: &sqlx::MySqlPool) -> Vec<ReplicaChannel> {
    let result = match crate::db::mysql::execute(pool, "SHOW REPLICA STATUS").await {
        Ok(r) => Ok(r),
        Err(_) => crate::db::mysql::execute(pool, "SHOW SLAVE STATUS").await,
    };
    let Ok(r) = result else { return Vec::new() };
    r.rows.iter().map(|row| {
        let kv: HashMap<String, String> = r.columns.iter().zip(row.iter())
            .map(|(c, v)| (c.name.to_ascii_lowercase(), match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Null => String::new(),
                other => other.to_string(),
            }))
            .collect();
        let get = |keys: &[&str]| keys.iter().find_map(|k| kv.get(*k)).cloned().unwrap_or_default();
        let behind = get(&["seconds_behind_source", "seconds_behind_master"]);
        ReplicaChannel {
            name: get(&["channel_name"]),
            io_running: get(&["replica_io_running", "slave_io_running"]),
            sql_running: get(&["replica_sql_running", "slave_sql_running"]),
            seconds_behind: if behind.is_empty() { None } else { behind.parse().ok() },
        }
    }).collect()
}

async fn collect_session_ssl(pool: &sqlx::MySqlPool) -> Option<String> {
    let rows = try_rows(pool, "SHOW SESSION STATUS LIKE 'Ssl_version'").await?;
    rows.first().map(|r| cell(r, 1))
}

async fn collect_session_time_zone(pool: &sqlx::MySqlPool) -> Option<(String, String)> {
    let rows = try_rows(pool,
        "SELECT @@session.time_zone, @@global.time_zone").await?;
    rows.first().map(|r| (cell(r, 0), cell(r, 1)))
}

/// P_S digest summary, only when the consumer is actually enabled.
async fn collect_top_statements(pool: &sqlx::MySqlPool) -> Option<Vec<TopStmt>> {
    let on = try_rows(pool,
        "SELECT COUNT(*) FROM performance_schema.setup_consumers \
         WHERE NAME = 'events_statements_summary_by_digest' AND ENABLED = 'YES'").await
        .and_then(|rows| rows.first().map(|r| cell(r, 0).parse::<u64>().unwrap_or(0)))
        .unwrap_or(0);
    if on == 0 {
        return None;
    }
    let rows = try_rows(pool,
        "SELECT DIGEST_TEXT, COUNT_STAR, ROUND(SUM_TIMER_WAIT/1000000000000, 2) \
         FROM performance_schema.events_statements_summary_by_digest \
         WHERE DIGEST_TEXT IS NOT NULL \
         ORDER BY SUM_TIMER_WAIT DESC LIMIT 5").await?;
    let stmts: Vec<TopStmt> = rows.iter().map(|r| TopStmt {
        digest: cell(r, 0),
        count: cell(r, 1).parse().unwrap_or(0),
        total_secs: cell(r, 2).parse().unwrap_or(0.0),
    }).collect();
    if stmts.is_empty() { None } else { Some(stmts) }
}

/// InnoDB fragmentation via information_schema.TABLES. DATA_FREE is only
/// meaningful per-table for file-per-table tablespaces — for tables living in
/// the shared system tablespace (innodb_file_per_table=OFF) or a general
/// tablespace it reports the whole tablespace's free space against every
/// table. The check reads `innodb_file_per_table` to say so.
async fn collect_fragmentation(pool: &sqlx::MySqlPool, data: &mut TunerData) {
    let agg = format!(
        "SELECT COALESCE(SUM(DATA_FREE),0), COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH),0) \
         FROM information_schema.TABLES \
         WHERE TABLE_TYPE = 'BASE TABLE' AND ENGINE = 'InnoDB' \
           AND TABLE_SCHEMA NOT IN {SYSTEM_SCHEMAS}");
    if let Some(rows) = try_rows(pool, &agg).await {
        if let Some(r) = rows.first() {
            data.frag_total_free_bytes = cell(r, 0).parse::<f64>().unwrap_or(0.0) as u64;
            data.frag_total_bytes = cell(r, 1).parse::<f64>().unwrap_or(0.0) as u64;
        }
    }

    let q = format!(
        "SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME), \
                DATA_LENGTH + INDEX_LENGTH, DATA_FREE \
         FROM information_schema.TABLES \
         WHERE TABLE_TYPE = 'BASE TABLE' AND ENGINE = 'InnoDB' \
           AND TABLE_SCHEMA NOT IN {SYSTEM_SCHEMAS} \
           AND DATA_FREE > 0 AND DATA_LENGTH + INDEX_LENGTH > 0 \
         ORDER BY DATA_FREE DESC LIMIT 10");
    data.frag_tables = try_rows(pool, &q).await.map(|rows| {
        rows.iter().map(|r| FragTable {
            table: cell(r, 0),
            total_bytes: cell(r, 1).parse::<f64>().unwrap_or(0.0) as u64,
            free_bytes: cell(r, 2).parse::<f64>().unwrap_or(0.0) as u64,
        }).collect()
    });
}

/// sys.schema_unused_indexes — secondary indexes with zero recorded reads
/// since server start (the view already excludes PRIMARY). Joined to
/// information_schema.TABLES so the write-amplification cost can be weighed
/// against the size of the table being written. Missing `sys` → None.
async fn collect_unused_indexes(pool: &sqlx::MySqlPool) -> Option<Vec<UnusedIndex>> {
    let rows = try_rows(pool,
        "SELECT CONCAT(u.object_schema, '.', u.object_name), u.index_name, \
                COALESCE(t.DATA_LENGTH + t.INDEX_LENGTH, 0) \
         FROM sys.schema_unused_indexes u \
         LEFT JOIN information_schema.TABLES t \
           ON t.TABLE_SCHEMA = u.object_schema AND t.TABLE_NAME = u.object_name \
         WHERE u.index_name IS NOT NULL AND u.index_name <> 'PRIMARY' \
         ORDER BY t.DATA_LENGTH + t.INDEX_LENGTH DESC LIMIT 20").await?;
    let idx: Vec<UnusedIndex> = rows.iter().map(|r| UnusedIndex {
        table: cell(r, 0),
        index: cell(r, 1),
        table_bytes: cell(r, 2).parse::<f64>().unwrap_or(0.0) as u64,
    }).collect();
    Some(idx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("8.0.46"), (8, 0, 46));
        assert_eq!(parse_version("9.7.1"), (9, 7, 1));
        assert_eq!(parse_version("10.11.18-MariaDB-1:10.11.18+maria~ubu2204"), (10, 11, 18));
        assert_eq!(parse_version("5.7.44-log"), (5, 7, 44));
        assert_eq!(parse_version(""), (0, 0, 0));
    }

    #[test]
    fn detects_flavor() {
        assert_eq!(detect_flavor("8.0.46", "Homebrew"), Flavor::Mysql);
        assert_eq!(detect_flavor("10.11.18-MariaDB", "mariadb.org binary distribution"), Flavor::Mariadb);
        assert_eq!(detect_flavor("8.0.44-35", "Percona Server (GPL), Release 35"), Flavor::Percona);
    }

    #[test]
    fn parses_sizes() {
        assert_eq!(parse_size_bytes("64M"), Some(64 * 1024 * 1024));
        assert_eq!(parse_size_bytes("1G"), Some(1024 * 1024 * 1024));
        assert_eq!(parse_size_bytes("128MB"), Some(128 * 1024 * 1024));
        assert_eq!(parse_size_bytes("67108864"), Some(67108864));
        assert_eq!(parse_size_bytes(" 512k "), Some(512 * 1024));
        assert_eq!(parse_size_bytes("1.5G"), Some(1610612736));
        assert_eq!(parse_size_bytes("auto"), None);
        assert_eq!(parse_size_bytes(""), None);
    }

    #[test]
    fn parses_provider_options() {
        let m = parse_provider_options("gcache.size = 64M; gcs.fc_limit = 16; gcs.sync_donor = no; base_dir = /x/");
        assert_eq!(m.get("gcache.size").map(String::as_str), Some("64M"));
        assert_eq!(m.get("gcs.fc_limit").map(String::as_str), Some("16"));
        assert_eq!(m.get("gcs.sync_donor").map(String::as_str), Some("no"));
        assert_eq!(m.get("base_dir").map(String::as_str), Some("/x/"));
        assert!(parse_provider_options("").is_empty());
    }

    #[test]
    fn galera_detection_uses_the_variable_not_the_status() {
        // MariaDB 11.8 has NO wsrep_on STATUS row — a status-only probe would
        // never detect it. Detection must read the VARIABLES map.
        let mut d = TunerData::default();
        d.status.insert("wsrep_cluster_size".into(), "3".into());
        assert!(derive_galera(&d).is_none(), "no wsrep_on variable → not Galera");
        d.vars.insert("wsrep_on".into(), "OFF".into());
        assert!(derive_galera(&d).is_none(), "provider loaded but OFF → not Galera");
        d.vars.insert("wsrep_on".into(), "ON".into());
        d.vars.insert("wsrep_provider_options".into(), "gcache.size = 64M; gcs.fc_limit = 16".into());
        let g = derive_galera(&d).expect("wsrep_on=ON must detect");
        assert_eq!(g.gcache_size_bytes, Some(64 * 1024 * 1024));
        assert_eq!(g.provider_options.get("gcs.fc_limit").map(String::as_str), Some("16"));
    }
}
