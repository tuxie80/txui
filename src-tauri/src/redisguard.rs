//! Redis command classification and argument parsing.
//!
//! `sqlguard` is SQL-shaped and cannot help here: it reported `FLUSHALL`,
//! `DEL`, `SET` and `HSET` as READS, so a connection marked read-only accepted
//! every destructive Redis command through the query editor. Redis needs its
//! own classifier.
//!
//! ## Why not just use `ACL CAT dangerous`
//!
//! Redis' own `@dangerous` category is about *risk*, not mutation — it
//! includes `INFO`, `KEYS`, `CONFIG GET`, `CLIENT LIST` and `SLOWLOG GET`,
//! every one of which the DBA panels rely on. Blocking that category on a
//! read-only connection would break the app while protecting nothing extra.
//! So:
//!
//!   * **Writes** come from `ACL CAT write` — authoritative and exact.
//!   * **Admin** is a curated list of commands that change SERVER state
//!     (`CONFIG SET`, `SHUTDOWN`, `REPLICAOF`, `CLIENT KILL`, `DEBUG`, …),
//!     because the `@admin` category also contains pure reads.
//!   * Everything else is a read.
//!
//! ## Two sources
//!
//!   1. The BASELINE tables, generated from a live server's `ACL CAT` output.
//!      They work offline and cover the case where the server refuses
//!      introspection (an ACL-restricted user may not run `ACL CAT`).
//!   2. The SERVER's own `ACL CAT write`, fetched once per session — it tracks
//!      the exact version and any loaded modules, so commands nobody would
//!      hardcode (this machine's Redis 8.10 ships `hgetex`, `delex`, `arseek`,
//!      `trimslots`) are classified correctly.
//!
//! Unknown commands are treated as WRITES. A false positive blocks a read on a
//! read-only connection (annoying); a false negative runs `FLUSHALL` on
//! production (unrecoverable). Same doctrine as sqlguard: when in doubt, block.

use std::collections::HashSet;

/// From `ACL CAT write` on Redis 8.10. Container commands appear as
/// "parent|sub" because the parent alone is not decisive.
const BASELINE_WRITE: &[&str] = &[
    "append", "ardel", "ardelrange", "arinsert", "armset", "arring",
    "arseek", "arset", "bitfield", "bitop", "blmove", "blmovem",
    "blmpop", "blpop", "brpop", "brpoplpush", "bzmpop", "bzpopmax",
    "bzpopmin", "copy", "decr", "decrby", "del", "delex",
    "expire", "expireat", "flushall", "flushdb", "function|delete", "function|flush",
    "function|load", "function|restore", "geoadd", "georadius", "georadiusbymember", "geosearchstore",
    "getdel", "getex", "getset", "hdel", "hexpire", "hexpireat",
    "hgetdel", "hgetex", "himport|set", "hincrby", "hincrbyfloat", "hmset",
    "hpersist", "hpexpire", "hpexpireat", "hset", "hsetex", "hsetnx",
    "incr", "incrby", "incrbyfloat", "increx", "linsert", "lmove",
    "lmovem", "lmpop", "lpop", "lpush", "lpushx", "lrem",
    "lset", "ltrim", "migrate", "move", "mset", "msetex",
    "msetnx", "persist", "pexpire", "pexpireat", "pfadd", "pfdebug",
    "pfmerge", "psetex", "rename", "renamenx", "restore", "restore-asking",
    "rpop", "rpoplpush", "rpush", "rpushx", "sadd", "sdiffstore",
    "set", "setbit", "setex", "setnx", "setrange", "sinterstore",
    "smove", "sort", "spop", "srem", "sunionstore", "swapdb",
    "trimslots", "unlink", "xack", "xackdel", "xadd", "xautoclaim",
    "xcfgset", "xclaim", "xdel", "xdelex", "xgroup|create", "xgroup|createconsumer",
    "xgroup|delconsumer", "xgroup|destroy", "xgroup|setid", "xidmprecord", "xnack", "xreadgroup",
    "xsetid", "xtrim", "zadd", "zdiffstore", "zincrby", "zinterstore",
    "zmpop", "zpopmax", "zpopmin", "zrangestore", "zrem", "zremrangebylex",
    "zremrangebyrank", "zremrangebyscore", "zunionstore",
    // Not in @write but unmistakably mutating:
    "eval", "evalsha", "fcall", "script|load", "script|flush",
];

