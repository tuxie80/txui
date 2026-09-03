#!/usr/bin/env bash
# crossbuild/build_macos.sh — macOS bundle. macOS is the "home" dev platform,
# so this is the trivial native path; it only exists so every target has the
# same one-command shape. macOS binaries cannot legally or technically be
# cross-built from another OS (Apple SDK licence).
#
#   crossbuild/build_macos.sh                 # TxUI.app, Apple Silicon
#   crossbuild/build_macos.sh --dmg           # + TxUI_<version>_aarch64.dmg
#   crossbuild/build_macos.sh --universal     # fat ARM+Intel
#   crossbuild/build_macos.sh --dmg --universal
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(uname -s)" = Darwin ] || { echo "macOS builds must run on macOS — use CI for this target"; exit 1; }
crossbuild/check_env.sh macos || { echo "fix the ✗ items above first"; exit 1; }

UNIVERSAL=0
BUNDLES=app
for a in "$@"; do
  case "$a" in
    --universal) UNIVERSAL=1 ;;
    # The .app alone is what you run locally; the .dmg is what you HAND to
    # someone. Tauri names it TxUI_<version>_<arch>.dmg from the version in
    # tauri.conf.json, so the artifact carries the version while the installed
    # app stays plain "TxUI" — a stable Dock entry that upgrades replace.
    --dmg)       BUNDLES=app,dmg ;;
    *) echo "unknown flag: $a (want --dmg and/or --universal)"; exit 1 ;;
  esac
done

# Ad-hoc code signature. Without ANY signature macOS reports a downloaded app
# as "damaged" — a quarantine flag, not corruption, but indistinguishable from
# one to whoever you gave it to. Ad-hoc costs nothing and needs no Apple
# account; it does NOT clear Gatekeeper on another machine, where the app still
# needs one right-click → Open (or `xattr -dr com.apple.quarantine TxUI.app`).
#
# Set as an env var rather than `signingIdentity` in tauri.conf.json so a real
# Developer ID later is a one-line override here and CI is left alone:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: …" crossbuild/build_macos.sh --dmg
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"

npm ci
if [ "$UNIVERSAL" = 1 ]; then
  rustup target add x86_64-apple-darwin
  cargo tauri build --target universal-apple-darwin --bundles "$BUNDLES"
else
  cargo tauri build --bundles "$BUNDLES"
fi

echo
echo "artifacts:"
for f in src-tauri/target*/release/bundle/macos/*.app \
         src-tauri/target/release/bundle/macos/*.app \
         src-tauri/target*/release/bundle/dmg/*.dmg \
         src-tauri/target/release/bundle/dmg/*.dmg; do
  [ -e "$f" ] || continue
  printf '  %7s  %s\n' "$(du -sh "$f" | cut -f1)" "$f"
done | sort -u

# Prove the signature is really on the bundle rather than assumed.
for app in src-tauri/target*/release/bundle/macos/*.app; do
  [ -e "$app" ] || continue
  echo
  echo "signature:"
  codesign -dv "$app" 2>&1 | sed 's/^/  /'
  codesign --verify --deep --strict "$app" 2>&1 | sed 's/^/  /' && echo "  ✓ signature verifies"
done
