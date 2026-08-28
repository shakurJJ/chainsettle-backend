# ADR-0003: Redis for nonce store, throttling, distributed locks, and caching

**Status:** Accepted

## Context

ChainSettle runs as a NestJS application, potentially behind a load balancer with multiple pods. Several subsystems need shared, low-latency state that is:

- **Ephemeral** (TTL-based expiry).
- **Consistent across pods** (all instances must see the same nonce / throttle count).
- **Fast** (sub-millisecond reads/writes for request-path operations).

Relational databases (PostgreSQL) could store these values, but TTL enforcement requires scheduled cleanup jobs, and row-level locking under high concurrency adds complexity. In-memory stores (e.g., Node.js `Map`) are not shared across pods.

## Decision

Use **Redis** (via `ioredis`) as the shared volatile store for:

1. **Auth nonces** — `chainsettle:nonce:<address>` with a 5-minute PX TTL. Used by `AuthService.generateNonce()` / `login()`.
2. **Rate limiting** — `RedisThrottlerStorageService` implements `@nestjs/throttler`'s `ThrottlerStorage` interface, storing throttle counters under `throttle:` keys with fixed-window semantics.
3. **Event-poller leader lock** — `chainsettle:event-poller:leader` with a 15-second TTL, renewed every 5 seconds via Lua scripts (`acquireLock`, `renewLock`, `releaseLock`).
4. **Email verification tokens** — `chainsettle:email-verification-token:<userId>` with a 24-hour TTL.
5. **Refresh tokens** — hashed JWTs stored in Redis for revocation support.
6. **Caching** — token registry lists, FX rates, arbiter reputation, IPFS deduplication, and shipment status responses are cached with JSON + TTL.

A single `RedisService` (`src/common/redis/redis.service.ts`) wraps `ioredis` and exposes typed helpers (`setPx`, `getJson`, `setJson`, `delByPrefix`, `acquireLock`, etc.).

## Consequences

- **Positive**
  - Multi-pod consistency: nonces and throttle counters are globally visible.
  - Native TTL support eliminates stale-key cleanup jobs.
  - Sub-millisecond latency for auth-path reads.
  - Distributed locking enables safe single-leader event processing.
- **Negative**
  - Redis is now a critical dependency: if it is down, auth nonces cannot be stored, rate limiting falls back to per-instance behavior (or open circuit in `RedisThrottlerStorageService`), and the event poller cannot elect a leader.
  - Additional operational surface (backup, memory planning, sentinel / cluster topology).
- **Neutral**
  - All Redis keys are prefixed (`chainsettle:`, `throttle:`) to avoid collisions in shared environments.
