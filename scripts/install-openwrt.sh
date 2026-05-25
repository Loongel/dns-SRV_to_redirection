#!/usr/bin/env sh
set -eu

OPENWRT_HOST="${OPENWRT_HOST:-wrt}"
OPENWRT_AGENT_PATH="${OPENWRT_AGENT_PATH:-/etc/natmap/natmap-portal-agent.sh}"
OPENWRT_DDNS_PATH="${OPENWRT_DDNS_PATH:-/etc/natmap/ddns/Cloudflare}"
OPENWRT_AGENT_CONFIG_PATH="${OPENWRT_AGENT_CONFIG_PATH:-/etc/natmap/natmap-portal-agent.conf}"
OPENWRT_CONFIGURE_CUSTOM_SCRIPT="${OPENWRT_CONFIGURE_CUSTOM_SCRIPT:-0}"
OPENWRT_CUSTOM_SCRIPT_SECTION="${OPENWRT_CUSTOM_SCRIPT_SECTION:-@natmap[0]}"
OPENWRT_QUEUE_NAME="${OPENWRT_QUEUE_NAME:-}"

scp openwrt/natmap-portal-agent.sh "$OPENWRT_HOST:/tmp/natmap-portal-agent.sh"
scp openwrt/ddns/Cloudflare "$OPENWRT_HOST:/tmp/natmap-ddns-cloudflare"

if [ -n "$OPENWRT_QUEUE_NAME" ]; then
  tmp_conf="$(mktemp)"
  escaped_queue="$(printf %s "$OPENWRT_QUEUE_NAME" | sed "s/'/'\\''/g")"
  printf "NATMAP_REFRESH_QUEUE_NAME='%s'\n" "$escaped_queue" > "$tmp_conf"
  scp "$tmp_conf" "$OPENWRT_HOST:/tmp/natmap-portal-agent.conf"
  rm -f "$tmp_conf"
fi

ssh "$OPENWRT_HOST" "set -eu
stamp=\$(date +%Y%m%d-%H%M%S)
mkdir -p /etc/natmap/ddns /etc/natmap/health.d /var/lock
if [ -e /tmp/natmap-portal-agent.conf ]; then
  [ ! -e '$OPENWRT_AGENT_CONFIG_PATH' ] || cp '$OPENWRT_AGENT_CONFIG_PATH' '$OPENWRT_AGENT_CONFIG_PATH.bak-'\$stamp
  cp /tmp/natmap-portal-agent.conf '$OPENWRT_AGENT_CONFIG_PATH'
  rm -f /tmp/natmap-portal-agent.conf
fi
[ ! -e '$OPENWRT_AGENT_PATH' ] || cp '$OPENWRT_AGENT_PATH' '$OPENWRT_AGENT_PATH.bak-'\$stamp
[ ! -e '$OPENWRT_DDNS_PATH' ] || cp '$OPENWRT_DDNS_PATH' '$OPENWRT_DDNS_PATH.bak-'\$stamp
cp /tmp/natmap-portal-agent.sh '$OPENWRT_AGENT_PATH'
cp /tmp/natmap-ddns-cloudflare '$OPENWRT_DDNS_PATH'
chmod 755 '$OPENWRT_AGENT_PATH' '$OPENWRT_DDNS_PATH'
rm -f /tmp/natmap-portal-agent.sh /tmp/natmap-ddns-cloudflare
bash -n '$OPENWRT_AGENT_PATH' '$OPENWRT_DDNS_PATH'
if [ '$OPENWRT_CONFIGURE_CUSTOM_SCRIPT' = '1' ]; then
  uci set 'natmap.$OPENWRT_CUSTOM_SCRIPT_SECTION.custom_script=$OPENWRT_AGENT_PATH'
  uci commit natmap
fi
"

echo "Installed OpenWrt scripts on $OPENWRT_HOST"
echo "Agent: $OPENWRT_AGENT_PATH"
echo "DDNS : $OPENWRT_DDNS_PATH"
if [ -n "$OPENWRT_QUEUE_NAME" ]; then
  echo "Config: $OPENWRT_AGENT_CONFIG_PATH"
fi
