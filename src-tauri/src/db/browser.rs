/// Data browser: paginated fetch, table metadata, inline DML.
/// All SQL is built programmatically — values are bound as parameters
/// to prevent injection.
use sqlx::AssertSqlSafe;
use anyhow::Result;

use super::types::{
    FilterClause, FilterOp,
    SortClause, SortDir, TableColumn, TableMeta,
};

// ── Public API (dispatched per-engine by commands/browser.rs) ────────────────

pub async fn get_table_meta_mysql(
    pool: &sqlx::MySqlPool,
    ns: &str,
    table: &str,
) -> Result<TableMeta> {

    use crate::db::mysql::lossy_str;

    // Columns (lossy decode — Cloud SQL serves these as VARBINARY)
    let cols: Vec<(String, String, String, String)> = sqlx::query(
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION"
    )
    .bind(ns).bind(table)
    .fetch_all(pool).await?
    .iter()
    .map(|r| (lossy_str(r, 0), lossy_str(r, 1), lossy_str(r, 2), lossy_str(r, 3)))
    .collect();

    // FK references
    let fks: Vec<(String, String, String)> = sqlx::query(
        "SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
         FROM information_schema.KEY_COLUMN_USAGE \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
           AND REFERENCED_TABLE_NAME IS NOT NULL"
    )
    .bind(ns).bind(table)
    .fetch_all(pool).await?
    .iter()
    .map(|r| (lossy_str(r, 0), lossy_str(r, 1), lossy_str(r, 2)))
    .collect();

    let fk_map: std::collections::HashMap<String, (String, String)> =
        fks.into_iter().map(|(col, ref_table, ref_col)| (col, (ref_table, ref_col))).collect();

    let mut pk_columns = Vec::new();
    let columns: Vec<TableColumn> = cols.into_iter().map(|(name, type_name, nullable, key)| {
        if key == "PRI" { pk_columns.push(name.clone()); }
        let (fk_table, fk_column) = fk_map.get(&name)
            .map(|(t, c)| (Some(format!("{}.{}", ns, t)), Some(c.clone())))
            .unwrap_or((None, None));
        TableColumn { name, type_name, nullable: nullable == "YES",
                      primary_key: key == "PRI", fk_table, fk_column }
    }).collect();

    // Approx row count from stats (fast)
    let total: Option<i64> = sqlx::query_scalar(
        "SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?"
    )
    .bind(ns).bind(table)
    .fetch_optional(pool).await.ok().flatten();

    Ok(TableMeta { columns, pk_columns, total_rows: total })
}

