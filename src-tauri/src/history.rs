/// Query history stored in an in-process SQLite database.
/// Kept simple: no ORM, raw sqlx queries.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{SqlitePool, Row};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id:           i64,
    pub connection_id: String,
    pub engine:       String,
    pub sql:          String,
    pub execution_ms: i64,
    pub rows_returned: i64,
    pub error:        Option<String>,
    pub created_at:   String,
}

/// Shared history store handle.
///
/// The pool itself — no mutex. `SqlitePool` is `Sync + Clone` and already
/// serialises (max_connections = 1), so the old `Arc<Mutex<SqlitePool>>` added
/// nothing but contention: every hot-path history/audit insert stalled behind
/// whatever slow read held the lock (a 5 000-row digest scan, an audit LIKE).
/// Multi-statement atomicity, where needed, uses explicit SQLite transactions
/// (`pool.begin()`), which the write sites already do.
pub type HistoryStore = SqlitePool;

pub async fn open(data_dir: &std::path::Path) -> Result<HistoryStore> {
    let db_path = data_dir.join("history.db");
    // WAL + synchronous=NORMAL, applied to every pooled connection: history
    // writes ride on the query critical path, and SQLite's defaults (rollback
    // journal + synchronous=FULL) fsync on every commit. The same settings
    // db/sqlite.rs gives a freshly created user file.
    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal);
    // One connection: SQLite serialises writers anyway, so a deeper pool
    // would only add checkout churn.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await?;
    migrate(&pool).await?;
    Ok(pool)
}

/// In-memory fallback store: same schema, nothing persisted. The startup path
/// uses it when history.db cannot be opened (corruption, a stale WAL from a
/// crashed second instance) — running with amnesiac history beats panicking
/// before any window exists (WP-10 10.4).
pub async fn open_in_memory() -> Result<HistoryStore> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().in_memory(true))
        .await?;
    migrate(&pool).await?;
    Ok(pool)
}

async fn migrate(pool: &SqlitePool) -> Result<()> {
    // One transaction for the whole migration: each statement used to be its
    // own autocommit, ~35 of them on every launch.
    let mut tx = pool.begin().await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS query_history (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id  TEXT    NOT NULL,
            engine         TEXT    NOT NULL,
            sql            TEXT    NOT NULL,
            execution_ms   INTEGER NOT NULL DEFAULT 0,
            rows_returned  INTEGER NOT NULL DEFAULT 0,
            error          TEXT,
            created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        )"
    )
    .execute(&mut *tx).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_history_conn ON query_history(connection_id, created_at DESC)"
    )
    .execute(&mut *tx).await?;

    // The connection-less search branches order by created_at alone — without
    // this, per-keystroke history search was a full-table scan + sort.
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_history_created ON query_history(created_at DESC)"
    )
    .execute(&mut *tx).await?;

    // Multi-server execution log: one run + one row per target server
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS multi_runs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            sql        TEXT    NOT NULL,
            total      INTEGER NOT NULL,
            ok_count   INTEGER NOT NULL DEFAULT 0,
            err_count  INTEGER NOT NULL DEFAULT 0,
            total_ms   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        )"
    )
    .execute(&mut *tx).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS multi_run_results (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id          INTEGER NOT NULL,
            connection_id   TEXT    NOT NULL,
            connection_name TEXT    NOT NULL,
            ok              INTEGER NOT NULL,
            rows_returned   INTEGER NOT NULL DEFAULT 0,
            rows_affected   INTEGER,
            execution_ms    INTEGER NOT NULL DEFAULT 0,
            error           TEXT
        )"
    )
    .execute(&mut *tx).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_multi_results_run ON multi_run_results(run_id)"
    )
    .execute(&mut *tx).await?;

    // Audit log: one row per executed statement — proofs for who/what/when
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS audit_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at      TEXT    NOT NULL,
            ended_at        TEXT    NOT NULL,
            duration_ms     INTEGER NOT NULL,
            connection_name TEXT    NOT NULL,
            db_user         TEXT    NOT NULL DEFAULT '',
            engine          TEXT    NOT NULL,
            ok              INTEGER NOT NULL,
            rows_out        INTEGER NOT NULL DEFAULT 0,
            rows_affected   INTEGER,
            error           TEXT,
            sql             TEXT    NOT NULL
        )"
    )
    .execute(&mut *tx).await?;

    // Attribution added after the table shipped, so it arrives as ALTERs an
    // existing database can take. SQLite has no `ADD COLUMN IF NOT EXISTS`;
    // adding one that is already there is an error, and that error is the
    // "already migrated" signal — there is nothing else to do about it.
    //
    // Why each column exists: an audit line that says only *what* ran cannot
    // answer the question people actually bring to an audit log — which tab,
    // against which database, as part of which run, and was it something the
    // user typed or something a panel did on its own.
    for add in [
        // Groups the statements of one Run into a single unit, so a 10-statement
        // script reads as one run rather than ten unrelated rows.
        "ALTER TABLE audit_log ADD COLUMN run_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE audit_log ADD COLUMN stmt_index INTEGER",
        "ALTER TABLE audit_log ADD COLUMN stmt_total INTEGER",
        // Which connection instance and which tab within it.
        "ALTER TABLE audit_log ADD COLUMN session_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE audit_log ADD COLUMN tab_title TEXT NOT NULL DEFAULT ''",
        // The database/schema in effect — the same statement means different
        // things against two schemas, and without this the row cannot say which.
        "ALTER TABLE audit_log ADD COLUMN database TEXT NOT NULL DEFAULT ''",
        // What initiated it: editor, browser, panel, shell, kill, datagen.
        "ALTER TABLE audit_log ADD COLUMN source TEXT NOT NULL DEFAULT 'editor'",
        // A stable class for the failure, from apperror::ErrorCode.
        //
        // `error` holds the server's prose, which is what a person needs — but
        // prose cannot be grouped. "How often are we losing connections?" and
        // "did the timeout change help?" are questions the log could not answer
        // at all, because every wording variant is a distinct string. Empty on
        // success and on rows written before this column existed.
        "ALTER TABLE audit_log ADD COLUMN error_code TEXT NOT NULL DEFAULT ''",
        // The server's own error number — 1146, 42P01 — and its SQLSTATE.
        // `error_code` above is TxUI's coarse class; this is the identity of
        // the failure, and the thing anyone actually searches for.
        "ALTER TABLE audit_log ADD COLUMN db_code TEXT NOT NULL DEFAULT ''",
        // Same two on a fleet run: "all twelve replicas returned 1146" and
        // "eleven returned 1146, one returned 1045" are different incidents,
        // and prose alone cannot tell them apart at a glance.
        "ALTER TABLE multi_run_results ADD COLUMN error_code TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE multi_run_results ADD COLUMN db_code TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE audit_log ADD COLUMN sqlstate TEXT NOT NULL DEFAULT ''",
    ] {
        let _ = sqlx::query(add).execute(&mut *tx).await;
    }

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_audit_started ON audit_log(started_at DESC)"
    )
    .execute(&mut *tx).await?;

    // Pulling one run out of a long audit log is the commonest lookup after
    // "what happened at 14:03", and a scan over every statement ever run is a
    // visible pause once the table is large.
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log(run_id)"
    )
    .execute(&mut *tx).await?;

    // Counting failures by class over a time range is the whole reason the
    // column exists; without this it is a scan of every row ever written.
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_audit_error_code \
         ON audit_log(error_code, started_at DESC) WHERE error_code <> ''"
    )
    .execute(&mut *tx).await?;

    // Saved queries / snippets
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS saved_queries (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            folder     TEXT    NOT NULL DEFAULT '',
            sql        TEXT    NOT NULL,
            created_at TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
        )"
    )
    .execute(&mut *tx).await?;

    // Stored SQL templates (`?name` editor expansion). `body` uses CodeMirror
    // snippet syntax (${1} tabstop / ${1:default} / ${0} final) stored raw.
    // `builtin` marks seeded rows; see seed_sql_templates for why deleting one
    // is permanent even though seeding now runs on every start.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sql_templates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    UNIQUE NOT NULL,
            engine      TEXT,
            description TEXT    NOT NULL DEFAULT '',
            body        TEXT    NOT NULL,
            builtin     INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )"
    )
    .execute(&mut *tx).await?;

    // QAN-style digest snapshots (pg_stat_statements / performance_schema
    // digests): a header per saved snapshot plus one row per digest. The
    // *cumulative* counters are stored — the same shape the panels capture —
    // and deltas are computed at read time (diff_digest_rows), so any two
    // snapshots can be compared, not just adjacent ones. Storing pre-computed
    // deltas would fix the baseline at write time and lose that.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS digest_snapshots (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id TEXT    NOT NULL,
            engine        TEXT    NOT NULL,
            label         TEXT    NOT NULL DEFAULT '',
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        )"
    )
    .execute(&mut *tx).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_digest_snaps_conn \
         ON digest_snapshots(connection_id, created_at DESC)"
    )
    .execute(&mut *tx).await?;

    // Normalized statement texts, deduped by (connection, digest): a digest's
    // text changes rarely if ever, so storing it once per digest instead of
    // once per snapshot-row keeps N snapshots of M digests at M texts, not N×M.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS digest_texts (
            connection_id TEXT NOT NULL,
            digest_id     TEXT NOT NULL,
            query_text    TEXT NOT NULL,
            PRIMARY KEY (connection_id, digest_id)
        )"
    )
    .execute(&mut *tx).await?;

    // Cumulative counters per digest per snapshot. Column names follow the
    // shared shape of the two live panels: calls / total_ms / mean_ms /
    // rows_total (rows_examined for MySQL, rows for PG) / shared_blks_* (PG).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS digest_snapshot_rows (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id     INTEGER NOT NULL REFERENCES digest_snapshots(id) ON DELETE CASCADE,
            digest_id       TEXT    NOT NULL,
            calls           INTEGER NOT NULL,
            total_ms        REAL    NOT NULL,
            mean_ms         REAL    NOT NULL DEFAULT 0,
            rows_total      INTEGER NOT NULL DEFAULT 0,
            shared_blks_hit  INTEGER NOT NULL DEFAULT 0,
            shared_blks_read INTEGER NOT NULL DEFAULT 0
        )"
    )
    .execute(&mut *tx).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_digest_rows_snap ON digest_snapshot_rows(snapshot_id)"
    )
    .execute(&mut *tx).await?;

    // The dead-text cleanup correlates on digest_id; without this it scans
    // every snapshot row of the connection on each save.
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_digest_rows_digest ON digest_snapshot_rows(digest_id)"
    )
    .execute(&mut *tx).await?;

    // Deadlock events: one row per detected deadlock, recorded when the
    // analyzer panel sees one (open/refresh). `raw` is the whole InnoDB
    // LATEST DETECTED DEADLOCK section (or the counters snapshot on
    // PostgreSQL), `parsed` the wait-for graph as JSON — the panel re-renders
    // a past incident without re-parsing, and the raw text stays for the day
    // the parser learns something new.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS deadlock_events (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id TEXT    NOT NULL,
            engine        TEXT    NOT NULL,
            detected_at   TEXT    NOT NULL DEFAULT '',
            victim        TEXT    NOT NULL DEFAULT '',
            txn_count     INTEGER NOT NULL DEFAULT 0,
            raw           TEXT    NOT NULL,
            parsed        TEXT    NOT NULL DEFAULT '',
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        )"
    )
    .execute(&mut *tx).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_deadlock_conn \
         ON deadlock_events(connection_id, created_at DESC)"
    )
    .execute(&mut *tx).await?;

    tx.commit().await?;

    seed_sql_templates(pool).await?;

    Ok(())
}

