//! TxShell, headless.
//!
//! The GUI shell is a TypeScript module; this is the subset of it that a cron
//! job can run. Two parsers for one language is normally a mistake, so the
//! shape of this module is chosen to make the mistake detectable rather than
//! to pretend it does not exist:
//!
//!   - The verb registry here is data, exactly as it is in
//!     `src/utils/txShellGrammar.ts`.
//!   - Every verb the TypeScript registry knows is either implemented here or
//!     listed in [`UNSUPPORTED`] **with a reason**.
//!   - A conformance test reads the TypeScript file and fails if a verb exists
//!     there and is neither implemented nor excused here.
//!
//! So the two registries cannot drift silently. Adding `pivot` to the GUI
//! breaks `cargo test` until somebody decides whether a cron job should have
//! it — which is the decision that would otherwise be forgotten.
//!
//! What is deliberately absent: everything that needs a screen or a session
//! the user can switch. A headless `chart` has nowhere to draw.

use serde_json::Value;

use crate::db::types::{ColumnInfo, QueryResult};

/// The pipeline operator, identical to the GUI's.
///
/// `|>` cannot occur in SQL — `|` is bitwise-or, `>` is greater-than, and no
/// expression puts them adjacent — which is the rule that lets a line be read
/// exactly one way with no mode to disambiguate it.
pub const PIPE: &str = "|>";

/// What a verb does to the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerbKind {
    /// Transforms a result set.
    Stage,
    /// Consumes one.
    Sink,
    /// Produces one.
    Source,
}

#[derive(Debug, Clone, Copy)]
pub struct VerbSpec {
    pub name:     &'static str,
    pub kind:     VerbKind,
    pub min_args: usize,
    /// `None` = unlimited.
    pub max_args: Option<usize>,
    pub usage:    &'static str,
}

/// The verbs a headless run supports.
pub const VERBS: &[VerbSpec] = &[
    VerbSpec { name: "where",    kind: VerbKind::Stage,  min_args: 1, max_args: None,    usage: "where <column> <op> <value>" },
    VerbSpec { name: "select",   kind: VerbKind::Stage,  min_args: 1, max_args: None,    usage: "select <col> [col…]" },
    VerbSpec { name: "sort",     kind: VerbKind::Stage,  min_args: 1, max_args: Some(2), usage: "sort <column> [desc]" },
    VerbSpec { name: "head",     kind: VerbKind::Stage,  min_args: 1, max_args: Some(1), usage: "head <n>" },
    VerbSpec { name: "tail",     kind: VerbKind::Stage,  min_args: 1, max_args: Some(1), usage: "tail <n>" },
    VerbSpec { name: "count",    kind: VerbKind::Stage,  min_args: 0, max_args: Some(0), usage: "count" },
    VerbSpec { name: "stats",    kind: VerbKind::Stage,  min_args: 0, max_args: Some(1), usage: "stats [column]" },
    VerbSpec { name: "distinct", kind: VerbKind::Stage,  min_args: 0, max_args: None,    usage: "distinct [col…]" },
    VerbSpec { name: "save",     kind: VerbKind::Sink,   min_args: 1, max_args: Some(1), usage: "save <file>" },
    VerbSpec { name: "append",   kind: VerbKind::Sink,   min_args: 1, max_args: Some(1), usage: "append <file>" },
    VerbSpec { name: "to",       kind: VerbKind::Sink,   min_args: 1, max_args: Some(1), usage: "to <csv|tsv|json|md>" },
    VerbSpec { name: "from",     kind: VerbKind::Source, min_args: 1, max_args: Some(1), usage: "from <file>" },
];

/// Verbs the GUI has that a headless run deliberately does not.
///
/// The reason is the point of the list. Without it the conformance test could
/// be silenced by adding a name, which would make it worthless.
pub const UNSUPPORTED: &[(&str, &str)] = &[
    ("chart", "draws into the GUI's chart view; a cron job has no canvas"),
    ("grid", "shows the GUI's result grid; headless output goes to --out or stdout"),
    (
        "insert",
        "writes rows into a table, optionally on a second connection. Headless \
         it would be a scheduled cross-server write with no one watching, so it \
         stays a decision made in front of the grid.",
    ),
];

