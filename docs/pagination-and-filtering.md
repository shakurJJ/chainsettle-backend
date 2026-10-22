# Pagination and Filtering

ChainSettle list endpoints support both **offset-based** and **cursor-based** pagination to balance simplicity with performance on large datasets. This document explains both approaches, common filters, and how to use them together.

---

## PaginatedResponseDto

Every paginated list endpoint wraps results in a consistent response structure with two fields:

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `data` | Array | Array of items for the current page |
| `meta` | Object | Pagination metadata (see sections below) |

### Offset Pagination Meta

When using page/limit (offset-based), `meta` contains:

| Field | Type | Description |
|-------|------|-------------|
| `page` | number | Current page number (1-indexed) |
| `limit` | number | Items returned per page (requested by client) |
| `total` | number | Total matching records (across all pages) |
| `totalPages` | number | Total number of pages (ceil(total / limit)) |
| `nextCursor` | null | Always null for offset pagination |

### Cursor Pagination Meta

When using cursor, `meta` contains:

| Field | Type | Description |
|-------|------|-------------|
| `limit` | number | Items returned per page |
| `nextCursor` | string \| null | Opaque base64 cursor for the next page, or null if no more data |

---

## Offset Pagination (page/limit)

**Offset pagination** uses explicit page and limit parameters. It's simple to implement and allows clients to jump to any page.

### Default behavior

- **Default page:** 1 (1-indexed)
- **Default limit:** 20 items per page
- **Maximum limit:** Usually 100 (varies by endpoint; check `@Max()` in the query DTO)

### Query parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | number | No | Page number, starting at 1. Defaults to 1. |
| `limit` | number | No | Items per page. Defaults to 20; max varies by endpoint. |

### Example request

```http
GET /api/v1/shipments?page=2&limit=20
Authorization: Bearer <token>
```

### Example response

```json
{
  "data": [
    {
      "id": "ship_456",
      "status": "DELIVERY",
      "totalAmount": "1500.00",
      "createdAt": "2026-02-15T10:30:00Z"
    },
    {
      "id": "ship_457",
      "status": "DRAFT",
      "totalAmount": "2000.00",
      "createdAt": "2026-02-14T09:15:00Z"
    }
  ],
  "meta": {
    "page": 2,
    "limit": 20,
    "total": 156,
    "totalPages": 8,
    "nextCursor": null
  }
}
```

### When to use offset pagination

- You need to jump to a specific page (e.g., page 3)
- The result set is small or stable (< 100k records)
- You're paginating in a UI with explicit page numbers

---

## Cursor Pagination (cursor)

**Cursor pagination** uses an opaque cursor token to retrieve the next batch of results. It's more efficient for large datasets and prevents issues when data is being added/removed during pagination (cursor-based fetches are stable even if records change between requests).

### How it works

1. Client calls the endpoint without `cursor` parameter
2. Server returns results and includes a `nextCursor` in the response meta (if more data exists)
3. Client passes `nextCursor` on the next request to fetch the next batch
4. Repeat until `nextCursor` is null

### Query parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cursor` | string | No | Opaque base64-encoded cursor. Omit on first request. |
| `limit` | number | No | Items per page. Defaults to 20; max varies by endpoint. |

### Cursor format

The cursor is an opaque base64-encoded token; clients must treat it as a string and not parse it. For reference, the internal format is base64(JSON), containing the `id` and `createdAt` of the last item in the previous page, used for efficient keyset pagination.

### Example request (first page)

```http
GET /api/v1/auth/login-history?limit=10
Authorization: Bearer <token>
```

### Example response (first page)

```json
{
  "data": [
    {
      "id": "login_1",
      "userAgent": "Mozilla/5.0...",
      "ipAddress": "203.0.113.42",
      "createdAt": "2026-02-20T14:30:00Z"
    },
    {
      "id": "login_2",
      "userAgent": "curl/7.68.0",
      "ipAddress": "198.51.100.1",
      "createdAt": "2026-02-20T13:25:00Z"
    }
  ],
  "meta": {
    "limit": 10,
    "nextCursor": "eyJpZCI6ImxvZ2luXzIiLCJjcmVhdGVkQXQiOiIyMDI2LTAyLTIwVDEzOjI1OjAwWiJ9"
  }
}
```

### Example request (next page, using cursor)

```http
GET /api/v1/auth/login-history?limit=10&cursor=eyJpZCI6ImxvZ2luXzIiLCJjcmVhdGVkQXQiOiIyMDI2LTAyLTIwVDEzOjI1OjAwWiJ9
Authorization: Bearer <token>
```

### Example response (next page)

```json
{
  "data": [
    {
      "id": "login_3",
      "userAgent": "PostmanRuntime/7.26.8",
      "ipAddress": "192.0.2.100",
      "createdAt": "2026-02-20T12:50:00Z"
    }
  ],
  "meta": {
    "limit": 10,
    "nextCursor": null
  }
}
```