/// Every curated template that has ever shipped, in shipping order.
///
/// Append only. `LEGACY_SEEDED` below records how far this list had got when
/// per-name seed tracking was introduced, so entries before that point are not
/// re-inserted for anyone who had already deleted them.
const BUILTINS: &[(&str, Option<&str>, &str, &str)] = &[
    ("processlist", Some("mysql"), "Sessions by user",
     "SELECT * FROM information_schema.PROCESSLIST WHERE USER = '${1}' ORDER BY TIME DESC;"),
    ("longqueries", Some("mysql"), "Queries running longer than N seconds",
     "SELECT * FROM information_schema.PROCESSLIST WHERE COMMAND = 'Query' AND TIME > ${1:60} ORDER BY TIME DESC;"),
    ("locks", Some("mysql"), "Current InnoDB locks",
     "SELECT * FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = '${1}' ORDER BY THREAD_ID;"),
    ("tablestats", Some("mysql"), "Table sizes in a schema",
     "SELECT TABLE_NAME, TABLE_ROWS, ROUND(DATA_LENGTH/1048576) AS data_mb, ROUND(INDEX_LENGTH/1048576) AS index_mb FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${1}' ORDER BY DATA_LENGTH DESC;"),
    ("activity", Some("postgres"), "Active queries with duration",
     "SELECT pid, usename, state, wait_event, now() - query_start AS duration, query FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() ORDER BY duration DESC;"),
    ("pglocks", Some("postgres"), "Locks not yet granted (waiters)",
     "SELECT * FROM pg_locks WHERE NOT GRANTED;"),
    // ── added after per-name seed tracking ──
    ("stats", Some("mysql"), "InnoDB persistent stats for one table",
     "SELECT * FROM mysql.innodb_table_stats WHERE table_name = '${1}';"),
];

/// The builtins that existed before `seeded_templates` did. On the first start
/// after the upgrade these are marked as already-seeded rather than inserted,
/// which is what stops a builtin the user deleted long ago from coming back.
const LEGACY_SEEDED: &[&str] = &[
    "processlist", "longqueries", "locks", "tablestats", "activity", "pglocks",
];

