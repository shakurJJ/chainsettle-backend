# Feature Flags

Feature flags gate new functionality so it can be released gradually, tested
internally, or switched off in production without a deploy.

Flags live in Redis, which the app already runs for the nonce store and
throttling. They are read on every request with no in-process cache, so a
change takes effect on the next request across every pod.

## Contents

- [Gating a route](#gating-a-route)
- [Flag naming](#flag-naming)
- [Flag shape](#flag-shape)
- [Toggling a flag without a redeploy](#toggling-a-flag-without-a-redeploy)
- [Percentage rollouts](#percentage-rollouts)
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

The Redis key is the flag name prefixed with `feature-flag:`, so
`shipment-templates` is stored at `feature-flag:shipment-templates`.

## Flag shape

The value is a small JSON document:

```json
{ "enabled": true, "rollout": 25 }
```

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | `boolean` | Master switch. `false` is an unconditional kill switch regardless of `rollout`. |
| `rollout` | `number` (optional) | Percentage 0-100. Omitted or `100` means everyone. Values outside the range are clamped. |

## Toggling a flag without a redeploy

Set the key. The next request picks it up; nothing needs restarting.

Turn a flag on for everyone:

```
SET feature-flag:shipment-templates {"enabled":true}
```

Kill a misbehaving feature immediately:

```
SET feature-flag:shipment-templates {"enabled":false}
```

Roll out to a quarter of users:

```
SET feature-flag:shipment-templates {"enabled":true,"rollout":25}
```

Inspect the current value:

```
GET feature-flag:shipment-templates
```

From a shell, the same via `redis-cli`:

```bash
redis-cli SET feature-flag:shipment-templates '{"enabled":true,"rollout":25}'
```

Because `enabled` is checked before `rollout`, setting `enabled` to `false` is
a complete stop even mid-rollout. It leaves the rollout percentage in place, so
flipping `enabled` back to `true` resumes at the same percentage.

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
for administrative use. `listFlags` uses `SCAN`, not `KEYS`, so it is safe
against the shared keyspace.

## Removing a flag

Once a feature is fully rolled out and the flag has been at 100% long enough to
trust:

1. Remove `@FeatureFlag()` and `FeatureFlagGuard` from the route.
2. Delete the key: `DEL feature-flag:shipment-templates`.

Delete the key only after the code is deployed. Deleting it first turns the
feature off for everyone, since an unknown flag reads as false.
