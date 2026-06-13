# Architecture

## Components

```text
Browser
  -> Cloudflare Worker portal/API
       -> Cloudflare DNS API for SRV/TXT writes and reads
  -> Service domains
       -> Worker redirect or non-web info page

OpenWrt natmap
  -> Cloudflare DDNS script replaces A/SRV/HTTPS records
  -> natmap portal agent
       -> reads refresh queue TXT through DNS
       -> restarts one matching natmap section
       -> performs periodic health checks
```

## Worker Responsibilities

The Worker has two modes based on request hostname:

- `PORTAL_DOMAIN`: serve the portal and JSON APIs.
- Any managed SRV hostname: select a matching SRV record, redirect HTTP/HTTPS services, and handle `_vless_fb` through its independent HTTPS fallback redirect rule.

The Worker fetches Cloudflare SRV records, normalizes them, filters them by `DOMAINS`, and deduplicates same `hostname|service|protocol` entries by newest Cloudflare timestamp.

## Wildcard Dynamic Redirects

Redirect handling prefers exact SRV hostnames. If no exact SRV exists, and the requested hostname is one label under `PORTAL_DOMAIN`, the Worker looks for a Web SRV template. The default template hostname is `web.<PORTAL_DOMAIN>` for compatibility with the original project, and it can be overridden with `WILDCARD_TEMPLATE_HOSTNAME`. When that template target begins with one of `WILDCARD_TEMPLATE_TARGET_PREFIXES` (`web,portal` by default), the prefix is replaced with the requested subdomain and the template port is reused.

```text
_http._tls.web.s.example.com -> web.n.example.com:2424
https://newapi.s.example.com/ -> https://newapi.n.example.com:2424/
```

The portal includes:

- Search over domain, service, target, and port.
- A Tailwind CDN-only UI; the Worker does not inline custom CSS.
- Browser-timezone rendering for record timestamps.
- Redirect status selection per domain in Worker memory.
- Manual refresh button that writes a TXT queue message and polls `/api/resources?force=1` until the port changes.

## Refresh Queue

Manual refresh replaces the TXT queue with one fresh record. The Worker deletes existing TXT records with the same queue name before creating the new value:

```text
<NATMAP_REFRESH_QUEUE_NAME> = "<domain>|<unix-ms>|<nonce>"
```

The OpenWrt agent polls the TXT through `nslookup`, selects the newest valid timestamp if DNS returns multiple TXT values, validates message age and nonce, finds the natmap section whose `ddns_srv` equals `<domain>`, and restarts only that section.

The agent stores the last processed nonce at:

```text
/tmp/natmap-portal-agent/refresh.last
```

## Health Checks

The agent iterates enabled natmap sections that have `forward=1` and `ddns_srv` set. It locates the matching runtime JSON in `/var/run/natmap/*.json` by section id, then probes the public IP and public port.

Default behavior:

| Service | Default probe |
| --- | --- |
| `http` + `tls`, `https` | `curl` to `https://<target>:<public_port>/` with `--resolve <target>:<public_port>:<public_ip>` |
| `http` without TLS | `curl` to `http://<target>:<public_port>/` with `--resolve` |
| `ssh`, `ftp`, `ftps`, `rdp`, unknown TCP | TCP connect with `nc` |
| UDP | Healthy by default, unless a custom probe exists |

For HTTP/HTTPS the target hostname is read from natmap section data in this order:

1. `ddns_https_target`
2. `ddns_srv_target`
3. `ddns_srv`

This keeps Host/SNI correct while still connecting to the natmap public IP and port.

## Cloudflare DDNS Cleanup

The OpenWrt DDNS script lists existing records, deletes old records with the same type and name, and then posts the replacement record. This prevents stale duplicate SRV records from accumulating when natmap changes port.

## Rate Limits

The Worker uses in-memory per-isolate rate limits:

| Operation | Limit |
| --- | --- |
| Force SRV fetch | 25 per client IP per minute |
| Refresh queue writes | 10 per client IP per 5 minutes |
| Refresh queue writes per domain | 1 per domain per minute |

These limits are a guardrail, not a global quota system. Cloudflare may run multiple isolates, so use Cloudflare WAF/rate limiting if this portal is exposed to untrusted users.
