#!/usr/bin/env bash
# crossbuild/setup_nsis.sh — rootless NSIS (makensis) for building the Windows
# installer off-Windows. Needed once per machine; safe to re-run.
#
# tauri-bundler runs plain `makensis` from PATH on non-Windows hosts and
# *strips* NSISDIR/NSISCONFDIR from its environment — so a rootless NSIS must
# be reachable through a wrapper that re-exports NSISDIR. Two more traps this
# handles:
#   - Debian/Ubuntu split NSIS in two: `nsis` (binary) + `nsis-common`
#     (stubs/plugins) — you need BOTH, and dpkg -x works without root.
#   - makensis finds its data via the compile-time prefix /usr/share/nsis;
#     the wrapper + NSISDIR is the only no-root override.
set -euo pipefail

NSIS_HOME="${XBUILD_NSIS_DIR:-$HOME/.local/nsis}"
BIN_DIR="$HOME/.local/bin"

if [ -x "$BIN_DIR/makensis" ] && [ -d "$NSIS_HOME/share/Stubs" ]; then
  echo "NSIS already installed ($BIN_DIR/makensis) — delete $NSIS_HOME and $BIN_DIR/makensis to reinstall"
  exit 0
fi

OS="$(uname -s)"
if [ "$OS" = Darwin ]; then
  echo "On macOS just use Homebrew: brew install nsis   (makensis lands on PATH, no wrapper needed)"
  exit 0
fi

command -v apt >/dev/null || { echo "no apt — install nsis + nsis-common via your distro, then symlink makensis into $BIN_DIR"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
(cd "$TMP" && apt download nsis nsis-common >/dev/null 2>&1)
mkdir -p "$NSIS_HOME" "$BIN_DIR"
for d in "$TMP"/*.deb; do dpkg -x "$d" "$TMP/root"; done
cp -a "$TMP/root/usr/bin/makensis" "$NSIS_HOME/makensis.real"
cp -a "$TMP/root/usr/share/nsis" "$NSIS_HOME/share"

cat > "$BIN_DIR/makensis" <<'EOF'
#!/bin/sh
# tauri-bundler strips NSISDIR from the makensis environment; this wrapper
# re-adds it so the rootless NSIS install finds its stubs/plugins.
export NSISDIR="$HOME/.local/nsis/share"
exec "$HOME/.local/nsis/makensis.real" "$@"
EOF
chmod +x "$BIN_DIR/makensis"

"$BIN_DIR/makensis" -VERSION
echo "NSIS ready: $BIN_DIR/makensis (data: $NSIS_HOME/share)"
echo "make sure $BIN_DIR is on PATH — build_windows.sh prepends it automatically"
