# DNS SRV to Redirection

Cloudflare Worker + OpenWrt natmap companion for publishing NAT-mapped services through Cloudflare SRV records.

It provides:

- A password-protected web portal that lists Cloudflare SRV records for managed domains.
- Redirects for web services based on SRV targets and ports.
- Treats `_vless_FB` SRV services as independent HTTPS fallback redirect endpoints.
- Wildcard dynamic redirects using a configurable template Web service.
- Copy actions for port, full URL, and `host:port`, plus a per-resource HTTPS authorization entry.
- RDP links use Microsoft Remote Desktop URI format: `rdp://full%20address=s:<host>:<port>`.
- A manual "refresh port" action that asks OpenWrt natmap to restart one matching section.
- A natmap agent that polls a DNS TXT refresh queue, performs health checks, and restarts unhealthy sections.
- A Cloudflare DDNS script that replaces old same-name records before adding new records, avoiding duplicate stale SRV entries.

## Repository Layout

```text
worker.js                         Cloudflare Worker entrypoint
openwrt/natmap-portal-agent.sh    natmap custom_script agent
openwrt/ddns/Cloudflare           natmap DDNS script for Cloudflare
scripts/deploy-worker.sh          Worker deploy helper
scripts/install-openwrt.sh        OpenWrt script installer
scripts/smoke-test.sh             basic live smoke checks
tests/worker-smoke.mjs            local Worker regression smoke test
docs/                            architecture, install, runbook, API, verification records
```

## Quick Start

1. Deploy the Worker.

```sh
cp wrangler.toml.example wrangler.toml
cp .secrets.example .secrets
# Edit wrangler.toml public vars and .secrets private values, then deploy:
scripts/deploy-worker.sh
```

2. Install OpenWrt scripts.

```sh
OPENWRT_HOST=wrt OPENWRT_QUEUE_NAME=_natmap-refresh.s.example.com scripts/install-openwrt.sh
```

3. Bind the agent to exactly one natmap section custom script.

```sh
ssh wrt 'uci set natmap.@natmap[0].custom_script=/etc/natmap/natmap-portal-agent.sh && uci commit natmap && /etc/init.d/natmap restart'
```

4. Open the portal.

```text
https://<PORTAL_DOMAIN>/?pwd=<PORTAL_PASSWD>
```

## Wildcard Dynamic Redirects

The Worker first looks for an exact SRV hostname match. If none exists and the request hostname is a single-label subdomain under `PORTAL_DOMAIN`, it can reuse a Web SRV record as a template. The default template is `web.<PORTAL_DOMAIN>`, matching the original project behavior.

Example with `PORTAL_DOMAIN=s.example.com`:

```text
_http._tls.web.s.example.com -> web.n.example.com:2424
https://newapi.s.example.com/path -> https://newapi.n.example.com:2424/path
```

Only template targets beginning with `web.` or `portal.` are rewritten. Cloudflare still needs to route the requested hostname to this Worker, usually through an appropriate Worker custom domain or wildcard route.

## Worker Environment Variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DOMAINS` | yes | none | Comma-separated managed domains. Wildcards are supported, for example `*.s.example.com`. |
| `PORTAL_DOMAIN` | yes | first wildcard parent or first domain | Hostname that serves the portal and JSON APIs. |
| `CF_API_TOKEN` | yes for portal scan and refresh | none | Cloudflare API token with DNS edit/read permission for the zone. |
| `CF_ZONE_ID` | yes for portal scan and refresh | none | Cloudflare zone id. Prefer storing it in `.secrets`. |
| `PORTAL_PASSWD` | recommended | `ABCCBA` | Portal/API password. Prefer storing it in `.secrets` as a Worker secret. |
| `DEFAULT_REDIRECT_STATUS` | no | `302` | One of `301`, `302`, `307`, `308`. |
| `CACHE_TTL_SECONDS` | no | `300` | Worker in-memory SRV cache TTL for non-forced reads. |
| `SRV_MAX_AGE_SECONDS` | no | `0` | Ignore SRV records older than this value. `0` disables age filtering. |
| `NATMAP_REFRESH_QUEUE_NAME` | no | `_natmap-refresh.<PORTAL_DOMAIN>` | TXT record name used as the refresh queue. |
| `WILDCARD_TEMPLATE_HOSTNAME` | no | `web.<PORTAL_DOMAIN>` | Web SRV hostname used when a single-label portal subdomain has no exact SRV. |
| `WILDCARD_TEMPLATE_TARGET_PREFIXES` | no | `web,portal` | Comma-separated target prefixes that may be replaced by the requested subdomain. |
| `TAILWIND_CDN_URL` | no | BootCDN Tailwind browser build | Tailwind CDN URL used by the Worker UI. Set to another accelerated mirror if needed. |
| `DEBUG_MODE` | no | `false` | Include debug blocks in portal responses. |

