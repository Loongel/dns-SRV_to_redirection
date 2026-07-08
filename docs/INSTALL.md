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

Edit public `[vars]` in `wrangler.toml`:

```toml
DOMAINS = "*.s.example.com"
PORTAL_DOMAIN = "s.example.com"
DEFAULT_REDIRECT_STATUS = "307"
CACHE_TTL_SECONDS = "300"
NATMAP_REFRESH_QUEUE_NAME = "_natmap-refresh.s.example.com"
TAILWIND_CDN_URLS = "https://fastly.jsdelivr.net/npm/@tailwindcss/browser@4.1.13/dist/index.global.min.js,https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.13/dist/index.global.min.js,https://unpkg.com/@tailwindcss/browser@4.1.13/dist/index.global.js"
```

Create local secrets. `.secrets` is ignored by git:

```sh
cp .secrets.example .secrets
# Fill CF_API_TOKEN, CF_ZONE_ID, PORTAL_PASSWD, and optionally CLOUDFLARE_API_TOKEN.
```

Deploy. The script loads `.secrets`, uploads Worker secrets, then runs Wrangler deploy:

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

For refresh, health maintenance, and stale DNS cleanup, each managed service should keep its DDNS metadata even when disabled:

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

When a section is disabled, the portal agent can automatically remove its stale SRV/HTTPS records from Cloudflare as long as `ddns_script`, real `ddns_tokens`, and the corresponding `ddns_srv` or `ddns_https` values remain in UCI. Placeholder tokens such as `<api_token>` are skipped. It intentionally does not remove shared A/AAAA records.

## Protected Port Authorization

If your natmap ports require a same-port HTTPS authorization before traffic is allowed, configure a token on OpenWrt:

```sh
cat >>/etc/natmap/natmap-portal-agent.conf <<'SH'
ACCESS_AUTH_SELF_CHECK_TOKEN='replace-with-your-token'
ACCESS_AUTH_SELF_CHECK_TTL=120
SH
```

During each health round the agent will try one token login through an enabled TCP tunnel before running probes. This request is best-effort: it writes an `access-auth self-check ...` log line, but success or failure does not change DNS repair, health probe, failure counter, or restart behavior.

The installer can also merge these values without deleting other config keys:

```sh
OPENWRT_HOST=wrt \
OPENWRT_ACCESS_AUTH_SELF_CHECK_TOKEN='replace-with-your-token' \
OPENWRT_ACCESS_AUTH_SELF_CHECK_TTL=120 \
scripts/install-openwrt.sh
```

## Health Probe Overrides

Place executable scripts in `/etc/natmap/health.d/<ddns_srv>` to override default health behavior for a service. `_vless_fb` has a built-in HTTPS fallback probe; plain VLESS and other unknown TCP services default to TCP connect unless you provide a custom probe.

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