/// Commands that change SERVER state. Hand-curated rather than taken from
/// `ACL CAT admin`, which also lists `CONFIG GET`, `CLIENT LIST`, `ROLE`,
/// `LASTSAVE`, `SLOWLOG GET` and the whole `LATENCY` read family.
const BASELINE_ADMIN: &[&str] = &[
    "acl|deluser", "acl|load", "acl|save", "acl|setuser",
    "backup|abort", "backup|cleanup", "backup|seal", "backup|start",
    "bgrewriteaof", "bgsave", "save",
    "client|kill", "client|no-evict", "client|no-touch", "client|pause",
    "client|unblock", "client|unpause", "client|setname", "client|setinfo", "client|reply",
    "cluster|addslots", "cluster|addslotsrange", "cluster|bumpepoch",
    "cluster|delslots", "cluster|delslotsrange", "cluster|failover",
    "cluster|flushslots", "cluster|forget", "cluster|meet", "cluster|migration",
    "cluster|replicate", "cluster|reset", "cluster|saveconfig",
    "cluster|set-config-epoch", "cluster|setslot", "cluster|syncslots",
    "config|resetstat", "config|rewrite", "config|set",
    "debug", "failover",
    "hotkeys|reset", "hotkeys|start", "hotkeys|stop",
    "latency|reset", "module|load", "module|loadex", "module|unload",
    "pfselftest", "psync", "replconf", "replicaof", "slaveof",
    "shutdown", "slowlog|reset", "sync", "swapdb",
    "subscribe", "psubscribe", "ssubscribe", "monitor",
];

/// Container commands whose meaning depends entirely on the subcommand.
const CONTAINERS: &[&str] = &[
    "acl", "backup", "client", "cluster", "command", "config", "function",
    "himport", "hotkeys", "latency", "memory", "module", "object", "pubsub",
    "script", "slowlog", "xgroup", "xinfo",
];

/// Container subcommands that only read. Anything on a container that is not
/// listed here and not classified above is treated as admin, so a new
/// destructive subcommand fails safe.
const SAFE_SUBCOMMANDS: &[&str] = &[
    "acl|cat", "acl|dryrun", "acl|getuser", "acl|list", "acl|log", "acl|users",
    "acl|whoami", "acl|help",
    "backup|list", "backup|status",
    "client|id", "client|info", "client|getname", "client|list", "client|help",
    "cluster|countkeysinslot", "cluster|count-failure-reports", "cluster|getkeysinslot",
    "cluster|info", "cluster|links", "cluster|myid", "cluster|nodes",
    "cluster|replicas", "cluster|shards", "cluster|slaves", "cluster|slots", "cluster|help",
    "command|count", "command|docs", "command|getkeys", "command|getkeysandflags",
    "command|info", "command|list", "command|help",
    "config|get", "config|help",
    "function|dump", "function|list", "function|stats", "function|help",
    "hotkeys|get",
    "latency|doctor", "latency|graph", "latency|histogram", "latency|history",
    "latency|latest", "latency|help",
    "memory|doctor", "memory|malloc-stats", "memory|purge", "memory|stats",
    "memory|usage", "memory|help",
    "module|list", "module|help",
    "object|encoding", "object|freq", "object|idletime", "object|refcount", "object|help",
    "pubsub|channels", "pubsub|numpat", "pubsub|numsub", "pubsub|shardchannels",
    "pubsub|shardnumsub", "pubsub|help",
    "script|exists", "script|help",
    "slowlog|get", "slowlog|len", "slowlog|help",
    "xgroup|help",
    "xinfo|consumers", "xinfo|groups", "xinfo|stream", "xinfo|help",
];

