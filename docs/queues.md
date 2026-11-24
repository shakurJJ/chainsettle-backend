# Background Queues (BullMQ)

Webhook delivery, email sending and shipment exports run on Redis-backed
[BullMQ](https://docs.bullmq.io/) queues instead of inside the request path
(#661). Work is persisted in Redis, so queued jobs survive an API restart, and
failed jobs are retried with exponential back-off.

## Queues

| Queue | Job | Producer | Worker |
|---|---|---|---|
| `webhooks` | `webhook-delivery` | `WebhooksService.dispatch()` (persists a `WebhookDelivery` row first) | `WebhookDeliveryProcessor` |
| `emails` | `send-email` | `NotificationsService.sendEmail()` | `EmailProcessor` |
| `exports` | `shipments-export` | `POST /api/v1/shipments/export` | `ShipmentsExportProcessor` |

Workers run in-process next to the API. Each feature owns its processor and
registers a worker with `QueueService.createWorker()` on module init; concurrency
comes from that queue's policy.

Every enqueue path keeps an in-process fallback. When `QUEUE_ENABLED=false`, or
Redis rejects a job, webhooks and email are delivered inline so a queue outage
does not silently drop notifications.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `QUEUE_ENABLED` | `true` | Set to `false` to disable BullMQ and use in-process delivery |
| `QUEUE_PREFIX` | `chainsettle` | Redis key prefix for all queues |
| `QUEUE_WEBHOOK_CONCURRENCY` | `10` | Webhook jobs processed concurrently per worker |
| `QUEUE_WEBHOOK_ATTEMPTS` | `5` | Total delivery attempts, including the first |
| `QUEUE_WEBHOOK_BACKOFF_MS` | `30000` | Base delay for exponential back-off |
| `QUEUE_EMAIL_CONCURRENCY` | `5` | Concurrent email jobs per worker |
| `QUEUE_EMAIL_ATTEMPTS` | `5` | Total send attempts |
| `QUEUE_EMAIL_BACKOFF_MS` | `5000` | Base delay for exponential back-off |
| `QUEUE_EXPORT_CONCURRENCY` | `2` | Concurrent export jobs per worker |
| `QUEUE_EXPORT_ATTEMPTS` | `3` | Total export attempts |
| `QUEUE_EXPORT_BACKOFF_MS` | `10000` | Base delay for exponential back-off |
| `EXPORT_RESULT_TTL_MS` | `3600000` | How long a finished export stays downloadable in Redis |

BullMQ delay for attempt _n_ is `backoffMs * 2^(n-1)`.

## Shipment exports

`GET /api/v1/shipments/export?format=csv|pdf` still streams synchronously for
backwards compatibility. The queued path is:

1. `POST /api/v1/shipments/export` with `{ "format": "csv" | "pdf" }` → `202`
   with `{ jobId, status: "queued" }`.
2. `GET /api/v1/shipments/export/:jobId` → job `state` (`waiting`, `active`,
   `completed`, `failed`, …) and result metadata once completed.
3. `GET /api/v1/shipments/export/:jobId/download` → the CSV/PDF file. Returns
   `409` while the job is still running and `404` if the result has expired.

A job is only readable by the user who requested it (admins may read any).

## Webhook retries

A delivery row is written before the job is enqueued, and the delivery id is
used as the BullMQ job id — enqueueing the same delivery twice is a no-op.

- Retryable failures (network errors, `429`, `5xx`) rethrow so BullMQ retries
  with back-off. The delivery row records `nextRetryAt` for visibility.
- Non-retryable failures (`4xx` other than `429`) and exhausted attempts set
  `permanentlyFailedAt`.
- The every-minute retry sweep only re-queues rows whose job was lost (for
  example after Redis was flushed); it does not duplicate a live delayed job.
- Manual retries (`POST .../deliveries/:id/retry`) reset the row and enqueue a
  fresh job.

## Metrics

Exposed on `/metrics` alongside the existing HTTP and job metrics:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `chainsettle_queue_depth` | gauge | `queue`, `state` | Jobs per queue in `waiting`, `active`, `delayed`, `failed`, `completed` |
| `chainsettle_queue_jobs_total` | counter | `queue`, `result` | Jobs finished by workers (`completed` / `failed`) |
| `chainsettle_queue_job_duration_seconds` | histogram | `queue` | Job processing duration |

A growing `waiting`/`delayed` series means the workers are falling behind; a
growing `failed` series means jobs are exhausting retries.

## Admin view

Both endpoints require an admin JWT:

- `GET /api/v1/admin/queues` — enabled flag, per-queue counts and the effective
  concurrency/retry policy.
- `GET /api/v1/admin/queues/:name/jobs?state=failed&limit=20` — recent jobs in a
  state, with attempts, timestamps and failure reason. `:name` is one of
  `webhooks`, `emails`, `exports`.
