#!/usr/bin/env bash
# Linux/macOS wrapper for obscure-fingerprint.js
# Usage: ./obscure.sh <fingerprint.json> [output.json] [seed]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

INPUT_FILE="$1"
OUTPUT_FILE="${2:-$1}"
SEED="$3"

if [ -z "$INPUT_FILE" ]; then
  echo "Usage: ./obscure.sh <fingerprint.json> [output.json] [seed]" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found on PATH." >&2
  exit 1
fi

if [ -n "$SEED" ]; then
  node src/obscure-fingerprint.js "$INPUT_FILE" "$OUTPUT_FILE" "--seed=$SEED"
else
  node src/obscure-fingerprint.js "$INPUT_FILE" "$OUTPUT_FILE"
fi