/// Plain read commands. Listed explicitly so an UNKNOWN command can safely
/// default to "write" instead of being waved through.
const KNOWN_READ: &[&str] = &[
    "auth", "bitcount", "bitpos", "dbsize", "dump", "echo", "eval_ro",
    "evalsha_ro", "exists", "expiretime", "fcall_ro", "geodist", "geohash",
    "geopos", "geosearch", "get", "getbit", "getrange", "hello", "hexists",
    "hexpiretime", "hget", "hgetall", "hkeys", "hlen", "hmget", "hpexpiretime",
    "hpttl", "hrandfield", "hscan", "hstrlen", "httl", "hvals", "info", "keys",
    "lastsave", "lcs", "lindex", "llen", "lolwut", "lpos", "lrange", "mget",
    "pexpiretime", "pfcount", "ping", "pttl", "publish", "quit", "randomkey",
    "role", "scan", "scard", "sdiff", "select", "sinter", "sintercard",
    "sismember", "smembers", "smismember", "sort_ro", "srandmember", "sscan",
    "strlen", "substr", "sunion", "time", "touch", "ttl", "type", "unsubscribe",
    "punsubscribe", "sunsubscribe", "wait", "waitaof", "xautoclaim_ro", "xlen",
    "xrange", "xread", "xrevrange", "zcard", "zcount", "zdiff", "zinter",
    "zintercard", "zlexcount", "zmscore", "zrandmember", "zrange",
    "zrangebylex", "zrangebyscore", "zrank", "zrevrange", "zrevrangebylex",
    "zrevrangebyscore", "zrevrank", "zscan", "zscore", "zunion",
];

/// What a command does, worst case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// Safe on a read-only connection.
    Read,
    /// Modifies keys.
    Write,
    /// Changes server state (config, replication, clients, persistence).
    Admin,
}

impl Class {
    /// True when a read-only connection must refuse this.
    pub fn mutates(self) -> bool { !matches!(self, Class::Read) }

    pub fn as_str(self) -> &'static str {
        match self {
            Class::Read  => "read",
            Class::Write => "write",
            Class::Admin => "admin",
        }
    }
}

/// Command sets, baseline plus whatever the connected server reported.
#[derive(Debug, Clone)]
pub struct CommandCatalog {
    write: HashSet<String>,
    admin: HashSet<String>,
    read: HashSet<String>,
    safe_sub: HashSet<String>,
    /// False when the server did not answer — callers can say "baseline only".
    pub from_server: bool,
}

impl Default for CommandCatalog {
    fn default() -> Self { Self::baseline() }
}

/// The baseline catalog, built once. `baseline()` allocates ~500 heap Strings
/// into four HashSets — rebuilding that on EVERY guarded Redis statement was
/// pure waste (WP-10 10.3). Sessions with a server-reported catalog use their
/// own (state.rs); everyone else shares this one.
static BASELINE_CATALOG: std::sync::LazyLock<CommandCatalog> =
    std::sync::LazyLock::new(CommandCatalog::baseline);

/// Shared, lazily-built baseline catalog — use this instead of `baseline()`
/// on any hot path.
pub fn baseline_catalog() -> &'static CommandCatalog {
    &BASELINE_CATALOG
}

impl CommandCatalog {
    pub fn baseline() -> Self {
        CommandCatalog {
            write:    BASELINE_WRITE.iter().map(|s| s.to_string()).collect(),
            admin:    BASELINE_ADMIN.iter().map(|s| s.to_string()).collect(),
            read:     KNOWN_READ.iter().map(|s| s.to_string()).collect(),
            safe_sub: SAFE_SUBCOMMANDS.iter().map(|s| s.to_string()).collect(),
            from_server: false,
        }
    }

    /// Union the server's `ACL CAT write` on top of the baseline. Empty input
    /// (introspection refused or unsupported) leaves the baseline untouched.
    pub fn with_server_writes(mut self, write: Vec<String>) -> Self {
        if write.is_empty() { return self; }
        for c in write {
            let c = c.to_ascii_lowercase();
            // A command the server calls a write must never stay in `read`.
            self.read.remove(&c);
            self.write.insert(c);
        }
        self.from_server = true;
        self
    }

