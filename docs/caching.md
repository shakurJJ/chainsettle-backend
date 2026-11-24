# Redis Caching Reference

This document is the authoritative inventory of everything ChainSettle stores in Redis. It covers key patterns, TTLs, invalidation rules, and module ownership. For the architectural rationale behind choosing Redis, see [ADR-0003](./adr/0003-redis-state-caching.md).

---

## Key inventory

All keys use one of two top-level namespaces:

- `chainsettle:` — application-specific state (auth, sessions, jobs, locks)
- Unprefixed namespaces — service-owned groups (`fx:`, `shipments:`, `arbiter:`, `feature-flag:`, `ipfs:`, `throttle:`, `performance:`)

---

### Auth nonces

| Key pattern | `chainsettle:nonce:<stellarAddress>` |
|---|---|
| **Owner** | `AuthService` (`src/modules/auth/auth.service.ts`) |
| **TTL** | 5 minutes (`NONCE_TTL_MS = 300 000 ms`) |
| **Value** | Plain string: `chainsettle:<address>:<timestamp>:<random>` |
| **Invalidation** | Deleted immediately after successful signature verification (one-time use). Also expires naturally after 5 minutes. |

---

### Email verification tokens

| Key pattern | `chainsettle:email-verification-token:<userId>` |
|---|---|
| **Owner** | `AuthService` (`src/modules/auth/auth.service.ts`) |
| **TTL** | 24 hours |
| **Value** | Signed JWT (`{ sub, email }`, expires in 24 h) |
| **Invalidation** | Deleted after the user successfully verifies their email. Also expires naturally. |

---

### Phone OTP codes

| Key pattern | `chainsettle:phone-otp:<userId>` |
|---|---|
| **Owner** | `AuthService` (`src/modules/auth/auth.service.ts`) |
| **TTL** | 5 minutes (`PHONE_OTP_TTL_MS = 300 000 ms`) |
| **Value** | 6-digit numeric OTP string |
| **Invalidation** | Deleted after successful phone verification. Expires naturally after 5 minutes. |

---

### JWT session sets

| Key pattern | `chainsettle:sessions:<userId>` |
|---|---|
| **Owner** | `SessionService` (`src/modules/auth/session.service.ts`) |
| **TTL** | No TTL — the set persists until all members are removed |
| **Value** | Redis Set of active `jti` (JWT ID) strings for this user |
| **Invalidation** | Members are removed individually on logout / session revocation. The set is emptied by `revokeAllSessions` (force-logout). Stale members whose tokens have expired are harmless — they are never returned to callers. |

---

### JWT blocklist (revoked sessions)

| Key pattern | `chainsettle:blocklist:<jti>` |
|---|---|
| **Owner** | `SessionService` (`src/modules/auth/session.service.ts`) |
| **TTL** | Remaining JWT lifetime at revocation time (derived from `JWT_EXPIRES_IN`, default `7d`) |
| **Value** | `"1"` (presence is the signal; value is irrelevant) |
| **Invalidation** | Self-expiring. After the original JWT would have expired the blocklist entry is no longer needed and is removed automatically. |

---

### API key usage counters

| Key pattern | `chainsettle:api-key:usage:<keyId>` |
|---|---|
| **Owner** | `ApiKeyStrategy` (`src/modules/auth/api-key.strategy.ts`) |
| **TTL** | 31 days (`API_KEY_USAGE_TTL_SECONDS`) |
| **Value** | Counter (incremented on every authenticated request) |
| **Invalidation** | Self-expiring (rolling 31-day window). Refreshed on each use via `EXPIRE`. |

---

### Rate-limiter counters

| Key pattern | `throttle:<throttlerKey>` |
|---|---|
| **Owner** | `RedisThrottlerStorageService` (`src/common/throttler/redis-throttler-storage.service.ts`) |
| **TTL** | Fixed window size in milliseconds (set by `@nestjs/throttler` per route) |
| **Value** | Hit counter (integer) |
| **Invalidation** | Self-expiring when the fixed window closes. Not explicitly invalidated. |

---

### Event-poller leader lock

