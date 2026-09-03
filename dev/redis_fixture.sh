#!/bin/sh
# dbgui Redis test fixture — one key of every type the browser must render,
# plus volume for SCAN paging and a few deliberate edge cases.
# Usage: sh dev/redis_fixture.sh [host] [port]
H="${1:-127.0.0.1}"; P="${2:-6379}"
R="redis-cli -h $H -p $P"

$R FLUSHDB >/dev/null

# ── strings ────────────────────────────────────────────────────────────
$R SET greeting "hello world"                     >/dev/null   # quoted value
$R SET counter 42                                 >/dev/null
$R SET big "$(head -c 4096 /dev/zero | tr '\0' 'x')" >/dev/null
$R SET json:doc '{"a":1,"b":[2,3]}'               >/dev/null
$R SET binary "$(printf 'a\x00b')"                >/dev/null   # embedded NUL
$R SET ttl:soon later                             >/dev/null
$R EXPIRE ttl:soon 3600                           >/dev/null

# ── hash / list / set / zset / stream ──────────────────────────────────
$R HSET user:1 name "Ada Lovelace" email ada@example.com age 36 >/dev/null
$R RPUSH queue:jobs job1 job2 job3 job4           >/dev/null
$R SADD tags:post1 rust redis database            >/dev/null
$R ZADD leaderboard 100 alice 250 bob 175 carol   >/dev/null
$R XADD events:log '*' kind login user alice      >/dev/null
$R XADD events:log '*' kind logout user alice     >/dev/null
$R XGROUP CREATE events:log workers 0             >/dev/null 2>&1

# ── other types ────────────────────────────────────────────────────────
$R PFADD visitors u1 u2 u3 u4 u5                  >/dev/null   # hyperloglog
$R SETBIT flags:online 7 1                        >/dev/null   # bitmap (string)
$R GEOADD cities 14.42 50.08 prague 2.35 48.85 paris >/dev/null

# ── volume, for SCAN paging + prefix grouping ──────────────────────────
for i in $(seq 1 500); do
  echo "SET session:$i tok$i"
  echo "HSET product:$i name p$i price $i"
done | $R --pipe >/dev/null 2>&1

echo "fixture loaded: $($R DBSIZE) keys in db0"
$R -n 3 SET other:db:key marker >/dev/null
echo "db3 seeded: $($R -n 3 DBSIZE) key"
