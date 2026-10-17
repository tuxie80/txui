//! Data-generator "Mimic existing data" profiling (plan-datagen-nextgen.md
//! Phase 4, synthesis-lite).
//!
//! One read-only command, `datagen_profile_table`, profiles each column of an
//! existing table so the panel can pre-fill generator + params that reproduce
//! the SHAPE of the data — never the values. Per column it reports: sampled
//! row count, null %, distinct count, min/max (numeric and temporal), avg/max
//! length (text) and the 8 most common values with frequencies (the raw
//! material of a weighted choice). The profile → generator mapping is pure TS
//! (src/utils/datagenMimic.ts); this module only measures.
//!
//! Work is capped: every measurement runs against a derived-table SAMPLE of at
//! most `PROFILE_SAMPLE_ROWS` rows in arrival order (no ORDER BY — a sort
//! would cost more than the profiling is worth). On a small table the sample
//! IS the table; on a huge one the numbers describe its first ~100k rows, and
//! the panel's log line says so. TABLESAMPLE (PG/MSSQL) was rejected: not
//! portable, and arrival order is at least honest about what it is.
//!
//! A column whose type resists profiling (PG `json` has no DISTINCT equality,
//! MSSQL `text` cannot GROUP BY) does not fail the table: its profile comes
//! back with `error` set, and the panel keeps the name-based suggestion for
//! it. Read-only by construction — the heaviest statement here is a bounded
//! SELECT — so no write guard applies, and read-only sessions profile fine
//! (the generator itself refuses them later, at run time).

use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::db::connection::get_session_pub;
use crate::db::types::{LiveSession, QueryResult};
use crate::state::AppState;
use super::datagen_fk::{ident_parts, quote_qualified};

/// Rows sampled per column profiling query.
pub const PROFILE_SAMPLE_ROWS: u32 = 100_000;
/// Top-N values kept per column — enough to build a weighted choice.
pub const TOP_VALUES: u32 = 8;

/// What kind of data a column holds, from its declared type. The SQL that is
/// safe to run against it follows from this, not from the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColFamily { Numeric, Temporal, Text, Bool, Other }

impl ColFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            ColFamily::Numeric => "numeric",
            ColFamily::Temporal => "temporal",
            ColFamily::Text => "text",
            ColFamily::Bool => "bool",
            ColFamily::Other => "other",
        }
    }
}

/// Classify a declared SQL type. Kept consistent with the type regexes in
/// `suggestGenerator` (src/utils/datagen.ts) so a column's family agrees with
/// the generator the name heuristic would have picked: TINYINT(1) is MySQL's
/// boolean and is checked BEFORE the INT family catches it; YEAR is numeric
/// (its min/max are years, not date strings).
pub fn family_of(type_name: &str) -> ColFamily {
    let t = type_name.trim().to_uppercase();
    let base = t.split('(').next().unwrap_or("").trim();
    if base == "BOOL" || base == "BOOLEAN" || t == "TINYINT(1)" { return ColFamily::Bool; }
    // DATETIME starts with DATE; TIMESTAMP starts with TIME. A bare TIME holds
    // a clock reading, but its min/max still profile usefully as strings.
    if base.starts_with("DATE") || base.starts_with("TIME") { return ColFamily::Temporal; }
    if base.contains("INT") || base.contains("SERIAL")
        || matches!(base, "DECIMAL" | "NUMERIC" | "DEC" | "FIXED" | "FLOAT" | "DOUBLE"
            | "REAL" | "MONEY" | "SMALLMONEY" | "NUMBER" | "YEAR")
        || base.starts_with("DOUBLE")
    {
        return ColFamily::Numeric;
    }
    if base.contains("CHAR") || base.contains("TEXT") || base.contains("CLOB")
        || base == "ENUM" || base == "SET"
        || base == "UUID" || base == "UNIQUEIDENTIFIER"
    {
        return ColFamily::Text;
    }
    ColFamily::Other
}

/// Character count, cast first so uuid/uniqueidentifier take the text path
/// too (PG has no `length(uuid)`). MSSQL's LEN ignores trailing spaces —
/// noted, not fixed: an approximation is all this is for.
fn len_expr(col: &str, quote: char) -> String {
    match quote {
        '`' => format!("CHAR_LENGTH(CAST({col} AS CHAR))"),
        '"' => format!("LENGTH(CAST({col} AS TEXT))"),
        '[' => format!("LEN(CAST({col} AS NVARCHAR(MAX)))"),
        _ => unreachable!("profile SQL knows three quote styles"),
    }
}

