use std::collections::{BTreeMap, HashSet};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{AssertSqlSafe, Column, Connection, Row, SqlSafeStr, TypeInfo, ValueRef};
use tauri::ipc::Channel;
use uuid::Uuid;

use super::{RefreshMaskBatchInput, RefreshPreflightInput};
use crate::apperror::{AppError, ErrorCode};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ExecuteTable {
    source_schema: String,
    target_schema: String,
    table: String,
    action: String,
    root_sql: Option<String>,
    policy: String,
    hard_limit: Option<u64>,
    key_columns: Vec<String>,
    unique_keys: Vec<UniqueKey>,
    batch_rows: usize,
    columns: Vec<ExecuteColumn>,
    indexes: Vec<ExecuteIndex>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct UniqueKey {
    name: String,
    columns: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ExecuteColumn {
    name: String,
    data_type: String,
    column_type: String,
    nullable: bool,
    collation: Option<String>,
    charset: Option<String>,
    char_max_len: Option<u64>,
    generation_expression: Option<String>,
    extra: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ExecuteIndex {
    name: String,
    unique: bool,
    columns: Vec<ExecuteIndexColumn>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ExecuteIndexColumn {
    name: String,
    seq: u64,
    sub_part: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ExecuteForeignKey {
    key: String,
    name: String,
    schema: String,
    table: String,
    ref_schema: String,
    ref_table: String,
    parts: Vec<ExecuteForeignKeyPart>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ExecuteForeignKeyPart {
    ordinal: u64,
    column: String,
    ref_column: String,
    nullable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ExecuteInput {
    run_key: String,
    expected_catalog_sha256: String,
    expected_row_set_sha256: String,
    max_chunk_bytes: usize,
    planning_key_batch: usize,
    max_planning_keys: usize,
    preflight: RefreshPreflightInput,
    tables: Vec<ExecuteTable>,
    foreign_keys: Vec<ExecuteForeignKey>,
    mask: RefreshMaskBatchInput,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct RefreshKeyRange {
    start_sha256: String,
    end_sha256: String,
}

impl RefreshKeyRange {
    fn from_keys(keys: &[Vec<Value>]) -> Result<Option<Self>, AppError> {
        let Some(first) = keys.first() else {
            return Ok(None);
        };
        let last = keys.last().expect("nonempty key chunk");
        Ok(Some(Self {
            start_sha256: format!("{:x}", Sha256::digest(canonical_values(first)?.as_bytes())),
            end_sha256: format!("{:x}", Sha256::digest(canonical_values(last)?.as_bytes())),
        }))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RefreshRunCounts {
    status: String,
    key_rows_read: u64,
    source_rows_read: u64,
    requested_rows: Option<u64>,
    closure_rows: Option<u64>,
    planned_rows: Option<u64>,
    committed_rows: u64,
    rows_inserted: u64,
    in_flight_rows: u64,
    remaining_rows: Option<u64>,
    chunks_committed: u64,
    source_bytes_read: u64,
    target_bytes_written: u64,
    rows_per_second: Option<f64>,
    eta_seconds: Option<u64>,
    elapsed_ms: u64,
    source_backend_id: Option<u64>,
    target_backend_id: Option<u64>,
    current_key_range: Option<RefreshKeyRange>,
    execution_row_set_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RefreshExecutionEvent {
    Started {
        run_key: String,
        source_backend_id: u64,
        target_backend_id: u64,
    },
    Progress {
        run_key: String,
        phase: String,
        table: Option<String>,
        table_index: usize,
        table_count: usize,
        #[serde(flatten)]
        counts: RefreshRunCounts,
    },
    Chunk {
        run_key: String,
        table: Option<String>,
        table_index: usize,
        table_count: usize,
        chunk_index: u64,
        outcome: String,
        rows: u64,
        #[serde(flatten)]
        counts: RefreshRunCounts,
    },
    Done {
        run_key: String,
        table: Option<String>,
        table_index: usize,
        table_count: usize,
        error: Option<String>,
        #[serde(flatten)]
        counts: RefreshRunCounts,
    },
}

#[derive(Debug)]
struct RunState {
    run_key: String,
    started: Instant,
    audit_started_at: String,
    status: &'static str,
    table: Option<String>,
    table_index: usize,
    key_rows_read: u64,
    source_rows_read: u64,
    requested_rows: Option<u64>,
    closure_rows: Option<u64>,
    planned_rows: Option<u64>,
    committed_rows: u64,
    rows_inserted: u64,
    in_flight_rows: u64,
    chunks_committed: u64,
    source_bytes_read: u64,
    target_bytes_written: u64,
    source_backend_id: Option<u64>,
    target_backend_id: Option<u64>,
    current_key_range: Option<RefreshKeyRange>,
    execution_row_set_sha256: Option<String>,
    uncertain: bool,
}

impl RunState {
    fn new(run_key: String) -> Self {
        Self {
            run_key,
            started: Instant::now(),
            audit_started_at: crate::commands::audit::lifecycle_now(),
            status: "running",
            table: None,
            table_index: 0,
            key_rows_read: 0,
            source_rows_read: 0,
            requested_rows: None,
            closure_rows: None,
            planned_rows: None,
            committed_rows: 0,
            rows_inserted: 0,
            in_flight_rows: 0,
            chunks_committed: 0,
            source_bytes_read: 0,
            target_bytes_written: 0,
            source_backend_id: None,
            target_backend_id: None,
            current_key_range: None,
            execution_row_set_sha256: None,
            uncertain: false,
        }
    }

    fn counts(&self, _table_count: usize) -> RefreshRunCounts {
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        let remaining_rows = self
            .planned_rows
            .map(|rows| rows.saturating_sub(self.committed_rows));
        let rows_per_second = (self.committed_rows > 0)
            .then(|| self.committed_rows as f64 / (elapsed_ms.max(1) as f64 / 1000.0));
        let eta_seconds = if self.status == "running" {
            match remaining_rows {
                Some(0) => Some(0),
                Some(remaining) => {
                    rows_per_second.map(|rate| (remaining as f64 / rate).ceil() as u64)
                }
                None => None,
            }
        } else {
            None
        };
        RefreshRunCounts {
            status: self.status.into(),
            key_rows_read: self.key_rows_read,
            source_rows_read: self.source_rows_read,
            requested_rows: self.requested_rows,
            closure_rows: self.closure_rows,
            planned_rows: self.planned_rows,
            committed_rows: self.committed_rows,
            rows_inserted: self.rows_inserted,
            in_flight_rows: self.in_flight_rows,
            remaining_rows,
            chunks_committed: self.chunks_committed,
            source_bytes_read: self.source_bytes_read,
            target_bytes_written: self.target_bytes_written,
            rows_per_second,
            eta_seconds,
            elapsed_ms,
            source_backend_id: self.source_backend_id,
            target_backend_id: self.target_backend_id,
            current_key_range: self.current_key_range.clone(),
            execution_row_set_sha256: self.execution_row_set_sha256.clone(),
        }
    }

    fn progress(&self, on_event: &Channel<RefreshExecutionEvent>, phase: &str, table_count: usize) {
        let _ = on_event.send(RefreshExecutionEvent::Progress {
            run_key: self.run_key.clone(),
            phase: phase.into(),
            table: self.table.clone(),
            table_index: self.table_index,
            table_count,
            counts: self.counts(table_count),
        });
    }

    fn chunk(
        &self,
        on_event: &Channel<RefreshExecutionEvent>,
        table_count: usize,
        outcome: &str,
        rows: u64,
    ) {
        let _ = on_event.send(RefreshExecutionEvent::Chunk {
            run_key: self.run_key.clone(),
            table: self.table.clone(),
            table_index: self.table_index,
            table_count,
            chunk_index: self.chunks_committed + 1,
            outcome: outcome.into(),
            rows,
            counts: self.counts(table_count),
        });
    }
}

#[derive(Clone)]
struct SelectedRow {
    key: Vec<Value>,
    identities: BTreeMap<String, Vec<Value>>,
    references: BTreeMap<String, Vec<Value>>,
    requested: bool,
}

#[derive(Default)]
struct TableState {
    rows: BTreeMap<String, SelectedRow>,
    identities: BTreeMap<String, BTreeMap<String, String>>,
}

struct GridData {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    bytes: usize,
}

fn failed(message: impl Into<String>) -> AppError {
    AppError::local(message)
}

fn cancelled(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Cancelled, message)
}

fn quote(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn relation(schema: &str, table: &str) -> String {
    format!("{}.{}", quote(schema), quote(table))
}

fn source_key(table: &ExecuteTable) -> String {
    format!("{}.{}", table.source_schema, table.table)
}

fn fk_child_key(edge: &ExecuteForeignKey) -> String {
    format!("{}.{}", edge.schema, edge.table)
}

fn fk_parent_key(edge: &ExecuteForeignKey) -> String {
    format!("{}.{}", edge.ref_schema, edge.ref_table)
}

fn generated(column: &ExecuteColumn) -> bool {
    column.generation_expression.is_some()
        || column.extra.to_ascii_lowercase().contains("generated")
}

fn sql_value(value: &Value) -> Result<String, AppError> {
    match value {
        Value::Null => Ok("NULL".into()),
        Value::Bool(value) => Ok(if *value { "1" } else { "0" }.into()),
        Value::Number(value) => {
            let text = value.to_string();
            if text.contains(['e', 'E', '.'])
                || text.parse::<i128>().is_ok()
                || text.parse::<u128>().is_ok()
            {
                Ok(text)
            } else {
                Err(failed("Refresh encountered a non-exact numeric value; the current chunk was not committed"))
            }
        }
        Value::String(value) => Ok(format!("X'{}'", hex::encode(value.as_bytes()))),
        Value::Array(_) | Value::Object(_) => Ok(format!(
            "X'{}'",
            hex::encode(
                serde_json::to_string(value)
                    .map_err(|_| failed("Refresh JSON value could not be serialized"))?
                    .as_bytes()
            )
        )),
    }
}

fn sql_values(values: &[Value]) -> Result<String, AppError> {
    values
        .iter()
        .map(sql_value)
        .collect::<Result<Vec<_>, _>>()
        .map(|values| values.join(", "))
}

fn tuple_in(columns: &[String], keys: &[Vec<Value>]) -> Result<String, AppError> {
    if keys.is_empty() || keys.iter().any(|key| key.len() != columns.len()) {
        return Err(failed("Refresh key batch is empty or malformed"));
    }
    let tuples = keys
        .iter()
        .map(|key| Ok(format!("({})", sql_values(key)?)))
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(format!(
        "({}) IN ({})",
        columns
            .iter()
            .map(|column| quote(column))
            .collect::<Vec<_>>()
            .join(", "),
        tuples.join(", ")
    ))
}

fn canonical_values(values: &[Value]) -> Result<String, AppError> {
    let mut out = String::new();
    for value in values {
        match value {
            Value::Number(number) => {
                out.push_str(&format!("n{}:{}|", number.to_string().len(), number))
            }
            Value::String(text) if !text.contains('\0') => {
                out.push_str(&format!("s{}:{}|", text.len(), text))
            }
            _ => {
                return Err(failed(
                    "Refresh key/FK values must be exact strings or integers without NUL",
                ))
            }
        }
    }
    Ok(out)
}

struct RefreshCancel {
    receivers: Vec<tokio::sync::oneshot::Receiver<()>>,
}

impl RefreshCancel {
    #[cfg(test)]
    fn one(receiver: tokio::sync::oneshot::Receiver<()>) -> Self {
        Self {
            receivers: vec![receiver],
        }
    }

    fn pair(
        source: tokio::sync::oneshot::Receiver<()>,
        target: tokio::sync::oneshot::Receiver<()>,
    ) -> Self {
        Self {
            receivers: vec![source, target],
        }
    }

    fn check(&mut self) -> Result<(), AppError> {
        if self
            .receivers
            .iter_mut()
            .any(|receiver| receiver.try_recv().is_ok())
        {
            Err(cancelled(
                "Refresh cancelled; committed chunks remain and no new chunk was started",
            ))
        } else {
            Ok(())
        }
    }

    async fn wait(&mut self) {
        match self.receivers.as_mut_slice() {
            [receiver] => {
                let _ = receiver.await;
            }
            [source, target] => {
                tokio::select! {
                    _ = source => {},
                    _ = target => {},
                }
            }
            _ => std::future::pending::<()>().await,
        }
    }
}

fn check_cancel(cancel_rx: &mut RefreshCancel) -> Result<(), AppError> {
    cancel_rx.check()
}

async fn source_grid(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    row_cap: usize,
    cancel_rx: &mut RefreshCancel,
) -> Result<GridData, AppError> {
    let query = sqlx::query(AssertSqlSafe(sql.to_owned()).into_sql_str()).fetch_all(&mut *conn);
    let rows = tokio::select! {
        result = query => result.map_err(|_| failed("Refresh source read failed; database details are omitted to protect row values"))?,
        _ = cancel_rx.wait() => return Err(cancelled("Refresh cancelled during a source read; no target commit was attempted for this read")),
    };
    if rows.len() > row_cap {
        return Err(failed(format!(
            "Refresh source page exceeded its {row_cap}-row cap"
        )));
    }
    let columns = rows
        .first()
        .map(|row| {
            row.columns()
                .iter()
                .map(|column| column.name().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let types = rows
        .first()
        .map(|row| {
            row.columns()
                .iter()
                .map(|column| column.type_info().name().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut decoded = Vec::with_capacity(rows.len());
    let mut bytes = 0usize;
    for row in &rows {
        let values = (0..row.columns().len())
            .map(|index| crate::db::mysql::json_value_from_row_pub(row, index, &types[index]))
            .collect::<Vec<_>>();
        bytes = bytes.saturating_add(crate::db::types::row_bytes(&values));
        decoded.push(values);
    }
    Ok(GridData {
        columns,
        rows: decoded,
        bytes,
    })
}

fn value(grid: &GridData, row: &[Value], column: &str) -> Result<Value, AppError> {
    let index = grid
        .columns
        .iter()
        .position(|candidate| candidate.eq_ignore_ascii_case(column))
        .ok_or_else(|| {
            failed(format!(
                "Refresh source projection omitted required column {column}"
            ))
        })?;
    row.get(index)
        .cloned()
        .ok_or_else(|| failed("Refresh source row has an invalid projection"))
}

fn parse_record(
    grid: &GridData,
    row: &[Value],
    table: &ExecuteTable,
    foreign_keys: &[ExecuteForeignKey],
) -> Result<SelectedRow, AppError> {
    let key = table
        .key_columns
        .iter()
        .map(|column| value(grid, row, column))
        .collect::<Result<Vec<_>, _>>()?;
    canonical_values(&key)?;
    let mut identities = BTreeMap::new();
    for unique in &table.unique_keys {
        let values = unique
            .columns
            .iter()
            .map(|column| value(grid, row, column))
            .collect::<Result<Vec<_>, _>>()?;
        canonical_values(&values)?;
        identities.insert(unique.columns.join("\0"), values);
    }
    let mut references = BTreeMap::new();
    for edge in foreign_keys
        .iter()
        .filter(|edge| edge.schema == table.source_schema && edge.table == table.table)
    {
        let values = edge
            .parts
            .iter()
            .map(|part| value(grid, row, &part.column))
            .collect::<Result<Vec<_>, _>>()?;
        if values.iter().all(|value| !value.is_null()) {
            canonical_values(&values)?;
        }
        references.insert(edge.key.clone(), values);
    }
    Ok(SelectedRow {
        key,
        identities,
        references,
        requested: false,
    })
}

fn projection(table: &ExecuteTable, foreign_keys: &[ExecuteForeignKey]) -> Vec<String> {
    let mut columns = table
        .unique_keys
        .iter()
        .flat_map(|unique| unique.columns.clone())
        .collect::<Vec<_>>();
    columns.extend(
        foreign_keys
            .iter()
            .filter(|edge| edge.schema == table.source_schema && edge.table == table.table)
            .flat_map(|edge| {
                edge.parts
                    .iter()
                    .map(|part| part.column.clone())
                    .collect::<Vec<_>>()
            }),
    );
    columns.sort();
    columns.dedup();
    columns
}

fn insert_selected(
    state: &mut TableState,
    mut record: SelectedRow,
    requested: bool,
    identity_count: &mut usize,
    cap: usize,
) -> Result<bool, AppError> {
    let chosen = canonical_values(&record.key)?;
    if let Some(existing) = state.rows.get_mut(&chosen) {
        if requested && !existing.requested {
            existing.requested = true;
        }
        return Ok(false);
    }
    for (signature, values) in &record.identities {
        let canonical = canonical_values(values)?;
        if let Some(previous) = state
            .identities
            .get(signature)
            .and_then(|items| items.get(&canonical))
        {
            if previous != &chosen {
                return Err(failed(
                    "Refresh source returned contradictory unique-key identities",
                ));
            }
            if requested {
                if let Some(existing) = state.rows.get_mut(previous) {
                    existing.requested = true;
                }
            }
            return Ok(false);
        }
    }
    let additions = record.identities.len();
    if identity_count.saturating_add(additions) > cap {
        return Err(failed(format!("Refresh snapshot planning exceeds the {cap} retained-identity cap; no unbounded temporary key store was used")));
    }
    record.requested = requested;
    for (signature, values) in &record.identities {
        state
            .identities
            .entry(signature.clone())
            .or_default()
            .insert(canonical_values(values)?, chosen.clone());
    }
    state.rows.insert(chosen, record);
    *identity_count += additions;
    Ok(true)
}

fn validate_hash(hash: &str, label: &str) -> Result<(), AppError> {
    if hash.len() == 64 && hash.chars().all(|character| character.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "{label} must be 64 hexadecimal characters"
        )))
    }
}

fn validate_input(input: &ExecuteInput) -> Result<BTreeMap<String, usize>, AppError> {
    Uuid::parse_str(&input.run_key)
        .map_err(|_| AppError::bad_request("Refresh run key must be a UUID"))?;
    validate_hash(&input.expected_catalog_sha256, "Refresh catalog hash")?;
    validate_hash(
        &input.expected_row_set_sha256,
        "Refresh previous row-set hash",
    )?;
    if input.tables.is_empty()
        || input.tables.len() > 1000
        || input.max_chunk_bytes < 1024
        || input.planning_key_batch == 0
        || input.planning_key_batch > 100_000
        || input.max_planning_keys == 0
        || input.max_planning_keys > 10_000_000
    {
        return Err(AppError::bad_request(
            "Refresh execution bounds or table list are invalid",
        ));
    }
    let mut order = BTreeMap::new();
    for (index, table) in input.tables.iter().enumerate() {
        let key = source_key(table);
        if order.insert(key.clone(), index).is_some() {
            return Err(AppError::bad_request(
                "Refresh insertion order contains duplicate tables",
            ));
        }
        for identifier in [&table.source_schema, &table.target_schema, &table.table] {
            if identifier.is_empty() || identifier.len() > 64 || identifier.contains('\0') {
                return Err(AppError::bad_request(
                    "Refresh source/target identifiers are invalid",
                ));
            }
        }
        if table.key_columns.is_empty()
            || table.batch_rows == 0
            || table.batch_rows > input.planning_key_batch
            || table.unique_keys.is_empty()
            || table
                .unique_keys
                .iter()
                .any(|unique| unique.name.is_empty() || unique.columns.is_empty())
            || table.columns.is_empty()
            || table.columns.iter().any(|column| {
                matches!(
                    column.data_type.to_ascii_lowercase().as_str(),
                    "geometry"
                        | "point"
                        | "linestring"
                        | "polygon"
                        | "multipoint"
                        | "multilinestring"
                        | "multipolygon"
                        | "geometrycollection"
                )
            })
        {
            return Err(AppError::bad_request(format!(
                "{key} lacks a bounded unique-key/non-spatial execution contract"
            )));
        }
        if let Some(root) = &table.root_sql {
            if root.len() > 100_000
                || !root
                    .trim_start()
                    .to_ascii_lowercase()
                    .starts_with("select ")
                || crate::sqlguard::is_write_for(Some(crate::db::types::Engine::Mysql), root)
            {
                return Err(AppError::bad_request(format!(
                    "{key} root selection is not a bounded read-only SELECT"
                )));
            }
        } else if table.action != "dependency" {
            return Err(AppError::bad_request(format!(
                "{key} has no root selection"
            )));
        }
    }
    for edge in &input.foreign_keys {
        if edge.parts.is_empty()
            || edge
                .parts
                .iter()
                .enumerate()
                .any(|(index, part)| part.ordinal as usize != index + 1)
        {
            return Err(AppError::bad_request(format!(
                "{} has malformed composite FK ordinals",
                edge.name
            )));
        }
        let child = fk_child_key(edge);
        let parent = fk_parent_key(edge);
        let child_index = order.get(&child).ok_or_else(|| {
            AppError::bad_request(format!("{child} has an FK outside the execution order"))
        })?;
        let parent_index = order.get(&parent).ok_or_else(|| {
            AppError::bad_request(format!(
                "{child} requires parent {parent} outside the execution order"
            ))
        })?;
        if parent_index >= child_index {
            return Err(AppError::bad_request(format!("{child} has a self/cyclic or non-parent-first dependency on {parent}; execution is refused before writing")));
        }
    }
    Ok(order)
}

async fn execute_raw(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    target: bool,
) -> Result<u64, AppError> {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()).into_sql_str()).execute(conn).await
        .map(|result| result.rows_affected())
        .map_err(|error| failed(if target {
            "Refresh target statement failed; database details are omitted to protect row values".into()
        } else {
            format!("Refresh source session setup failed; no target write was attempted: {error}")
        }))
}

async fn backend_id(conn: &mut sqlx::MySqlConnection) -> Result<u64, AppError> {
    sqlx::query_scalar("SELECT CONNECTION_ID()")
        .fetch_one(conn)
        .await
        .map_err(|_| failed("Refresh could not identify its dedicated backend connection"))
}

fn metadata_u64(row: &sqlx::mysql::MySqlRow, index: usize) -> Result<Option<u64>, AppError> {
    let value =
        crate::db::mysql::json_value_from_row_pub(row, index, row.column(index).type_info().name());
    let decoded = match value {
        Value::Null => None,
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.parse::<u64>().ok(),
        _ => None,
    };
    if decoded.is_none()
        && !row
            .try_get_raw(index)
            .map_err(|_| failed("Refresh numeric metadata could not be inspected"))?
            .is_null()
    {
        return Err(failed(
            "Refresh numeric metadata is not an exact unsigned integer",
        ));
    }
    Ok(decoded)
}

async fn validate_columns(
    conn: &mut sqlx::MySqlConnection,
    table: &ExecuteTable,
    schema: &str,
    target: bool,
) -> Result<(), AppError> {
    let rows = sqlx::query(
        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME, CHARACTER_MAXIMUM_LENGTH, GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    ).bind(schema).bind(&table.table).fetch_all(conn).await
        .map_err(|_| failed("Refresh schema revalidation failed before target writes"))?;
    if rows.len() != table.columns.len() {
        return Err(failed(format!(
            "{}.{} column count changed; Refresh is refused",
            schema, table.table
        )));
    }
    for (row, expected) in rows.iter().zip(&table.columns) {
        let name: String = row
            .try_get(0)
            .map_err(|_| failed("Refresh column metadata could not be decoded"))?;
        let data_type: String = row
            .try_get(1)
            .map_err(|_| failed("Refresh column type could not be decoded"))?;
        let column_type: String = row
            .try_get(2)
            .map_err(|_| failed("Refresh declared column type could not be decoded"))?;
        let nullable: String = row
            .try_get(3)
            .map_err(|_| failed("Refresh nullability could not be decoded"))?;
        let extra: String = row
            .try_get(4)
            .map_err(|_| failed("Refresh column generation metadata could not be decoded"))?;
        let charset: Option<String> = row
            .try_get(5)
            .map_err(|_| failed("Refresh column charset could not be decoded"))?;
        let collation: Option<String> = row
            .try_get(6)
            .map_err(|_| failed("Refresh column collation could not be decoded"))?;
        let char_max_len = metadata_u64(row, 7)?;
        let generation: Option<String> = row
            .try_get(8)
            .map_err(|_| failed("Refresh generated expression could not be decoded"))?;
        let unchanged = name == expected.name
            && data_type.eq_ignore_ascii_case(&expected.data_type)
            && (nullable == "YES") == expected.nullable
            && charset == expected.charset
            && collation == expected.collation
            && char_max_len == expected.char_max_len
            && generation.as_deref().unwrap_or("")
                == expected.generation_expression.as_deref().unwrap_or("")
            && extra.eq_ignore_ascii_case(&expected.extra)
            && (!target
                || column_type == expected.column_type
                || expected.data_type.to_ascii_lowercase().contains("int"));
        if !unchanged {
            return Err(failed(format!(
                "{}.{}.{} changed since catalog analysis; Refresh is refused before writing (actual: {name}/{data_type}/{nullable}/{extra:?}/{charset:?}/{collation:?}/{char_max_len:?}/{generation:?}; expected: {}/{}/{}/{:?}/{:?}/{:?}/{:?}/{:?})",
                schema, table.table, expected.name, expected.name, expected.data_type, expected.nullable,
                expected.extra, expected.charset, expected.collation, expected.char_max_len, expected.generation_expression,
            )));
        }
    }
    Ok(())
}

async fn validate_indexes(
    conn: &mut sqlx::MySqlConnection,
    table: &ExecuteTable,
    schema: &str,
) -> Result<(), AppError> {
    let rows = sqlx::query(
        "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, SUB_PART FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
    ).bind(schema).bind(&table.table).fetch_all(conn).await
        .map_err(|_| failed("Refresh index revalidation failed before target writes"))?;
    let expected = table
        .indexes
        .iter()
        .flat_map(|index| {
            index.columns.iter().map(move |column| {
                (
                    index.name.clone(),
                    index.unique,
                    column.name.clone(),
                    column.seq,
                    column.sub_part,
                )
            })
        })
        .collect::<Vec<_>>();
    if rows.len() != expected.len() {
        return Err(failed(format!(
            "{}.{} index metadata changed; Refresh is refused",
            schema, table.table
        )));
    }
    let mut actual = Vec::with_capacity(rows.len());
    for row in rows {
        actual.push((
            row.try_get::<String, _>(0)
                .map_err(|_| failed("Refresh index name could not be decoded"))?,
            metadata_u64(&row, 1)? == Some(0),
            row.try_get::<String, _>(2)
                .map_err(|_| failed("Refresh index column could not be decoded"))?,
            metadata_u64(&row, 3)?.ok_or_else(|| failed("Refresh index ordinal is NULL"))?,
            metadata_u64(&row, 4)?,
        ));
    }
    actual.sort_by(|left, right| (&left.0, left.3).cmp(&(&right.0, right.3)));
    let mut expected = expected;
    expected.sort_by(|left, right| (&left.0, left.3).cmp(&(&right.0, right.3)));
    if actual != expected {
        return Err(failed(format!(
            "{}.{} unique/index definitions changed; Refresh is refused",
            schema, table.table
        )));
    }
    Ok(())
}

async fn validate_foreign_keys(
    conn: &mut sqlx::MySqlConnection,
    table: &ExecuteTable,
    edges: &[ExecuteForeignKey],
) -> Result<(), AppError> {
    let expected = edges
        .iter()
        .filter(|edge| edge.schema == table.source_schema && edge.table == table.table)
        .flat_map(|edge| {
            edge.parts.iter().map(move |part| {
                (
                    edge.name.clone(),
                    part.column.clone(),
                    edge.ref_schema.clone(),
                    edge.ref_table.clone(),
                    part.ref_column.clone(),
                    part.ordinal,
                    part.nullable,
                )
            })
        })
        .collect::<Vec<_>>();
    let rows = sqlx::query(
        "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, k.ORDINAL_POSITION \
         FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
    ).bind(&table.source_schema).bind(&table.table).fetch_all(conn).await
        .map_err(|_| failed("Refresh foreign-key revalidation failed before target writes"))?;
    if rows.len() != expected.len() {
        return Err(failed(format!(
            "{} foreign-key definitions changed; Refresh is refused",
            source_key(table)
        )));
    }
    for (row, wanted) in rows.iter().zip(expected) {
        let actual = (
            row.try_get::<String, _>(0)
                .map_err(|_| failed("Refresh FK name could not be decoded"))?,
            row.try_get::<String, _>(1)
                .map_err(|_| failed("Refresh FK column could not be decoded"))?,
            row.try_get::<String, _>(2)
                .map_err(|_| failed("Refresh FK schema could not be decoded"))?,
            row.try_get::<String, _>(3)
                .map_err(|_| failed("Refresh FK table could not be decoded"))?,
            row.try_get::<String, _>(4)
                .map_err(|_| failed("Refresh FK referenced column could not be decoded"))?,
            metadata_u64(row, 5)?.ok_or_else(|| failed("Refresh FK ordinal is NULL"))?,
        );
        if actual != (wanted.0, wanted.1, wanted.2, wanted.3, wanted.4, wanted.5) {
            return Err(failed(format!(
                "{} foreign-key mapping changed; Refresh is refused",
                source_key(table)
            )));
        }
    }
    Ok(())
}

async fn target_empty(
    conn: &mut sqlx::MySqlConnection,
    table: &ExecuteTable,
) -> Result<(), AppError> {
    let sql = format!(
        "SELECT 1 FROM {} LIMIT 1",
        relation(&table.target_schema, &table.table)
    );
    let nonempty = sqlx::query(AssertSqlSafe(sql).into_sql_str())
        .fetch_optional(conn)
        .await
        .map_err(|_| {
            failed("Refresh target emptiness could not be proven; no insert was attempted")
        })?;
    if nonempty.is_some() {
        return Err(AppError::guard(format!(
            "target table {}.{} is not empty at execution time",
            table.target_schema, table.table
        )));
    }
    Ok(())
}

async fn plan_snapshot(
    input: &ExecuteInput,
    source: &mut sqlx::MySqlConnection,
    states: &mut BTreeMap<String, TableState>,
    run: &mut RunState,
    on_event: &Channel<RefreshExecutionEvent>,
    cancel_rx: &mut RefreshCancel,
) -> Result<(), AppError> {
    let tables = &input.tables;
    let foreign_keys = &input.foreign_keys;
    let mut identity_count = 0usize;
    for (table_index, table) in tables.iter().enumerate() {
        check_cancel(cancel_rx)?;
        run.table = Some(source_key(table));
        run.table_index = table_index + 1;
        run.progress(on_event, "planning", tables.len());
        validate_columns(source, table, &table.source_schema, false).await?;
        validate_indexes(source, table, &table.source_schema).await?;
        validate_foreign_keys(source, table, foreign_keys).await?;
        let Some(root_sql) = &table.root_sql else {
            continue;
        };
        let projected = projection(table, foreign_keys);
        let selected_columns = projected
            .iter()
            .map(|column| quote(column))
            .collect::<Vec<_>>()
            .join(", ");
        let order = table
            .key_columns
            .iter()
            .map(|column| quote(column))
            .collect::<Vec<_>>()
            .join(", ");
        let mut after: Option<Vec<Value>> = None;
        let mut previous_first: Option<String> = None;
        loop {
            check_cancel(cancel_rx)?;
            let boundary = match &after {
                Some(values) => format!(" WHERE ({}) > ({})", order, sql_values(values)?),
                None => String::new(),
            };
            let sql = format!(
                "SELECT {selected_columns} FROM ({root_sql}) AS `__txui_refresh_selection`{boundary} ORDER BY {order} LIMIT {}",
                input.planning_key_batch,
            );
            let grid = source_grid(source, &sql, input.planning_key_batch, cancel_rx).await?;
            run.key_rows_read += grid.rows.len() as u64;
            run.source_bytes_read = run.source_bytes_read.saturating_add(grid.bytes as u64);
            let mut frontier = Vec::new();
            let mut previous_row: Option<String> = None;
            for row in &grid.rows {
                let record = parse_record(&grid, row, table, foreign_keys)?;
                let canonical = canonical_values(&record.key)?;
                if previous_first.as_deref() == Some(&canonical)
                    || previous_row.as_deref() == Some(&canonical)
                {
                    return Err(failed("Refresh source repeated a root keyset identity; refusing an unbounded loop"));
                }
                previous_row = Some(canonical);
                let state = states
                    .get_mut(&source_key(table))
                    .expect("state initialized");
                if insert_selected(
                    state,
                    record.clone(),
                    true,
                    &mut identity_count,
                    input.max_planning_keys,
                )? {
                    frontier.push((source_key(table), record));
                }
            }
            if let Some(first) = grid.rows.first() {
                let record = parse_record(&grid, first, table, foreign_keys)?;
                previous_first = Some(canonical_values(&record.key)?);
            }
            process_closure(
                input,
                source,
                states,
                &mut frontier,
                &mut identity_count,
                run,
                on_event,
                cancel_rx,
            )
            .await?;
            run.progress(on_event, "planning", tables.len());
            if grid.rows.len() < input.planning_key_batch {
                break;
            }
            after = frontier_key_after(&grid, table, foreign_keys)?;
        }
    }
    for table in tables {
        if let Some(limit) = table.hard_limit {
            let count = states
                .get(&source_key(table))
                .map(|state| state.rows.len() as u64)
                .unwrap_or(0);
            if count > limit {
                return Err(failed(format!("{} hard limit {limit} is exceeded by FK closure ({count} rows); no target writes were attempted", source_key(table))));
            }
        }
    }
    let requested = states
        .values()
        .map(|state| state.rows.values().filter(|row| row.requested).count() as u64)
        .sum::<u64>();
    let planned = states
        .values()
        .map(|state| state.rows.len() as u64)
        .sum::<u64>();
    let closure = planned - requested;
    let hash_input = serde_json::json!({
        "spec_sha256": input.preflight.spec_sha256,
        "catalog_sha256": input.expected_catalog_sha256,
        "requested": requested,
        "closure": closure,
        "final": planned,
        "tables": tables.iter().map(|table| {
            let state = states.get(&source_key(table)).expect("state initialized");
            serde_json::json!([source_key(table), state.rows.values().filter(|row| row.requested).count(), state.rows.values().filter(|row| !row.requested).count(), state.rows.len()])
        }).collect::<Vec<_>>(),
    });
    run.requested_rows = Some(requested);
    run.closure_rows = Some(closure);
    run.planned_rows = Some(planned);
    run.execution_row_set_sha256 = Some(format!(
        "{:x}",
        Sha256::digest(hash_input.to_string().as_bytes())
    ));
    Ok(())
}

fn frontier_key_after(
    grid: &GridData,
    table: &ExecuteTable,
    foreign_keys: &[ExecuteForeignKey],
) -> Result<Option<Vec<Value>>, AppError> {
    match grid.rows.last() {
        Some(row) => Ok(Some(parse_record(grid, row, table, foreign_keys)?.key)),
        None => Ok(None),
    }
}

async fn process_closure(
    input: &ExecuteInput,
    source: &mut sqlx::MySqlConnection,
    states: &mut BTreeMap<String, TableState>,
    frontier: &mut Vec<(String, SelectedRow)>,
    identity_count: &mut usize,
    run: &mut RunState,
    on_event: &Channel<RefreshExecutionEvent>,
    cancel_rx: &mut RefreshCancel,
) -> Result<(), AppError> {
    while !frontier.is_empty() {
        check_cancel(cancel_rx)?;
        if frontier.len() > input.planning_key_batch {
            return Err(failed(
                "Refresh closure frontier exceeded the planning batch cap",
            ));
        }
        let current = std::mem::take(frontier);
        let mut groups: BTreeMap<
            String,
            (
                String,
                String,
                ExecuteForeignKey,
                BTreeMap<String, Vec<Value>>,
            ),
        > = BTreeMap::new();
        for (child_key, record) in current {
            let child = input
                .tables
                .iter()
                .find(|table| source_key(table) == child_key)
                .expect("frontier table");
            for edge in input
                .foreign_keys
                .iter()
                .filter(|edge| fk_child_key(edge) == child_key)
            {
                let values = record
                    .references
                    .get(&edge.key)
                    .ok_or_else(|| failed("Refresh closure record omitted an FK projection"))?;
                if values.iter().any(|value| value.is_null()) {
                    continue;
                }
                let parent_key = fk_parent_key(edge);
                let parent_state = states
                    .get(&parent_key)
                    .ok_or_else(|| failed(format!("Refresh parent {parent_key} is not loaded")))?;
                let signature = edge
                    .parts
                    .iter()
                    .map(|part| part.ref_column.clone())
                    .collect::<Vec<_>>()
                    .join("\0");
                let canonical = canonical_values(values)?;
                if parent_state
                    .identities
                    .get(&signature)
                    .is_some_and(|identities| identities.contains_key(&canonical))
                {
                    continue;
                }
                let group = groups.entry(edge.key.clone()).or_insert_with(|| {
                    (
                        child_key.clone(),
                        parent_key.clone(),
                        edge.clone(),
                        BTreeMap::new(),
                    )
                });
                group.3.insert(canonical, values.clone());
                let _ = child;
            }
        }
        for (_, (child_key, parent_key, edge, requests)) in groups {
            let parent = input
                .tables
                .iter()
                .find(|table| source_key(table) == parent_key)
                .ok_or_else(|| {
                    failed(format!(
                        "Refresh parent {parent_key} is outside the execution plan"
                    ))
                })?;
            let projected = projection(parent, &input.foreign_keys);
            let selected_columns = projected
                .iter()
                .map(|column| quote(column))
                .collect::<Vec<_>>()
                .join(", ");
            let parent_columns = edge
                .parts
                .iter()
                .map(|part| part.ref_column.clone())
                .collect::<Vec<_>>();
            let requests = requests.into_values().collect::<Vec<_>>();
            for batch in requests.chunks(input.planning_key_batch) {
                check_cancel(cancel_rx)?;
                let predicate = tuple_in(&parent_columns, batch)?;
                let grid = source_grid(
                    source,
                    &format!(
                        "SELECT {selected_columns} FROM {} WHERE {predicate}",
                        relation(&parent.source_schema, &parent.table),
                    ),
                    input.planning_key_batch,
                    cancel_rx,
                )
                .await?;
                run.key_rows_read += grid.rows.len() as u64;
                run.source_bytes_read = run.source_bytes_read.saturating_add(grid.bytes as u64);
                let mut candidates = BTreeMap::new();
                for row in &grid.rows {
                    let record = parse_record(&grid, row, parent, &input.foreign_keys)?;
                    let values = edge
                        .parts
                        .iter()
                        .map(|part| value(&grid, row, &part.ref_column))
                        .collect::<Result<Vec<_>, _>>()?;
                    if candidates
                        .insert(canonical_values(&values)?, record)
                        .is_some()
                    {
                        return Err(failed(format!(
                            "Refresh parent {parent_key} returned duplicate identities"
                        )));
                    }
                }
                let mut membership = HashSet::new();
                if parent.policy == "full" {
                    for key in batch {
                        membership.insert(canonical_values(key)?);
                    }
                } else if let Some(root_sql) = &parent.root_sql {
                    let selected = parent_columns
                        .iter()
                        .map(|column| quote(column))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let sql = format!("SELECT {selected} FROM ({root_sql}) AS `__txui_refresh_membership` WHERE {predicate}");
                    let members =
                        source_grid(source, &sql, input.planning_key_batch, cancel_rx).await?;
                    run.key_rows_read += members.rows.len() as u64;
                    run.source_bytes_read =
                        run.source_bytes_read.saturating_add(members.bytes as u64);
                    for row in &members.rows {
                        let values = parent_columns
                            .iter()
                            .map(|column| value(&members, row, column))
                            .collect::<Result<Vec<_>, _>>()?;
                        membership.insert(canonical_values(&values)?);
                    }
                }
                for key in batch {
                    let canonical = canonical_values(key)?;
                    let record = candidates.get(&canonical).cloned().ok_or_else(|| {
                        failed(format!(
                            "{child_key}.{} requires a missing parent in {parent_key}",
                            edge.name
                        ))
                    })?;
                    let requested = membership.contains(&canonical);
                    let state = states
                        .get_mut(&parent_key)
                        .expect("parent state initialized");
                    if insert_selected(
                        state,
                        record.clone(),
                        requested,
                        identity_count,
                        input.max_planning_keys,
                    )? {
                        frontier.push((parent_key.clone(), record));
                    }
                }
                if frontier.len() > input.planning_key_batch {
                    return Err(failed(
                        "Refresh closure frontier exceeded the planning batch cap",
                    ));
                }
                run.progress(on_event, "planning", input.tables.len());
            }
        }
    }
    Ok(())
}

async fn copy_tables(
    input: &ExecuteInput,
    source: &mut sqlx::MySqlConnection,
    target: &mut sqlx::MySqlConnection,
    states: &BTreeMap<String, TableState>,
    run: &mut RunState,
    on_event: &Channel<RefreshExecutionEvent>,
    cancel_rx: &mut RefreshCancel,
    collision_keys: &mut HashSet<String>,
) -> Result<(), AppError> {
    for (table_index, table) in input.tables.iter().enumerate() {
        run.table = Some(source_key(table));
        run.table_index = table_index + 1;
        run.progress(on_event, "copying", input.tables.len());
        target_empty(target, table).await?;
        let state = states.get(&source_key(table)).expect("state initialized");
        let keys = state
            .rows
            .values()
            .map(|row| row.key.clone())
            .collect::<Vec<_>>();
        for key_chunk in keys.chunks(table.batch_rows) {
            check_cancel(cancel_rx)?;
            run.current_key_range = RefreshKeyRange::from_keys(key_chunk)?;
            run.chunk(
                on_event,
                input.tables.len(),
                "reading",
                key_chunk.len() as u64,
            );
            let predicate = tuple_in(&table.key_columns, key_chunk)?;
            let columns = table
                .columns
                .iter()
                .filter(|column| !generated(column))
                .collect::<Vec<_>>();
            let selected = columns
                .iter()
                .map(|column| quote(&column.name))
                .collect::<Vec<_>>()
                .join(", ");
            let order = table
                .key_columns
                .iter()
                .map(|column| quote(column))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT {selected} FROM {} WHERE {predicate} ORDER BY {order}",
                relation(&table.source_schema, &table.table)
            );
            let grid = match source_grid(source, &sql, key_chunk.len(), cancel_rx).await {
                Ok(grid) => grid,
                Err(error) => {
                    run.chunk(
                        on_event,
                        input.tables.len(),
                        if error.code == ErrorCode::Cancelled {
                            "cancelled"
                        } else {
                            "failed"
                        },
                        0,
                    );
                    return Err(error);
                }
            };
            if grid.rows.len() != key_chunk.len() {
                return Err(failed(format!("{} snapshot data page did not match its planned identities; no new chunk was committed", source_key(table))));
            }
            run.source_rows_read += grid.rows.len() as u64;
            run.source_bytes_read = run.source_bytes_read.saturating_add(grid.bytes as u64);
            let mut rows = Vec::with_capacity(grid.rows.len());
            for source_row in &grid.rows {
                let mut values = Map::new();
                for column in &columns {
                    values.insert(column.name.clone(), value(&grid, source_row, &column.name)?);
                }
                rows.push(super::RefreshMaskRowInput {
                    table: source_key(table),
                    values,
                });
            }
            let mut offset = 0usize;
            while offset < rows.len() {
                check_cancel(cancel_rx)?;
                let mut end = offset + 1;
                let mut estimated = 0usize;
                while end < rows.len() {
                    let next = serde_json::to_vec(&rows[end].values)
                        .map(|value| value.len())
                        .unwrap_or(input.max_chunk_bytes);
                    if end - offset >= table.batch_rows
                        || estimated.saturating_add(next) > input.max_chunk_bytes
                    {
                        break;
                    }
                    estimated += next;
                    end += 1;
                }
                if end == offset {
                    return Err(failed(
                        "Refresh encountered a row larger than the target chunk byte cap",
                    ));
                }
                let batch = &rows[offset..end];
                let mut mask_input = input.mask.clone();
                mask_input.rows = batch.to_vec();
                mask_input.committed_scope.committed_rows = run.committed_rows;
                mask_input.committed_scope.in_flight_rows = batch.len() as u64;
                let masked = super::refresh_mask_apply_tracked(mask_input, collision_keys).await?;
                if masked.rows.len() != batch.len() {
                    return Err(failed(
                        "Refresh mask output count changed; the chunk was not sent to the target",
                    ));
                }
                let column_names = table
                    .columns
                    .iter()
                    .filter(|column| !generated(column))
                    .map(|column| column.name.clone())
                    .collect::<Vec<_>>();
                let mut tuples = Vec::with_capacity(masked.rows.len());
                for row in &masked.rows {
                    let values = column_names
                        .iter()
                        .map(|name| sql_value(row.values.get(name).unwrap_or(&Value::Null)))
                        .collect::<Result<Vec<_>, _>>()?;
                    tuples.push(format!("({})", values.join(", ")));
                }
                let insert_sql = format!(
                    "INSERT INTO {} ({}) VALUES {}",
                    relation(&table.target_schema, &table.table),
                    column_names
                        .iter()
                        .map(|column| quote(column))
                        .collect::<Vec<_>>()
                        .join(", "),
                    tuples.join(", "),
                );
                if insert_sql.len()
                    > input
                        .max_chunk_bytes
                        .saturating_mul(2)
                        .saturating_add(16 * 1024)
                {
                    return Err(failed("Refresh outbound chunk exceeded its bounded SQL envelope; no insert was attempted"));
                }
                execute_raw(target, "START TRANSACTION", true).await?;
                run.in_flight_rows = batch.len() as u64;
                run.chunk(
                    on_event,
                    input.tables.len(),
                    "inserting",
                    batch.len() as u64,
                );
                let inserted = tokio::select! {
                    result = execute_raw(target, &insert_sql, true) => result,
                    _ = cancel_rx.wait() => {
                        run.uncertain = true;
                        run.chunk(on_event, input.tables.len(), "uncertain", batch.len() as u64);
                        return Err(cancelled("Refresh was cancelled during a target INSERT; that uncommitted chunk's outcome is uncertain and is not counted as committed"));
                    }
                };
                if let Err(error) = inserted {
                    if execute_raw(target, "ROLLBACK", true).await.is_err() {
                        run.uncertain = true;
                        run.chunk(
                            on_event,
                            input.tables.len(),
                            "uncertain",
                            batch.len() as u64,
                        );
                        return Err(failed("Refresh INSERT failed and rollback could not be confirmed; the in-flight chunk remains separately reported"));
                    }
                    run.in_flight_rows = 0;
                    run.chunk(
                        on_event,
                        input.tables.len(),
                        "rolled_back",
                        batch.len() as u64,
                    );
                    return Err(error);
                }
                run.rows_inserted += batch.len() as u64;
                run.chunk(
                    on_event,
                    input.tables.len(),
                    "inserted_uncommitted",
                    batch.len() as u64,
                );
                let committed = tokio::select! {
                    result = execute_raw(target, "COMMIT", true) => result,
                    _ = cancel_rx.wait() => {
                        run.uncertain = true;
                        run.chunk(on_event, input.tables.len(), "uncertain", batch.len() as u64);
                        return Err(cancelled("Refresh was cancelled during COMMIT; the chunk outcome is uncertain and is not counted as committed"));
                    }
                };
                if committed.is_err() {
                    run.uncertain = true;
                    run.chunk(
                        on_event,
                        input.tables.len(),
                        "uncertain",
                        batch.len() as u64,
                    );
                    return Err(failed("Refresh COMMIT outcome is uncertain; the in-flight chunk is not counted as committed or rolled back"));
                }
                run.committed_rows += batch.len() as u64;
                run.in_flight_rows = 0;
                run.chunks_committed += 1;
                run.target_bytes_written = run
                    .target_bytes_written
                    .saturating_add(insert_sql.len() as u64);
                run.chunk(
                    on_event,
                    input.tables.len(),
                    "committed",
                    batch.len() as u64,
                );
                offset = end;
            }
        }
    }
    Ok(())
}

async fn execute_inner(
    input: ExecuteInput,
    state: &crate::state::AppState,
    on_event: Channel<RefreshExecutionEvent>,
    run: &mut RunState,
    cancel_rx: &mut RefreshCancel,
) -> Result<RefreshRunCounts, AppError> {
    let order = validate_input(&input)?;
    if order.len() != input.tables.len() || !input.mask.rows.is_empty() {
        return Err(AppError::bad_request(
            "Refresh execution input has inconsistent tables or seeded rows",
        ));
    }
    run.progress(&on_event, "starting", input.tables.len());
    let preflight = super::preflight_inner(input.preflight.clone(), state).await?;
    if !preflight.ok || preflight.tables.iter().any(|table| !table.empty) {
        return Err(AppError::guard(
            "Refresh execution preflight did not prove every selected target table empty",
        ));
    }
    check_cancel(cancel_rx)?;
    let source_session =
        crate::db::connection::get_session_pub(input.preflight.source_session_id, &state.sessions)
            .await?;
    let target_session =
        crate::db::connection::get_session_pub(input.preflight.target_session_id, &state.sessions)
            .await?;
    let source_pool = match source_session.as_ref() {
        crate::db::types::LiveSession::Mysql(pool) => pool.clone(),
        _ => return Err(AppError::bad_request("Refresh source is not MySQL/MariaDB")),
    };
    let target_pool = match target_session.as_ref() {
        crate::db::types::LiveSession::Mysql(pool) => pool.clone(),
        _ => return Err(AppError::bad_request("Refresh target is not MySQL/MariaDB")),
    };
    let mut source = source_pool
        .acquire()
        .await
        .map_err(|_| failed("Refresh could not acquire its source connection"))?
        .detach();
    let mut target = target_pool
        .acquire()
        .await
        .map_err(|_| failed("Refresh could not acquire its target connection"))?
        .detach();
    let result = async {
        let source_backend_id = backend_id(&mut source).await?;
        let target_backend_id = backend_id(&mut target).await?;
        let autocommit: i64 = sqlx::query_scalar("SELECT @@autocommit")
            .fetch_one(&mut target)
            .await
            .map_err(|_| failed("Refresh could not verify target autocommit"))?;
        if autocommit != 1 {
            return Err(AppError::guard(
                "Refresh target connection is not in autocommit mode",
            ));
        }
        run.source_backend_id = Some(source_backend_id);
        run.target_backend_id = Some(target_backend_id);
        let _ = on_event.send(RefreshExecutionEvent::Started {
            run_key: input.run_key.clone(),
            source_backend_id,
            target_backend_id,
        });
        execute_raw(
            &mut source,
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
            false,
        )
        .await?;
        execute_raw(
            &mut source,
            "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
            false,
        )
        .await?;
        let mut states = input
            .tables
            .iter()
            .map(|table| (source_key(table), TableState::default()))
            .collect::<BTreeMap<_, _>>();
        plan_snapshot(&input, &mut source, &mut states, run, &on_event, cancel_rx).await?;
        run.progress(&on_event, "copying", input.tables.len());
        for table in &input.tables {
            validate_columns(&mut target, table, &table.target_schema, true).await?;
            validate_indexes(&mut target, table, &table.target_schema).await?;
            target_empty(&mut target, table).await?;
        }
        let mut collision_keys = HashSet::new();
        copy_tables(
            &input,
            &mut source,
            &mut target,
            &states,
            run,
            &on_event,
            cancel_rx,
            &mut collision_keys,
        )
        .await?;
        run.status = "completed";
        run.in_flight_rows = 0;
        Ok(run.counts(input.tables.len()))
    }
    .await;
    let _ = execute_raw(&mut source, "ROLLBACK", false).await;
    if !run.uncertain {
        let _ = execute_raw(&mut target, "ROLLBACK", true).await;
    }
    let _ = source.close().await;
    let _ = target.close().await;
    result
}

async fn audit_refresh_run(
    state: &crate::state::AppState,
    target_session_id: Uuid,
    database: String,
    run: &RunState,
    counts: &RefreshRunCounts,
    error: Option<&str>,
    error_code: &str,
) {
    let start = state
        .session_starts
        .read()
        .await
        .get(&target_session_id)
        .cloned();
    let entry = crate::commands::audit::AuditInsert {
        run_id: format!("refresh:{}", run.run_key), stmt_index: Some(1), stmt_total: Some(1),
        session_id: target_session_id.to_string(), tab_title: "Safe Environment Refresh".into(),
        database, source: "refresh".into(), started_at: run.audit_started_at.clone(),
        ended_at: crate::commands::audit::lifecycle_now(), duration_ms: counts.elapsed_ms as i64,
        connection_name: start.as_ref().map(|value| value.connection_name.clone()).unwrap_or_default(),
        db_user: start.as_ref().map(|value| value.db_user.clone()).unwrap_or_default(),
        engine: "mysql".into(), ok: counts.status == "completed", rows_out: 0,
        rows_affected: Some(counts.committed_rows as i64), error: error.map(Into::into),
        error_code: error_code.into(), db_code: String::new(), sqlstate: String::new(),
        sql: format!(
            "-- consistent-snapshot refresh: status={} planned={} committed={} in_flight={} remaining={} chunks={}; no row values",
            counts.status,
            counts.planned_rows.map(|value| value.to_string()).unwrap_or_else(|| "unknown".into()),
            counts.committed_rows, counts.in_flight_rows,
            counts.remaining_rows.map(|value| value.to_string()).unwrap_or_else(|| "unknown".into()),
            counts.chunks_committed,
        ),
    };
    if let Err(error) = crate::commands::audit::insert(&state.history, &entry).await {
        eprintln!("[audit] environment refresh terminal insert failed: {error:#}");
    }
}

struct RefreshJobs {
    keys: [String; 2],
    cancel: RefreshCancel,
}

async fn register_refresh_jobs(
    state: &crate::state::AppState,
    source_session_id: Uuid,
    target_session_id: Uuid,
    run_key: &str,
) -> Result<RefreshJobs, AppError> {
    let source_key = crate::state::ext_job_key(source_session_id, run_key);
    let target_key = crate::state::ext_job_key(target_session_id, run_key);
    let (source_tx, source_rx) = tokio::sync::oneshot::channel();
    let (target_tx, target_rx) = tokio::sync::oneshot::channel();
    {
        let mut jobs = state.ext_jobs.write().await;
        if jobs.contains_key(&source_key) || jobs.contains_key(&target_key) {
            return Err(AppError::bad_request("This Refresh run is already active"));
        }
        jobs.insert(source_key.clone(), source_tx);
        jobs.insert(target_key.clone(), target_tx);
    }
    Ok(RefreshJobs {
        keys: [source_key, target_key],
        cancel: RefreshCancel::pair(source_rx, target_rx),
    })
}

async fn unregister_refresh_jobs(state: &crate::state::AppState, keys: &[String; 2]) {
    let mut jobs = state.ext_jobs.write().await;
    for key in keys {
        jobs.remove(key);
    }
}

async fn cancel_registered_refresh(state: &crate::state::AppState, run_key: &str) {
    for _ in 0..2 {
        if let Some(tx) = crate::state::take_ext_job(&state.ext_jobs, run_key).await {
            let _ = tx.send(());
        }
    }
}

#[tauri::command]
pub async fn refresh_execute(
    input: ExecuteInput,
    on_event: Channel<RefreshExecutionEvent>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<RefreshRunCounts, AppError> {
    let run_key = input.run_key.clone();
    let source_session_id = input.preflight.source_session_id;
    let target_session_id = input.preflight.target_session_id;
    let database = input
        .tables
        .iter()
        .map(|table| table.target_schema.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
        .join(",");
    let table_count = input.tables.len();
    Uuid::parse_str(&run_key)
        .map_err(|_| AppError::bad_request("Refresh run key must be a UUID"))?;
    let jobs =
        register_refresh_jobs(&state, source_session_id, target_session_id, &run_key).await?;
    let RefreshJobs {
        keys: job_keys,
        cancel: mut cancel_rx,
    } = jobs;
    let mut run = RunState::new(run_key.clone());
    let result = execute_inner(input, &state, on_event.clone(), &mut run, &mut cancel_rx).await;
    unregister_refresh_jobs(&state, &job_keys).await;
    match result {
        Ok(counts) => {
            audit_refresh_run(&state, target_session_id, database, &run, &counts, None, "").await;
            let _ = on_event.send(RefreshExecutionEvent::Done {
                run_key,
                table: run.table.clone(),
                table_index: run.table_index,
                table_count,
                error: None,
                counts,
            });
            Ok(run.counts(table_count))
        }
        Err(error) => {
            run.status = if run.uncertain {
                "uncertain"
            } else if error.code == ErrorCode::Cancelled {
                "cancelled"
            } else {
                "failed"
            };
            let counts = run.counts(table_count);
            let message = format!(
                "{}; committed_rows={} in_flight_rows={} remaining_rows={} outcome={}",
                error.message,
                counts.committed_rows,
                counts.in_flight_rows,
                counts
                    .remaining_rows
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".into()),
                counts.status,
            );
            audit_refresh_run(
                &state,
                target_session_id,
                database,
                &run,
                &counts,
                Some(&message),
                error.code.as_str(),
            )
            .await;
            let _ = on_event.send(RefreshExecutionEvent::Done {
                run_key,
                table: run.table.clone(),
                table_index: run.table_index,
                table_count,
                error: Some(message.clone()),
                counts,
            });
            Err(AppError::new(error.code, message))
        }
    }
}

#[tauri::command]
pub async fn refresh_cancel(
    run_key: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), AppError> {
    cancel_registered_refresh(&state, &run_key).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_literals_do_not_interpolate_text_or_claim_non_finite_numbers() {
        assert_eq!(
            sql_value(&Value::String("private ' \\ value".into())).unwrap(),
            "X'707269766174652027205c2076616c7565'"
        );
        assert_eq!(
            sql_value(&serde_json::json!({"private": [1, 2]})).unwrap(),
            "X'7b2270726976617465223a5b312c325d7d'"
        );
    }

    #[test]
    fn honest_counts_keep_uncertain_rows_out_of_committed_totals() {
        let mut run = RunState::new(Uuid::new_v4().to_string());
        run.planned_rows = Some(100);
        run.committed_rows = 40;
        run.in_flight_rows = 10;
        run.uncertain = true;
        run.status = "uncertain";
        let counts = run.counts(2);
        assert_eq!(counts.committed_rows, 40);
        assert_eq!(counts.in_flight_rows, 10);
        assert_eq!(counts.remaining_rows, Some(60));
        assert_eq!(counts.status, "uncertain");
    }

    #[test]
    fn progress_metrics_are_denominated_and_key_ranges_are_hash_only() {
        let mut run = RunState::new(Uuid::new_v4().to_string());
        run.planned_rows = Some(100);
        run.committed_rows = 40;
        run.rows_inserted = 50;
        run.in_flight_rows = 10;
        run.source_backend_id = Some(41);
        run.target_backend_id = Some(42);
        run.current_key_range = RefreshKeyRange::from_keys(&[
            vec![Value::String("private-start".into())],
            vec![Value::String("private-end".into())],
        ])
        .unwrap();
        let counts = run.counts(2);
        assert_eq!(counts.rows_inserted, 50);
        assert!(counts.rows_per_second.is_some_and(|rate| rate > 0.0));
        assert!(counts.eta_seconds.is_some());
        assert_eq!(counts.source_backend_id, Some(41));
        assert_eq!(counts.target_backend_id, Some(42));
        let range = counts.current_key_range.as_ref().unwrap();
        assert_eq!(range.start_sha256.len(), 64);
        assert_eq!(range.end_sha256.len(), 64);
        assert_ne!(range.start_sha256, range.end_sha256);
        let serialized = serde_json::to_string(&counts).unwrap();
        assert!(!serialized.contains("private-start"));
        assert!(!serialized.contains("private-end"));
        run.status = "uncertain";
        assert_eq!(run.counts(2).eta_seconds, None);
    }

    #[tokio::test]
    async fn paired_cancel_and_either_session_disconnect_are_cleaned_up() {
        let history = crate::history::open_in_memory().await.unwrap();
        let state = crate::state::AppState::new(
            history,
            std::env::temp_dir(),
            std::collections::HashMap::new(),
        );
        let source = Uuid::new_v4();
        let target = Uuid::new_v4();
        let run_key = Uuid::new_v4().to_string();
        let jobs = register_refresh_jobs(&state, source, target, &run_key)
            .await
            .unwrap();
        assert_eq!(state.ext_jobs.read().await.len(), 2);
        cancel_registered_refresh(&state, &run_key).await;
        let mut cancel = jobs.cancel;
        assert_eq!(cancel.check().unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(cancel.check().unwrap_err().code, ErrorCode::Cancelled);
        assert!(state.ext_jobs.read().await.is_empty());
        unregister_refresh_jobs(&state, &jobs.keys).await;

        for disconnected in [source, target] {
            let run_key = Uuid::new_v4().to_string();
            let mut jobs = register_refresh_jobs(&state, source, target, &run_key)
                .await
                .unwrap();
            state.cancel_session_work(disconnected).await;
            assert_eq!(jobs.cancel.check().unwrap_err().code, ErrorCode::Cancelled);
            unregister_refresh_jobs(&state, &jobs.keys).await;
            assert!(state.ext_jobs.read().await.is_empty());
        }
    }

    fn recorder() -> (
        Channel<RefreshExecutionEvent>,
        std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    ) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    sink.lock().unwrap().push(value);
                }
            }
            Ok(())
        });
        (channel, seen)
    }

    fn cancellation_recorder() -> (
        Channel<RefreshExecutionEvent>,
        std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
        RefreshCancel,
    ) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let cancel = std::sync::Arc::new(std::sync::Mutex::new(Some(cancel_tx)));
        let trigger = cancel.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    if value["committed_rows"]
                        .as_u64()
                        .is_some_and(|rows| rows >= 5)
                        && value["in_flight_rows"].as_u64() == Some(0)
                    {
                        if let Some(tx) = trigger.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                    }
                    sink.lock().unwrap().push(value);
                }
            }
            Ok(())
        });
        (channel, seen, RefreshCancel::one(cancel_rx))
    }

    fn insert_cancellation_recorder() -> (
        Channel<RefreshExecutionEvent>,
        std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
        RefreshCancel,
    ) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let cancel = std::sync::Arc::new(std::sync::Mutex::new(Some(cancel_tx)));
        let trigger = cancel.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    if value["outcome"].as_str() == Some("inserting") {
                        if let Some(tx) = trigger.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                    }
                    sink.lock().unwrap().push(value);
                }
            }
            Ok(())
        });
        (channel, seen, RefreshCancel::one(cancel_rx))
    }

    fn read_cancellation_recorder() -> (
        Channel<RefreshExecutionEvent>,
        std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
        RefreshCancel,
    ) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let cancel = std::sync::Arc::new(std::sync::Mutex::new(Some(cancel_tx)));
        let trigger = cancel.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    if value["outcome"].as_str() == Some("reading") {
                        if let Some(tx) = trigger.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                    }
                    sink.lock().unwrap().push(value);
                }
            }
            Ok(())
        });
        (channel, seen, RefreshCancel::one(cancel_rx))
    }

    async fn refresh_execute_node(
        args: &[String],
        input: Option<serde_json::Value>,
    ) -> serde_json::Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut command = tokio::process::Command::new("node");
        command
            .arg(root.join("dev/refresh_execute_live.mjs"))
            .args(args)
            .current_dir(root)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if input.is_some() {
            command.stdin(std::process::Stdio::piped());
        }
        let mut child = command.spawn().unwrap();
        if let Some(input) = input {
            tokio::io::AsyncWriteExt::write_all(
                child.stdin.as_mut().unwrap(),
                input.to_string().as_bytes(),
            )
            .await
            .unwrap();
            drop(child.stdin.take());
        }
        let output = child.wait_with_output().await.unwrap();
        assert!(
            output.status.success(),
            "refresh execute live proof failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    async fn live_input(
        pool: &sqlx::MySqlPool,
        source: &str,
        target: &str,
        rows: usize,
    ) -> (ExecuteInput, u64) {
        let request = refresh_execute_node(
            &[
                "--queries".into(),
                source.into(),
                target.into(),
                rows.to_string(),
            ],
            None,
        )
        .await;
        let mut grids = Vec::new();
        for query in request["queries"].as_array().unwrap() {
            let sql = query["sql"].as_str().unwrap();
            let result = crate::db::mysql::execute(pool, sql).await.unwrap();
            assert!(!result.truncated);
            grids.push(serde_json::json!({
                "sessionId": query["sessionId"], "sql": sql,
                "grid": {
                    "columns": result.columns.iter().map(|column| &column.name).collect::<Vec<_>>(),
                    "rows": result.rows, "truncated": result.truncated,
                },
            }));
        }
        let evidence = refresh_execute_node(
            &[],
            Some(serde_json::json!({
                "spec": request["spec"], "grids": grids, "rows": rows,
            })),
        )
        .await;
        let input = serde_json::from_value(evidence["input"].clone()).unwrap();
        (input, evidence["expectedRows"].as_u64().unwrap())
    }

    async fn live_state(pool: &sqlx::MySqlPool) -> (crate::state::AppState, Uuid, Uuid) {
        let history = crate::history::open_in_memory().await.unwrap();
        let state = crate::state::AppState::new(
            history,
            std::env::temp_dir(),
            std::collections::HashMap::new(),
        );
        let source = Uuid::new_v4();
        let target = Uuid::new_v4();
        let source_connection = Uuid::new_v4();
        let target_connection = Uuid::new_v4();
        let mut source_config =
            crate::db::types::ConnectionConfig::new(crate::db::types::Engine::Mysql, "source");
        source_config.id = source_connection;
        source_config.read_only = true;
        let mut target_config =
            crate::db::types::ConnectionConfig::new(crate::db::types::Engine::Mysql, "target");
        target_config.id = target_connection;
        state.sessions.write().await.insert(
            source,
            std::sync::Arc::new(crate::db::types::LiveSession::Mysql(pool.clone())),
        );
        state.sessions.write().await.insert(
            target,
            std::sync::Arc::new(crate::db::types::LiveSession::Mysql(pool.clone())),
        );
        state.session_meta.write().await.insert(
            source,
            crate::state::SessionGuard::from_config(&source_config),
        );
        state.session_meta.write().await.insert(
            target,
            crate::state::SessionGuard::from_config(&target_config),
        );
        state.session_starts.write().await.insert(
            source,
            crate::commands::audit::session_start(&source_config),
        );
        state.session_starts.write().await.insert(
            target,
            crate::commands::audit::session_start(&target_config),
        );
        (state, source, target)
    }

    async fn bind_live_input(
        input: &mut ExecuteInput,
        state: &crate::state::AppState,
        source: Uuid,
        target: Uuid,
    ) {
        input.preflight.source_session_id = source;
        input.preflight.target_session_id = target;
        let starts = state.session_starts.read().await;
        input.preflight.source_connection_id = starts.get(&source).unwrap().connection_id;
        input.preflight.target_connection_id = starts.get(&target).unwrap().connection_id;
    }

    async fn create_live_schemas(
        pool: &sqlx::MySqlPool,
        suffix: &str,
        rows: usize,
    ) -> (String, String) {
        let source = format!("txui_refresh_exec_source_{suffix}");
        let target = format!("txui_refresh_exec_target_{suffix}");
        for schema in [&source, &target] {
            crate::db::mysql::execute(pool, &format!("CREATE DATABASE `{schema}`"))
                .await
                .unwrap();
            crate::db::mysql::execute(pool, &format!(
                "CREATE TABLE `{schema}`.`parents` (id INT PRIMARY KEY, email VARCHAR(64) NOT NULL UNIQUE, computed VARCHAR(65) GENERATED ALWAYS AS (CONCAT(email,'!')) STORED) ENGINE=InnoDB",
            )).await.unwrap();
            crate::db::mysql::execute(pool, &format!(
                "CREATE TABLE `{schema}`.`children` (id INT PRIMARY KEY, parent_id INT NOT NULL, note VARCHAR(80) NOT NULL, CONSTRAINT fk_parent FOREIGN KEY(parent_id) REFERENCES parents(id)) ENGINE=InnoDB",
            )).await.unwrap();
        }
        crate::db::mysql::execute(pool, &format!(
            "INSERT INTO `{source}`.`parents` (id,email) VALUES (1,'one@example.test'),(2,'two@example.test'),(3,'three@example.test')",
        )).await.unwrap();
        for id in 1..=rows {
            crate::db::mysql::execute(pool, &format!(
                "INSERT INTO `{source}`.`children` (id,parent_id,note) VALUES ({id},{},'private-note-{id}')", (id - 1) % 3 + 1,
            )).await.unwrap();
        }
        (source, target)
    }

    async fn drop_live_schemas(pool: &sqlx::MySqlPool, source: &str, target: &str) {
        for schema in [source, target] {
            crate::db::mysql::execute(pool, &format!("DROP DATABASE `{schema}`"))
                .await
                .unwrap();
        }
    }

    async fn wait_for_event(
        events: &std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
        predicate: impl Fn(&Value) -> bool,
    ) {
        for _ in 0..300 {
            if events.lock().unwrap().iter().any(|event| predicate(event)) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!(
            "timed out waiting for Refresh event: {}",
            serde_json::to_string(&*events.lock().unwrap()).unwrap()
        );
    }

    #[derive(Clone, Copy)]
    enum GraphShape {
        Deep(usize),
        SelfReference,
        TwoCycle,
    }

    fn graph_names(shape: GraphShape) -> Vec<String> {
        let count = match shape {
            GraphShape::Deep(count) => count,
            GraphShape::SelfReference => 1,
            GraphShape::TwoCycle => 2,
        };
        (0..count)
            .map(|index| format!("chain_{index:03}"))
            .collect()
    }

    fn graph_parent(shape: GraphShape, index: usize) -> Option<usize> {
        match shape {
            GraphShape::Deep(_) if index > 0 => Some(index - 1),
            GraphShape::SelfReference => Some(0),
            GraphShape::TwoCycle => Some((index + 1) % 2),
            _ => None,
        }
    }

    fn graph_input(source: &str, target: &str, shape: GraphShape) -> ExecuteInput {
        let names = graph_names(shape);
        let last = names.len() - 1;
        let tables = names.iter().enumerate().map(|(index, name)| {
            let parent = graph_parent(shape, index);
            let mut columns = vec![serde_json::json!({
                "name": "id", "data_type": "int", "column_type": "int", "nullable": false,
                "collation": null, "charset": null, "char_max_len": null,
                "generation_expression": null, "extra": "",
            })];
            if parent.is_some() {
                columns.push(serde_json::json!({
                    "name": "parent_id", "data_type": "int", "column_type": "int", "nullable": true,
                    "collation": null, "charset": null, "char_max_len": null,
                    "generation_expression": null, "extra": "",
                }));
            }
            let mut indexes = vec![serde_json::json!({
                "name": "PRIMARY", "unique": true,
                "columns": [{"name": "id", "seq": 1, "sub_part": null}],
            })];
            if parent.is_some() {
                indexes.push(serde_json::json!({
                    "name": format!("fk_{name}"), "unique": false,
                    "columns": [{"name": "parent_id", "seq": 1, "sub_part": null}],
                }));
            }
            serde_json::json!({
                "source_schema": source, "target_schema": target, "table": name,
                "action": if index == last { "full" } else { "dependency" },
                "root_sql": (index == last).then(|| format!("SELECT `id`, `parent_id` FROM {}", relation(source, name))),
                "policy": if index == last { "full" } else { "dependency" },
                "hard_limit": null, "key_columns": ["id"],
                "unique_keys": [{"name": "PRIMARY", "columns": ["id"]}],
                "batch_rows": 2, "columns": columns, "indexes": indexes,
            })
        }).collect::<Vec<_>>();
        let foreign_keys = names.iter().enumerate().filter_map(|(index, name)| {
            let parent = graph_parent(shape, index)?;
            Some(serde_json::json!({
                "key": format!("{source}.{name}.fk_{name}"), "name": format!("fk_{name}"),
                "schema": source, "table": name, "ref_schema": source, "ref_table": names[parent],
                "parts": [{"ordinal": 1, "column": "parent_id", "ref_column": "id", "nullable": true}],
            }))
        }).collect::<Vec<_>>();
        let mask_tables = tables
            .iter()
            .map(|table| {
                let columns = table["columns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|column| {
                        serde_json::json!({
                            "name": column["name"], "data_type": "int", "collation": null,
                            "char_max_len": null, "generation_expression": null, "extra": "",
                        })
                    })
                    .collect::<Vec<_>>();
                serde_json::json!({
                    "name": format!("{source}.{}", table["table"].as_str().unwrap()),
                    "columns": columns,
                    "indexes": [{"name": "PRIMARY", "unique": true, "columns": ["id"]}],
                })
            })
            .collect::<Vec<_>>();
        serde_json::from_value(serde_json::json!({
            "run_key": Uuid::new_v4(), "expected_catalog_sha256": "a".repeat(64),
            "expected_row_set_sha256": "b".repeat(64), "max_chunk_bytes": 65536,
            "planning_key_batch": 2, "max_planning_keys": 10000,
            "preflight": {
                "source_session_id": Uuid::nil(), "target_session_id": Uuid::nil(),
                "source_connection_id": Uuid::nil(), "target_connection_id": Uuid::nil(),
                "spec_sha256": "c".repeat(64), "production_confirmation": null,
                "tables": [{"source_schema": source, "target_schema": target, "table": names[last]}],
            },
            "tables": tables, "foreign_keys": foreign_keys,
            "mask": {
                "seed": "graph-test", "rules": [], "tables": mask_tables, "relations": [], "rows": [],
                "allow_fk_breaking": false, "acknowledge_unmasked_sensitive": true,
                "committed_scope": {"committed_rows": 0, "in_flight_rows": 0},
                "max_unique_keys": 10000,
            },
        })).unwrap()
    }

    async fn create_graph_schemas(
        pool: &sqlx::MySqlPool,
        suffix: &str,
        shape: GraphShape,
    ) -> (String, String) {
        let names = graph_names(shape);
        let source = format!("txui_refresh_graph_source_{suffix}");
        let target = format!("txui_refresh_graph_target_{suffix}");
        for schema in [&source, &target] {
            crate::db::mysql::execute(pool, &format!("CREATE DATABASE `{schema}`"))
                .await
                .unwrap();
            for (index, name) in names.iter().enumerate() {
                let parent_column = if graph_parent(shape, index).is_some() {
                    ", parent_id INT NULL"
                } else {
                    ""
                };
                crate::db::mysql::execute(pool, &format!(
                    "CREATE TABLE `{schema}`.`{name}` (id INT PRIMARY KEY{parent_column}) ENGINE=InnoDB",
                )).await.unwrap();
            }
            for (index, name) in names.iter().enumerate() {
                if let Some(parent) = graph_parent(shape, index) {
                    crate::db::mysql::execute(pool, &format!(
                        "ALTER TABLE `{schema}`.`{name}` ADD CONSTRAINT `fk_{name}` FOREIGN KEY(parent_id) REFERENCES `{schema}`.`{}`(id)",
                        names[parent],
                    )).await.unwrap();
                }
            }
        }
        for (index, name) in names.iter().enumerate() {
            let values = if graph_parent(shape, index).is_some() {
                "1,NULL"
            } else {
                "1"
            };
            crate::db::mysql::execute(
                pool,
                &format!(
                    "INSERT INTO `{source}`.`{name}` (id{}) VALUES ({values})",
                    if graph_parent(shape, index).is_some() {
                        ",parent_id"
                    } else {
                        ""
                    },
                ),
            )
            .await
            .unwrap();
        }
        for (index, name) in names.iter().enumerate() {
            if graph_parent(shape, index).is_some() {
                crate::db::mysql::execute(
                    pool,
                    &format!("UPDATE `{source}`.`{name}` SET parent_id=1"),
                )
                .await
                .unwrap();
            }
        }
        (source, target)
    }

    async fn graph_target_rows(pool: &sqlx::MySqlPool, target: &str, shape: GraphShape) -> i64 {
        let mut total = 0;
        for name in graph_names(shape) {
            total += sqlx::query_scalar::<_, i64>(
                AssertSqlSafe(format!("SELECT COUNT(*) FROM `{target}`.`{name}`")).into_sql_str(),
            )
            .fetch_one(pool)
            .await
            .unwrap();
        }
        total
    }

    #[test]
    fn self_and_two_table_cycles_are_refused_before_session_or_target_access() {
        for shape in [GraphShape::SelfReference, GraphShape::TwoCycle] {
            let input = graph_input("source", "target", shape);
            let error = validate_input(&input).unwrap_err();
            assert!(error.message.contains("self/cyclic"), "{error}");
            assert!(error.message.contains("before writing"), "{error}");
        }
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
    async fn dbctl_deep_chain_copies_without_orphans_and_cycles_write_nothing() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(12)
            .connect(&url)
            .await
            .unwrap();
        let suffix = &Uuid::new_v4().simple().to_string()[..8];
        let shape = GraphShape::Deep(64);
        let (source, target) = create_graph_schemas(&pool, suffix, shape).await;
        let mut input = graph_input(&source, &target, shape);
        let (state, source_session, target_session) = live_state(&pool).await;
        bind_live_input(&mut input, &state, source_session, target_session).await;
        let (channel, events) = recorder();
        let (_cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let mut run = RunState::new(input.run_key.clone());
        let counts = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            execute_inner(
                input,
                &state,
                channel,
                &mut run,
                &mut RefreshCancel::one(cancel_rx),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(counts.status, "completed");
        assert_eq!(counts.requested_rows, Some(1));
        assert_eq!(counts.closure_rows, Some(63));
        assert_eq!(counts.planned_rows, Some(64));
        assert_eq!(counts.committed_rows, 64);
        assert_eq!(counts.remaining_rows, Some(0));
        assert_eq!(counts.in_flight_rows, 0);
        assert_eq!(counts.chunks_committed, 64);
        assert_eq!(graph_target_rows(&pool, &target, shape).await, 64);
        for index in 1..64 {
            let name = format!("chain_{index:03}");
            let parent = format!("chain_{:03}", index - 1);
            let orphans: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT COUNT(*) FROM `{target}`.`{name}` child LEFT JOIN `{target}`.`{parent}` parent ON child.parent_id=parent.id WHERE child.parent_id IS NOT NULL AND parent.id IS NULL",
            )).into_sql_str()).fetch_one(&pool).await.unwrap();
            assert_eq!(orphans, 0, "orphans in {name}");
        }
        assert!(!serde_json::to_string(&*events.lock().unwrap())
            .unwrap()
            .contains("FOREIGN_KEY_CHECKS"));
        drop_live_schemas(&pool, &source, &target).await;

        for shape in [GraphShape::SelfReference, GraphShape::TwoCycle] {
            let (source, target) = create_graph_schemas(&pool, suffix, shape).await;
            let mut input = graph_input(&source, &target, shape);
            let (state, source_session, target_session) = live_state(&pool).await;
            bind_live_input(&mut input, &state, source_session, target_session).await;
            let (channel, _events) = recorder();
            let (_cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
            let mut run = RunState::new(input.run_key.clone());
            let error = execute_inner(
                input,
                &state,
                channel,
                &mut run,
                &mut RefreshCancel::one(cancel_rx),
            )
            .await
            .unwrap_err();
            assert!(error.message.contains("self/cyclic"), "{error}");
            assert_eq!(run.committed_rows, 0);
            assert_eq!(graph_target_rows(&pool, &target, shape).await, 0);
            drop_live_schemas(&pool, &source, &target).await;
        }
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8 and node"]
    async fn dbctl_snapshot_copy_concurrent_mutation_cancel_and_refusal() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(12)
            .connect(&url)
            .await
            .unwrap();
        let suffix = &Uuid::new_v4().simple().to_string()[..8];
        let (source, target) = create_live_schemas(&pool, suffix, 8).await;
        let (mut input, expected) = live_input(&pool, &source, &target, 8).await;
        input.run_key = Uuid::new_v4().to_string();
        let (state, source_session, target_session) = live_state(&pool).await;
        bind_live_input(&mut input, &state, source_session, target_session).await;
        let (channel, events) = recorder();
        let (_cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let mut task = tokio::spawn(async move {
            let mut run = RunState::new(input.run_key.clone());
            let result = execute_inner(input, &state, channel, &mut run, &mut {
                RefreshCancel::one(cancel_rx)
            })
            .await;
            (result, run)
        });
        let waiting = wait_for_event(&events, |event| {
            event["key_rows_read"]
                .as_u64()
                .is_some_and(|rows| rows >= 2)
        });
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => {},
            output = &mut task => panic!("Refresh ended before snapshot planning: {output:?}"),
        }
        crate::db::mysql::execute(
            &pool,
            &format!("UPDATE `{source}`.`children` SET note='post-snapshot-secret' WHERE id=1",),
        )
        .await
        .unwrap();
        crate::db::mysql::execute(&pool, &format!(
            "INSERT INTO `{source}`.`children` (id,parent_id,note) VALUES (99,1,'post-snapshot-insert')",
        )).await.unwrap();
        let (result, run) = tokio::time::timeout(std::time::Duration::from_secs(30), task)
            .await
            .unwrap()
            .unwrap();
        let counts = result.unwrap();
        assert_eq!(counts.status, "completed");
        assert_eq!(counts.planned_rows, Some(expected));
        assert_eq!(counts.committed_rows, expected);
        assert_eq!(counts.remaining_rows, Some(0));
        assert_eq!(counts.in_flight_rows, 0);
        assert!(counts.chunks_committed >= 6);
        assert_eq!(run.committed_rows, expected);
        let target_children: i64 = sqlx::query_scalar(
            AssertSqlSafe(format!("SELECT COUNT(*) FROM `{target}`.`children`")).into_sql_str(),
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let target_parents: i64 = sqlx::query_scalar(
            AssertSqlSafe(format!("SELECT COUNT(*) FROM `{target}`.`parents`")).into_sql_str(),
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(target_children + target_parents, expected as i64);
        let original_note: String = sqlx::query_scalar(
            AssertSqlSafe(format!("SELECT note FROM `{target}`.`children` WHERE id=1"))
                .into_sql_str(),
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(original_note, "private-note-1");
        let inserted_after_snapshot: i64 = sqlx::query_scalar(
            AssertSqlSafe(format!(
                "SELECT COUNT(*) FROM `{target}`.`children` WHERE id=99"
            ))
            .into_sql_str(),
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(inserted_after_snapshot, 0);
        let unmasked: i64 = sqlx::query_scalar(AssertSqlSafe(format!("SELECT COUNT(*) FROM `{target}`.`parents` WHERE email LIKE '%example.test' OR LENGTH(email) <> 64 OR computed <> CONCAT(email,'!')")).into_sql_str()).fetch_one(&pool).await.unwrap();
        assert_eq!(unmasked, 0);
        let recorded = events.lock().unwrap().clone();
        assert!(recorded
            .iter()
            .any(|event| event["outcome"].as_str() == Some("committed")));
        assert!(recorded
            .iter()
            .any(|event| event["current_key_range"]["start_sha256"]
                .as_str()
                .is_some_and(|hash| hash.len() == 64)));
        assert!(recorded
            .iter()
            .any(|event| event["target_backend_id"].as_u64().is_some_and(|id| id > 0)));
        assert!(recorded.iter().any(|event| event["rows_per_second"]
            .as_f64()
            .is_some_and(|rate| rate > 0.0)));
        let event_text = serde_json::to_string(&recorded).unwrap();
        assert!(!event_text.contains("private-note"));
        assert!(!event_text.contains("example.test"));
        assert!(!event_text.contains("post-snapshot"));
        drop_live_schemas(&pool, &source, &target).await;

        let (source, target) = create_live_schemas(&pool, suffix, 80).await;
        let (mut input, expected) = live_input(&pool, &source, &target, 80).await;
        input.run_key = Uuid::new_v4().to_string();
        let (state, source_session, target_session) = live_state(&pool).await;
        bind_live_input(&mut input, &state, source_session, target_session).await;
        let (channel, _events, mut cancel_rx) = cancellation_recorder();
        let task = tokio::spawn(async move {
            let mut run = RunState::new(input.run_key.clone());
            let result = execute_inner(input, &state, channel, &mut run, &mut cancel_rx).await;
            (result, run)
        });
        let (result, mut run) = tokio::time::timeout(std::time::Duration::from_secs(30), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        run.status = if run.uncertain {
            "uncertain"
        } else {
            "cancelled"
        };
        let counts = run.counts(2);
        assert!(
            counts.committed_rows >= 5 && counts.committed_rows < expected,
            "{counts:?}"
        );
        assert_eq!(counts.planned_rows, Some(expected));
        assert_eq!(
            counts.remaining_rows,
            Some(expected - counts.committed_rows)
        );
        let actual: i64 = sqlx::query_scalar(AssertSqlSafe(format!("SELECT (SELECT COUNT(*) FROM `{target}`.`parents`) + (SELECT COUNT(*) FROM `{target}`.`children`)")).into_sql_str()).fetch_one(&pool).await.unwrap();
        if counts.in_flight_rows == 0 {
            assert!(!run.uncertain);
            assert_eq!(actual, counts.committed_rows as i64);
        } else {
            assert!(run.uncertain);
            assert!(
                actual >= counts.committed_rows as i64
                    && actual <= (counts.committed_rows + counts.in_flight_rows) as i64
            );
        }
        drop_live_schemas(&pool, &source, &target).await;

        let (source, target) = create_live_schemas(&pool, suffix, 2).await;
        let (mut input, expected) = live_input(&pool, &source, &target, 2).await;
        input.run_key = Uuid::new_v4().to_string();
        let (state, source_session, target_session) = live_state(&pool).await;
        bind_live_input(&mut input, &state, source_session, target_session).await;
        let (channel, events, mut cancel_rx) = read_cancellation_recorder();
        let task = tokio::spawn(async move {
            let mut run = RunState::new(input.run_key.clone());
            let result = execute_inner(input, &state, channel, &mut run, &mut cancel_rx).await;
            (result, run)
        });
        let (result, run) = tokio::time::timeout(std::time::Duration::from_secs(30), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        let counts = run.counts(2);
        assert!(!run.uncertain);
        assert_eq!(counts.committed_rows, 0);
        assert_eq!(counts.in_flight_rows, 0);
        assert_eq!(counts.planned_rows, Some(expected));
        assert_eq!(counts.remaining_rows, Some(expected));
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["outcome"].as_str() == Some("cancelled")));
        let actual: i64 = sqlx::query_scalar(AssertSqlSafe(format!("SELECT (SELECT COUNT(*) FROM `{target}`.`parents`) + (SELECT COUNT(*) FROM `{target}`.`children`)")).into_sql_str()).fetch_one(&pool).await.unwrap();
        assert_eq!(actual, 0);
        drop_live_schemas(&pool, &source, &target).await;

        let (source, target) = create_live_schemas(&pool, suffix, 2).await;
        let (mut input, expected) = live_input(&pool, &source, &target, 2).await;
        input.run_key = Uuid::new_v4().to_string();
        let (state, source_session, target_session) = live_state(&pool).await;
        bind_live_input(&mut input, &state, source_session, target_session).await;
        let (channel, events, mut cancel_rx) = insert_cancellation_recorder();
        let task = tokio::spawn(async move {
            let mut run = RunState::new(input.run_key.clone());
            let result = execute_inner(input, &state, channel, &mut run, &mut cancel_rx).await;
            (result, run)
        });
        let (result, mut run) = tokio::time::timeout(std::time::Duration::from_secs(30), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert!(run.uncertain);
        run.status = "uncertain";
        let counts = run.counts(2);
        assert!(counts.in_flight_rows > 0);
        assert_eq!(counts.committed_rows, 0);
        assert_eq!(counts.planned_rows, Some(expected));
        assert_eq!(counts.remaining_rows, Some(expected));
        let actual: i64 = sqlx::query_scalar(AssertSqlSafe(format!("SELECT (SELECT COUNT(*) FROM `{target}`.`parents`) + (SELECT COUNT(*) FROM `{target}`.`children`)")).into_sql_str()).fetch_one(&pool).await.unwrap();
        assert!(actual >= 0 && actual <= counts.in_flight_rows as i64);
        let recorded = events.lock().unwrap().clone();
        assert!(recorded
            .iter()
            .any(|event| event["outcome"].as_str() == Some("uncertain")));
        assert!(recorded
            .iter()
            .any(|event| event["target_backend_id"].as_u64().is_some_and(|id| id > 0)));
        assert!(recorded
            .iter()
            .any(|event| event["current_key_range"]["start_sha256"]
                .as_str()
                .is_some_and(|hash| hash.len() == 64)));
        assert!(!serde_json::to_string(&recorded)
            .unwrap()
            .contains("private-note"));
        drop_live_schemas(&pool, &source, &target).await;

        let (source, target) = create_live_schemas(&pool, suffix, 1).await;
        let (mut input, _) = live_input(&pool, &source, &target, 1).await;
        input.run_key = Uuid::new_v4().to_string();
        let (state, source_session, target_session) = live_state(&pool).await;
        bind_live_input(&mut input, &state, source_session, target_session).await;
        crate::db::mysql::execute(
            &pool,
            &format!("ALTER TABLE `{target}`.`children` ADD COLUMN drifted INT NULL"),
        )
        .await
        .unwrap();
        let (channel, _events) = recorder();
        let (_cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let mut run = RunState::new(input.run_key.clone());
        let error = execute_inner(
            input,
            &state,
            channel,
            &mut run,
            &mut RefreshCancel::one(cancel_rx),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("column count changed"), "{error}");
        let actual: i64 = sqlx::query_scalar(AssertSqlSafe(format!("SELECT (SELECT COUNT(*) FROM `{target}`.`parents`) + (SELECT COUNT(*) FROM `{target}`.`children`)")).into_sql_str()).fetch_one(&pool).await.unwrap();
        assert_eq!(actual, 0);
        drop_live_schemas(&pool, &source, &target).await;
        pool.close().await;
    }
}
