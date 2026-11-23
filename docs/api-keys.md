# API Keys — Machine-to-Machine Authentication

API keys give automated integrations (CI pipelines, backend services, monitoring scripts) a stable credential that does not require a Stellar wallet or interactive login. Each key is scoped to a single user account and carries either read-only or full read/write access.

---

## Table of Contents

- [Concepts](#concepts)
- [Managing Keys (JWT Required)](#managing-keys-jwt-required)
  - [Create a Key](#create-a-key)
  - [List Keys](#list-keys)
  - [Rotate a Key](#rotate-a-key)
  - [Revoke a Key](#revoke-a-key)
  - [Get Usage Stats](#get-usage-stats)
- [Using a Key in Requests](#using-a-key-in-requests)
- [Scopes](#scopes)
- [Monthly Request Quotas](#monthly-request-quotas)
- [Storage and Key Format](#storage-and-key-format)
- [Expiry and lastUsedAt Tracking](#expiry-and-lastusedAt-tracking)
- [Which Endpoints Accept API Key Auth](#which-endpoints-accept-api-key-auth)
- [Security Best Practices](#security-best-practices)
- [Error Reference](#error-reference)

---

## Concepts

| Concept | Detail |
|---------|--------|
| **Header** | `X-Api-Key: <key>` |
| **Key format** | 40 lowercase hex characters (`randomBytes(20).toString('hex')`) |
| **Storage** | SHA-256 digest only — the raw key is never persisted |
| **Plaintext shown** | Once, in the create (or rotate) response — not retrievable again |
| **Scopes** | `read` (GET/HEAD) and/or `write` (POST/PUT/PATCH/DELETE) |
| **Monthly quota** | `monthlyQuota` requests per calendar month (default from config) |
| **Management auth** | JWT only — API keys cannot create or manage other API keys |

---

## Managing Keys (JWT Required)

All key-management routes live under `/api/v1/auth/api-keys` and require an `Authorization: Bearer <JWT>` header. You cannot use an API key to manage API keys.

### Create a Key

```
POST /api/v1/auth/api-keys
```

**Request fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | Human-readable label, max 64 chars |
| `scopes` | `string[]` | No | `["read"]` or `["read","write"]`; defaults to `["read","write"]` |
| `expiresAt` | ISO 8601 string | No | Must be in the future and at most 1 year out; omit for a non-expiring key |
| `monthlyQuota` | integer | No | Max requests per calendar month; defaults to the configured `API_KEY_MONTHLY_QUOTA` |

**Example — read/write key for a CI pipeline:**

```bash
curl -s -X POST https://api.example.com/api/v1/auth/api-keys \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"name": "CI Pipeline"}'
```

**Example — read-only key with an expiry:**

```bash
curl -s -X POST https://api.example.com/api/v1/auth/api-keys \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Monitoring Dashboard",
    "scopes": ["read"],
    "expiresAt": "2027-09-25T00:00:00.000Z"
  }'
```

**Response (HTTP 201):**

```json
{
  "success": true,
  "data": {
    "id": "3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f",
    "name": "CI Pipeline",
    "scopes": ["read", "write"],
    "expiresAt": null,
    "monthlyQuota": 100000,
    "createdAt": "2026-09-29T10:00:00.000Z",
    "key": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
  },
  "timestamp": "2026-09-29T10:00:00.000Z"
}
```

> **The `key` field is only present in this response.** It is never stored and will not be returned again. Copy it to your secrets manager before closing this response.

---

### List Keys

Returns all active (non-revoked) keys for the authenticated user. The raw key value is never included.

```
GET /api/v1/auth/api-keys
```

```bash
curl -s https://api.example.com/api/v1/auth/api-keys \
  -H "Authorization: Bearer $JWT"
```

**Response (HTTP 200):**

```json
{
  "success": true,
  "data": [
    {
      "id": "3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f",
      "name": "CI Pipeline",
      "scopes": ["read", "write"],
      "lastUsedAt": "2026-09-29T11:30:00.000Z",
      "expiresAt": null,
      "monthlyQuota": 100000,
      "createdAt": "2026-09-29T10:00:00.000Z"
    }
  ],
  "timestamp": "2026-09-29T12:00:00.000Z"
}
```

---

### Rotate a Key

Atomically revokes the specified key and issues a replacement with the same name and scopes. Use this for regular key rotation or when a key may have been exposed. The `expiresAt` from the old key is intentionally **not** inherited — re-specify it explicitly if needed.

```
POST /api/v1/auth/api-keys/:id/rotate
```

**Request fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `gracePeriodSeconds` | integer | No | Seconds the **old** key stays valid after rotation (0–86400). Defaults to `0` (immediate revocation). |

Use `gracePeriodSeconds` to perform a zero-downtime swap: deploy the new key while the old one still works, then remove the old key reference.

**Example — immediate rotation:**

```bash
curl -s -X POST https://api.example.com/api/v1/auth/api-keys/3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f/rotate \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Example — 5-minute grace period for zero-downtime swap:**

```bash
curl -s -X POST https://api.example.com/api/v1/auth/api-keys/3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f/rotate \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"gracePeriodSeconds": 300}'
```

**Response (HTTP 201):**

```json
{
  "success": true,
  "data": {
    "id": "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d",
    "name": "CI Pipeline",
    "scopes": ["read", "write"],
    "expiresAt": null,
    "monthlyQuota": 100000,
    "createdAt": "2026-09-29T14:00:00.000Z",
    "rotatedFromId": "3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f",
    "gracePeriodEndsAt": "2026-09-29T14:05:00.000Z",
    "key": "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5"
  },
  "timestamp": "2026-09-29T14:00:00.000Z"
}
```

> The `key` in the rotation response is the **new** key's plaintext — shown once only. Save it immediately.

---

### Revoke a Key

Immediately marks a key as revoked. Revoked keys return `401` on all subsequent requests and do not appear in the list endpoint.

```
DELETE /api/v1/auth/api-keys/:id
```

```bash
curl -s -X DELETE https://api.example.com/api/v1/auth/api-keys/3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f \
  -H "Authorization: Bearer $JWT"
```

**Response (HTTP 200):**

```json
{
  "success": true,
  "data": {
    "message": "API key revoked successfully"
  },
  "timestamp": "2026-09-29T15:00:00.000Z"
}
```

---

### Get Usage Stats

Retrieve daily request counts for the last 30 days along with `lastUsedAt`. This allows key owners to audit usage activity, identify idle keys, and detect leaked keys. Owner-only.

The response also includes the key's current monthly quota usage so owners can see how close they are to the cap.

```
GET /api/v1/auth/api-keys/:id/usage
```

**Example:**

```bash
curl -s https://api.example.com/api/v1/auth/api-keys/3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f/usage \
  -H "Authorization: Bearer $JWT"
```

**Response (HTTP 200):**

```json
{
  "id": "3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f",
  "name": "CI Deployment Key",
  "lastUsedAt": "2026-10-19T10:15:30.000Z",
  "totalRequests30d": 128,
  "monthlyQuota": 100000,
  "monthlyUsage": 128,
  "monthlyRemaining": 99872,
  "quotaResetsAt": "2026-11-01T00:00:00.000Z",
  "dailyUsage": [
    { "date": "2026-09-20", "count": 0 },
    { "date": "2026-10-18", "count": 42 },
    { "date": "2026-10-19", "count": 86 }
  ]
}
```

---

## Using a Key in Requests

Pass the key in the `X-Api-Key` header on any request to an endpoint that accepts API key authentication:

```bash
curl -s https://api.example.com/api/v1/shipments \
  -H "X-Api-Key: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
```

```bash
# POST example (requires "write" scope)
curl -s -X POST https://api.example.com/api/v1/shipments \
  -H "X-Api-Key: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" \
  -H "Content-Type: application/json" \
  -d '{"contractId": "..."}'
```

Do **not** combine `X-Api-Key` with an `Authorization: Bearer` header in the same request — JWT authentication takes precedence where both guards are applied.

---

## Scopes

Scopes control which HTTP methods a key may use:

| Scope | Permitted methods |
|-------|------------------|
| `read` | `GET`, `HEAD` |
| `write` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` |

A key created with `"scopes": ["read", "write"]` (the default) has full access. A key created with `"scopes": ["read"]` is rejected with `403 API_KEY_SCOPE_INSUFFICIENT` if it attempts any mutating operation.

Prefer read-only keys for integrations that only need to read data.

---

## Monthly Request Quotas

Rate limits stop bursts, but a single integration can still generate sustained heavy load. Each API key therefore carries a `monthlyQuota` — the maximum number of requests it may make in a calendar month.

| Behaviour | Detail |
|-----------|--------|
| **Default** | Taken from the `API_KEY_MONTHLY_QUOTA` config value when a key is created without an explicit `monthlyQuota` |
| **Counting** | Requests are counted in Redis, keyed by API key and month (`YYYY-MM`) |
| **Reset** | The counter is month-scoped, so usage automatically resets at the start of each calendar month |
| **Enforcement** | Once the quota is exhausted, further requests are rejected with `429` and error code `API_KEY_QUOTA_EXCEEDED` |
| **Raising quotas** | Admins can raise a key's `monthlyQuota`; the new limit applies immediately to the current month's counter |

Every API-key-authenticated response includes quota headers so clients can track consumption:

| Header | Meaning |
|--------|---------|
| `X-Quota-Limit` | The key's monthly quota |
| `X-Quota-Used` | Requests used in the current month |
| `X-Quota-Remaining` | Requests remaining in the current month |
| `X-Quota-Reset` | ISO 8601 timestamp when the counter resets (start of next month) |

**Example — quota exceeded:**

```json
{
  "success": false,
  "error": {
    "code": "API_KEY_QUOTA_EXCEEDED",
    "message": "Monthly request quota exceeded for this API key"
  },
  "timestamp": "2026-10-19T10:15:30.000Z"
}
```

---

## Storage and Key Format

Keys are generated with `randomBytes(20).toString('hex')` (40 lowercase hex characters) and only their SHA-256 digest is persisted. The plaintext is returned exactly once, at creation or rotation.

---

## Expiry and lastUsedAt Tracking

Keys may carry an `expiresAt` (at most 1 year out). Expired keys return `401`. `lastUsedAt` is updated on each successful authentication so owners can spot idle or leaked keys.

---

## Which Endpoints Accept API Key Auth

Endpoints that accept API key authentication are documented per-route. Where both JWT and API key guards apply, a valid `Authorization: Bearer` header takes precedence over `X-Api-Key`.

---

## Security Best Practices

- Store keys in a secrets manager, never in source control.
- Use read-only keys wherever possible.
- Rotate keys regularly, using `gracePeriodSeconds` for zero-downtime swaps.
- Set an `expiresAt` on keys used by temporary integrations.
- Monitor usage via the usage endpoint and `X-Quota-*` headers to detect anomalies.

---

## Error Reference

| HTTP | Code | Meaning |
|------|------|---------|
| `401` | `API_KEY_INVALID` | Key is unknown, revoked, or expired |
| `403` | `API_KEY_SCOPE_INSUFFICIENT` | Key lacks the scope required for the method |
| `429` | `API_KEY_QUOTA_EXCEEDED` | Monthly request quota for the key is exhausted |
