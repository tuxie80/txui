//! Turn Redis replies into a grid.
//!
//! Every command used to come back as ONE row with ONE column holding the
//! whole reply as JSON — readable for `GET key`, useless for anything a DBA
//! runs. `SLOWLOG GET` rendered as a single cell containing a nested array;
//! `CLIENT LIST` as one cell containing 40 clients' worth of text.
//!
//! Redis has no result metadata to lean on, so the shape has to be inferred:
//!
//!   * a few commands have a KNOWN structure worth naming properly
//!     (`SLOWLOG GET`, `CLIENT LIST`, `CONFIG GET`, `XINFO`, `MEMORY STATS`);
//!   * everything else falls back to generic shaping — a map becomes
//!     key/value rows, a flat array becomes one row per element, an array of
//!     equal-length arrays becomes a table.
//!
//! The fallback matters more than the special cases: it means a command this
//! module has never heard of — including a module command — still renders as
//! something you can sort, filter and export.

use serde_json::Value as J;

use super::types::{ColumnInfo, QueryResult};

fn col(name: &str) -> ColumnInfo {
    ColumnInfo { name: name.into(), type_name: "redis".into(), nullable: true }
}

fn result(columns: Vec<ColumnInfo>, rows: Vec<Vec<J>>, execution_ms: u64) -> QueryResult {
    QueryResult { columns, rows, rows_affected: None, execution_ms, fetch_ms: 0, warnings: vec![], truncated: false }
}

/// Command name in the "CONFIG GET" / "GET" form, uppercase.
fn head(args: &[String]) -> String {
    crate::redisguard::display_name(args)
}

/// Shape a decoded reply for `args`, falling back to generic structure
/// inference when the command is not specially handled.
pub fn shape(args: &[String], value: J, execution_ms: u64) -> QueryResult {
    match head(args).as_str() {
        "SLOWLOG GET"  => slowlog(value, execution_ms),
        "CLIENT LIST"  => client_list(value, execution_ms),
        "CONFIG GET"   => pairs(value, "parameter", "value", execution_ms),
        "MEMORY STATS" => pairs_from_map(value, "metric", "value", execution_ms),
        "XINFO STREAM" => pairs_from_map(value, "field", "value", execution_ms),
        "INFO"         => info_sections(value, execution_ms),
        _ => generic(value, execution_ms),
    }
}

/// `SLOWLOG GET` → one row per slow command.
/// Reply: [id, unix_ts, duration_us, [argv…], client_addr, client_name, …].
fn slowlog(v: J, ms: u64) -> QueryResult {
    let J::Array(entries) = v else { return generic(v, ms) };
    let cols = vec![col("id"), col("when"), col("duration_ms"), col("command"),
                    col("client"), col("client_name")];
    let mut rows = Vec::with_capacity(entries.len());
    for e in entries {
        let J::Array(f) = e else { continue };
        let micros = f.get(2).and_then(|x| x.as_i64()).unwrap_or(0);
        let cmd = match f.get(3) {
            Some(J::Array(argv)) => argv.iter()
                .map(|a| a.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>()
                .join(" "),
            other => other.map(|o| o.to_string()).unwrap_or_default(),
        };
        rows.push(vec![
            f.first().cloned().unwrap_or(J::Null),
            // Unix seconds are unreadable in a grid; render ISO local time.
            f.get(1).and_then(|t| t.as_i64())
                .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
                .map(|d| J::String(d.with_timezone(&chrono::Local)
                                    .format("%Y-%m-%d %H:%M:%S").to_string()))
                .unwrap_or(J::Null),
            // Microseconds → milliseconds, which is what a human compares.
            super::types::json_f64(micros as f64 / 1000.0),
            J::String(cmd),
            f.get(4).cloned().unwrap_or(J::Null),
            f.get(5).cloned().unwrap_or(J::Null),
        ]);
    }
    result(cols, rows, ms)
}

/// `CLIENT LIST` → one row per client.
/// Reply is a single text blob, one `k=v k=v …` line per client.
fn client_list(v: J, ms: u64) -> QueryResult {
    let text = match &v {
        J::String(s) => s.clone(),
        other => other.to_string(),
    };
    // Column order follows the field order of the first line, so the columns
    // a DBA looks at (id, addr, age, idle, cmd) stay at the left where Redis
    // put them, rather than being alphabetised.
    let mut names: Vec<String> = Vec::new();
    let mut parsed: Vec<Vec<(String, String)>> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let mut fields = Vec::new();
        for kv in line.split(' ') {
            if let Some((k, val)) = kv.split_once('=') {
                if !names.iter().any(|n| n == k) { names.push(k.to_string()); }
                fields.push((k.to_string(), val.to_string()));
            }
        }
        parsed.push(fields);
    }
    if names.is_empty() { return generic(v, ms); }

    let cols: Vec<ColumnInfo> = names.iter().map(|n| col(n)).collect();
    let rows = parsed.into_iter().map(|fields| {
        names.iter().map(|n| fields.iter()
            .find(|(k, _)| k == n)
            .map(|(_, val)| J::String(val.clone()))
            .unwrap_or(J::Null)).collect()
    }).collect();
    result(cols, rows, ms)
}

