# Announcements and Maintenance Mode

This guide is for platform operators and administrators. It covers two related
operational features:

- **Announcements** — banners that are shown to users of the platform, with
  severities, role targeting, scheduling and per-user dismissal.
- **Maintenance mode** — a safe way to block state-changing writes while
  keeping the platform observable and readable during maintenance windows.

---

## Announcements

Announcements are managed by admins and surfaced to clients through a
dedicated read endpoint. Each announcement has a severity, an optional set of
target roles, an optional schedule, and can be dismissed per user.

### Severities

Announcements support three severities:

| Severity   | Intended use                                                        |
| ---------- | ------------------------------------------------------------------- |
| `INFO`     | General information, tips, non-urgent notices.                      |
| `WARNING`  | Degraded functionality, upcoming changes, action recommended.       |
| `CRITICAL` | Outages, security notices, urgent action required.                  |

When multiple announcements are active, clients should display them in
**priority order: `CRITICAL` → `WARNING` → `INFO`**. The most severe
announcements should be shown first (and, if the UI only has room for one
banner, the highest-severity announcement wins).

### Targeting

Targeting is controlled by the `audienceRoles` field:

- **Empty array (or omitted)** — the announcement is shown to **all roles**.
- **Non-empty array** — the announcement is shown **only to users whose role
  matches one of the listed `UserRole` values**.

Use targeting to reach specific audiences (for example, only `ADMIN` users, or
only a subset of operational roles) without exposing the message to everyone.

### Scheduling

Each announcement can be scheduled with two optional timestamps:

- `startsAt` — when the announcement becomes active. **Defaults to now** if
  omitted.
- `endsAt` — when the announcement stops being active. **`null` means it never
  expires.**

If `endsAt` is provided it **must be after `startsAt`**, otherwise the API
rejects the request with **HTTP 400**.

### Dismissal

Users dismiss an announcement for themselves with:

```
POST /announcements/:id/dismiss
```

Dismissal is:

- **Per-user** — dismissing an announcement only affects the calling user.
- **Idempotent** — calling dismiss repeatedly for the same announcement is
  safe and has no additional effect.

### Client endpoint

Clients fetch the announcements they should currently see via:

```
GET /announcements/active
```

This endpoint returns only announcements that are:

- **not dismissed** by the calling user,
- **role-matching** (the user's role is in `audienceRoles`, or
  `audienceRoles` is empty), and
- **currently active** (between `startsAt` and `endsAt`, where `endsAt` may be
  `null`).

Clients should render the returned announcements in severity priority order
(`CRITICAL` → `WARNING` → `INFO`).

### Admin API

All admin announcement endpoints require an **`ADMIN` JWT** (send it in the
`Authorization: Bearer <token>` header). The examples below assume:

```bash
export API=https://api.example.com/api/v1
export TOKEN="<admin-jwt>"
```

#### Create an announcement

```bash
curl -X POST "$API/admin/announcements" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Scheduled maintenance",
    "body": "The platform will be read-only on Saturday 02:00–04:00 UTC.",
    "severity": "CRITICAL",
    "audienceRoles": [],
    "startsAt": "2025-01-10T00:00:00Z",
    "endsAt": "2025-01-11T06:00:00Z"
  }'
```

To target specific roles, set `audienceRoles`:

```bash
curl -X POST "$API/admin/announcements" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Admin action required",
    "body": "Rotate API keys before the end of the month.",
    "severity": "WARNING",
    "audienceRoles": ["ADMIN"]
  }'
```

Omit `startsAt` to start immediately, and set `endsAt` to `null` (or omit it)
for an announcement that never expires.

#### List announcements

```bash
curl "$API/admin/announcements?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

#### Get a single announcement

```bash
curl "$API/admin/announcements/<id>" \
  -H "Authorization: Bearer $TOKEN"
