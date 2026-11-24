# Security Headers Configuration

This document describes the production-grade security headers applied by the ChainSettle Backend. These headers are enforced via Helmet.js and CORS middleware in `src/main.ts`.

## Overview

Security headers protect against common web vulnerabilities such as clickjacking, MIME-type sniffing, cross-site scripting (XSS), and protocol downgrade attacks. All responses from the ChainSettle API include the headers listed below.

## Helmet Security Headers

### Content-Security-Policy (CSP)

**Header**: `Content-Security-Policy: default-src 'self'`

Restricts the sources from which the browser can load resources (scripts, stylesheets, images, etc.). The restrictive `default-src 'self'` policy means:
- Only resources from the same origin (`'self'`) are allowed
- Inline scripts and styles are blocked
- External scripts and stylesheets are blocked

**Use case**: Mitigates XSS attacks by preventing injection of malicious scripts from external sources.

**Configuration** (in `src/main.ts`):
```typescript
helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
    },
  },
})
```

### HTTP Strict-Transport-Security (HSTS)

**Header**: `Strict-Transport-Security: max-age=31536000; includeSubDomains`

Instructs browsers to only communicate with the server over HTTPS (encrypted connections). Once a browser receives this header, it will:
- Automatically upgrade HTTP requests to HTTPS for 1 year (31536000 seconds)
- Apply the same policy to all subdomains (`includeSubDomains`)

**Use case**: Protects against man-in-the-middle (MITM) attacks and protocol downgrade attacks.

**Configuration** (in `src/main.ts`):
```typescript
helmet({
  hsts: {
    maxAge: 31536000,        // 1 year in seconds
    includeSubDomains: true,
    preload: false,
  },
})
```

### X-Content-Type-Options

**Header**: `X-Content-Type-Options: nosniff`

Prevents browsers from inferring the MIME type of a resource. Without this header, a browser might execute a file that was intended to be downloaded (e.g., misinterpreting a `.js` file as HTML).

**Use case**: Mitigates MIME-sniffing attacks.

**Configuration** (in `src/main.ts`):
```typescript
helmet({
  noSniff: true,
})
```

### X-Frame-Options

**Header**: `X-Frame-Options: DENY`

Prevents the application from being embedded in an iframe on other domains. The `DENY` directive means:
- The page cannot be displayed in a frame at all, even on the same origin
- An iframe on any site will fail to load the page

Alternative directives (not currently used):
- `SAMEORIGIN`: Allows framing only from the same origin
- `ALLOW-FROM https://example.com`: Allows framing from a specific origin (deprecated in modern browsers)

**Use case**: Mitigates clickjacking attacks where an attacker overlays a legitimate page with malicious content.

**Configuration** (in `src/main.ts`):
```typescript
helmet({
  frameguard: { action: 'deny' },
})
```

### X-XSS-Protection

**Header**: `X-XSS-Protection: 1; mode=block`

Instructs older browsers (IE, Edge <18) to block pages if they detect XSS attacks. Modern browsers use CSP instead, but this header provides defense-in-depth for legacy clients.

**Use case**: Legacy protection against reflected XSS in older browsers.

**Configuration** (in `src/main.ts`):
```typescript
helmet({
  xssFilter: true,
})
```

### X-Powered-By Disabled

**Header**: Not present

By default, Express.js and many frameworks expose the `X-Powered-By` header (e.g., `X-Powered-By: Express`), which leaks technology information to potential attackers. This header is explicitly disabled.

**Configuration** (in `src/main.ts`):
```typescript
const expressApp = app.getHttpAdapter().getInstance() as any;
if (expressApp?.disable) {
  expressApp.disable('x-powered-by');
}
```

## CORS Configuration

### Overview

Cross-Origin Resource Sharing (CORS) allows browser clients from different origins to make requests to the API. The ChainSettle Backend enforces a strict allowlist of trusted origins.

