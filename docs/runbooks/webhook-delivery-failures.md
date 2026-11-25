# Webhook Delivery Failures Runbook

## Overview

This runbook covers investigation and recovery when webhook deliveries fail: rising `permanently_failed` deliveries, `SYSTEM_ALERT` notifications, or endpoints that have been auto-disabled after repeated failures.

For failures related to the failed-events pipeline itself, see [failed-events.md](./failed-events.md).

---

## Symptoms

Watch for any of the following:

- **Rising `permanently_failed` deliveries** — the `retryStatus` of deliveries transitions to `permanently_failed` after retries are exhausted.
- **`SYSTEM_ALERT` notifications** — the system emits `SYSTEM_ALERT` notifications when delivery failure thresholds are crossed.
- **Endpoint auto-disabled** — a webhook endpoint's `WebhookEndpointStatus` is set to a disabled state automatically after sustained failures.

---

## Metrics and Logs to Check

### Metrics

Webhook delivery metrics are recorded via `MetricsService`. Check for:

- Delivery success/failure counters (per endpoint and per status).
- Retry attempt counts.
- `permanently_failed` delivery counts over time.

Query your metrics backend for the webhook delivery metric names exposed by `MetricsService` and look for spikes in failures or drops in success rate.

### Logs

Search application logs for the following log line prefixes:

- `[webhook]` — webhook delivery lifecycle events (attempts, responses, status transitions).
- `[retry]` — retry scheduling and retry attempt outcomes.

Example:

```bash
# Search for webhook and retry log lines for a specific endpoint
grep -E '\[webhook\]|\[retry\]' app.log | grep '<endpoint-id>'
```

Look for:

- Repeated non-2xx responses from the target provider (especially 5xx).
- Timeouts and connection errors.
- Retry exhaustion messages leading to `permanently_failed`.

---

## Step 1: Inspect the Webhook Endpoint

Retrieve the endpoint configuration and current status:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/v1/webhooks/$WEBHOOK_ID"
```

Check:

- `status` (`WebhookEndpointStatus`) — is the endpoint active or auto-disabled?
- The target URL and subscribed events.
- Any failure counters or metadata returned.

---

## Step 2: Inspect a Specific Delivery

Retrieve a delivery by ID to inspect its `retryStatus`:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/v1/webhooks/$WEBHOOK_ID/deliveries/$DELIVERY_ID"
```

The `retryStatus` field will be one of:

| `retryStatus`        | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `pending`            | Delivery queued, not yet attempted.                            |
| `pending_retry`      | A retry is scheduled; awaiting the next attempt.               |
| `permanently_failed` | Retries exhausted; delivery will not be retried automatically. |
| `succeeded`          | Delivery completed successfully.                               |

Inspect the recorded response status, error message, and attempt count to determine the root cause.

---

## Step 3: Manually Retry a Delivery

Trigger a manual retry for a specific delivery:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/v1/webhooks/$WEBHOOK_ID/deliveries/$DELIVERY_ID/retry"
```

Confirm the delivery's `retryStatus` transitions back to `pending`/`pending_retry` and then to `succeeded` after the attempt.

---

## Step 4: Re-enable an Auto-Disabled Webhook

If the endpoint was auto-disabled, verify the target provider is healthy (see Step 1 and logs) before re-enabling. Re-enable the endpoint by updating its status back to active via the webhook update endpoint:

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"active"}' \
  "$BASE_URL/api/v1/webhooks/$WEBHOOK_ID"
```

Confirm the returned `WebhookEndpointStatus` is active and that new deliveries begin succeeding.

---

## Step 5: Replay a Date Range

To recover deliveries that failed within a time window, use the admin replay endpoint:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"2024-01-01T00:00:00Z","to":"2024-01-02T00:00:00Z"}' \
  "$BASE_URL/api/v1/admin/webhooks/$WEBHOOK_ID/deliveries/replay"
```

The request body is a `ReplayDeliveriesDto`:

| Field  | Type              | Description                          |
| ------ | ----------------- | ------------------------------------ |
| `from` | ISO 8601 datetime | Start of the replay window (inclusive). |
| `to`   | ISO 8601 datetime | End of the replay window (inclusive).   |

After replay, re-inspect deliveries (Step 2) to confirm they reach `succeeded`.

---

## Escalation Criteria

Escalate to the platform/on-call engineering team if any of the following occur:

- **Multiple endpoints failing** simultaneously — suggests a systemic issue rather than a single provider outage.
- **Sustained 5xx responses from a provider** — the downstream provider is unhealthy and may need to be contacted.
- **Replay does not recover deliveries** — deliveries remain `permanently_failed` after a replay of the affected window.
- **Auto-disabled endpoints repeatedly re-disable** after being re-enabled.
- **`SYSTEM_ALERT` notifications continue** after the above steps have been applied.

When escalating, include:

- Affected webhook endpoint IDs and their `WebhookEndpointStatus`.
- Sample delivery IDs and their `retryStatus`.
- Relevant `[webhook]` and `[retry]` log excerpts.
- Metrics snapshots showing failure trends.
- The replay window used and its outcome.