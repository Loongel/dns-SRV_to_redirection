# Custom Health Probes

Executable files in `/etc/natmap/health.d/<ddns_srv>` override the default health logic for one natmap section.

Return codes:

- `0`: healthy
- `1`: unhealthy
- `2`: fall back to default probe logic

Available environment variables:

| Variable | Meaning |
| --- | --- |
| `NATMAP_SID` | natmap section id |
| `NATMAP_COMMENT` | section comment |
| `NATMAP_DDNS_SRV` | portal-facing service domain |
| `NATMAP_DDNS_SRV_TARGET` | SRV target hostname |
| `NATMAP_DDNS_HTTPS_TARGET` | HTTPS target hostname |
| `NATMAP_VLESS_FALLBACK_TARGET` | derived HTTPS fallback hostname for `vless_fb` services |
| `NATMAP_SERVICE` | service name such as `http`, `rdp`, `hy2` |
| `NATMAP_PROTO` | runtime protocol from status JSON |
| `NATMAP_PUBLIC_IP` | natmap public IP |
| `NATMAP_PUBLIC_PORT` | natmap public port |
| `NATMAP_FORWARD_TARGET` | configured forward target |
| `NATMAP_FORWARD_PORT` | configured forward port |
| `NATMAP_TIMEOUT` | probe timeout seconds |

`vless_fb` has a built-in HTTPS fallback probe. Plain VLESS only gets a TCP connect probe by default; add a custom probe if you need protocol-level validation. UDP services such as HY2 or QUIC should normally provide a custom probe because generic UDP has no reliable response semantics.
