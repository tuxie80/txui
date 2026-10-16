/**
 * Client-side Redis write classification — the pre-flight mirror of
 * `src-tauri/src/redisguard.rs` (the server-side enforcement).
 *
 * Why this exists: `sqlGuard.isWriteStatement` is SQL-shaped and reports
 * `FLUSHALL`/`DEL`/`SET` as reads, so multi-exec's write preflight never
 * fired for a Redis fleet. The backend still refuses per server
 * (multi_exec.rs classifies with redisguard), so this module is UX-only —
 * but the safety prompt is the whole point of the preflight.
 *
 * The vocabulary mirrors redisguard's BASELINE tables — the offline,
 * generated-from-`ACL CAT` list — NOT the server-fetched catalog: the
 * preflight runs before any server is contacted, so it must judge with the
 * same offline vocabulary the backend falls back to. tests/redisWrite.test.ts
 * extracts the Rust constants from source and fails on drift.
 *
 * Semantics mirror `CommandCatalog::classify`:
 *   - container commands (CONFIG, CLIENT, …) are judged by subcommand;
 *   - an unrecognised subcommand of a known container is admin (fail closed);
 *   - an unknown command is a write (fail closed — a false positive blocks a
 *     read in a prompt; a false negative runs FLUSHALL on production).
 *
 * Pure: no server, no React. `node --test` covers it.
 */

/** From `ACL CAT write` on Redis 8.10 — mirror of redisguard's BASELINE_WRITE. */
export const REDIS_WRITE_COMMANDS: readonly string[] = [
  'append', 'ardel', 'ardelrange', 'arinsert', 'armset', 'arring',
  'arseek', 'arset', 'bitfield', 'bitop', 'blmove', 'blmovem',
  'blmpop', 'blpop', 'brpop', 'brpoplpush', 'bzmpop', 'bzpopmax',
  'bzpopmin', 'copy', 'decr', 'decrby', 'del', 'delex',
  'expire', 'expireat', 'flushall', 'flushdb', 'function|delete', 'function|flush',
  'function|load', 'function|restore', 'geoadd', 'georadius', 'georadiusbymember', 'geosearchstore',
  'getdel', 'getex', 'getset', 'hdel', 'hexpire', 'hexpireat',
  'hgetdel', 'hgetex', 'himport|set', 'hincrby', 'hincrbyfloat', 'hmset',
  'hpersist', 'hpexpire', 'hpexpireat', 'hset', 'hsetex', 'hsetnx',
  'incr', 'incrby', 'incrbyfloat', 'increx', 'linsert', 'lmove',
  'lmovem', 'lmpop', 'lpop', 'lpush', 'lpushx', 'lrem',
  'lset', 'ltrim', 'migrate', 'move', 'mset', 'msetex',
  'msetnx', 'persist', 'pexpire', 'pexpireat', 'pfadd', 'pfdebug',
  'pfmerge', 'psetex', 'rename', 'renamenx', 'restore', 'restore-asking',
  'rpop', 'rpoplpush', 'rpush', 'rpushx', 'sadd', 'sdiffstore',
  'set', 'setbit', 'setex', 'setnx', 'setrange', 'sinterstore',
  'smove', 'sort', 'spop', 'srem', 'sunionstore', 'swapdb',
  'trimslots', 'unlink', 'xack', 'xackdel', 'xadd', 'xautoclaim',
  'xcfgset', 'xclaim', 'xdel', 'xdelex', 'xgroup|create', 'xgroup|createconsumer',
  'xgroup|delconsumer', 'xgroup|destroy', 'xgroup|setid', 'xidmprecord', 'xnack', 'xreadgroup',
  'xsetid', 'xtrim', 'zadd', 'zdiffstore', 'zincrby', 'zinterstore',
  'zmpop', 'zpopmax', 'zpopmin', 'zrangestore', 'zrem', 'zremrangebylex',
  'zremrangebyrank', 'zremrangebyscore', 'zunionstore',
  // Not in @write but unmistakably mutating:
  'eval', 'evalsha', 'fcall', 'script|load', 'script|flush',
];

/** Server-state changers — mirror of redisguard's BASELINE_ADMIN. */
export const REDIS_ADMIN_COMMANDS: readonly string[] = [
  'acl|deluser', 'acl|load', 'acl|save', 'acl|setuser',
  'backup|abort', 'backup|cleanup', 'backup|seal', 'backup|start',
  'bgrewriteaof', 'bgsave', 'save',
  'client|kill', 'client|no-evict', 'client|no-touch', 'client|pause',
  'client|unblock', 'client|unpause', 'client|setname', 'client|setinfo', 'client|reply',
  'cluster|addslots', 'cluster|addslotsrange', 'cluster|bumpepoch',
  'cluster|delslots', 'cluster|delslotsrange', 'cluster|failover',
  'cluster|flushslots', 'cluster|forget', 'cluster|meet', 'cluster|migration',
  'cluster|replicate', 'cluster|reset', 'cluster|saveconfig',
  'cluster|set-config-epoch', 'cluster|setslot', 'cluster|syncslots',
  'config|resetstat', 'config|rewrite', 'config|set',
  'debug', 'failover',
  'hotkeys|reset', 'hotkeys|start', 'hotkeys|stop',
  'latency|reset', 'module|load', 'module|loadex', 'module|unload',
  'pfselftest', 'psync', 'replconf', 'replicaof', 'slaveof',
  'shutdown', 'slowlog|reset', 'sync', 'swapdb',
  'subscribe', 'psubscribe', 'ssubscribe', 'monitor',
];

/** Container commands judged by subcommand — mirror of redisguard's CONTAINERS. */
export const REDIS_CONTAINERS: readonly string[] = [
  'acl', 'backup', 'client', 'cluster', 'command', 'config', 'function',
  'himport', 'hotkeys', 'latency', 'memory', 'module', 'object', 'pubsub',
  'script', 'slowlog', 'xgroup', 'xinfo',
];

