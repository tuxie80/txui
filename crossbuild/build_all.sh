#!/usr/bin/env bash
# crossbuild/build_all.sh — build every target this host can produce.
#
# Reality of Tauri cross-building (the matrix this encodes):
#
#   host \ target   macOS   Linux   Windows
#   macOS             ✓       ✗        ✓ (cargo-xwin)
#   Linux             ✗       ✓        ✓ (cargo-xwin)
#   Windows           ✗       WSL      ✓
#
# So no single machine makes all three; CI (crossbuild/ci/release.yml) is the
# "always all three" answer, this script is the local "everything possible
# here" answer.
set -euo pipefail
cd "$(dirname "$0")/.."

FAILED=""
run() { echo; echo "══ $* ══"; if ! "$@"; then FAILED="$FAILED $1"; fi; }

case "$(uname -s)" in
  Linux)
    run crossbuild/build_linux.sh
    run crossbuild/build_windows.sh
    echo; echo "(macOS target skipped: only buildable on a Mac — CI covers it)"
    ;;
  Darwin)
    run crossbuild/build_macos.sh
    run crossbuild/build_windows.sh
    echo; echo "(Linux target skipped: only buildable on Linux — CI covers it)"
    ;;
  *) echo "unsupported host $(uname -s)"; exit 1 ;;
esac

echo
if [ -n "$FAILED" ]; then
  echo "FAILED:$FAILED"; exit 1
fi
echo "all buildable targets succeeded"
