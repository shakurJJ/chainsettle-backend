# Runbook — Failed Event Dead-Letter Queue (DLQ)

**Audience:** on-call engineers and platform operators  
**Trigger:** DLQ size is growing, an admin `SYSTEM_ALERT` notification has fired, or the
`chainsettle_events_failed_total` counter is rising unexpectedly.

---

## Background

The ChainSettle backend polls the Stellar RPC for on-chain contract events every second. Each
event is dispatched to a handler that updates the database (shipments, milestones) and sends
notifications. When a handler throws, the event is written to the **`failed_events` table**
(the dead-letter queue) instead of being silently dropped.

### DLQ record fields

| Field | Meaning |
|---|---|
| `id` | UUID primary key — use this in retry and detail API calls |
| `eventName` | Stellar contract topic from the event's first topic element, e.g. `proof_submitted`, `milestone_confirmed`, `dispute_raised`, `shipment_cancelled`, `unknown` |
| `ledger` | Stellar ledger sequence number the event appeared in |
| `txHash` | Soroban transaction hash; unique together with `eventName` (same tx+event never creates duplicate rows) |
| `payload` | Raw decoded event value as stored on-chain |
| `error` | `.message` of the last exception that caused this event to fail |
| `attemptCount` | Total number of processing attempts so far, starting at `1` |
| `lastAttemptAt` | Timestamp of the most recent attempt (initial or retry) |
| `resolvedAt` | `null` while unresolved; set to the resolution timestamp on success |
| `createdAt` | When the event was first moved to the DLQ |

### Automatic retry schedule

The poller retries unresolved events (where `resolvedAt IS NULL AND attemptCount < 5`) every
minute using exponential back-off. A record is only eligible for the next attempt once this
window has elapsed since `lastAttemptAt`:

| Attempt # | Back-off (min since previous attempt) |
|---|---|
| 2 | 1 min |
| 3 | 2 min |
| 4 | 4 min |
| 5 | 8 min |

After 5 failed attempts the cron stops retrying automatically and fires a `SYSTEM_ALERT`
notification to all `ADMIN` users. Manual intervention is then required.

Only the instance that holds the Redis leader lock runs the retry cron — this prevents
duplicate side-effects in blue/green or multi-replica deployments.

---

## Step-by-step triage

### Step 1 — check poller health and lag

Before looking at individual failures, confirm the poller is running and not falling behind
the chain.

```
GET /api/v1/events/admin/cursor
Authorization: Bearer <admin-jwt>
```

Example response:

```json
{
  "inMemoryLedger": 54400,
  "persistedLedger": 54399,
  "chainTip": 54450,
  "lag": 50,
  "updatedAt": "2026-09-29T14:05:00.000Z",
  "healthy": true,
  "isPollerLeader": true
}
```

