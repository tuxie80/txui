#!/usr/bin/env bash
# Build the TxUI HTML help system. Run from the project root.
#
#   dev/build_docs.sh            # rebuild inventory + HTML from source (fast)
#   dev/build_docs.sh --shots    # also re-capture screenshots (needs the shots
#                                 # dev server on :5273 — see below)
#
# Screenshots use a mock-Tauri build of the real frontend rendered in the cached
# Playwright Chromium. Before --shots, start the shots dev server in another
# shell:  node node_modules/vite/bin/vite.js --config dev/vite.shots.config.ts
set -euo pipefail
cd "$(dirname "$0")/.."

echo "1/4  Cross-check inventory (reads source modules via Vite SSR)…"
node dev/gen_docs_inventory.mjs

if [[ "${1:-}" == "--shots" ]]; then
  echo "2/4  Capturing screenshots (macOS, retina, red highlights)…"
  node dev/shoot.mjs
else
  echo "2/4  Skipping screenshot capture (pass --shots to re-run)."
fi

echo "3/4  Generating docs/index.html…"
node dev/gen_docs_html.mjs

if [[ "${1:-}" == "--shots" ]]; then
  echo "4/4  Capturing user-guide screenshots…"
  node dev/shoot_userguide.mjs
else
  echo "4/4  Skipping user-guide screenshots (pass --shots to re-capture)."
fi

echo "Done → docs/index.html + docs/user-guide/screenshots/"