## Local Secrets File

Copy `.secrets.example` to `.secrets` and fill private values. `.secrets` is ignored by git. `scripts/deploy-worker.sh` loads it, uploads `CF_API_TOKEN`, `CF_ZONE_ID`, and `PORTAL_PASSWD` as Worker secrets when present, then runs `wrangler deploy`. `CLOUDFLARE_API_TOKEN` can also be stored there for Wrangler authentication.

## OpenWrt Runtime Variables

The agent works with defaults, but these can be exported before running it:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NATMAP_REFRESH_QUEUE_NAME` | `_natmap-refresh.example.com` | TXT name to poll. Set this to the same value as Worker `NATMAP_REFRESH_QUEUE_NAME`. |
| `NATMAP_REFRESH_INTERVAL` | `30` | Refresh queue polling interval in seconds. |
| `NATMAP_HEALTH_INTERVAL` | `300` | Health check interval in seconds. |
| `NATMAP_HEALTH_FAIL_THRESHOLD` | `2` | Consecutive failures before restarting a section. |
| `NATMAP_HEALTH_TIMEOUT` | `4` | Probe timeout in seconds. |
| `NATMAP_REFRESH_MAX_AGE_MS` | `900000` | Ignore stale refresh TXT messages older than this age. |
| `NATMAP_REFRESH_RETRY_LIMIT` | `3` | Manual refresh restart attempts when the public port does not change. |
| `NATMAP_REFRESH_RESTART_WAIT_SECONDS` | `10` | Seconds to wait for natmap runtime status after each manual refresh restart. |
| `NATMAP_CLEANUP_DISABLED` | `1` | Delete SRV/HTTPS DNS records for disabled natmap sections that still carry DDNS config. |
| `NATMAP_CLEANUP_INTERVAL` | `300` | Disabled-section cleanup interval in seconds. |
| `NATMAP_DNS_RECONCILE_INTERVAL` | `300` | Minimum seconds between DDNS repair attempts when DNS SRV still points at an old port. |
| `ACCESS_AUTH_SELF_CHECK_TOKEN` | empty | Optional token used by the health agent to pre-authorize the router's public IP before probing protected TCP tunnels. |
| `ACCESS_AUTH_SELF_CHECK_TTL` | `120` | Requested pre-authorization lifetime in seconds. Values below 60 are raised to 60. |
| `NATMAP_PORTAL_VERBOSE` | `0` | Print logs to stdout as well as `logger`. |

## Safety Notes

- OpenWrt refresh polling reads TXT through system DNS (`nslookup`); it does not use Cloudflare API tokens.
- Disabled natmap cleanup and stale SRV repair use the section's own DDNS script and tokens; the agent itself still reads refresh/DNS state through system DNS tools.
- If `ACCESS_AUTH_SELF_CHECK_TOKEN` is configured, each health round attempts one HTTPS token login through an enabled TCP tunnel before probes. Success or failure is logged only and never changes the original health logic.
- Worker force-refresh and manual refresh APIs require the portal password and have in-memory rate limits.
- Manual browser refresh after clicking "refresh port" does not repeat the action; POST fallback uses `303 See Other`.
- Portal authorization buttons open `https://<target>:<auth-port>/`. UDP resources reuse the first available non-UDP resource port for authorization because their own public port may not serve HTTPS.
- `_vless_fb` is probed as HTTPS fallback using the derived fallback hostname, while plain VLESS still defaults to TCP connect. UDP services are not generically probeable; add service-specific scripts under `/etc/natmap/health.d/` for HY2, QUIC, game protocols, and similar services.

## Documentation

- [Installation](docs/INSTALL.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [Operations Runbook](docs/RUNBOOK.md)
- [Verification Record](docs/VERIFICATION.md)
- [Security Notes](docs/SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).

```sh
scripts/deploy-all.sh
```