    pub fn classify(&self, args: &[String]) -> Class {
        let Some(head) = args.first() else { return Class::Read };
        let cmd = head.to_ascii_lowercase();

        if CONTAINERS.contains(&cmd.as_str()) {
            let Some(sub) = args.get(1) else {
                // A bare container name is a usage error; harmless.
                return Class::Read;
            };
            let full = format!("{}|{}", cmd, sub.to_ascii_lowercase());
            if self.admin.contains(&full) { return Class::Admin; }
            if self.write.contains(&full) { return Class::Write; }
            if self.safe_sub.contains(&full) { return Class::Read; }
            // Unrecognised subcommand of a known container: assume the worst.
            return Class::Admin;
        }

        if self.admin.contains(&cmd) { return Class::Admin; }
        if self.write.contains(&cmd) { return Class::Write; }
        if self.read.contains(&cmd)  { return Class::Read; }
        // Unknown — could be a module command that writes.
        Class::Write
    }

    /// Classify a raw typed line. A line that will not tokenise cannot be
    /// judged, so it is treated as a write.
    pub fn classify_line(&self, line: &str) -> Class {
        match split_args(line) {
            Ok(args) => self.classify(&args),
            Err(_) => Class::Write,
        }
    }
}

/// Production hard limits for Redis.
///
/// The SQL version blocks destructive DDL and WHERE-less writes; the Redis
/// equivalents are the commands that can destroy or stall an entire instance
/// in one line. `FLUSHALL` on a production Redis is not recoverable, and
/// `KEYS *` on a large keyspace blocks the single-threaded server for the
/// duration of the scan.
pub fn check_prod_limits(guard: &crate::state::SessionGuard, line: &str) -> Result<(), String> {
    if guard.environment.as_deref() != Some("prod") {
        return Ok(());
    }
    let Ok(args) = split_args(line) else { return Ok(()) };
    let Some(head) = args.first() else { return Ok(()) };
    let cmd = head.to_ascii_lowercase();
    let name = display_name(&args);

    // Wipes the whole keyspace — the Redis analogue of DROP/TRUNCATE.
    if matches!(cmd.as_str(), "flushall" | "flushdb") && !guard.prod_allow_ddl {
        return Err(format!(
            "blocked on prod: {name} erases the entire keyspace — enable 'Allow destructive DDL' on the connection to permit"));
    }
    // Server-level destruction / takeover.
    if matches!(cmd.as_str(), "shutdown" | "replicaof" | "slaveof" | "failover" | "debug")
        && !guard.prod_allow_ddl
    {
        return Err(format!(
            "blocked on prod: {name} changes server state — enable 'Allow destructive DDL' on the connection to permit"));
    }
    // Script execution: a script body can call any command — including
    // redis.call('flushall') — so EVAL/EVALSHA/FCALL ride the same border as
    // the commands they can smuggle, honoring the same opt-out so power users
    // can still run scripts deliberately. EVAL_RO / EVALSHA_RO / FCALL_RO
    // stay allowed: the server itself rejects writes from their scripts
    // (read-only by contract), so they are inspection, not risk.
    if matches!(cmd.as_str(), "eval" | "evalsha" | "fcall") && !guard.prod_allow_ddl {
        return Err(format!(
            "blocked on prod: {name} runs a script that can call any command \
             — enable 'Allow destructive DDL' on the connection to permit"));
    }
    if cmd == "cluster" {
        if let Some(sub) = args.get(1) {
            if matches!(sub.to_ascii_lowercase().as_str(),
                        "reset" | "failover" | "forget" | "setslot" | "delslots" | "delslotsrange")
                && !guard.prod_allow_ddl
            {
                return Err(format!("blocked on prod: {name} changes cluster topology — enable 'Allow destructive DDL' on the connection to permit"));
            }
        }
    }

    // Reconfiguring or re-authenticating a live production server. None of
    // these erase data, so they are not "destructive DDL" in the SQL sense —
    // but `CONFIG SET appendonly no` or `ACL DELUSER` on prod is exactly the
    // class of action the prod border exists to slow down. Probed against the
    // classifier first: all of these already counted as mutating, so a
    // read-only connection refused them; only the prod border was silent.
    let sub = args.get(1).map(|a| a.to_ascii_lowercase()).unwrap_or_default();
    let reconfigures = match cmd.as_str() {
        "config" => sub == "set" || sub == "resetstat" || sub == "rewrite",
        "acl"    => matches!(sub.as_str(), "setuser" | "deluser" | "load" | "save"),
        "script" => sub == "flush",
        // FUNCTION LOAD installs server-side code; FUNCTION FLUSH erases it.
        // FUNCTION LIST/DUMP/STATS remain inspection.
        "function" => sub == "flush" || sub == "load",
        // MODULE UNLOAD can take the server down with it — but MODULE LIST
        // is inspection, which is most of what anyone does on prod.
        "module" => matches!(sub.as_str(), "load" | "loadex" | "unload"),
        "migrate" => true,
        // SWAPDB exchanges two whole databases atomically — every client sees
        // a different keyspace from one command to the next.
        "swapdb" => true,
        _ => false,
    };
    if reconfigures && !guard.prod_allow_ddl {
        return Err(format!(
            "blocked on prod: {name} reconfigures the running server \
             — enable 'Allow destructive DDL' on the connection to permit"));
    }

    // O(N) over the whole keyspace on a single-threaded server: the closest
    // Redis analogue of a WHERE-less UPDATE.
    if cmd == "keys" && !guard.prod_allow_unfiltered_write {
        return Err(
            "blocked on prod: KEYS scans the entire keyspace and blocks the server \
             — use SCAN, or enable 'Allow unfiltered writes' on the connection".into());
    }
    Ok(())
}