/// The bounded sample every measurement runs against, as a FROM item.
/// T-SQL has no LIMIT; TOP goes inside the SELECT.
pub fn sample_from(table: &str, col_q: &str, quote: char) -> String {
    if quote == '[' {
        format!("(SELECT TOP ({PROFILE_SAMPLE_ROWS}) {col_q} AS v FROM {table}) AS s")
    } else {
        format!("(SELECT {col_q} AS v FROM {table} LIMIT {PROFILE_SAMPLE_ROWS}) AS s")
    }
}

/// The aggregate SELECT list for a family, as (alias, expression) pairs — the
/// decoder zips against the same list, so there is no positional guessing.
fn stats_selects(family: ColFamily, quote: char) -> Vec<(&'static str, String)> {
    // COUNT(v) skips NULLs portably, so non-null count and null % fall out
    // of the same pass; COUNT(*) on the sample doubles as sampled_rows.
    let mut v = vec![
        ("total", "COUNT(*)".to_string()),
        ("non_null", "COUNT(v)".to_string()),
    ];
    match family {
        // DISTINCT/GROUP BY on json, blob or geometry fails on at least one
        // engine (PG json has no equality) — Other gets row counts only.
        ColFamily::Other => {}
        ColFamily::Bool => {
            v.push(("distinct_n", "COUNT(DISTINCT v)".into()));
        }
        ColFamily::Numeric | ColFamily::Temporal => {
            v.push(("distinct_n", "COUNT(DISTINCT v)".into()));
            v.push(("min_v", "MIN(v)".into()));
            v.push(("max_v", "MAX(v)".into()));
        }
        ColFamily::Text => {
            v.push(("distinct_n", "COUNT(DISTINCT v)".into()));
            let len = len_expr("v", quote);
            v.push(("avg_len", format!("AVG({len})")));
            v.push(("max_len", format!("MAX({len})")));
        }
    }
    v
}

/// One aggregate pass over the sample.
pub fn stats_sql(family: ColFamily, table: &str, col_q: &str, quote: char) -> String {
    let fields = stats_selects(family, quote)
        .iter().map(|(a, e)| format!("{e} AS {a}")).collect::<Vec<_>>().join(", ");
    format!("SELECT {fields} FROM {}", sample_from(table, col_q, quote))
}

