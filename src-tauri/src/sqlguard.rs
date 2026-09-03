//! Server-side write-statement detection — defence in depth behind the UI's
//! client guard (src/utils/sqlGuard.ts). A read-only connection must reject
//! writes even if the frontend guard is bypassed (a data-modifying CTE, an
//! `EXPLAIN ANALYZE DELETE`, injected webview JS, or a raw IPC call).
//!
//! Detection is intentionally broad — a false positive blocks a read (safe);
//! a false negative runs a write on a read-only server (unsafe). When in
//! doubt we block.

/// Replace the contents of string literals, quoted identifiers, dollar-quoted
/// bodies and comments with spaces, preserving overall structure (parens,
/// keywords, statement separators). Operates on `char`s so UTF-8 identifiers
/// are handled safely.
fn blank(sql: &str) -> String {
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
        if c == '#' {
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
            while i < n && !(cs[i] == '*' && i + 1 < n && cs[i + 1] == '/') { out.push(' '); i += 1; }
            if i < n { out.push(' '); i += 1; }        // '*'
            if i < n { out.push(' '); i += 1; }        // '/'
            continue;
        }
        // PostgreSQL dollar-quote:  $tag$ ... $tag$   (tag may be empty)
        if c == '$' {
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
                // backslash escape (not for backtick-quoted identifiers)
                if cs[i] == '\\' && c != '`' && i + 1 < n {
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
fn statement_is_write(blanked: &str) -> bool {
    let kw = first_word(blanked);
    if kw.is_empty() { return false; }
    if WRITE_KEYWORDS.contains(&kw.as_str()) { return true; }
    if kw == "set" {
        // SET GLOBAL / SET PERSIST / SET PERSIST_ONLY mutate server state;
        // session/user variables do not.
        let second = word_after(blanked, kw.len());
        return matches!(second.as_str(), "global" | "persist" | "persist_only");
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
        return statement_is_write(&rest);
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
pub fn is_write(sql: &str) -> bool {
    let blanked = blank(sql);
    blanked.split(';').any(statement_is_write)
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
    let blanked = blank(sql);
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
    let blanked = blank(sql);
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
    if is_dangerous_ddl(sql) && !guard.prod_allow_ddl {
        return Err("blocked on prod: destructive DDL (DROP/TRUNCATE/ALTER/RENAME/GRANT/REVOKE) \
                    — enable 'Allow destructive DDL' on the connection to permit".into());
    }
    if is_unfiltered_write(sql) && !guard.prod_allow_unfiltered_write {
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
    //! Regression tests for the 2026-08 guard-hardening review (findings.md
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