/// Flat `[k, v, k, v, …]` reply → two columns.
fn pairs(v: J, kname: &str, vname: &str, ms: u64) -> QueryResult {
    match v {
        J::Array(items) if items.len() % 2 == 0 => {
            let rows = items.chunks(2)
                .map(|c| vec![c[0].clone(), c[1].clone()])
                .collect();
            result(vec![col(kname), col(vname)], rows, ms)
        }
        // RESP3 servers return a map here instead.
        J::Object(_) => pairs_from_map(v, kname, vname, ms),
        other => generic(other, ms),
    }
}

/// Map reply → two columns, insertion order preserved.
fn pairs_from_map(v: J, kname: &str, vname: &str, ms: u64) -> QueryResult {
    match v {
        J::Object(map) => {
            let rows = map.into_iter()
                .map(|(k, val)| vec![J::String(k), val])
                .collect();
            result(vec![col(kname), col(vname)], rows, ms)
        }
        other => pairs(other, kname, vname, ms),
    }
}

/// `INFO` text → section / name / value.
fn info_sections(v: J, ms: u64) -> QueryResult {
    let J::String(text) = &v else { return generic(v, ms) };
    let mut section = String::new();
    let mut rows = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if let Some(name) = line.strip_prefix("# ") {
            section = name.trim().to_string();
            continue;
        }
        if let Some((k, val)) = line.split_once(':') {
            rows.push(vec![
                J::String(section.clone()),
                J::String(k.to_string()),
                J::String(val.to_string()),
            ]);
        }
    }
    if rows.is_empty() { return generic(v, ms); }
    result(vec![col("section"), col("name"), col("value")], rows, ms)
}

