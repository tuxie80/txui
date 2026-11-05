//! Streaming input for the built-in MySQL/MariaDB SQL-script runner.
//!
//! The whole file is never held in memory. Gzip validation, UTF-8 validation
//! and statement splitting work across arbitrary chunk boundaries; only the
//! current statement and a bounded channel are retained.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

pub const DEFAULT_MAX_STATEMENT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_STATEMENT_LIMIT_BYTES: usize = 1024 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScriptCompression {
    Plain,
    Gzip,
}

#[derive(Clone, Debug)]
pub struct ScriptSource {
    pub path: PathBuf,
    pub compression: ScriptCompression,
    pub bytes: u64,
    modified: Option<SystemTime>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanSummary {
    pub source_bytes: u64,
    pub source_total: u64,
    pub uncompressed_bytes: u64,
    pub statements: u64,
    pub lines: u64,
    pub sha256: String,
}

#[derive(Clone, Debug)]
pub struct ScriptStatement {
    pub sql: String,
    pub line: u64,
    pub offset: u64,
}

#[derive(Debug)]
pub enum ScriptScanEvent {
    Progress { source_bytes: u64, source_total: u64, uncompressed_bytes: u64 },
    Statement(ScriptStatement),
}

pub fn inspect_source(path: &str, compression: ScriptCompression) -> Result<ScriptSource, String> {
    if path.trim().is_empty() {
        return Err("choose a .sql or .sql.gz file".into());
    }
    let p = PathBuf::from(path);
    let meta = std::fs::metadata(&p)
        .map_err(|e| format!("cannot read {}: {e}", p.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", p.display()));
    }
    Ok(ScriptSource {
        path: p,
        compression,
        bytes: meta.len(),
        modified: meta.modified().ok(),
    })
}

pub fn ensure_unchanged(source: &ScriptSource) -> Result<(), String> {
    let current = inspect_source(
        source.path.to_str().ok_or("the script path is not valid UTF-8")?,
        source.compression,
    )?;
    if current.bytes != source.bytes || current.modified != source.modified {
        return Err(format!(
            "{} changed between validation and execution — nothing was executed; validate it again",
            source.path.display(),
        ));
    }
    Ok(())
}

#[derive(Clone)]
struct SourceHash {
    bytes: Arc<AtomicU64>,
    sha: Arc<Mutex<Sha256>>,
}

impl SourceHash {
    fn new() -> Self {
        Self { bytes: Arc::new(AtomicU64::new(0)), sha: Arc::new(Mutex::new(Sha256::new())) }
    }

    fn bytes(&self) -> u64 { self.bytes.load(Ordering::Relaxed) }

    fn finish(&self) -> String {
        let sha = self.sha.lock().unwrap_or_else(|e| e.into_inner()).clone();
        format!("{:x}", sha.finalize())
    }
}

struct HashReader {
    file: std::fs::File,
    hash: SourceHash,
}

impl Read for HashReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let n = self.file.read(out)?;
        if n > 0 {
            self.hash.bytes.fetch_add(n as u64, Ordering::Relaxed);
            self.hash.sha.lock().unwrap_or_else(|e| e.into_inner()).update(&out[..n]);
        }
        Ok(n)
    }
}

fn source_reader(source: &ScriptSource, hash: SourceHash) -> Result<Box<dyn Read + Send>, String> {
    let file = std::fs::File::open(&source.path)
        .map_err(|e| format!("cannot open {}: {e}", source.path.display()))?;
    let raw = std::io::BufReader::new(HashReader { file, hash });
    Ok(match source.compression {
        ScriptCompression::Plain => Box::new(raw),
        ScriptCompression::Gzip => Box::new(flate2::read::MultiGzDecoder::new(raw)),
    })
}

/// Start a bounded streaming scan. The receiver closes when the reader exits;
/// the join handle owns the final checksum and counters.
pub fn spawn_scan(
    source: ScriptSource,
    max_statement_bytes: usize,
) -> (
    tokio::sync::mpsc::Receiver<Result<ScriptScanEvent, String>>,
    tokio::task::JoinHandle<Result<ScanSummary, String>>,
) {
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let join = tokio::task::spawn_blocking(move || scan_blocking(source, max_statement_bytes, tx));
    (rx, join)
}