| Signal | What it means |
|---|---|
| `healthy: false` (`lag > 100`) | The poller is more than 100 ledgers behind the chain tip. It may have stalled, lost the leader lock, or be processing a large backlog of events. |
| `isPollerLeader: false` | This pod does not hold the leader lock. Either another pod is the leader (normal in multi-replica), or no pod holds the lock (abnormal). |
| `inMemoryLedger` ≠ `persistedLedger` | The cursor DB write is failing. The poller keeps running from memory but a restart will re-process events from `persistedLedger`. Watch the logs for `Cursor DB write failed`. |
| `chainTip: 0` or error | The Stellar RPC is unreachable. See [Scenario A](#scenario-a-stellar-rpc-timeout-or-network-error) below. |

> **Healthy poller with growing DLQ** usually means a systematic data problem (missing
> shipment, wrong status) rather than an infrastructure outage — skip to Step 3.

---

### Step 2 — list unresolved DLQ events

```
GET /api/v1/events/admin/failed-events?page=1&limit=50
Authorization: Bearer <admin-jwt>
```

Response:

```json
{
  "data": [
    {
      "id": "3f8a1b2c-...",
      "eventName": "proof_submitted",
      "ledger": 54321,
      "txHash": "abc123...",
      "payload": ["SHIP-001", 2],
      "error": "Milestone 2 not found on shipment SHIP-001",
      "attemptCount": 3,
      "lastAttemptAt": "2026-09-29T14:10:00.000Z",
      "resolvedAt": null,
      "createdAt": "2026-09-29T14:00:00.000Z"
    }
  ],
  "meta": { "total": 7, "page": 1, "limit": 50, "totalPages": 1 }
}
```

Look for patterns in the `error` and `eventName` fields:

- Same `error` text across many records → systematic root cause.
- Same `eventName` failing → the handler for that event type has a bug or the on-chain
  contract emits a payload shape the backend does not expect.
- Scattered errors across many event types → likely an RPC or DB connectivity issue.

The `total` in `meta` is the current open DLQ depth. Use `chainsettle_events_failed_total`
in Prometheus for the cumulative rate.

---

### Step 3 — inspect a specific event

For any event you want to investigate:

```
GET /api/v1/events/admin/failed-events/:id
Authorization: Bearer <admin-jwt>
```

The full `payload` field shows exactly what the contract emitted. Cross-reference it with the
relevant shipment or milestone in the database to understand why the handler failed.

---

### Step 4 — resolve the root cause, then retry

Once you have identified and fixed (or confirmed) the root cause, manually trigger a retry:

```
POST /api/v1/events/admin/failed-events/:id/retry
Authorization: Bearer <admin-jwt>
```

HTTP 200 response on success:

```json
{ "message": "Failed event <id> retried and resolved successfully" }
```

On success the `resolvedAt` field is set and the event no longer appears in the list
endpoint. On failure the endpoint returns 500 — the error is not written back to the DLQ and
`attemptCount` is not incremented; you can retry as many times as needed once the underlying
problem is fixed.

> **Note:** the manual retry re-runs the handler directly. It does not reset `attemptCount`,
> does not check the back-off window, and works even if `attemptCount >= 5`.

---

## Common failure scenarios

### Scenario A — Stellar RPC timeout or network error

**Typical `error` values:**

```
connect ECONNREFUSED 1.2.3.4:8000
connect ETIMEDOUT
Failed to fetch events from ledger 54321
Contract simulation error: ...
```

**What happens:** `syncStatusFromChain` or `simulateContractCall` inside a handler calls the
Stellar RPC, which is temporarily unreachable. The handler throws, the event goes to the DLQ,
and the automatic back-off retry will attempt it again once the RPC recovers.

**Triage:**

1. Check `GET /api/v1/events/admin/cursor` — if `chainTip: 0` or the endpoint itself times
   out, the RPC is down.
2. Verify connectivity from the pod:
   ```bash
   curl https://soroban-testnet.stellar.org/health
   # expected: {"status":"healthy"}
   ```
3. Check `STELLAR_RPC_URL` in the running config; confirm it matches the deployed network.
4. If the outage was brief, the automatic cron retry will clear these events as the back-off
   windows expire. Monitor `chainsettle_events_failed_total` to confirm the rate drops.
5. If the RPC is back but events are still failing, retry manually via the API.

**Do not retry** while the RPC is still down — you will only increment `attemptCount` and
consume your retry budget.

---

### Scenario B — shipment or milestone not found

**Typical `error` values:**

```
Shipment SHIP-001 not found
Milestone 2 not found on shipment SHIP-001
```

**What happens:** An on-chain event (e.g. `proof_submitted`, `milestone_confirmed`,
`dispute_raised`) references a shipment ID or milestone index that does not exist in the
database. This usually means:

- The `POST /api/v1/shipments` call that creates the DB record was never made before the
  chain event arrived (race condition during high-throughput bulk imports).
- The shipment was created on a different contract deployment (`CHAINSETTTLE_CONTRACT_ID`)
  than the one currently configured.
- A milestone index was passed incorrectly from the front-end when creating the shipment.

**Triage:**

1. Note the `payload` field from the detail endpoint — it contains the `shipmentId` and
   `milestoneIndex`.
2. Check whether the shipment row exists:
   ```
   GET /api/v1/shipments/:shipmentId
   ```
3. **If the shipment is missing:** create it via the normal API path
   (`POST /api/v1/shipments`) or restore it from the archived-shipments table if it was
   inadvertently archived. Then retry the failed event.
4. **If the milestone is missing:** the shipment may have been created with a different
   milestone count than the contract expects. Add the missing milestone(s) or investigate the
   contract deployment for inconsistency.
5. After the DB record exists, retry:
   ```
   POST /api/v1/events/admin/failed-events/:id/retry
   ```

---

### Scenario C — event payload decode error

**Typical `error` values:**

```
Cannot read properties of undefined (reading '0')
payload.map is not a function
Unexpected token in JSON at position 0
```

**What happens:** The handler for a specific `eventName` expects the `payload` to be an array
(`[shipmentId, milestoneIndex]`) or a particular shape, but the contract emitted something
different. This can happen after a contract upgrade changes the event schema without a
corresponding backend update.

**Triage:**

1. Fetch the event detail and inspect `payload` carefully:
   ```
   GET /api/v1/events/admin/failed-events/:id
   ```
2. Compare the payload structure to what the handler expects (see `executeHandler` and the
   `handle*` methods in `src/modules/events/events.service.ts`).
3. If this is a contract upgrade: the backend handler needs a code change to match the new
   schema. Deploy the fix first, then retry the DLQ events.
4. If the payload looks valid and the error is intermittent: check whether a prior schema
   migration changed a related table column type and a Prisma type mismatch is causing the
   cast to fail.

---

### Scenario D — duplicate / already-processed status

**Typical `error` values:**

```
Cannot submit proof: shipment SHIP-001 is CANCELLED
Milestone 2 is not currently disputed
Unique constraint failed on the fields: (`txHash`,`eventName`)
```

**What happens:** The handler tries to apply a state transition to a record that is already in
a terminal or incompatible state. This is typically safe — the chain event has already been
applied (possibly via the REST API before the on-chain event arrived), and the DLQ entry is a
false alarm.

**Triage:**

1. Check the current state of the relevant shipment/milestone via the API.
2. If the state is already correct (the intended transition already happened), simply mark
   the DLQ event as resolved — since the retry endpoint writes `resolvedAt` on success you
   can choose to **not** retry and instead manually update the record if that is appropriate,
   or just retry and accept the 500 knowing the state is fine.
3. If retrying and the handler is idempotent for this state (e.g., it guards with an
   `if (existing?.status === 'CONFIRMED') return;` check), the retry will succeed silently.
   These events often self-resolve on the next automatic retry.

---

## Escalate when

- `lag` on `GET /events/admin/cursor` is consistently above 500 ledgers and not recovering
  after the RPC comes back.
- `attemptCount` has reached 5 on more than ~10% of the total DLQ and the root cause is not
  yet identified — the admin `SYSTEM_ALERT` notifications are the first signal; check the
  notifications inbox or set up a Slack webhook to forward them.
- `isPollerLeader: false` on **all** running pods simultaneously (check all instances) —
  this means no pod holds the Redis leader lock and event processing has stalled completely.
  Restart the service or force a Redis key expiry.
- The DLQ is growing faster than it is being resolved and the back-off retries are not
  catching up — consider pausing the automatic retry cron (by setting `EVENT_POLLING_INTERVAL_MS`
  to a very large value temporarily) while you investigate the root cause.

---

## Quick reference

| Task | Command |
|---|---|
| Check poller health | `GET /api/v1/events/admin/cursor` |
| List open DLQ events | `GET /api/v1/events/admin/failed-events?page=1&limit=50` |
| Inspect one event | `GET /api/v1/events/admin/failed-events/:id` |
| Retry one event | `POST /api/v1/events/admin/failed-events/:id/retry` |
| DLQ rate metric | `increase(chainsettle_events_failed_total[5m])` |
| Processed rate metric | `rate(chainsettle_events_processed_total[1m])` |

**Related source files:**
- Event processing and DLQ logic: `src/modules/events/events.service.ts`
- Admin HTTP endpoints: `src/modules/events/events.controller.ts`
- Stellar RPC client: `src/common/stellar/stellar.service.ts`
- Metrics definitions: `src/common/metrics/metrics.service.ts`
