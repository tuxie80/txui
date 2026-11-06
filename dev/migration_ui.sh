#!/bin/sh
# Real-Chromium Migration Cockpit visual and interaction gate.
set -eu
cd "$(dirname "$0")/.."
exec node dev/migration_ui.mjs
