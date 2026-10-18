#!/bin/bash
# Release smoke gate — boots the BUILT app (default: the release bundle) with
# the in-app self-test armed (utils/smoke.ts) and asserts the verdict.
#
# This is the test that would have caught the 1.3.0 CSP disaster: it exercises
# the real packaged artifact (Tauri's CSP asset modification included), not a
# dev server. The arm flag lives in the webview's LocalStorage sqlite, written
# while the app is CLOSED (WebKit overwrites the file on exit, so ordering
# matters: app quit → write flag → launch → app writes verdict → app exits).
#
# Usage: dev/release_smoke.sh [path/to/TxUI.app]
set -euo pipefail
APP="${1:-$(dirname "$0")/../src-tauri/target/release/bundle/macos/TxUI.app}"
APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"  # absolutize — `open -a` rejects relative paths
VERDICT=/tmp/txui-smoke.json
LSDB="$HOME/Library/WebKit/com.dbgui.app/WebsiteData/Default"
ORIGIN="tauri.localhost"   # WKWebView localStorage origin for the custom protocol

if [ ! -d "$APP" ]; then echo "no app bundle at $APP — build first (cargo tauri build --bundles app)"; exit 2; fi

# 1. app must be closed before touching its WebKit storage
osascript -e 'quit app "TxUI"' 2>/dev/null || true
sleep 2
rm -f "$VERDICT"

# 2. arm the smoke flag in the webview's LocalStorage (UTF-16LE values)
rc=0
python3 - "$LSDB" <<'PYEOF' || rc=$?
import sqlite3, glob, sys
base = sys.argv[1]
dbs = glob.glob(base + '/**/LocalStorage/localstorage.sqlite3', recursive=True)
if not dbs:
    print('no localstorage db yet — launching once to create it')
    sys.exit(3)  # caller handles: launch once, quit, retry
db = dbs[0]
con = sqlite3.connect(db)
val = '1'.encode('utf-16-le')
con.execute("INSERT INTO ItemTable (key, value) VALUES ('dbgui.smoke', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (val,))
con.commit(); con.close()
print('armed')
PYEOF
if [ "$rc" -eq 3 ]; then
  open -a "$APP"; sleep 6; osascript -e 'quit app "TxUI"' 2>/dev/null || true; sleep 2
  [ -z "${SMOKE_RETRIED:-}" ] && SMOKE_RETRIED=1 exec "$0" "$APP"   # retry once
  echo "SMOKE: could not arm localStorage flag"; exit 2
fi

# 3. launch — the app self-tests and exits on its own (utils/smoke.ts)
open -a "$APP"
for i in $(seq 1 30); do
  sleep 2
  [ -s "$VERDICT" ] && break
done

# 4. disarm (app is closed by now) so the next normal launch doesn't self-test
python3 - "$LSDB" <<'PYEOF'
import sqlite3, glob, sys
dbs = glob.glob(sys.argv[1] + '/**/LocalStorage/localstorage.sqlite3', recursive=True)
if dbs:
    con = sqlite3.connect(dbs[0])
    con.execute("DELETE FROM ItemTable WHERE key='dbgui.smoke'")
    con.commit(); con.close()
print('disarmed')
PYEOF

# 5. verdict
if [ ! -s "$VERDICT" ]; then echo "SMOKE: no verdict written (app never finished the self-test)"; exit 1; fi
python3 - "$VERDICT" <<'PYEOF'
import json, sys
v = json.load(open(sys.argv[1]))
for c in v['checks']:
    print(('PASS ' if c['ok'] else 'FAIL ') + c['id'] + (f" — {c['detail']}" if c.get('detail') else ''))
print('csp violations:', v['cspViolations'] or 'none')
print('SMOKE', 'OK' if v['ok'] else 'FAILED', f"({v['ms']} ms)")
sys.exit(0 if v['ok'] else 1)
PYEOF
