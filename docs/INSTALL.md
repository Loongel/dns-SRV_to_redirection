# Installation Guide

This project has two deploy targets:

- Cloudflare Worker: portal, redirects, Cloudflare SRV scan, refresh queue writer.
- OpenWrt: natmap DDNS cleanup script and single custom-script agent.

## Requirements

Cloudflare:

- A zone managed by Cloudflare.
- API token with DNS read/edit permissions for the zone.
- A Worker route or custom domain for `PORTAL_DOMAIN`.

OpenWrt:

- natmap installed and running.
- `jsonfilter`, `nslookup`, `curl`, `nc`, `flock`, and `/lib/functions.sh` available.
- SSH access from the deployment host.

## Worker Deployment

Create a local Wrangler config from the example:

```sh
cp wrangler.toml.example wrangler.toml
```

Edit `[vars]` in `wrangler.toml`:

```toml
DOMAINS = "*.s.example.com"
PORTAL_DOMAIN = "s.example.com"
PORTAL_PASSWD = "change-me"
DEFAULT_REDIRECT_STATUS = "307"
CACHE_TTL_SECONDS = "300"
NATMAP_REFRESH_QUEUE_NAME = "_natmap-refresh.s.example.com"
TAILWIND_CDN_URL = "https://cdn.bootcdn.net/ajax/libs/tailwindcss-browser/4.1.13/index.global.min.js"
```

Set secrets:

```sh
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ZONE_ID
```

Deploy:

```sh
scripts/deploy-worker.sh
# Optional: deploy both targets after configuring all environment variables
scripts/deploy-all.sh
```

## OpenWrt Deployment

Install scripts:

```sh
OPENWRT_HOST=wrt OPENWRT_QUEUE_NAME=_natmap-refresh.s.example.com scripts/install-openwrt.sh
```

The installer copies:

- `openwrt/natmap-portal-agent.sh` to `/etc/natmap/natmap-portal-agent.sh`
- `openwrt/ddns/Cloudflare` to `/etc/natmap/ddns/Cloudflare`

It backs up existing files with a timestamp suffix before replacing them.

Bind the portal agent to one natmap section only:

```sh
ssh wrt 'uci set natmap.@natmap[0].custom_script=/etc/natmap/natmap-portal-agent.sh && uci commit natmap && /etc/init.d/natmap restart'
```

Do not also install cron jobs for this project. The agent runs from natmap `custom_script` and handles both refresh polling and health checks.

## natmap Section Requirements

For refresh and health maintenance, each managed service should have:

```text
option enable '1'
option forward '1'
option ddns_enable '1'
option ddns_script '/etc/natmap/ddns/Cloudflare'
option ddns_srv '<portal-visible-domain>'
option ddns_srv_serv '<service>'
option ddns_srv_proto 'tcp|udp|tls'
option ddns_srv_target '<service-target-hostname>'
```

For random allocation inside a port range, natmap uses `port_pointer=1`:

```text
option port '60111-60120'
option port_pointer '1'
```

OpenWrt natmap converts that to `-b 60111~60120`, which means random allocation inside the range.

## Health Probe Overrides

Place executable scripts in `/etc/natmap/health.d/<ddns_srv>` to override default health behavior for a service.

Example:

```sh
cat >/etc/natmap/health.d/hm-hy2.s.example.com <<'SH'
#!/bin/sh
# Return 0 for healthy, 1 for unhealthy, 2 to fall back to default logic.
# Service context is available through NATMAP_* environment variables.
exit 2
SH
chmod 755 /etc/natmap/health.d/hm-hy2.s.example.com
```
