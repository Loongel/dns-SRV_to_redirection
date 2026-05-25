#!/usr/bin/env sh
set -eu

mode="${1:-all}"

worker_smoke() {
  PORTAL_URL="${PORTAL_URL:?PORTAL_URL is required, for example https://s.example.com}"
  PORTAL_PASSWD="${PORTAL_PASSWD:?PORTAL_PASSWD is required}"
  curl -fsS "$PORTAL_URL/api/resources?pwd=$PORTAL_PASSWD&force=1" | grep '"ok":true' >/dev/null
  echo "Worker API smoke passed"
}

openwrt_smoke() {
  OPENWRT_HOST="${OPENWRT_HOST:-wrt}"
  ssh "$OPENWRT_HOST" 'bash -n /etc/natmap/ddns/Cloudflare /etc/natmap/natmap-portal-agent.sh'
  ssh "$OPENWRT_HOST" 'NATMAP_PORTAL_VERBOSE=1 /etc/natmap/natmap-portal-agent.sh --once-refresh; NATMAP_PORTAL_VERBOSE=1 /etc/natmap/natmap-portal-agent.sh --once-health'
  echo "OpenWrt smoke passed"
}

case "$mode" in
  worker) worker_smoke ;;
  openwrt) openwrt_smoke ;;
  all) worker_smoke; openwrt_smoke ;;
  *) echo "Usage: $0 [worker|openwrt|all]" >&2; exit 2 ;;
esac
