#!/usr/bin/env bash
# crossbuild/patch_duckdb_clangcl.sh — one-line-class patch to the vendored
# DuckDB sources so the WINDOWS cross-build survives clang-cl.
#
# Why this exists: libduckdb-sys defines DUCKDB_BUILD_LIBRARY on Windows
# targets, so duckdb/common/winapi.hpp expands DUCKDB_API to
# __declspec(dllexport). clang-cl (unlike MSVC) hard-errors when dllexport
# lands on a =delete'd function:
#
#   variant_stats.hpp: error: attribute 'dllexport' cannot be applied to a
#   deleted function
#
# DuckDB is linked STATICALLY into TxUI.exe — the dllexport is dead weight —
# so stripping DUCKDB_API from the two deleted overloads is safe on every
# compiler, MSVC included (a deleted function exports nothing anyway).
#
# The sources live inside the crate's duckdb.tar.gz (extracted fresh on every
# build, so patching OUT_DIR is useless). This script patches the tarball in
# the cargo registry, idempotently, keeping a one-time .txui-orig backup.
# It is keyed to the tarball CONTENT, not a version number: upgrade duckdb
# and a fixed upstream tarball is simply left alone; an unfixed one gets
# patched again.
set -euo pipefail

HDR="duckdb/src/include/duckdb/storage/statistics/variant_stats.hpp"
found=0

shopt -s nullglob
for crate in "$HOME"/.cargo/registry/src/*/libduckdb-sys-*/; do
  tgz="$crate/duckdb.tar.gz"
  [ -f "$tgz" ] || continue
  found=1
  if tar xzOf "$tgz" "$HDR" 2>/dev/null | grep -q 'DUCKDB_API.*= *delete'; then
    echo "patching $tgz (clang-cl dllexport-on-deleted-function)"
    [ -f "$tgz.txui-orig" ] || cp -p "$tgz" "$tgz.txui-orig"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    tar xzf "$tgz" -C "$tmp"
    # Strip DUCKDB_API from =delete'd declarations in this header only.
    sed -i '/= *delete;/s/DUCKDB_API //' "$tmp/$HDR"
    if grep -q 'DUCKDB_API.*= *delete' "$tmp/$HDR"; then
      echo "ERROR: patch did not take" >&2
      exit 1
    fi
    tar czf "$tgz.tmp" -C "$tmp" duckdb
    mv "$tgz.tmp" "$tgz"
    rm -rf "$tmp"
    trap - EXIT
  else
    echo "ok (already fixed or not affected): $tgz"
  fi
done

if [ "$found" -eq 0 ]; then
  echo "note: no libduckdb-sys found in the cargo registry yet — run once after the first fetch" >&2
fi
