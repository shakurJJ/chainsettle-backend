# Rate Limiting

ChainSettle applies rate limiting to all API routes via `@nestjs/throttler` backed by Redis
(`src/common/throttler/redis-throttler-storage.service.ts`). Redis storage ensures limits are
consistent across all running pods/instances — a user cannot bypass the limit by hitting a
different server.

The global throttler guard (`RateLimitThrottlerGuard`,
`src/common/guards/rate-limit-throttler.guard.ts`) is applied as a global `APP_GUARD` in
`AppModule`, so every route is covered unless it is explicitly overridden.

---

## Default limit (all routes not listed below)

| Tier | Value | Environment variable |
|------|-------|----------------------|
| Default / anonymous | 100 per window | `THROTTLE_LIMIT` (default `100`) |
| KYC-verified user | 250 per window | `THROTTLE_LIMIT_VERIFIED` (default `250`) |
| Admin user | 500 per window | `THROTTLE_LIMIT_ADMIN` (default `500`) |
| Window | 60 seconds | `THROTTLE_TTL` (in seconds; default `60`) |
| Key | IP address | — |

The effective limit is chosen from the authenticated user's record when one is present:
- admin users receive the admin tier
- verified users receive the verified tier
- everyone else remains on the default tier

---

## Per-route overrides

The following endpoints use stricter limits defined with `@Throttle()` on the handler.
Routes that also use `StellarAddressThrottlerGuard` are keyed by **Stellar address** rather
than IP, so each wallet address has its own independent counter.

| Endpoint | Window | Limit | Key | Notes |
|----------|--------|-------|-----|-------|
| `GET /api/v1/auth/nonce` | 60 s | 5 | Stellar address | Prevents nonce harvesting |
| `POST /api/v1/auth/login` | 60 s | 10 | Stellar address | Prevents brute-force signature attempts |
| `POST /api/v1/auth/resend-verification` | 60 s | 1 | Stellar address | One re-send per minute per address |
| `POST /api/v1/shipments/:id/milestones/:index/proof` | 3600 s (1 hour) | 5 | Stellar address | Proof file uploads; 5 uploads per hour per user |
| `GET /api/v1/shipments/export` | 3600 s (1 hour) | 5 | IP | CSV/PDF bulk export |
| `GET /api/v1/shipments/:id/export` | 3600 s (1 hour) | 10 | IP | Single shipment PDF export |

---

## Authenticated vs. unauthenticated callers

- **Unauthenticated routes** (`/auth/nonce`, `/auth/login`) key by Stellar address (passed as a
  query parameter or in the request body). This means an attacker cannot exhaust another user's
  limit from a different IP, but also cannot escape their own limit by rotating IPs.
- **Authenticated routes** default to IP keying from the global throttler. Per-route overrides
  on authenticated proof and export endpoints continue to use IP keying via the default throttler,
  but proof submission also applies `StellarAddressThrottlerGuard` to additionally key by the
  authenticated user's Stellar address.

---

## Response headers

Every response from a rate-limited route includes the following headers (CORS-exposed so
browser clients can read them):

| Header | Present on | Meaning |
|--------|-----------|---------|
| `X-RateLimit-Limit` | All responses | Maximum requests allowed in the current window |
| `X-RateLimit-Remaining` | All responses | Requests left in the window (`0` when rate limited) |
| `X-RateLimit-Reset` | All responses | Seconds until the current window resets |
| `Retry-After` | `429` responses only | Same value as `X-RateLimit-Reset` — how long to wait before retrying |

When a route has a named throttler (anything other than `default`) the suffix
`-<name>` is appended: e.g., `X-RateLimit-Limit-auth`.

---

## 429 response body

When the limit is exceeded the `ThrottlerExceptionFilter` returns:

```json
{
  "success": false,
  "statusCode": 429,
  "timestamp": "2026-08-28T19:00:00.000Z",
  "path": "/api/v1/auth/nonce",
  "message": "Too Many Requests"
}
```

---

## Self-throttling for API consumers

Read `X-RateLimit-Remaining` on each response and slow down proactively before it reaches `0`.
When it does reach `0` on a non-`429` response, the next request will be blocked. Use
`X-RateLimit-Reset` (or `Retry-After` on a `429`) to know exactly how many seconds to wait.

A minimal back-off loop in pseudocode:

```
remaining = response.headers['X-RateLimit-Remaining']
if remaining == "0":
    reset_in = response.headers['X-RateLimit-Reset']
    sleep(reset_in)
```

---

## Implementation references

| Concern | Location |
|---------|----------|
| Redis storage adapter | `src/common/throttler/redis-throttler-storage.service.ts` |
| Global throttler guard (sets headers) | `src/common/guards/rate-limit-throttler.guard.ts` |
| Stellar-address keying guard | `src/common/guards/stellar-address-throttler.guard.ts` |
| ThrottlerModule registration | `src/app.module.ts` |
| Auth endpoint limits | `src/modules/auth/auth.controller.ts` |
| Proof upload limit | `src/modules/milestones/milestones.controller.ts` |
| Export limits | `src/modules/shipments/shipments.controller.ts` |

---

## Local verification

Use the bundled shell script to test success responses and `429` behaviour against a running
local API:

```bash
./test-rate-limit.sh
```

Expected outcomes:
- `GET /auth/nonce` — requests 1–5 return `200` with `X-RateLimit-Remaining` counting down;
  requests 6–7 return `429` with `Retry-After`.
- `POST /auth/login` — first 10 requests return `401` (invalid signature, not rate-limited);
  requests 11–12 return `429`.
