# Agent Instructions

## Project Scope

This repository contains a Cloudflare Worker and directly related OpenWrt natmap scripts. Keep changes scoped to:

- `worker.js`
- `openwrt/`
- `scripts/`
- `tests/`
- `docs/`

Do not modify unrelated OpenWrt configuration or services when working through SSH. The OpenWrt side should use natmap mechanisms (`ddns_script`, one `custom_script`) and should not add cron jobs for this project.

## Important Behaviors

- OpenWrt refresh polling must read the TXT queue through DNS tools such as `nslookup`; it must not read Cloudflare TXT records through Cloudflare API tokens.
- The DDNS script should replace old same-name records before posting new records to avoid duplicate stale SRV records.
- Manual refresh must restart only the matching natmap section whose `ddns_srv` equals the requested domain.
- For natmap port ranges, `port_pointer=1` is the random allocation mode because the init script converts `60111-60120` to `60111~60120`.
- UDP health cannot be generically inferred from missing data. Use service-specific scripts in `/etc/natmap/health.d/` for HY2/QUIC-like services.
- HTTP/HTTPS health probes must use public IP + public port while preserving Host/SNI from section target variables (`ddns_https_target`, then `ddns_srv_target`, then `ddns_srv`).

## Commands

```sh
npm test
OPENWRT_HOST=wrt scripts/smoke-test.sh openwrt
PORTAL_URL=https://s.example.com PORTAL_PASSWD=change-me scripts/smoke-test.sh worker
```

Deploy helpers:

```sh
scripts/deploy-worker.sh
OPENWRT_HOST=wrt scripts/install-openwrt.sh
```

## Secrets

Never commit Cloudflare API tokens, zone ids, or portal passwords. Wrangler secrets should carry `CF_API_TOKEN` and `CF_ZONE_ID`. OpenWrt UCI can contain DDNS tokens, but copied examples in this repository must not.