/// Curated starter templates.
///
/// A template is inserted the first time its name is seen and never again, so
/// deleting a builtin is permanent — but a builtin added in a later release
/// still reaches installs that already have a populated table. The old
/// "seed only when the table is empty" rule could not do the second part:
/// every template added after the first release was invisible to every
/// existing user.
async fn seed_sql_templates(pool: &SqlitePool) -> Result<()> {
    let mut tx = pool.begin().await?;

    let fresh_db: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sql_templates")
        .fetch_one(&mut *tx).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS seeded_templates (
            name      TEXT PRIMARY KEY,
            seeded_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"
    )
    .execute(&mut *tx).await?;

    // Backfill: an existing install (templates present, nothing tracked yet)
    // has already had every legacy builtin offered to it once.
    let tracked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM seeded_templates")
        .fetch_one(&mut *tx).await?;
    if tracked == 0 && fresh_db > 0 {
        for name in LEGACY_SEEDED {
            sqlx::query("INSERT OR IGNORE INTO seeded_templates (name) VALUES (?)")
                .bind(name)
                .execute(&mut *tx).await?;
        }
    }

    for (name, engine, description, body) in BUILTINS {
        let seen: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM seeded_templates WHERE name = ?"
        )
        .bind(name)
        .fetch_one(&mut *tx).await?;
        if seen > 0 { continue; }

        // INSERT OR IGNORE: a user template may already own this name, and
        // their version must win over ours.
        sqlx::query(
            "INSERT OR IGNORE INTO sql_templates (name, engine, description, body, builtin)
             VALUES (?, ?, ?, ?, 1)"
        )
        .bind(name).bind(engine).bind(description).bind(body)
        .execute(&mut *tx).await?;
        sqlx::query("INSERT OR IGNORE INTO seeded_templates (name) VALUES (?)")
            .bind(name)
            .execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Rolling cap on query_history rows. The table used to grow without bound
/// (the old comment admitted it) — the oldest roll off past the cap, the same
/// trade the digest/deadlock stores in this file make. Generous: at a few
/// hundred bytes a row this is tens of MB, and the digest lookup only ever
/// scans the newest DIGEST_SCAN_ROWS anyway.
const MAX_HISTORY_ROWS: i64 = 100_000;

pub async fn insert(
    store: &HistoryStore,
    connection_id: &str,
    engine: &str,
    sql: &str,
    execution_ms: i64,
    rows_returned: i64,
    error: Option<&str>,
) -> Result<i64> {
    insert_capped(store, connection_id, engine, sql, execution_ms, rows_returned, error, MAX_HISTORY_ROWS).await
}

/// `cap` is a parameter so the retention test does not have to insert 100 001
/// rows to see one roll off (the digest-snapshot store's pattern).
#[allow(clippy::too_many_arguments)]
async fn insert_capped(
    store: &HistoryStore,
    connection_id: &str,
    engine: &str,
    sql: &str,
    execution_ms: i64,
    rows_returned: i64,
    error: Option<&str>,
    cap: i64,
) -> Result<i64> {
    let pool = store;
    let id = sqlx::query(
        "INSERT INTO query_history (connection_id, engine, sql, execution_ms, rows_returned, error)
         VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(connection_id)
    .bind(engine)
    .bind(sql)
    .bind(execution_ms)
    .bind(rows_returned)
    .bind(error)
    .execute(&*pool).await?
    .last_insert_rowid();
    // Retention: delete everything older than the cap-th newest row. With
    // fewer rows the subquery yields NULL and `id <= NULL` matches nothing.
    // Inserts are already off the query critical path (spawned), so the extra
    // indexed delete costs the user nothing.
    sqlx::query(
        "DELETE FROM query_history WHERE id <= \
         (SELECT id FROM query_history ORDER BY id DESC LIMIT 1 OFFSET ?)"
    )
    .bind(cap)
    .execute(&*pool).await?;
    Ok(id)
}

pub async fn search(
    store: &HistoryStore,
    connection_id: Option<&str>,
    query: Option<&str>,
    limit: i64,
) -> Result<Vec<HistoryEntry>> {
    let pool = store;

    let rows = match (connection_id, query) {
        (Some(cid), Some(q)) => {
            let pattern = format!("%{}%", q);
            sqlx::query(
                "SELECT id, connection_id, engine, sql, execution_ms, rows_returned, error, created_at \
                 FROM query_history WHERE connection_id = ? AND sql LIKE ? \
                 ORDER BY created_at DESC LIMIT ?"
            )
            .bind(cid).bind(pattern).bind(limit)
            .fetch_all(&*pool).await?
        }
        (Some(cid), None) => {
            sqlx::query(
                "SELECT id, connection_id, engine, sql, execution_ms, rows_returned, error, created_at \
                 FROM query_history WHERE connection_id = ? \
                 ORDER BY created_at DESC LIMIT ?"
            )
            .bind(cid).bind(limit)
            .fetch_all(&*pool).await?
        }
        (None, Some(q)) => {
            let pattern = format!("%{}%", q);
            sqlx::query(
                "SELECT id, connection_id, engine, sql, execution_ms, rows_returned, error, created_at \
                 FROM query_history WHERE sql LIKE ? \
                 ORDER BY created_at DESC LIMIT ?"
            )
            .bind(pattern).bind(limit)
            .fetch_all(&*pool).await?
        }
        (None, None) => {
            sqlx::query(
                "SELECT id, connection_id, engine, sql, execution_ms, rows_returned, error, created_at \
                 FROM query_history ORDER BY created_at DESC LIMIT ?"
            )
            .bind(limit)
            .fetch_all(&*pool).await?
        }
    };

    Ok(rows.iter().map(|r| HistoryEntry {
        id:            r.get(0),
        connection_id: r.get(1),
        engine:        r.get(2),
        sql:           r.get(3),
        execution_ms:  r.get(4),
        rows_returned: r.get(5),
        error:         r.get(6),
        created_at:    r.get(7),
    }).collect())
}

pub async fn delete_entry(store: &HistoryStore, id: i64) -> Result<()> {
    let pool = store;
    sqlx::query("DELETE FROM query_history WHERE id = ?")
        .bind(id)
        .execute(&*pool).await?;
    Ok(())
}

pub async fn clear_connection(store: &HistoryStore, connection_id: &str) -> Result<()> {
    let pool = store;
    sqlx::query("DELETE FROM query_history WHERE connection_id = ?")
        .bind(connection_id)
        .execute(&*pool).await?;
    Ok(())
}

// ── Statement fingerprints (per-statement digest stats) ─────────────────────
//
// The gutter tooltip's "ran N× in history · p95 …" line. The frontend
// fingerprints the statement it just ran with utils/slowLogParse.ts
// `fingerprint`; the rows here are fingerprinted with THIS Rust mirror, and
// the two must agree byte-for-byte or the lookup never matches. The parity
// tests at the bottom pin the shared cases — change one side, change both.

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Collapse `IN (?, ?, …)` to `IN (?)` — the last step of the TS fingerprint,
/// applied there before the whitespace collapse, here after it (single spaces
/// make the parse trivial either way, and the result is identical).
fn collapse_in_lists(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let is_in = (chars[i] == 'i' || chars[i] == 'I')
            && matches!(chars.get(i + 1), Some('n') | Some('N'))
            && !out.chars().last().is_some_and(is_word_char);
        if is_in {
            // Try `\s* ( \s* ? ( \s* , \s* ? )* \s* )` — on any mismatch the
            // text is left alone, exactly what the regex does.
            let mut j = i + 2;
            while j < chars.len() && chars[j].is_whitespace() { j += 1; }
            if chars.get(j) == Some(&'(') {
                j += 1;
                let mut k = j;
                let mut matched = true;
                let mut done = false;
                while !done {
                    while k < chars.len() && chars[k].is_whitespace() { k += 1; }
                    if chars.get(k) == Some(&'?') {
                        k += 1;
                        while k < chars.len() && chars[k].is_whitespace() { k += 1; }
                        match chars.get(k) {
                            Some(',') => { k += 1; }
                            Some(')') => { k += 1; done = true; }
                            _ => { matched = false; done = true; }
                        }
                    } else {
                        matched = false;
                        done = true;
                    }
                }
                if matched {
                    out.push_str("in (?)");
                    i = k;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Normalize a statement to its digest fingerprint: comments stripped, string
/// and number literals → `?`, IN-lists collapsed, whitespace collapsed,
/// lowercased. Mirrors utils/slowLogParse.ts `fingerprint`.
pub fn fingerprint_sql(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // Block comment — unterminated eats the rest, like the regex's
        // non-match leaving the opener literal… except JS `/\*.*?\*/` simply
        // never matches an unterminated block, so keep it literal instead.
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            let mut j = i + 2;
            while j + 1 < chars.len() && !(chars[j] == '*' && chars[j + 1] == '/') { j += 1; }
            if j + 1 < chars.len() {
                out.push(' ');
                i = j + 2;
            } else {
                out.push('/');
                i += 1;
            }
            continue;
        }
        // Line comment — always runs to the newline or EOF.
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            let mut j = i + 2;
            while j < chars.len() && chars[j] != '\n' { j += 1; }
            out.push(' ');
            i = j;
            continue;
        }
        // String / quoted literal with backslash escapes. Unterminated: the
        // regex never matched, so the quote stays literal.
        if c == '\'' || c == '"' {
            let mut j = i + 1;
            let mut closed = false;
            while j < chars.len() {
                if chars[j] == '\\' { j += 2; continue; }
                if chars[j] == c { closed = true; j += 1; break; }
                j += 1;
            }
            if closed {
                out.push('?');
                i = j;
            } else {
                out.push(c);
                i += 1;
            }
            continue;
        }
        // Number literal — `\b\d+(\.\d+)?\b`: a digit run (optionally with a
        // decimal tail) bounded by non-word characters on both ends. `123abc`
        // matches nothing in JS (the trailing boundary fails for every
        // backtrack), so leave it literal here too.
        if c.is_ascii_digit() && !out.chars().last().is_some_and(is_word_char) {
            let mut j = i;
            while j < chars.len() && chars[j].is_ascii_digit() { j += 1; }
            if chars.get(j) == Some(&'.')
                && chars.get(j + 1).is_some_and(|d| d.is_ascii_digit())
            {
                j += 1;
                while j < chars.len() && chars[j].is_ascii_digit() { j += 1; }
            }
            if chars.get(j).is_none_or(|&n| !is_word_char(n)) {
                out.push('?');
                i = j;
                continue;
            }
        }
        for lc in c.to_lowercase() { out.push(lc); }
        i += 1;
    }
    // Whitespace collapse + trim.
    let mut collapsed = String::with_capacity(out.len());
    let mut pending_space = false;
    for c in out.chars() {
        if c.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && !collapsed.is_empty() { collapsed.push(' '); }
        collapsed.push(c);
        pending_space = false;
    }
    collapse_in_lists(&collapsed)
}

/// How many recent history rows a digest lookup scans. Fingerprinting is a
/// per-row string pass, so this bounds the lookup's cost on an unbounded
/// table; older runs past the cap simply do not count.
const DIGEST_SCAN_ROWS: i64 = 5000;

/// Digest statistics for one statement fingerprint, from the local query
/// history. snake_case on the wire per the struct-payload convention.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestStats {
    pub runs:      i64,
    pub avg_ms:    f64,
    pub p95_ms:    i64,
    pub last_seen: String,
}

/// Aggregate the successful runs of one statement shape for a connection.
/// `None` (→ null on the wire) when history holds no run of it — a first-time
/// statement is the common case and must not read as an error.
pub async fn digest_stats(
    store: &HistoryStore,
    connection_id: &str,
    fingerprint: &str,
) -> Result<Option<DigestStats>> {
    let pool = store;
    // Errors are excluded: a statement that keeps failing has a duration
    // distribution of its own, and mixing it into the p95 of the successful
    // runs makes both numbers lie.
    let rows = sqlx::query(
        "SELECT sql, execution_ms, created_at FROM query_history \
         WHERE connection_id = ? AND error IS NULL \
         ORDER BY id DESC LIMIT ?"
    )
    .bind(connection_id)
    .bind(DIGEST_SCAN_ROWS)
    .fetch_all(&*pool).await?;

    let mut times: Vec<i64> = Vec::new();
    let mut last_seen = String::new();
    for r in &rows {
        let sql: String = r.get(0);
        if fingerprint_sql(&sql) != fingerprint { continue; }
        times.push(r.get(1));
        // created_at is 'YYYY-MM-DD HH:MM:SS' (UTC) — lexicographic IS
        // chronological on that format, so max() is the latest run.
        let created: String = r.get(2);
        if created > last_seen { last_seen = created; }
    }
    if times.is_empty() { return Ok(None); }

    times.sort_unstable();
    let runs = times.len() as i64;
    let avg_ms = times.iter().sum::<i64>() as f64 / runs as f64;
    // Nearest-rank p95: the smallest value at least 95 % of runs are ≤.
    let p95_ms = times[(runs as f64 * 0.95).ceil() as usize - 1];
    Ok(Some(DigestStats { runs, avg_ms, p95_ms, last_seen }))
}

// ── Digest snapshots (QAN-style store) ───────────────────────────────────────

/// Cap on stored statement text. performance_schema caps DIGEST_TEXT at 1024
/// bytes server-side; pgss query text is unbounded, so this is the bound that
/// keeps a snapshot of long ad-hoc normalized queries from bloating the file.
const MAX_QUERY_TEXT_CHARS: usize = 8000;

/// Snapshots kept per connection. query_history itself is unbounded, but a
/// snapshot is a heavy row-set (one row per digest), so this store gets the
/// bound query_history never needed: the oldest roll off past the cap.
const MAX_SNAPSHOTS_PER_CONN: i64 = 100;

/// One digest row as the panels send it (cumulative counters, snake_case
/// inside the serialized payload per project convention).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestRowIn {
    pub digest_id: String,
    pub query_text: String,
    pub calls: i64,
    pub total_ms: f64,
    pub mean_ms: f64,
    pub rows_total: i64,
    #[serde(default)]
    pub shared_blks_hit: i64,
    #[serde(default)]
    pub shared_blks_read: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestSnapshotMeta {
    pub id: i64,
    pub connection_id: String,
    pub engine: String,
    pub label: String,
    pub rows_count: i64,
    pub created_at: String,
}

/// A stored digest row with its text resolved from digest_texts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredDigestRow {
    pub digest_id: String,
    pub query_text: String,
    pub calls: i64,
    pub total_ms: f64,
    pub mean_ms: f64,
    pub rows_total: i64,
    pub shared_blks_hit: i64,
    pub shared_blks_read: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestSnapshotStored {
    pub meta: DigestSnapshotMeta,
    pub rows: Vec<StoredDigestRow>,
}

/// One entry of a stored-snapshot diff. Mirrors the live pgss diff semantics:
/// `changed` = in both (deltas are the interval's work), `new` = only in the
/// later snapshot (baseline zero), `gone` = only in the earlier one (deltas
/// go negative). Deltas are raw subtractions — a counter reset shows up as a
/// negative d_calls, which is exactly how the panels detect a reset, so the
/// stored diff must not clamp it away.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestDelta {
    pub digest_id: String,
    pub query_text: String,
    pub status: String, // "changed" | "new" | "gone"
    pub d_calls: i64,
    pub d_total_ms: f64,
    pub d_rows: i64,
    pub after_calls: i64,
    pub after_total_ms: f64,
    pub after_mean_ms: f64,
}

fn truncate_text(text: &str) -> String {
    if text.chars().count() <= MAX_QUERY_TEXT_CHARS {
        return text.to_string();
    }
    let mut t: String = text.chars().take(MAX_QUERY_TEXT_CHARS).collect();
    t.push('…');
    t
}

pub async fn save_digest_snapshot(
    store: &HistoryStore,
    connection_id: &str,
    engine: &str,
    label: &str,
    rows: &[DigestRowIn],
) -> Result<i64> {
    save_digest_snapshot_capped(store, connection_id, engine, label, rows, MAX_SNAPSHOTS_PER_CONN).await
}

/// `cap` is a parameter so the retention test does not have to insert 101
/// snapshots to see one roll off.
async fn save_digest_snapshot_capped(
    store: &HistoryStore,
    connection_id: &str,
    engine: &str,
    label: &str,
    rows: &[DigestRowIn],
    cap: i64,
) -> Result<i64> {
    let pool = store;
    // One transaction for the whole snapshot: a snapshot is one logical write,
    // and N digests used to cost 2N autocommit fsyncs while holding the lock.
    let mut tx = pool.begin().await?;
    let snap_id = sqlx::query(
        "INSERT INTO digest_snapshots (connection_id, engine, label) VALUES (?, ?, ?)"
    )
    .bind(connection_id)
    .bind(engine)
    .bind(label)
    .execute(&mut *tx).await?
    .last_insert_rowid();

    for r in rows {
        sqlx::query(
            "INSERT INTO digest_snapshot_rows
                (snapshot_id, digest_id, calls, total_ms, mean_ms, rows_total, shared_blks_hit, shared_blks_read)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(snap_id)
        .bind(&r.digest_id)
        .bind(r.calls)
        .bind(r.total_ms)
        .bind(r.mean_ms)
        .bind(r.rows_total)
        .bind(r.shared_blks_hit)
        .bind(r.shared_blks_read)
        .execute(&mut *tx).await?;

        // Latest text wins: a digest's normalized text can shift across server
        // versions, and the newest wording is the one a diff should show.
        sqlx::query(
            "INSERT INTO digest_texts (connection_id, digest_id, query_text) VALUES (?, ?, ?)
             ON CONFLICT(connection_id, digest_id) DO UPDATE SET query_text = excluded.query_text"
        )
        .bind(connection_id)
        .bind(&r.digest_id)
        .bind(truncate_text(&r.query_text))
        .execute(&mut *tx).await?;
    }

    // Retention: roll off the oldest snapshots beyond the cap. Rows go
    // explicitly rather than relying on the FK cascade firing.
    let doomed: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM digest_snapshots WHERE connection_id = ?
         ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?"
    )
    .bind(connection_id)
    .bind(cap)
    .fetch_all(&mut *tx).await?;
    for id in doomed {
        sqlx::query("DELETE FROM digest_snapshot_rows WHERE snapshot_id = ?")
            .bind(id)
            .execute(&mut *tx).await?;
        sqlx::query("DELETE FROM digest_snapshots WHERE id = ?")
            .bind(id)
            .execute(&mut *tx).await?;
    }

    // Texts no remaining snapshot references are dead weight.
    sqlx::query(
        "DELETE FROM digest_texts WHERE connection_id = ? AND NOT EXISTS (
            SELECT 1 FROM digest_snapshot_rows r
            JOIN digest_snapshots s ON s.id = r.snapshot_id
            WHERE s.connection_id = digest_texts.connection_id
              AND r.digest_id = digest_texts.digest_id)"
    )
    .bind(connection_id)
    .execute(&mut *tx).await?;

    tx.commit().await?;
    Ok(snap_id)
}

