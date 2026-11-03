#!/bin/sh
# Real-browser core UI gate. Starts and stops the mock Vite server as needed.
set -eu
cd "$(dirname "$0")/.."
exec node dev/verify_core_interactions.mjs