pub async fn get_table_meta_pg(
    pool: &sqlx::PgPool,
    ns: &str,
    table: &str,
) -> Result<TableMeta> {

    // pg_attribute, not information_schema.columns: materialized views have no
    // information_schema row at all, so browsing one returned zero columns.
    // format_type() also renders the declared type ("numeric(14,2)", "text[]")
    // instead of the internal udt_name ("numeric", "_text").
    let cols: Vec<(String, String, bool)> = sqlx::query_as(
        "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), NOT a.attnotnull \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 \
           AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum"
    )
    .bind(ns).bind(table)
    .fetch_all(pool).await?;

    let pk_cols: Vec<String> = sqlx::query_scalar(
        "SELECT a.attname \
         FROM pg_catalog.pg_index ix \
         JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(ix.indkey) \
         WHERE n.nspname = $1 AND c.relname = $2 AND ix.indisprimary"
    )
    .bind(ns).bind(table)
    .fetch_all(pool).await.unwrap_or_default();

    // Foreign keys, paired by ORDINAL POSITION.
    //
    // The previous query joined information_schema.referential_constraints to
    // key_column_usage and constraint_column_usage on constraint name alone.
    // For a single-column FK that happens to be right; for a COMPOSITE FK it
    // is a cartesian product — a two-column key yielded 2×2 rows and the map
    // kept whichever landed last, so the data browser could offer to navigate
    // `line_no` to the parent's `order_id`. pg_constraint stores the two sides
    // as parallel arrays (conkey/confkey), so unnesting them together is the
    // only way to pair them correctly.
    let fks: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT att.attname, fns.nspname, fc.relname, fatt.attname \
         FROM pg_catalog.pg_constraint c \
         JOIN pg_catalog.pg_class t ON t.oid = c.conrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_catalog.pg_class fc ON fc.oid = c.confrelid \
         JOIN pg_catalog.pg_namespace fns ON fns.oid = fc.relnamespace \
         JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(loc, rem, ord) ON true \
         JOIN pg_catalog.pg_attribute att  ON att.attrelid  = c.conrelid  AND att.attnum = k.loc \
         JOIN pg_catalog.pg_attribute fatt ON fatt.attrelid = c.confrelid AND fatt.attnum = k.rem \
         WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'f' \
         ORDER BY c.conname, k.ord"
    )
    .bind(ns).bind(table)
    .fetch_all(pool).await.unwrap_or_default();

    let fk_map: std::collections::HashMap<String, (String, String, String)> =
        fks.into_iter().map(|(col, ref_ns, ref_table, ref_col)| (col, (ref_ns, ref_table, ref_col))).collect();

    let columns: Vec<TableColumn> = cols.into_iter().map(|(name, type_name, nullable)| {
        let (fk_table, fk_column) = fk_map.get(&name)
            .map(|(s, t, c)| (Some(format!("{}.{}", s, t)), Some(c.clone())))
            .unwrap_or((None, None));
        let pk = pk_cols.contains(&name);
        TableColumn { name, type_name, nullable, primary_key: pk, fk_table, fk_column }
    }).collect();

    // Approximate row count. Restricted to relkinds that hold rows so an
    // index sharing the table's name cannot match, and reltuples = -1
    // (PG 10+ for "never analyzed") becomes "unknown" rather than a
    // nonsensical -1 row count in the grid footer. A partitioned parent
    // ('p') keeps its own reltuples at 0, so its children are summed.
    let total: Option<i64> = sqlx::query_scalar(
        "SELECT CASE WHEN c.relkind = 'p' THEN ( \
                  SELECT COALESCE(SUM(GREATEST(child.reltuples, 0)), 0)::bigint \
                  FROM pg_catalog.pg_inherits i \
                  JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid \
                  WHERE i.inhparent = c.oid) \
                ELSE NULLIF(c.reltuples, -1)::bigint END \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 \
           AND c.relkind IN ('r','p','m','f','v')"
    )
    .bind(ns).bind(table)
    .fetch_optional(pool).await.ok().flatten();

    Ok(TableMeta { columns, pk_columns: pk_cols, total_rows: total })
}

/// Column name → PostgreSQL type for one relation, used to type the bound
/// filter parameters. Reads pg_attribute so it also covers materialized views
/// (absent from information_schema.columns). Failure is non-fatal: an empty
/// map just means the filters render uncast, exactly as before.
pub async fn pg_column_types<'e, E>(pool: E, table: &str) -> ColTypes
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let (ns, rel) = match table.split_once('.') {
        Some((n, t)) => (n, t),
        None => ("public", table),
    };
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT lower(a.attname), pg_catalog.format_type(a.atttypid, a.atttypmod) \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped"
    )
    .bind(ns).bind(rel)
    .fetch_all(pool).await
    .unwrap_or_default();

    rows.into_iter().collect()
}