pub fn find_verb(name: &str) -> Option<&'static VerbSpec> {
    let lower = name.to_ascii_lowercase();
    VERBS.iter().find(|v| v.name == lower)
}

pub fn unsupported_reason(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    UNSUPPORTED.iter().find(|(n, _)| *n == lower).map(|(_, r)| *r)
}

// ── parsing ──────────────────────────────────────────────────────────────────

/// Split a line on `|>` — but not inside quotes.
///
/// The head is SQL (or a `from` source); the tail is verbs. Quote-awareness
/// matters because a literal `'a |> b'` is data, not a pipeline boundary.
pub fn split_pipeline(line: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let bytes: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                cur.push(c);
                // Doubled quote inside a quoted string is an escaped quote.
                if c == q {
                    if bytes.get(i + 1) == Some(&q) {
                        cur.push(q);
                        i += 1;
                    } else {
                        quote = None;
                    }
                }
            }
            None => {
                if c == '\'' || c == '"' || c == '`' {
                    quote = Some(c);
                    cur.push(c);
                } else if c == '|' && bytes.get(i + 1) == Some(&'>') {
                    parts.push(cur.trim().to_string());
                    cur.clear();
                    i += 1;
                } else {
                    cur.push(c);
                }
            }
        }
        i += 1;
    }
    parts.push(cur.trim().to_string());
    parts
}

/// Split a stage into words, respecting quotes and stripping them.
pub fn tokenize(stage: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut had_quote = false;
    for c in stage.chars() {
        match quote {
            Some(q) if c == q => {
                quote = None;
            }
            Some(_) => cur.push(c),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                had_quote = true;
            }
            None if c.is_whitespace() => {
                if !cur.is_empty() || had_quote {
                    out.push(std::mem::take(&mut cur));
                    had_quote = false;
                }
            }
            None => cur.push(c),
        }
    }
    if !cur.is_empty() || had_quote {
        out.push(cur);
    }
    out
}

/// Check a stage's verb and arity before anything runs.
pub fn validate_stage(stage: &str) -> Result<(), String> {
    let toks = tokenize(stage);
    let Some(name) = toks.first() else {
        return Err("empty pipeline stage".into());
    };
    if let Some(reason) = unsupported_reason(name) {
        return Err(format!("`{name}` is a GUI-only verb: {reason}"));
    }
    let Some(spec) = find_verb(name) else {
        return Err(format!("unknown verb `{name}`"));
    };
    let n = toks.len() - 1;
    if n < spec.min_args {
        return Err(format!("`{name}` needs at least {} argument(s): {}", spec.min_args, spec.usage));
    }
    if let Some(max) = spec.max_args {
        if n > max {
            return Err(format!("`{name}` takes at most {max} argument(s): {}", spec.usage));
        }
    }
    Ok(())
}

// ── execution ────────────────────────────────────────────────────────────────

fn col_index(r: &QueryResult, name: &str) -> Option<usize> {
    r.columns.iter().position(|c| c.name.eq_ignore_ascii_case(name))
}