| Key pattern | `chainsettle:event-poller:leader` |
|---|---|
| **Owner** | `EventsService` (`src/modules/events/events.service.ts`) |
| **TTL** | 15 seconds (`POLLER_LOCK_TTL_MS`), renewed every 5 seconds while held |
| **Value** | UUID token identifying the current leader pod |
| **Invalidation** | Released explicitly via a Lua CAS script when the leader shuts down. Falls off naturally if the leader pod crashes and stops renewing. |

---

### Event backfill lock

| Key pattern | `chainsettle:event-backfill:lock` |
|---|---|
| **Owner** | `BackfillService` (`src/modules/events/backfill.service.ts`) |
| **TTL** | 30 seconds (`BACKFILL_LOCK_TTL_MS`) |
| **Value** | UUID token |
| **Invalidation** | Released via Lua CAS on completion. Self-expires on crash. |

---

### Scheduled-job locks

The following distributed locks prevent concurrent execution of cron jobs across pods. All use the same `acquireLock` / `releaseLock` mechanism.

| Key pattern | Owner job | TTL |
|---|---|---|
| `chainsettle:reconciliation:lock` | `ReconciliationJob` | 1 hour |
| `chainsettle:late-delivery:lock` | `LateDeliveryJob` | 10 minutes |
| `chainsettle:notification-cleanup:lock` | `NotificationCleanupJob` | 10 minutes |
| `chainsettle:shipment-archival:lock` | `ShipmentArchivalJob` | 10 minutes |
| `chainsettle:shipment-reminders:lock` | `ShipmentReminderJob` | 4 minutes |
| `chainsettle:recurring-schedules:lock` | `RecurringScheduleJob` | 4 minutes |

**Invalidation:** Released via Lua CAS at job completion. Self-expire on crash, allowing the next scheduled execution to acquire the lock.

---

### Job run tracker

| Key pattern | `chainsettle:jobs:<jobName>:last_run` |
|---|---|
| **Owner** | `runTrackedJob` util (`src/common/jobs/job-tracker.util.ts`) |
| **TTL** | No TTL — persists indefinitely |
| **Value** | JSON `{ name, lastRunAt, lastResult, durationMs, error }` |
| **Invalidation** | Overwritten on every job execution. Never deleted. |

---

### FX rates — token/USD

| Key pattern | `fx:rate:<TOKEN_SYMBOL>` (e.g. `fx:rate:USDC`) |
|---|---|
| **Owner** | `FxRateService` (`src/common/fx/fx-rate.service.ts`) |
| **TTL** | `FX_RATE_CACHE_TTL_SECONDS` env var, default **300 s (5 min)** |
| **Value** | JSON `{ rate: number, asOf: ISO-8601 }` |
| **Invalidation** | Overwritten on every scheduled refresh (`FxRateJob`). |

A companion last-known-good copy is stored at `fx:rate:<TOKEN_SYMBOL>:last` with **no TTL**. It is served with `stale: true` when the fresh entry has expired or while the provider circuit breaker is open.

---

### FX rates — USD/fiat cross-rates

| Key pattern | `fx:fiat:<CURRENCY_CODE>` (e.g. `fx:fiat:EUR`) |
|---|---|
| **Owner** | `FxRateService` (`src/common/fx/fx-rate.service.ts`) |
| **TTL** | Same as token/USD: `FX_RATE_CACHE_TTL_SECONDS` (default 300 s) |
| **Value** | JSON `{ rate: number, asOf: ISO-8601 }` |
| **Invalidation** | Overwritten on every scheduled refresh. |

A last-known-good copy is stored at `fx:fiat:<CODE>:last` with **no TTL**, served stale on expiry.

---

### Shipment list cache

| Key pattern | `shipments:<callerStellarAddress>:<16-char SHA-256 of filters>` |
|---|---|
| **Owner** | `ShipmentsService.findAllCached` (`src/modules/shipments/shipments.service.ts`) |
| **TTL** | `SHIPMENTS_CACHE_TTL_SECONDS` env var, default **30 s** |
| **Value** | JSON — full paginated response payload |
| **Invalidation** | `delByPrefix('shipments:<callerStellarAddress>:')` is called on any write that changes shipment state (create, status change, milestone confirm, etc.) for that caller. Also self-expires after 30 s. Search requests bypass the cache entirely. |

