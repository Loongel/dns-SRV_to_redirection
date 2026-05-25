#!/usr/bin/env sh
set -eu

scripts/deploy-worker.sh
scripts/install-openwrt.sh

cat <<'MSG'
Deploy helpers completed.

Next checks:
  npm test
  scripts/smoke-test.sh all
MSG