pub async fn list_digest_snapshots(
    store: &HistoryStore,
    connection_id: &str,
) -> Result<Vec<DigestSnapshotMeta>> {
    let pool = store;
    let rows = sqlx::query(
        "SELECT s.id, s.connection_id, s.engine, s.label,
                (SELECT COUNT(*) FROM digest_snapshot_rows r WHERE r.snapshot_id = s.id) AS rows_count,
                s.created_at
         FROM digest_snapshots s WHERE s.connection_id = ?
         ORDER BY s.created_at DESC, s.id DESC"
    )
    .bind(connection_id)
    .fetch_all(&*pool).await?;
    Ok(rows.iter().map(|r| DigestSnapshotMeta {
        id:            r.get(0),
        connection_id: r.get(1),
        engine:        r.get(2),
        label:         r.get(3),
        rows_count:    r.get(4),
        created_at:    r.get(5),
    }).collect())
}

/// Fetch one snapshot with texts resolved. Snapshot-local last row wins on a
/// duplicate digest id within the snapshot, matching rowsToSnapshot's
/// collapse-by-key behaviour in the live panels.
pub async fn get_digest_snapshot(store: &HistoryStore, id: i64) -> Result<DigestSnapshotStored> {
    let pool = store;
    let meta_row = sqlx::query(
        "SELECT s.id, s.connection_id, s.engine, s.label,
                (SELECT COUNT(*) FROM digest_snapshot_rows r WHERE r.snapshot_id = s.id) AS rows_count,
                s.created_at
         FROM digest_snapshots s WHERE s.id = ?"
    )
    .bind(id)
    .fetch_one(&*pool).await?;
    let meta = DigestSnapshotMeta {
        id:            meta_row.get(0),
        connection_id: meta_row.get(1),
        engine:        meta_row.get(2),
        label:         meta_row.get(3),
        rows_count:    meta_row.get(4),
        created_at:    meta_row.get(5),
    };

    let rows = sqlx::query(
        "SELECT r.digest_id, COALESCE(t.query_text, '') AS query_text,
                r.calls, r.total_ms, r.mean_ms, r.rows_total, r.shared_blks_hit, r.shared_blks_read
         FROM digest_snapshot_rows r
         LEFT JOIN digest_texts t
           ON t.connection_id = ? AND t.digest_id = r.digest_id
         WHERE r.snapshot_id = ?
         ORDER BY r.total_ms DESC"
    )
    .bind(&meta.connection_id)
    .bind(id)
    .fetch_all(&*pool).await?;

    Ok(DigestSnapshotStored {
        meta,
        rows: rows.iter().map(|r| StoredDigestRow {
            digest_id:        r.get(0),
            query_text:       r.get(1),
            calls:            r.get(2),
            total_ms:         r.get(3),
            mean_ms:          r.get(4),
            rows_total:       r.get(5),
            shared_blks_hit:  r.get(6),
            shared_blks_read: r.get(7),
        }).collect(),
    })
}

