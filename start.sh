#!/usr/bin/env bash
# Radyab launcher for macOS / Linux
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and run this again."
  exit 1
fi
[ -d node_modules ] || npm install --omit=dev
exec node src/index.js
