#!/usr/bin/env bash
# crossbuild/setup_llvm.sh — rootless LLVM (clang-cl/lld-link/llvm-rc) for the
# Windows cross-build. Needed once per machine; safe to re-run.
#
# Why not apt/brew clang: this works without root and pins one known-good
# LLVM for every machine. Prebuilt LLVM 18 links libtinfo.so.5, which current
# distros (Debian 13, Fedora 40+, …) no longer ship — a symlink to
# libtinfo.so.6 does NOT work (missing 5.x symbol versions), so we extract the
# real libtinfo5 from the distro archive into a private compat dir.
set -euo pipefail

LLVM_VER="18.1.8"
LLVM_DIR="${XBUILD_LLVM_DIR:-$HOME/.local/llvm}"

if [ -x "$LLVM_DIR/bin/clang-cl" ]; then
  echo "LLVM already at $LLVM_DIR — delete it to reinstall"
  exit 0
fi

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)  PKG="clang+llvm-${LLVM_VER}-x86_64-linux-gnu-ubuntu-18.04" ;;
  Darwin-arm64)  PKG="clang+llvm-${LLVM_VER}-arm64-apple-darwin22.0" ;;
  *) echo "no prebuilt LLVM ${LLVM_VER} mapping for $OS-$ARCH — install clang/lld via your package manager instead"; exit 1 ;;
esac

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "downloading LLVM $LLVM_VER ($PKG)…"
curl -fSL -o "$TMP/llvm.tar.xz" \
  "https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VER}/${PKG}.tar.xz"
mkdir -p "$HOME/.local"
tar -xJf "$TMP/llvm.tar.xz" -C "$TMP"
mv "$TMP/$PKG" "$LLVM_DIR"

# libtinfo5 compat (Linux only)
if [ "$OS" = Linux ] && ! "$LLVM_DIR/bin/clang-cl" --version >/dev/null 2>&1; then
  mkdir -p "$LLVM_DIR/lib-compat"
  echo "fetching libtinfo5 compat library…"
  curl -fSL -o "$TMP/tinfo5.deb" \
    "http://ftp.debian.org/debian/pool/main/n/ncurses/libtinfo5_6.4-4_amd64.deb"
  dpkg -x "$TMP/tinfo5.deb" "$TMP/tinfo5"
  cp -a "$TMP/tinfo5/lib/x86_64-linux-gnu/libtinfo.so.5"* "$LLVM_DIR/lib-compat/"
fi

export LD_LIBRARY_PATH="$LLVM_DIR/lib-compat${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"$LLVM_DIR/bin/clang-cl" --version
echo "LLVM ready at $LLVM_DIR"
