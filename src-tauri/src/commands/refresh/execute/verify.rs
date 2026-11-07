use std::collections::BTreeMap;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{AssertSqlSafe, SqlSafeStr};

use super::super::RefreshMaskRowInput;
use super::{
    failed, fk_child_key, fk_parent_key, generated, quote, relation, source_key, target_grid,
    tuple_in, value, ExecuteColumn, ExecuteInput, ExecuteTable, RunState, TableState,
    REFRESH_BINARY_KEY,
};

const CHUNK_HASH_REPORT_CAP: usize = 64;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RefreshVerificationOptions {
    pub exact_counts: bool,
    pub foreign_key_orphans: bool,
    pub content_sha256: bool,
}

impl Default for RefreshVerificationOptions {
    fn default() -> Self {
        Self {
            exact_counts: true,
            foreign_key_orphans: true,
            content_sha256: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RefreshUnverifiedColumn {
    pub(super) table: String,
    pub(super) column: String,
    pub(super) data_type: String,
    pub(super) reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RefreshChunkVerification {
    pub(super) chunk_index: u64,
    pub(super) rows: u64,
    pub(super) outbound_sha256: String,
    pub(super) target_sha256: String,
    pub(super) matched: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RefreshTableVerification {
    pub(super) table: String,
    pub(super) target: String,
    pub(super) selected_rows: u64,
    pub(super) committed_rows: u64,
    pub(super) target_rows: Option<u64>,
    pub(super) count_status: String,
    pub(super) content_status: String,
    pub(super) content_sha256: Option<String>,
    pub(super) chunks_checked: u64,
    pub(super) chunk_hashes: Vec<RefreshChunkVerification>,
    pub(super) chunk_hashes_omitted: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RefreshForeignKeyVerification {
    pub(super) name: String,
    pub(super) child: String,
    pub(super) parent: String,
    pub(super) status: String,
    pub(super) orphan_rows: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RefreshVerificationReport {
    pub(super) status: String,
    pub(super) tables: Vec<RefreshTableVerification>,
    pub(super) foreign_keys: Vec<RefreshForeignKeyVerification>,
    pub(super) unverified_columns: Vec<RefreshUnverifiedColumn>,
    pub(super) comparable_content_sha256: Option<String>,
}

impl Default for RefreshVerificationReport {
    fn default() -> Self {
        Self {
            status: "pending".into(),
            tables: Vec::new(),
            foreign_keys: Vec::new(),
            unverified_columns: Vec::new(),
            comparable_content_sha256: None,
        }
    }
}

#[derive(Debug)]
pub struct TableContentState {
    chunks: u64,
    final_hash: Sha256,
}

impl TableContentState {
    pub fn new(table: &ExecuteTable) -> Self {
        let mut final_hash = Sha256::new();
        update_bytes(&mut final_hash, b"TxUI refresh table content v1");
        update_bytes(&mut final_hash, source_key(table).as_bytes());
        Self {
            chunks: 0,
            final_hash,
        }
    }

    fn add_chunk(&mut self, rows: usize, digest: [u8; 32]) {
        self.chunks += 1;
        self.final_hash.update(self.chunks.to_be_bytes());
        self.final_hash.update((rows as u64).to_be_bytes());
        self.final_hash.update(digest);
    }

    fn finish(self) -> String {
        format!("{:x}", self.final_hash.finalize())
    }
}

fn update_bytes(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}

fn integer(data_type: &str) -> bool {
    matches!(
        data_type,
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "year" | "bit"
    )
}

fn decimal(data_type: &str) -> bool {
    matches!(data_type, "decimal" | "numeric" | "dec" | "fixed")
}

fn binary(data_type: &str) -> bool {
    matches!(
        data_type,
        "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob"
    )
}

fn textual(data_type: &str) -> bool {
    matches!(
        data_type,
        "char" | "varchar" | "text" | "tinytext" | "mediumtext" | "longtext" | "enum" | "set"
    )
}

fn temporal(data_type: &str) -> bool {
    matches!(data_type, "date" | "datetime" | "timestamp" | "time")
}

fn unsupported_reason(column: &ExecuteColumn) -> Option<String> {
    let data_type = column.data_type.to_ascii_lowercase();
    if generated(column) {
        Some("target-generated value omitted from outbound content; matching schema expression is not a row-content check".into())
    } else if matches!(data_type.as_str(), "float" | "double" | "real") {
        Some(
            "floating-point rendering is not byte-stable; no lossy f64 comparison is attempted"
                .into(),
        )
    } else if integer(&data_type)
        || decimal(&data_type)
        || binary(&data_type)
        || textual(&data_type)
        || temporal(&data_type)
        || matches!(data_type.as_str(), "json" | "bool" | "boolean")
    {
        None
    } else {
        Some("no exact canonical Refresh decoder exists for this type".into())
    }
}

fn scalar_text(value: &Value) -> Result<String, String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        Value::Bool(value) => Ok(if *value { "1" } else { "0" }.into()),
        _ => Err("value does not match its declared scalar type".into()),
    }
}

fn binary_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let object = value.as_object().ok_or_else(|| {
        String::from(
            "binary value has no raw-byte envelope; verification refuses a text/hex ambiguity",
        )
    })?;
    if object.len() != 1 {
        return Err(String::from(
            "binary value has an invalid raw-byte envelope",
        ));
    }
    let encoded = object
        .get(REFRESH_BINARY_KEY)
        .and_then(Value::as_str)
        .ok_or_else(|| String::from("binary value has an invalid raw-byte envelope"))?;
    hex::decode(encoded)
        .map_err(|_| String::from("binary raw-byte envelope is not valid hexadecimal"))
}

fn canonical_json(value: &Value, output: &mut Vec<u8>) -> Result<(), String> {
    match value {
        Value::Null => output.push(b'z'),
        Value::Bool(value) => {
            output.push(b'b');
            output.push(u8::from(*value));
        }
        Value::Number(number) => {
            let exact = number
                .as_i64()
                .map(|value| value.to_string())
                .or_else(|| number.as_u64().map(|value| value.to_string()))
                .ok_or_else(|| {
                    String::from(
                        "JSON number is not an exact i64/u64; refusing lossy f64 verification",
                    )
                })?;
            output.push(b'n');
            output.extend_from_slice(&(exact.len() as u64).to_be_bytes());
            output.extend_from_slice(exact.as_bytes());
        }
        Value::String(text) => {
            output.push(b's');
            output.extend_from_slice(&(text.len() as u64).to_be_bytes());
            output.extend_from_slice(text.as_bytes());
        }
        Value::Array(values) => {
            output.push(b'a');
            output.extend_from_slice(&(values.len() as u64).to_be_bytes());
            for value in values {
                let mut encoded = Vec::new();
                canonical_json(value, &mut encoded)?;
                output.extend_from_slice(&(encoded.len() as u64).to_be_bytes());
                output.extend_from_slice(&encoded);
            }
        }
        Value::Object(values) => {
            output.push(b'o');
            output.extend_from_slice(&(values.len() as u64).to_be_bytes());
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            for (key, value) in entries {
                output.extend_from_slice(&(key.len() as u64).to_be_bytes());
                output.extend_from_slice(key.as_bytes());
                let mut encoded = Vec::new();
                canonical_json(value, &mut encoded)?;
                output.extend_from_slice(&(encoded.len() as u64).to_be_bytes());
                output.extend_from_slice(&encoded);
            }
        }
    }
    Ok(())
}

fn canonical_cell(column: &ExecuteColumn, value: &Value) -> Result<Option<Vec<u8>>, String> {
    if unsupported_reason(column).is_some() {
        return Ok(None);
    }
    let data_type = column.data_type.to_ascii_lowercase();
    let (tag, payload) = if value.is_null() {
        (b'z', Vec::new())
    } else if integer(&data_type) || matches!(data_type.as_str(), "bool" | "boolean") {
        let text = scalar_text(value)?;
        let signed = text
            .parse::<i128>()
            .map_err(|_| "integer value is not exact".to_string())?;
        let ordered = (signed as u128) ^ (1_u128 << 127);
        (b'i', ordered.to_be_bytes().to_vec())
    } else if decimal(&data_type) {
        let text = scalar_text(value)?;
        rust_decimal::Decimal::from_str(&text)
            .map_err(|_| "decimal value is not exact".to_string())?;
        (b'd', text.into_bytes())
    } else if binary(&data_type) {
        (b'b', binary_bytes(value)?)
    } else if textual(&data_type) || temporal(&data_type) {
        (b's', scalar_text(value)?.into_bytes())
    } else if data_type == "json" {
        let mut encoded = Vec::new();
        canonical_json(value, &mut encoded)?;
        (b'j', encoded)
    } else {
        return Ok(None);
    };
    let mut output = vec![tag];
    output.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    output.extend_from_slice(&payload);
    Ok(Some(output))
}

fn canonical_key(table: &ExecuteTable, values: &Map<String, Value>) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    for name in &table.key_columns {
        let column = table
            .columns
            .iter()
            .find(|column| &column.name == name)
            .ok_or_else(|| "content key has no catalog column".to_string())?;
        let value = values
            .get(name)
            .ok_or_else(|| "outbound row omitted a content key".to_string())?;
        let encoded = canonical_cell(column, value)?
            .ok_or_else(|| "content key type is not exactly verifiable".to_string())?;
        if value.is_null() {
            return Err("content key unexpectedly contains NULL".into());
        }
        output.extend_from_slice(&(encoded.len() as u64).to_be_bytes());
        output.extend_from_slice(&encoded);
    }
    Ok(output)
}

fn canonical_row(table: &ExecuteTable, values: &Map<String, Value>) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    for column in &table.columns {
        if unsupported_reason(column).is_some() {
            continue;
        }
        let value = values
            .get(&column.name)
            .ok_or_else(|| format!("{} row omitted a comparable column", source_key(table)))?;
        let encoded = canonical_cell(column, value)?
            .ok_or_else(|| "comparable column became unsupported".to_string())?;
        output.extend_from_slice(&(column.name.len() as u64).to_be_bytes());
        output.extend_from_slice(column.name.as_bytes());
        output.extend_from_slice(&(column.data_type.len() as u64).to_be_bytes());
        output.extend_from_slice(column.data_type.as_bytes());
        output.extend_from_slice(&(encoded.len() as u64).to_be_bytes());
        output.extend_from_slice(&encoded);
    }
    Ok(output)
}

fn ordered_rows<'a>(
    table: &ExecuteTable,
    rows: &'a [RefreshMaskRowInput],
) -> Result<Vec<&'a RefreshMaskRowInput>, String> {
    let mut keyed = rows
        .iter()
        .map(|row| Ok((canonical_key(table, &row.values)?, row)))
        .collect::<Result<Vec<_>, String>>()?;
    keyed.sort_by(|left, right| left.0.cmp(&right.0));
    if keyed.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(format!(
            "{} verification returned a duplicate canonical key",
            source_key(table)
        ));
    }
    Ok(keyed.into_iter().map(|(_, row)| row).collect())
}