/// Render a cell the way a comparison should see it.
fn as_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn as_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// Apply one stage to a result set.
///
/// Sinks and sources are not handled here — they are I/O, and the caller owns
/// where bytes come from and go to.
pub fn apply_stage(r: QueryResult, stage: &str) -> Result<QueryResult, String> {
    validate_stage(stage)?;
    let toks = tokenize(stage);
    let name = toks[0].to_ascii_lowercase();
    let args = &toks[1..];

    match name.as_str() {
        "where" => {
            if args.len() < 3 {
                return Err("where <column> <op> <value>".into());
            }
            let idx = col_index(&r, &args[0])
                .ok_or_else(|| format!("no column `{}`", args[0]))?;
            let op = args[1].to_ascii_lowercase();
            let rhs = args[2..].join(" ");
            let mut out = r;
            let rows = std::mem::take(&mut out.rows);
            out.rows = rows
                .into_iter()
                .filter(|row| {
                    let cell = row.get(idx).unwrap_or(&Value::Null);
                    compare(cell, &op, &rhs)
                })
                .collect();
            Ok(out)
        }
        "select" => {
            let idxs: Result<Vec<usize>, String> = args
                .iter()
                .map(|a| col_index(&r, a).ok_or_else(|| format!("no column `{a}`")))
                .collect();
            let idxs = idxs?;
            let columns: Vec<ColumnInfo> = idxs.iter().map(|&i| r.columns[i].clone()).collect();
            let rows = r
                .rows
                .iter()
                .map(|row| idxs.iter().map(|&i| row.get(i).cloned().unwrap_or(Value::Null)).collect())
                .collect();
            Ok(QueryResult { columns, rows, ..r })
        }
        "sort" => {
            let idx = col_index(&r, &args[0])
                .ok_or_else(|| format!("no column `{}`", args[0]))?;
            let desc = args.get(1).map(|s| s.eq_ignore_ascii_case("desc")).unwrap_or(false);
            let mut out = r;
            out.rows.sort_by(|a, b| {
                let (x, y) = (a.get(idx).unwrap_or(&Value::Null), b.get(idx).unwrap_or(&Value::Null));
                // Numbers compare as numbers; a numeric column sorted as text
                // puts 10 before 9, which is the classic wrong answer.
                let ord = match (as_number(x), as_number(y)) {
                    (Some(p), Some(q)) => p.partial_cmp(&q).unwrap_or(std::cmp::Ordering::Equal),
                    _ => as_text(x).cmp(&as_text(y)),
                };
                if desc { ord.reverse() } else { ord }
            });
            Ok(out)
        }
        "head" => {
            let n: usize = args[0].parse().map_err(|_| format!("`{}` is not a number", args[0]))?;
            let mut out = r;
            out.rows.truncate(n);
            Ok(out)
        }
        "tail" => {
            let n: usize = args[0].parse().map_err(|_| format!("`{}` is not a number", args[0]))?;
            let mut out = r;
            let skip = out.rows.len().saturating_sub(n);
            out.rows = out.rows.split_off(skip);
            Ok(out)
        }
        "count" => {
            let n = r.rows.len();
            Ok(QueryResult {
                columns: vec![ColumnInfo { name: "count".into(), type_name: "bigint".into(), nullable: false }],
                rows: vec![vec![Value::from(n)]],
                ..r
            })
        }
        "distinct" => {
            let idxs: Vec<usize> = if args.is_empty() {
                (0..r.columns.len()).collect()
            } else {
                args.iter()
                    .map(|a| col_index(&r, a).ok_or_else(|| format!("no column `{a}`")))
                    .collect::<Result<_, _>>()?
            };
            let mut seen = std::collections::HashSet::new();
            let mut out = r;
            let rows = std::mem::take(&mut out.rows);
            out.rows = rows
                .into_iter()
                .filter(|row| {
                    let key: Vec<String> =
                        idxs.iter().map(|&i| as_text(row.get(i).unwrap_or(&Value::Null))).collect();
                    seen.insert(key)
                })
                .collect();
            Ok(out)
        }
        "stats" => {
            let targets: Vec<usize> = match args.first() {
                Some(a) => vec![col_index(&r, a).ok_or_else(|| format!("no column `{a}`"))?],
                // No column named: every column whose values are numeric.
                None => (0..r.columns.len())
                    .filter(|&i| r.rows.iter().any(|row| as_number(row.get(i).unwrap_or(&Value::Null)).is_some()))
                    .collect(),
            };
            let columns = vec![
                ColumnInfo { name: "column".into(), type_name: "text".into(), nullable: false },
                ColumnInfo { name: "count".into(), type_name: "bigint".into(), nullable: false },
                ColumnInfo { name: "sum".into(), type_name: "double".into(), nullable: true },
                ColumnInfo { name: "avg".into(), type_name: "double".into(), nullable: true },
                ColumnInfo { name: "min".into(), type_name: "double".into(), nullable: true },
                ColumnInfo { name: "max".into(), type_name: "double".into(), nullable: true },
            ];
            let rows = targets
                .into_iter()
                .map(|i| {
                    let nums: Vec<f64> = r
                        .rows
                        .iter()
                        .filter_map(|row| as_number(row.get(i).unwrap_or(&Value::Null)))
                        .collect();
                    let n = nums.len();
                    let sum: f64 = nums.iter().sum();
                    // A NaN or infinity has no JSON representation; null is the honest
                    // answer rather than a silently coerced 0. A whole number stays
                    // whole, so a sum over integers does not come back as `429.0`.
                    let json = |x: Option<f64>| match x {
                        Some(v) if v.fract() == 0.0 && v.abs() < 9.0e15 => Value::from(v as i64),
                        Some(v) => serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null),
                        None => Value::Null,
                    };
                    vec![
                        Value::String(r.columns[i].name.clone()),
                        Value::from(n),
                        json((n > 0).then_some(sum)),
                        json((n > 0).then(|| sum / n as f64)),
                        json(nums.iter().cloned().fold(None, |a: Option<f64>, x| Some(a.map_or(x, |m| m.min(x))))),
                        json(nums.iter().cloned().fold(None, |a: Option<f64>, x| Some(a.map_or(x, |m| m.max(x))))),
                    ]
                })
                .collect();
            Ok(QueryResult { columns, rows, ..r })
        }
        other => Err(format!("`{other}` is not a stage")),
    }
}

