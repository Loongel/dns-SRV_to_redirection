#!/usr/bin/env sh
set -eu

OPENWRT_HOST="${OPENWRT_HOST:-wrt}"
OPENWRT_AGENT_PATH="${OPENWRT_AGENT_PATH:-/etc/natmap/natmap-portal-agent.sh}"
OPENWRT_DDNS_PATH="${OPENWRT_DDNS_PATH:-/etc/natmap/ddns/Cloudflare}"
OPENWRT_AGENT_CONFIG_PATH="${OPENWRT_AGENT_CONFIG_PATH:-/etc/natmap/natmap-portal-agent.conf}"
OPENWRT_CONFIGURE_CUSTOM_SCRIPT="${OPENWRT_CONFIGURE_CUSTOM_SCRIPT:-0}"
OPENWRT_CUSTOM_SCRIPT_SECTION="${OPENWRT_CUSTOM_SCRIPT_SECTION:-@natmap[0]}"
OPENWRT_QUEUE_NAME="${OPENWRT_QUEUE_NAME:-}"
OPENWRT_ACCESS_AUTH_SELF_CHECK_TOKEN="${OPENWRT_ACCESS_AUTH_SELF_CHECK_TOKEN:-}"
OPENWRT_ACCESS_AUTH_SELF_CHECK_TTL="${OPENWRT_ACCESS_AUTH_SELF_CHECK_TTL:-}"

scp openwrt/natmap-portal-agent.sh "$OPENWRT_HOST:/tmp/natmap-portal-agent.sh"
scp openwrt/ddns/Cloudflare "$OPENWRT_HOST:/tmp/natmap-ddns-cloudflare"

if [ -n "$OPENWRT_QUEUE_NAME$OPENWRT_ACCESS_AUTH_SELF_CHECK_TOKEN$OPENWRT_ACCESS_AUTH_SELF_CHECK_TTL" ]; then
  tmp_conf="$(mktemp)"
  if [ -n "$OPENWRT_QUEUE_NAME" ]; then
    escaped_queue="$(printf %s "$OPENWRT_QUEUE_NAME" | sed "s/'/'\\''/g")"
    printf "NATMAP_REFRESH_QUEUE_NAME='%s'\n" "$escaped_queue" >> "$tmp_conf"
  fi
  if [ -n "$OPENWRT_ACCESS_AUTH_SELF_CHECK_TOKEN" ]; then
    escaped_token="$(printf %s "$OPENWRT_ACCESS_AUTH_SELF_CHECK_TOKEN" | sed "s/'/'\\''/g")"
    printf "ACCESS_AUTH_SELF_CHECK_TOKEN='%s'\n" "$escaped_token" >> "$tmp_conf"
  fi
  if [ -n "$OPENWRT_ACCESS_AUTH_SELF_CHECK_TTL" ]; then
    escaped_ttl="$(printf %s "$OPENWRT_ACCESS_AUTH_SELF_CHECK_TTL" | sed "s/'/'\\''/g")"
    printf "ACCESS_AUTH_SELF_CHECK_TTL='%s'\n" "$escaped_ttl" >> "$tmp_conf"
  fi
  scp "$tmp_conf" "$OPENWRT_HOST:/tmp/natmap-portal-agent.conf"
  rm -f "$tmp_conf"
fi

ssh "$OPENWRT_HOST" "set -eu
stamp=\$(date +%Y%m%d-%H%M%S)
mkdir -p /etc/natmap/ddns /etc/natmap/health.d /var/lock
if [ -e /tmp/natmap-portal-agent.conf ]; then
  [ ! -e '$OPENWRT_AGENT_CONFIG_PATH' ] || cp '$OPENWRT_AGENT_CONFIG_PATH' '$OPENWRT_AGENT_CONFIG_PATH.bak-'\$stamp
  touch '$OPENWRT_AGENT_CONFIG_PATH'
  while IFS='=' read -r key value; do
    [ -n \"\$key\" ] || continue
    tmp_file='$OPENWRT_AGENT_CONFIG_PATH.tmp'
    grep -v \"^\${key}=\" '$OPENWRT_AGENT_CONFIG_PATH' > \"\$tmp_file\" || true
    printf '%s=%s\n' \"\$key\" \"\$value\" >> \"\$tmp_file\"
    mv \"\$tmp_file\" '$OPENWRT_AGENT_CONFIG_PATH'
  done < /tmp/natmap-portal-agent.conf
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
if [ -n "$OPENWRT_ACCESS_AUTH_SELF_CHECK_TOKEN$OPENWRT_ACCESS_AUTH_SELF_CHECK_TTL" ]; then
  echo "Access auth self-check config updated on $OPENWRT_HOST"
fi
