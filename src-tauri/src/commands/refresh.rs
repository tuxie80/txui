//! Safe Environment Refresh specification files. No database connection is used:
//! JSON validation lives in the pure frontend `refreshSpec.ts` contract.

use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_REFRESH_SPEC_BYTES: usize = 2 * 1024 * 1024;

#[tauri::command]
pub async fn refresh_spec_load(path: PathBuf) -> Result<String, crate::apperror::AppError> {
    let metadata = tokio::fs::metadata(&path).await.map_err(|error| {
        crate::apperror::AppError::local(format!("could not open refresh spec {}: {error}", path.display()))
    })?;
    if metadata.len() > MAX_REFRESH_SPEC_BYTES as u64 {
        return Err(crate::apperror::AppError::bad_request("refresh spec exceeds the 2 MiB limit"));
    }
    tokio::fs::read_to_string(&path).await.map_err(|error| {
        crate::apperror::AppError::local(format!("refresh spec is not valid UTF-8: {error}"))
    })
}

#[tauri::command]
pub async fn refresh_spec_save(path: PathBuf, contents: String) -> Result<u64, crate::apperror::AppError> {
    if contents.len() > MAX_REFRESH_SPEC_BYTES {
        return Err(crate::apperror::AppError::bad_request("refresh spec exceeds the 2 MiB limit"));
    }
    let dir = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let base = path.file_name().and_then(|name| name.to_str()).unwrap_or("refresh.json");
    let tmp = dir.join(format!(".{base}.txui-tmp-{}", Uuid::new_v4().simple()));
    let result: Result<(), std::io::Error> = async {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&tmp).await?;
        file.write_all(contents.as_bytes()).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }.await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(crate::apperror::AppError::local(format!("could not save refresh spec {}: {error}", path.display())));
    }
    Ok(contents.len() as u64)
}

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::str::FromStr;
use std::time::Instant;

