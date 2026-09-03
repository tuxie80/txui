#!/usr/bin/env bash
# Run the PostgreSQL DBA views against the majors we do not keep installed.
#
# The local fixtures (dbctl) cover 14 / 16 / 17 / 18. PostgreSQL 12 and 13 are
# still in the field, Homebrew no longer ships them, and every catalog query
# added to the panel multiplies the exposure — `plan-postgresql.md` §5.1 has
# been carrying "covered by reading rather than running" for those two for
# months. This closes it with containers, which need no permanent install.
#
#     dev/pg_old_matrix.sh            # 12 and 13
#     PG_MAJORS="11 12 13" dev/pg_old_matrix.sh
#
# Requires a running Docker daemon. Containers are named txui-pg<major>,
# started on a free high port, loaded with dev/pg_fixture.sql, probed, and
# removed — including on Ctrl-C.
#
# No daemon? Any already-running servers work just as well — this script's
# Docker half is only a fixture provider; the probe is the point:
#
#     PG_PORTS=55422,55423 node dev/probe_pg_views.mjs     # Node 25+
#     PG_PORTS=55422,55423 node --loader <ts-loader> dev/probe_pg_views.mjs   # Node 20
#
# (2026-08-27: PG 12.22 + 13.23 live-probed this way from source builds —
# 0 failures.) One pitfall: run the probe with a MODERN psql first in PATH —
# psql ≤ 14's `-c` returns only the last statement's result, so the version
# check reads nothing and reports a healthy server as "not reachable".
set -euo pipefail

MAJORS=${PG_MAJORS:-"12 13"}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT_BASE=${PORT_BASE:-55432}

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running — start it and re-run." >&2
  echo "The views also run against the installed majors: dbctl start pg14 pg16 pg17 pg18" >&2
  exit 1
fi

cleanup() {
  for major in $MAJORS; do
    docker rm -f "txui-pg$major" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

ports=""
offset=0
for major in $MAJORS; do
  port=$((PORT_BASE + offset))
  offset=$((offset + 1))
  echo "── PostgreSQL $major on :$port"
  docker rm -f "txui-pg$major" >/dev/null 2>&1 || true
  docker run -d --name "txui-pg$major" \
    -e POSTGRES_PASSWORD=root -e POSTGRES_USER=root -e POSTGRES_DB=root \
    -p "$port:5432" "postgres:$major" >/dev/null

  # The container reports ready before it accepts connections on the mapped
  # port; poll rather than sleep, so a slow machine does not fail spuriously.
  for _ in $(seq 1 60); do
    if PGPASSWORD=root psql -h 127.0.0.1 -p "$port" -U root -d root -c 'SELECT 1' >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  PGPASSWORD=root psql -h 127.0.0.1 -p "$port" -U root -d root -q \
    -v ON_ERROR_STOP=1 -f "$ROOT/dev/pg_fixture.sql" >/dev/null
  # Not preloaded in the stock image, so the statement views will report n/a —
  # which is the same thing a real server without it reports.
  PGPASSWORD=root psql -h 127.0.0.1 -p "$port" -U root -d root -q \
    -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' >/dev/null 2>&1 || true
  ports="${ports:+$ports,}$port"
done

echo
PG_PORTS="$ports" node --experimental-strip-types "$ROOT/dev/probe_pg_views.mjs"
