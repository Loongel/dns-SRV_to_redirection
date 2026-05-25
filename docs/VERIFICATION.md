# Verification Record

This file records the integration checks performed during the 2026-05-26 cleanup.

## Local Worker

- `node --check worker.js`: passed.
- `node tests/worker-smoke.mjs`: passed.
- The smoke test verifies portal HTML, browser-timezone timestamp data, `/api/resources?force=1`, `/api/refresh`, TXT queue writes, rate limiting, and POST fallback `303` behavior.

## OpenWrt Agent

Verified on host alias `wrt`:

- `bash -n /etc/natmap/ddns/Cloudflare /etc/natmap/natmap-portal-agent.sh`: passed.
- `NATMAP_PORTAL_VERBOSE=1 /etc/natmap/natmap-portal-agent.sh --once-refresh`: passed.
- `NATMAP_PORTAL_VERBOSE=1 /etc/natmap/natmap-portal-agent.sh --once-health`: passed.
- Agent process is bound through one natmap `custom_script`; no project cron entries are required.
- Refresh polling reads `_natmap-refresh...` with `nslookup`, not Cloudflare API.

## Manual Refresh Test

A live `POST /api/refresh` for a HY2 service wrote a new TXT queue message. The OpenWrt agent processed the nonce and restarted only the matching natmap section. natmap random port allocation changed the public port and the Worker API returned the new port after force refresh.

## Health Maintenance Test

A temporary failing custom probe was installed for the HY2 service and `NATMAP_HEALTH_FAIL_THRESHOLD=1` was used for the test only. The agent:

- detected the failure,
- restarted only the matching section,
- changed the natmap public port through random allocation,
- cleared the failure counter,
- and DDNS synchronized the new SRV port.

The temporary probe was removed after the test.

## HTTP/HTTPS Probe Test

The HTTPS probe was corrected to use section target variables instead of portal-facing SRV names. The tested pattern was:

```text
curl --resolve <ddns_https_target>:<public_port>:<public_ip> https://<ddns_https_target>:<public_port>/
```

A real HTTPS section returned HTTP `307`, which is considered healthy because the service responded.

## Known Limits

- UDP has no generic default failure detector. Use `/etc/natmap/health.d/<ddns_srv>` for HY2, QUIC, games, or other UDP protocols.
- SSH/FTP/RDP default to TCP connect checks because many implementations do not safely expose a banner or protocol response to a generic `nc` read.
