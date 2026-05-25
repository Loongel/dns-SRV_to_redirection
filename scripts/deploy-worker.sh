#!/usr/bin/env sh
set -eu

WORKER_NAME="${WORKER_NAME:-dns-srv-to-redirection}"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-wrangler.toml}"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run wrangler" >&2
  exit 1
fi

if [ ! -f "$WRANGLER_CONFIG" ]; then
  echo "$WRANGLER_CONFIG not found. Copy wrangler.toml.example and edit it first." >&2
  exit 1
fi

npx wrangler deploy worker.js --config "$WRANGLER_CONFIG" --name "$WORKER_NAME"
