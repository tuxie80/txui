#!/usr/bin/env bash
# dev/archive_docs.sh vX.Y.Z [vY.Z.W …] — snapshot the generated help of past
# releases into site/docs-archive/, so tuxie.eu/txui/docs-archive/ can serve
# the docs AS THEY WERE at each tag.
#
# Sources come from git, not from a checkout: docs/index.html, docs/shots/,
# docs/user-guide/screenshots/ and docs/inventory.json are tracked (only the
# .md sources stay local per .gitignore), so any tagged release archives
# cleanly without touching the working tree.
#
# Also (re)writes site/docs-archive/index.html listing every snapshot present,
# newest first. site/ is local-only and the deploy mirror is additive, so the
# archive lives on this machine and on the server — same as the demo video.
#
# Release-procedure hook: run `sh dev/archive_docs.sh X.Y.Z` right after
# tagging, BEFORE deploying the new docs (the deploy carries the archive up).

set -euo pipefail
cd "$(dirname "$0")/.."

ARCH=site/docs-archive
mkdir -p "$ARCH"

[ $# -ge 1 ] || { echo "usage: $0 vX.Y.Z [vY.Z.W …]" >&2; exit 1; }

for arg in "$@"; do
  tag="v${arg#v}"
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || {
    echo "no such tag: $tag" >&2; exit 1; }
  dest="$ARCH/$tag"
  tmp=$(mktemp -d -t txui-docs-archive)
  # Everything tracked under docs/ except the gen/ cross-check JSON (build
  # input, not content) — index.html + shots/ + user-guide/ + inventory.json.
  git archive "$tag" docs/index.html docs/shots docs/user-guide docs/inventory.json \
    | tar -x -C "$tmp"
  rm -rf "$dest"
  mkdir -p "$dest"
  mv "$tmp/docs/"* "$dest/"
  rm -rf "$tmp"
  echo "archived $tag → $dest/"
done

# Regenerate the archive index from what's actually on disk.
python3 - <<'PY'
import json, os, re, subprocess

ARCH = 'site/docs-archive'
vers = sorted(
    (d for d in os.listdir(ARCH) if re.fullmatch(r'v\d+\.\d+\.\d+', d)),
    key=lambda v: [int(x) for x in v[1:].split('.')], reverse=True)

rows = []
for v in vers:
    try:
        date = subprocess.run(['git', 'log', '-1', '--format=%as', v],
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        date = ''
    size = sum(os.path.getsize(os.path.join(dp, f))
               for dp, _, fs in os.walk(os.path.join(ARCH, v)) for f in fs)
    rows.append((v, date, size))

def esc(s): return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

items = '\n'.join(
    f'      <li><a href="{v}/">{v}</a>'
    + (f' <span class="muted">· {esc(d)} · {s//1024} KiB</span>' if d else '')
    + '</li>'
    for v, d, s in rows)

html = f'''<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TxUI — documentation archive</title>
<style>
  body {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117;
         color: #e6e6e6; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; }}
  a {{ color: #ff2d2d; text-decoration: none }} a:hover {{ text-decoration: underline }}
  li {{ margin: .5rem 0 }} .muted {{ color: #8b949e }}
  h1 {{ font-size: 1.3rem }} p.back {{ margin-top: 2.5rem }}
</style></head><body>
<h1>TxUI documentation archive</h1>
<p class="muted">The help system as shipped with each release. The current
version lives at <a href="../docs/">/txui/docs/</a>; unreleased development
docs are at <a href="../dev/">/txui/dev/</a>. Old app binaries stay on the
<a href="https://github.com/tuxie80/txui/releases">GitHub releases page</a>.</p>
<ul>
{items}
</ul>
<p class="back"><a href="../">← tuxie.eu/txui</a></p>
</body></html>
'''
with open(os.path.join(ARCH, 'index.html'), 'w') as fh:
    fh.write(html)
print(f'archive index: {len(rows)} version(s): {", ".join(v for v, _, _ in rows)}')
PY