fn rows_sha256(table: &ExecuteTable, rows: &[RefreshMaskRowInput]) -> Result<[u8; 32], String> {
    let ordered = ordered_rows(table, rows)?;
    let mut hash = Sha256::new();
    update_bytes(&mut hash, b"TxUI refresh chunk content v1");
    update_bytes(&mut hash, source_key(table).as_bytes());
    hash.update((ordered.len() as u64).to_be_bytes());
    for row in ordered {
        let encoded = canonical_row(table, &row.values)
            .map_err(|error| format!("{}: {error}", source_key(table)))?;
        update_bytes(&mut hash, &encoded);
    }
    Ok(hash.finalize().into())
}

fn differing_columns(
    table: &ExecuteTable,
    expected: &[RefreshMaskRowInput],
    actual: &[RefreshMaskRowInput],
) -> Vec<String> {
    let Ok(expected) = ordered_rows(table, expected) else {
        return Vec::new();
    };
    let Ok(actual) = ordered_rows(table, actual) else {
        return Vec::new();
    };
    let mut different = Vec::new();
    for column in table
        .columns
        .iter()
        .filter(|column| unsupported_reason(column).is_none())
    {
        let changed = expected.iter().zip(&actual).any(|(expected, actual)| {
            match (
                canonical_cell(column, &expected.values[&column.name]),
                canonical_cell(column, &actual.values[&column.name]),
            ) {
                (Ok(expected), Ok(actual)) => expected != actual,
                _ => true,
            }
        });
        if changed {
            let mut label = column.name.clone();
            if decimal(&column.data_type.to_ascii_lowercase()) {
                let scales = expected.iter().zip(&actual).find_map(|(expected, actual)| {
                    let expected_value = &expected.values[&column.name];
                    let actual_value = &actual.values[&column.name];
                    let expected_encoded = canonical_cell(column, expected_value).ok()?;
                    let actual_encoded = canonical_cell(column, actual_value).ok()?;
                    if expected_encoded == actual_encoded {
                        return None;
                    }
                    let expected_scale =
                        rust_decimal::Decimal::from_str(&scalar_text(expected_value).ok()?)
                            .ok()?
                            .scale();
                    let actual_scale =
                        rust_decimal::Decimal::from_str(&scalar_text(actual_value).ok()?)
                            .ok()?
                            .scale();
                    Some((expected_scale, actual_scale))
                });
                if let Some((expected, actual)) = scales {
                    label.push_str(&format!("(scale {expected}/{actual})"));
                }
            }
            different.push(label);
        }
    }
    different
}

