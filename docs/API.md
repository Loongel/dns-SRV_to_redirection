# API Reference

All API routes are served from `PORTAL_DOMAIN` and require the portal password.

## GET `/api/resources`

Query parameters:

| Name | Required | Purpose |
| --- | --- | --- |
| `pwd` | yes | Portal password. |
| `force` | no | `1` forces a Cloudflare SRV fetch, subject to rate limits. |

Response:

```json
{
  "ok": true,
  "resources": [
    {
      "domain": "web.s.example.com",
      "service": "_http",
      "protocol": "_tls",
      "target": "web.n.example.com",
      "port": 443,
      "link": "https://web.n.example.com:443",
      "isWeb": true,
      "updatedIso": "2026-05-26T00:00:00.000Z",
      "redirectStatus": 307
    }
  ],
  "cache": {
    "fetchedAt": 1779734120,
    "duplicateCount": 0,
    "staleCount": 0,
    "lastError": ""
  }
}
```

Errors:

| Status | Meaning |
| --- | --- |
| `401` | Wrong password. |
| `429` | Force fetch rate limit exceeded. |

## POST `/api/refresh`

JSON body:

```json
{
  "pwd": "portal-password",
  "domain": "hm-hy2.s.example.com",
  "currentPort": 24498
}
```

Response:

```json
{
  "ok": true,
  "domain": "hm-hy2.s.example.com",
  "oldPort": 24498,
  "queuedAt": "2026-05-26T00:00:00.000Z"
}
```

Errors:

| Status | Meaning |
| --- | --- |
| `400` | Missing domain. |
| `401` | Wrong password. |
| `404` | Domain is not a managed SRV resource. |
| `429` | Refresh or force-fetch rate limit exceeded. |
| `502` | Cloudflare TXT queue write failed. |

## HTML Form Fallback

The portal also supports form POSTs for redirect status and refresh actions. Successful POSTs return `303 See Other`, so browser reloads do not repeat refresh actions.