// ── Argument parsing ─────────────────────────────────────────────────────────

/// Split a typed command line into arguments the way `redis-cli` does.
///
/// The previous implementation used `split_whitespace`, so
/// `SET greeting "hello world"` became four arguments and stored the literal
/// `"hello` — silently writing the wrong value, then leaving `world"` as a
/// stray argument. Quoting has to be real: double quotes support the standard
/// escapes plus `\xNN`; single quotes are literal apart from `\'`.
pub fn split_args(input: &str) -> Result<Vec<String>, String> {
    let cs: Vec<char> = input.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;

    while i < cs.len() {
        while i < cs.len() && cs[i].is_whitespace() { i += 1; }
        if i >= cs.len() { break; }

        let mut cur = String::new();
        match cs[i] {
            '"' => {
                i += 1;
                loop {
                    if i >= cs.len() { return Err("unbalanced double quote".into()); }
                    if cs[i] == '\\' && i + 1 < cs.len() {
                        i += 1;
                        match cs[i] {
                            'x' if i + 2 < cs.len()
                                && cs[i + 1].is_ascii_hexdigit()
                                && cs[i + 2].is_ascii_hexdigit() => {
                                let hex: String = cs[i + 1..=i + 2].iter().collect();
                                if let Ok(b) = u8::from_str_radix(&hex, 16) { cur.push(b as char); }
                                i += 3;
                            }
                            'n' => { cur.push('\n');     i += 1; }
                            'r' => { cur.push('\r');     i += 1; }
                            't' => { cur.push('\t');     i += 1; }
                            'b' => { cur.push('\u{08}'); i += 1; }
                            'a' => { cur.push('\u{07}'); i += 1; }
                            c   => { cur.push(c);        i += 1; }
                        }
                        continue;
                    }
                    if cs[i] == '"' {
                        i += 1;
                        if i < cs.len() && !cs[i].is_whitespace() {
                            return Err("closing quote must be followed by a space".into());
                        }
                        break;
                    }
                    cur.push(cs[i]);
                    i += 1;
                }
            }
            '\'' => {
                i += 1;
                loop {
                    if i >= cs.len() { return Err("unbalanced single quote".into()); }
                    if cs[i] == '\\' && i + 1 < cs.len() && cs[i + 1] == '\'' {
                        cur.push('\''); i += 2; continue;
                    }
                    if cs[i] == '\'' {
                        i += 1;
                        if i < cs.len() && !cs[i].is_whitespace() {
                            return Err("closing quote must be followed by a space".into());
                        }
                        break;
                    }
                    cur.push(cs[i]);
                    i += 1;
                }
            }
            _ => {
                while i < cs.len() && !cs[i].is_whitespace() {
                    cur.push(cs[i]);
                    i += 1;
                }
            }
        }
        out.push(cur);
    }
    Ok(out)
}

