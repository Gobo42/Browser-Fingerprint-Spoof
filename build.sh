#!/usr/bin/env bash
# Linux/macOS wrapper for build-extension.js
# Usage: ./build.sh <fingerprint.json> [outputDir] [excludeList.json[,more.json...]] [hardblockList.json[,more.json...]]
#
# excludeList and hardblockList each accept multiple comma-separated files
# (no spaces around the comma); they're merged and deduplicated at build
# time, e.g. ./build.sh fingerprint.json output/fp-extension exclude-list.json,exclude-financial.json
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

INPUT_FILE="$1"
OUTPUT_DIR="${2:-output/fp-extension}"
EXCLUDE_LIST="${3:-exclude-list.json}"
HARDBLOCK_LIST="${4:-hardblock-list.json}"

if [ -z "$INPUT_FILE" ]; then
  echo "Usage: ./build.sh <fingerprint.json> [outputDir] [excludeList.json[,more.json...]] [hardblockList.json[,more.json...]]" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found on PATH." >&2
  exit 1
fi

node src/build-extension.js "$INPUT_FILE" "$OUTPUT_DIR" "$EXCLUDE_LIST" "$HARDBLOCK_LIST"