/// Structure inference for everything else.
///
/// This is what makes an unknown command — including a module command —
/// usable: it will still be a grid rather than a wall of JSON.
fn generic(v: J, ms: u64) -> QueryResult {
    match v {
        // Map → key/value rows.
        J::Object(map) => {
            let rows = map.into_iter().map(|(k, val)| vec![J::String(k), val]).collect();
            result(vec![col("field"), col("value")], rows, ms)
        }
        J::Array(items) => {
            if items.is_empty() {
                return result(vec![col("result")], vec![], ms);
            }
            // Array of equal-length arrays → a real table (SLOWLOG-like,
            // GEOPOS, ZRANGE WITHSCORES on RESP3, …).
            let inner_lens: Vec<usize> = items.iter()
                .filter_map(|i| match i { J::Array(a) => Some(a.len()), _ => None })
                .collect();
            if inner_lens.len() == items.len() && !inner_lens.is_empty() {
                let width = inner_lens[0];
                if width > 0 && inner_lens.iter().all(|&l| l == width) {
                    let cols = (0..width).map(|i| col(&format!("f{}", i + 1))).collect();
                    let rows = items.into_iter().map(|i| match i {
                        J::Array(a) => a,
                        other => vec![other],
                    }).collect();
                    return result(cols, rows, ms);
                }
            }
            // Flat array → one row per element, which is what SCAN / KEYS /
            // SMEMBERS / LRANGE return and what a user wants to scroll.
            let rows = items.into_iter().map(|i| vec![i]).collect();
            result(vec![col("value")], rows, ms)
        }
        // Scalar → a single cell, unchanged.
        other => result(vec![col("result")], vec![vec![other]], ms),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(v: &[&str]) -> Vec<String> { v.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn slowlog_becomes_one_row_per_entry() {
        // Previously: one cell containing the whole nested array.
        let v = json!([
            [1, 1786011819, 4200, ["GET", "user:1"], "127.0.0.1:57545", ""],
            [0, 1786011819, 6,    ["CONFIG", "SET", "x", "0"], "127.0.0.1:57544", "worker"]
        ]);
        let r = shape(&args(&["SLOWLOG", "GET"]), v, 1);
        assert_eq!(r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
                   vec!["id", "when", "duration_ms", "command", "client", "client_name"]);
        assert_eq!(r.rows.len(), 2);
        // argv is joined into a readable command line.
        assert_eq!(r.rows[0][3], json!("GET user:1"));
        assert_eq!(r.rows[1][3], json!("CONFIG SET x 0"));
        // Microseconds are converted — 4200µs is 4.2ms, not "4200".
        assert_eq!(r.rows[0][2], json!(4.2));
        // The timestamp is rendered, not left as a unix integer.
        assert!(r.rows[0][1].as_str().unwrap().starts_with("20"));
    }

    #[test]
    fn client_list_becomes_columns_in_server_order() {
        let text = "id=1 addr=10.0.0.1:5000 name=web age=30 cmd=get\n\
                    id=2 addr=10.0.0.2:5001 name= age=5 cmd=set";
        let r = shape(&args(&["CLIENT", "LIST"]), json!(text), 0);
        // Field order follows Redis, so id/addr stay leftmost rather than
        // being alphabetised into the middle.
        assert_eq!(r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
                   vec!["id", "addr", "name", "age", "cmd"]);
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][1], json!("10.0.0.1:5000"));
        assert_eq!(r.rows[1][2], json!(""));
    }

    #[test]
    fn client_list_tolerates_a_client_missing_a_field() {
        // Redis adds fields between versions; a row without one must not shift
        // every later column left.
        let text = "id=1 addr=a name=x cmd=get\nid=2 addr=b cmd=set";
        let r = shape(&args(&["CLIENT", "LIST"]), json!(text), 0);
        let name_idx = r.columns.iter().position(|c| c.name == "name").unwrap();
        let cmd_idx = r.columns.iter().position(|c| c.name == "cmd").unwrap();
        assert_eq!(r.rows[1][name_idx], json!(null), "missing field must be NULL");
        assert_eq!(r.rows[1][cmd_idx], json!("set"), "later columns must not shift");
    }

    #[test]
    fn config_get_pairs_up() {
        let r = shape(&args(&["CONFIG", "GET", "*"]),
                      json!(["maxmemory", "0", "appendonly", "no"]), 0);
        assert_eq!(r.columns.len(), 2);
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0], vec![json!("maxmemory"), json!("0")]);
    }

    #[test]
    fn info_splits_into_section_name_value() {
        let text = "# Server\nredis_version:8.10.0\nuptime_in_seconds:42\n\n# Clients\nconnected_clients:3";
        let r = shape(&args(&["INFO"]), json!(text), 0);
        assert_eq!(r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
                   vec!["section", "name", "value"]);
        assert_eq!(r.rows.len(), 3);
        assert_eq!(r.rows[0], vec![json!("Server"), json!("redis_version"), json!("8.10.0")]);
        assert_eq!(r.rows[2][0], json!("Clients"));
    }

    // ── Generic inference: what makes unknown commands usable ────────────

    #[test]
    fn flat_arrays_become_one_row_each() {
        // SCAN / SMEMBERS / LRANGE: a list you want to scroll and filter, not
        // a single cell holding 500 elements.
        let r = shape(&args(&["SMEMBERS", "tags"]), json!(["a", "b", "c"]), 0);
        assert_eq!(r.columns.len(), 1);
        assert_eq!(r.rows.len(), 3);
        assert_eq!(r.rows[1][0], json!("b"));
    }

    #[test]
    fn arrays_of_equal_arrays_become_a_table() {
        let r = shape(&args(&["GEOPOS", "cities"]), json!([["14.4", "50.0"], ["2.3", "48.8"]]), 0);
        assert_eq!(r.columns.len(), 2);
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][0], json!("14.4"));
    }

    #[test]
    fn ragged_arrays_stay_one_row_each() {
        // XRANGE returns [id, [field, value, …]] pairs of differing shape —
        // forcing them into columns would misalign the data.
        let r = shape(&args(&["XRANGE", "s", "-", "+"]),
                      json!([["1-0", ["a", "1"]], ["2-0", ["a", "1", "b", "2"]]]), 0);
        assert_eq!(r.columns.len(), 2, "outer pairs are still uniform width 2");
        assert_eq!(r.rows.len(), 2);
    }

    #[test]
    fn maps_become_field_value_rows() {
        let r = shape(&args(&["SOMEMODULE.CMD"]), json!({"a": 1, "b": "x"}), 0);
        assert_eq!(r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
                   vec!["field", "value"]);
        assert_eq!(r.rows.len(), 2);
    }

    #[test]
    fn scalars_stay_a_single_cell() {
        let r = shape(&args(&["GET", "k"]), json!("hello world"), 0);
        assert_eq!(r.columns.len(), 1);
        assert_eq!(r.rows, vec![vec![json!("hello world")]]);

        let n = shape(&args(&["DBSIZE"]), json!(1014), 0);
        assert_eq!(n.rows, vec![vec![json!(1014)]]);
    }

    #[test]
    fn empty_replies_produce_no_rows_not_a_null_row() {
        let r = shape(&args(&["KEYS", "nomatch*"]), json!([]), 0);
        assert_eq!(r.rows.len(), 0);
        assert_eq!(r.columns.len(), 1);
    }

    #[test]
    fn an_unknown_command_still_renders_as_a_grid() {
        // The point of the fallback: a module command nobody special-cased.
        let r = shape(&args(&["FT.SEARCH", "idx", "*"]),
                      json!([2, "doc:1", ["title", "a"], "doc:2", ["title", "b"]]), 0);
        assert!(r.rows.len() > 1, "must not collapse into one JSON cell");
    }
}
