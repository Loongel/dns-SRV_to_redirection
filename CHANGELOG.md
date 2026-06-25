# Changelog

## Unreleased

### Changed

- OpenWrt agent repairs stale DNS SRV ports from natmap runtime state during health checks, rate-limited by `NATMAP_DNS_RECONCILE_INTERVAL`.
- OpenWrt health checks write failure counters atomically and probe `_vless_fb` services through their HTTPS fallback hostname.
- Cloudflare DDNS calls now use a total request timeout so failed API connectivity cannot block indefinitely.

## 0.2.0 - 2026-05-26

### Added

- Responsive Worker portal with search, browser-timezone timestamps, and refresh progress card.
- JSON APIs for resource listing and manual natmap port refresh.
- Worker-side rate limiting for force refresh and manual refresh operations.
- OpenWrt natmap portal agent for TXT queue polling and health maintenance.
- OpenWrt Cloudflare DDNS script that deletes old same-name records before creating replacements.
- Deployment helpers, smoke tests, and complete project documentation.
- Wildcard dynamic redirects that reuse a configurable Web SRV template, defaulting to `web.<PORTAL_DOMAIN>`, for single-label portal subdomains without exact SRV records.

### Changed

- Refresh queue polling on OpenWrt uses DNS TXT lookup instead of Cloudflare API token reads.
- Manual refresh uses natmap `port_pointer=1` random allocation for port ranges.
- HTTP/HTTPS health probes use natmap section target hostnames with `curl --resolve` to preserve Host/SNI while connecting to public IP and port.

### Verified

- Worker local smoke test.
- Live manual port refresh flow.
- Health-triggered restart flow.
- DDNS SRV replacement and duplicate cleanup behavior.