```

#### Update an announcement

```bash
curl -X PATCH "$API/admin/announcements/<id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "severity": "WARNING",
    "endsAt": "2025-01-11T12:00:00Z"
  }'
```

#### Delete an announcement

```bash
curl -X DELETE "$API/admin/announcements/<id>" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Maintenance mode

Maintenance mode lets operators **safely block state-changing writes** while
keeping the platform observable and readable. Use it during migrations,
data backfills, or any operation that must not race with user writes.

### Enabling and disabling

Maintenance mode is controlled by configuration / a feature flag. Depending on
how your deployment is configured, you can:

- **Toggle at runtime** (if the runtime toggle is enabled in your
  configuration), or
- **Set the flag in configuration and restart** the affected services.

Follow your deployment's standard procedure for changing configuration. When
enabled, the platform enters maintenance mode; when disabled, normal write
traffic resumes.

### What maintenance mode blocks

- **Writes and state-changing endpoints** — create, update and delete
  operations (and any other endpoint that mutates state) are rejected while
  maintenance mode is active.

### What remains available

- **Health checks** — liveness and readiness probes continue to respond so
  orchestrators and load balancers can track the instance.
- **Reads** — read-only endpoints remain available so users and dashboards can
  still inspect data.

### Client handling of `503` responses

While maintenance mode is active, blocked requests receive **HTTP `503
Service Unavailable`**. The response body follows **RFC 9457
`application/problem+json`**, produced by the shared `HttpExceptionFilter`.

The problem document includes:

| Field      | Meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| `type`     | A URI identifying the problem type.                            |
| `title`    | A short, human-readable summary of the problem.                |
| `status`   | The HTTP status code (`503`).                                  |
| `detail`   | A human-readable explanation specific to this occurrence.      |
| `instance` | A URI reference identifying this specific occurrence.          |
| `code`     | A machine-readable application error code.                     |

For backward compatibility, the body also includes the legacy fields
`success`, `statusCode`, `timestamp`, `path` and `message`.

A `Retry-After` header is included on these responses and is **exposed via
CORS**, so browser clients can read it.

Clients should:

1. Detect `503` responses on write operations.
2. Read the `Retry-After` header (exposed via CORS) to decide when to retry.
3. Surface the `detail`/`message` from the problem document to the user,
   indicating the platform is temporarily read-only.
4. Retry the write after the indicated delay, or once maintenance mode is
   disabled.

Example problem response:

```json
{
  "type": "about:blank",
  "title": "Service Unavailable",
  "status": 503,
  "detail": "The platform is in maintenance mode. Writes are temporarily disabled.",
  "instance": "/api/v1/items",
  "code": "MAINTENANCE_MODE",
  "success": false,
  "statusCode": 503,
  "timestamp": "2025-01-10T02:00:00.000Z",
  "path": "/api/v1/items",
  "message": "The platform is in maintenance mode. Writes are temporarily disabled."
}
```

---

## Recommended maintenance checklist

1. **Announce ahead of time** — post a `CRITICAL` banner describing the
   maintenance window (start and end times) so users can plan.
2. **Verify health/ready** — confirm all instances report healthy on their
   liveness and readiness probes before starting.
3. **Drain traffic** — remove instances from the load balancer / shift traffic
   away from the services being maintained.
4. **Enable maintenance mode** — turn on the maintenance flag so writes are
   blocked while reads and health checks continue.
5. **Run migrations** — perform schema changes, backfills or other
   state-changing operations.
6. **Smoke test** — verify reads, health checks and a representative write
   path behave as expected.
7. **Disable maintenance mode** — turn the flag off and confirm writes are
   accepted again.
8. **Post-completion `INFO` banner** — let users know maintenance is complete
   (and remove or expire the earlier `CRITICAL` banner).
9. **Monitor error rates** — watch `503` rates, latency and error dashboards
   for a period after completion to catch regressions early.

---

_See also: the deployment guide for how to configure feature flags and
maintenance mode in your environment._