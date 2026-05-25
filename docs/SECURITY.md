# Security Notes

## Secrets

Do not commit Cloudflare API tokens, zone ids, or portal passwords. Use Wrangler secrets for Cloudflare values:

```sh
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ZONE_ID
```

OpenWrt DDNS tokens stay in natmap UCI config. The refresh/health agent does not read Cloudflare tokens; it reads the refresh queue via DNS TXT lookup.

## Access Control

The portal and JSON APIs are protected by `PORTAL_PASSWD`. This is a lightweight shared password, not a full account system. For internet-exposed deployments, combine it with Cloudflare Access, firewall rules, or Cloudflare WAF/rate limiting.

## Rate Limiting

Worker-side rate limits are in-memory per isolate. They reduce accidental abuse but are not a strict global limiter. Use Cloudflare edge rate limiting if the portal is public.

## Health Probe Risk

Health checks can restart services. Keep `NATMAP_HEALTH_FAIL_THRESHOLD` above `1` in production unless you have strong custom probes. HTTP/HTTPS probes use real HTTP requests to the public IP and port while preserving Host/SNI with `--resolve`.

## OpenWrt Scope

The provided installer only copies files under `/etc/natmap/` and optionally sets one natmap section's `custom_script`. It should not be used as a general OpenWrt configuration management tool.
