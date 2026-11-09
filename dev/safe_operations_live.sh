#!/bin/sh
# Full live Safe Operations matrix. Every dbctl instance is destroyed on exit.
set -u

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TOTAL_GROUPS=8
TOTAL_TESTS=52
passed_groups=0
passed_tests=0
failed_groups=0
group=0

trap 'exit 130' INT TERM

for command in dbctl cargo node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'ERROR: required command not found: %s\n' "$command" >&2
    exit 2
  fi
done

run_group() {
  feature=$1
  target=$2
  filter=$3
  expected=$4
  skip_args=${5:-}
  group=$((group + 1))
  printf '\n[%d/%d] %s | %s | %d live tests\n' "$group" "$TOTAL_GROUPS" "$feature" "$target" "$expected"
  if (
    cd "$ROOT/src-tauri" || exit 2
    # skip_args intentionally splits into libtest's --skip FILTER pair.
    dbctl tmp "$target" --profile tiny -- \
      cargo test --lib "$filter" -- --ignored --nocapture --test-threads=1 $skip_args
  ); then
    passed_groups=$((passed_groups + 1))
    passed_tests=$((passed_tests + expected))
    printf 'PASS: %s | %s | %d/%d tests\n' "$feature" "$target" "$expected" "$expected"
  else
    failed_groups=$((failed_groups + 1))
    printf 'FAIL: %s | %s | see the cargo output above\n' "$feature" "$target" >&2
  fi
}

run_group 'Migration Cockpit' mysql@8.4 'commands::migration::tests::dbctl_mysql_' 7
run_group 'Migration Cockpit' mariadb@11.8 'commands::migration::tests::dbctl_mysql_' 7
run_group 'Migration Cockpit' postgres@18 'commands::migration::tests::dbctl_postgres_' 7
run_group 'Environment Refresh' mysql@8.4 'commands::refresh::' 7
run_group 'Environment Refresh' mariadb@11.8 'commands::refresh::' 7
run_group 'Query Optimization Lab' mysql@8.4 'commands::query_lab::tests::dbctl_mysql_' 5
run_group 'Query Optimization Lab' mariadb@11.8 'commands::query_lab::tests::dbctl_mysql_' 5
run_group 'Query Optimization Lab + HypoPG' postgres@18 'commands::query_lab::tests::dbctl_' 7 '--skip dbctl_mysql_'

# The three engine/feature areas are independent; keep their exact totals visible.
printf '\nSafe Operations live summary\n'
printf '  Migration Cockpit:      21 tests (MySQL 8.4, MariaDB 11.8, PostgreSQL 18)\n'
printf '  Environment Refresh:    14 tests (MySQL 8.4, MariaDB 11.8)\n'
printf '  Query Optimization Lab: 17 tests (all three engines, including HypoPG)\n'
printf '  Result: %d/%d tests passed in %d/%d groups; %d groups failed\n' \
  "$passed_tests" "$TOTAL_TESTS" "$passed_groups" "$TOTAL_GROUPS" "$failed_groups"

if [ "$failed_groups" -ne 0 ] || [ "$passed_tests" -ne "$TOTAL_TESTS" ]; then
  exit 1
fi
printf 'All Safe Operations dbctl fixtures passed and were destroyed.\n'