/// Column metadata for a ClickHouse table.
///
/// ClickHouse has no foreign keys and no nullable-by-default: a column is NOT
/// NULL unless its type is wrapped in `Nullable(...)`. The primary key is the
/// sorting key prefix, exposed per column as `is_in_primary_key`.
/// SQLite table metadata.
///
/// `PRAGMA foreign_key_list` gives real FKs, which SQLite does record even
/// when enforcement is off (`PRAGMA foreign_keys` defaults to OFF) — the
/// browser's FK navigation should work either way, since the declaration is
/// what describes the schema.
pub async fn get_table_meta_sqlite(
    pool: &sqlx::SqlitePool,
    database: &str,
    table: &str,
) -> Result<TableMeta> {
    use sqlx::Row as _;
    let q = format!(
        "\"{}\".\"{}\"",
        database.replace('"', "\"\""),
        table.replace('"', "\"\"")
    );
    // PRAGMA takes its schema BEFORE the pragma name — a dotted argument is a
    // syntax error. See db::sqlite::pragma.
    let pragma = |name: &str| format!(
        "PRAGMA \"{}\".{}(\"{}\")",
        database.replace('"', "\"\""), name, table.replace('"', "\"\"")
    );

    // FK map first, so each column can carry its target.
    let mut fks: std::collections::HashMap<String, (String, String)> = Default::default();
    if let Ok(rows) = sqlx::query(AssertSqlSafe(pragma("foreign_key_list"))).fetch_all(pool).await {
        for r in &rows {
            let from: String = r.try_get("from").unwrap_or_default();
            let to_table: String = r.try_get("table").unwrap_or_default();
            let to_col: String = r.try_get("to").unwrap_or_default();
            if !from.is_empty() && !to_table.is_empty() {
                fks.insert(from, (to_table, to_col));
            }
        }
    }

    let rows = sqlx::query(AssertSqlSafe(pragma("table_info"))).fetch_all(pool).await?;
    let mut pk_columns = Vec::new();
    let columns: Vec<TableColumn> = rows.iter().map(|r| {
        let name: String = r.try_get("name").unwrap_or_default();
        let decl: String = r.try_get("type").unwrap_or_default();
        let notnull: i64 = r.try_get("notnull").unwrap_or(0);
        let pk: i64 = r.try_get("pk").unwrap_or(0);
        if pk > 0 { pk_columns.push(name.clone()); }
        let fk = fks.get(&name);
        TableColumn {
            nullable: notnull == 0,
            primary_key: pk > 0,
            type_name: if decl.is_empty() { "(untyped)".into() } else { decl },
            fk_table: fk.map(|(t, _)| t.clone()),
            fk_column: fk.map(|(_, c)| c.clone()),
            name,
        }
    }).collect();

    // SQLite has no row-count metadata — no statistics table, no reltuples.
    // COUNT(*) is the only answer, and on a local file it is cheap enough.
    let total: Option<i64> = sqlx::query_scalar(AssertSqlSafe(format!("SELECT COUNT(*) FROM {q}")))
        .fetch_one(pool).await.ok();

    Ok(TableMeta { columns, pk_columns, total_rows: total })
}

/// Parquet "table" metadata — the file's own leaf columns.
///
/// The row count is exact and free: it is in the footer, not counted.
pub fn get_table_meta_parquet(file: &crate::db::parquet::ParquetFile) -> TableMeta {
    let descr = file.metadata.file_metadata().schema_descr();
    let columns: Vec<TableColumn> = descr.columns().iter().map(|c| TableColumn {
        name: c.path().string(),
        type_name: c.physical_type().to_string(),
        // Repetition is Parquet's nullability: a leaf at max_def_level 0 is
        // REQUIRED and can never hold a null.
        nullable: c.max_def_level() > 0,
        // A Parquet file has neither keys nor foreign keys.
        primary_key: false,
        fk_table: None,
        fk_column: None,
    }).collect();
    TableMeta { columns, pk_columns: vec![], total_rows: Some(file.num_rows()) }
}

