# Security Notes

## Secrets

Do not commit Cloudflare API tokens, zone ids, or portal passwords. Copy `.secrets.example` to `.secrets` for local deployment secrets; `.secrets` is ignored by git. `scripts/deploy-worker.sh` uploads configured Worker secrets through Wrangler before deploying.

OpenWrt DDNS tokens stay in natmap UCI config. The refresh/health agent does not read Cloudflare tokens; it reads the refresh queue via DNS TXT lookup.

`ACCESS_AUTH_SELF_CHECK_TOKEN`, when used, is also a secret. Keep the real token in `/etc/natmap/natmap-portal-agent.conf` or a local deployment environment variable. Do not commit it to this repository.

## Access Control

The portal and JSON APIs are protected by `PORTAL_PASSWD`. This is a lightweight shared password, not a full account system. For internet-exposed deployments, combine it with Cloudflare Access, firewall rules, or Cloudflare WAF/rate limiting.

## Rate Limiting

Worker-side rate limits are in-memory per isolate. They reduce accidental abuse but are not a strict global limiter. Use Cloudflare edge rate limiting if the portal is public.

## Health Probe Risk

Health checks can restart services. Keep `NATMAP_HEALTH_FAIL_THRESHOLD` above `1` in production unless you have strong custom probes. HTTP/HTTPS probes use real HTTP requests to the public IP and port while preserving Host/SNI with `--resolve`.

The optional access-authorization preflight is best-effort and logs only. It should reduce false failures when protected ports require authorization, but it is not treated as health evidence by itself.

## OpenWrt Scope

The provided installer only copies files under `/etc/natmap/` and optionally sets one natmap section's `custom_script`. It should not be used as a general OpenWrt configuration management tool.
