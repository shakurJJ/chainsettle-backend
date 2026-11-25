# Feature Flags

Feature flags gate new functionality so it can be released gradually, tested
internally, or switched off in production without a deploy.

Flags are persisted in the database and cached in Redis, which the app already
runs for the nonce store and throttling. The cache is invalidated whenever a
flag changes, so a toggle takes effect on the next request across every pod
without a restart or redeploy.

## Contents

- [Gating a route](#gating-a-route)
- [Flag naming](#flag-naming)
- [Flag shape](#flag-shape)
- [Toggling a flag without a redeploy](#toggling-a-flag-without-a-redeploy)
- [Admin API](#admin-api)
- [Targeting](#targeting)
- [Percentage rollouts](#percentage-rollouts)
- [Caching and invalidation](#caching-and-invalidation)
- [Audit logging](#audit-logging)
- [Reading flags in a service](#reading-flags-in-a-service)
- [Removing a flag](#removing-a-flag)

## Gating a route

Apply `@FeatureFlag()` and `FeatureFlagGuard`. On a controller the flag covers
every route in it; on a single handler it covers only that route, and a
handler-level flag overrides a controller-level one.

```ts
import { UseGuards } from '@nestjs/common';
import { FeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { FeatureFlagGuard } from '../../common/guards/feature-flag.guard';

// Whole controller
@FeatureFlag('shipment-templates')
@UseGuards(FeatureFlagGuard)
@Controller('shipment-templates')
export class ShipmentTemplatesController {}

// Single route
@FeatureFlag('ipfs-proofs')
@UseGuards(FeatureFlagGuard)
@Post(':id/proof')
submitProof() {}
```

When the flag is off the route answers **404**, not 403. A disabled endpoint
should be indistinguishable from one that does not exist; a 403 would confirm
the route is present and merely switched off, which leaks unreleased work.

**Unknown flags are off.** A flag that has never been set evaluates to false,
so new functionality stays dark until somebody turns it on deliberately. That
is the safe default for both a gradual rollout and a kill switch.

## Flag naming

One flag per shippable capability, named for the capability rather than the
ticket or the date.

- Lowercase `kebab-case`: `shipment-templates`, `ipfs-proofs`, `webhook-retries`
- Name the feature, not the mechanism: `saved-filters`, not `new-filter-code`
- No environment or date suffixes: use `ipfs-proofs`, not `ipfs-proofs-v2` or
  `ipfs-proofs-2026-08`
- Keep the name stable once it is live, since renaming a key silently reverts
  the flag to off for everyone

The Redis cache key is the flag name prefixed with `feature-flag:`, so
`shipment-templates` is cached at `feature-flag:shipment-templates`. The
database row is the source of truth; the Redis entry is only a cache.

## Flag shape

A flag is a record with the following fields:

```json
{
  "key": "shipment-templates",
  "enabled": true,
  "rolloutPercent": 25,
  "userIds": [],
  "orgIds": []
}
```

| Field | Type | Description |
| --- | --- | --- |
| `key` | `string` | Flag name (see [Flag naming](#flag-naming)). |
| `enabled` | `boolean` | Master switch. `false` is an unconditional kill switch regardless of `rolloutPercent` or targeting. |
| `rolloutPercent` | `number` (optional) | Percentage 0-100. Omitted or `100` means everyone. Values outside the range are clamped. |
| `userIds` | `string[]` (optional) | Users explicitly targeted by the flag. |
| `orgIds` | `string[]` (optional) | Organizations explicitly targeted by the flag. |

## Toggling a flag without a redeploy

Change the flag through the admin API (see [Admin API](#admin-api)). The
change is persisted, the Redis cache entry is invalidated, and the next
request picks it up; nothing needs restarting.

Because `enabled` is checked before `rolloutPercent` and targeting, setting
`enabled` to `false` is a complete stop even mid-rollout. It leaves the rollout
percentage and targeting lists in place, so flipping `enabled` back to `true`
resumes at the same configuration.

## Admin API

All endpoints require an admin caller.

### `GET /admin/feature-flags`

Lists every flag with its current configuration.

### `PATCH /admin/feature-flags`

Creates or updates a flag. The body carries the flag `key` plus any fields to
change; omitted fields keep their current values.

Turn a flag on for everyone:

```json
{ "key": "shipment-templates", "enabled": true }
```

Kill a misbehaving feature immediately:

```json
{ "key": "shipment-templates", "enabled": false }
```

Roll out to a quarter of users:

```json
{ "key": "shipment-templates", "enabled": true, "rolloutPercent": 25 }
```

Target specific users and organizations:

```json
{
  "key": "shipment-templates",
  "enabled": true,
  "userIds": ["usr_123"],
  "orgIds": ["org_456"]
}
```

## Targeting

A flag evaluates to `true` for a caller when `enabled` is `true` and any of the
following holds:

1. The caller's user id is in `userIds`.
2. The caller's organization id is in `orgIds`.
3. The caller falls inside `rolloutPercent` (see
   [Percentage rollouts](#percentage-rollouts)).

Explicit targeting is checked before the percentage bucket, so a targeted user
is always in regardless of the rollout percentage. An empty or omitted
`userIds`/`orgIds` matches nobody; it does not mean everyone.

## Percentage rollouts

A subject is bucketed 0-99 by hashing the flag name together with a stable
per-caller id, so:

- The same user always gets the same answer for the same flag. Nobody sees a
  feature appear and vanish between requests.
- Raising the percentage only ever adds users; nobody already in the rollout
  drops out.
- Being in the first 10% of one flag does not put a user in the first 10% of
  every other flag, because the flag name is part of the hash.

The subject is the authenticated user id, falling back to the Stellar address.
A percentage rollout therefore needs an authenticated caller: on an anonymous
request a percentage flag evaluates to **false**, rather than picking randomly
and flapping request to request. Gate anonymous routes with a plain boolean
flag instead.

## Caching and invalidation

Flag reads are served from Redis. Every write through the admin API
invalidates the affected cache entry (and the list cache) before returning, so
the next request re-reads the flag from the database. There is no in-process
cache, so every pod sees the change on its next request.

If a cache entry is missing, it is repopulated from the database on read. Do
not edit the `feature-flag:` keys by hand; write through the admin API so the
database and cache stay consistent.

## Audit logging

Every change made through the admin API is recorded in the audit log with the
acting admin, the flag key, and the before/after values. Use the audit trail to
answer who turned a flag on or off and when.

## Reading flags in a service

For logic that is not a whole route, inject the service:

```ts
constructor(private readonly featureFlags: FeatureFlagsService) {}

if (await this.featureFlags.isEnabled('webhook-retries', user.id)) {
  // new path
}
```

`FeatureFlagsModule` is global, so no import is needed in the consuming module.

The service also exposes `getFlag`, `setFlag`, `deleteFlag`, and `listFlags`
for administrative use. Administrative changes should go through the admin API
so they are audited and the cache is invalidated; `listFlags` uses `SCAN`, not
`KEYS`, so it is safe against the shared keyspace.

## Removing a flag

Once a feature is fully rolled out and the flag has been at 100% long enough to
trust:

1. Remove `@FeatureFlag()` and `FeatureFlagGuard` from the route.
2. Delete the flag through the admin API.

Delete the flag only after the code is deployed. Deleting it first turns the
feature off for everyone, since an unknown flag reads as false.