pub async fn get_table_meta_clickhouse(
    session: &crate::db::clickhouse::ChSession,
    database: &str,
    table: &str,
) -> Result<TableMeta> {
    let esc = |s: &str| s.replace('\'', "\\'");
    let rows = crate::db::clickhouse::execute(session, &format!(
        "SELECT name, type, is_in_primary_key FROM system.columns \
         WHERE database = '{}' AND table = '{}' ORDER BY position",
        esc(database), esc(table)
    )).await?;

    let mut pk_columns = Vec::new();
    let columns: Vec<TableColumn> = rows.rows.iter().filter_map(|r| {
        let name = r.first()?.as_str()?.to_string();
        let ty = r.get(1)?.as_str().unwrap_or("").to_string();
        // JSONCompact renders UInt8 as a number, so accept either shape.
        let in_pk = r.get(2).map(|v| v.as_u64() == Some(1) || v.as_str() == Some("1")).unwrap_or(false);
        if in_pk { pk_columns.push(name.clone()); }
        Some(TableColumn {
            nullable: ty.contains("Nullable("),
            name,
            type_name: ty,
            primary_key: in_pk,
            fk_table: None,   // ClickHouse has no foreign keys
            fk_column: None,
        })
    }).collect();

    // Row count from part metadata rather than COUNT(*): on a table with
    // billions of rows the exact count is an expensive full scan, and the
    // browser only needs it to size the scrollbar.
    let total = crate::db::clickhouse::execute(session, &format!(
        "SELECT sum(rows) FROM system.parts \
         WHERE database = '{}' AND table = '{}' AND active",
        esc(database), esc(table)
    )).await.ok()
        .and_then(|r| r.rows.first().and_then(|row| row.first()).cloned())
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));

    Ok(TableMeta { columns, pk_columns, total_rows: total })
}

/// A ClickHouse browse query plus the typed parameters it references.
pub struct ChBrowseQuery {
    pub sql: String,
    /// (param name, ClickHouse type, value) — sent as `param_<name>` and
    /// referenced in the SQL as `{<name>:<Type>}`. ClickHouse binds these
    /// server-side, so a value can never be parsed as SQL.
    pub params: Vec<(String, String, String)>,
}

/// ClickHouse identifier quoting: backticks, doubled to escape.
fn ch_ident(name: &str) -> String { format!("`{}`", name.replace('`', "``")) }

fn ch_table(table: &str) -> String {
    match table.split_once('.') {
        Some((db, t)) => format!("{}.{}", ch_ident(db), ch_ident(t)),
        None => ch_ident(table),
    }
}

/// A parameter's declared type. `Nullable(T)`/`LowCardinality(T)` wrappers are
/// stripped: a bound value is never null and the wrapper is not accepted in a
/// parameter declaration.
fn ch_param_type(col_type: &str) -> String {
    let mut t = col_type.trim();
    loop {
        let stripped = t.strip_prefix("Nullable(").or_else(|| t.strip_prefix("LowCardinality("));
        match stripped {
            Some(inner) => t = inner.strip_suffix(')').unwrap_or(inner),
            None => break,
        }
    }
    // Anything parameterised (Decimal(x,y), DateTime64(3), Enum8(...)) binds
    // fine as a String and is compared after ClickHouse's own coercion.
    match t {
        x if x.starts_with("Int") || x.starts_with("UInt") || x.starts_with("Float")
             || x == "String" || x == "Date" || x == "Date32" || x == "DateTime" || x == "UUID"
             || x == "Bool" => x.to_string(),
        _ => "String".to_string(),
    }
}

