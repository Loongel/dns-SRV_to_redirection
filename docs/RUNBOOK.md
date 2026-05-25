# Operations Runbook

## Smoke Checks

Worker syntax and local mock test:

```sh
npm test
```

Live Worker API:

```sh
PORTAL_URL=https://s.example.com PORTAL_PASSWD=change-me scripts/smoke-test.sh worker
```

OpenWrt scripts:

```sh
OPENWRT_HOST=wrt scripts/smoke-test.sh openwrt
```

## Check the Refresh Queue

```sh
ssh wrt 'nslookup -type=TXT _natmap-refresh.s.example.com'
ssh wrt 'cat /tmp/natmap-portal-agent/refresh.last 2>/dev/null || true'
```

If TXT nonce and `refresh.last` match, the agent has processed the newest request.

## Check natmap Runtime State

```sh
ssh wrt 'for f in /var/run/natmap/*.json; do [ -e "$f" ] && cat "$f" && echo; done'
```

Match `sid` to `uci show natmap.<section>`.

## Check the Agent

```sh
ssh wrt 'ps w | grep natmap-portal-agent | grep -v grep'
ssh wrt 'logread | grep natmap-portal | tail -n 50'
ssh wrt 'NATMAP_PORTAL_VERBOSE=1 /etc/natmap/natmap-portal-agent.sh --once-refresh'
ssh wrt 'NATMAP_PORTAL_VERBOSE=1 /etc/natmap/natmap-portal-agent.sh --once-health'
```

## Manual Port Refresh Flow

1. Portal calls `POST /api/refresh`.
2. Worker writes TXT queue.
3. OpenWrt agent polls TXT within `NATMAP_REFRESH_INTERVAL` seconds.
4. Agent restarts the matching natmap section.
5. natmap DDNS script replaces Cloudflare SRV with the new port.
6. Portal polls `/api/resources?force=1` and reloads when the port changes.

## Health Troubleshooting

Failure counters live in:

```text
/tmp/natmap-portal-agent/<section>.fail
```

A success removes the counter. When the count reaches `NATMAP_HEALTH_FAIL_THRESHOLD`, the section is restarted and the counter is removed.

For UDP services, add custom probes. Generic UDP cannot reliably distinguish a healthy silent service from a filtered or broken one.

## Rollback

OpenWrt installer backups are written next to the replaced files, for example:

```text
/etc/natmap/natmap-portal-agent.sh.bak-YYYYmmdd-HHMMSS
/etc/natmap/ddns/Cloudflare.bak-YYYYmmdd-HHMMSS
```

Restore with:

```sh
ssh wrt 'cp /etc/natmap/natmap-portal-agent.sh.bak-YYYYmmdd-HHMMSS /etc/natmap/natmap-portal-agent.sh && chmod 755 /etc/natmap/natmap-portal-agent.sh'
```

Worker rollback is a normal Cloudflare Worker rollback through Wrangler or the Cloudflare dashboard.
