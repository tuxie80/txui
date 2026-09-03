//! Splitting `CREATE TABLE` into a load-shaped table and the rest.
//!
//! Rust port of `src/utils/syncDdl.ts`. Conformance is asserted by golden
//! vectors generated from **the real `SHOW CREATE TABLE` output of every table
//! on both test servers**, not from hand-written fixtures — a parser checked
//! only against DDL its author wrote is checked against their assumptions.
//!
//! Loading rows into a table that already carries its secondary indexes makes
//! the server maintain every B-tree per row, as random I/O. Loading into a
//! PK-only table and building the indexes afterwards makes it one sorted pass
//! per index. Measured on MySQL 8.0.46, 598,689 rows, four secondary indexes:
//! 3,454 ms with the indexes present against 1,290 ms + 778 ms without —
//! **1.67× faster**, and that is the best case for the indexed version.
//!
//! **The primary key is not deferred.** InnoDB clusters the table on it, so
//! adding it afterwards rewrites everything — measured at 544 ms on the same
//! data.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeferredKind {
    Index,
    Unique,
    Fulltext,
    Spatial,
    ForeignKey,
    Check,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeferredClause {
    pub kind: DeferredKind,
    pub name: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SplitTable {
    pub create_sql: String,
    pub deferred: Vec<DeferredClause>,
    pub auto_increment: Option<u64>,
    pub generated_columns: Vec<String>,
    pub load_columns: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RebuildPlan {
    pub index_sql: Option<String>,
    pub foreign_key_sql: Option<String>,
    pub check_sql: Option<String>,
    pub auto_increment_sql: Option<String>,
}

/// Split the body of a `CREATE TABLE` into its top-level clauses.
///
/// Not a line splitter and not a naive comma split: a clause can contain commas
/// inside parentheses (`KEY x (a,b)`), inside string literals (`DEFAULT 'a,b'`)
/// and inside backticked identifiers (`` `we,ird` ``). All three occur in real
/// DDL.
pub fn split_clauses(body: &str) -> Vec<String> {
    let chars: Vec<char> = body.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            cur.push(c);
            if c == '\\' && q != '`' {
                if let Some(&n) = chars.get(i + 1) {
                    cur.push(n);
                    i += 1;
                }
            } else if c == q {
                // A doubled quote is an escaped one, not a terminator.
                if chars.get(i + 1) == Some(&q) {
                    cur.push(q);
                    i += 1;
                } else {
                    quote = None;
                }
            }
            i += 1;
            continue;
        }
        match c {
            '\'' | '"' | '`' => {
                quote = Some(c);
                cur.push(c);
            }
            '(' => {
                depth += 1;
                cur.push(c);
            }
            ')' => {
                depth -= 1;
                cur.push(c);
            }
            ',' if depth == 0 => {
                out.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(c),
        }
        i += 1;
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// Read a backticked identifier starting at `from`, un-doubling `` `` ``.
fn read_ident(s: &str, from: usize) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut i = from;
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    if chars.get(i) != Some(&'`') {
        return None;
    }
    i += 1;
    let mut name = String::new();
    while i < chars.len() {
        if chars[i] == '`' {
            if chars.get(i + 1) == Some(&'`') {
                name.push('`');
                i += 2;
                continue;
            }
            return Some(name);
        }
        name.push(chars[i]);
        i += 1;
    }
    None
}

fn starts_with_kw(s: &str, kw: &str) -> bool {
    let up: String = s.trim_start().to_uppercase();
    if !up.starts_with(kw) {
        return false;
    }
    // The next character must not continue the word — `keyword` is not `KEY`.
    up[kw.len()..]
        .chars()
        .next()
        .map(|c| !c.is_alphanumeric() && c != '_')
        .unwrap_or(true)
}

/// Name following `CONSTRAINT`, when there is one.
fn constraint_name(c: &str) -> Option<String> {
    let up = c.to_uppercase();
    if !up.trim_start().starts_with("CONSTRAINT") {
        return None;
    }
    let at = c.to_uppercase().find("CONSTRAINT")? + "CONSTRAINT".len();
    read_ident(c, at)
}

/// The index name in a key clause.
///
/// The introducer is one or two words — `KEY x`, `UNIQUE KEY x`,
/// `FULLTEXT INDEX x` — so the identifier is found by skipping *words* until a
/// backtick appears, rather than by assuming a fixed offset. Looking only after
/// the first keyword misses every `UNIQUE KEY`, which is what the live-server
/// vectors caught.
fn key_name(c: &str) -> Option<String> {
    let chars: Vec<char> = c.chars().collect();
    let mut i = 0usize;
    // At most three words before the name: e.g. `CONSTRAINT`-less `FULLTEXT KEY x`.
    for _ in 0..3 {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if chars.get(i) == Some(&'`') {
            return read_ident(c, i);
        }
        // Skip one bare word.
        let start = i;
        while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
            i += 1;
        }
        if i == start {
            return None;   // punctuation — an unnamed key
        }
    }
    None
}

/// Classify one top-level clause. `None` = it belongs in the load table.
pub fn classify_clause(clause: &str) -> Option<DeferredClause> {
    let c = clause.trim();
    let up = c.to_uppercase();

    // PRIMARY KEY stays — InnoDB clusters on it. Checked first because
    // "PRIMARY KEY" would also match the generic KEY pattern.
    if starts_with_kw(c, "PRIMARY") && up.contains("KEY") {
        return None;
    }

    let mk = |kind: DeferredKind, name: Option<String>| {
        Some(DeferredClause { kind, name, text: c.to_string() })
    };

    let is_constraint = starts_with_kw(c, "CONSTRAINT");
    if (is_constraint && up.contains("FOREIGN KEY")) || starts_with_kw(c, "FOREIGN") {
        return mk(DeferredKind::ForeignKey, constraint_name(c));
    }
    if (is_constraint && up.contains("CHECK")) || starts_with_kw(c, "CHECK") {
        return mk(DeferredKind::Check, constraint_name(c));
    }
    if starts_with_kw(c, "FULLTEXT") {
        return mk(DeferredKind::Fulltext, key_name(c));
    }
    if starts_with_kw(c, "SPATIAL") {
        return mk(DeferredKind::Spatial, key_name(c));
    }
    if starts_with_kw(c, "UNIQUE") {
        return mk(DeferredKind::Unique, key_name(c));
    }
    if starts_with_kw(c, "KEY") || starts_with_kw(c, "INDEX") {
        return mk(DeferredKind::Index, key_name(c));
    }
    // A column definition, or something unrecognised. Either way it stays — the
    // cost of being wrong here is a slower load, not a broken one.
    None
}

/// A generated column's name, or `None`.
pub fn generated_column_name(clause: &str) -> Option<String> {
    let name = read_ident(clause, 0)?;
    let up = clause.to_uppercase();
    let generated = up.contains("GENERATED ALWAYS AS")
        || up.replace("  ", " ").contains("GENERATED ALWAYS AS")
        || up.contains(" AS (");
    if generated { Some(name) } else { None }
}

/// A plain column's name, or `None` when the clause is not a column.
pub fn column_name(clause: &str) -> Option<String> {
    let name = read_ident(clause, 0)?;
    if classify_clause(clause).is_some() {
        return None;
    }
    for kw in [
        "PRIMARY", "UNIQUE", "FULLTEXT", "SPATIAL", "KEY", "INDEX", "CONSTRAINT", "CHECK",
        "FOREIGN",
    ] {
        if starts_with_kw(clause, kw) {
            return None;
        }
    }
    Some(name)
}

/// Pull `AUTO_INCREMENT = n` out of a table's option list, ignoring any that
/// sits inside a quoted string.
///
/// A regex over the whole tail cannot tell an option from the contents of a
/// `COMMENT`, and getting it wrong corrupts the comment **and** invents a
/// counter — both directions of wrong from one mistake.
pub fn lift_auto_increment(tail: &str) -> (Option<u64>, String) {
    let chars: Vec<char> = tail.chars().collect();
    let mut out = String::new();
    let mut quote: Option<char> = None;
    let mut value: Option<u64> = None;
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            out.push(c);
            if c == '\\' {
                if let Some(&n) = chars.get(i + 1) {
                    out.push(n);
                    i += 1;
                }
            } else if c == q {
                if chars.get(i + 1) == Some(&q) {
                    out.push(q);
                    i += 1;
                } else {
                    quote = None;
                }
            }
            i += 1;
            continue;
        }
        if c == '\'' || c == '"' || c == '`' {
            quote = Some(c);
            out.push(c);
            i += 1;
            continue;
        }
        if value.is_none() {
            if let Some((v, len)) = match_auto_increment(&chars[i..]) {
                value = Some(v);
                i += len;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    (value, out)
}

/// `\s*AUTO_INCREMENT\s*=\s*(\d+)` at the head of `s`, returning its length.
fn match_auto_increment(s: &[char]) -> Option<(u64, usize)> {
    let mut i = 0usize;
    while i < s.len() && s[i].is_whitespace() {
        i += 1;
    }
    const KW: &str = "AUTO_INCREMENT";
    if s.len() < i + KW.len() {
        return None;
    }
    let word: String = s[i..i + KW.len()].iter().collect::<String>().to_uppercase();
    if word != KW {
        return None;
    }
    i += KW.len();
    while i < s.len() && s[i].is_whitespace() {
        i += 1;
    }
    if s.get(i) != Some(&'=') {
        return None;
    }
    i += 1;
    while i < s.len() && s[i].is_whitespace() {
        i += 1;
    }
    let start = i;
    while i < s.len() && s[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    let digits: String = s[start..i].iter().collect();
    digits.parse().ok().map(|v| (v, i))
}

/// Split a `SHOW CREATE TABLE` result into a load table plus deferred clauses.
pub fn split_create_table(create_sql: &str) -> SplitTable {
    let open = create_sql.find('(');
    let close = create_sql.rfind(')');
    let (open, close) = match (open, close) {
        (Some(o), Some(c)) if c > o => (o, c),
        // Not something we recognise — hand it back whole rather than mangling.
        _ => {
            return SplitTable {
                create_sql: create_sql.to_string(),
                deferred: Vec::new(),
                auto_increment: None,
                generated_columns: Vec::new(),
                load_columns: Vec::new(),
            }
        }
    };

    let head = create_sql[..open].trim_end();
    let body = &create_sql[open + 1..close];
    let tail_raw = &create_sql[close + 1..];

    let mut kept: Vec<String> = Vec::new();
    let mut deferred: Vec<DeferredClause> = Vec::new();
    let mut generated_columns: Vec<String> = Vec::new();
    let mut load_columns: Vec<String> = Vec::new();

    for clause in split_clauses(body) {
        if let Some(d) = classify_clause(&clause) {
            deferred.push(d);
            continue;
        }
        kept.push(clause.clone());
        if let Some(g) = generated_column_name(&clause) {
            generated_columns.push(g);
            continue;
        }
        if let Some(c) = column_name(&clause) {
            load_columns.push(c);
        }
    }

    let (auto_increment, tail) = lift_auto_increment(tail_raw);
    let body_out = kept
        .iter()
        .map(|c| format!("  {c}"))
        .collect::<Vec<_>>()
        .join(",\n");

    SplitTable {
        create_sql: format!("{head} (\n{body_out}\n){}", tail.trim_end()),
        deferred,
        auto_increment,
        generated_columns,
        load_columns,
    }
}

fn q(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// The statements that put back what the split held out.
///
/// Indexes go in **one** `ALTER`: InnoDB makes a single pass over the table for
/// a combined add and one pass per statement otherwise (measured: four indexes
/// in one `ALTER` took 778 ms against a 1,290 ms load).
///
/// `FULLTEXT` is emitted one per statement — InnoDB permits only one to be
/// added per `ALTER`, so batching them is a runtime error. Foreign keys are
/// separate because they can reference a table loaded later; checks are last,
/// because a failing `CHECK` is a statement about the *data*.
pub fn rebuild_plan(schema: &str, table: &str, split: &SplitTable) -> RebuildPlan {
    let target = format!("{}.{}", q(schema), q(table));
    let of = |k: DeferredKind| -> Vec<&DeferredClause> {
        split.deferred.iter().filter(|d| d.kind == k).collect()
    };

    let mut indexish: Vec<&DeferredClause> = Vec::new();
    indexish.extend(of(DeferredKind::Index));
    indexish.extend(of(DeferredKind::Unique));
    indexish.extend(of(DeferredKind::Spatial));
    // Preserve the order they appeared in, not the order of the kinds.
    indexish.sort_by_key(|d| split.deferred.iter().position(|x| std::ptr::eq(*d, x)).unwrap_or(0));

    let mut stmts: Vec<String> = Vec::new();
    if !indexish.is_empty() {
        let adds: Vec<String> = indexish.iter().map(|d| format!("ADD {}", d.text)).collect();
        stmts.push(format!("ALTER TABLE {target}\n  {}", adds.join(",\n  ")));
    }
    for f in of(DeferredKind::Fulltext) {
        stmts.push(format!("ALTER TABLE {target} ADD {}", f.text));
    }

    let join_adds = |list: Vec<&DeferredClause>| -> Option<String> {
        if list.is_empty() {
            return None;
        }
        let adds: Vec<String> = list.iter().map(|d| format!("ADD {}", d.text)).collect();
        Some(format!("ALTER TABLE {target}\n  {}", adds.join(",\n  ")))
    };

    RebuildPlan {
        index_sql: if stmts.is_empty() { None } else { Some(stmts.join(";\n")) },
        foreign_key_sql: join_adds(of(DeferredKind::ForeignKey)),
        check_sql: join_adds(of(DeferredKind::Check)),
        auto_increment_sql: split
            .auto_increment
            .map(|n| format!("ALTER TABLE {target} AUTO_INCREMENT = {n}")),
    }
}

/// The `INSERT` / `LOAD DATA` column list.
///
/// Generated columns are excluded because inserting into one is an error, and
/// invisible columns (8.0.23+) are the mirror hazard — absent from `SELECT *`.
/// Which is why the list is always explicit and never a star.
pub fn load_column_list(split: &SplitTable) -> String {
    split
        .load_columns
        .iter()
        .map(|c| q(c))
        .collect::<Vec<_>>()
        .join(", ")
}
