#!/usr/bin/env sh
set -eu

SECRETS_FILE="${SECRETS_FILE:-.secrets}"
WORKER_NAME="${WORKER_NAME:-dns-srv-to-redirection}"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-wrangler.toml}"
WORKER_SECRET_NAMES="${WORKER_SECRET_NAMES:-CF_API_TOKEN CF_ZONE_ID PORTAL_PASSWD}"
SKIP_SECRET_UPLOAD="${SKIP_SECRET_UPLOAD:-0}"

if [ -f "$SECRETS_FILE" ]; then
  case "$SECRETS_FILE" in
    */*) secrets_path="$SECRETS_FILE" ;;
    *) secrets_path="./$SECRETS_FILE" ;;
  esac
  set -a
  # shellcheck disable=SC1090
  . "$secrets_path"
  set +a
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run wrangler" >&2
  exit 1
fi

if [ ! -f "$WRANGLER_CONFIG" ]; then
  echo "$WRANGLER_CONFIG not found. Copy wrangler.toml.example to wrangler.toml and edit public vars first." >&2
  exit 1
fi

put_secret() {
  name="$1"
  value=$(eval "printf %s \"\${$name:-}\"")
  if [ -z "$value" ]; then
    echo "skip secret $name: not set" >&2
    return 0
  fi
  echo "upload secret $name"
  printf %s "$value" | npx wrangler secret put "$name" --config "$WRANGLER_CONFIG" --name "$WORKER_NAME"
}

if [ "$SKIP_SECRET_UPLOAD" != "1" ]; then
  for secret_name in $WORKER_SECRET_NAMES; do
    put_secret "$secret_name"
  done
fi

npx wrangler deploy worker.js --config "$WRANGLER_CONFIG" --name "$WORKER_NAME"