pub async fn delete_digest_snapshot(store: &HistoryStore, id: i64) -> Result<()> {
    let pool = store;
    delete_digest_snapshot_locked(&pool, id).await
}

async fn delete_digest_snapshot_locked(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM digest_snapshot_rows WHERE snapshot_id = ?")
        .bind(id)
        .execute(pool).await?;
    sqlx::query("DELETE FROM digest_snapshots WHERE id = ?")
        .bind(id)
        .execute(pool).await?;
    Ok(())
}

// ── Deadlock events (analyzer history) ───────────────────────────────────────

/// Events kept per connection. Each row carries the full raw section and its
/// parsed graph, so like digest snapshots the store gets the bound
/// query_history never needed: the oldest roll off past the cap.
const MAX_DEADLOCK_EVENTS_PER_CONN: i64 = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeadlockEventMeta {
    pub id: i64,
    pub connection_id: String,
    pub engine: String,
    /// Timestamp from the report header; empty when the engine does not give
    /// one (PostgreSQL counters), in which case `created_at` is the truth.
    pub detected_at: String,
    /// Short victim label ("(2) · thread 813"); empty on PG counter rows.
    pub victim: String,
    pub txn_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeadlockEvent {
    pub id: i64,
    pub connection_id: String,
    pub engine: String,
    pub detected_at: String,
    pub victim: String,
    pub txn_count: i64,
    pub raw: String,
    pub parsed: String,
    pub created_at: String,
}

#[allow(clippy::too_many_arguments)]
pub async fn record_deadlock_event(
    store: &HistoryStore,
    connection_id: &str,
    engine: &str,
    detected_at: &str,
    victim: &str,
    txn_count: i64,
    raw: &str,
    parsed: &str,
) -> Result<Option<i64>> {
    record_deadlock_event_capped(
        store, connection_id, engine, detected_at, victim, txn_count, raw, parsed,
        MAX_DEADLOCK_EVENTS_PER_CONN,
    ).await
}

/// Returns the new row id, or None when nothing was recorded.
///
/// `cap` is a parameter so the retention test does not have to insert 51
/// events to see one roll off.
#[allow(clippy::too_many_arguments)]
async fn record_deadlock_event_capped(
    store: &HistoryStore,
    connection_id: &str,
    engine: &str,
    detected_at: &str,
    victim: &str,
    txn_count: i64,
    raw: &str,
    parsed: &str,
    cap: i64,
) -> Result<Option<i64>> {
    let pool = store;

    // Dedupe: the server's "latest deadlock" changes only when a new deadlock
    // happens (and PG counters only when one is counted), so a refresh loop
    // would otherwise store the same incident on every poll. Identical raw
    // text to the newest stored event ⇒ nothing new to record.
    let latest_raw: Option<String> = sqlx::query_scalar(
        "SELECT raw FROM deadlock_events WHERE connection_id = ? ORDER BY id DESC LIMIT 1"
    )
    .bind(connection_id)
    .fetch_optional(&*pool).await?;
    if latest_raw.as_deref() == Some(raw) {
        return Ok(None);
    }

    let id = sqlx::query(
        "INSERT INTO deadlock_events
            (connection_id, engine, detected_at, victim, txn_count, raw, parsed)
         VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(connection_id)
    .bind(engine)
    .bind(detected_at)
    .bind(victim)
    .bind(txn_count)
    .bind(raw)
    .bind(parsed)
    .execute(&*pool).await?
    .last_insert_rowid();

    // Retention: roll off the oldest events beyond the cap.
    sqlx::query(
        "DELETE FROM deadlock_events WHERE connection_id = ? AND id IN (
            SELECT id FROM deadlock_events WHERE connection_id = ?
            ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)"
    )
    .bind(connection_id)
    .bind(connection_id)
    .bind(cap)
    .execute(&*pool).await?;

    Ok(Some(id))
}

pub async fn list_deadlock_events(
    store: &HistoryStore,
    connection_id: &str,
) -> Result<Vec<DeadlockEventMeta>> {
    let pool = store;
    let rows = sqlx::query(
        "SELECT id, connection_id, engine, detected_at, victim, txn_count, created_at
         FROM deadlock_events WHERE connection_id = ?
         ORDER BY created_at DESC, id DESC"
    )
    .bind(connection_id)
    .fetch_all(&*pool).await?;
    Ok(rows.iter().map(|r| DeadlockEventMeta {
        id:            r.get(0),
        connection_id: r.get(1),
        engine:        r.get(2),
        detected_at:   r.get(3),
        victim:        r.get(4),
        txn_count:     r.get(5),
        created_at:    r.get(6),
    }).collect())
}

pub async fn get_deadlock_event(store: &HistoryStore, id: i64) -> Result<DeadlockEvent> {
    let pool = store;
    let r = sqlx::query(
        "SELECT id, connection_id, engine, detected_at, victim, txn_count, raw, parsed, created_at
         FROM deadlock_events WHERE id = ?"
    )
    .bind(id)
    .fetch_one(&*pool).await?;
    Ok(DeadlockEvent {
        id:            r.get(0),
        connection_id: r.get(1),
        engine:        r.get(2),
        detected_at:   r.get(3),
        victim:        r.get(4),
        txn_count:     r.get(5),
        raw:           r.get(6),
        parsed:        r.get(7),
        created_at:    r.get(8),
    })
}

pub async fn delete_deadlock_event(store: &HistoryStore, id: i64) -> Result<()> {
    let pool = store;
    sqlx::query("DELETE FROM deadlock_events WHERE id = ?")
        .bind(id)
        .execute(&*pool).await?;
    Ok(())
}

/// Pure delta math over two stored snapshots — see DigestDelta for semantics.
/// Sorted by total-time increase, then call increase, then digest id, the
/// same "what got slower" ordering the live panels use.
pub fn diff_digest_rows(before: &[StoredDigestRow], after: &[StoredDigestRow]) -> Vec<DigestDelta> {
    use std::collections::HashMap;
    let prev: HashMap<&str, &StoredDigestRow> =
        before.iter().map(|r| (r.digest_id.as_str(), r)).collect();
    let next: HashMap<&str, &StoredDigestRow> =
        after.iter().map(|r| (r.digest_id.as_str(), r)).collect();

    let mut out: Vec<DigestDelta> = Vec::new();
    for a in after {
        let b = prev.get(a.digest_id.as_str());
        let (status, d_calls, d_total, d_rows) = match b {
            Some(b) => ("changed", a.calls - b.calls, a.total_ms - b.total_ms, a.rows_total - b.rows_total),
            None    => ("new", a.calls, a.total_ms, a.rows_total),
        };
        out.push(DigestDelta {
            digest_id: a.digest_id.clone(),
            query_text: a.query_text.clone(),
            status: status.to_string(),
            d_calls,
            d_total_ms: d_total,
            d_rows,
            after_calls: a.calls,
            after_total_ms: a.total_ms,
            after_mean_ms: a.mean_ms,
        });
    }
    for b in before {
        if next.contains_key(b.digest_id.as_str()) { continue; }
        out.push(DigestDelta {
            digest_id: b.digest_id.clone(),
            query_text: b.query_text.clone(),
            status: "gone".to_string(),
            d_calls: -b.calls,
            d_total_ms: -b.total_ms,
            d_rows: -b.rows_total,
            after_calls: 0,
            after_total_ms: 0.0,
            after_mean_ms: 0.0,
        });
    }
    out.sort_by(|x, y| {
        y.d_total_ms.partial_cmp(&x.d_total_ms).unwrap_or(std::cmp::Ordering::Equal)
            .then(y.d_calls.cmp(&x.d_calls))
            .then(x.digest_id.cmp(&y.digest_id))
    });
    out
}

#[cfg(test)]
mod migration_tests {
    /// The audit-log migration has to run against a database that already has
    /// rows in it, which is the case that never gets exercised by a fresh
    /// install. `error_code` arrives as an ALTER with a default, so old rows
    /// must come back readable and be excluded from failure counts rather than
    /// bucketed as a class of their own.
    #[tokio::test]
    async fn error_code_is_added_to_a_database_that_already_has_rows() {
        let dir = std::env::temp_dir().join(format!("txui_hist_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // A database at the previous shape, with a row in it.
        let store = super::open(&dir).await.expect("first open");
        {
            let pool = &store;
            sqlx::query("INSERT INTO audit_log \
                (started_at, ended_at, duration_ms, connection_name, db_user, engine, ok, \
                 rows_out, rows_affected, error, sql) \
                 VALUES ('t','t',1,'c','u','mysql',0,0,NULL,'Lost connection','SELECT 1')")
                .execute(&*pool).await.expect("insert old-shape row");
        }

        // Re-opening runs the migrations again — the ALTER for a column that
        // already exists is the "already migrated" signal and must not abort.
        let store2 = super::open(&dir).await.expect("second open");
        let pool = &store2;
        let (code, err): (String, String) = sqlx::query_as(
            "SELECT error_code, error FROM audit_log ORDER BY id DESC LIMIT 1")
            .fetch_one(&*pool).await.expect("row survived the migration");
        assert_eq!(code, "", "an existing row must default to no class, not a wrong one");
        assert_eq!(err, "Lost connection", "the prose must survive");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod digest_store_tests {
    use super::*;

    fn row(digest: &str, text: &str, calls: i64, total_ms: f64, rows_total: i64) -> DigestRowIn {
        DigestRowIn {
            digest_id: digest.into(),
            query_text: text.into(),
            calls,
            total_ms,
            mean_ms: if calls > 0 { total_ms / calls as f64 } else { 0.0 },
            rows_total,
            shared_blks_hit: 0,
            shared_blks_read: 0,
        }
    }

    async fn temp_store(tag: &str) -> (HistoryStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("txui_digest_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = open(&dir).await.expect("open temp history db");
        (store, dir)
    }

    #[tokio::test]
    async fn save_list_get_roundtrip() {
        let (store, dir) = temp_store("roundtrip").await;
        let rows = vec![
            row("aaa", "SELECT * FROM t WHERE id = ?", 10, 123.0, 50),
            row("bbb", "UPDATE t SET x = ? WHERE id = ?", 4, 40.0, 4),
        ];
        let id = save_digest_snapshot(&store, "conn1", "postgres", "before deploy", &rows)
            .await.expect("save");

        let listed = list_digest_snapshots(&store, "conn1").await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert_eq!(listed[0].label, "before deploy");
        assert_eq!(listed[0].rows_count, 2);
        // Another connection must not see it.
        assert!(list_digest_snapshots(&store, "conn2").await.expect("list other").is_empty());

        let got = get_digest_snapshot(&store, id).await.expect("get");
        assert_eq!(got.meta.engine, "postgres");
        assert_eq!(got.rows.len(), 2);
        // Ordered by total_ms DESC, and the text came back from digest_texts.
        assert_eq!(got.rows[0].digest_id, "aaa");
        assert_eq!(got.rows[0].query_text, "SELECT * FROM t WHERE id = ?");
        assert_eq!(got.rows[0].calls, 10);
        assert_eq!(got.rows[1].digest_id, "bbb");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn texts_are_deduped_by_digest_across_snapshots() {
        let (store, dir) = temp_store("dedupe").await;
        let snap_rows = vec![
            row("aaa", "SELECT * FROM t WHERE id = ?", 10, 100.0, 50),
            row("bbb", "SELECT 1", 1, 1.0, 1),
        ];
        save_digest_snapshot(&store, "c", "mysql", "one", &snap_rows).await.unwrap();
        let mut later = snap_rows.clone();
        later[0].calls = 20;
        later[0].total_ms = 250.0;
        save_digest_snapshot(&store, "c", "mysql", "two", &later).await.unwrap();

        let pool = &store;
        let texts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM digest_texts WHERE connection_id = 'c'")
            .fetch_one(&*pool).await.unwrap();
        let rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM digest_snapshot_rows r
             JOIN digest_snapshots s ON s.id = r.snapshot_id WHERE s.connection_id = 'c'")
            .fetch_one(&*pool).await.unwrap();
        assert_eq!(rows, 4, "two snapshots × two digests");
        assert_eq!(texts, 2, "the text is stored once per digest, not once per row");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn long_query_text_is_capped() {
        let (store, dir) = temp_store("cap").await;
        let long = "x".repeat(MAX_QUERY_TEXT_CHARS + 500);
        let id = save_digest_snapshot(&store, "c", "postgres", "", &[row("d", &long, 1, 1.0, 0)])
            .await.unwrap();
        let got = get_digest_snapshot(&store, id).await.unwrap();
        assert_eq!(got.rows[0].query_text.chars().count(), MAX_QUERY_TEXT_CHARS + 1,
            "cap plus the ellipsis marker");
        assert!(got.rows[0].query_text.ends_with('…'));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn retention_prunes_oldest_beyond_cap() {
        let (store, dir) = temp_store("prune").await;
        let mut ids = Vec::new();
        for i in 0..4 {
            ids.push(
                save_digest_snapshot_capped(&store, "c", "mysql", &format!("s{i}"),
                    &[row(&format!("d{i}"), "SELECT 1", 1, 1.0, 1)], 3)
                    .await.unwrap()
            );
            // Distinct created_at values for a deterministic order.
            let pool = &store;
            sqlx::query("UPDATE digest_snapshots SET created_at = printf('2026-01-01 00:00:0%d', ?) WHERE id = ?")
                .bind(i).bind(ids[i as usize])
                .execute(&*pool).await.unwrap();
        }

        let listed = list_digest_snapshots(&store, "c").await.expect("list");
        assert_eq!(listed.len(), 3, "cap is 3");
        assert!(listed.iter().all(|m| m.id != ids[0]), "the oldest rolled off");
        // Its rows went with it.
        let pool = &store;
        let orphans: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM digest_snapshot_rows WHERE snapshot_id = ?")
            .bind(ids[0]).fetch_one(&*pool).await.unwrap();
        assert_eq!(orphans, 0);
        // And its digest text, no longer referenced, was cleaned up.
        let stale: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM digest_texts WHERE connection_id = 'c' AND digest_id = 'd0'")
            .fetch_one(&*pool).await.unwrap();
        assert_eq!(stale, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn delete_removes_header_and_rows() {
        let (store, dir) = temp_store("delete").await;
        let id = save_digest_snapshot(&store, "c", "mysql", "", &[row("d", "SELECT 1", 1, 1.0, 1)])
            .await.unwrap();
        delete_digest_snapshot(&store, id).await.unwrap();
        assert!(list_digest_snapshots(&store, "c").await.unwrap().is_empty());
        assert!(get_digest_snapshot(&store, id).await.is_err(), "fetch_one on a gone id must error");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn stored(digest: &str, text: &str, calls: i64, total_ms: f64, rows_total: i64) -> StoredDigestRow {
        StoredDigestRow {
            digest_id: digest.into(),
            query_text: text.into(),
            calls,
            total_ms,
            mean_ms: if calls > 0 { total_ms / calls as f64 } else { 0.0 },
            rows_total,
            shared_blks_hit: 0,
            shared_blks_read: 0,
        }
    }

    #[test]
    fn diff_marks_changed_new_and_gone() {
        let before = vec![
            stored("a", "SELECT a", 10, 100.0, 20),
            stored("b", "SELECT b", 5, 50.0, 5),
        ];
        let after = vec![
            stored("a", "SELECT a", 14, 190.0, 30),  // changed
            stored("c", "SELECT c", 3, 30.0, 3),     // new
        ];
        let d = diff_digest_rows(&before, &after);
        assert_eq!(d.len(), 3);

        let a = d.iter().find(|e| e.digest_id == "a").unwrap();
        assert_eq!(a.status, "changed");
        assert_eq!(a.d_calls, 4);
        assert!((a.d_total_ms - 90.0).abs() < 1e-9);
        assert_eq!(a.d_rows, 10);
        assert_eq!(a.after_calls, 14);

        let c = d.iter().find(|e| e.digest_id == "c").unwrap();
        assert_eq!(c.status, "new");
        assert_eq!(c.d_calls, 3, "new digests diff against a zero baseline");

        let b = d.iter().find(|e| e.digest_id == "b").unwrap();
        assert_eq!(b.status, "gone");
        assert_eq!(b.d_calls, -5, "gone digests subtract to negatives");
    }

    #[test]
    fn diff_keeps_negative_deltas_visible_for_reset_detection() {
        // A counter reset makes the later snapshot smaller; clamping that to
        // zero would disguise the reset as "no work", which is the one lie a
        // diff tool must never tell.
        let before = vec![stored("a", "SELECT a", 100, 9000.0, 100)];
        let after = vec![stored("a", "SELECT a", 2, 10.0, 2)];
        let d = diff_digest_rows(&before, &after);
        assert_eq!(d[0].d_calls, -98, "a reset must surface as a negative delta");
    }

    #[test]
    fn diff_sorts_by_total_time_increase() {
        let before = vec![
            stored("slow", "SELECT s", 1, 10.0, 1),
            stored("fast", "SELECT f", 1, 5.0, 1),
        ];
        let after = vec![
            stored("slow", "SELECT s", 2, 30.0, 2),   // +20 ms
            stored("fast", "SELECT f", 100, 8.0, 100), // +3 ms, more calls
        ];
        let d = diff_digest_rows(&before, &after);
        assert_eq!(d[0].digest_id, "slow", "larger time increase leads even with fewer calls");
        assert_eq!(d[1].digest_id, "fast");
    }

    #[tokio::test]
    async fn diff_two_stored_snapshots_end_to_end() {
        let (store, dir) = temp_store("e2e").await;
        let before_id = save_digest_snapshot(&store, "c", "mysql", "before",
            &[row("a", "SELECT * FROM orders WHERE id = ?", 10, 100.0, 20)]).await.unwrap();
        let after_id = save_digest_snapshot(&store, "c", "mysql", "after",
            &[row("a", "SELECT * FROM orders WHERE id = ?", 25, 400.0, 60)]).await.unwrap();

        let before = get_digest_snapshot(&store, before_id).await.unwrap();
        let after = get_digest_snapshot(&store, after_id).await.unwrap();
        let d = diff_digest_rows(&before.rows, &after.rows);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].d_calls, 15);
        assert!((d[0].d_total_ms - 300.0).abs() < 1e-9);
        assert_eq!(d[0].query_text, "SELECT * FROM orders WHERE id = ?");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod deadlock_store_tests {
    use super::*;

    async fn temp_store(tag: &str) -> (HistoryStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("txui_deadlock_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = open(&dir).await.expect("open temp history db");
        (store, dir)
    }

    #[tokio::test]
    async fn record_list_get_roundtrip() {
        let (store, dir) = temp_store("roundtrip").await;
        let id = record_deadlock_event(&store, "c1", "mysql",
            "2026-08-20 14:03:11 0x7f", "(2) · thread 813", 2,
            "RAW SECTION", "{\"victim\":2}")
            .await.expect("record")
            .expect("a new event is recorded");

        let listed = list_deadlock_events(&store, "c1").await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert_eq!(listed[0].victim, "(2) · thread 813");
        assert_eq!(listed[0].txn_count, 2);
        assert_eq!(listed[0].detected_at, "2026-08-20 14:03:11 0x7f");
        // Another connection must not see it.
        assert!(list_deadlock_events(&store, "c2").await.expect("list other").is_empty());

        let got = get_deadlock_event(&store, id).await.expect("get");
        assert_eq!(got.raw, "RAW SECTION");
        assert_eq!(got.parsed, "{\"victim\":2}");
        assert_eq!(got.engine, "mysql");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_same_incident_is_not_recorded_twice() {
        let (store, dir) = temp_store("dedupe").await;
        let first = record_deadlock_event(&store, "c", "mysql", "t", "(2)", 2, "SAME RAW", "")
            .await.unwrap();
        assert!(first.is_some());
        // A refresh poll re-reads the unchanged LATEST DETECTED DEADLOCK.
        let again = record_deadlock_event(&store, "c", "mysql", "t", "(2)", 2, "SAME RAW", "")
            .await.unwrap();
        assert_eq!(again, None, "identical raw to the newest event ⇒ nothing new");
        // A different incident (different raw) is new even with the same stamp.
        let next = record_deadlock_event(&store, "c", "mysql", "t", "(1)", 2, "NEW RAW", "")
            .await.unwrap();
        assert!(next.is_some());
        assert_eq!(list_deadlock_events(&store, "c").await.unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn retention_prunes_oldest_beyond_cap() {
        let (store, dir) = temp_store("prune").await;
        let mut first_id = 0;
        for i in 0..4 {
            let id = record_deadlock_event_capped(&store, "c", "mysql", "", "", 2,
                &format!("raw {i}"), "", 3)
                .await.unwrap().unwrap();
            if i == 0 { first_id = id; }
        }
        let listed = list_deadlock_events(&store, "c").await.expect("list");
        assert_eq!(listed.len(), 3, "cap is 3");
        assert!(listed.iter().all(|m| m.id != first_id), "the oldest rolled off");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn delete_removes_the_event() {
        let (store, dir) = temp_store("delete").await;
        let id = record_deadlock_event(&store, "c", "postgres", "", "", 0, "counters", "")
            .await.unwrap().unwrap();
        delete_deadlock_event(&store, id).await.unwrap();
        assert!(list_deadlock_events(&store, "c").await.unwrap().is_empty());
        assert!(get_deadlock_event(&store, id).await.is_err(),
            "fetch_one on a gone id must error");
        let _ = std::fs::remove_dir_all(&dir);
    }
}


#[cfg(test)]
mod fingerprint_tests {
    use super::*;

    // Parity with utils/slowLogParse.ts `fingerprint` — the frontend
    // fingerprints the just-run statement with the TS version, this side
    // fingerprints history rows, and a lookup only matches when the two agree.
    // Known divergence, deliberately accepted: the TS pipeline strips
    // line/block comments BEFORE strings, so a `--` inside a string literal
    // eats the rest of the line there and not here. That shape is rare in
    // editor-run SQL, and the failure mode is a silent tooltip miss, not a
    // wrong number.
    #[test]
    fn fingerprint_parity_cases() {
        assert_eq!(fingerprint_sql("SELECT * FROM users WHERE id = 42"),
            "select * from users where id = ?");
        assert_eq!(fingerprint_sql("select  *  from\nusers  where id=7"),
            "select * from users where id=?");
        assert_eq!(fingerprint_sql("SELECT * FROM t WHERE name = 'O''Brien' AND n IN (1, 2, 3)"),
            // `''` is not an escape to either side: two adjacent literals,
            // each → '?' (TS `'(?:[^'\\]|\\.)*'` does the same).
            "select * from t where name = ?? and n in (?)");
        assert_eq!(fingerprint_sql("SELECT * FROM t WHERE x = 'a\\'b'"),
            "select * from t where x = ?");
        assert_eq!(fingerprint_sql("SELECT * FROM t WHERE id IN (5,6,7)"),
            "select * from t where id in (?)");
        assert_eq!(fingerprint_sql("SELECT * FROM t WHERE id IN ( 9 )"),
            "select * from t where id in (?)");
        assert_eq!(fingerprint_sql("-- a comment\nSELECT 1; -- tail"),
            "select ?;");
        assert_eq!(fingerprint_sql("/* block */ SELECT 1.5, 2"),
            "select ?, ?");
        assert_eq!(fingerprint_sql("SELECT \"quoted ident\" FROM t"),
            "select ? from t");
        // word-boundary rules: digits glued to an identifier are not literals
        assert_eq!(fingerprint_sql("SELECT a1, t2.x FROM t2"),
            "select a1, t2.x from t2");
        assert_eq!(fingerprint_sql("SELECT 123abc"), "select 123abc");
        assert_eq!(fingerprint_sql("SELECT 1.2.3"), "select ?.?");
        // IN with no list of plain literals is left alone
        assert_eq!(fingerprint_sql("SELECT * FROM t WHERE id IN (SELECT id FROM s)"),
            "select * from t where id in (select id from s)");
    }

    async fn temp_store(tag: &str) -> (HistoryStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("txui_fp_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = open(&dir).await.expect("open temp history db");
        (store, dir)
    }

    #[tokio::test]
    async fn digest_stats_aggregates_matching_runs_only() {
        let (store, dir) = temp_store("stats").await;
        let sql_a = "SELECT * FROM users WHERE id = 1";
        // Same shape, different literals → same fingerprint, must aggregate.
        insert(&store, "c", "mysql", sql_a, 100, 1, None).await.unwrap();
        insert(&store, "c", "mysql", "SELECT * FROM users WHERE id = 999", 300, 1, None).await.unwrap();
        // Failed run of the same shape — excluded (errors have their own
        // distribution; mixing them in makes the p95 lie about success).
        insert(&store, "c", "mysql", "select * from users where id=5", 9000, 0, Some("boom"))
            .await.unwrap();
        // Different shape, and a different connection's run of the same shape.
        insert(&store, "c", "mysql", "SELECT 1", 5, 1, None).await.unwrap();
        insert(&store, "other", "mysql", sql_a, 7000, 1, None).await.unwrap();

        let stats = digest_stats(&store, "c", &fingerprint_sql(sql_a))
            .await.unwrap().expect("stats");
        assert_eq!(stats.runs, 2);
        assert_eq!(stats.avg_ms, 200.0);
        assert_eq!(stats.p95_ms, 300, "nearest-rank p95 of [100, 300]");
        assert!(!stats.last_seen.is_empty());

        // A statement that never ran is null, not an error.
        assert!(digest_stats(&store, "c", &fingerprint_sql("DELETE FROM t")).await.unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn digest_stats_p95_is_nearest_rank() {
        let (store, dir) = temp_store("p95").await;
        // 20 runs, 10..=200 by tens: nearest-rank p95 is the 19th value, 190.
        for i in 1..=20 {
            insert(&store, "c", "mysql", &format!("SELECT * FROM t WHERE id = {i}"),
                i * 10, 1, None).await.unwrap();
        }
        let stats = digest_stats(&store, "c", &fingerprint_sql("SELECT * FROM t WHERE id = 1"))
            .await.unwrap().unwrap();
        assert_eq!(stats.runs, 20);
        assert_eq!(stats.p95_ms, 190);
        let _ = std::fs::remove_dir_all(&dir);
    }
    /// WP-10 10.1: query_history is no longer unbounded, and the
    /// connection-less search order has an index behind it.
    #[tokio::test]
    async fn history_retention_and_created_index() {
        let (store, dir) = temp_store("hist-cap").await;
        for i in 0..6 {
            insert_capped(&store, "c", "mysql", &format!("SELECT {i}"), 1, 1, None, 4)
                .await.unwrap();
        }
        let rows = search(&store, None, None, 100).await.unwrap();
        assert_eq!(rows.len(), 4, "oldest rolled off past the cap");
        assert!(rows.iter().all(|r| r.sql != "SELECT 0" && r.sql != "SELECT 1"),
                "the two oldest must be gone");

        let idx: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_index_list('query_history')")
            .fetch_all(&store).await.unwrap();
        assert!(idx.iter().any(|n| n == "idx_history_created"), "missing index: {idx:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

}