### Origin Allowlist

The API accepts requests only from origins listed in the `ALLOWED_ORIGINS` environment variable:

**Environment Variable**: `ALLOWED_ORIGINS` (comma-separated list)
**Fallback**: `CORS_ORIGIN` (single origin, used if `ALLOWED_ORIGINS` is not set)
**Default**: `http://localhost:5173` (local development)

**Configuration** (in `src/main.ts`):
```typescript
const allowedOrigins = configService
  .get<string>('ALLOWED_ORIGINS')
  ?.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const fallbackOrigin = configService.get<string>('CORS_ORIGIN', 'http://localhost:5173');

app.enableCors({
  origin: allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : [fallbackOrigin],
  credentials: true,
  // ...
});
```

### Allowed Methods

The API accepts the following HTTP methods from CORS requests:

```
GET, POST, PUT, PATCH, DELETE, OPTIONS
```

### Allowed Request Headers

Clients may send the following headers in CORS requests:

```
Content-Type, Authorization, X-Request-ID
```

### Exposed Response Headers

The API exposes the following headers so browsers can read them:

```
X-Request-ID             → Unique request identifier
X-RateLimit-Limit        → Max requests per window
X-RateLimit-Remaining    → Remaining requests in window
X-RateLimit-Reset        → Unix timestamp when window resets
Retry-After              → Seconds to wait before retrying (on 429 responses)
```

**Configuration** (in `src/main.ts`):
```typescript
app.enableCors({
  exposedHeaders: [
    'X-Request-ID',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'Retry-After',
  ],
  credentials: true,
});
```

### Credentials Support

The API allows credentials (cookies, HTTP authentication, TLS client certificates) in CORS requests:

```
Access-Control-Allow-Credentials: true
```

This enables the frontend to include authentication tokens in requests to the API.

## Testing Security Headers

The test suite includes comprehensive end-to-end tests for all security headers:

**Test file**: `test/security-headers.e2e-spec.ts`

**Run tests**:
```bash
npm run test:e2e -- security-headers
```

**Test coverage**:
- CSP, HSTS, X-Content-Type-Options, X-Frame-Options, X-XSS-Protection headers are present
- X-Powered-By header is absent
- CORS origin allowlist is enforced
- CORS allowed methods and headers are correct
- CORS exposed headers are correct
- Security headers are applied to all response types (success, error)

## Production Deployment

### Configuration Checklist

- [ ] Set `ALLOWED_ORIGINS` to a comma-separated list of production frontend URLs
  - Example: `ALLOWED_ORIGINS=https://app.chainsetttle.com,https://dashboard.chainsetttle.com`
- [ ] Set `CORS_ORIGIN` as a fallback (or leave unset if using `ALLOWED_ORIGINS`)
- [ ] Ensure the API is served over HTTPS (HSTS max-age=31536000 assumes this)
- [ ] Verify that no sensitive information is leaked in error responses (see `docs/observability.md`)

### Example Production .env

```env
# Multiple allowed origins for production
ALLOWED_ORIGINS=https://app.chainsetttle.com,https://dashboard.chainsetttle.com,https://admin.chainsetttle.com

# CORS_ORIGIN is not needed when ALLOWED_ORIGINS is set
# CORS_ORIGIN=https://app.chainsetttle.com
```

## Additional References

- [OWASP Top 10 - Broken Access Control](https://owasp.org/Top10/A01_2021-Broken_Access_Control/)
- [OWASP Top 10 - Injection](https://owasp.org/Top10/A03_2021-Injection/)
- [MDN - HTTP Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers)
- [Helmet.js Documentation](https://helmetjs.github.io/)
- [CORS Explained](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- [Content Security Policy (CSP)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [Strict-Transport-Security (HSTS)](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security)

## Related Issues

- #557: Security header validation
- #562: CORS hardening
- #556: Helmet configuration audit
- #555: Documentation of security headers