fn scan_blocking(
    source: ScriptSource,
    max_statement_bytes: usize,
    tx: tokio::sync::mpsc::Sender<Result<ScriptScanEvent, String>>,
) -> Result<ScanSummary, String> {
    let hash = SourceHash::new();
    let mut reader = source_reader(&source, hash.clone())?;
    let mut utf8 = IncrementalUtf8::default();
    let mut splitter = MysqlSplitter::new(max_statement_bytes);
    let mut buf = [0u8; READ_CHUNK];
    let mut uncompressed = 0u64;
    let mut statements = 0u64;
    let mut first_text = true;

    macro_rules! send {
        ($event:expr) => {
            if tx.blocking_send($event).is_err() {
                return Err("scan cancelled".into());
            }
        };
    }

    loop {
        let n = reader.read(&mut buf)
            .map_err(|e| format!("cannot decode {}: {e}", source.path.display()))?;
        if n == 0 { break; }
        uncompressed += n as u64;
        let text = utf8.push(&buf[..n]).map_err(|e| format!(
            "{} is not valid UTF-8 at uncompressed byte {}: {e}",
            source.path.display(), uncompressed - n as u64 + e.valid_up_to as u64,
        ))?;
        let text = if first_text && !text.is_empty() {
            first_text = false;
            text.strip_prefix('\u{feff}').unwrap_or(&text)
        } else {
            &text
        };
        for stmt in splitter.feed(text)? {
            validate_statement(&stmt)?;
            statements += 1;
            send!(Ok(ScriptScanEvent::Statement(stmt)));
        }
        send!(Ok(ScriptScanEvent::Progress {
            source_bytes: hash.bytes(),
            source_total: source.bytes,
            uncompressed_bytes: uncompressed,
        }));
    }
    let tail = utf8.finish().map_err(|e| format!(
        "{} ends inside a UTF-8 sequence at uncompressed byte {}: {e}",
        source.path.display(), uncompressed,
    ))?;
    let tail = if first_text && !tail.is_empty() {
        tail.strip_prefix('\u{feff}').unwrap_or(&tail)
    } else {
        &tail
    };
    for stmt in splitter.feed(tail)? {
        validate_statement(&stmt)?;
        statements += 1;
        send!(Ok(ScriptScanEvent::Statement(stmt)));
    }
    for stmt in splitter.finish()? {
        validate_statement(&stmt)?;
        statements += 1;
        send!(Ok(ScriptScanEvent::Statement(stmt)));
    }
    if hash.bytes() != source.bytes {
        return Err(format!(
            "{} was not read completely ({} of {} compressed bytes); trailing or changed data is not accepted",
            source.path.display(), hash.bytes(), source.bytes,
        ));
    }
    Ok(ScanSummary {
        source_bytes: hash.bytes(),
        source_total: source.bytes,
        uncompressed_bytes: uncompressed,
        statements,
        lines: splitter.line,
        sha256: hash.finish(),
    })
}

#[derive(Debug)]
struct Utf8Error {
    valid_up_to: usize,
    message: &'static str,
}

impl std::fmt::Display for Utf8Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.message) }
}

#[derive(Default)]
struct IncrementalUtf8 {
    pending: Vec<u8>,
}

impl IncrementalUtf8 {
    fn push(&mut self, bytes: &[u8]) -> Result<String, Utf8Error> {
        let mut all = Vec::with_capacity(self.pending.len() + bytes.len());
        all.extend_from_slice(&self.pending);
        all.extend_from_slice(bytes);
        self.pending.clear();
        match std::str::from_utf8(&all) {
            Ok(s) => Ok(s.to_string()),
            Err(e) => {
                let valid = e.valid_up_to();
                let prefix = String::from_utf8(all[..valid].to_vec())
                    .map_err(|_| Utf8Error { valid_up_to: 0, message: "invalid UTF-8 prefix" })?;
                if let Some(invalid) = e.error_len() {
                    return Err(Utf8Error { valid_up_to: valid + invalid, message: "invalid byte sequence" });
                }
                self.pending.extend_from_slice(&all[valid..]);
                Ok(prefix)
            }
        }
    }

