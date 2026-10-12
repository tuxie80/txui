#!/bin/sh
# dev/bump_tap.sh — update the Homebrew tap cask after a release.
# Part of the release checklist (AGENTS.md "CI / release"): run once the CI
# checksums job has uploaded sha256sums.txt for the tag.
#
#   sh dev/bump_tap.sh 1.2.0
#
# Reads the dmg's sha256 from the release's sha256sums.txt (no 100 MB
# download), updates Casks/txui.rb in a local clone of tuxie80/homebrew-tap
# (TAP_DIR, default sibling ../homebrew-tap), commits and pushes.

set -eu

VERSION="${1:-}"
case "$VERSION" in
  *.*.*) ;;
  *) echo "usage: sh dev/bump_tap.sh X.Y.Z" >&2; exit 2 ;;
esac

REPO="tuxie80/txui"
TAP_DIR="${TAP_DIR:-$(cd "$(dirname "$0")/.." && pwd)/../homebrew-tap}"
DMG="TxUI_${VERSION}_universal.dmg"

SHA=$(curl -fsSL "https://github.com/$REPO/releases/download/v$VERSION/sha256sums.txt" \
  | grep " $DMG\$" | awk '{print $1}')
[ "$SHA" != "" ] || { echo "no sha256 for $DMG in release v$VERSION — did the checksums job run?" >&2; exit 1; }

[ -d "$TAP_DIR/.git" ] || git clone -q git@github-tuxie80:tuxie80/homebrew-tap.git "$TAP_DIR"
git -C "$TAP_DIR" pull -q --ff-only

CASK="$TAP_DIR/Casks/txui.rb"
sed -i '' "s/^  version \".*\"/  version \"$VERSION\"/; s/^  sha256 \".*\"/  sha256 \"$SHA\"/" "$CASK"
grep -q "version \"$VERSION\"" "$CASK" || { echo "cask version update failed" >&2; exit 1; }

git -C "$TAP_DIR" add Casks/txui.rb
if git -C "$TAP_DIR" diff --cached --quiet; then
  echo "tap already at $VERSION — nothing to do"
else
  git -C "$TAP_DIR" commit -q -m "TxUI $VERSION"
  git -C "$TAP_DIR" push -q
  echo "tap updated: tuxie80/tap/txui $VERSION ($SHA)"
fi
