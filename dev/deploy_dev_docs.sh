#!/bin/sh
# dev/deploy_dev_docs.sh — publish a SHADOW copy of the help system, built from
# the CURRENT working tree (unreleased features included), to
# tuxie.eu/txui/dev/. The stable docs at /txui/docs/ are untouched.
#
#   TXUI_DEPLOY_PASSWORD=… sh dev/deploy_dev_docs.sh     (or it prompts, hidden)
#
# The dev copy is the freshly generated docs/index.html + screenshots with a
# red banner injected naming the build date and the unreleased status. The
# mirror is additive and scoped to www/txui/dev/ only — nothing else on the
# hosting is read or written. Password handling follows deploy_site.sh
# (0600 temp script, trap-deleted, never argv).

set -eu
cd "$(dirname "$0")/.."

HOST=36357.w57.wedos.net
USER=w36357
REMOTE=www/txui/dev

echo "Building docs from the working tree…"
sh dev/build_docs.sh

STAGE=$(mktemp -d -t txui-dev-docs)
trap 'rm -rf "$STAGE" "${SCRIPT:-}"' EXIT
mkdir -p "$STAGE/docs"
cp docs/index.html docs/inventory.json "$STAGE/docs/"
cp -R docs/shots "$STAGE/docs/shots"
mkdir -p "$STAGE/docs/user-guide"
cp -R docs/user-guide/screenshots "$STAGE/docs/user-guide/screenshots"

STAMP=$(date '+%Y-%m-%d %H:%M')
STAGE_DIR="$STAGE" STAMP="$STAMP" python3 - <<'PY'
import os, re
p = os.path.join(os.environ['STAGE_DIR'], 'docs', 'index.html')
html = open(p).read()
banner = (
    '<div style="position:sticky;top:0;z-index:9999;background:#ff2d2d;color:#fff;'
    'font:13px ui-monospace,Menlo,monospace;padding:.45rem .9rem;text-align:center">'
    f"DEVELOPMENT DOCS — built from main on {os.environ['STAMP']}; describes "
    'unreleased features. <a href="../docs/" style="color:#fff;text-decoration:underline">'
    'Stable docs</a> · <a href="../docs-archive/" style="color:#fff;text-decoration:underline">'
    'Archive</a></div>')
assert '</body>' not in banner
m = re.search(r'<body[^>]*>', html)
if not m:
    raise SystemExit('docs/index.html: no <body> to hang the banner on')
html = html[:m.end()] + banner + html[m.end():]
open(p, 'w').write(html)
print('banner injected')
PY

if [ "${TXUI_DEPLOY_PASSWORD:-}" = "" ]; then
  printf 'Password for %s@%s: ' "$USER" "$HOST" >&2
  stty -echo 2>/dev/null || true
  IFS= read -r TXUI_DEPLOY_PASSWORD
  stty echo 2>/dev/null || true
  printf '\n' >&2
fi

SCRIPT=$(mktemp -t txui-deploy-dev)
chmod 600 "$SCRIPT"

cat > "$SCRIPT" <<EOF
set net:timeout 20
set net:max-retries 2
set ftp:passive-mode yes
open -u $USER,$TXUI_DEPLOY_PASSWORD ftp://$HOST
mirror -R --parallel=8 --exclude '\.DS_Store' $STAGE/docs $REMOTE
bye
EOF

lftp -f "$SCRIPT"
echo "deployed → https://tuxie.eu/txui/dev/"