    fn finish(&mut self) -> Result<String, Utf8Error> {
        if self.pending.is_empty() { return Ok(String::new()); }
        self.pending.clear();
        Err(Utf8Error { valid_up_to: 0, message: "incomplete byte sequence" })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LexState {
    Normal,
    SingleQuote,
    DoubleQuote,
    Backtick,
    LineComment,
    BlockComment,
}

/// Incremental MySQL lexer. It is deliberately not a SQL parser: it preserves
/// the original statement text and recognizes only boundaries and client
/// directives, leaving SQL validity to the server.
pub struct MysqlSplitter {
    pending: Vec<u8>,
    current: Vec<u8>,
    state: LexState,
    escaped: bool,
    delimiter: Vec<u8>,
    absolute: u64,
    previous: Option<u8>,
    line: u64,
    line_start: bool,
    statement_line: u64,
    statement_offset: u64,
    has_code: bool,
    max_statement_bytes: usize,
}

impl MysqlSplitter {
    pub fn new(max_statement_bytes: usize) -> Self {
        Self {
            pending: vec![], current: vec![], state: LexState::Normal,
            escaped: false, delimiter: b";".to_vec(), absolute: 0, previous: None,
            line: 1, line_start: true, statement_line: 0, statement_offset: 0,
            has_code: false, max_statement_bytes,
        }
    }

    pub fn feed(&mut self, text: &str) -> Result<Vec<ScriptStatement>, String> {
        self.pending.extend_from_slice(text.as_bytes());
        self.process(false)
    }

    pub fn finish(&mut self) -> Result<Vec<ScriptStatement>, String> {
        let mut out = self.process(true)?;
        if !matches!(self.state, LexState::Normal | LexState::LineComment) {
            return Err(format!("unterminated {} at line {}", match self.state {
                LexState::SingleQuote => "single-quoted string",
                LexState::DoubleQuote => "double-quoted string",
                LexState::Backtick => "backtick identifier",
                LexState::BlockComment => "block comment",
                _ => "statement",
            }, self.line));
        }
        if self.has_code {
            out.push(self.emit());
        }
        self.current.clear();
        self.has_code = false;
        Ok(out)
    }

    fn process(&mut self, final_input: bool) -> Result<Vec<ScriptStatement>, String> {
        let mut out = Vec::new();
        let mut i = 0usize;
        while i < self.pending.len() {
            if self.state == LexState::Normal && self.line_start
                && matches!(self.pending[i], b'd' | b'D')
            {
                match self.directive(&self.pending[i..], final_input)? {
                    Directive::Wait => break,
                    Directive::NotDirective => {}
                    Directive::Delimiter { value, consumed } => {
                        if self.has_code {
                            return Err(format!("DELIMITER at line {} appears inside a statement", self.line));
                        }
                        self.current.clear();
                        self.reset_statement();
                        self.delimiter = value;
                        for b in self.pending[i..i + consumed].to_vec() { self.consume(b); }
                        i += consumed;
                        continue;
                    }
                }
            }

            let b = self.pending[i];
            match self.state {
                LexState::Normal => {
                    if b == b'#' {
                        self.append(b)?;
                        self.consume(b);
                        self.state = LexState::LineComment;
                        i += 1;
                        continue;
                    }
                    if b == b'-' {
                        if i + 2 >= self.pending.len() && !final_input { break; }
                        if self.pending.get(i + 1) == Some(&b'-')
                            && self.pending.get(i + 2).is_some_and(|c| c.is_ascii_whitespace())
                        {
                            self.append(b)?;
                            self.consume(b);
                            self.state = LexState::LineComment;
                            i += 1;
                            continue;
                        }
                    }
                    if b == b'/' {
                        if i + 1 >= self.pending.len() && !final_input { break; }
                        if self.pending.get(i + 1) == Some(&b'*') {
                            if self.pending.get(i + 2) == Some(&b'!') { self.has_code = true; }
                            self.append(b)?;
                            self.consume(b);
                            self.append(b'*')?;
                            self.consume(b'*');
                            self.state = LexState::BlockComment;
                            i += 2;
                            continue;
                        }
                    }
                    if matches!(b, b'\'' | b'"' | b'`') {
                        self.append(b)?;
                        self.consume(b);
                        self.has_code = true;
                        self.state = match b {
                            b'\'' => LexState::SingleQuote,
                            b'"' => LexState::DoubleQuote,
                            _ => LexState::Backtick,
                        };
                        i += 1;
                        continue;
                    }
                    let available = self.pending.len() - i;
                    if available < self.delimiter.len() && !final_input
                        && self.pending[i..] == self.delimiter[..available]
                    {
                        break;
                    }
                    let delimiter_end = i + self.delimiter.len();
                    let last_is_word = self.delimiter.last().is_some_and(|b| is_word(*b));
                    if delimiter_end == self.pending.len() && last_is_word && !final_input
                        && self.pending[i..] == self.delimiter[..]
                    {
                        break;
                    }
                    if self.delimiter_at(i, final_input) {
                        if self.has_code { out.push(self.emit()); }
                        self.current.clear();
                        self.reset_statement();
                        for d in self.delimiter.clone() { self.consume(d); }
                        i += self.delimiter.len();
                        continue;
                    }
                    self.append(b)?;
                    if !b.is_ascii_whitespace() { self.has_code = true; }
                    self.consume(b);
                    i += 1;
                }
                LexState::LineComment => {
                    self.append(b)?;
                    self.consume(b);
                    i += 1;
                    if b == b'\n' { self.state = LexState::Normal; }
                }
                LexState::BlockComment => {
                    if b == b'*' && i + 1 >= self.pending.len() && !final_input { break; }
                    if b == b'*' && self.pending.get(i + 1) == Some(&b'/') {
                        self.append(b)?;
                        self.consume(b);
                        self.append(b'/')?;
                        self.consume(b'/');
                        self.state = LexState::Normal;
                        i += 2;
                    } else {
                        self.append(b)?;
                        self.consume(b);
                        i += 1;
                    }
                }
                LexState::SingleQuote | LexState::DoubleQuote | LexState::Backtick => {
                    let quote = match self.state {
                        LexState::SingleQuote => b'\'',
                        LexState::DoubleQuote => b'"',
                        _ => b'`',
                    };
                    if b == quote && !self.escaped && i + 1 >= self.pending.len() && !final_input {
                        break;
                    }
                    self.append(b)?;
                    self.consume(b);
                    i += 1;
                    if self.escaped {
                        self.escaped = false;
                    } else if b == b'\\' && self.state != LexState::Backtick {
                        self.escaped = true;
                    } else if b == quote {
                        if self.pending.get(i) == Some(&quote) {
                            self.append(quote)?;
                            self.consume(quote);
                            i += 1;
                        } else {
                            self.state = LexState::Normal;
                        }
                    }
                }
            }
        }
        self.pending.drain(..i);
        Ok(out)
    }

    fn delimiter_at(&self, i: usize, final_input: bool) -> bool {
        let d = &self.delimiter;
        if i + d.len() > self.pending.len() {
            return !final_input && false;
        }
        if self.pending.get(i..i + d.len()) != Some(d.as_slice()) { return false; }
        let word_start = d[0].is_ascii_alphanumeric() || d[0] == b'_';
        let word_end = d[d.len() - 1].is_ascii_alphanumeric() || d[d.len() - 1] == b'_';
        if word_start && i > 0 && is_word(self.pending[i - 1]) { return false; }
        if word_start && i == 0 && self.previous.is_some_and(is_word) { return false; }
        if word_end && self.pending.get(i + d.len()).is_some_and(|b| is_word(*b)) { return false; }
        true
    }

    fn directive(&self, bytes: &[u8], final_input: bool) -> Result<Directive, String> {
        let newline = bytes.iter().position(|b| *b == b'\n');
        let Some(end) = newline.or(if final_input { Some(bytes.len()) } else { None }) else {
            return Ok(Directive::Wait);
        };
        let line = std::str::from_utf8(&bytes[..end]).unwrap_or("").trim_end_matches('\r');
        let mut words = line.split_ascii_whitespace();
        let Some(first) = words.next() else { return Ok(Directive::NotDirective); };
        if !first.eq_ignore_ascii_case("delimiter") {
            return Ok(Directive::NotDirective);
        }
        let value = words.next().ok_or_else(|| format!("DELIMITER at line {} needs a value", self.line))?;
        if words.next().is_some() {
            return Err(format!("DELIMITER at line {} must contain exactly one delimiter", self.line));
        }
        if value.is_empty() || value.len() > 32 {
            return Err(format!("DELIMITER at line {} must be 1–32 bytes", self.line));
        }
        Ok(Directive::Delimiter {
            value: value.as_bytes().to_vec(),
            consumed: end + usize::from(newline.is_some()),
        })
    }

    fn append(&mut self, b: u8) -> Result<(), String> {
        if self.statement_line == 0 && !b.is_ascii_whitespace() {
            self.statement_line = self.line;
            self.statement_offset = self.absolute;
        }
        self.current.push(b);
        if self.current.len() > self.max_statement_bytes {
            return Err(format!(
                "statement at line {} exceeds the {} MiB statement limit; raise the limit or split the statement",
                self.statement_line.max(1), self.max_statement_bytes / (1024 * 1024),
            ));
        }
        Ok(())
    }

    fn consume(&mut self, b: u8) {
        self.absolute += 1;
        self.previous = Some(b);
        if b == b'\n' {
            self.line += 1;
            self.line_start = true;
        } else {
            self.line_start = false;
        }
    }

    fn reset_statement(&mut self) {
        self.statement_line = 0;
        self.statement_offset = 0;
        self.has_code = false;
        self.escaped = false;
    }

    fn emit(&mut self) -> ScriptStatement {
        let start = self.current.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(0);
        let end = self.current.iter().rposition(|b| !b.is_ascii_whitespace())
            .map_or(start, |p| p + 1);
        ScriptStatement {
            sql: String::from_utf8(self.current[start..end].to_vec())
                .expect("the incremental UTF-8 decoder guarantees statement text"),
            line: self.statement_line.max(1),
            offset: self.statement_offset,
        }
    }
}

fn is_word(b: u8) -> bool { b.is_ascii_alphanumeric() || b == b'_' }

enum Directive {
    Wait,
    NotDirective,
    Delimiter { value: Vec<u8>, consumed: usize },
}

fn validate_statement(stmt: &ScriptStatement) -> Result<(), String> {
    let sql = stmt.sql.trim_start();
    if sql.starts_with("\\.") || sql.starts_with('\\') {
        return Err(format!("client command at line {} is not supported by the built-in runner", stmt.line));
    }
    let first: String = sql.chars().take_while(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect::<String>().to_ascii_lowercase();
    const CLIENT_COMMANDS: &[&str] = &[
        "source", "tee", "notee", "pager", "nopager", "system", "quit", "exit",
        "connect", "edit", "ego", "print", "prompt", "rehash", "warnings",
        "nowarning", "charset", "clear",
    ];
    if CLIENT_COMMANDS.contains(&first.as_str()) {
        return Err(format!(
            "mysql client command '{first}' at line {} is not supported; use server SQL instead",
            stmt.line,
        ));
    }
    Ok(())
}

pub fn compression_for_path(path: &str) -> ScriptCompression {
    if Path::new(path).extension().is_some_and(|e| e.eq_ignore_ascii_case("gz")) {
        ScriptCompression::Gzip
    } else {
        ScriptCompression::Plain
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;

    fn split(text: &str, chunk: usize) -> Result<Vec<String>, String> {
        let mut s = MysqlSplitter::new(DEFAULT_MAX_STATEMENT_BYTES);
        let mut out = Vec::new();
        for part in text.as_bytes().chunks(chunk) {
            let part = std::str::from_utf8(part).unwrap();
            out.extend(s.feed(part)?.into_iter().map(|x| x.sql));
        }
        out.extend(s.finish()?.into_iter().map(|x| x.sql));
        Ok(out)
    }

    #[test]
    fn splits_only_real_mysql_boundaries() {
        let sql = concat!(
            "INSERT INTO t VALUES ('a;b', 'it\\'s', \"x;y\");\n",
            "-- not;a statement\n# neither;this\n/* nor;this */ SELECT `a;b` FROM t;",
        );
        assert_eq!(split(sql, 4).unwrap(), vec![
            "INSERT INTO t VALUES ('a;b', 'it\\'s', \"x;y\")",
            "-- not;a statement\n# neither;this\n/* nor;this */ SELECT `a;b` FROM t",
        ]);
    }

    #[test]
    fn every_byte_boundary_produces_the_same_statements() {
        let sql = concat!(
            "CREATE TABLE t(s varchar(20));\n",
            "INSERT INTO t VALUES ('x;--/*\\\'y');\n",
            "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//\n",
            "DELIMITER ;\nCALL p();",
        );
        let expected = split(sql, sql.len()).unwrap();
        for n in 1..sql.len() {
            assert_eq!(split(sql, n).unwrap(), expected, "chunk size {n}");
        }
        assert_eq!(expected.len(), 4);
        assert!(expected[2].starts_with("CREATE PROCEDURE"));
    }

    #[test]
    fn delimiter_does_not_split_identifiers() {
        let sql = "DELIMITER GO\nSELECT 1 GO\nSELECT GOODS GO\nSELECT 2GO";
        let got = split(sql, 2).unwrap();
        assert_eq!(got, vec!["SELECT 1", "SELECT GOODS", "SELECT 2GO"]);
    }

    #[test]
    fn unterminated_constructs_are_errors() {
        for sql in ["SELECT 'x", "SELECT `x", "/* x", "SELECT \"x"] {
            assert!(split(sql, 2).is_err(), "{sql}");
        }
    }

    #[test]
    fn rejects_client_commands_and_bad_directives() {
        for sql in ["SOURCE other.sql;", "\\. other.sql", "PAGER less;"] {
            let mut s = MysqlSplitter::new(DEFAULT_MAX_STATEMENT_BYTES);
            let statements = s.feed(sql).unwrap();
            for stmt in statements { assert!(validate_statement(&stmt).is_err(), "{sql}"); }
        }
        assert!(split("DELIMITER // trailing\nSELECT 1;", 4).is_err());
        assert!(split("SELECT 1\nDELIMITER //", 4).is_err());
    }

    #[test]
    fn statement_limit_is_enforced_during_streaming() {
        let mut s = MysqlSplitter::new(8);
        assert!(s.feed("SELECT 123").is_err());
    }

    #[test]
    fn utf8_decoder_accepts_split_codepoints_and_rejects_bad_input() {
        let bytes = "SELECT 'ž🦆'".as_bytes();
        for n in 1..bytes.len() {
            let mut u = IncrementalUtf8::default();
            let mut text = String::new();
            for part in bytes.chunks(n) { text.push_str(&u.push(part).unwrap()); }
            text.push_str(&u.finish().unwrap());
            assert_eq!(text, "SELECT 'ž🦆'", "chunk size {n}");
        }
        assert!(IncrementalUtf8::default().push(&[0xff]).is_err());
        let mut incomplete = IncrementalUtf8::default();
        assert!(incomplete.push(&[0xf0, 0x9f]).is_ok());
        assert!(incomplete.finish().is_err());
    }

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let p = std::env::temp_dir().join(format!("txui-sqlscript-{}-{name}", uuid::Uuid::new_v4()));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    async fn scan_file(path: &Path, compression: ScriptCompression) -> Result<(ScanSummary, Vec<ScriptStatement>), String> {
        let source = inspect_source(path.to_str().unwrap(), compression)?;
        let (mut rx, join) = spawn_scan(source, DEFAULT_MAX_STATEMENT_BYTES);
        let mut statements = Vec::new();
        while let Some(event) = rx.recv().await {
            if let ScriptScanEvent::Statement(s) = event? { statements.push(s); }
        }
        let summary = join.await.map_err(|e| e.to_string())??;
        Ok((summary, statements))
    }

    #[tokio::test]
    async fn scans_plain_and_multimember_gzip() {
        let sql = b"CREATE TABLE t(id int);\nINSERT INTO t VALUES (1);\n";
        let plain = temp_file("plain.sql", sql);
        let (a, astmts) = scan_file(&plain, ScriptCompression::Plain).await.unwrap();
        assert_eq!((a.statements, a.uncompressed_bytes, astmts.len()), (2, sql.len() as u64, 2));

        let mut first = GzEncoder::new(Vec::new(), Compression::default());
        std::io::Write::write_all(&mut first, &sql[..20]).unwrap();
        let mut gz = first.finish().unwrap();
        let mut second = GzEncoder::new(Vec::new(), Compression::default());
        std::io::Write::write_all(&mut second, &sql[20..]).unwrap();
        gz.extend(second.finish().unwrap());
        let zipped = temp_file("multi.sql.gz", &gz);
        let (b, bstmts) = scan_file(&zipped, ScriptCompression::Gzip).await.unwrap();
        assert_eq!(b.statements, 2);
        assert_eq!(b.uncompressed_bytes, sql.len() as u64);
        assert_eq!(bstmts[1].sql, "INSERT INTO t VALUES (1)");
        assert_ne!(a.sha256, b.sha256);

        std::fs::remove_file(plain).unwrap();
        std::fs::remove_file(zipped).unwrap();
    }

    #[tokio::test]
    async fn corrupt_gzip_and_invalid_utf8_fail_the_scan() {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        std::io::Write::write_all(&mut encoder, b"SELECT 1;").unwrap();
        let mut gz = encoder.finish().unwrap();
        let n = gz.len();
        gz[n - 5] ^= 0xff;
        let zipped = temp_file("bad-crc.sql.gz", &gz);
        assert!(scan_file(&zipped, ScriptCompression::Gzip).await.is_err());
        std::fs::remove_file(zipped).unwrap();

        let invalid = temp_file("invalid.sql", &[0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0xff]);
        assert!(scan_file(&invalid, ScriptCompression::Plain).await.is_err());
        std::fs::remove_file(invalid).unwrap();
    }

    #[tokio::test]
    async fn bom_empty_and_truncated_inputs_have_truthful_outcomes() {
        let bom = temp_file("bom.sql", b"\xef\xbb\xbfSELECT 1;");
        let (_, statements) = scan_file(&bom, ScriptCompression::Plain).await.unwrap();
        assert_eq!(statements.len(), 1);
        assert_eq!(statements[0].sql, "SELECT 1");
        std::fs::remove_file(bom).unwrap();

        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let bytes = encoder.finish().unwrap();
        let empty = temp_file("empty.sql.gz", &bytes);
        let (summary, statements) = scan_file(&empty, ScriptCompression::Gzip).await.unwrap();
        assert_eq!(summary.statements, 0);
        assert!(statements.is_empty());
        std::fs::remove_file(empty).unwrap();

        let truncated = temp_file("truncated.sql.gz", &bytes[..bytes.len() - 3]);
        assert!(scan_file(&truncated, ScriptCompression::Gzip).await.is_err());
        std::fs::remove_file(truncated).unwrap();
    }

    #[test]
    fn source_change_and_compression_detection_are_explicit() {
        assert_eq!(compression_for_path("x.SQL.GZ"), ScriptCompression::Gzip);
        assert_eq!(compression_for_path("x.sql"), ScriptCompression::Plain);
        let p = temp_file("change.sql", b"SELECT 1;");
        let source = inspect_source(p.to_str().unwrap(), ScriptCompression::Plain).unwrap();
        std::fs::write(&p, b"SELECT 123;").unwrap();
        assert!(ensure_unchanged(&source).is_err());
        std::fs::remove_file(p).unwrap();
    }
}