/// Display name for logs and errors: "CONFIG SET", "GET".
pub fn display_name(args: &[String]) -> String {
    let Some(head) = args.first() else { return String::new() };
    let cmd = head.to_ascii_uppercase();
    if CONTAINERS.contains(&head.to_ascii_lowercase().as_str()) {
        if let Some(sub) = args.get(1) {
            return format!("{} {}", cmd, sub.to_ascii_uppercase());
        }
    }
    cmd
}

#[cfg(test)]
mod prod_border_tests {
    use super::*;
    use crate::state::SessionGuard;

    fn guard(env: Option<&str>) -> SessionGuard {
        SessionGuard {
            read_only: false,
            engine: crate::db::types::Engine::Redis,
            environment: env.map(str::to_string),
            log_dir: None,
            prod_allow_ddl: false,
            prod_allow_unfiltered_write: false,
            autocommit: true,
            query_timeout_secs: None,
        }
    }
    fn prod() -> SessionGuard { guard(Some("prod")) }

    /// These already counted as *mutating*, so a read-only connection refused
    /// them — but on a read-write prod connection the border said nothing.
    /// Reconfiguring or re-authenticating a live server is exactly the class
    /// of action it exists to slow down.
    #[test]
    fn reconfiguring_a_live_prod_server_is_stopped() {
        for line in [
            "CONFIG SET appendonly no",
            "CONFIG REWRITE",
            "ACL DELUSER app",
            "ACL SETUSER app on >pw",
            "SCRIPT FLUSH",
            "FUNCTION FLUSH",
            "MODULE UNLOAD m",
            "MIGRATE other 6379 k 0 100",   // moves keys to a different server
            "SWAPDB 0 1",
        ] {
            assert!(check_prod_limits(&prod(), line).is_err(), "allowed on prod: {line}");
        }
    }

    #[test]
    fn reading_the_same_things_is_not_stopped() {
        // The cost of widening the border is false positives on inspection,
        // which is most of what anyone does on a prod connection.
        for line in ["CONFIG GET maxmemory", "ACL LIST", "ACL WHOAMI",
                     "SCRIPT EXISTS abc", "FUNCTION LIST", "MODULE LIST", "INFO"] {
            assert!(check_prod_limits(&prod(), line).is_ok(), "blocked on prod: {line}");
        }
    }

    #[test]
    fn the_opt_out_still_works() {
        let mut g = prod();
        g.prod_allow_ddl = true;
        assert!(check_prod_limits(&g, "CONFIG SET appendonly no").is_ok());
    }

    /// WP-01 1.5: a script body can call redis.call('flushall') — EVAL and
    /// friends must ride the prod border. The _RO variants stay allowed (the
    /// server rejects writes from their scripts by contract).
    #[test]
    fn script_execution_rides_the_prod_border() {
        for line in [
            "EVAL \"redis.call('flushall')\" 0",
            "EVALSHA abc123 0",
            "FCALL myfunc 0",
            "FUNCTION LOAD \"#!lua name=lib\"",
        ] {
            assert!(check_prod_limits(&prod(), line).is_err(), "allowed on prod: {line}");
        }
        // deliberate opt-out still runs scripts
        let mut g = prod();
        g.prod_allow_ddl = true;
        assert!(check_prod_limits(&g, "EVAL \"redis.call('flushall')\" 0").is_ok());
        // read-only-by-contract variants and plain reads are untouched
        for line in ["EVAL_RO \"return 1\" 0", "EVALSHA_RO abc 0", "FCALL_RO f 0", "GET x"] {
            assert!(check_prod_limits(&prod(), line).is_ok(), "blocked on prod: {line}");
        }
    }

    #[test]
    fn nothing_is_blocked_off_prod() {
        let g = guard(None);
        for line in ["CONFIG SET appendonly no", "FLUSHALL", "SHUTDOWN", "KEYS *"] {
            assert!(check_prod_limits(&g, line).is_ok(), "blocked off prod: {line}");
        }
    }

