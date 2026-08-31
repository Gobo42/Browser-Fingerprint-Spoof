#!/usr/bin/env bash
# Linux/macOS wrapper for capture-fingerprint.js
# Usage: ./capture.sh [outputPath]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUTPUT_PATH="${1:-fingerprint.json}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found on PATH. Install it and re-run." >&2
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  npx playwright install chrome
fi

node src/capture-fingerprint.js "$OUTPUT_PATH"
