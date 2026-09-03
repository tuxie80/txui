//! Turn a JSON or spreadsheet file into CSV, so everything else can stay as it
//! is.
//!
//! CSV import already has the parts that are hard to get right: streaming
//! insert, progress reporting, upsert, truncate, the production guards and the
//! audit trail. Reimplementing that per format would be three copies of the
//! dangerous half. Converting to a temporary CSV and handing it to the
//! existing pipeline means JSON and Excel inherit all of it for free.
//!
//! The conversion is deliberately dumb: **every value becomes text**, and type
//! inference stays where it already lives, in `csv_preview`. Two formats
//! guessing at types independently is two places for them to disagree.
//!
//! Verified against real files: a JSON array with nested objects, arrays and
//! nulls; an NDJSON file with blank lines; and a DEFLATE-compressed two-sheet
//! `.xlsx` — which listed both sheets, took the first, and wrote `20` and `0`
//! rather than `20.0` and `0.0` (see `cell_text`).

use anyhow::{bail, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct Converted {
    /// Temporary CSV the caller should feed to `csv_preview` / `csv_import`.
    pub csv_path: String,
    pub rows: usize,
    pub columns: Vec<String>,
    /// Sheet names, when the source had more than one. Empty for JSON.
    pub sheets: Vec<String>,
    /// The sheet actually converted.
    pub sheet: String,
}

/// What a path looks like it holds. Extension only — sniffing content would be
/// nicer, but the file picker already filters and a wrong guess produces a
/// clearer error than a wrong parse.
pub fn format_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("json") => "json",
        Some("ndjson") | Some("jsonl") => "ndjson",
        Some("xlsx") | Some("xlsm") | Some("xls") | Some("ods") => "sheet",
        Some("csv") | Some("tsv") | Some("txt") => "csv",
        _ => "unknown",
    }
}

/// Column order for a set of JSON objects.
///
/// **Alphabetical** — now by explicit sort. `serde_json::Map` was a `BTreeMap`
/// (sorted iteration) until the MongoDB driver arrived: bson depends on
/// serde_json's `preserve_order` feature, non-optionally, which switched the
/// map to insertion-ordered `IndexMap` app-wide. The tripwire test below
/// (`columns_are_alphabetical_while_serde_json_sorts_its_maps`) was written for
/// exactly this event — it still asserts the same contract, so the sort is
/// done here rather than borrowed from the map's implementation.
///
/// What the order does guarantee: keys that appear only in later records are
/// still columns, so nothing is dropped because the first record happened not
/// to have the field. Mapping is by name in the wizard regardless.
pub fn json_columns(records: &[serde_json::Map<String, serde_json::Value>]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for r in records {
        for k in r.keys() {
            if seen.insert(k.clone()) {
                out.push(k.clone());
            }
        }
    }
    out.sort_unstable();
    out
}