fn compare(cell: &Value, op: &str, rhs: &str) -> bool {
    // `is null` / `is not null` read the cell, not its rendering — an empty
    // string is not NULL, and conflating them is how a row survives a filter
    // it should not.
    if op == "is" {
        let want_null = rhs.trim().eq_ignore_ascii_case("null");
        let want_not = rhs.trim().to_ascii_lowercase().starts_with("not");
        let is_null = cell.is_null();
        return if want_not { !is_null } else if want_null { is_null } else { false };
    }
    if op == "in" {
        let set: Vec<String> = rhs
            .trim_matches(|c| c == '(' || c == ')')
            .split(',')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .collect();
        return set.iter().any(|s| s == &as_text(cell));
    }
    if op == "like" || op == "ilike" {
        let text = as_text(cell);
        let (hay, pat) = if op == "ilike" {
            (text.to_lowercase(), rhs.to_lowercase())
        } else {
            (text, rhs.to_string())
        };
        return like_match(&hay, &pat);
    }
    // Numeric where both sides are numbers, text otherwise — so `total > 100`
    // on a numeric column compares numbers rather than rendered strings.
    match (as_number(cell), rhs.trim().parse::<f64>()) {
        (Some(a), Ok(b)) => match op {
            "=" | "==" => a == b,
            "!=" | "<>" => a != b,
            "<" => a < b,
            "<=" => a <= b,
            ">" => a > b,
            ">=" => a >= b,
            _ => false,
        },
        _ => {
            let a = as_text(cell);
            let b = rhs.trim().trim_matches('\'');
            match op {
                "=" | "==" => a == b,
                "!=" | "<>" => a != b,
                "<" => a.as_str() < b,
                "<=" => a.as_str() <= b,
                ">" => a.as_str() > b,
                ">=" => a.as_str() >= b,
                _ => false,
            }
        }
    }
}

/// SQL `LIKE`: `%` is any run, `_` is one character.
fn like_match(text: &str, pat: &str) -> bool {
    let t: Vec<char> = text.chars().collect();
    let p: Vec<char> = pat.chars().collect();
    // Iterative backtracking rather than recursion: `%%%%%%…` against a long
    // string is a stack overflow in the recursive form.
    let (mut ti, mut pi) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '_' || p[pi] == t[ti]) {
            ti += 1;
            pi += 1;
        } else if pi < p.len() && p[pi] == '%' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '%' {
        pi += 1;
    }
    pi == p.len()
}

// ── sources ──────────────────────────────────────────────────────────────────

/// Read a `.csv` / `.tsv` / `.json` file as a result set.
///
/// The point of `from` is that the same pipeline works on files and on queries
/// alike — a scheduled diff between yesterday's export and today's query needs
/// both sides to be the same kind of thing.
pub fn read_source(path: &str) -> Result<QueryResult, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "json" => parse_json(&text),
        "tsv" => Ok(parse_delimited(&text, '\t')),
        "csv" => Ok(parse_delimited(&text, ',')),
        other => Err(format!("cannot read `.{other}` — from reads .csv, .tsv or .json")),
    }
}

