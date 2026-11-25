# Recurring Schedules

Recurring schedules let you automatically create shipments from a shipment template on a fixed interval. Each schedule references a template and defines when the next shipment should be drafted. This document covers the supported intervals, how `nextRunAt` is computed, what happens when a run fails, and the full set of endpoints available in `RecurringSchedulesController`.

For information about the templates that schedules are built from, see the [Shipment Templates documentation](./shipment-templates.md).

## Overview

A recurring schedule ties a **template** to a **cadence**. On each run, the background job looks for schedules whose `nextRunAt` has passed and creates a new shipment draft from the referenced template. After a successful creation, the schedule's `nextRunAt` is advanced by one interval.

## Supported intervals

| Interval  | Description |
|-----------|-------------|
| `WEEKLY`  | Advances `nextRunAt` by 7 days. |
| `MONTHLY` | Advances `nextRunAt` by one calendar month. |

### Month-end clamping

`MONTHLY` schedules use an `advance()` helper that clamps to the last valid day of the target month. This avoids the common pitfall where advancing from the 31st of a month would overflow into the following month.

Examples:

- A schedule on **January 31** advances to **February 28** (or **February 29** in a leap year).
- A schedule on **March 31** advances to **April 30**.
- A schedule on **May 15** advances to **June 15** (no clamping needed).

Because clamping is applied each time, a schedule created on the 31st will drift to the last day of shorter months and then return to the 31st in months that have one.

## How `nextRunAt` is computed

When a schedule is created, `nextRunAt` is determined as follows:

1. If you provide an explicit `nextRunAt`, it is used as-is.
2. Otherwise, if you provide a `startAt`, it is used as the first run time.
3. Otherwise, `nextRunAt` defaults to **one interval from now** (e.g. one week from now for `WEEKLY`, one month from now for `MONTHLY`).

Any provided `startAt` or `nextRunAt` **must be in the future**. A value in the past is rejected with a validation error.

### Missed intervals

The job does **not** attempt to "catch up" by creating one draft per missed interval. If the service is down for a long period (for example, a multi-week outage), the next run advances `nextRunAt` past all missed intervals and creates **a single catch-up draft**. This keeps the number of drafts predictable and avoids flooding the account with backdated shipments.

## What happens when a run fails

Failures are handled defensively so that a single bad schedule cannot block the rest of the batch:

- **Template deleted:** If the referenced template no longer exists, the schedule is **deactivated** (`active` is set to `false`) so it is skipped on subsequent runs.
- **Per-schedule errors:** Any other error while creating a draft is **logged** for that schedule only. The schedule remains active and is **retried on the next run**.
- **Exactly one draft per run:** A Redis lock combined with a compare-and-set on `nextRunAt` guarantees that each schedule produces **exactly one draft per run**, even if multiple job workers execute concurrently. A worker only advances `nextRunAt` if it still matches the value it read, so duplicate drafts are prevented.

## The job schedule

The recurring-schedule job runs on a fixed cadence:

| Setting    | Value |
|------------|-------|
| Cron       | Every 5 minutes |
| Batch size | 50 schedules per run |
| Lock TTL   | 4 minutes |

The lock TTL is shorter than the cron interval so that a crashed worker's lock expires before the next run begins, while still being long enough to cover a normal batch.

## Endpoints

All endpoints are served by `RecurringSchedulesController`.

### Create a schedule — `POST /recurring-schedules`

Creates a new recurring schedule from a template.

**Request body:**

```json
{
  "templateId": "tpl_123",
  "interval": "MONTHLY",
  "startAt": "2025-02-01T09:00:00Z"
}
```

All fields except `templateId` and `interval` are optional. Omit `startAt` and `nextRunAt` to default to one interval from now.

**Response:**

```json
{
  "id": "rec_456",
  "templateId": "tpl_123",
  "interval": "MONTHLY",
  "active": true,
  "nextRunAt": "2025-02-01T09:00:00Z",
  "createdAt": "2025-01-15T12:00:00Z"
}
```

### List schedules — `GET /recurring-schedules`

Returns the schedules for the current account. Supports filtering by `active` and by `templateId`.

**Example:**

```
GET /recurring-schedules?active=true&templateId=tpl_123
```

**Response:**

```json
{
  "data": [
    {
      "id": "rec_456",
      "templateId": "tpl_123",
      "interval": "MONTHLY",
      "active": true,
      "nextRunAt": "2025-02-01T09:00:00Z"
    }
  ]
}
```

### Update a schedule — `PATCH /recurring-schedules/:id`

Updates a schedule. You can change the `interval`, set a new `nextRunAt`, or pause/resume the schedule with `active`.

**Example — change the interval:**

```json
{
  "interval": "WEEKLY"
}
```

**Example — pause a schedule:**

```json
{
  "active": false
}
```

Setting `active: false` pauses the schedule; the job will skip it until it is reactivated with `active: true`. Any new `nextRunAt` you supply must be in the future.

**Response:**

```json
{
  "id": "rec_456",
  "templateId": "tpl_123",
  "interval": "WEEKLY",
  "active": false,
  "nextRunAt": "2025-02-08T09:00:00Z"
}
```

### Delete a schedule — `DELETE /recurring-schedules/:id`

Deletes a schedule. Shipments already created from the schedule are not affected.

**Response:** `204 No Content`

## Related documentation

- [Shipment Templates](./shipment-templates.md) — the templates that recurring schedules are built from.