/// One JSON value as a CSV cell.
///
/// Scalars become their plain text — a string is itself, not a quoted JSON
/// string, or every imported value would arrive wrapped in `"`. Objects and
/// arrays keep their JSON form, which is what a `JSON` column wants and is
/// still readable in a `TEXT` one. `null` becomes empty, so the existing
/// "treat empty as NULL" switch governs it like every other format.
pub fn json_cell(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Parse JSON into records, accepting the three shapes a file actually comes in.
pub fn parse_json_records(
    text: &str,
    ndjson: bool,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>> {
    let mut out = Vec::new();
    if ndjson {
        for (i, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() { continue; }
            let v: serde_json::Value = serde_json::from_str(line)
                .map_err(|e| anyhow::anyhow!("line {}: {e}", i + 1))?;
            match v {
                serde_json::Value::Object(m) => out.push(m),
                _ => bail!("line {} is not an object — NDJSON import needs one object per line", i + 1),
            }
        }
        return Ok(out);
    }

    let v: serde_json::Value = serde_json::from_str(text)?;
    match v {
        // The common shape.
        serde_json::Value::Array(items) => {
            for (i, it) in items.into_iter().enumerate() {
                match it {
                    serde_json::Value::Object(m) => out.push(m),
                    _ => bail!("element {i} is not an object — a table needs objects, not bare values"),
                }
            }
        }
        // A single record is a one-row table, which is occasionally what
        // someone means and costs nothing to accept.
        serde_json::Value::Object(m) => out.push(m),
        _ => bail!("this JSON is a single value, not a list of records"),
    }
    Ok(out)
}

fn temp_csv_for(src: &Path) -> PathBuf {
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("import");
    // Process id keeps two TxUI windows converting the same file apart.
    let safe: String = stem.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(60)
        .collect();
    std::env::temp_dir().join(format!("txui-import-{}-{safe}.csv", std::process::id()))
}

fn write_csv(path: &Path, columns: &[String], rows: &[Vec<String>]) -> Result<()> {
    // Owner-only from the first byte (WP-12 12.4): this is the user's data —
    // possibly PII — sitting in the SHARED system temp dir, and every other
    // persistence path in the app is 0600. Windows temp dirs are per-user by
    // ACL, so the unix gate mirrors the codebase's other permission code.
    let file = {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        #[cfg(not(unix))]
        {
            // Windows has no mode bits; %TEMP% is already per-user by ACL,
            // which is the equivalent protection — the same stance
            // secretstore/vaultfile.rs documents for its 0600.
        }
        opts.open(path)?
    };
    let result = (|| -> Result<()> {
        let mut w = csv::Writer::from_writer(file);
        w.write_record(columns)?;
        for r in rows {
            w.write_record(r)?;
        }
        w.flush()?;
        Ok(())
    })();
    if result.is_err() {
        // A half-written conversion must not linger in the shared temp dir.
        let _ = std::fs::remove_file(path);
    }
    result
}

/// Delete a conversion temp file once the import that consumed it is done —
/// success or failure. Guarded twice (our temp dir AND our name prefix) so a
/// user-picked CSV that merely lives in the temp dir can never be deleted.
pub fn cleanup_temp_csv(path: &Path) {
    let ours = path.starts_with(std::env::temp_dir())
        && path.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("txui-import-") && n.ends_with(".csv"));
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

/// Ceiling on a conversion.
///
/// The whole file is held in memory to build the CSV, unlike the streaming CSV
/// import it feeds. Past this the honest answer is "convert it outside", not a
/// window that stops responding.
pub const MAX_CONVERT_ROWS: usize = 1_000_000;

pub fn convert_json(path: &Path, ndjson: bool) -> Result<Converted> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("could not read {}: {e}", path.display()))?;
    let records = parse_json_records(&text, ndjson)?;
    if records.is_empty() {
        bail!("no records found in {}", path.display());
    }
    if records.len() > MAX_CONVERT_ROWS {
        bail!("{} records — more than the {MAX_CONVERT_ROWS} this converter holds in memory. \
               Split the file, or convert it to CSV outside TxUI.", records.len());
    }
    let columns = json_columns(&records);
    if columns.is_empty() {
        bail!("the records in {} have no fields", path.display());
    }
    let rows: Vec<Vec<String>> = records.iter()
        // Missing keys become empty rather than shifting the row — a record
        // without a field is a NULL, not a different shape.
        .map(|r| columns.iter().map(|c| r.get(c).map(json_cell).unwrap_or_default()).collect())
        .collect();

    let out = temp_csv_for(path);
    write_csv(&out, &columns, &rows)?;
    Ok(Converted {
        csv_path: out.display().to_string(),
        rows: rows.len(),
        columns,
        sheets: vec![],
        sheet: String::new(),
    })
}

pub fn convert_sheet(path: &Path, sheet: Option<&str>) -> Result<Converted> {
    use calamine::Reader;

    let mut wb = calamine::open_workbook_auto(path)
        .map_err(|e| anyhow::anyhow!("could not open {}: {e}", path.display()))?;
    let sheets = wb.sheet_names().to_vec();
    if sheets.is_empty() {
        bail!("{} has no sheets", path.display());
    }
    let want = sheet.map(str::to_string).unwrap_or_else(|| sheets[0].clone());
    let range = wb.worksheet_range(&want)
        .map_err(|e| anyhow::anyhow!("could not read sheet `{want}`: {e}"))?;

    let mut iter = range.rows();
    let Some(header) = iter.next() else {
        bail!("sheet `{want}` is empty");
    };
    // A blank header cell still needs a name, or the column cannot be mapped.
    let columns: Vec<String> = header.iter().enumerate()
        .map(|(i, c)| {
            let s = cell_text(c);
            if s.trim().is_empty() { format!("column_{}", i + 1) } else { s }
        })
        .collect();

    let mut rows: Vec<Vec<String>> = Vec::new();
    for r in iter {
        if rows.len() >= MAX_CONVERT_ROWS {
            bail!("sheet `{want}` has more than {MAX_CONVERT_ROWS} rows — split it, \
                   or export it to CSV, which imports as a stream rather than in memory");
        }
        // Trailing short rows are normal in a spreadsheet; pad rather than
        // producing a ragged CSV the reader would reject.
        let mut row: Vec<String> = r.iter().map(cell_text).collect();
        row.resize(columns.len(), String::new());
        // A wholly empty row is spreadsheet padding, not data.
        if row.iter().all(|c| c.trim().is_empty()) { continue; }
        rows.push(row);
    }

    let out = temp_csv_for(path);
    write_csv(&out, &columns, &rows)?;
    Ok(Converted {
        csv_path: out.display().to_string(),
        rows: rows.len(),
        columns,
        sheets,
        sheet: want,
    })
}