fn target_rows(
    table: &ExecuteTable,
    grid: &super::GridData,
) -> Result<Vec<RefreshMaskRowInput>, String> {
    grid.rows
        .iter()
        .map(|row| {
            let mut values = Map::new();
            for column in table.columns.iter().filter(|column| !generated(column)) {
                values.insert(
                    column.name.clone(),
                    value(grid, row, &column.name).map_err(|error| error.message)?,
                );
            }
            Ok(RefreshMaskRowInput {
                table: source_key(table),
                values,
            })
        })
        .collect()
}

pub fn validate_content_keys(input: &ExecuteInput) -> Result<(), crate::apperror::AppError> {
    if !input.verification.content_sha256 {
        return Ok(());
    }
    for table in &input.tables {
        for name in &table.key_columns {
            let column = table
                .columns
                .iter()
                .find(|column| &column.name == name)
                .ok_or_else(|| failed("Refresh content key has no catalog metadata"))?;
            if unsupported_reason(column).is_some() {
                return Err(crate::apperror::AppError::bad_request(format!(
                    "{} content verification requires an exactly comparable unique key",
                    source_key(table)
                )));
            }
        }
    }
    Ok(())
}

pub fn initialize(input: &ExecuteInput, states: &BTreeMap<String, TableState>, run: &mut RunState) {
    let mut report = RefreshVerificationReport::default();
    for table in &input.tables {
        let selected_rows = states
            .get(&source_key(table))
            .map(|state| state.rows.len() as u64)
            .unwrap_or(0);
        report.tables.push(RefreshTableVerification {
            table: source_key(table),
            target: format!("{}.{}", table.target_schema, table.table),
            selected_rows,
            committed_rows: 0,
            target_rows: None,
            count_status: if input.verification.exact_counts {
                "pending".into()
            } else {
                "disabled".into()
            },
            content_status: if input.verification.content_sha256 {
                "pending".into()
            } else {
                "disabled".into()
            },
            content_sha256: None,
            chunks_checked: 0,
            chunk_hashes: Vec::new(),
            chunk_hashes_omitted: 0,
        });
        for column in &table.columns {
            if let Some(reason) = unsupported_reason(column) {
                report.unverified_columns.push(RefreshUnverifiedColumn {
                    table: source_key(table),
                    column: column.name.clone(),
                    data_type: column.data_type.clone(),
                    reason,
                });
            }
        }
    }
    for edge in &input.foreign_keys {
        report.foreign_keys.push(RefreshForeignKeyVerification {
            name: edge.name.clone(),
            child: fk_child_key(edge),
            parent: fk_parent_key(edge),
            status: if input.verification.foreign_key_orphans {
                "pending".into()
            } else {
                "disabled".into()
            },
            orphan_rows: None,
        });
    }
    run.verification = report;
}

