#!/usr/bin/env bash
# Compile the OTHER platforms' `#[cfg]` branches without cross-compiling.
#
# Real cross-compilation needs the target's C toolchain — `cargo check --target
# x86_64-pc-windows-msvc` dies inside `ring` for want of a Windows SDK long
# before it reaches our code. So the platform branches used to be verified by
# reading them, which is how a branch that has never been compiled ends up
# shipped.
#
# This copies the crate, rewrites the platform gates so the Windows (or Linux)
# side is the one the local compiler sees, and builds that. It cannot catch
# anything needing a Windows-only *API* — but every gate we own is written in
# portable std, so what it does catch is exactly the failure mode that matters:
# a branch that does not compile because nobody ever compiled it.
#
#   dev/xplat_check.sh            # both profiles
#   dev/xplat_check.sh windows    # one
#   dev/xplat_check.sh --keep     # leave the work tree for investigation
#
# The work trees are ~4.4 GB per profile and are deleted on exit unless --keep
# is given.
#
# CI builds all three for real; this is the fast local check before pushing.
set -euo pipefail

# Each profile is a full copy of the crate plus its own target dir — ~4.4 GB
# apiece, measured. Left behind they accumulate silently in TMPDIR until
# somebody wonders where the disk went, so they are removed on the way out
# however the script exits. `--keep` overrides that when a failure needs
# investigating.
KEEP=0
[ "${1:-}" = "--keep" ] && { KEEP=1; shift; }
cleanup() {
  [ "$KEEP" = "1" ] && { echo "kept: $WORK"; return; }
  rm -rf "$WORK"
}
trap cleanup EXIT

cd "$(dirname "$0")/.."
SRC="src-tauri"
WORK="${TMPDIR:-/tmp}/txui-xplat"
PROFILES="${1:-windows linux}"
FAILED=0

# Set once, covering every profile: a trap set inside the loop is replaced on
# the next iteration, so the earlier profile's lock would survive the run and
# the *next* run would refuse to start with "another xplat_check is using…".
# Editing this script while it is running is also a way to break it — bash
# reads it incrementally, so shifting the byte offsets mid-run produces a
# syntax error in whatever the file now has at that position.
mkdir -p "$WORK"
cleanup_locks() { for p in $PROFILES; do rm -f "$WORK/$p.lock"; done; }
trap cleanup_locks EXIT INT TERM

for profile in $PROFILES; do
  echo "── $profile ─────────────────────────────────────────────"
  rm -rf "$WORK/$profile"
  mkdir -p "$WORK"
  cp -R "$SRC" "$WORK/$profile"
  rm -rf "$WORK/$profile/target"

  python3 - "$WORK/$profile/src" "$profile" <<'PY'
import pathlib, sys
root, profile = pathlib.Path(sys.argv[1]), sys.argv[2]
ON, OFF = '#[cfg(not(XPLAT_OFF))]', '#[cfg(XPLAT_OFF)]'

if profile == 'windows':
    subs = {
        '#[cfg(unix)]': OFF,
        '#[cfg(not(unix))]': ON,
        '#[cfg_attr(not(unix), allow(unused_mut))]': '#[allow(unused_mut)]',
        '#[cfg(windows)]': ON,
        '#[cfg(not(windows))]': OFF,
        '#[cfg(target_os = "macos")]': OFF,
        '#[cfg(target_os = "linux")]': OFF,
        '#[cfg(target_os = "windows")]': ON,
        '#[cfg(not(target_os = "macos"))]': ON,
        '#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]': OFF,
        '#[cfg(not(any(target_os = "macos", target_os = "windows")))]': OFF,
    }
else:  # linux — unix APIs exist, so those gates stay as they are
    subs = {
        '#[cfg(target_os = "macos")]': OFF,
        '#[cfg(target_os = "windows")]': OFF,
        '#[cfg(target_os = "linux")]': ON,
        '#[cfg(not(target_os = "macos"))]': ON,
        '#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]': OFF,
        '#[cfg(not(any(target_os = "macos", target_os = "windows")))]': ON,
    }

# A gate whose preceding line carries `xplat-skip` is left exactly as written.
#
# This exists for the one thing this script has always documented that it
# cannot do: a branch that calls a Windows-only *API*. Forcing such a gate on
# while compiling against a macOS toolchain does not test the branch — the
# function it calls does not exist in this build of `tokio`/`std` — it just
# fails, every time, for a reason that has nothing to do with our code.
#
# The marker is deliberately noisy and greppable: each use is a line the
# checker cannot vouch for, and the count of them should stay countable.
SKIP = 'xplat-skip'

def rewrite(text):
    out, changed = [], False
    lines = text.split('\n')
    for i, line in enumerate(lines):
        prev = lines[i - 1] if i > 0 else ''
        if SKIP in prev:
            out.append(line)
            continue
        new_line = line
        for a, b in subs.items():
            new_line = new_line.replace(a, b)
        changed = changed or new_line != line
        out.append(new_line)
    return '\n'.join(out), changed

n = skipped = 0
for p in root.rglob('*.rs'):
    original = p.read_text()
    skipped += original.count(SKIP)
    s, changed = rewrite(original)
    if changed:
        p.write_text(s)
        n += 1
note = f"  rewrote gates in {n} files"
if skipped:
    note += f"  ({skipped} gate(s) skipped: native API, cannot be checked here)"
print(note)
PY

  # The verdict comes from cargo's own exit status, not from whether grep
  # found something to print.
  #
  # It used to be `cargo build | grep -E "^error"`, with the `if` reading
  # grep's status — and under `set -o pipefail` the pipeline's status is
  # cargo's failure, not grep's match, so the branches were **inverted**: a
  # failing build printed its errors and was then announced as "✓ compiles".
  # A checker that says ✓ exactly when it should say ✗ is worse than no
  # checker, and it went unnoticed because the happy path looks identical.
  # A second concurrent run would rm -rf this directory out from under the
  # first one, and the failure it produces ("could not find Cargo.toml") looks
  # nothing like a platform problem. One run at a time.
  if [ -e "$WORK/$profile.lock" ]; then
    echo "  ✗ another xplat_check is using $WORK/$profile — run one at a time"
    exit 1
  fi
  : > "$WORK/$profile.lock"

  build_log="$WORK/$profile.log"
  if (cd "$WORK/$profile" && cargo build --lib) > "$build_log" 2>&1; then
    echo "  ✓ $profile branches compile"
  else
    echo "  ✗ $profile branches do NOT compile"
    grep -E "^(error|warning: unused)" -A 8 "$build_log" | head -60 || true
    FAILED=1
  fi
done

exit $FAILED