    /// The refusals are read by people mid-incident. A run of stray spaces in
    /// the middle of the sentence is what these strings used to contain.
    #[test]
    fn the_refusals_read_as_sentences() {
        for line in ["FLUSHALL", "SHUTDOWN", "CLUSTER RESET", "CONFIG SET x 1", "KEYS *"] {
            let msg = check_prod_limits(&prod(), line).unwrap_err();
            assert!(!msg.contains("  "), "double space in: {msg}");
            assert!(!msg.contains('\n'), "newline in: {msg}");
            assert!(msg.contains("enable"), "no way out offered: {msg}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> { v.iter().map(|s| s.to_string()).collect() }
    fn cls(line: &str) -> Class { CommandCatalog::baseline().classify_line(line) }

    // ── The hole this module exists to close ─────────────────────────────

    #[test]
    fn destructive_commands_are_not_reads() {
        // Every one of these was is_write() == false under sqlguard, so a
        // read-only Redis connection accepted them.
        for c in ["SET k v", "DEL k", "FLUSHALL", "FLUSHDB", "EXPIRE k 1",
                  "HSET h f v", "LPUSH l v", "UNLINK k", "GETDEL k",
                  "RENAME a b", "ZADD z 1 m", "XADD s '*' f v", "SPOP s"] {
            assert!(cls(c).mutates(), "{c} must not be treated as a read");
        }
    }

    #[test]
    fn reads_stay_readable() {
        // Blocking these would break the browser and every DBA panel.
        for c in ["GET k", "MGET a b", "SCAN 0", "HGETALL h", "LRANGE l 0 -1",
                  "TTL k", "TYPE k", "EXISTS k", "DBSIZE", "INFO", "INFO memory",
                  "KEYS *", "PING", "ZRANGE z 0 -1", "XRANGE s - +", "SMEMBERS s",
                  "OBJECT ENCODING k", "MEMORY USAGE k", "CLIENT LIST",
                  "CONFIG GET maxmemory", "SLOWLOG GET 10", "LATENCY LATEST",
                  "COMMAND DOCS GET", "ACL WHOAMI", "CLUSTER INFO"] {
            assert_eq!(cls(c), Class::Read, "{c} must stay allowed on a read-only connection");
        }
    }

    #[test]
    fn server_state_changes_are_admin() {
        for c in ["CONFIG SET maxmemory 0", "SHUTDOWN", "REPLICAOF host 1",
                  "SLAVEOF NO ONE", "CLIENT KILL ID 5", "DEBUG SLEEP 1",
                  "MODULE LOAD /x.so", "ACL SETUSER bob on", "SLOWLOG RESET",
                  "BGSAVE", "SAVE", "FAILOVER", "CLUSTER RESET", "MONITOR"] {
            assert_eq!(cls(c), Class::Admin, "{c} must be admin");
        }
    }

    #[test]
    fn container_commands_are_judged_by_subcommand() {
        // The whole point: CONFIG GET reads, CONFIG SET does not.
        assert_eq!(cls("CONFIG GET maxmemory"), Class::Read);
        assert_eq!(cls("CONFIG SET maxmemory 0"), Class::Admin);
        assert_eq!(cls("SLOWLOG GET"), Class::Read);
        assert_eq!(cls("SLOWLOG RESET"), Class::Admin);
        assert_eq!(cls("ACL LIST"), Class::Read);
        assert_eq!(cls("ACL DELUSER bob"), Class::Admin);
        assert_eq!(cls("XGROUP CREATE s g $"), Class::Write);
        assert_eq!(cls("XINFO STREAM s"), Class::Read);
    }

    #[test]
    fn unknown_things_fail_closed() {
        // A module command nobody hardcoded must not be waved through.
        assert_eq!(cls("JSON.SET doc $ '{}'"), Class::Write);
        assert_eq!(cls("FT.CREATE idx SCHEMA t TEXT"), Class::Write);
        // An unrecognised subcommand of a known container is worse — it could
        // be a new destructive one.
        assert_eq!(cls("CONFIG SOMETHINGNEW x"), Class::Admin);
        assert_eq!(cls("CLIENT FUTURESUBCOMMAND"), Class::Admin);
        // A line that cannot even be tokenised cannot be judged.
        assert_eq!(cls("SET k \"unterminated"), Class::Write);
    }

    #[test]
    fn case_and_whitespace_do_not_matter() {
        assert_eq!(cls("flushall"), Class::Write);
        assert_eq!(cls("  FlUsHaLl  "), Class::Write);
        assert_eq!(cls("config   set   appendonly   no"), Class::Admin);
        assert_eq!(cls(""), Class::Read);
    }

    #[test]
    fn server_catalog_overrides_the_baseline() {
        // A module command the server reports as a write must be caught, and a
        // command the server calls a write must lose any "read" status.
        let cat = CommandCatalog::baseline()
            .with_server_writes(vec!["json.set".into(), "keys".into()]);
        assert!(cat.from_server);
        assert_eq!(cat.classify(&args(&["JSON.SET", "d", "$", "1"])), Class::Write);
        assert_eq!(cat.classify(&args(&["KEYS", "*"])), Class::Write);
        // Empty server response leaves the baseline alone.
        let cat2 = CommandCatalog::baseline().with_server_writes(vec![]);
        assert!(!cat2.from_server);
        assert_eq!(cat2.classify(&args(&["KEYS", "*"])), Class::Read);
    }

    // ── Argument parsing ─────────────────────────────────────────────────

    #[test]
    fn quoted_values_survive_intact() {
        // split_whitespace turned this into ["SET","greeting","\"hello","world\""]
        // and stored the wrong value.
        assert_eq!(split_args(r#"SET greeting "hello world""#).unwrap(),
                   vec!["SET", "greeting", "hello world"]);
        assert_eq!(split_args("SET k 'single quoted value'").unwrap(),
                   vec!["SET", "k", "single quoted value"]);
    }

    #[test]
    fn escapes_follow_redis_cli() {
        assert_eq!(split_args(r#"SET k "line1\nline2""#).unwrap()[2], "line1\nline2");
        assert_eq!(split_args(r#"SET k "tab\there""#).unwrap()[2], "tab\there");
        assert_eq!(split_args(r#"SET k "quote\"inside""#).unwrap()[2], "quote\"inside");
        assert_eq!(split_args(r#"SET k "\x41\x42""#).unwrap()[2], "AB");
        // single quotes are literal apart from \'
        assert_eq!(split_args(r"SET k 'it\'s'").unwrap()[2], "it's");
        assert_eq!(split_args(r"SET k 'no\nescape'").unwrap()[2], r"no\nescape");
    }

    #[test]
    fn empty_arguments_are_preserved() {
        // An empty string is a legitimate Redis value.
        assert_eq!(split_args(r#"SET k """#).unwrap(), vec!["SET", "k", ""]);
    }

    #[test]
    fn malformed_quoting_is_an_error_not_a_guess() {
        assert!(split_args(r#"SET k "unterminated"#).is_err());
        assert!(split_args("SET k 'unterminated").is_err());
        // redis-cli requires a separator after a closing quote
        assert!(split_args(r#"SET k "a"b"#).is_err());
    }

    #[test]
    fn extra_whitespace_is_collapsed() {
        assert_eq!(split_args("  GET    key  ").unwrap(), vec!["GET", "key"]);
        assert_eq!(split_args("").unwrap(), Vec::<String>::new());
        assert_eq!(split_args("   ").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn display_name_includes_the_subcommand() {
        assert_eq!(display_name(&args(&["config", "set", "x", "1"])), "CONFIG SET");
        assert_eq!(display_name(&args(&["get", "k"])), "GET");
        assert_eq!(display_name(&args(&["CONFIG"])), "CONFIG");
        assert_eq!(display_name(&[]), "");
    }

    #[test]
    fn glob_and_special_chars_pass_through_unquoted() {
        assert_eq!(split_args("SCAN 0 MATCH user:* COUNT 100").unwrap(),
                   vec!["SCAN", "0", "MATCH", "user:*", "COUNT", "100"]);
        assert_eq!(split_args("XADD s * f v").unwrap()[2], "*");
    }
}