/// Build a parameterised SELECT for the ClickHouse data browser.
pub fn build_select_clickhouse(
    table: &str,
    filters: &[FilterClause],
    sort: &[SortClause],
    limit: i64,
    offset: i64,
    col_types: &ColTypes,
) -> ChBrowseQuery {
    let mut params: Vec<(String, String, String)> = Vec::new();

    let where_clause = if filters.is_empty() {
        String::new()
    } else {
        let parts: Vec<String> = filters.iter().enumerate().map(|(i, f)| {
            let col = ch_ident(&f.column);
            if !f.op.has_value() {
                // ClickHouse has no NULL for a non-Nullable column, but the
                // operators still parse and are correct for Nullable ones.
                return format!("{} {}", col, f.op.to_sql());
            }
            let name = format!("p{i}");
            let ty = col_types.get(&f.column.to_ascii_lowercase())
                .map(|t| ch_param_type(t))
                .unwrap_or_else(|| "String".to_string());
            params.push((name.clone(), ty.clone(), f.value.clone().unwrap_or_default()));
            format!("{} {} {{{}:{}}}", col, f.op.to_sql(), name, ty)
        }).collect();
        format!(" WHERE {}", parts.join(" AND "))
    };

    let order_clause = if sort.is_empty() {
        String::new()
    } else {
        let parts: Vec<String> = sort.iter().map(|s| {
            let dir = match s.direction { SortDir::Asc => "ASC", SortDir::Desc => "DESC" };
            format!("{} {}", ch_ident(&s.column), dir)
        }).collect();
        format!(" ORDER BY {}", parts.join(", "))
    };

    // LIMIT/OFFSET are i64 here, never user text — inlined for the same reason
    // as the other engines.
    ChBrowseQuery {
        sql: format!("SELECT * FROM {}{}{} LIMIT {} OFFSET {}",
                     ch_table(table), where_clause, order_clause, limit.max(0), offset.max(0)),
        params,
    }
}

/// Column name (lowercased) → declared ClickHouse type, for typing the bound
/// parameters above.
pub async fn ch_column_types(
    session: &crate::db::clickhouse::ChSession,
    table: &str,
) -> ColTypes {
    let (db, tbl) = match table.split_once('.') {
        Some((d, t)) => (d, t),
        None => ("default", table),
    };
    let esc = |s: &str| s.replace('\'', "\\'");
    let Ok(r) = crate::db::clickhouse::execute(session, &format!(
        "SELECT lower(name), type FROM system.columns WHERE database = '{}' AND table = '{}'",
        esc(db), esc(tbl)
    )).await else { return ColTypes::new() };

    r.rows.iter().filter_map(|row| {
        Some((row.first()?.as_str()?.to_string(), row.get(1)?.as_str()?.to_string()))
    }).collect()
}

// ── Query builder ─────────────────────────────────────────────────────────────

pub struct BrowseQuery {
    pub sql:    String,
    pub values: Vec<String>, // all params are strings; cast in DB
}

/// Column name (lowercased) → PostgreSQL type name, used to type the bound
/// parameters. Empty for MySQL, which coerces strings on its own.
pub type ColTypes = std::collections::BTreeMap<String, String>;

/// True for types a text parameter already compares against without a cast.
fn is_texty(pg_type: &str) -> bool {
    matches!(
        pg_type.trim().to_ascii_lowercase().as_str(),
        "text" | "varchar" | "character varying" | "char" | "character"
            | "bpchar" | "name" | "citext" | "unknown"
    )
}

/// Render the comparison for one filter.
///
/// Every value crosses the IPC boundary as a string and sqlx binds it with the
/// TEXT type OID. PostgreSQL does no implicit text→other coercion, so
/// `WHERE "id" = $1` against a bigint column fails outright with
/// `operator does not exist: bigint = text` — which broke every data-browser
/// filter on a non-text column. Casting the *parameter* to the column's own
/// type fixes it and keeps the column bare, so indexes are still usable.
/// LIKE is the mirror case: it needs text on the left, so there the *column*
/// is cast instead (a scan either way for a non-text column).
fn render_filter(f: &FilterClause, placeholder: Option<String>, pg: bool, col_types: &ColTypes) -> String {
    let col = quote_ident(&f.column, pg);
    let Some(p) = placeholder else {
        return format!("{} {}", col, f.op.to_sql());
    };
    if !pg {
        return format!("{} {} {}", col, f.op.to_sql(), p);
    }

    let ty = col_types.get(&f.column.to_ascii_lowercase()).map(String::as_str);
    let like = matches!(f.op, FilterOp::Like | FilterOp::NotLike);

    match (like, ty) {
        // LIKE on a non-text column: cast the column so the pattern applies.
        (true, Some(t)) if !is_texty(t) => format!("{}::text {} {}", col, f.op.to_sql(), p),
        (true, _)                       => format!("{} {} {}", col, f.op.to_sql(), p),
        // Ordinary comparison: type the parameter, leave the column indexable.
        (false, Some(t)) if !is_texty(t) => format!("{} {} {}::{}", col, f.op.to_sql(), p, t),
        (false, _)                       => format!("{} {} {}", col, f.op.to_sql(), p),
    }
}

