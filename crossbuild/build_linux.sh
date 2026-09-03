#!/usr/bin/env bash
# crossbuild/build_linux.sh — native Linux x86_64 release.
#
# Deliverables:
#   AppImage  THE portable format: one file, binary + all bundled libraries,
#             chmod +x and run. No install, no root. There is no such thing as
#             a static Tauri binary — WebKitGTK/GTK/glibc are dynamic system
#             libraries — so the AppImage is as close to "one binary" as
#             Linux gets.
#   .deb      optional proper-install format.
#   raw bin   copied next to them for convenience; it is NOT portable (needs
#             libwebkit2gtk-4.1 etc. installed on the target machine).
#
# glibc floor: an AppImage runs only on systems with glibc >= the build
# machine's. For widest compatibility build on the oldest supported distro
# (CI uses ubuntu-22.04). A Debian-13 local build targets modern distros.
#
# Must run ON a Linux x86_64 host — cross-compiling into Linux is not
# supported for Tauri (WebKitGTK is a system dependency). Use CI elsewhere.
set -euo pipefail
cd "$(dirname "$0")/.."

crossbuild/check_env.sh linux || { echo "fix the ✗ items above first"; exit 1; }

npm ci
# AppImage bundling shells out to linuxdeploy, which needs FUSE; on FUSE-less
# systems (containers, some modern distros) this makes tauri-bundler extract
# and run it instead. Harmless when FUSE exists.
export APPIMAGE_EXTRACT_AND_RUN=1
cargo tauri build --bundles appimage,deb

OUT="src-tauri/target/release/bundle"
cp -f src-tauri/target/release/TxUI "$OUT/TxUI-linux-x86_64.raw-binary-NOT-portable"

echo
echo "artifacts:"
ls -la "$OUT/appimage/"*.AppImage "$OUT/deb/"*.deb "$OUT/TxUI-linux-x86_64.raw-binary-NOT-portable"