The `nextCursor` is null, indicating no more data.

### When to use cursor pagination

- Paginating large datasets (10k+ records)
- You only need to move forward through results (no random access)
- Data is being added/modified frequently; you want stable pagination
- You're building an infinite-scroll or "load more" UI

### Important: Cursor and page are mutually exclusive

If both `cursor` and `page` are provided with non-default values, the endpoint returns a `400 Bad Request`:

```json
{
  "statusCode": 400,
  "message": "cursor and page are mutually exclusive"
}
```

---

## Endpoints and pagination support

| Endpoint | Support | Default Limit | Max Limit | Notes |
|----------|---------|---------------|-----------|-------|
| `GET /shipments` | Offset + Cursor | 20 | 100 | Main shipment list |
| `GET /shipments/archived` | Offset | 20 | 100 | Archived shipments only |
| `GET /shipments/:id/comments` | Offset | 20 | 100 | Comments on a shipment |
| `GET /shipments/:id/comments/:commentId/replies` | Offset | 20 | 100 | Replies to a comment |
| `GET /admin/audit-logs` | Offset | 50 | — | Admin audit log list |
| `GET /auth/login-history` | Cursor | 20 | 100 | User's login history |
| `GET /announcements` | Offset | 20 | 100 | Announcements |
| `GET /admin/arbiters` | Offset | — | — | Arbiters with reputation (no pagination in response; sortBy supported) |
| `GET /events` | — | — | — | On-chain events (ledger range, no pagination) |
| `GET /events/admin/failed-events` | Offset | 20 | — | Failed event queue (admin only) |

---

## Common Filters

Most list endpoints accept optional filter parameters to narrow results. Filters are combined with AND logic.

### Date range filters

Filter by creation or modification timestamps using ISO 8601 format (`YYYY-MM-DDTHH:mm:ss.sssZ`).

| Parameter | Endpoint(s) | Format | Example |
|-----------|-------------|--------|---------|
| `createdAfter` | `/shipments` | ISO 8601 | `2026-01-01T00:00:00.000Z` |
| `createdBefore` | `/shipments` | ISO 8601 | `2026-03-31T23:59:59.999Z` |
| `updatedAfter` | `/shipments` | ISO 8601 | `2026-01-15T00:00:00.000Z` |
| `updatedBefore` | `/shipments` | ISO 8601 | `2026-02-01T00:00:00.000Z` |
| `startDate` | `/admin/audit-logs`, `/events` | ISO 8601 | `2026-01-01T00:00:00Z` |
| `endDate` | `/admin/audit-logs`, `/events` | ISO 8601 | `2026-02-28T23:59:59Z` |

### Status and state filters

| Parameter | Endpoint(s) | Values | Example |
|-----------|-------------|--------|---------|
| `status` | `/shipments`, `/admin/audit-logs/export` | Enum: `DRAFT, ACTIVE, DELIVERY, DISPUTE, CANCELLED, COMPLETED` | `status=ACTIVE` |
| `isDraft` | `/shipments` | `true`, `false` | `isDraft=true` (drafts only) |
| `unreadOnly` | `/notifications` | `true`, `false` | `unreadOnly=true` |

### Search and text filters

| Parameter | Endpoint(s) | Behavior | Example |
|-----------|-------------|----------|---------|
| `search` | `/shipments` | Full-text search in shipment description | `search=customs` |
| `referenceNumber` | `/shipments` | Exact match on reference number | `referenceNumber=REF-2026-001` |
| `email` | `/admin/email-suppressions` | Exact match on email | `email=user@example.com` |
| `action` | `/admin/audit-logs` | Substring match on action name | `action=UPDATE` |

### Address and participant filters

| Parameter | Endpoint(s) | Behavior | Example |
|-----------|-------------|----------|---------|
| `buyerAddress` | `/shipments` | Filter by buyer Stellar address | `buyerAddress=GBBD...` |
| `supplierAddress` | `/shipments` | Filter by supplier Stellar address | `supplierAddress=GBBD...` |
| `organizationId` | `/shipments` | Filter by organization membership | `organizationId=org_123` |
| `actorAddress` | `/admin/audit-logs` | Filter by actor Stellar address | `actorAddress=GBBD...` |

### Advanced filters

| Parameter | Endpoint(s) | Behavior | Example |
|-----------|-------------|----------|---------|
| `tags` | `/shipments` | Comma-separated tags (substring match on each) | `tags=priority,gate` |
| `riskLevel` | `/shipments` | Filter by computed risk: `LOW`, `MEDIUM`, `HIGH` | `riskLevel=HIGH` |
| `favorite` | `/shipments` | Return only favorited shipments | `favorite=true` |
| `includeArchived` | `/shipments` | Include archived shipments (default: false) | `includeArchived=true` |
| `currency` | `/shipments` | Override FX display currency | `currency=EUR` |
| `savedFilterId` | `/shipments` | Apply a saved filter preset | `savedFilterId=filter_123` |
| `sortBy` | `/admin/arbiters` | Sort field: `disputesOpen`, `disputesHandled`, `averageResolutionTimeHours` | `sortBy=disputesHandled` |