fn empty_result(columns: Vec<ColumnInfo>, rows: Vec<Vec<Value>>) -> QueryResult {
    QueryResult {
        columns,
        rows,
        rows_affected: None,
        execution_ms: 0,
        fetch_ms: 0,
        warnings: Vec::new(),
        truncated: false,
    }
}

/// RFC 4180 delimited text: quoted fields may contain the separator, a newline,
/// and doubled quotes.
pub fn parse_delimited(text: &str, sep: char) -> QueryResult {
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    cur.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' && cur.is_empty() {
            quoted = true;
        } else if c == sep {
            row.push(std::mem::take(&mut cur));
        } else if c == '\n' {
            row.push(std::mem::take(&mut cur));
            records.push(std::mem::take(&mut row));
        } else if c != '\r' {
            cur.push(c);
        }
        i += 1;
    }
    if !cur.is_empty() || !row.is_empty() {
        row.push(cur);
        records.push(row);
    }
    if records.is_empty() {
        return empty_result(Vec::new(), Vec::new());
    }
    let header = records.remove(0);
    let columns: Vec<ColumnInfo> = header
        .iter()
        .map(|h| ColumnInfo { name: h.clone(), type_name: "text".into(), nullable: true })
        .collect();
    // Values are typed on the way in, so `where total > 100` on a file compares
    // numbers — the same as it would on a query. Text in, text out otherwise.
    let rows = records
        .into_iter()
        .map(|r| {
            (0..columns.len())
                .map(|i| match r.get(i) {
                    None => Value::Null,
                    Some(v) if v.is_empty() => Value::Null,
                    // Integers stay integers. Parsing everything as f64 renders
                    // an id of 1 as `1.0`, so save → from → save would not
                    // round-trip and a joined key would stop matching.
                    Some(v) => v
                        .parse::<i64>()
                        .map(Value::from)
                        .ok()
                        .or_else(|| {
                            v.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map(Value::Number)
                        })
                        .unwrap_or_else(|| Value::String(v.clone())),
                })
                .collect()
        })
        .collect();
    empty_result(columns, rows)
}