/// Build a parameterised SELECT for the data browser.
/// Returns (sql_template, bound_values).
/// Uses positional `?` for MySQL and `$N` for PG.
pub fn build_select(
    table: &str,
    filters: &[FilterClause],
    sort: &[SortClause],
    limit: i64,
    offset: i64,
    pg: bool,
    col_types: &ColTypes,
) -> BrowseQuery {
    let mut values: Vec<String> = Vec::new();
    let mut param_n = 1usize;

    let mut next_param = |v: &str, values: &mut Vec<String>| -> String {
        values.push(v.to_string());
        if pg {
            let s = format!("${}", param_n);
            param_n += 1;
            s
        } else {
            "?".to_string()
        }
    };

    let where_clause = if filters.is_empty() {
        String::new()
    } else {
        let parts: Vec<String> = filters.iter().map(|f| {
            let p = f.op.has_value()
                .then(|| next_param(f.value.as_deref().unwrap_or(""), &mut values));
            render_filter(f, p, pg, col_types)
        }).collect();
        format!(" WHERE {}", parts.join(" AND "))
    };

    let order_clause = if sort.is_empty() {
        String::new()
    } else {
        let parts: Vec<String> = sort.iter().map(|s| {
            let dir = match s.direction { SortDir::Asc => "ASC", SortDir::Desc => "DESC" };
            format!("{} {}", quote_ident(&s.column, pg), dir)
        }).collect();
        format!(" ORDER BY {}", parts.join(", "))
    };

    // LIMIT/OFFSET are inlined rather than bound. They are already i64 here —
    // never user text — so there is nothing to inject, and PostgreSQL rejects
    // a TEXT-typed parameter outright ("argument of OFFSET must be type
    // bigint, not type text"), which broke paging for every table.
    let _ = &mut param_n;
    let sql = format!(
        "SELECT * FROM {}{}{} LIMIT {} OFFSET {}",
        quote_table(table, pg), where_clause, order_clause, limit.max(0), offset.max(0)
    );

    BrowseQuery { sql, values }
}

/// Build a parameterised top-N value-count query for the column-filter popover:
///   SELECT <col> AS value, COUNT(*) AS cnt FROM <table>
///   [WHERE <other filters>] GROUP BY <col> ORDER BY cnt DESC LIMIT n
/// Filters use the same clause builder as `build_select`, so the list is
/// faceted by every other active filter.
pub fn build_value_counts(
    table: &str,
    column: &str,
    filters: &[FilterClause],
    limit: i64,
    pg: bool,
    col_types: &ColTypes,
) -> BrowseQuery {
    let mut values: Vec<String> = Vec::new();
    let mut param_n = 1usize;

    let mut next_param = |v: &str, values: &mut Vec<String>| -> String {
        values.push(v.to_string());
        if pg {
            let s = format!("${}", param_n);
            param_n += 1;
            s
        } else {
            "?".to_string()
        }
    };

    let where_clause = if filters.is_empty() {
        String::new()
    } else {
        let parts: Vec<String> = filters.iter().map(|f| {
            let p = f.op.has_value()
                .then(|| next_param(f.value.as_deref().unwrap_or(""), &mut values));
            render_filter(f, p, pg, col_types)
        }).collect();
        format!(" WHERE {}", parts.join(" AND "))
    };

    // Inlined for the same reason as build_select: an i64, and PostgreSQL
    // refuses a TEXT-bound LIMIT.
    let _ = &mut param_n;
    let col = quote_ident(column, pg);
    let sql = format!(
        "SELECT {} AS value, COUNT(*) AS cnt FROM {}{} GROUP BY {} ORDER BY cnt DESC LIMIT {}",
        col, quote_table(table, pg), where_clause, col, limit.max(0)
    );

    BrowseQuery { sql, values }
}

