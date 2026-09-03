#!/usr/bin/env bash
# crossbuild/build_windows.sh — Windows x86_64 NSIS installer, cross-compiled
# FROM Linux or macOS. No Windows machine, no Visual Studio:
#
#   cargo-xwin  downloads the MSVC CRT + Windows SDK headers/libs from
#               Microsoft (~1 GB, cached in ~/.cache/cargo-xwin)
#   clang-cl    MSVC-compatible C driver (ring compiles C even in a
#               "pure rustls" build — without it the build dies in ring)
#   lld-link    MSVC-compatible linker
#   llvm-rc     embeds the icon + version manifest into TxUI.exe
#   makensis    packs TxUI.exe into the NSIS installer — the bundler runs it
#               from PATH and strips NSISDIR, so a rootless install needs the
#               wrapper from crossbuild/setup_nsis.sh
#
# MSI is NOT produced here: WiX only runs on Windows. NSIS is the cross-
# platform installer format; that is a Tauri/Windows fact, not a gap in this
# script. Get the MSI from CI (crossbuild/ci/release.yml) if you need it.
set -euo pipefail
cd "$(dirname "$0")/.."

# Rootless tool installs live here (setup_llvm.sh / setup_nsis.sh).
export PATH="$HOME/.local/bin:$PATH"

crossbuild/check_env.sh windows || { echo "fix the ✗ items above first"; exit 1; }

# libduckdb-sys (bundled DuckDB engine) marks its C++ API with
# __declspec(dllexport) on Windows targets, and clang-cl (unlike MSVC) hard-
# errors on dllexport applied to =delete'd functions (variant_stats.hpp:
# "attribute 'dllexport' cannot be applied to a deleted function"). DuckDB is
# linked STATICALLY into TxUI.exe, so the dllexport is dead weight; the patch
# script strips DUCKDB_API from those two deleted declarations inside the
# crate's duckdb.tar.gz (idempotent, content-keyed, backup kept). A CXXFLAGS
# define does NOT work here: cargo-xwin overwrites the target-scoped flags.
crossbuild/patch_duckdb_clangcl.sh

# Private LLVM location used when the OS package manager is unavailable
# (no root). See README §Windows toolchain.
LLVM_DIR="${XBUILD_LLVM_DIR:-$HOME/.local/llvm}"
if [ -x "$LLVM_DIR/bin/clang-cl" ]; then
  export PATH="$LLVM_DIR/bin:$PATH"
  # Prebuilt LLVM ≤19 links libtinfo.so.5, which current Debian/Fedora no
  # longer ship. The compat dir holds the real library extracted from a
  # distro package — see crossbuild/setup_llvm.sh.
  [ -d "$LLVM_DIR/lib-compat" ] && export LD_LIBRARY_PATH="$LLVM_DIR/lib-compat${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

npm ci
cargo tauri build --runner cargo-xwin \
  --target x86_64-pc-windows-msvc \
  --bundles nsis

echo
echo "artifacts:"
ls -la src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
