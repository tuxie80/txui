#!/usr/bin/env bash
# crossbuild/check_env.sh — detect the host, audit every build prerequisite,
# and print exactly what is missing and how to fix it. Read-only: it never
# installs anything, it only reports.
#
#   crossbuild/check_env.sh            # audit everything
#   crossbuild/check_env.sh windows    # audit one target (linux|windows|macos)
#
# Exit status: 0 = every audited target is buildable, 1 = something is missing.
# The report lines are deliberately copy-pasteable fixes.
set -uo pipefail

cd "$(dirname "$0")/.."
ONLY="${1:-all}"

# ── host detection ────────────────────────────────────────────────────────
HOST_OS="$(uname -s)"          # Linux | Darwin
HOST_ARCH="$(uname -m)"        # x86_64 | arm64 | aarch64
case "$HOST_OS" in
  Linux)  HOST=linux ;;
  Darwin) HOST=macos ;;
  *)      HOST=unknown ;;
esac

ok=0; miss=0
have()  { command -v "$1" >/dev/null 2>&1; }
good()  { printf '  ✓ %s\n' "$1"; ok=$((ok+1)); }
bad()   { printf '  ✗ %s\n         fix: %s\n' "$1" "$2"; miss=$((miss+1)); }
warn()  { printf '  ~ %s\n' "$1"; }

echo "host: $HOST_OS $HOST_ARCH  (targets: ${ONLY})"
echo

# ── shared prerequisites (all targets) ────────────────────────────────────
echo "── shared ────────────────────────────────────────────────"
have cargo  && good "cargo $(cargo --version | awk '{print $2}')" \
            || bad  "cargo not found" "install rustup: https://rustup.rs"
if [ -f rust-toolchain.toml ]; then
  PINNED="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
  ACTIVE="$(rustc --version 2>/dev/null | awk '{print $2}')"
  if [ "$PINNED" = "$ACTIVE" ]; then
    good "rustc pinned and active: $ACTIVE"
  else
    bad "rustc is $ACTIVE, project pins $PINNED" "rustup toolchain install $PINNED (rustup auto-selects it via rust-toolchain.toml)"
  fi
else
  warn "no rust-toolchain.toml — binaries will depend on whatever rustc happens to be installed"
fi
have node && good "node $(node --version)" || bad "node not found" "install Node 20+ (frontend build)"
if [ -d node_modules ] && [ -x node_modules/.bin/tsc ]; then
  good "node_modules present and functional"
else
  bad "node_modules missing or broken (it is NOT portable across OS/arch)" "rm -rf node_modules && npm ci"
fi
if have cargo-tauri || cargo tauri --version >/dev/null 2>&1; then
  good "tauri CLI $(cargo tauri --version 2>/dev/null | awk '{print $1}')"
else
  bad "tauri CLI not found" "cargo install tauri-cli --version '^2' --locked"
fi
echo

# ── Linux target (native on Linux hosts only) ─────────────────────────────
if [ "$ONLY" = all ] || [ "$ONLY" = linux ]; then
  echo "── linux x86_64 (AppImage + .deb) ───────────────────────"
  if [ "$HOST" != linux ]; then
    warn "cross-building a Linux Tauri app from $HOST_OS is not supported (WebKitGTK is a system dependency) — build on Linux or in CI/Docker"
  else
    for pc in webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1 librsvg-2.0 openssl; do
      pkg-config --exists "$pc" 2>/dev/null && good "pkg-config: $pc" \
        || bad "pkg-config: $pc missing" "sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev"
    done
    have patchelf && good "patchelf (AppImage bundling)" \
      || bad "patchelf missing" "sudo apt install patchelf"
    have dpkg && good "dpkg (.deb bundling)" || warn "no dpkg — .deb bundling will be skipped"
  fi
  echo
fi

# ── Windows target (cross from Linux/macOS via cargo-xwin) ────────────────
if [ "$ONLY" = all ] || [ "$ONLY" = windows ]; then
  echo "── windows x86_64 (NSIS installer, cross via cargo-xwin) ─"
  if [ "$HOST" = unknown ]; then
    warn "unknown host OS"
  else
    if rustup target list --installed 2>/dev/null | grep -q '^x86_64-pc-windows-msvc$'; then
      good "rust target x86_64-pc-windows-msvc installed"
    else
      bad "windows rust target missing" "rustup target add x86_64-pc-windows-msvc"
    fi
    have cargo-xwin && good "cargo-xwin $(cargo xwin --version 2>/dev/null | awk '{print $2}')" \
      || bad "cargo-xwin not found" "cargo install cargo-xwin --locked"
    # clang-cl may live in a private LLVM dir (no root needed)
    LLVM_BIN="${XBUILD_LLVM_DIR:-$HOME/.local/llvm}/bin"
    if have clang-cl || [ -x "$LLVM_BIN/clang-cl" ]; then
      good "clang-cl (MSVC-compatible C driver, needed by ring's C sources)"
    else
      bad "clang-cl not found" "see crossbuild/README.md §Windows toolchain — prebuilt LLVM works without root"
    fi
    if have lld-link || [ -x "$LLVM_BIN/lld-link" ]; then
      good "lld-link (MSVC-compatible linker)"
    else
      bad "lld-link not found" "same LLVM package as clang-cl"
    fi
    if have llvm-rc || [ -x "$LLVM_BIN/llvm-rc" ]; then
      good "llvm-rc (embeds icon/manifest into the .exe)"
    else
      warn "llvm-rc not found — the .exe may ship without icon/version metadata"
    fi
    # makensis packs the installer; tauri-bundler strips NSISDIR, so a
    # rootless install must come through the setup_nsis.sh wrapper
    if have makensis || [ -x "$HOME/.local/bin/makensis" ]; then
      good "makensis (NSIS installer bundling)"
    else
      bad "makensis not found" "crossbuild/setup_nsis.sh (rootless) or sudo apt install nsis nsis-common"
    fi
    if [ -d "${XWIN_CACHE_DIR:-$HOME/.cache/cargo-xwin}" ]; then
      good "cargo-xwin MSVC CRT/SDK cache present"
    else
      warn "MSVC CRT/SDK not downloaded yet — first build fetches ~1 GB from Microsoft automatically"
    fi
    echo "     note: .msi bundling is impossible off Windows (WiX); NSIS works cross-platform — this is normal, not a gap"
  fi
  echo
fi

# ── macOS target (native only) ────────────────────────────────────────────
if [ "$ONLY" = all ] || [ "$ONLY" = macos ]; then
  echo "── macOS (Apple Silicon, .app bundle) ────────────────────"
  if [ "$HOST" != macos ]; then
    warn "macOS binaries can only be built on macOS (Apple SDK licence + toolchain) — use CI or a Mac"
  else
    have xcodebuild && good "Xcode command line tools" \
      || bad "xcodebuild missing" "xcode-select --install"
    rustup target list --installed 2>/dev/null | grep -q '^aarch64-apple-darwin$' \
      && good "rust target aarch64-apple-darwin" \
      || bad "aarch64-apple-darwin missing" "rustup target add aarch64-apple-darwin"
  fi
  echo
fi

echo "── summary: $ok ok, $miss missing ───────────────────────"
[ "$miss" -eq 0 ]