const MAX_MASK_BATCH_ROWS: usize = 10_000;
const MAX_MASK_TEXT_BYTES: usize = 1024 * 1024;
const MAX_UNIQUE_KEYS: usize = 10_000_000;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct RefreshMaskRuleInput {
    pub table: String,
    pub column: String,
    pub rule: String,
    pub generator: Option<String>,
    pub value: Option<Value>,
    pub relation: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct RefreshMaskColumnInput {
    pub name: String,
    pub data_type: String,
    pub collation: Option<String>,
    pub char_max_len: Option<u64>,
    pub generation_expression: Option<String>,
    pub extra: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct RefreshMaskIndexInput {
    pub name: String,
    pub unique: bool,
    pub columns: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct RefreshMaskTableInput {
    pub name: String,
    pub columns: Vec<RefreshMaskColumnInput>,
    pub indexes: Vec<RefreshMaskIndexInput>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct RefreshMaskRelationInput {
    pub relation: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct RefreshMaskRowInput {
    pub table: String,
    pub values: Map<String, Value>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct RefreshCommittedScopeInput {
    pub committed_rows: u64,
    pub in_flight_rows: u64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct RefreshMaskBatchInput {
    pub seed: String,
    pub rules: Vec<RefreshMaskRuleInput>,
    pub tables: Vec<RefreshMaskTableInput>,
    pub relations: Vec<RefreshMaskRelationInput>,
    pub rows: Vec<RefreshMaskRowInput>,
    pub allow_fk_breaking: bool,
    pub acknowledge_unmasked_sensitive: bool,
    pub committed_scope: RefreshCommittedScopeInput,
    pub max_unique_keys: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RefreshMaskBatchResponse {
    pub rows: Vec<RefreshMaskRowInput>,
    pub accepted_rows: u64,
    pub masked_cells: u64,
    pub unique_keys: usize,
    pub elapsed_ms: u64,
}

impl Serialize for RefreshMaskRowInput {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("RefreshMaskRowInput", 2)?;
        state.serialize_field("table", &self.table)?;
        state.serialize_field("values", &self.values)?;
        state.end()
    }
}

fn bad_request(message: impl Into<String>) -> crate::apperror::AppError {
    crate::apperror::AppError::bad_request(message)
}

fn constraint(message: impl Into<String>) -> crate::apperror::AppError {
    crate::apperror::AppError::new(crate::apperror::ErrorCode::Constraint, message)
}

fn generated(column: &RefreshMaskColumnInput) -> bool {
    column.generation_expression.is_some() || column.extra.to_lowercase().contains("generated")
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(v) => format!("boolean:{v}"),
        Value::Number(v) => format!("number:{v}"),
        Value::String(v) => format!("string:{}:{v}", v.len()),
        _ => "unsupported".into(),
    }
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::Null => String::new(),
        _ => String::new(),
    }
}

fn generator_params() -> crate::commands::datagen::GenParams {
    serde_json::from_value(serde_json::json!({
        "min": 1.0, "max": 1000.0, "dateFrom": "2024-01-01", "dateTo": "2026-07-01",
        "list": "", "nullPct": 0.0,
    })).expect("static generator parameters")
}

fn generator_alias(name: &str) -> &str {
    match name {
        "person.full_name" => "fullName",
        "person.first_name" => "firstName",
        "person.last_name" => "lastName",
        "internet.email" => "email",
        "internet.username" => "username",
        "company.name" => "company",
        "address.city" => "city",
        "address.country" => "country",
        "phone.number" => "phone",
        "uuid.v4" => "uuid",
        other => other,
    }
}

async fn mask_value(
    seed: &str,
    scope: &str,
    rule: &RefreshMaskRuleInput,
    column: &RefreshMaskColumnInput,
    value: &Value,
) -> Result<Value, crate::apperror::AppError> {
    if value.is_null() || rule.rule == "preserve" {
        return Ok(value.clone());
    }
    if rule.rule == "constant" {
        return Ok(rule.value.clone().unwrap_or(Value::Null));
    }
    let input = canonical(value);
    if rule.rule == "hash" {
        let digest = Sha256::digest(format!("{seed}\0{scope}\0{input}").as_bytes());
        return Ok(Value::String(format!("{digest:x}")));
    }
    if matches!(rule.generator.as_deref(), Some("format" | "format_preserving" | "format-preserving")) {
        let text = value_text(value);
        let mut out = String::new();
        for (index, character) in text.chars().enumerate() {
            let digest = Sha256::digest(format!("{seed}\0{scope}\0format\0{index}\0{input}").as_bytes());
            let number = u32::from_be_bytes(digest[..4].try_into().unwrap());
            let mapped = if character.is_alphabetic() {
                let alphabet = if character.is_uppercase() { b"ABCDEFGHIJKLMNOPQRSTUVWXYZ" } else { b"abcdefghijklmnopqrstuvwxyz" };
                alphabet[number as usize % 26] as char
            } else if character.is_numeric() {
                char::from(b'0' + (number % 10) as u8)
            } else {
                character
            };
            out.push(mapped);
        }
        return Ok(Value::String(out));
    }
    let generator = generator_alias(rule.generator.as_deref().unwrap_or(""));
    let seed_digest = Sha256::digest(format!("{seed}\0{scope}\0{input}").as_bytes());
    let rng_seed = u32::from_be_bytes(seed_digest[..4].try_into().unwrap());
    let row_index = u32::from_be_bytes(seed_digest[4..8].try_into().unwrap()) as u64;
    let spec = crate::commands::datagen::ColumnSpec {
        name: column.name.clone(),
        type_name: column.data_type.clone(),
        generator: generator.into(),
        params: generator_params(),
        unique: false,
    };
    let output = crate::commands::datagen::generate_value_at(spec, rng_seed, row_index);
    if output.is_null() {
        return Err(bad_request("unknown or unsupported seeded generator"));
    }
    Ok(output)
}

fn fold_latin(character: char) -> Option<char> {
    let folded = match character {
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' | 'Ā' | 'Ă' | 'Ą' => 'A',
        'é' | 'è' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'É' | 'È' | 'Ê' | 'Ë' | 'Ē' | 'Ĕ' | 'Ė' | 'Ę' | 'Ě' => 'E',
        'í' | 'ì' | 'î' | 'ï' | 'ī' | 'ĩ' | 'į' => 'i',
        'Í' | 'Ì' | 'Î' | 'Ï' | 'Ī' | 'Ĩ' | 'Į' => 'I',
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ō' | 'ŏ' | 'ő' => 'o',
        'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' | 'Ō' | 'Ŏ' | 'Ő' => 'O',
        'ú' | 'ù' | 'û' | 'ü' | 'ū' | 'ũ' | 'ů' | 'ű' | 'ų' => 'u',
        'Ú' | 'Ù' | 'Û' | 'Ü' | 'Ū' | 'Ũ' | 'Ů' | 'Ű' | 'Ų' => 'U',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'Ý' | 'Ÿ' | 'Ŷ' => 'Y',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'Ñ' | 'Ń' | 'Ņ' | 'Ň' => 'N',
        'ç' | 'ć' | 'ĉ' | 'č' => 'c',
        'Ç' | 'Ć' | 'Ĉ' | 'Č' => 'C',
        'š' | 'ś' | 'ŝ' => 's',
        'Š' | 'Ś' | 'Ŝ' => 'S',
        'ž' | 'ź' | 'ż' => 'z',
        'Ž' | 'Ź' | 'Ż' => 'Z',
        other => return Some(other),
    };
    Some(folded)
}

fn canonical_column(column: &RefreshMaskColumnInput, value: &Value) -> Result<String, crate::apperror::AppError> {
    if value.is_null() {
        return Ok("null".into());
    }
    let data_type = column.data_type.to_lowercase();
    if data_type.contains("int") || data_type.contains("decimal") || data_type.contains("numeric")
        || data_type.contains("float") || data_type.contains("double") || data_type.contains("year")
    {
        let text = value_text(value);
        let decimal = rust_decimal::Decimal::from_str(&text)
            .map_err(|_| bad_request("non-numeric value in a numeric unique column"))?;
        return Ok(format!("n:{}", decimal.normalize()));
    }
    if let Value::Bool(v) = value {
        return Ok(format!("b:{v}"));
    }
    let mut text = value_text(value);
    let collation = column.collation.as_deref().unwrap_or("").to_lowercase();
    if !collation.ends_with("_bin") {
        text = text.trim_end().into();
    }
    if collation.contains("_ai") {
        text = text.chars().map(fold_latin).collect::<Option<String>>()
            .ok_or_else(|| bad_request("unsupported Unicode accent-fold comparison"))?;
    }
    if collation.contains("_ci") {
        text = text.to_lowercase();
    }
    Ok(format!("s:{text}"))
}

fn sensitive(name: &str) -> bool {
    let name = name.to_lowercase();
    ["email", "password", "passwd", "secret", "token", "api_key", "apikey", "ssn",
        "credit_card", "card_number", "iban", "bic", "phone", "mobile", "address",
        "full_name", "first_name", "last_name", "dob", "birth", "passport",
        "national_id", "license", "private_key", "auth",
    ].iter().any(|part| name.contains(part))
}

#[tauri::command]
pub async fn refresh_mask_apply(input: RefreshMaskBatchInput) -> Result<RefreshMaskBatchResponse, crate::apperror::AppError> {
    let started = Instant::now();
    if input.rows.len() > MAX_MASK_BATCH_ROWS {
        return Err(bad_request("refresh mask batch exceeds the 10000-row limit"));
    }
    if input.rules.len() > 10_000 || input.tables.len() > 1000 || input.max_unique_keys == 0 || input.max_unique_keys > MAX_UNIQUE_KEYS {
        return Err(bad_request("refresh mask batch metadata or unique-key cap is invalid"));
    }
    let tables: BTreeMap<String, &RefreshMaskTableInput> = input.tables.iter().map(|table| (table.name.clone(), table)).collect();
    if tables.len() != input.tables.len() {
        return Err(bad_request("refresh mask batch contains duplicate tables"));
    }
    let rules: BTreeMap<String, &RefreshMaskRuleInput> = input.rules.iter().map(|rule| (format!("{}.{}", rule.table, rule.column), rule)).collect();
    if rules.len() != input.rules.len() {
        return Err(bad_request("refresh mask batch contains duplicate table/column rules"));
    }
    for (name, rule) in &rules {
        let table = tables.get(&rule.table).ok_or_else(|| bad_request(format!("{name} has no catalog table")))?;
        let column = table.columns.iter().find(|column| column.name == rule.column)
            .ok_or_else(|| bad_request(format!("{name} has no catalog column")))?;
        if generated(column) && rule.rule != "preserve" {
            return Err(bad_request(format!("{name} is generated and must be recomputed by the target")));
        }
        if rule.rule == "hash" && column.char_max_len.is_some_and(|length| length < 64) {
            return Err(bad_request(format!("{name} cannot store a 64-character SHA-256 mask")));
        }
        if rule.rule != "preserve" && matches!(column.data_type.to_lowercase().as_str(),
            "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob"
            | "geometry" | "point" | "linestring" | "polygon" | "multipoint"
            | "multilinestring" | "multipolygon" | "geometrycollection" | "geography" | "bit")
        {
            return Err(bad_request(format!("{name} has an unsupported type for masking")));
        }
        if matches!(rule.rule.as_str(), "hash" | "fake")
            && !matches!(column.data_type.to_lowercase().as_str(), "char" | "varchar" | "text" | "tinytext" | "mediumtext" | "longtext" | "json" | "enum" | "set")
        {
            return Err(bad_request(format!("{name} requires a text-compatible column for hash/fake masks")));
        }
    }
    if !input.acknowledge_unmasked_sensitive {
        for table in &input.tables {
            for column in &table.columns {
                let name = format!("{}.{}", table.name, column.name);
                if sensitive(&column.name) && rules.get(&name).is_none_or(|rule| rule.rule == "preserve") {
                    return Err(bad_request(format!("{name} is sensitive-looking and remains unmasked; explicit acknowledgment is required")));
                }
            }
        }
    }
    if !input.allow_fk_breaking {
        let mut relations: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        for relation in &input.relations {
            relations.entry(relation.relation.clone()).or_default()
                .insert(format!("{}.{}", relation.table, relation.column), "preserve".into());
        }
        for rule in &input.rules {
            if let Some(relation) = &rule.relation {
                let signature = match rule.rule.as_str() {
                    "constant" => format!("constant:{}", rule.value.clone().unwrap_or(Value::Null)),
                    "fake" => format!("fake:{}", generator_alias(rule.generator.as_deref().unwrap_or(""))),
                    other => other.into(),
                };
                relations.entry(relation.clone()).or_default()
                    .insert(format!("{}.{}", rule.table, rule.column), signature);
            }
        }
        for (relation, columns) in relations {
            let mut signatures = columns.values();
            let Some(first) = signatures.next() else { continue };
            if signatures.any(|signature| signature != first) {
                return Err(constraint(format!("foreign-key relation {relation} has different mask rules; relational equality would break")));
            }
        }
    }
    let mut output = Vec::with_capacity(input.rows.len());
    let mut seen = HashSet::new();
    let mut masked_cells = 0_u64;
    for row in &input.rows {
        let table = tables.get(&row.table).ok_or_else(|| bad_request(format!("{} has no catalog table", row.table)))?;
        for column in &table.columns {
            if generated(column) && row.values.contains_key(&column.name) {
                return Err(constraint(format!("{}: generated columns must not be inserted ({})", table.name, column.name)));
            }
        }
        let mut values = Map::new();
        for column in &table.columns {
            let name = format!("{}.{}", table.name, column.name);
            let source = row.values.get(&column.name).unwrap_or(&Value::Null);
            let scope = rules.get(&name).and_then(|rule| rule.relation.as_ref())
                .filter(|_| !input.allow_fk_breaking)
                .map(|relation| format!("relation:{relation}"))
                .unwrap_or_else(|| format!("column:{name}"));
            let masked = match rules.get(&name) {
                Some(rule) => {
                    let value = mask_value(&input.seed, &scope, rule, column, source).await?;
                    masked_cells += 1;
                    value
                }
                None => source.clone(),
            };
            if masked.as_str().is_some_and(|text| text.len() > MAX_MASK_TEXT_BYTES) {
                return Err(bad_request(format!("{name} mask output exceeds the 1 MiB text limit")));
            }
            values.insert(column.name.clone(), masked);
        }
        for index in &table.indexes {
            if !index.unique && index.name != "PRIMARY" {
                continue;
            }
            if !index.columns.iter().any(|column| rules.get(&format!("{}.{}", table.name, column)).is_some_and(|rule| rule.rule != "preserve")) {
                continue;
            }
            let mut parts = Vec::new();
            let mut has_null = false;
            for name in &index.columns {
                let column = table.columns.iter().find(|column| &column.name == name)
                    .ok_or_else(|| bad_request(format!("{}.{} has no catalog metadata", table.name, name)))?;
                let value = values.get(name).ok_or_else(|| bad_request(format!("{}.{} is missing from the outbound row", table.name, name)))?;
                has_null |= value.is_null();
                parts.push(canonical_column(column, value)?);
            }
            if has_null {
                continue;
            }
            let key = format!("{}\0{}\0{}", table.name, index.name, parts.join("\u{1}"));
            if seen.contains(&key) {
                return Err(constraint(format!(
                    "{}: masked values collide on unique index {} ({}); committed_rows={} in_flight_rows={}",
                    table.name, index.name, index.columns.join(", "),
                    input.committed_scope.committed_rows, input.committed_scope.in_flight_rows,
                )));
            }
            if seen.len() >= input.max_unique_keys {
                return Err(constraint(format!(
                    "{}: unique collision tracking exceeds its key cap; committed_rows={} in_flight_rows={}",
                    table.name, input.committed_scope.committed_rows, input.committed_scope.in_flight_rows,
                )));
            }
            seen.insert(key);
        }
        output.push(RefreshMaskRowInput { table: row.table.clone(), values });
    }
    Ok(RefreshMaskBatchResponse {
        accepted_rows: output.len() as u64,
        rows: output,
        masked_cells,
        unique_keys: seen.len(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spec_round_trip_is_atomic_and_replaces_the_previous_good_file() {
        let dir = std::env::temp_dir().join(format!("txui-refresh-spec-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("refresh.json");
        assert_eq!(refresh_spec_save(path.clone(), "{\"version\":1}\n".into()).await.unwrap(), 14);
        assert_eq!(refresh_spec_load(path.clone()).await.unwrap(), "{\"version\":1}\n");
        refresh_spec_save(path.clone(), "{\"version\":1,\"seed\":\"new\"}\n".into()).await.unwrap();
        assert_eq!(refresh_spec_load(path.clone()).await.unwrap(), "{\"version\":1,\"seed\":\"new\"}\n");
        let leftovers = std::fs::read_dir(&dir).unwrap().filter(|entry| {
            entry.as_ref().unwrap().file_name().to_str()
                .is_some_and(|name| name.contains(".txui-tmp-"))
        }).count();
        assert_eq!(leftovers, 0);
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }

    #[tokio::test]
    async fn oversized_or_invalid_utf8_specs_are_refused_without_side_effects() {
        let dir = std::env::temp_dir().join(format!("txui-refresh-spec-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("refresh.json");
        let oversized = "x".repeat(MAX_REFRESH_SPEC_BYTES + 1);
        let error = refresh_spec_save(path.clone(), oversized).await.expect_err("oversized save");
        assert!(error.message.contains("2 MiB"));
        assert!(!path.exists());
        tokio::fs::write(&path, [0xff, 0xfe]).await.unwrap();
        let error = refresh_spec_load(path).await.expect_err("invalid UTF-8");
        assert!(error.message.contains("UTF-8"));
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }

    fn mask_column(name: &str, data_type: &str) -> RefreshMaskColumnInput {
        RefreshMaskColumnInput {
            name: name.into(), data_type: data_type.into(),
            collation: Some("utf8mb4_0900_ai_ci".into()),
            char_max_len: Some(64), generation_expression: None, extra: String::new(),
        }
    }

    fn mask_table() -> RefreshMaskTableInput {
        let mut computed = mask_column("computed", "varchar");
        computed.generation_expression = Some("concat(`full_name`,'!')".into());
        computed.extra = "STORED GENERATED".into();
        RefreshMaskTableInput {
            name: "source.parents".into(),
            columns: vec![
                mask_column("id", "varchar"),
                mask_column("email", "varchar"),
                mask_column("full_name", "varchar"),
                mask_column("code", "varchar"),
                mask_column("amount", "decimal"),
                mask_column("payload", "varbinary"),
                computed,
            ],
            indexes: vec![
                RefreshMaskIndexInput { name: "PRIMARY".into(), unique: true, columns: vec!["id".into()] },
                RefreshMaskIndexInput { name: "uq_email".into(), unique: true, columns: vec!["email".into()] },
                RefreshMaskIndexInput { name: "uq_amount".into(), unique: true, columns: vec!["amount".into()] },
            ],
        }
    }

    fn mask_rule(table: &str, column: &str, rule: &str, generator: Option<&str>, value: Option<Value>) -> RefreshMaskRuleInput {
        RefreshMaskRuleInput {
            table: table.into(), column: column.into(), rule: rule.into(),
            generator: generator.map(Into::into), value, relation: None,
        }
    }

    fn mask_row(table: &str, values: &[(&str, Value)]) -> RefreshMaskRowInput {
        RefreshMaskRowInput {
            table: table.into(),
            values: values.iter().map(|(name, value)| (name.to_string(), value.clone())).collect(),
        }
    }

    fn mask_input(rules: Vec<RefreshMaskRuleInput>, rows: Vec<RefreshMaskRowInput>) -> RefreshMaskBatchInput {
        RefreshMaskBatchInput {
            seed: "refresh-v1".into(), rules, tables: vec![mask_table()], relations: vec![], rows,
            allow_fk_breaking: false, acknowledge_unmasked_sensitive: true,
            committed_scope: RefreshCommittedScopeInput { committed_rows: 1, in_flight_rows: 1 },
            max_unique_keys: 1000,
        }
    }

    #[tokio::test]
    async fn mask_batch_is_deterministic_and_preserves_format_and_scalars() {
        let input = mask_input(
            vec![
                mask_rule("source.parents", "email", "hash", None, None),
                mask_rule("source.parents", "full_name", "fake", Some("person.full_name"), None),
                mask_rule("source.parents", "code", "fake", Some("format"), None),
            ],
            vec![
                mask_row("source.parents", &[("id", Value::String("p1".into())), ("email", Value::String("a@example.test".into())), ("full_name", Value::String("First Last".into())), ("code", Value::String("Ab-19".into())), ("amount", Value::String("1.00".into())), ("payload", Value::String("binary-source".into()))]),
                mask_row("source.parents", &[("id", Value::String("p2".into())), ("email", Value::String("b@example.test".into())), ("full_name", Value::String("First Last".into())), ("code", Value::String("Ab-19".into())), ("amount", Value::String("2.00".into())), ("payload", Value::String("binary-source".into()))]),
            ],
        );
        let first = refresh_mask_apply(input.clone()).await.unwrap();
        let second = refresh_mask_apply(input).await.unwrap();
        assert_eq!(first.accepted_rows, 2);
        assert_eq!(first.masked_cells, 6);
        assert_eq!(first.unique_keys, 2);
        assert_eq!(first.rows[0].values["email"].as_str().unwrap().len(), 64);
        assert_eq!(first.rows[0].values["full_name"], second.rows[0].values["full_name"]);
        assert!(first.rows[0].values["full_name"].as_str().unwrap().contains(' '));
        assert_eq!(first.rows[0].values["code"], second.rows[0].values["code"]);
        assert_eq!(first.rows[0].values["code"].as_str().unwrap().len(), 5);
        assert_eq!(first.rows[0].values["payload"], Value::String("binary-source".into()));
        assert_eq!(first.rows[0].values["amount"], Value::String("1.00".into()));
    }

    #[tokio::test]
    async fn mask_collision_errors_never_include_raw_or_masked_values() {
        let planted = "private@example.test";
        let error = refresh_mask_apply(mask_input(
            vec![mask_rule("source.parents", "email", "hash", None, None)],
            vec![
                mask_row("source.parents", &[("id", Value::String("p1".into())), ("email", Value::String(planted.into()))]),
                mask_row("source.parents", &[("id", Value::String("p2".into())), ("email", Value::String(planted.into()))]),
            ],
        )).await.expect_err("duplicate masked email");
        assert_eq!(error.code, crate::apperror::ErrorCode::Constraint);
        assert!(error.message.contains("committed_rows=1 in_flight_rows=1"));
        assert!(!format!("{error:?}").contains(planted));
        assert!(!error.message.contains("committed_rows=0"));
    }

    #[tokio::test]
    async fn mask_decimal_generated_and_cap_failures_keep_scope_without_values() {
        let decimal_error = refresh_mask_apply(mask_input(
            vec![mask_rule("source.parents", "amount", "constant", None, Some(serde_json::json!(1.0)))],
            vec![
                mask_row("source.parents", &[("id", Value::String("p1".into())), ("amount", Value::String("1.00".into()))]),
                mask_row("source.parents", &[("id", Value::String("p2".into())), ("amount", Value::String("1.0".into()))]),
            ],
        )).await.expect_err("exact decimal collision");
        assert!(decimal_error.message.contains("uq_amount"));
        assert!(!decimal_error.message.contains("1.00"));

        let generated_error = refresh_mask_apply(mask_input(
            vec![],
            vec![mask_row("source.parents", &[("computed", Value::String("raw-generated".into()))])],
        )).await.expect_err("generated insert");
        assert!(!generated_error.message.contains("raw-generated"));

        let mut capped = mask_input(
            vec![mask_rule("source.parents", "email", "hash", None, None)],
            vec![
                mask_row("source.parents", &[("id", Value::String("p1".into())), ("email", Value::String("one@example.test".into()))]),
                mask_row("source.parents", &[("id", Value::String("p2".into())), ("email", Value::String("two@example.test".into()))]),
            ],
        );
        capped.max_unique_keys = 1;
        let cap_error = refresh_mask_apply(capped).await.expect_err("unique key cap");
        assert!(cap_error.message.contains("committed_rows=1 in_flight_rows=1"));
        assert!(!cap_error.message.contains("one@example.test"));
        assert!(!cap_error.message.contains("two@example.test"));
    }

    #[tokio::test]
    async fn mask_backend_enforces_fk_and_sensitive_guards() {
        let mut input = mask_input(
            vec![mask_rule("source.children", "parent_id", "hash", None, None)],
            vec![],
        );
        input.tables.push(RefreshMaskTableInput {
            name: "source.children".into(),
            columns: vec![mask_column("parent_id", "varchar")],
            indexes: vec![],
        });
        input.rules[0].relation = Some("fk-parent:1".into());
        input.relations = vec![
            RefreshMaskRelationInput { relation: "fk-parent:1".into(), table: "source.parents".into(), column: "id".into() },
            RefreshMaskRelationInput { relation: "fk-parent:1".into(), table: "source.children".into(), column: "parent_id".into() },
        ];
        let error = refresh_mask_apply(input.clone()).await.expect_err("implicit preserve parent");
        assert!(error.message.contains("relational equality would break"));
        input.allow_fk_breaking = true;
        assert_eq!(refresh_mask_apply(input).await.unwrap().accepted_rows, 0);

        let mut sensitive = mask_input(vec![], vec![]);
        sensitive.acknowledge_unmasked_sensitive = false;
        let error = refresh_mask_apply(sensitive).await.expect_err("unacknowledged sensitive columns");
        assert!(error.message.contains("explicit acknowledgment"));
    }

    async fn refresh_live_node(args: &[String], input: Option<serde_json::Value>) -> serde_json::Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut command = tokio::process::Command::new("node");
        command
            .arg(root.join("dev/refresh_catalog_live.mjs"))
            .args(args)
            .current_dir(root)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if input.is_some() {
            command.stdin(std::process::Stdio::piped());
        }
        let mut child = command.spawn().unwrap();
        if let Some(input) = input {
            tokio::io::AsyncWriteExt::write_all(child.stdin.as_mut().unwrap(), input.to_string().as_bytes()).await.unwrap();
            drop(child.stdin.take());
        }
        let output = child.wait_with_output().await.unwrap();
        assert!(output.status.success(), "refresh live proof failed: {}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8 and node"]
    async fn dbctl_mysql_refresh_catalog_graph_and_compatibility() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(2).connect(&url).await.unwrap();
        let suffix = &Uuid::new_v4().simple().to_string()[..8];
        let source = format!("txui_refresh_source_{suffix}");
        let target = format!("txui_refresh_target_{suffix}");
        for schema in [&source, &target] {
            crate::db::mysql::execute(&pool, &format!("CREATE DATABASE `{schema}`")).await.unwrap();
            for sql in [
                "CREATE TABLE parents (id INT NOT NULL, seq INT NOT NULL, code VARCHAR(20) NOT NULL, computed VARCHAR(21) GENERATED ALWAYS AS (CONCAT(code,'!')) STORED, PRIMARY KEY(id,seq), UNIQUE KEY uq_code(code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE children (id INT PRIMARY KEY, parent_id INT NULL, parent_seq INT NOT NULL, self_parent INT NULL, created_on DATE NOT NULL, CONSTRAINT fk_composite FOREIGN KEY(parent_id,parent_seq) REFERENCES parents(id,seq), CONSTRAINT fk_self FOREIGN KEY(self_parent) REFERENCES children(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE cyc_a (id INT PRIMARY KEY, b_id INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE cyc_b (id INT PRIMARY KEY, a_id INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "ALTER TABLE cyc_a ADD CONSTRAINT fk_a_b FOREIGN KEY(b_id) REFERENCES cyc_b(id)",
                "ALTER TABLE cyc_b ADD CONSTRAINT fk_b_a FOREIGN KEY(a_id) REFERENCES cyc_a(id)",
                "CREATE TABLE no_key (id INT NOT NULL, note VARCHAR(40) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ] {
                let qualified = if sql.starts_with("CREATE TABLE ") {
                    sql.replacen("CREATE TABLE ", &format!("CREATE TABLE `{schema}`."), 1)
                } else {
                    sql.replacen("ALTER TABLE ", &format!("ALTER TABLE `{schema}`."), 1)
                };
                crate::db::mysql::execute(&pool, &qualified).await.unwrap();
            }
        }
        let request = refresh_live_node(&["--queries".into(), source.clone(), target.clone()], None).await;
        let mut grids = Vec::new();
        for query in request["queries"].as_array().unwrap() {
            let sql = query["sql"].as_str().unwrap();
            let result = crate::db::mysql::execute(&pool, sql).await.unwrap();
            assert!(!result.truncated, "catalog query was truncated: {sql}");
            grids.push(serde_json::json!({
                "sessionId": query["sessionId"],
                "sql": sql,
                "grid": {
                    "columns": result.columns.iter().map(|column| &column.name).collect::<Vec<_>>(),
                    "rows": result.rows,
                    "truncated": result.truncated,
                },
            }));
        }
        let evidence = refresh_live_node(&[], Some(serde_json::json!({
            "spec": request["spec"], "grids": grids,
        }))).await;
        assert_eq!(evidence["sourceTables"], 5);
        assert_eq!(evidence["targetTables"], 5);
        assert_eq!(evidence["foreignKeys"], 4);
        assert_eq!(evidence["selfReferences"], 1);
        assert_eq!(evidence["cycles"], 2);
        assert_eq!(evidence["generatedColumns"], 1);
        assert_eq!(evidence["missingKeyBlocked"], true);
        assert_eq!(evidence["incompatibleTargetBlocked"], true);
        assert_eq!(evidence["metadataQueries"], 12);
        assert_eq!(evidence["executionPlanExecutable"], true);
        let explain_sql = evidence["explainSql"].as_str().unwrap();
        assert!(!explain_sql.contains("OFFSET"));
        let explain = crate::db::mysql::execute(&pool, &format!("EXPLAIN {explain_sql}")).await.unwrap();
        assert!(!explain.rows.is_empty(), "EXPLAIN returned no plan rows");
        for schema in [&source, &target] {
            crate::db::mysql::execute(&pool, &format!("DROP DATABASE `{schema}`")).await.unwrap();
        }
        pool.close().await;
    }
}