fn quote_ident(name: &str, pg: bool) -> String {
    if pg { format!("\"{}\"", name.replace('"', "\"\"")) }
    else  { format!("`{}`",   name.replace('`', "``")) }
}

fn quote_table(table: &str, pg: bool) -> String {
    // "schema.table" → `schema`.`table`  or  "schema"."table"
    if let Some((ns, t)) = table.split_once('.') {
        format!("{}.{}", quote_ident(ns, pg), quote_ident(t, pg))
    } else {
        quote_ident(table, pg)
    }
}

// ── DML builder ───────────────────────────────────────────────────────────────

// Inline-DML builders (UPDATE/INSERT/DELETE) were removed with the read-only
// data browser — the grid has no write path. `quote_ident`/`quote_table`
// remain in use by the SELECT builder above.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::FilterOp;

    fn sort_pk_desc(col: &str) -> Vec<SortClause> {
        vec![SortClause { column: col.into(), direction: SortDir::Desc }]
    }

    fn no_types() -> ColTypes { ColTypes::new() }

    fn types(pairs: &[(&str, &str)]) -> ColTypes {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn mysql_pk_desc_default_browse() {
        // The double-click browse shape: latest rows first, strict LIMIT 100.
        let q = build_select("shop.orders", &[], &sort_pk_desc("id"), 100, 0, false, &no_types());
        assert_eq!(q.sql, "SELECT * FROM `shop`.`orders` ORDER BY `id` DESC LIMIT 100 OFFSET 0");
        assert!(q.values.is_empty());
    }

    #[test]
    fn pg_pk_desc_default_browse() {
        let q = build_select("public.orders", &[], &sort_pk_desc("id"), 100, 0, true, &no_types());
        assert_eq!(q.sql, "SELECT * FROM \"public\".\"orders\" ORDER BY \"id\" DESC LIMIT 100 OFFSET 0");
        assert!(q.values.is_empty());
    }

    #[test]
    fn no_sort_no_order_by() {
        let q = build_select("logs", &[], &[], 100, 0, false, &no_types());
        assert_eq!(q.sql, "SELECT * FROM `logs` LIMIT 100 OFFSET 0");
    }

    #[test]
    fn filter_params_precede_limit_params() {
        let filters = vec![
            FilterClause { column: "name".into(), op: FilterOp::Like, value: Some("%a%".into()) },
            FilterClause { column: "deleted".into(), op: FilterOp::IsNull, value: None },
        ];
        let q = build_select("t", &filters, &sort_pk_desc("id"), 500, 100, true, &no_types());
        assert_eq!(
            q.sql,
            "SELECT * FROM \"t\" WHERE \"name\" LIKE $1 AND \"deleted\" IS NULL ORDER BY \"id\" DESC LIMIT 500 OFFSET 100"
        );
        assert_eq!(q.values, vec!["%a%"]);
    }

    // ── Parameter typing (PostgreSQL) ────────────────────────────────────
    // Values arrive as strings and bind as TEXT. Without a cast PostgreSQL
    // rejects `bigint = text` outright, which broke every filter on a
    // non-text column.

    #[test]
    fn pg_casts_param_to_column_type() {
        let filters = vec![
            FilterClause { column: "id".into(), op: FilterOp::Eq, value: Some("5".into()) },
        ];
        let q = build_select("t", &filters, &[], 100, 0, true, &types(&[("id", "bigint")]));
        // Cast lands on the parameter, so "id" stays bare and indexable.
        assert_eq!(
            q.sql,
            "SELECT * FROM \"t\" WHERE \"id\" = $1::bigint LIMIT 100 OFFSET 0"
        );
        assert_eq!(q.values, vec!["5"]);
    }

    #[test]
    fn pg_leaves_text_columns_uncast() {
        let filters = vec![
            FilterClause { column: "name".into(), op: FilterOp::Eq, value: Some("bob".into()) },
        ];
        let q = build_select("t", &filters, &[], 10, 0, true, &types(&[("name", "text")]));
        assert_eq!(q.sql, "SELECT * FROM \"t\" WHERE \"name\" = $1 LIMIT 10 OFFSET 0");
    }

    #[test]
    fn pg_like_casts_the_column_not_the_param() {
        // LIKE needs text on the left, so a non-text column is cast instead.
        let filters = vec![
            FilterClause { column: "id".into(), op: FilterOp::Like, value: Some("%7%".into()) },
        ];
        let q = build_select("t", &filters, &[], 10, 0, true, &types(&[("id", "bigint")]));
        assert_eq!(q.sql, "SELECT * FROM \"t\" WHERE \"id\"::text LIKE $1 LIMIT 10 OFFSET 0");
    }

    #[test]
    fn pg_parameterised_types_survive_qualified_types() {
        // format_type() yields things like "numeric(14,2)" / "timestamp with
        // time zone" — both are valid cast targets verbatim.
        let filters = vec![
            FilterClause { column: "amount".into(), op: FilterOp::Gte, value: Some("10.5".into()) },
            FilterClause { column: "at".into(), op: FilterOp::Lt, value: Some("2026-01-01".into()) },
        ];
        let q = build_select("t", &filters, &[], 10, 0, true,
                             &types(&[("amount", "numeric(14,2)"), ("at", "timestamp with time zone")]));
        assert_eq!(
            q.sql,
            "SELECT * FROM \"t\" WHERE \"amount\" >= $1::numeric(14,2) \
             AND \"at\" < $2::timestamp with time zone LIMIT 10 OFFSET 0"
        );
    }

    #[test]
    fn pg_unknown_column_falls_back_to_uncast() {
        // An empty/failed catalog lookup must degrade to the old behaviour,
        // never to a malformed cast.
        let filters = vec![
            FilterClause { column: "mystery".into(), op: FilterOp::Eq, value: Some("x".into()) },
        ];
        let q = build_select("t", &filters, &[], 10, 0, true, &no_types());
        assert_eq!(q.sql, "SELECT * FROM \"t\" WHERE \"mystery\" = $1 LIMIT 10 OFFSET 0");
    }

    #[test]
    fn mysql_never_casts() {
        let filters = vec![
            FilterClause { column: "id".into(), op: FilterOp::Eq, value: Some("5".into()) },
        ];
        let q = build_select("t", &filters, &[], 10, 0, false, &types(&[("id", "bigint")]));
        assert_eq!(q.sql, "SELECT * FROM `t` WHERE `id` = ? LIMIT 10 OFFSET 0");
    }

    #[test]
    fn pg_value_counts_types_its_filters_too() {
        let filters = vec![
            FilterClause { column: "customer_id".into(), op: FilterOp::Eq, value: Some("42".into()) },
        ];
        let q = build_value_counts("s.orders", "status", &filters, 20, true,
                                   &types(&[("customer_id", "bigint")]));
        assert_eq!(
            q.sql,
            "SELECT \"status\" AS value, COUNT(*) AS cnt FROM \"s\".\"orders\" \
             WHERE \"customer_id\" = $1::bigint GROUP BY \"status\" ORDER BY cnt DESC LIMIT 20"
        );
    }

    #[test]
    fn pg_column_type_lookup_is_case_insensitive() {
        // pg_column_types lowercases its keys; a filter naming the column in
        // its original case must still find the type.
        let filters = vec![
            FilterClause { column: "UserId".into(), op: FilterOp::Eq, value: Some("1".into()) },
        ];
        let q = build_select("t", &filters, &[], 10, 0, true, &types(&[("userid", "integer")]));
        assert_eq!(q.sql, "SELECT * FROM \"t\" WHERE \"UserId\" = $1::integer LIMIT 10 OFFSET 0");
    }
}
