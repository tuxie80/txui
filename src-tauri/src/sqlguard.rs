//! Server-side write-statement detection — defence in depth behind the UI's
//! client guard (src/utils/sqlGuard.ts). A read-only connection must reject
//! writes even if the frontend guard is bypassed (a data-modifying CTE, an
//! `EXPLAIN ANALYZE DELETE`, injected webview JS, or a raw IPC call).
//!
//! Detection is intentionally broad — a false positive blocks a read (safe);
//! a false negative runs a write on a read-only server (unsafe). When in
//! doubt we block.

/// Lexical dialect switches for `blank` — the few places the supported
/// engines disagree on what is code and what is text. Getting one wrong is
/// not cosmetic: each was a verified guard bypass (a write the scanner
/// blanked away, e.g. treating `#` as a comment erases `… # 2; DROP TABLE t`
/// on PostgreSQL, where `#` is the XOR operator) or a false positive on live
/// SQL (`DELETE FROM #tmp WHERE …` on T-SQL).
///
/// The engine-less default (`None`) keeps the historical MySQL-leaning
/// behavior — backslash escapes, `#` comments, no comment nesting, dollar
/// strings — so callers that predate engine threading see no behavior
/// change. That default is NOT safe against these bypasses on non-MySQL
/// engines; every enforcement path holding a session engine must call the
/// `*_for` variants instead.
#[derive(Clone, Copy)]
pub(crate) struct Dialect {
    /// `#` starts a line comment — MySQL-family only. On PostgreSQL `#` is an
    /// operator, on T-SQL the temp-table prefix (`DELETE FROM #tmp`).
    hash_comment: bool,
    /// A backslash escapes inside '…'/"…" strings — MySQL-family and
    /// ClickHouse. On PostgreSQL (standard_conforming_strings), SQLite,
    /// DuckDB and T-SQL it is data, so `'x\'; DROP TABLE t; --'` is a
    /// complete string followed by a real DROP.
    backslash_escape: bool,
    /// Block comments nest (`/* /* */ */`) — PostgreSQL and T-SQL. MySQL,
    /// SQLite, ClickHouse and DuckDB end the comment at the first `*/`, and
    /// counting depth there would blank the live SQL that follows it
    /// (`/* /* */ DROP TABLE t -- */` is a real DROP on MySQL).
    nested_comments: bool,
    /// Dollar-quoted strings `$tag$ … $tag$` — PostgreSQL and DuckDB. On
    /// MySQL/T-SQL `$` is an identifier character, so blanking between two
    /// `$a$` tokens would hide the statements between them.
    dollar_strings: bool,
    /// Semantic, not lexical: on PostgreSQL, flipping the driver-level
    /// read-only backstop off classifies as a write. `is_write_for` judges
    /// these on the RAW statement (`pg_set_flips_readonly`), because the
    /// spellings hide from blanked text: `SET "transaction_read_only" = off`
    /// blanks the quoted GUC name away, and `SET SESSION CHARACTERISTICS AS
    /// TRANSACTION READ WRITE` never names the GUC at all.
    ///
    /// PG-only by owner decision (2026-10-15): MySQL/MariaDB's
    /// `SET SESSION transaction_read_only = 0` is deliberately NOT blocked —
    /// a DBA tool must let the user manage that switch explicitly.
    pg_set_readonly: bool,
}

impl Dialect {
    /// The historical engine-less behavior: MySQL-family lexing plus dollar
    /// strings (which predate the dialect split). See the struct doc for why
    /// callers with a known engine must not rely on it.
    fn legacy() -> Dialect {
        Dialect {
            hash_comment: true,
            backslash_escape: true,
            nested_comments: false,
            dollar_strings: true,
            pg_set_readonly: false,
        }
    }

    /// Every switch off: blank nothing beyond universal `--`/`/* */`/quotes.
    fn off() -> Dialect {
        Dialect {
            hash_comment: false,
            backslash_escape: false,
            nested_comments: false,
            dollar_strings: false,
            pg_set_readonly: false,
        }
    }

    fn for_engine(engine: Option<crate::db::types::Engine>) -> Dialect {
        use crate::db::types::Engine as E;
        match engine {
            Some(E::Mysql) => Dialect { hash_comment: true, backslash_escape: true, ..Dialect::off() },
            Some(E::Postgres) => Dialect { nested_comments: true, dollar_strings: true, pg_set_readonly: true, ..Dialect::off() },
            Some(E::SqlServer) => Dialect { nested_comments: true, ..Dialect::off() },
            Some(E::Clickhouse) => Dialect { backslash_escape: true, ..Dialect::off() },
            Some(E::Duckdb) => Dialect { dollar_strings: true, ..Dialect::off() },
            // Sqlite/Parquet/Redis/MongoDb: everything off — reveal the text,
            // let the keyword scan see it.
            Some(_) => Dialect::off(),
            None => Dialect::legacy(),
        }
    }
}

/// Replace the contents of string literals, quoted identifiers, dollar-quoted
/// bodies and comments with spaces, preserving overall structure (parens,
/// keywords, statement separators). Operates on `char`s so UTF-8 identifiers
/// are handled safely. Engine-less wrapper — see `Dialect` for what that
/// means; prefer `blank_dialect` where the engine is known.
/// `pub(crate)`: commands/duckdb.rs's GeoParquet export uses it to reject a
/// comment-only "statement" as effectively empty.
pub(crate) fn blank(sql: &str) -> String {
    blank_dialect(sql, &Dialect::legacy())
}

