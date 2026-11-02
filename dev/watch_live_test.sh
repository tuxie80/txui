#!/bin/sh
# Tiny live watcher matrix. Every dbctl instance is destroyed on exit.
set -eu

cd "$(dirname "$0")/../src-tauri"

for target in mysql@8.4 percona@8.4 mariadb@11.8 postgresql@17 duckdb@2; do
  case "$target" in
    mysql@*|percona@*) test_name=dbctl_mysql_watch_lock_stages_completion_and_privileges ;;
    mariadb@*) test_name=dbctl_mysql_watch_lock_stages_completion_and_privileges ;;
    postgresql@*) test_name=dbctl_postgres_watch_lock_completion_and_privileges ;;
    duckdb@*) test_name=dbctl_duckdb_2_file ;;
  esac
  printf '\n== %s ==\n' "$target"
  case "$target" in
    mysql@*|percona@*|mariadb@*) extra_args='--set conf.performance_schema=ON' ;;
    *) extra_args='' ;;
  esac
  # extra_args intentionally splits into dbctl's --set key=value pair.
  dbctl tmp "$target" --profile tiny $extra_args -- \
    cargo test --lib "$test_name" -- --ignored --nocapture
done

printf '\n== mariadb@11.8 native progress with performance_schema=OFF ==\n'
dbctl tmp mariadb@11.8 --profile tiny --set conf.performance_schema=OFF -- \
  cargo test --lib dbctl_mariadb_native_vector_compression_live -- --ignored --nocapture

printf '\nMySQL, Percona, MariaDB, PostgreSQL and DuckDB live watcher checks passed.\n'
printf 'SQL Server remains opt-in through TXUI_MSSQL_*; dbctl has no SQL Server engine.\n'