---

## Sparse fieldsets

Some endpoints support requesting a subset of fields via the `fields` parameter. This reduces response size and improves performance for large result sets.

| Parameter | Endpoint(s) | Behavior | Example |
|-----------|-------------|----------|---------|
| `fields` | `/shipments` | Comma-separated field names (always includes id) | `fields=id,status,totalAmount` |

**Important:** Unknown field names in the request return a `400` error.

---

## Practical Examples

### Example 1: List recent shipments with offset pagination

```bash
curl -X GET "http://localhost:3000/api/v1/shipments?page=1&limit=10&createdAfter=2026-02-01T00:00:00Z" \
  -H "Authorization: Bearer your_jwt_token"
```

Response:
```json
{
  "data": [ /* 10 shipments */ ],
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 45,
    "totalPages": 5,
    "nextCursor": null
  }
}
```

### Example 2: Filter by status and address

```bash
curl -X GET "http://localhost:3000/api/v1/shipments?status=ACTIVE&buyerAddress=GBXYZ123&page=1&limit=20" \
  -H "Authorization: Bearer your_jwt_token"
```

### Example 3: Cursor-based pagination for login history

First request:
```bash
curl -X GET "http://localhost:3000/api/v1/auth/login-history?limit=5" \
  -H "Authorization: Bearer your_jwt_token"
```

Response:
```json
{
  "data": [ /* 5 login records */ ],
  "meta": {
    "limit": 5,
    "nextCursor": "eyJpZCI6ImxvZ2luXzU..."
  }
}
```

Second request (using the cursor):
```bash
curl -X GET "http://localhost:3000/api/v1/auth/login-history?limit=5&cursor=eyJpZCI6ImxvZ2luXzU..." \
  -H "Authorization: Bearer your_jwt_token"
```

### Example 4: Full-text search with sparse fieldset

```bash
curl -X GET "http://localhost:3000/api/v1/shipments?search=urgent+delivery&fields=id,status,createdAt&page=1&limit=20" \
  -H "Authorization: Bearer your_jwt_token"
```

### Example 5: Combine date range, status, and risk filter

```bash
curl -X GET "http://localhost:3000/api/v1/shipments?createdAfter=2026-01-01T00:00:00Z&createdBefore=2026-03-31T23:59:59Z&status=DISPUTE&riskLevel=HIGH&page=1&limit=25" \
  -H "Authorization: Bearer your_jwt_token"
```

---

## Defaults and Limits

| Aspect | Value | Configurable |
|--------|-------|--------------|
| Default page size | 20 | Per endpoint via query DTO `@IsInt() @Min(1) @Max(...)` |
| Default page | 1 | Hard-coded in service layer |
| Default limit (audit logs) | 50 | Hard-coded in service layer |
| Max limit (most endpoints) | 100 | Per endpoint via `@Max(100)` |
| Offset pagination max | Unlimited | Database dependent; practical limit ~1M records |
| Cursor pagination max | Unlimited | Stable; recommended for very large datasets |

---

## Error Handling

### 400 Bad Request

- **Mutually exclusive parameters:** `cursor` and `page` both provided with non-defaults
  ```json
  {"statusCode": 400, "message": "cursor and page are mutually exclusive"}
  ```
- **Invalid cursor format:** Malformed or non-base64 cursor
  ```json
  {"statusCode": 400, "message": "Invalid cursor format"}
  ```
- **Invalid date format:** Date parameter not ISO 8601
  ```json
  {"statusCode": 400, "message": "...validation error..."}
  ```
- **Exceeds max limit:** Requested limit > max allowed
  ```json
  {"statusCode": 400, "message": "...max 100..."}
  ```

### 403 Forbidden

- Listing resources for which you lack access (e.g., another user's login history, audit logs without ADMIN role)

### 404 Not Found

- Referenced resource (e.g., by `savedFilterId`) does not exist

---

## Best Practices

1. **Prefer cursor pagination for:**
   - Real-time or high-frequency data (e.g., activity logs, notifications)
   - Large datasets (> 10k records)
   - Mobile / infinite-scroll UIs

2. **Use offset pagination for:**
   - Traditional pagination UI (numbered pages)
   - Small, stable datasets
   - APIs used primarily for exports or backups

3. **Always specify `limit` explicitly** — don't rely on defaults, as they may change.

4. **For bulk operations,** export endpoints (`GET /shipments/export`, `GET /admin/audit-logs/export`) are separate from list endpoints and return CSV/PDF instead of paginated JSON.

5. **If paginating through all data programmatically,** use cursor pagination — it remains stable even if new records are added during your iteration.

6. **Combine filters, not pagination:** Use query parameters to narrow results, then paginate the narrowed set. Don't try to skip records with pagination to achieve filtering.