---

### Arbiter reputation

| Key pattern | `arbiter:reputation:<stellarAddress>` |
|---|---|
| **Owner** | `ArbitersService` (`src/modules/arbiters/arbiters.service.ts`) |
| **TTL** | 7 days (`CACHE_TTL_SECONDS`) |
| **Value** | JSON `ArbiterReputation` object |
| **Invalidation** | Overwritten by `ArbiterReputationJob` on its scheduled run. The 7-day TTL acts as a safety net only — under normal operation the job refreshes every entry before expiry. Arbiter availability is **never** cached; it is read live from the database on every request. |

---

### Feature flags

| Key pattern | `feature-flag:<flagName>` (e.g. `feature-flag:shipment-templates`) |
|---|---|
| **Owner** | `FeatureFlagsService` (`src/modules/feature-flags/feature-flags.service.ts`) |
| **TTL** | No TTL — persists until explicitly deleted |
| **Value** | JSON `{ enabled: boolean, rollout?: number }` |
| **Invalidation** | Updated or deleted via admin API (`PUT /feature-flags/:name`, `DELETE /feature-flags/:name`). No cache: every flag check reads Redis directly so changes propagate instantly to all pods. |

---

### IPFS dedup hashes

| Key pattern | `ipfs:dedup:<sha256-of-file-buffer>` |
|---|---|
| **Owner** | `IpfsService` (`src/common/ipfs/ipfs.service.ts`) |
| **TTL** | `IPFS_DEDUP_TTL_DAYS` env var × 86 400 s, default **30 days** |
| **Value** | IPFS CID string |
| **Invalidation** | Self-expiring only. If an identical file is re-uploaded after expiry it is re-pinned and a new entry is created. |

---

### Performance stats cache

| Key pattern | `performance:<stellarAddress>:<role>:<sinceKey>` |
|---|---|
| **Owner** | `PerformanceService` (`src/modules/performance/performance.service.ts`) |
| **TTL** | 3 600 s (1 hour) — `PERFORMANCE_CACHE_TTL_SECONDS` |
| **Value** | JSON performance stats object |
| **Invalidation** | Self-expiring only. Recomputed on the next request after expiry. |

---

## What happens when Redis is unavailable

Redis is a **required dependency** for the following request-path operations:

| Operation | Failure behaviour |
|---|---|
| Auth nonce generation / login | `500 Internal Server Error` — nonce cannot be stored |
| JWT blocklist check | Blocklisted tokens are **not** rejected (open circuit) |
| Rate limiting | Falls back to per-instance counting — cross-pod limits are not enforced |
| Event-poller leadership | No pod can acquire the leader lock; polling stops entirely |
| Backfill | Backfill jobs cannot start |

For **non-request-path** operations (FX rate cache, shipment list cache, IPFS dedup) the service either serves a degraded response (stale / uncached) or falls through to the database, rather than returning an error to the caller.

Scheduled jobs that rely on distributed locks will skip a run if they cannot acquire the lock. They will retry on the next scheduled invocation.

---

## Flushing Redis in production

> **Warning:** Flushing Redis in a live environment logs out all users, clears all rate-limit windows, and stops the event poller until a new leader lock is acquired.

Safe actions after a full flush:

1. The event poller re-elects a leader automatically within one `POLLER_LOCK_TTL_MS` (15 s).
2. Auth nonces are short-lived — users will simply need to request a new nonce.
3. Active JWT blocklist entries are lost. If an incident requires keeping revoked tokens blocked, do **not** flush Redis. Use targeted `DEL chainsettle:blocklist:<jti>` removals instead, or wait for natural expiry.
4. FX rates will be served as stale from the last-known-good keys (no TTL) until the next scheduled refresh.
5. Shipment list cache will be rebuilt on the next request.
6. Feature flags are deleted and will all evaluate to `false` until re-set. Check `GET /feature-flags` before flushing to record current state.
