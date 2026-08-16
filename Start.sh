#!/usr/bin/env bash
# Entry point for the HTTP Server Manager, which looks for exactly this file
# when it scans its projects folder. It also works as a plain launcher:
#
#   ./Start.sh
#
# The manager reads PORT out of this script to build the card's link, so the
# default below is the one that ends up on screen.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

export HOST="${HOST:-0.0.0.0}"
# Not 3000 (the manager's own port) and not 8080 (what the manager's scaffolding
# gives every other imported Node project, so it is the port most likely to be
# taken already).
export PORT="${PORT:-8090}"
export HTTPS_PORT="${HTTPS_PORT:-8453}"

# No dependencies, so there is nothing to install — but a manifest may appear
# later, and a program that silently runs against stale dependencies is worse
# than one that takes a moment to install them.
if [ -f package.json ] && [ -d node_modules ] && [ package.json -nt node_modules ]; then
  echo "[SETUP] package.json changed; installing npm dependencies..."
  npm install
fi

exec node server.js