/** Read-only container subcommands — mirror of redisguard's SAFE_SUBCOMMANDS. */
export const REDIS_SAFE_SUBCOMMANDS: readonly string[] = [
  'acl|cat', 'acl|dryrun', 'acl|getuser', 'acl|list', 'acl|log', 'acl|users',
  'acl|whoami', 'acl|help',
  'backup|list', 'backup|status',
  'client|id', 'client|info', 'client|getname', 'client|list', 'client|help',
  'cluster|countkeysinslot', 'cluster|count-failure-reports', 'cluster|getkeysinslot',
  'cluster|info', 'cluster|links', 'cluster|myid', 'cluster|nodes',
  'cluster|replicas', 'cluster|shards', 'cluster|slaves', 'cluster|slots', 'cluster|help',
  'command|count', 'command|docs', 'command|getkeys', 'command|getkeysandflags',
  'command|info', 'command|list', 'command|help',
  'config|get', 'config|help',
  'function|dump', 'function|list', 'function|stats', 'function|help',
  'hotkeys|get',
  'latency|doctor', 'latency|graph', 'latency|histogram', 'latency|history',
  'latency|latest', 'latency|help',
  'memory|doctor', 'memory|malloc-stats', 'memory|purge', 'memory|stats',
  'memory|usage', 'memory|help',
  'module|list', 'module|help',
  'object|encoding', 'object|freq', 'object|idletime', 'object|refcount', 'object|help',
  'pubsub|channels', 'pubsub|numpat', 'pubsub|numsub', 'pubsub|shardchannels',
  'pubsub|shardnumsub', 'pubsub|help',
  'script|exists', 'script|help',
  'slowlog|get', 'slowlog|len', 'slowlog|help',
  'xgroup|help',
  'xinfo|consumers', 'xinfo|groups', 'xinfo|stream', 'xinfo|help',
];

/** Plain reads — mirror of redisguard's KNOWN_READ. */
export const REDIS_KNOWN_READ: readonly string[] = [
  'auth', 'bitcount', 'bitpos', 'dbsize', 'dump', 'echo', 'eval_ro',
  'evalsha_ro', 'exists', 'expiretime', 'fcall_ro', 'geodist', 'geohash',
  'geopos', 'geosearch', 'get', 'getbit', 'getrange', 'hello', 'hexists',
  'hexpiretime', 'hget', 'hgetall', 'hkeys', 'hlen', 'hmget', 'hpexpiretime',
  'hpttl', 'hrandfield', 'hscan', 'hstrlen', 'httl', 'hvals', 'info', 'keys',
  'lastsave', 'lcs', 'lindex', 'llen', 'lolwut', 'lpos', 'lrange', 'mget',
  'pexpiretime', 'pfcount', 'ping', 'pttl', 'publish', 'quit', 'randomkey',
  'role', 'scan', 'scard', 'sdiff', 'select', 'sinter', 'sintercard',
  'sismember', 'smembers', 'smismember', 'sort_ro', 'srandmember', 'sscan',
  'strlen', 'substr', 'sunion', 'time', 'touch', 'ttl', 'type', 'unsubscribe',
  'punsubscribe', 'sunsubscribe', 'wait', 'waitaof', 'xautoclaim_ro', 'xlen',
  'xrange', 'xread', 'xrevrange', 'zcard', 'zcount', 'zdiff', 'zinter',
  'zintercard', 'zlexcount', 'zmscore', 'zrandmember', 'zrange',
  'zrangebylex', 'zrangebyscore', 'zrank', 'zrevrange', 'zrevrangebylex',
  'zrevrangebyscore', 'zrevrank', 'zscan', 'zscore', 'zunion',
];

export type RedisClass = 'read' | 'write' | 'admin';

const WRITE = new Set(REDIS_WRITE_COMMANDS);
const ADMIN = new Set(REDIS_ADMIN_COMMANDS);
const CONTAINERS = new Set(REDIS_CONTAINERS);
const SAFE_SUB = new Set(REDIS_SAFE_SUBCOMMANDS);
const KNOWN_READ = new Set(REDIS_KNOWN_READ);

/**
 * Classify one command line. Only the first two whitespace-separated tokens
 * are consulted — command and subcommand names are bare tokens, so quoting
 * (which redisguard's `split_args` handles for VALUES) cannot change the
 * class. A line that would not tokenise there starts with a quote here and
 * lands in the same place: unknown → write.
 */
export function redisLineClass(line: string): RedisClass {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  const cmd = tokens[0]?.toLowerCase();
  if (!cmd) return 'read';

  if (CONTAINERS.has(cmd)) {
    const sub = tokens[1];
    // A bare container name is a usage error; harmless.
    if (!sub) return 'read';
    const full = `${cmd}|${sub.toLowerCase()}`;
    if (ADMIN.has(full)) return 'admin';
    if (WRITE.has(full)) return 'write';
    if (SAFE_SUB.has(full)) return 'read';
    // Unrecognised subcommand of a known container: assume the worst.
    return 'admin';
  }

  if (ADMIN.has(cmd)) return 'admin';
  if (WRITE.has(cmd)) return 'write';
  if (KNOWN_READ.has(cmd)) return 'read';
  // Unknown — could be a module command that writes.
  return 'write';
}

/**
 * True when a read-only server must refuse this text — any line that mutates
 * keys (write) or server state (admin). Mirrors `Class::mutates`, evaluated
 * per line so a write on line two of a script still pre-flights as a write.
 */
export function isRedisWrite(text: string): boolean {
  return text.split(/\r?\n/).some(line => redisLineClass(line) !== 'read');
}