pub(crate) fn blank_dialect(sql: &str, d: &Dialect) -> String {
    let cs: Vec<char> = sql.chars().collect();
    let n = cs.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;
    while i < n {
        let c = cs[i];
        // line comments
        if c == '-' && i + 1 < n && cs[i + 1] == '-' {
            while i < n && cs[i] != '\n' { out.push(' '); i += 1; }
            continue;
        }
        if c == '#' && d.hash_comment {
            while i < n && cs[i] != '\n' { out.push(' '); i += 1; }
            continue;
        }
        // block comment
        if c == '/' && i + 1 < n && cs[i + 1] == '*' {
            // MySQL versioned comments (`/*!50000 … */`, `/*! … */`) are
            // EXECUTED by the server, so their body must stay visible to the
            // keyword scan — otherwise `/*! DROP TABLE t */` blanks to nothing
            // and sails past a read-only/prod border. Optimizer hints (`/*+`)
            // are kept visible too, conservatively. Only the opener token and
            // any version digits are blanked; the body flows through the
            // normal scanner (strings inside it still get blanked) and the
            // trailing `*/` stays as punctuation, which no word check matches.
            if i + 2 < n && (cs[i + 2] == '!' || cs[i + 2] == '+') {
                out.push(' '); out.push(' '); out.push(' ');
                i += 3;
                while i < n && cs[i].is_ascii_digit() { out.push(' '); i += 1; }
                continue;
            }
            // Depth counts only where the engine nests comments (see
            // Dialect::nested_comments); elsewhere the first `*/` closes.
            // The opener is consumed before the loop so it is not re-counted.
            out.push(' '); out.push(' '); i += 2;
            let mut depth = 1i32;
            while i < n && depth > 0 {
                if d.nested_comments && cs[i] == '/' && i + 1 < n && cs[i + 1] == '*' {
                    depth += 1; out.push(' '); out.push(' '); i += 2; continue;
                }
                if cs[i] == '*' && i + 1 < n && cs[i + 1] == '/' {
                    depth -= 1; out.push(' '); out.push(' '); i += 2; continue;
                }
                out.push(' '); i += 1;
            }
            continue;
        }
        // PostgreSQL dollar-quote:  $tag$ ... $tag$   (tag may be empty)
        if c == '$' && d.dollar_strings {
            if let Some(tag) = dollar_tag(&cs, i) {
                let body_start = i + tag.len();
                let end = find_seq(&cs, &tag, body_start)
                    .map(|p| p + tag.len())
                    .unwrap_or(n);
                for _ in i..end { out.push(' '); }
                i = end;
                continue;
            }
        }
        // quotes: '...'  "..."  `...`
        if c == '\'' || c == '"' || c == '`' {
            out.push(' ');
            i += 1;
            while i < n {
                // backslash escape (not for backtick-quoted identifiers, and
                // only on engines whose strings take backslash escapes)
                if d.backslash_escape && cs[i] == '\\' && c != '`' && i + 1 < n {
                    out.push(' '); out.push(' '); i += 2; continue;
                }
                if cs[i] == c {
                    // doubled-quote escape
                    if i + 1 < n && cs[i + 1] == c { out.push(' '); out.push(' '); i += 2; continue; }
                    out.push(' '); i += 1; break;
                }
                out.push(' '); i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// If `cs[start]` begins a dollar-quote tag (`$` [A-Za-z0-9_]* `$`), return the
/// full tag including both `$` (e.g. `$$` or `$body$`).
fn dollar_tag(cs: &[char], start: usize) -> Option<Vec<char>> {
    if cs.get(start) != Some(&'$') { return None; }
    let mut j = start + 1;
    while j < cs.len() && (cs[j].is_ascii_alphanumeric() || cs[j] == '_') { j += 1; }
    if cs.get(j) == Some(&'$') { Some(cs[start..=j].to_vec()) } else { None }
}

fn find_seq(cs: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || from > cs.len() { return None; }
    let mut i = from;
    while i + needle.len() <= cs.len() {
        if cs[i..i + needle.len()] == *needle { return Some(i); }
        i += 1;
    }
    None
}

const WRITE_KEYWORDS: &[&str] = &[
    "insert", "update", "delete", "replace", "drop", "alter", "truncate",
    "create", "grant", "revoke", "rename", "call", "merge", "load",
    "optimize", "repair", "flush", "reset", "kill",
    // ── PostgreSQL ──────────────────────────────────────────────────────
    // These mutate data, schema, or storage and were previously invisible to
    // the guard, so a read-only PostgreSQL connection accepted them.
    // `do` runs an anonymous PL/pgSQL block — arbitrary writes.
    // `vacuum` / `cluster` / `reindex` rewrite storage; `refresh` rewrites a
    // materialized view; `comment` and `security` change catalog metadata;
    // `lock` takes an explicit table lock; `discard`/`notify` change session
    // or queue state; `import` pulls in a whole foreign schema.
    // ── ClickHouse ──────────────────────────────────────────────────────
    // Its mutating vocabulary is not MySQL's, and the guard only knew MySQL's,
    // so a connection marked read-only accepted all of these. Probed against
    // the keyword list rather than assumed:
    //   DETACH TABLE t   — the table disappears from the server
    //   ATTACH TABLE t   — and reappears, or a new one appears
    //   EXCHANGE TABLES  — atomically swaps two tables' contents
    //   SYSTEM SHUTDOWN  — stops the server; SYSTEM also covers DROP CACHE,
    //                      STOP MERGES, RESTART REPLICA and friends
    // None of these words begin a statement on MySQL or PostgreSQL (PG spells
    // its partition detach `ALTER TABLE … DETACH PARTITION`, which already
    // starts with ALTER), so adding them costs those engines nothing.
    "detach", "attach", "exchange", "system",
    // ── PostgreSQL ──────────────────────────────────────────────────────
    "do", "vacuum", "cluster", "reindex", "refresh", "comment", "security",
    "lock", "discard", "notify", "import", "reassign", "cleanup",
    // `execute` runs a previously prepared statement whose body we cannot see
    // here, and `prepare` is checked separately below for its inner statement.
    "execute",
    // ── MySQL/MariaDB server administration ─────────────────────────────
    // Statement-leading admin verbs a read-only connection must refuse:
    // SHUTDOWN stops the server; PURGE BINARY LOGS deletes binlogs; CHANGE
    // REPLICATION SOURCE TO / CHANGE MASTER TO repoints replication;
    // INSTALL/UNINSTALL PLUGIN loads code into the server. START/STOP
    // (REPLICA/SLAVE) are handled below with a second-word check so that
    // START TRANSACTION keeps behaving like BEGIN.
    "shutdown", "purge", "change", "install", "uninstall", "stop",
    // ── SQL Server (T-SQL) ────────────────────────────────────────────────
    // EXEC('DELETE …') / EXEC sp_executesql run a body we cannot see —
    // blocked like EXECUTE. No other supported engine starts a statement
    // with `exec`.
    "exec",
    // BULK INSERT t FROM 'file' bulk-loads rows. `merge`, `truncate` and
    // `select`-INTO are already covered above: MERGE starts with "merge",
    // TRUNCATE TABLE with "truncate", and `SELECT … INTO t` (T-SQL's
    // table-creating SELECT) is the existing `select`+`into` rule — which is
    // engine-agnostic on purpose: on the engines where SELECT … INTO means
    // something read-ish there is no such syntax, so the rule cannot misfire
    // on MySQL/PG text. (The one known false positive, a T-SQL bracket-quoted
    // identifier literally named [into], is the safe direction: it blocks a
    // read, never runs a write.)
    "bulk",
];

fn first_word(s: &str) -> String {
    s.trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_lowercase()
}

/// The word (letters/digits/underscore) following the leading keyword of
/// `s`, lowercased — empty when the statement ends there. `kw_len` is the
/// byte length of the leading keyword (ASCII, per `first_word`).
fn word_after(s: &str, kw_len: usize) -> String {
    s.trim_start()[kw_len..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_lowercase()
}

/// Whole-word search on already-blanked text.
fn has_word(blanked: &str, word: &str) -> bool {
    let lower = blanked.to_lowercase();
    let bytes = lower.as_bytes();
    let w = word.as_bytes();
    let mut i = 0;
    while i + w.len() <= bytes.len() {
        if &bytes[i..i + w.len()] == w {
            let before_ok = i == 0 || !is_word_byte(bytes[i - 1]);
            let after = i + w.len();
            let after_ok = after >= bytes.len() || !is_word_byte(bytes[after]);
            if before_ok && after_ok { return true; }
        }
        i += 1;
    }
    false
}

fn is_word_byte(b: u8) -> bool { b.is_ascii_alphanumeric() || b == b'_' }

/// Direction of a `COPY` statement: true when it loads data in.
///
/// The deciding FROM/TO keyword sits at paren depth 0 — a plain
/// `has_word(.., "from")` would match the FROM inside
/// `COPY (SELECT * FROM t) TO STDOUT` and wrongly block an export, so only
/// top-level words count and the FIRST of from/to wins.
fn copy_writes(blanked: &str) -> bool {
    let after = blanked.trim_start();
    let after = &after[after.len().min(4)..]; // drop the leading "copy"
    let mut depth = 0i32;
    let mut word = String::new();

    for c in after.chars() {
        match c {
            '(' => { depth += 1; word.clear(); continue; }
            ')' => { depth -= 1; word.clear(); continue; }
            _ => {}
        }
        if c.is_ascii_alphanumeric() || c == '_' {
            word.push(c.to_ascii_lowercase());
            continue;
        }
        if depth == 0 {
            if word == "from" { return true; }
            if word == "to"   { return false; }
        }
        word.clear();
    }
    // Statement ended on a word (e.g. "... from stdin" already returned).
    depth == 0 && word == "from"
}

/// Detect whether a single (already-blanked) statement writes.
fn statement_is_write(blanked: &str, d: &Dialect) -> bool {
    let kw = first_word(blanked);
    if kw.is_empty() { return false; }
    if WRITE_KEYWORDS.contains(&kw.as_str()) { return true; }
    if kw == "set" {
        // SET GLOBAL / SET PERSIST / SET PERSIST_ONLY mutate server state;
        // session/user variables do not.
        let second = word_after(blanked, kw.len());
        if matches!(second.as_str(), "global" | "persist" | "persist_only") { return true; }
        // PostgreSQL's read-only-backstop flips (SET [SESSION|LOCAL]
        // (default_)transaction_read_only in all its quoted/dotted spellings,
        // and SET SESSION CHARACTERISTICS … READ WRITE) are judged on the RAW
        // statement by pg_set_flips_readonly in is_write_for — on blanked text
        // a quoted GUC name is invisible.
        return false;
    }
    if kw == "start" {
        // START TRANSACTION is BEGIN's other spelling — not a write. Every
        // other START (REPLICA / SLAVE / GROUP_REPLICATION / ALL SLAVES) is
        // server administration; when in doubt we block.
        return word_after(blanked, kw.len()) != "transaction";
    }
    if kw == "with" {
        // data-modifying CTE: the write can sit inside the CTE parens, so
        // scan the whole (blanked) statement for a modifying keyword.
        return ["insert", "update", "delete", "merge"].iter().any(|w| has_word(blanked, w));
    }
    if kw == "copy" {
        // PostgreSQL COPY goes both ways: `COPY t FROM …` bulk-loads rows,
        // `COPY t TO …` is an export. Only the inbound direction writes, and
        // treating them alike would have broken exporting from a read-only
        // connection.
        return copy_writes(blanked);
    }
    if kw == "prepare" {
        // PREPARE w AS INSERT … — the payload decides. Without this the
        // statement parked a write that a later EXECUTE would run.
        let rest = blanked.trim_start()[kw.len()..].to_string();
        return ["insert", "update", "delete", "merge", "create", "drop", "alter", "truncate"]
            .iter().any(|w| has_word(&rest, w));
    }
    if kw == "select" {
        // `SELECT … INTO new_table` creates and populates a table. A plain
        // SELECT never contains a bare INTO keyword (a subquery write would
        // make the statement start with WITH instead).
        return has_word(blanked, "into");
    }
    if kw == "explain" || kw == "describe" || kw == "desc" {
        // strip the EXPLAIN prefix + its options, re-test the remainder:
        // EXPLAIN [ANALYZE] [VERBOSE] [( … )] <statement>
        let rest = strip_explain(blanked);
        return statement_is_write(&rest, d);
    }
    false
}

/// Remove a leading `explain`/`describe` keyword plus `analyze`/`verbose`
/// words and a parenthesised option list, returning the underlying statement.
fn strip_explain(blanked: &str) -> String {
    let mut s = blanked.trim_start().to_string();
    // drop the leading keyword
    let fw = first_word(&s);
    s = s.trim_start()[fw.len()..].trim_start().to_string();
    loop {
        let lw = first_word(&s);
        if lw == "analyze" || lw == "verbose" || lw == "analyse" || lw == "format" {
            s = s.trim_start()[lw.len()..].trim_start().to_string();
            // `format json` / `format=json`
            if s.starts_with('=') { s = s[1..].trim_start().to_string(); }
            let v = first_word(&s);
            if !v.is_empty() && lw == "format" { s = s.trim_start()[v.len()..].trim_start().to_string(); }
            continue;
        }
        break;
    }
    if s.starts_with('(') {
        // skip the balanced option list
        let cs: Vec<char> = s.chars().collect();
        let mut depth = 0i32;
        let mut i = 0;
        while i < cs.len() {
            match cs[i] { '(' => depth += 1, ')' => { depth -= 1; if depth == 0 { i += 1; break; } }, _ => {} }
            i += 1;
        }
        s = cs[i..].iter().collect::<String>().trim_start().to_string();
    }
    s
}

/// True if any statement in `sql` is a write/DDL/DCL statement.
/// Engine-less wrapper — the most transparent scanner (see `Dialect`);
/// callers holding a session engine should use `is_write_for`.
pub fn is_write(sql: &str) -> bool {
    is_write_for(None, sql)
}

/// `is_write` with the session engine, so the scanner blanks exactly what
/// that engine treats as text (nested comments, `#` comments, backslash
/// escapes, dollar quotes — see `Dialect`).
pub fn is_write_for(engine: Option<crate::db::types::Engine>, sql: &str) -> bool {
    let d = Dialect::for_engine(engine);
    let blanked = blank_dialect(sql, &d);
    if d.pg_set_readonly {
        // The read-only-backstop flips hide from blanked text (quoted GUC
        // names, SET SESSION CHARACTERISTICS), so PostgreSQL SET statements
        // are additionally judged on the RAW statement. Blanking preserves
        // character count exactly, so raw and blanked split identically.
        return split_aligned(sql, &blanked).into_iter().any(|(raw, bl)| {
            statement_is_write(bl, &d)
                || (first_word(bl) == "set" && pg_set_flips_readonly(raw))
        });
    }
    blanked.split(';').any(|s| statement_is_write(s, &d))
}

/// Split `raw` and its blanked form into per-statement pairs. Blanking maps
/// every input char to exactly one output char, so both strings cut at the
/// same character positions — the `;`s in `blanked` (string/comment content
/// no longer contains any) are safe split points for both.
fn split_aligned<'a>(raw: &'a str, blanked: &'a str) -> Vec<(&'a str, &'a str)> {
    let rb: Vec<usize> = raw.char_indices().map(|(i, _)| i)
        .chain(std::iter::once(raw.len())).collect();
    let bb: Vec<usize> = blanked.char_indices().map(|(i, _)| i)
        .chain(std::iter::once(blanked.len())).collect();
    debug_assert_eq!(rb.len(), bb.len());
    let mut out = Vec::new();
    let mut start = 0; // char index of the current segment
    for (ci, c) in blanked.chars().enumerate() {
        if c == ';' {
            out.push((&raw[rb[start]..rb[ci]], &blanked[bb[start]..bb[ci]]));
            start = ci + 1;
        }
    }
    out.push((&raw[rb[start]..], &blanked[bb[start]..]));
    out
}

/// Token of the PG SET-target scan: words and `"quoted"` identifiers are kept
/// (lowercased) — the quoted form is the whole point, since blanking erases
/// it — while `'…'`/`$tag$` strings and comments collapse to `Other`.
#[derive(PartialEq)]
enum PgTok { Word(String), Quoted(String), Dot, Other }

fn pg_set_tokens(raw: &str) -> Vec<PgTok> {
    let cs: Vec<char> = raw.chars().collect();
    let n = cs.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        let c = cs[i];
        if c.is_whitespace() { i += 1; continue; }
        if c == '-' && i + 1 < n && cs[i + 1] == '-' {
            while i < n && cs[i] != '\n' { i += 1; }
            continue;
        }
        // PG block comments nest (Dialect::nested_comments for Postgres).
        if c == '/' && i + 1 < n && cs[i + 1] == '*' {
            i += 2;
            let mut depth = 1i32;
            while i < n && depth > 0 {
                if cs[i] == '/' && i + 1 < n && cs[i + 1] == '*' { depth += 1; i += 2; }
                else if cs[i] == '*' && i + 1 < n && cs[i + 1] == '/' { depth -= 1; i += 2; }
                else { i += 1; }
            }
            continue;
        }
        // '…' string, incl. the E'…' prefix whose backslash escapes — a SET
        // target never contains one, but the VALUE does, and an escaped quote
        // mis-skipped would leak string content into the token stream.
        if c == '\'' || ((c == 'E' || c == 'e') && i + 1 < n && cs[i + 1] == '\'') {
            let escaped = c != '\'';
            i += if escaped { 2 } else { 1 };
            while i < n {
                if escaped && cs[i] == '\\' && i + 1 < n { i += 2; continue; }
                if cs[i] == '\'' {
                    if i + 1 < n && cs[i + 1] == '\'' { i += 2; continue; }
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.push(PgTok::Other);
            continue;
        }
        if c == '$' {
            if let Some(tag) = dollar_tag(&cs, i) {
                let body_start = i + tag.len();
                let end = find_seq(&cs, &tag, body_start)
                    .map(|p| p + tag.len()).unwrap_or(n);
                i = end;
                out.push(PgTok::Other);
                continue;
            }
            i += 1; // a lone $ is punctuation
            continue;
        }
        if c == '"' {
            i += 1;
            let mut name = String::new();
            while i < n {
                if cs[i] == '"' {
                    if i + 1 < n && cs[i + 1] == '"' { name.push('"'); i += 2; continue; }
                    i += 1;
                    break;
                }
                name.push(cs[i]);
                i += 1;
            }
            // GUC names compare case-insensitively even when quoted.
            out.push(PgTok::Quoted(name.to_lowercase()));
            continue;
        }
        if c.is_ascii_alphanumeric() || c == '_' {
            let mut w = String::new();
            while i < n && (cs[i].is_ascii_alphanumeric() || cs[i] == '_') {
                w.push(cs[i].to_ascii_lowercase());
                i += 1;
            }
            out.push(PgTok::Word(w));
            continue;
        }
        if c == '.' { out.push(PgTok::Dot); }
        i += 1;
    }
    out
}

/// PostgreSQL-only: does this RAW (single) statement flip the driver-level
/// read-only backstop the pool sets at connect? Catches every spelling of
///   SET [SESSION|LOCAL] {default_transaction_read_only|transaction_read_only}
/// — bare, `"quoted"` (GUC names compare case-insensitively even quoted), or
/// as the last component of a `dotted.name` — plus
///   SET SESSION CHARACTERISTICS AS TRANSACTION … READ WRITE
/// which never names the GUC at all. Blocking a custom `x.transaction_read_only`
/// placeholder with it is the safe direction (a false positive blocks a SET,
/// a false negative undoes the read-only backstop). The value is never
/// inspected: even `= on` is refused, matching the historical posture.
fn pg_set_flips_readonly(raw: &str) -> bool {
    let toks = pg_set_tokens(raw);
    let word = |i: usize| -> Option<&str> {
        match toks.get(i) { Some(PgTok::Word(w)) => Some(w), _ => None }
    };
    let component = |i: usize| -> Option<&str> {
        match toks.get(i) { Some(PgTok::Word(w)) | Some(PgTok::Quoted(w)) => Some(w), _ => None }
    };
    if word(0) != Some("set") { return false; }
    let mut i = 1;
    if matches!(word(i), Some("session") | Some("local")) {
        if word(i + 1) == Some("characteristics") {
            // SET SESSION CHARACTERISTICS AS TRANSACTION <mode>[, …] — only
            // the READ WRITE mode undoes the backstop; READ ONLY and the
            // ISOLATION LEVEL / DEFERRABLE modes stay allowed.
            return toks[i + 2..].windows(2).any(|w| matches!(w,
                [PgTok::Word(a), PgTok::Word(b)] if a == "read" && b == "write"));
        }
        i += 1;
    }
    // configuration_parameter := component (. component)*
    let mut last = match component(i) { Some(c) => c, None => return false };
    let mut j = i + 1;
    while toks.get(j) == Some(&PgTok::Dot) {
        match component(j + 1) {
            Some(c) => { last = c; j += 2; }
            None => break,
        }
    }
    last == "transaction_read_only" || last == "default_transaction_read_only"
}

/// Read-family statements (SELECT/WITH/TABLE/VALUES/SHOW/DESCRIBE/EXPLAIN) —
/// a loose mirror of limitGuard's read detection in the frontend. Used to skip
/// the post-write `SHOW WARNINGS` fetch: reads rarely produce warnings, and
/// SHOW/EXPLAIN output must never be disturbed. Deliberately cheap: first word
/// of the FIRST statement, no write analysis.
pub fn is_read_family(sql: &str) -> bool {
    const READ_KEYWORDS: &[&str] =
        &["select", "with", "table", "values", "show", "describe", "desc", "explain"];
    let blanked = blank(sql);
    let kw = first_word(&blanked);
    READ_KEYWORDS.contains(&kw.as_str())
}

/// Destructive DDL/DCL keywords blocked on prod sessions (hard limit).
const DANGEROUS_DDL_KEYWORDS: &[&str] = &[
    "drop", "truncate", "alter", "rename", "grant", "revoke",
    // ClickHouse: DETACH makes a table vanish and EXCHANGE swaps two of them
    // under live readers — both belong on the prod border with DROP/RENAME.
    "detach", "exchange",
];

/// True if any statement in `sql` starts with a destructive DDL/DCL keyword
/// (DROP, TRUNCATE, ALTER, RENAME, GRANT, REVOKE), or is one of the
/// PostgreSQL maintenance commands that takes an ACCESS EXCLUSIVE lock and
/// rewrites the whole relation. The latter are not "destructive" in the sense
/// of losing data, but on a production server they stall every reader for the
/// duration, which is exactly what the prod border exists to prevent.
pub fn is_dangerous_ddl(sql: &str) -> bool {
    is_dangerous_ddl_for(None, sql)
}

/// `is_dangerous_ddl` with the session engine — see `is_write_for`.
pub fn is_dangerous_ddl_for(engine: Option<crate::db::types::Engine>, sql: &str) -> bool {
    let blanked = blank_dialect(sql, &Dialect::for_engine(engine));
    blanked.split(';').any(|s| {
        let kw = first_word(s);
        if DANGEROUS_DDL_KEYWORDS.contains(&kw.as_str()) { return true; }
        match kw.as_str() {
            // VACUUM FULL rewrites the table; plain VACUUM is routine.
            "vacuum"  => has_word(s, "full"),
            // ClickHouse SYSTEM covers everything from `FLUSH LOGS` (routine)
            // to `SHUTDOWN` (stops the server). Only the destructive half is a
            // prod hard limit; blocking the lot would make the prod border
            // noise people learn to switch off.
            "system" => ["shutdown", "kill", "restart", "restore", "drop", "stop"]
                .iter().any(|w| has_word(s, w)),
            "cluster" => true,
            "reindex" => !has_word(s, "concurrently"),
            // REFRESH MATERIALIZED VIEW blocks readers unless CONCURRENTLY.
            "refresh" => !has_word(s, "concurrently"),
            _ => false,
        }
    })
}

/// A bare UPDATE/DELETE with no WHERE clause hits every row — the classic
/// "oops" write. Mirrors `isUnfilteredWrite` in src/utils/sqlGuard.ts:
/// detected on blanked SQL so a `where` inside a string/comment doesn't
/// hide the danger; a data-modifying CTE outer UPDATE/DELETE counts.
pub fn is_unfiltered_write(sql: &str) -> bool {
    is_unfiltered_write_for(None, sql)
}

/// `is_unfiltered_write` with the session engine — see `is_write_for`.
pub fn is_unfiltered_write_for(engine: Option<crate::db::types::Engine>, sql: &str) -> bool {
    let blanked = blank_dialect(sql, &Dialect::for_engine(engine));
    blanked.split(';').any(unfiltered_updel)
}

/// One blanked statement: does it contain an UPDATE/DELETE with no WHERE at
/// the *same paren depth*? A `where` inside a subquery or CTE body must not
/// excuse a WHERE-less outer write (`WITH x AS (SELECT 1 WHERE true)
/// DELETE FROM t` is unfiltered), and a data-modifying CTE's inner
/// DELETE/UPDATE is judged by the WHERE inside its own parens. Heuristic
/// depth-scoped scanning, consistent with `copy_writes` — this is a guard,
/// not a parser.
fn unfiltered_updel(s: &str) -> bool {
    let kw = first_word(s);
    if kw != "update" && kw != "delete" && kw != "with" { return false; }
    // pending[d] = an UPDATE/DELETE verb seen at paren depth d, no WHERE yet
    let mut pending: Vec<bool> = vec![false];
    let mut depth: usize = 0;
    let mut word = String::new();
    let mut unfiltered = false;
    for c in s.chars().chain(std::iter::once('\n')) {
        if c.is_ascii_alphanumeric() || c == '_' {
            word.push(c.to_ascii_lowercase());
            continue;
        }
        if !word.is_empty() {
            if word == "update" || word == "delete" { pending[depth] = true; }
            else if word == "where" { pending[depth] = false; }
            word.clear();
        }
        match c {
            '(' => {
                depth += 1;
                if pending.len() <= depth { pending.push(false); } else { pending[depth] = false; }
            }
            ')' => {
                if pending[depth] { unfiltered = true; }   // group closed WHERE-less
                pending[depth] = false;
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
    }
    unfiltered || pending.iter().any(|&p| p)
}

/// Prod hard limits: destructive DDL and WHERE-less UPDATE/DELETE are blocked
/// on prod sessions unless the connection opts out. Non-prod: always Ok.
pub fn check_prod_limits(guard: &crate::state::SessionGuard, sql: &str) -> Result<(), String> {
    if guard.environment.as_deref() != Some("prod") {
        return Ok(());
    }
    // The guard carries the session engine, so the prod border scans the SQL
    // the way that engine will actually parse it.
    let engine = Some(guard.engine);
    if is_dangerous_ddl_for(engine, sql) && !guard.prod_allow_ddl {
        return Err("blocked on prod: destructive DDL (DROP/TRUNCATE/ALTER/RENAME/GRANT/REVOKE) \
                    — enable 'Allow destructive DDL' on the connection to permit".into());
    }
    if is_unfiltered_write_for(engine, sql) && !guard.prod_allow_unfiltered_write {
        return Err("blocked on prod: UPDATE/DELETE without a WHERE clause \
                    — enable 'Allow unfiltered writes' on the connection to permit".into());
    }
    Ok(())
}

#[cfg(test)]
mod clickhouse_tests {
    use super::{is_dangerous_ddl, is_write};

    /// ClickHouse's mutating vocabulary is not MySQL's, and the guard only
    /// knew MySQL's — so a connection the user had marked **read-only**
    /// accepted every statement below, including one that stops the server.
    #[test]
    fn the_clickhouse_statements_a_read_only_connection_used_to_accept() {
        for sql in [
            "DETACH TABLE t",              // the table disappears
            "ATTACH TABLE t",              // and reappears, or a new one does
            "EXCHANGE TABLES a AND b",     // two tables swap under live readers
            "SYSTEM SHUTDOWN",             // stops the server
            "SYSTEM DROP QUERY CACHE",
            "SYSTEM STOP MERGES",
            "SYSTEM RESTART REPLICA db.t",
        ] {
            assert!(is_write(sql), "read-only connection would accept: {sql}");
        }
    }

    /// The ones it already caught, kept so a future edit cannot quietly trade
    /// one gap for another.
    #[test]
    fn the_clickhouse_statements_it_already_caught_still_count() {
        for sql in [
            "ALTER TABLE t DELETE WHERE id = 1",   // ClickHouse's DELETE
            "ALTER TABLE t UPDATE v = 1 WHERE id = 1",
            "OPTIMIZE TABLE t FINAL",
            "TRUNCATE TABLE t",
            "KILL MUTATION WHERE mutation_id = 'x'",
            "INSERT INTO FUNCTION remote('h', db.t) SELECT * FROM s",
        ] {
            assert!(is_write(sql), "{sql}");
        }
    }

    #[test]
    fn reads_are_still_reads() {
        // The cost of widening the keyword list is false positives, which
        // would make a read-only ClickHouse session useless.
        for sql in ["SELECT * FROM t", "SHOW TABLES", "DESCRIBE TABLE t",
                    "EXISTS TABLE t", "SELECT * FROM system.parts"] {
            assert!(!is_write(sql), "{sql} was called a write");
        }
    }

    /// SYSTEM spans routine maintenance and stopping the server. Blocking all
    /// of it on prod would make the border noise people switch off.
    #[test]
    fn only_the_destructive_half_of_system_is_a_prod_hard_limit() {
        assert!(is_dangerous_ddl("SYSTEM SHUTDOWN"));
        assert!(is_dangerous_ddl("SYSTEM KILL"));
        assert!(is_dangerous_ddl("SYSTEM RESTART REPLICA db.t"));
        assert!(is_dangerous_ddl("SYSTEM STOP MERGES"));
        assert!(!is_dangerous_ddl("SYSTEM FLUSH LOGS"));
        assert!(!is_dangerous_ddl("SYSTEM RELOAD CONFIG"));
    }

    #[test]
    fn detach_and_exchange_are_prod_hard_limits_like_drop() {
        assert!(is_dangerous_ddl("DETACH TABLE t"));
        assert!(is_dangerous_ddl("EXCHANGE TABLES a AND b"));
        // ATTACH creates rather than destroys — a write, but not the border.
        assert!(!is_dangerous_ddl("ATTACH TABLE t"));
    }

    /// The new keywords must not change MySQL or PostgreSQL behaviour.
    #[test]
    fn the_other_engines_are_unaffected() {
        // PG spells its partition detach as an ALTER, which was already caught.
        assert!(is_write("ALTER TABLE t DETACH PARTITION p1"));
        assert!(!is_write("SELECT detach FROM t"));
        assert!(!is_write("SELECT * FROM system_config"));
    }
}

#[cfg(test)]
mod pg_tests {
    use super::{is_dangerous_ddl, is_read_family, is_write};

    // ── PostgreSQL write statements the guard used to let through ────────

    #[test]
    fn copy_from_writes_copy_to_does_not() {
        // COPY is bidirectional — blocking both would break exporting from a
        // read-only connection, allowing both let bulk loads through.
        assert!(is_write("COPY t FROM '/tmp/x.csv' WITH (FORMAT csv)"));
        assert!(is_write("COPY t (a,b) FROM STDIN"));
        assert!(!is_write("COPY t TO '/tmp/x.csv' WITH (FORMAT csv)"));
        assert!(!is_write("COPY (SELECT * FROM t) TO STDOUT"));
    }

    #[test]
    fn anonymous_do_block_is_a_write() {
        assert!(is_write("DO $$ BEGIN DELETE FROM t; END $$"));
        // dollar-quoted body is blanked, so detection rests on the keyword
        assert!(is_write("DO $body$ BEGIN PERFORM 1; END $body$"));
    }

    #[test]
    fn prepare_inspects_its_payload() {
        assert!(is_write("PREPARE w AS INSERT INTO t VALUES (1)"));
        assert!(is_write("PREPARE w AS DELETE FROM t WHERE id = $1"));
        assert!(!is_write("PREPARE r AS SELECT * FROM t WHERE id = $1"));
        // EXECUTE runs a body we cannot see — blocked by design
        assert!(is_write("EXECUTE w(1)"));
    }

    #[test]
    fn select_into_creates_a_table() {
        assert!(is_write("SELECT * INTO backup FROM orders"));
        assert!(!is_write("SELECT * FROM orders"));
        assert!(!is_write("SELECT id, name FROM t WHERE id IN (1,2)"));
    }

    #[test]
    fn storage_and_catalog_commands_are_writes() {
        assert!(is_write("VACUUM FULL orders"));
        assert!(is_write("VACUUM ANALYZE orders"));
        assert!(is_write("CLUSTER orders USING idx"));
        assert!(is_write("REINDEX TABLE orders"));
        assert!(is_write("REFRESH MATERIALIZED VIEW mv"));
        assert!(is_write("COMMENT ON TABLE t IS 'x'"));
        assert!(is_write("LOCK TABLE t IN ACCESS EXCLUSIVE MODE"));
    }

    #[test]
    fn explain_analyze_is_still_a_read() {
        // "analyze" as an EXPLAIN modifier must not be mistaken for the
        // standalone ANALYZE command.
        assert!(!is_write("EXPLAIN ANALYZE SELECT * FROM t"));
        assert!(!is_write("EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t"));
        assert!(is_read_family("EXPLAIN ANALYZE SELECT 1"));
        // …but EXPLAIN ANALYZE of a write still runs the write.
        assert!(is_write("EXPLAIN ANALYZE DELETE FROM t"));
    }

    #[test]
    fn a_where_hiding_in_a_dollar_quote_does_not_excuse_a_write() {
        // dollar-quoted bodies are blanked before keyword scanning
        assert!(super::is_unfiltered_write("UPDATE t SET body = $$ where $$"));
        // …and still are once the scanner knows the engine is PostgreSQL
        assert!(super::is_unfiltered_write_for(
            Some(crate::db::types::Engine::Postgres),
            "UPDATE t SET body = $$ where $$",
        ));
    }

    // ── Prod hard limits: heavy-lock maintenance ─────────────────────────

    #[test]
    fn prod_blocks_full_rewrites_but_not_routine_maintenance() {
        assert!(is_dangerous_ddl("VACUUM FULL orders"));
        assert!(!is_dangerous_ddl("VACUUM orders"));
        assert!(!is_dangerous_ddl("VACUUM ANALYZE orders"));
        assert!(!is_dangerous_ddl("ANALYZE orders"));

        assert!(is_dangerous_ddl("CLUSTER orders USING idx"));

        // CONCURRENTLY is the online variant — allowed on prod.
        assert!(is_dangerous_ddl("REINDEX TABLE orders"));
        assert!(!is_dangerous_ddl("REINDEX INDEX CONCURRENTLY idx"));
        assert!(is_dangerous_ddl("REFRESH MATERIALIZED VIEW mv"));
        assert!(!is_dangerous_ddl("REFRESH MATERIALIZED VIEW CONCURRENTLY mv"));
    }

    #[test]
    fn ordinary_reads_remain_unblocked_on_prod() {
        assert!(!is_dangerous_ddl("SELECT * FROM t"));
        assert!(!is_dangerous_ddl("COPY t TO STDOUT"));
        assert!(!is_dangerous_ddl("EXPLAIN SELECT * FROM t"));
    }
}

#[cfg(test)]
mod tsql_tests {
    use super::{is_dangerous_ddl, is_unfiltered_write, is_write};

    /// The T-SQL writes a read-only SQL Server connection must refuse. MERGE,
    /// TRUNCATE TABLE and DROP TABLE ride the existing engine-agnostic
    /// keywords; BULK INSERT is the one new keyword (nothing on MySQL or PG
    /// begins a statement with BULK, so it costs them nothing).
    #[test]
    fn tsql_writes_are_caught() {
        for sql in [
            "MERGE INTO target USING src ON target.id = src.id WHEN MATCHED THEN UPDATE SET v = src.v",
            "TRUNCATE TABLE t",
            "BULK INSERT t FROM 'C:\\data\\rows.csv' WITH (FIELDTERMINATOR = ',')",
            "DROP TABLE t",
            // pre-2016 has no IF EXISTS — detection is the same either way
            "DROP TABLE IF EXISTS t",
        ] {
            assert!(is_write(sql), "read-only connection would accept: {sql}");
        }
    }

    /// T-SQL's `SELECT … INTO t` creates and populates a table — a write
    /// dressed as a read. The rule is the engine-agnostic `select`+`into` one
    /// that already existed for PG; temp tables are no exception.
    #[test]
    fn select_into_is_a_write_in_tsql() {
        assert!(is_write("SELECT * INTO backup FROM orders"));
        assert!(is_write("SELECT id INTO #tmp FROM t"));
        assert!(!is_write("SELECT * FROM orders"));
        assert!(!is_write("SELECT id, name FROM t WHERE id IN (1,2)"));
    }

    #[test]
    fn tsql_reads_are_still_reads() {
        for sql in [
            "SELECT TOP 10 * FROM t",
            "SELECT * FROM t CROSS APPLY (SELECT 1) x",
            "SELECT * FROM t WITH (NOLOCK)",
            "DBCC SHOW_STATISTICS('t', 'i')",   // read-only DBCC — not a write verb
        ] {
            assert!(!is_write(sql), "{sql} was called a write");
        }
    }

    /// Known, accepted false positive: a bracket-quoted identifier named after
    /// the INTO keyword. House doctrine — a false positive blocks a read
    /// (safe); a false negative runs a write (unsafe). blank() does not strip
    /// […] quoting, and teaching it to would perturb every other engine for a
    /// corner case on one.
    #[test]
    fn a_bracketed_into_identifier_false_positive_is_the_safe_direction() {
        assert!(is_write("SELECT * FROM [into]"));
    }

    #[test]
    fn tsql_prod_hard_limits() {
        assert!(is_dangerous_ddl("DROP TABLE t"));
        assert!(is_dangerous_ddl("TRUNCATE TABLE t"));
        assert!(is_dangerous_ddl("ALTER TABLE t ADD c int"));
        assert!(!is_dangerous_ddl("MERGE INTO t USING s ON 1=0 WHEN NOT MATCHED THEN INSERT VALUES (1)"));
        assert!(is_unfiltered_write("UPDATE t SET v = 1"));
        assert!(!is_unfiltered_write("UPDATE t SET v = 1 WHERE id = 2"));
    }
}

#[cfg(test)]
mod tests {
    use super::{is_dangerous_ddl, is_read_family, is_unfiltered_write, is_write};

    #[test]
    fn reads_are_not_writes() {
        assert!(!is_write("SELECT * FROM t"));
        assert!(!is_write("  -- c\n select 1"));
        assert!(!is_write("EXPLAIN SELECT * FROM t"));
        assert!(!is_write("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!is_write("SELECT 'delete me' FROM t"));      // string, not a write
        assert!(!is_write("SET SESSION x = 1"));
    }

    #[test]
    fn writes_are_caught() {
        assert!(is_write("DELETE FROM t"));
        assert!(is_write("UPDATE t SET a=1"));
        assert!(is_write("select 1; delete from t"));
        assert!(is_write("WITH d AS (DELETE FROM users WHERE id=1 RETURNING *) SELECT * FROM d"));
        assert!(is_write("EXPLAIN ANALYZE DELETE FROM t"));
        assert!(is_write("EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a=1"));
        assert!(is_write("SET GLOBAL max_connections = 1"));
    }

    #[test]
    fn dangerous_ddl_caught() {
        assert!(is_dangerous_ddl("DROP TABLE t"));
        assert!(is_dangerous_ddl("truncate t"));
        assert!(is_dangerous_ddl("ALTER TABLE t ADD COLUMN c INT"));
        assert!(is_dangerous_ddl("RENAME TABLE a TO b"));
        assert!(is_dangerous_ddl("GRANT ALL ON *.* TO 'u'@'%'"));
        assert!(is_dangerous_ddl("REVOKE ALL ON db.* FROM 'u'@'%'"));
        assert!(is_dangerous_ddl("select 1; drop table t"));
        assert!(is_dangerous_ddl("/* x */ DROP TABLE t"));
    }

    #[test]
    fn dangerous_ddl_ignores_lookalikes() {
        assert!(!is_dangerous_ddl("SELECT * FROM t"));
        assert!(!is_dangerous_ddl("CREATE TABLE t (id INT)"));
        assert!(!is_dangerous_ddl("CREATE OR REPLACE VIEW v AS SELECT 1"));
        assert!(!is_dangerous_ddl("INSERT INTO t VALUES (1)"));
        assert!(!is_dangerous_ddl("UPDATE t SET a=1 WHERE id=2"));
        assert!(!is_dangerous_ddl("SELECT 'drop table t'"));        // string, not DDL
        assert!(!is_dangerous_ddl("-- drop table t\nSELECT 1"));    // comment
        assert!(!is_dangerous_ddl("SELECT dropper FROM t"));        // prefix, not keyword
    }

    #[test]
    fn unfiltered_writes_caught() {
        assert!(is_unfiltered_write("UPDATE t SET a=1"));
        assert!(is_unfiltered_write("DELETE FROM t"));
        assert!(is_unfiltered_write("delete from t;"));
        assert!(is_unfiltered_write("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"));
    }

    #[test]
    fn read_family_detected() {
        assert!(is_read_family("SELECT 1"));
        assert!(is_read_family("  -- c\n select 1"));
        assert!(is_read_family("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(is_read_family("SHOW WARNINGS"));
        assert!(is_read_family("DESCRIBE t"));
        assert!(is_read_family("EXPLAIN SELECT 1"));
        assert!(!is_read_family("SET GLOBAL super_read_only=OFF"));
        assert!(!is_read_family("INSERT INTO t VALUES (1)"));
        assert!(!is_read_family("CHANGE REPLICATION SOURCE TO SOURCE_HOST='h'"));
        assert!(!is_read_family("/* c */ UPDATE t SET a=1"));
    }

    #[test]
    fn filtered_or_non_writes_pass() {
        assert!(!is_unfiltered_write("UPDATE t SET a=1 WHERE id=2"));
        assert!(!is_unfiltered_write("DELETE FROM t WHERE id IN (SELECT id FROM s)"));
        assert!(!is_unfiltered_write("SELECT * FROM t"));
        assert!(!is_unfiltered_write("INSERT INTO t VALUES (1)"));
        assert!(is_unfiltered_write("UPDATE t SET note='where was I'"));   // where in a string doesn't count
        assert!(!is_unfiltered_write("SELECT somewhere FROM t"));          // prefix, not keyword
    }
}

#[cfg(test)]
mod guard_bypass_tests {
    //! Regression tests for the 2026-08 guard-hardening review (the findings
    //! WP-01): each test asserts both that a bypass is now blocked and that
    //! its legitimate neighbor still passes.
    use super::{is_dangerous_ddl, is_unfiltered_write, is_write};

    /// MySQL versioned comments are executed by the server — blanking their
    /// body used to erase the write from the guard's view entirely.
    #[test]
    fn versioned_comments_cannot_smuggle_writes() {
        assert!(is_write("/*!50000 DELETE FROM t*/"));
        assert!(is_unfiltered_write("/*!50000 DELETE FROM t*/"));
        assert!(is_write("/*! DROP TABLE x */"));
        assert!(is_dangerous_ddl("/*! DROP TABLE x */"));
        // legitimate neighbors: plain comments stay comments, hints stay reads
        assert!(!is_write("SELECT 1 /* comment */"));
        assert!(!is_write("/* delete from t */ SELECT 1"));
        assert!(!is_write("SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1"));
        assert!(!is_write("SELECT /*!40001 SQL_NO_CACHE */ * FROM t"));
    }

    /// Statement-leading admin verbs a read-only session used to accept.
    #[test]
    fn admin_verbs_are_writes() {
        assert!(is_write("SHUTDOWN"));
        assert!(is_write("PURGE BINARY LOGS BEFORE NOW()"));
        assert!(is_write("CHANGE REPLICATION SOURCE TO SOURCE_HOST='h'"));
        assert!(is_write("CHANGE MASTER TO MASTER_HOST='h'"));
        assert!(is_write("STOP REPLICA"));
        assert!(is_write("STOP SLAVE"));
        assert!(is_write("START REPLICA"));
        assert!(is_write("START GROUP_REPLICATION"));
        assert!(is_write("INSTALL PLUGIN x SONAME 'x.so'"));
        assert!(is_write("UNINSTALL PLUGIN x"));
        assert!(is_write("SET PERSIST max_connections = 1"));
        assert!(is_write("SET PERSIST_ONLY max_connections = 1"));
        // legitimate neighbors keep their classification
        assert!(!is_write("START TRANSACTION"));
        assert!(!is_write("START TRANSACTION READ ONLY"));
        assert!(!is_write("SET SESSION x = 1"));
        assert!(!is_write("SET @v = 1"));
        assert!(is_write("SET GLOBAL max_connections = 1"));
        assert!(!is_write("SELECT shutdown FROM t"));   // column, not verb
    }

    /// A WHERE hidden inside a CTE body or subquery must not excuse a
    /// WHERE-less outer UPDATE/DELETE.
    #[test]
    fn where_must_sit_at_the_write_verbs_own_depth() {
        assert!(is_unfiltered_write("WITH x AS (SELECT 1 WHERE true) DELETE FROM t"));
        assert!(!is_unfiltered_write("WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM x)"));
        assert!(!is_unfiltered_write("DELETE FROM t USING u WHERE t.id=u.id"));
        assert!(!is_unfiltered_write("DELETE FROM t WHERE EXISTS(SELECT 1)"));
        // subquery WHERE does not excuse the outer write either
        assert!(is_unfiltered_write("UPDATE t SET a=(SELECT max(x) FROM s WHERE s.id=1)"));
        // a data-modifying CTE is judged by the WHERE inside its own parens
        assert!(is_unfiltered_write("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"));
        assert!(!is_unfiltered_write("WITH d AS (DELETE FROM t WHERE id=1 RETURNING *) SELECT * FROM d"));
    }

    /// T-SQL EXEC runs a body the guard cannot see — blocked like EXECUTE.
    #[test]
    fn tsql_exec_is_a_write() {
        assert!(is_write("EXEC('DELETE FROM t')"));
        assert!(is_write("EXEC sp_executesql N'DROP TABLE t'"));
        assert!(is_write("EXECUTE w(1)"));   // unchanged
        assert!(!is_write("SELECT exec_count FROM stats"));
    }
}

#[cfg(test)]
mod dialect_tests {
    //! Probe tests for the engine-blindness bypasses: each asserts the exact
    //! payload from the audit is now classified the way the engine parses it.
    //! The engine-less wrappers deliberately keep their historical MySQL
    //! behavior (see `Dialect`), so every probe passes the engine in.
    use crate::db::types::Engine::*;
    use super::{is_unfiltered_write, is_unfiltered_write_for, is_write, is_write_for};

    /// `/* a /* b */ c */ DROP TABLE t` — PG and T-SQL nest block comments,
    /// so the DROP is live SQL; blanking only to the first `*/` hid it.
    #[test]
    fn nested_block_comments_cannot_smuggle_writes() {
        for eng in [Postgres, SqlServer] {
            assert!(is_write_for(Some(eng), "/* a /* b */ c */ DROP TABLE t"));
            // a balanced nested comment is still just a comment
            assert!(!is_write_for(Some(eng), "/* a /* b */ c */ SELECT 1"));
        }
        // MySQL does NOT nest: the comment ends at the first `*/` and what
        // follows is live SQL — depth-counting here would blank the DROP.
        assert!(is_write_for(Some(Mysql), "/* /* */ DROP TABLE t -- */"));
    }

    /// `'x\'; DROP TABLE t; --'` — on PG (standard_conforming_strings),
    /// T-SQL and SQLite the string ends at the quote and the DROP is real;
    /// treating the backslash as an escape blanked the whole tail.
    #[test]
    fn backslash_escapes_only_where_the_engine_says_so() {
        for eng in [Postgres, SqlServer, Sqlite, Duckdb] {
            assert!(is_write_for(Some(eng), "'x\\'; DROP TABLE t; --'"));
        }
        // MySQL and ClickHouse: it really is one long string literal.
        assert!(!is_write_for(Some(Mysql), "'x\\'; DROP TABLE t; --'"));
        assert!(!is_write_for(Some(Clickhouse), "'x\\'; DROP TABLE t; --'"));
    }

    /// `SELECT 1 # 2; DROP TABLE t` — `#` is PostgreSQL's XOR operator, not
    /// a comment; blanking to end-of-line erased the DROP. And on T-SQL,
    /// `#tmp` is a temp table, so `DELETE FROM #tmp WHERE …` kept its WHERE.
    #[test]
    fn hash_is_a_comment_only_on_mysql() {
        assert!(is_write_for(Some(Postgres), "SELECT 1 # 2; DROP TABLE t"));
        assert!(!is_unfiltered_write_for(Some(SqlServer), "DELETE FROM #tmp WHERE id=1"));
        assert!(is_unfiltered_write_for(Some(SqlServer), "DELETE FROM #tmp"));
        // MySQL: `#` really does comment out the rest of the line.
        assert!(!is_write_for(Some(Mysql), "SELECT 1 # ; DROP TABLE t"));
    }

    /// Dollar quotes exist on PostgreSQL and DuckDB only. Elsewhere `$tag$`
    /// is identifier text, and blanking between two of them hides the
    /// statements in between.
    #[test]
    fn dollar_quotes_blank_only_where_the_engine_has_them() {
        // PG: the `where` is string content — it must not excuse the missing
        // WHERE on the UPDATE.
        assert!(is_unfiltered_write_for(Some(Postgres), "UPDATE t SET body = $$ where $$"));
        assert!(!is_write_for(Some(Postgres), "SELECT $$ into $$ FROM t"));
        // MySQL: `$a$` is an identifier; the DROP between two of them is live.
        assert!(is_write_for(Some(Mysql), "SELECT 1 $a$; DROP TABLE t; SELECT 1 $a$"));
        assert!(!is_write_for(Some(Mysql), "SELECT $a$ FROM t"));
    }

    /// On PostgreSQL, SET (default_)transaction_read_only flips the
    /// driver-level read-only backstop the pool sets at connect — a write as
    /// far as the guard is concerned, like SET GLOBAL on MySQL.
    #[test]
    fn pg_set_readonly_flip_is_a_write() {
        for sql in [
            "SET default_transaction_read_only = off",
            "SET transaction_read_only = on",
            "SET SESSION default_transaction_read_only TO off",
            "set local transaction_read_only = on",
            "SET  SESSION   transaction_read_only=off",
        ] {
            assert!(is_write_for(Some(Postgres), sql), "{sql}");
        }
        // ordinary session settings stay reads
        assert!(!is_write_for(Some(Postgres), "SET work_mem = '64MB'"));
        assert!(!is_write_for(Some(Postgres), "SET SESSION statement_timeout = 1000"));
        assert!(!is_write_for(Some(Postgres), "SET LOCAL search_path = public"));
        // the rule is PG-only — other engines have no such backstop here
        assert!(!is_write_for(Some(Mysql), "SET SESSION sql_mode = 'x'"));
        assert!(!is_write("SET default_transaction_read_only = off"));
    }

    /// The flip spellings that hide from blanked text: a QUOTED GUC name is
    /// erased by blanking (PG's `"…"` is an identifier, not a string), and
    /// SET SESSION CHARACTERISTICS never names the GUC at all. Both used to
    /// sail past the guard and undo the pool's read-only backstop.
    #[test]
    fn pg_set_readonly_quoted_and_characteristics_spelling_is_a_write() {
        for sql in [
            // quoted GUC names — GUC lookup is case-insensitive even quoted
            r#"SET "transaction_read_only" = off"#,
            r#"SET "TRANSACTION_READ_ONLY" = off"#,
            r#"SET SESSION "default_transaction_read_only" TO 'off'"#,
            r#"set local "transaction_read_only" = on"#,
            // dotted spellings — a custom `x.transaction_read_only`
            // placeholder is not the real GUC, but doubt blocks (safe side)
            r#"SET foo."transaction_read_only" = off"#,
            r#"SET "foo".transaction_read_only = off"#,
            r#"SET "foo"."default_transaction_read_only" = off"#,
            // SET SESSION CHARACTERISTICS AS TRANSACTION … READ WRITE
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "set session characteristics as transaction read write",
            "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE, DEFERRABLE",
            // behind comments and stacked behind a read
            "SET /* x */ SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "-- lead\nSET \"transaction_read_only\" = off",
            "SELECT 1; SET \"transaction_read_only\" = off",
            "SELECT 1; SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
        ] {
            assert!(is_write_for(Some(Postgres), sql), "{sql}");
        }
    }

    /// The legitimate neighbors: READ ONLY / ISOLATION LEVEL characteristics,
    /// ordinary (and quoted) session GUCs, and the flip words inside strings
    /// or comments must NOT be blocked — a read-only PG session whose every
    /// SET errors would be useless.
    #[test]
    fn pg_set_readonly_neighbors_stay_reads() {
        for sql in [
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
            "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE",
            "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY, DEFERRABLE",
            "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
            "SET search_path = public",
            r#"SET "search_path" = 'read write'"#,   // quoted GUC, value names the words
            r#"SET "my ext"."read write" = 'x'"#,    // quoted custom GUC named like the mode
            "SET TIME ZONE 'UTC'",
            "SELECT 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE'",
            "SELECT 1 -- SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "SET work_mem = '64MB'",
            "SET SESSION statement_timeout = 1000",
        ] {
            assert!(!is_write_for(Some(Postgres), sql), "{sql} was called a write");
        }
        // non-PG engines never take this branch (owner decision: MySQL's
        // session read-only switch stays user-managed)
        assert!(!is_write_for(Some(Mysql),
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE"));
        assert!(!is_write_for(Some(Mysql), r#"SET "transaction_read_only" = off"#));
    }

    /// The engine-less wrappers keep the historical MySQL-leaning behavior so
    /// callers that predate engine threading are unchanged — which is exactly
    /// why enforcement paths holding a session engine must use the `*_for`
    /// variants: each assertion below is a residual bypass when the engine is
    /// not threaded.
    #[test]
    fn the_engine_less_wrapper_keeps_historical_behavior() {
        // backslash escapes strings: the tail stays inside the literal
        assert!(!is_write("'x\\'; DROP TABLE t; --'"));
        // `#` comments out the rest of the line
        assert!(!is_write("SELECT 1 # 2; DROP TABLE t"));
        // dollar-quoted bodies are blanked
        assert!(is_unfiltered_write("UPDATE t SET body = $$ where $$"));
        // block comments do not nest: `c */` stays visible, so the statement
        // leads with `c` and the DROP — though visible text — is not leading.
        // This is the residual gap only engine threading closes.
        assert!(!is_write("/* a /* b */ c */ DROP TABLE t"));
    }
}