fn parse_json(text: &str) -> Result<QueryResult, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))?;
    let arr = v.as_array().ok_or("JSON source must be an array of objects")?;
    // Union of keys in first-seen order: an array whose objects have different
    // shapes still produces one rectangular result rather than losing columns.
    let mut names: Vec<String> = Vec::new();
    for item in arr {
        if let Some(o) = item.as_object() {
            for k in o.keys() {
                if !names.iter().any(|n| n == k) {
                    names.push(k.clone());
                }
            }
        }
    }
    let columns: Vec<ColumnInfo> = names
        .iter()
        .map(|n| ColumnInfo { name: n.clone(), type_name: "json".into(), nullable: true })
        .collect();
    let rows = arr
        .iter()
        .map(|item| {
            names
                .iter()
                .map(|n| item.get(n).cloned().unwrap_or(Value::Null))
                .collect()
        })
        .collect();
    Ok(empty_result(columns, rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qr(cols: &[&str], rows: Vec<Vec<Value>>) -> QueryResult {
        QueryResult {
            columns: cols
                .iter()
                .map(|c| ColumnInfo { name: (*c).into(), type_name: "text".into(), nullable: true })
                .collect(),
            rows,
            rows_affected: None,
            execution_ms: 0,
            fetch_ms: 0,
            warnings: Vec::new(),
            truncated: false,
        }
    }

    fn sample() -> QueryResult {
        qr(
            &["id", "name", "total"],
            vec![
                vec![Value::from(1), Value::from("alice"), Value::from(9)],
                vec![Value::from(2), Value::from("bob"), Value::from(120)],
                vec![Value::from(3), Value::from("carol"), Value::Null],
            ],
        )
    }

    // ── the rule that makes the shell unambiguous ───────────────────────────

    #[test]
    fn the_pipe_is_two_characters_that_cannot_occur_in_sql() {
        assert_eq!(PIPE, "|>");
    }

    #[test]
    fn a_bare_pipe_is_not_a_pipeline_boundary() {
        // `a | b` is bitwise-or and stays SQL's.
        let parts = split_pipeline("SELECT a | b FROM t");
        assert_eq!(parts.len(), 1);
    }

    #[test]
    fn a_pipe_inside_quotes_is_data() {
        let parts = split_pipeline("SELECT 'x |> y' FROM t |> count");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], "SELECT 'x |> y' FROM t");
        assert_eq!(parts[1], "count");
    }

    #[test]
    fn a_doubled_quote_does_not_end_the_string() {
        let parts = split_pipeline("SELECT 'it''s |> fine' |> count");
        assert_eq!(parts.len(), 2);
    }

    // ── arity, checked before anything runs ─────────────────────────────────

    #[test]
    fn an_unknown_verb_is_rejected() {
        assert!(validate_stage("pivot x").unwrap_err().contains("unknown verb"));
    }

    #[test]
    fn a_gui_only_verb_says_why_rather_than_unknown() {
        // "unknown verb chart" would send someone looking for a typo.
        let e = validate_stage("chart bar").unwrap_err();
        assert!(e.contains("GUI-only"), "{e}");
        assert!(e.contains("canvas"), "{e}");
    }

    #[test]
    fn arity_is_enforced_both_ways() {
        assert!(validate_stage("head").is_err());
        assert!(validate_stage("count 1").is_err());
        assert!(validate_stage("head 5").is_ok());
    }

    // ── stages ──────────────────────────────────────────────────────────────

    #[test]
    fn where_compares_numbers_as_numbers() {
        // Rendered as text, "9" > "120" — the classic wrong answer.
        let r = apply_stage(sample(), "where total > 100").unwrap();
        assert_eq!(r.rows.len(), 1);
        assert_eq!(r.rows[0][1], Value::from("bob"));
    }

    #[test]
    fn where_is_null_distinguishes_null_from_empty() {
        let r = apply_stage(sample(), "where total is null").unwrap();
        assert_eq!(r.rows.len(), 1);
        assert_eq!(r.rows[0][1], Value::from("carol"));
        let r = apply_stage(sample(), "where total is not null").unwrap();
        assert_eq!(r.rows.len(), 2);
    }

    #[test]
    fn where_like_understands_percent_and_underscore() {
        let r = apply_stage(sample(), "where name like a%").unwrap();
        assert_eq!(r.rows.len(), 1);
        let r = apply_stage(sample(), "where name like b_b").unwrap();
        assert_eq!(r.rows.len(), 1);
    }

    #[test]
    fn like_does_not_blow_the_stack_on_many_wildcards() {
        let pat = "%".repeat(200) + "z";
        assert!(!like_match(&"a".repeat(500), &pat));
    }

    #[test]
    fn where_on_a_missing_column_is_an_error_not_an_empty_result() {
        // Silently returning nothing would read as "no rows match".
        assert!(apply_stage(sample(), "where nope = 1").is_err());
    }

    #[test]
    fn select_reorders_and_narrows() {
        let r = apply_stage(sample(), "select total name").unwrap();
        assert_eq!(r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["total", "name"]);
        assert_eq!(r.rows[0][1], Value::from("alice"));
    }

    #[test]
    fn sort_orders_numerically_when_it_can() {
        let r = apply_stage(sample(), "sort total desc").unwrap();
        assert_eq!(r.rows[0][2], Value::from(120));
    }

    #[test]
    fn head_and_tail_take_from_the_right_ends() {
        assert_eq!(apply_stage(sample(), "head 1").unwrap().rows[0][0], Value::from(1));
        assert_eq!(apply_stage(sample(), "tail 1").unwrap().rows[0][0], Value::from(3));
        // More than there are is not an error.
        assert_eq!(apply_stage(sample(), "tail 99").unwrap().rows.len(), 3);
    }

    #[test]
    fn count_replaces_the_rows() {
        let r = apply_stage(sample(), "count").unwrap();
        assert_eq!(r.columns.len(), 1);
        assert_eq!(r.rows[0][0], Value::from(3));
    }

    #[test]
    fn distinct_dedupes_on_the_named_columns_only() {
        let d = qr(
            &["a", "b"],
            vec![
                vec![Value::from(1), Value::from("x")],
                vec![Value::from(1), Value::from("y")],
            ],
        );
        assert_eq!(apply_stage(d.clone(), "distinct").unwrap().rows.len(), 2);
        assert_eq!(apply_stage(d, "distinct a").unwrap().rows.len(), 1);
    }

    #[test]
    fn stats_ignores_nulls_and_non_numbers() {
        let r = apply_stage(sample(), "stats total").unwrap();
        assert_eq!(r.rows.len(), 1);
        assert_eq!(r.rows[0][1], Value::from(2)); // count of NUMBERS, not rows
        assert_eq!(r.rows[0][2], Value::from(129)); // whole sum stays whole
    }

    #[test]
    fn stats_with_no_column_picks_the_numeric_ones() {
        let r = apply_stage(sample(), "stats").unwrap();
        let named: Vec<String> = r.rows.iter().map(|row| as_text(&row[0])).collect();
        assert!(named.contains(&"total".to_string()));
        assert!(!named.contains(&"name".to_string()));
    }

    // ── tokenizing ──────────────────────────────────────────────────────────

    // ── sources ─────────────────────────────────────────────────────────────

    #[test]
    fn csv_numbers_arrive_as_numbers() {
        // Otherwise `where total > 100` on a file would compare text and put 9
        // above 120 — a different answer from the same pipeline on a query.
        let r = parse_delimited("id,total\n1,9\n2,120\n", ',');
        assert_eq!(r.rows[1][1], Value::from(120));
        let filtered = apply_stage(r, "where total > 100").unwrap();
        assert_eq!(filtered.rows.len(), 1);
    }

    #[test]
    fn an_integer_column_does_not_become_a_float() {
        // Rendering an id of 1 as `1.0` breaks save → from → save round-trips
        // and stops a joined key matching.
        let r = parse_delimited("id,rate\n1,0.5\n", ',');
        assert_eq!(r.rows[0][0], Value::from(1));
        assert_eq!(r.rows[0][1], Value::from(0.5));
    }

    #[test]
    fn a_quoted_csv_field_may_contain_the_separator_and_a_newline() {
        let r = parse_delimited("a,b\n\"x,y\",\"line1\nline2\"\n", ',');
        assert_eq!(r.rows.len(), 1);
        assert_eq!(r.rows[0][0], Value::from("x,y"));
        assert_eq!(r.rows[0][1], Value::from("line1\nline2"));
    }

    #[test]
    fn a_doubled_quote_in_csv_is_one_quote() {
        let r = parse_delimited("a\n\"it\"\"s\"\n", ',');
        assert_eq!(r.rows[0][0], Value::from("it\"s"));
    }

    #[test]
    fn an_empty_csv_field_is_null_not_empty_string() {
        // `where x is null` must agree with what the query path would say.
        let r = parse_delimited("a,b\n1,\n", ',');
        assert_eq!(r.rows[0][1], Value::Null);
    }

    #[test]
    fn json_objects_of_different_shapes_still_make_one_table() {
        let r = parse_json(r#"[{"a":1},{"b":2}]"#).unwrap();
        assert_eq!(r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(r.rows[0][1], Value::Null);
        assert_eq!(r.rows[1][0], Value::Null);
    }

    #[test]
    fn a_json_source_must_be_an_array() {
        assert!(parse_json(r#"{"a":1}"#).is_err());
    }

    // ── tokenizing ──────────────────────────────────────────────────────────

    #[test]
    fn a_quoted_argument_keeps_its_spaces() {
        assert_eq!(tokenize("save 'my report.csv'"), ["save", "my report.csv"]);
    }

    #[test]
    fn an_empty_quoted_argument_survives() {
        // `where name = ''` must not lose the empty string and become arity-2.
        assert_eq!(tokenize("where name = ''"), ["where", "name", "=", ""]);
    }
}
