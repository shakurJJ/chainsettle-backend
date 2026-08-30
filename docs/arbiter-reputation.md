# Arbiter Reputation

ChainSettle tracks a lightweight reputation summary for every arbiter, derived entirely from milestone dispute history. This doc explains what each field means, how it's computed, and how the underlying cache is kept fresh.

Source: `ArbitersService` in [`src/modules/arbiters/arbiters.service.ts`](../src/modules/arbiters/arbiters.service.ts).

---

## Reading the reputation summary

```
GET /api/v1/arbiters/:address/reputation
```

```json
{
  "arbiterAddress": "GABC...",
  "disputesHandled": 12,
  "disputesOpen": 1,
  "averageResolutionTimeHours": 18.42,
  "hasHistory": true,
  "computedAt": "2026-08-30T06:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `arbiterAddress` | Stellar Ed25519 public key of the arbiter this summary is for. |
| `disputesHandled` | Count of milestones assigned to this arbiter that reached `RESOLVED` status. This is the arbiter's completed-dispute count. |
| `disputesOpen` | Count of milestones currently in `DISPUTED` status where this arbiter is the assigned arbiter — i.e. work still awaiting resolution. |
| `averageResolutionTimeHours` | Mean time, in hours, from dispute start to resolution across all `RESOLVED` milestones (see below for how "start" and "resolution" are defined). `null` when there is no resolved history yet. Rounded to 2 decimal places. |
| `hasHistory` | `true` if the arbiter has at least one `DISPUTED` or `RESOLVED` milestone ever recorded against them. `false` for an arbiter who has never been escalated to. |
| `computedAt` | ISO-8601 timestamp of when this snapshot was computed (not necessarily "now" — see [Cache & refresh cadence](#cache--refresh-cadence)). |

Only milestones with status `DISPUTED` or `RESOLVED` are considered; milestones that were confirmed without ever being disputed play no part in the score.

## How resolution time is measured

For each `RESOLVED` milestone with a `confirmedAt` timestamp, the resolution duration is:

```
resolutionTime = confirmedAt − startPoint
```

where `startPoint` is:

- `disputeEscalatedAt` when it is set (the milestone actually went through the dispute-escalation flow), otherwise
- `createdAt` (fallback for older/edge-case records where the escalation timestamp was never recorded)

`averageResolutionTimeHours` is the mean of all such durations, in hours, across every resolved milestone for the arbiter. Any computed duration that comes out negative (clock skew, bad data) is dropped from the average rather than skewing it.

## "No history" fallback behaviour

An arbiter who has never had a milestone escalated to them (no `DISPUTED` or `RESOLVED` milestones) gets a **neutral, non-error** response:

```json
{
  "arbiterAddress": "GXYZ...",
  "disputesHandled": 0,
  "disputesOpen": 0,
  "averageResolutionTimeHours": null,
  "hasHistory": false,
  "computedAt": "2026-08-30T06:00:00.000Z"
}
```

This is intentional — a brand-new arbiter should never surface as a 404 or an error in arbiter-selection UI; they should simply show as having no track record yet (`hasHistory: false`).

`GET /api/v1/arbiters/:address/history` behaves the same way: it returns an empty paginated page (`data: [], meta.total: 0`) rather than an error when the arbiter has no dispute history.

## Cache & refresh cadence

Reputation is expensive to compute at request time (it scans milestone history), so it's precomputed on a schedule rather than live on every read:

- **`ArbiterReputationJob`** ([`src/modules/arbiters/arbiter-reputation.job.ts`](../src/modules/arbiters/arbiter-reputation.job.ts)) runs on a cron schedule of **`0 */6 * * *`** — every 6 hours, on the hour (00:00, 06:00, 12:00, 18:00 UTC). It lists every distinct arbiter address that has ever been assigned to a shipment (`listKnownArbiterAddresses()`) and recomputes + caches each one's reputation in turn, logging (but not failing the whole run on) any per-arbiter error.
- Recomputed snapshots are cached in Redis under key `arbiter:reputation:<address>` with a **7-day TTL**. The long TTL is a safety net against stale-forever caching if the cron job stops running — it is not the expected refresh interval. In normal operation, the cache is overwritten every 6 hours by the job well before it would expire.
- `GET /arbiters/:address/reputation` (`getReputation()`) reads the cache first. On a cache miss (new arbiter, cache evicted, or Redis flushed) it **falls back to computing the reputation live**, on that request, so the endpoint never errors due to a cold cache — it just costs one on-demand computation.
- Nothing besides the cron job normally triggers a recompute. The one exception is the admin endpoint below, for on-demand refreshes outside the 6-hour cadence.

### Forcing an out-of-cycle recompute

```
POST /api/v1/admin/arbiters/:address/reputation/recompute
```

Admin-only (`@Roles(UserRole.ADMIN)`). Synchronously recomputes and re-caches one arbiter's reputation immediately, bypassing the 6-hour cron cadence, and returns the fresh snapshot. Useful right after resolving a batch of disputes when you don't want to wait for the next scheduled run.

`GET /api/v1/admin/arbiters` lists every known arbiter with its current cached reputation (not force-recomputed), optionally sorted via `?sortBy=disputesHandled|disputesOpen|averageResolutionTimeHours`.