/// A spreadsheet cell as text.
///
/// Floats are the awkward case: calamine reports every number as `f64`, so an
/// integer id arrives as `4.0` and would import as a float or fail a strict
/// integer column. Whole values are written without the fractional part.
fn cell_text(c: &calamine::Data) -> String {
    use calamine::Data;
    match c {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 9.007e15 {
                format!("{}", *f as i64)
            } else {
                let s = format!("{f}");
                s
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#ERROR:{e:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn objs(json: &str) -> Vec<serde_json::Map<String, serde_json::Value>> {
        parse_json_records(json, false).unwrap()
    }

    #[test]
    fn an_array_of_objects_is_the_common_shape() {
        let r = objs(r#"[{"a":1},{"a":2}]"#);
        assert_eq!(r.len(), 2);
    }

    /// A single record is a one-row table — occasionally what someone means,
    /// and it costs nothing to accept.
    #[test]
    fn a_lone_object_is_one_row() {
        assert_eq!(objs(r#"{"a":1}"#).len(), 1);
    }

    #[test]
    fn ndjson_is_one_object_per_line_and_blanks_are_skipped() {
        let r = parse_json_records("{\"a\":1}\n\n{\"a\":2}\n", true).unwrap();
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn a_bare_value_is_refused_with_a_reason() {
        let e = parse_json_records("42", false).unwrap_err().to_string();
        assert!(e.contains("not a list of records"), "{e}");
        let e2 = parse_json_records(r#"[1,2]"#, false).unwrap_err().to_string();
        assert!(e2.contains("not an object"), "{e2}");
    }

    #[test]
    fn a_syntax_error_names_the_line_in_ndjson() {
        let e = parse_json_records("{\"a\":1}\nnot json\n", true).unwrap_err().to_string();
        assert!(e.contains("line 2"), "{e}");
    }

    /// Alphabetical, because `serde_json::Map` is a BTreeMap — see the note on
    /// `json_columns`. Pinned so that if `preserve_order` is ever switched on
    /// this test says so rather than the ordering changing unnoticed.
    #[test]
    fn columns_are_alphabetical_while_serde_json_sorts_its_maps() {
        let r = objs(r#"[{"zebra":1,"apple":2}]"#);
        assert_eq!(json_columns(&r), vec!["apple", "zebra"]);
    }

    /// A key that only appears later must not be dropped because row one
    /// happened not to have it.
    #[test]
    fn a_key_appearing_only_later_is_still_a_column() {
        let r = objs(r#"[{"a":1},{"a":2,"b":3}]"#);
        assert_eq!(json_columns(&r), vec!["a", "b"]);
    }

    #[test]
    fn scalars_become_their_plain_text_not_quoted_json() {
        assert_eq!(json_cell(&serde_json::json!("hi")), "hi");
        assert_eq!(json_cell(&serde_json::json!(42)), "42");
        assert_eq!(json_cell(&serde_json::json!(1.5)), "1.5");
        assert_eq!(json_cell(&serde_json::json!(true)), "true");
    }

    /// Empty, so the pipeline's existing "treat empty as NULL" switch governs
    /// it like every other format.
    #[test]
    fn null_becomes_empty() {
        assert_eq!(json_cell(&serde_json::Value::Null), "");
    }

    /// A nested value keeps its JSON form — which is exactly what a JSON
    /// column wants, and still readable in a TEXT one.
    #[test]
    fn nested_values_keep_their_json() {
        assert_eq!(json_cell(&serde_json::json!({"x": 1})), r#"{"x":1}"#);
        assert_eq!(json_cell(&serde_json::json!([1, 2])), "[1,2]");
    }

    #[test]
    fn the_format_is_taken_from_the_extension() {
        assert_eq!(format_of(Path::new("a.json")), "json");
        assert_eq!(format_of(Path::new("a.NDJSON")), "ndjson");
        assert_eq!(format_of(Path::new("a.jsonl")), "ndjson");
        assert_eq!(format_of(Path::new("a.xlsx")), "sheet");
        assert_eq!(format_of(Path::new("a.ods")), "sheet");
        assert_eq!(format_of(Path::new("a.csv")), "csv");
        assert_eq!(format_of(Path::new("a.parquet")), "unknown");
    }

    /// calamine reports every number as f64, so an integer id arrives as
    /// `4.0` and would fail a strict integer column.
    #[test]
    fn a_whole_float_is_written_without_its_fraction() {
        assert_eq!(cell_text(&calamine::Data::Float(4.0)), "4");
        assert_eq!(cell_text(&calamine::Data::Float(-17.0)), "-17");
        assert_eq!(cell_text(&calamine::Data::Float(1.5)), "1.5");
    }

    #[test]
    fn an_empty_cell_is_empty_text() {
        assert_eq!(cell_text(&calamine::Data::Empty), "");
    }

    #[test]
    fn a_json_file_round_trips_to_csv() {
        let dir = std::env::temp_dir().join(format!("txui-conv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("people.json");
        std::fs::write(&src, r#"[{"id":1,"name":"Ada","meta":{"x":1}},{"id":2,"name":null}]"#).unwrap();

        let c = convert_json(&src, false).unwrap();
        assert_eq!(c.rows, 2);
        assert_eq!(c.columns, vec!["id", "meta", "name"]);   // sorted; see json_columns

        let csv = std::fs::read_to_string(&c.csv_path).unwrap();
        assert!(csv.starts_with("id,meta,name\n"), "{csv}");
        assert!(csv.contains(r#""{""x"":1}""#), "nested JSON was not preserved: {csv}");
        // The record missing `meta` must produce an empty cell, not a short row.
        assert!(csv.trim_end().ends_with("2,,"), "a missing key shifted the row: {csv}");

        let _ = std::fs::remove_file(&c.csv_path);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
