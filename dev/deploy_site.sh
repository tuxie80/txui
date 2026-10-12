#!/bin/sh
# dev/deploy_site.sh — publish the website + generated docs to tuxie.eu/txui.
# ESSENTIAL part of every release: the version badge, the feature cards and
# the whole docs page live on this hosting, not just in the repo.
#
#   TXUI_DEPLOY_PASSWORD=… sh dev/deploy_site.sh     (or it prompts, hidden)
#
# Mapping:  site/  →  www/txui/
#           docs/  →  www/txui/docs/   (markdown excluded — the web serves the
#           generated index.html; the .md sources stay local per .gitignore)
#
# The mirror is ADDITIVE (no --delete): server-only files — the demo video in
# docs/shots/demo/ — must survive a deploy. Host/user are not secrets; the
# password never enters the repo, argv, or a committed file (it rides a
# 0600 temp script that is trap-deleted, the project's askpass pattern).

set -eu

HOST=36357.w57.wedos.net
USER=w36357
REMOTE=www/txui

if [ "${TXUI_DEPLOY_PASSWORD:-}" = "" ]; then
  printf 'Password for %s@%s: ' "$USER" "$HOST" >&2
  stty -echo 2>/dev/null || true
  IFS= read -r TXUI_DEPLOY_PASSWORD
  stty echo 2>/dev/null || true
  printf '\n' >&2
fi

SCRIPT=$(mktemp -t txui-deploy)
chmod 600 "$SCRIPT"
trap 'rm -f "$SCRIPT"' EXIT

cat > "$SCRIPT" <<EOF
set net:timeout 20
set net:max-retries 2
set ftp:passive-mode yes
open -u $USER,$TXUI_DEPLOY_PASSWORD ftp://$HOST
mirror -R --parallel=8 --exclude '\.DS_Store' site $REMOTE
mirror -R --parallel=8 --exclude '\.md\$' --exclude '\.DS_Store' docs $REMOTE/docs
bye
EOF

lftp -f "$SCRIPT"
echo "deployed → https://tuxie.eu/txui/"