/// The second pass: most common values with frequencies, NULL excluded (the
/// null % already carries that share).
pub fn topn_sql(table: &str, col_q: &str, quote: char) -> String {
    let from = sample_from(table, col_q, quote);
    if quote == '[' {
        format!("SELECT TOP ({TOP_VALUES}) v, COUNT(*) AS c FROM {from} WHERE v IS NOT NULL GROUP BY v ORDER BY c DESC")
    } else {
        format!("SELECT v, COUNT(*) AS c FROM {from} WHERE v IS NOT NULL GROUP BY v ORDER BY c DESC LIMIT {TOP_VALUES}")
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopValue {
    pub value: serde_json::Value,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnProfile {
    pub column: String,
    pub family: String,
    /// Rows the sample actually held (≤ PROFILE_SAMPLE_ROWS).
    pub sampled_rows: u64,
    pub null_pct: f64,
    /// COUNT(DISTINCT) over the sample — None for unprofilable types.
    pub distinct: Option<u64>,
    /// Raw decoded values: numbers as JSON numbers, DECIMAL and dates as
    /// strings — the mapping parses either.
    pub min: Option<serde_json::Value>,
    pub max: Option<serde_json::Value>,
    pub avg_len: Option<f64>,
    pub max_len: Option<u64>,
    pub top_values: Vec<TopValue>,
    /// Set INSTEAD of failing the table when this column's type resists
    /// profiling — the panel keeps the name-based suggestion for it.
    pub error: Option<String>,
}

impl ColumnProfile {
    fn failed(col: &ProfileColumn, msg: String) -> Self {
        ColumnProfile {
            column: col.name.clone(),
            family: family_of(&col.type_name).as_str().into(),
            sampled_rows: 0, null_pct: 0.0, distinct: None,
            min: None, max: None, avg_len: None, max_len: None,
            top_values: vec![], error: Some(msg),
        }
    }
}

fn json_u64(v: Option<&serde_json::Value>) -> Option<u64> {
    v.and_then(|v| v.as_u64()
        .or_else(|| v.as_i64().map(|x| x.max(0) as u64))
        .or_else(|| v.as_f64().map(|x| x.max(0.0) as u64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

fn json_f64(v: Option<&serde_json::Value>) -> Option<f64> {
    v.and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

async fn run(session: &LiveSession, sql: &str) -> anyhow::Result<QueryResult> {
    match session {
        LiveSession::Mysql(p) => crate::db::mysql::execute(p, sql).await,
        LiveSession::Postgres(p) => crate::db::postgres::execute(p, sql).await,
        LiveSession::Sqlite(p) => crate::db::sqlite::execute(p, sql).await,
        LiveSession::SqlServer(s) => crate::db::sqlserver::execute(s, sql).await,
        _ => Err(anyhow::anyhow!("datagen profiling is not supported for this engine")),
    }
}

async fn profile_column(
    session: &LiveSession, quote: char, table: &str, col: &ProfileColumn,
) -> anyhow::Result<ColumnProfile> {
    let family = family_of(&col.type_name);
    let col_q = quote_qualified(&ident_parts(&col.name, quote), quote);
    let selects = stats_selects(family, quote);
    let stats = run(session, &stats_sql(family, table, &col_q, quote)).await?;
    let row = stats.rows.first().cloned().unwrap_or_default();
    let at = |alias: &str| -> Option<&serde_json::Value> {
        selects.iter().position(|(a, _)| *a == alias).and_then(|i| row.get(i))
    };
    let total = json_u64(at("total")).unwrap_or(0);
    let non_null = json_u64(at("non_null")).unwrap_or(0);
    let null_pct = if total > 0 { (total - non_null) as f64 * 100.0 / total as f64 } else { 0.0 };
    let top_values = if family == ColFamily::Other {
        vec![]
    } else {
        run(session, &topn_sql(table, &col_q, quote)).await?.rows.iter()
            .filter_map(|r| r.first().map(|v| TopValue {
                value: v.clone(),
                count: json_u64(r.get(1)).unwrap_or(0),
            }))
            .collect()
    };
    Ok(ColumnProfile {
        column: col.name.clone(),
        family: family.as_str().into(),
        sampled_rows: total,
        null_pct,
        distinct: json_u64(at("distinct_n")),
        min: at("min_v").filter(|v| !v.is_null()).cloned(),
        max: at("max_v").filter(|v| !v.is_null()).cloned(),
        avg_len: json_f64(at("avg_len")),
        max_len: json_u64(at("max_len")),
        top_values,
        error: None,
    })
}

/// Profile every column of an existing table for the data generator's
/// "Mimic existing data" button. Read-only; a per-column failure degrades to
/// `error` on that column's profile rather than failing the table.
/// `table` arrives pre-quoted, possibly schema-qualified — the panel builds it
/// engine-correctly (same convention as `resolve_sequence_start`).
#[tauri::command]
pub async fn datagen_profile_table(
    session_id: Uuid,
    table: String,
    columns: Vec<ProfileColumn>,
    state: State<'_, AppState>,
) -> Result<Vec<ColumnProfile>, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions).await?;
    let quote = match session.as_ref() {
        LiveSession::Mysql(_) => '`',
        LiveSession::Postgres(_) | LiveSession::Sqlite(_) => '"',
        // Brackets are not a symmetric pair, but every builder below takes
        // the `[` arm explicitly (datagen_fk precedent).
        LiveSession::SqlServer(_) => '[',
        _ => return Err("datagen profiling is not supported for this engine".into()),
    };
    let mut out = Vec::with_capacity(columns.len());
    for col in &columns {
        let p = profile_column(session.as_ref(), quote, &table, col)
            .await
            .unwrap_or_else(|e| ColumnProfile::failed(col, e.to_string()));
        out.push(p);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_classification() {
        assert_eq!(family_of("INT"), ColFamily::Numeric);
        assert_eq!(family_of("bigint unsigned"), ColFamily::Numeric);
        assert_eq!(family_of("DECIMAL(10,2)"), ColFamily::Numeric);
        assert_eq!(family_of("numeric"), ColFamily::Numeric);
        assert_eq!(family_of("double precision"), ColFamily::Numeric);
        assert_eq!(family_of("YEAR"), ColFamily::Numeric);
        // MySQL's boolean alias must not fall into the INT family.
        assert_eq!(family_of("TINYINT(1)"), ColFamily::Bool);
        assert_eq!(family_of("TINYINT(4)"), ColFamily::Numeric);
        assert_eq!(family_of("BOOLEAN"), ColFamily::Bool);
        assert_eq!(family_of("DATE"), ColFamily::Temporal);
        assert_eq!(family_of("DATETIME"), ColFamily::Temporal);
        assert_eq!(family_of("TIMESTAMP"), ColFamily::Temporal);
        assert_eq!(family_of("timestamp with time zone"), ColFamily::Temporal);
        assert_eq!(family_of("TIME"), ColFamily::Temporal);
        assert_eq!(family_of("VARCHAR(100)"), ColFamily::Text);
        assert_eq!(family_of("character varying(50)"), ColFamily::Text);
        assert_eq!(family_of("TEXT"), ColFamily::Text);
        assert_eq!(family_of("ENUM('a','b')"), ColFamily::Text);
        assert_eq!(family_of("uniqueidentifier"), ColFamily::Text);
        assert_eq!(family_of("JSON"), ColFamily::Other);
        assert_eq!(family_of("jsonb"), ColFamily::Other);
        assert_eq!(family_of("BLOB"), ColFamily::Other);
        assert_eq!(family_of("bytea"), ColFamily::Other);
        assert_eq!(family_of("geometry"), ColFamily::Other);
    }

    #[test]
    fn stats_sql_per_family_and_engine() {
        // MySQL text: distinct + casted lengths over a bounded sample.
        assert_eq!(
            stats_sql(ColFamily::Text, "`shop`.`t`", "`name`", '`'),
            "SELECT COUNT(*) AS total, COUNT(v) AS non_null, COUNT(DISTINCT v) AS distinct_n, \
             AVG(CHAR_LENGTH(CAST(v AS CHAR))) AS avg_len, MAX(CHAR_LENGTH(CAST(v AS CHAR))) AS max_len \
             FROM (SELECT `name` AS v FROM `shop`.`t` LIMIT 100000) AS s"
        );
        // PG numeric: min/max, no lengths.
        let sql = stats_sql(ColFamily::Numeric, "\"t\"", "\"price\"", '"');
        assert!(sql.contains("MIN(v) AS min_v, MAX(v) AS max_v"), "{sql}");
        assert!(!sql.contains("LENGTH"), "{sql}");
        assert!(sql.contains("LIMIT 100000"), "{sql}");
        // SQL Server temporal: TOP inside the SELECT, no LIMIT.
        let sql = stats_sql(ColFamily::Temporal, "[dbo].[t]", "[created_at]", '[');
        assert!(sql.contains("SELECT TOP (100000) [created_at] AS v FROM [dbo].[t]"), "{sql}");
        assert!(!sql.contains("LIMIT"), "{sql}");
        // Other profiles row counts only — DISTINCT json would fail on PG.
        assert_eq!(
            stats_sql(ColFamily::Other, "\"t\"", "\"doc\"", '"'),
            "SELECT COUNT(*) AS total, COUNT(v) AS non_null \
             FROM (SELECT \"doc\" AS v FROM \"t\" LIMIT 100000) AS s"
        );
        // SQLite shares the double-quote dialect.
        let sql = stats_sql(ColFamily::Bool, "\"t\"", "\"active\"", '"');
        assert_eq!(
            sql,
            "SELECT COUNT(*) AS total, COUNT(v) AS non_null, COUNT(DISTINCT v) AS distinct_n \
             FROM (SELECT \"active\" AS v FROM \"t\" LIMIT 100000) AS s"
        );
    }

    #[test]
    fn topn_sql_per_engine() {
        assert_eq!(
            topn_sql("`t`", "`status`", '`'),
            "SELECT v, COUNT(*) AS c FROM (SELECT `status` AS v FROM `t` LIMIT 100000) AS s \
             WHERE v IS NOT NULL GROUP BY v ORDER BY c DESC LIMIT 8"
        );
        let ms = topn_sql("[dbo].[t]", "[status]", '[');
        assert!(ms.starts_with("SELECT TOP (8) v, COUNT(*) AS c FROM (SELECT TOP (100000)"), "{ms}");
        assert!(ms.ends_with("GROUP BY v ORDER BY c DESC"), "{ms}");
        assert!(!ms.contains("LIMIT"), "{ms}");
    }
}