fn table_report_mut<'a>(
    run: &'a mut RunState,
    table: &ExecuteTable,
) -> &'a mut RefreshTableVerification {
    let key = source_key(table);
    run.verification
        .tables
        .iter_mut()
        .find(|report| report.table == key)
        .expect("verification table initialized")
}

pub async fn verify_committed_batch(
    table: &ExecuteTable,
    expected: &[RefreshMaskRowInput],
    target: &mut sqlx::MySqlConnection,
    content: &mut TableContentState,
    run: &mut RunState,
    cancel_rx: &mut super::RefreshCancel,
) -> Result<(), crate::apperror::AppError> {
    if expected.is_empty() {
        return Err(failed("Refresh cannot verify an empty committed batch"));
    }
    table_report_mut(run, table).committed_rows += expected.len() as u64;
    let keys = expected
        .iter()
        .map(|row| {
            table
                .key_columns
                .iter()
                .map(|name| {
                    row.values
                        .get(name)
                        .cloned()
                        .ok_or_else(|| failed("Refresh outbound row omitted its verification key"))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()?;
    let predicate = tuple_in(&table.key_columns, &keys)?;
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
    let sql = format!(
        "SELECT {selected} FROM {} WHERE {predicate}",
        relation(&table.target_schema, &table.table)
    );
    let grid = target_grid(target, &sql, expected.len(), cancel_rx).await?;
    let actual = target_rows(table, &grid).map_err(|_| {
        failed(format!(
            "{} target verification rows could not be canonically decoded",
            source_key(table)
        ))
    })?;
    if actual.len() != expected.len() {
        table_report_mut(run, table).content_status = "failed".into();
        return Err(failed(format!(
            "{} target content re-read returned {} rows for {} committed identities; committed chunks remain",
            source_key(table),
            actual.len(),
            expected.len()
        )));
    }
    let outbound = rows_sha256(table, expected).map_err(|error| {
        failed(format!(
            "outbound content is not exactly verifiable: {error}"
        ))
    })?;
    let target = rows_sha256(table, &actual)
        .map_err(|error| failed(format!("target content is not exactly verifiable: {error}")))?;
    let chunk_index = content.chunks + 1;
    let matched = outbound == target;
    let report = table_report_mut(run, table);
    report.chunks_checked += 1;
    let chunk = RefreshChunkVerification {
        chunk_index,
        rows: expected.len() as u64,
        outbound_sha256: hex::encode(outbound),
        target_sha256: hex::encode(target),
        matched,
    };
    if report.chunk_hashes.len() < CHUNK_HASH_REPORT_CAP || !matched {
        report.chunk_hashes.push(chunk);
    } else {
        report.chunk_hashes_omitted += 1;
    }
    if !matched {
        report.content_status = "failed".into();
        let columns = differing_columns(table, expected, &actual).join(",");
        return Err(failed(format!(
            "{} masked-content SHA-256 mismatch at verification chunk {chunk_index} (columns: {columns}); committed chunks remain and no row values are included",
            source_key(table)
        )));
    }
    content.add_chunk(expected.len(), outbound);
    Ok(())
}

pub fn finish_table_content(table: &ExecuteTable, content: TableContentState, run: &mut RunState) {
    let partial = run.verification.unverified_columns.iter().any(|column| {
        column.table == source_key(table) && !generated_column(table, &column.column)
    });
    let report = table_report_mut(run, table);
    report.content_sha256 = Some(content.finish());
    report.content_status = if partial {
        "partial".into()
    } else {
        "verified".into()
    };
}

fn generated_column(table: &ExecuteTable, name: &str) -> bool {
    table
        .columns
        .iter()
        .find(|column| column.name == name)
        .is_some_and(generated)
}

pub async fn finish_verification(
    input: &ExecuteInput,
    target: &mut sqlx::MySqlConnection,
    run: &mut RunState,
    cancel_rx: &mut super::RefreshCancel,
) -> Result<(), crate::apperror::AppError> {
    let mut failure = None;
    let mut overall = Sha256::new();
    update_bytes(&mut overall, b"TxUI refresh comparable content v1");
    for table in &input.tables {
        super::check_cancel(cancel_rx)?;
        let table_name = source_key(table);
        let (expected, content_hash) = {
            let report = table_report_mut(run, table);
            report.committed_rows = report.selected_rows;
            (report.selected_rows, report.content_sha256.clone())
        };
        if input.verification.content_sha256 {
            update_bytes(&mut overall, table_name.as_bytes());
            update_bytes(
                &mut overall,
                content_hash
                    .as_deref()
                    .unwrap_or("verification-incomplete")
                    .as_bytes(),
            );
        }
        if input.verification.exact_counts {
            let sql = format!(
                "SELECT COUNT(*) FROM {}",
                relation(&table.target_schema, &table.table)
            );
            let actual = tokio::select! {
                result = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql).into_sql_str()).fetch_one(&mut *target) => result,
                _ = cancel_rx.wait() => return Err(super::cancelled("Refresh cancelled during exact-count verification; committed chunks remain and verification is incomplete")),
            }
            .map_err(|_| failed("Refresh exact-count verification read failed; database details are omitted"))?;
            let actual = u64::try_from(actual).map_err(|_| {
                failed("Refresh exact-count verification returned a negative count")
            })?;
            let report = table_report_mut(run, table);
            report.target_rows = Some(actual);
            report.count_status = if actual == expected {
                "verified"
            } else {
                "failed"
            }
            .into();
            if actual != expected && failure.is_none() {
                failure = Some(format!(
                    "{} exact count mismatch: selected/committed {expected}, target {actual}; committed chunks remain",
                    source_key(table)
                ));
            }
        }
    }
    for index in 0..input.foreign_keys.len() {
        super::check_cancel(cancel_rx)?;
        if !input.verification.foreign_key_orphans {
            break;
        }
        let edge = &input.foreign_keys[index];
        let child = input
            .tables
            .iter()
            .find(|table| source_key(table) == fk_child_key(edge))
            .ok_or_else(|| failed("Refresh FK verification lost its child mapping"))?;
        let parent = input
            .tables
            .iter()
            .find(|table| source_key(table) == fk_parent_key(edge))
            .ok_or_else(|| failed("Refresh FK verification lost its parent mapping"))?;
        let join = edge
            .parts
            .iter()
            .map(|part| {
                format!(
                    "child.{} = parent.{}",
                    quote(&part.column),
                    quote(&part.ref_column)
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ");
        let nonnull = edge
            .parts
            .iter()
            .map(|part| format!("child.{} IS NOT NULL", quote(&part.column)))
            .collect::<Vec<_>>()
            .join(" AND ");
        let parent_missing = format!("parent.{} IS NULL", quote(&edge.parts[0].ref_column));
        let sql = format!(
            "SELECT COUNT(*) FROM {} child LEFT JOIN {} parent ON {join} WHERE {nonnull} AND {parent_missing}",
            relation(&child.target_schema, &child.table),
            relation(&parent.target_schema, &parent.table),
        );
        let orphans = tokio::select! {
            result = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql).into_sql_str()).fetch_one(&mut *target) => result,
            _ = cancel_rx.wait() => return Err(super::cancelled("Refresh cancelled during FK orphan verification; committed chunks remain and verification is incomplete")),
        }
        .map_err(|_| failed(format!("Refresh orphan verification for {} failed; database details are omitted", edge.name)))?;
        let orphans = u64::try_from(orphans)
            .map_err(|_| failed("Refresh orphan verification returned a negative count"))?;
        let report = &mut run.verification.foreign_keys[index];
        report.orphan_rows = Some(orphans);
        report.status = if orphans == 0 { "verified" } else { "failed" }.into();
        if orphans > 0 && failure.is_none() {
            failure = Some(format!(
                "{} found {orphans} target FK orphan rows; committed chunks remain",
                edge.name
            ));
        }
    }
    if input.verification.content_sha256 {
        run.verification.comparable_content_sha256 = Some(format!("{:x}", overall.finalize()));
    }
    if let Some(message) = failure {
        run.verification.status = "failed".into();
        return Err(failed(message));
    }
    let enabled = input.verification.exact_counts
        || input.verification.foreign_key_orphans
        || input.verification.content_sha256;
    let complete = input.verification.exact_counts
        && input.verification.foreign_key_orphans
        && input.verification.content_sha256
        && run.verification.unverified_columns.is_empty();
    run.verification.status = if complete {
        "verified".into()
    } else if enabled {
        "partial".into()
    } else {
        "disabled".into()
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::canonical_values;
    use super::*;

    fn column(name: &str, data_type: &str) -> ExecuteColumn {
        ExecuteColumn {
            name: name.into(),
            data_type: data_type.into(),
            column_type: data_type.into(),
            nullable: true,
            collation: None,
            charset: None,
            char_max_len: None,
            generation_expression: None,
            extra: String::new(),
        }
    }

    fn table() -> ExecuteTable {
        ExecuteTable {
            source_schema: "source".into(),
            target_schema: "target".into(),
            table: "items".into(),
            action: "full".into(),
            root_sql: None,
            policy: "full".into(),
            hard_limit: None,
            key_columns: vec!["id".into()],
            unique_keys: Vec::new(),
            batch_rows: 10,
            columns: vec![
                column("id", "int"),
                column("value", "varchar"),
                column("amount", "decimal"),
                column("payload", "varbinary"),
            ],
            indexes: Vec::new(),
        }
    }

    fn row(id: i64, value: Value, amount: &str, payload: &[u8]) -> RefreshMaskRowInput {
        let mut values = Map::new();
        values.insert("id".into(), Value::from(id));
        values.insert("value".into(), value);
        values.insert("amount".into(), Value::String(amount.into()));
        values.insert(
            "payload".into(),
            serde_json::json!({REFRESH_BINARY_KEY: hex::encode(payload)}),
        );
        RefreshMaskRowInput {
            table: "source.items".into(),
            values,
        }
    }

    #[test]
    fn canonical_hashes_are_key_ordered_and_mutation_sensitive() {
        let table = table();
        let clean = vec![
            row(2, Value::String("second".into()), "2.00", &[0, 255]),
            row(1, Value::Null, "1.00", &[0, 1, 255]),
        ];
        let reversed = vec![clean[1].clone(), clean[0].clone()];
        assert_eq!(
            rows_sha256(&table, &clean).unwrap(),
            rows_sha256(&table, &reversed).unwrap()
        );
        let baseline = rows_sha256(&table, &clean).unwrap();
        for mutated in [
            vec![
                clean[1].clone(),
                row(2, Value::String(String::new()), "2.00", &[0, 255]),
            ],
            vec![
                clean[1].clone(),
                row(2, Value::String("second".into()), "2.0", &[0, 255]),
            ],
            vec![
                clean[1].clone(),
                row(2, Value::String("second".into()), "2.00", &[0, 254]),
            ],
            vec![
                clean[1].clone(),
                row(2, Value::String("masked-change".into()), "2.00", &[0, 255]),
            ],
        ] {
            assert_ne!(rows_sha256(&table, &mutated).unwrap(), baseline);
        }
    }

    #[test]
    fn null_empty_decimal_scale_binary_and_json_numbers_are_typed_exactly() {
        let table = table();
        let null = canonical_row(&table, &row(1, Value::Null, "1.00", &[255]).values).unwrap();
        let empty = canonical_row(
            &table,
            &row(1, Value::String(String::new()), "1.00", &[255]).values,
        )
        .unwrap();
        let scale = canonical_row(&table, &row(1, Value::Null, "1.0", &[255]).values).unwrap();
        let binary = canonical_row(&table, &row(1, Value::Null, "1.00", &[254]).values).unwrap();
        assert_ne!(null, empty);
        assert_ne!(null, scale);
        assert_ne!(null, binary);
        assert!(binary_bytes(&Value::String("00ff".into())).is_err());

        let json = column("document", "json");
        let mut exact = Vec::new();
        canonical_cell(&json, &serde_json::json!({"n": 9007199254740993_u64}))
            .unwrap()
            .unwrap();
        canonical_json(&serde_json::json!({"n": 9007199254740993_u64}), &mut exact).unwrap();
        let error = canonical_cell(&json, &serde_json::json!({"n": 1.5})).unwrap_err();
        assert!(error.contains("lossy f64"));
        assert!(!error.contains("1.5"));
    }

    #[test]
    fn duplicate_keys_fail_instead_of_disappearing_into_a_hash() {
        let table = table();
        let duplicate = vec![
            row(1, Value::Null, "1.00", &[0]),
            row(1, Value::String("different".into()), "2.00", &[1]),
        ];
        let error = rows_sha256(&table, &duplicate).unwrap_err();
        assert!(error.contains("duplicate canonical key"));
        assert!(!error.contains("different"));
    }

    #[test]
    fn generated_float_and_unknown_columns_are_explicitly_unverified() {
        let mut generated = column("computed", "varchar");
        generated.generation_expression = Some("concat(`value`,'!')".into());
        assert!(unsupported_reason(&generated)
            .unwrap()
            .contains("target-generated"));
        assert!(unsupported_reason(&column("ratio", "double"))
            .unwrap()
            .contains("f64"));
        assert!(unsupported_reason(&column("custom", "custom_type"))
            .unwrap()
            .contains("no exact"));
    }

    #[test]
    fn canonical_keys_do_not_use_database_or_legacy_string_order() {
        let table = table();
        let numeric = canonical_values(&[Value::from(-2)]).unwrap();
        let other_numeric = canonical_values(&[Value::from(-11)]).unwrap();
        assert!(numeric < other_numeric);
        let two = canonical_key(&table, &row(-2, Value::Null, "1.00", &[0]).values).unwrap();
        let eleven = canonical_key(&table, &row(-11, Value::Null, "1.00", &[0]).values).unwrap();
        assert!(two > eleven);
    }

    #[test]
    fn table_final_hash_covers_every_chunk_not_only_reported_ones() {
        let table = table();
        let mut content = TableContentState::new(&table);
        for index in 0..(CHUNK_HASH_REPORT_CAP + 3) {
            content.add_chunk(1, [index as u8; 32]);
        }
        assert_eq!(content.chunks, CHUNK_HASH_REPORT_CAP as u64 + 3);
        assert_eq!(content.finish().len(), 64);
    }
}
