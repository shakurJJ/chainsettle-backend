# Tracking

This guide is for logistics integrators who need to push shipment tracking updates into ChainSettle and consume the derived tracking state. It covers the tracking data model, the three ingestion paths (single update, bulk import, carrier webhook), how the latest position and ETA are derived, and the rate limits that apply.

For outbound webhooks that ChainSettle delivers to *your* systems (including the signature scheme), see [docs/webhooks.md](./webhooks.md).

## Data model

Tracking updates are stored as `TrackingUpdate` records. Each record is immutable after submission — corrections are made by submitting a new update, never by editing or deleting an existing one.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `shipmentId` | string | yes | The shipment this update belongs to. |
| `submittedBy` | string | yes | Identifier of the user or integration that submitted the update. Set by the API from the authenticated principal. |
| `location` | string | yes | Human-readable location (e.g. `"Rotterdam, NL"`). |
| `latitude` | number | no | Latitude of the reported position. |
| `longitude` | number | no | Longitude of the reported position. |
| `status` | string | yes | Tracking status for this update (e.g. `in_transit`, `out_for_delivery`, `delivered`). |
| `estimatedArrival` | string (ISO 8601) | no | ETA reported by this update. |
| `notes` | string | no | Free-form notes. |
| `createdAt` | string (ISO 8601) | yes | Server-assigned creation timestamp. Used to order updates. |

Because updates are append-only, the "current" state of a shipment is always derived from the set of updates (see [Deriving the latest position and ETA](#deriving-the-latest-position-and-eta)).

## Ingestion paths

There are three ways to get tracking updates into ChainSettle:

1. **Single update** — `POST /api/v1/shipments/:id/tracking` for one-off updates from a logistics participant.
2. **Bulk import** — CSV / bulk tracking import exposed by the shipments module for backfills and batch syncs.
3. **Carrier webhook** — carriers post updates directly to a signed webhook endpoint.

All three paths produce the same immutable `TrackingUpdate` records.

### 1. Single update

`POST /api/v1/shipments/:id/tracking`

Restricted to **logistics participants**. Requests from other roles are rejected with `403 Forbidden`. An unknown shipment returns `404 Not Found`. A successful submission returns `201 Created` with the created `TrackingUpdate`.

#### Request body (`CreateTrackingDto`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `location` | string | yes | Human-readable location. |
| `latitude` | number | no | Latitude. |
| `longitude` | number | no | Longitude. |
| `status` | string | yes | Tracking status. |
| `estimatedArrival` | string (ISO 8601) | no | ETA for this update. |
| `notes` | string | no | Free-form notes. |

`shipmentId` comes from the URL path and `submittedBy` from the authenticated principal; neither is supplied in the body.

#### Example

```bash
curl -X POST https://api.chainsettle.example/api/v1/shipments/shp_123/tracking \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "location": "Rotterdam, NL",
    "latitude": 51.9244,
    "longitude": 4.4777,
    "status": "in_transit",
    "estimatedArrival": "2025-06-02T14:00:00Z",
    "notes": "Loaded on vessel"
  }'
```

Response `201 Created`:

```json
{
  "id": "tru_9f1c",
  "shipmentId": "shp_123",
  "submittedBy": "user_42",
  "location": "Rotterdam, NL",
  "latitude": 51.9244,
  "longitude": 4.4777,
  "status": "in_transit",
  "estimatedArrival": "2025-06-02T14:00:00Z",
  "notes": "Loaded on vessel",
  "createdAt": "2025-05-30T09:12:44Z"
}
```

Error responses:

| Status | Meaning |
| --- | --- |
| `403` | Caller is not a logistics participant. |
| `404` | Shipment `:id` does not exist. |
| `422` | Validation failure in the request body. |

### 2. Bulk import

The shipments module exposes a bulk tracking import (CSV upload) for backfills and periodic batch syncs. Each row is validated and converted into a `TrackingUpdate`; rows that fail validation are reported individually and do not block valid rows.

#### Example

```bash
curl -X POST https://api.chainsettle.example/api/v1/shipments/tracking/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@tracking.csv"
```

`tracking.csv`:

```csv
shipmentId,location,latitude,longitude,status,estimatedArrival,notes
shp_123,"Rotterdam, NL",51.9244,4.4777,in_transit,2025-06-02T14:00:00Z,Loaded on vessel
shp_124,"Hamburg, DE",53.5511,9.9937,out_for_delivery,2025-06-01T09:00:00Z,On truck
```

Response `201 Created`:

```json
{
  "created": 2,
  "failed": 0,
  "errors": []
}
```

Response with partial failures:

```json
{
  "created": 1,
  "failed": 1,
  "errors": [
    { "row": 3, "shipmentId": "shp_999", "message": "Shipment not found" }
  ]
}
```

Bulk import is subject to the same throttler limits as single submission (see [Rate limits](#rate-limits)).

### 3. Carrier webhook

Carriers can post tracking updates directly to a per-integration webhook endpoint. This is the preferred path for high-volume carrier feeds because it avoids polling and keeps updates close to real time.

#### Configuring the endpoint

1. Register the carrier integration and generate a **shared secret** for it.
2. Provide the carrier with the endpoint URL:

   ```
   POST https://api.chainsettle.example/api/v1/webhooks/carriers/:carrierId/tracking
   ```

3. Configure the carrier to sign each delivery with the shared secret (see below).

#### Carrier signature verification

Inbound carrier callbacks are **signed and verified** before any update is persisted. The carrier computes an HMAC over the **raw request body** using the shared secret and sends it in a signature header (e.g. `X-Carrier-Signature`). On receipt, ChainSettle:

1. Reads the **raw body bytes** (before JSON parsing) and recomputes the HMAC-SHA256 with the shared secret.
2. Compares the computed value to the supplied signature using a **timing-safe comparison** to avoid timing side channels.
3. Rejects the request if the signature is missing or does not match.
4. Rejects requests whose timestamp is **stale** (outside the tolerance window) to prevent replay attacks. Carriers should send a timestamp header alongside the signature; the signature should cover the timestamp and the raw body (e.g. HMAC over `timestamp + "." + rawBody`).

Requests that fail verification are rejected and no `TrackingUpdate` is created.

> **Note:** This is the *inbound* carrier scheme. It is distinct from ChainSettle's *outbound* webhook signature scheme, which is documented in [docs/webhooks.md](./webhooks.md). That outbound scheme uses `X-ChainSettle-Timestamp`, a legacy `X-ChainSettle-Signature` (v1), and `X-ChainSettle-Signature-V2` with `t=...,v1=...` where the HMAC-SHA256 is computed over `timestamp + "." + rawBody` with a 300s tolerance. Use the same principles (raw body, timing-safe comparison, timestamp tolerance) when implementing your carrier-side signing.

#### Example carrier delivery

```bash
BODY='{"shipmentId":"shp_123","location":"Antwerp, BE","latitude":51.2194,"longitude":4.4025,"status":"in_transit","estimatedArrival":"2025-06-02T14:00:00Z"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$CARRIER_SECRET" -hex | sed 's/^.* //')

curl -X POST https://api.chainsettle.example/api/v1/webhooks/carriers/car_acme/tracking \
  -H "Content-Type: application/json" \
  -H "X-Carrier-Timestamp: $TS" \
  -H "X-Carrier-Signature: $SIG" \
  -d "$BODY"
```

Successful ingestion returns `200 OK`:

```json
{ "received": true, "trackingUpdateId": "tru_9f1c" }
```

Invalid signature or stale timestamp returns `401 Unauthorized` and no update is recorded.

#### Webhook delivery retries

When ChainSettle delivers outbound webhooks to your systems, failed deliveries are retried automatically:

- **Max 5 automatic attempts.**
- **Retryable status codes:** `429`, `500`, `502`, `503`, `504`.
- **Exponential backoff with jitter**, starting at **30s**.

Return a `2xx` as soon as you have durably accepted the payload to avoid unnecessary retries. See [docs/webhooks.md](./webhooks.md) for the full outbound delivery and signature details.

## Deriving the latest position and ETA

The current tracking state of a shipment is computed from its `TrackingUpdate` records:

- **Latest position and status:** the update with the greatest `createdAt` supplies the current `location`, `latitude`/`longitude`, and `status`.
- **ETA:** taken from the most recent update that sets `estimatedArrival`. If no update sets an ETA, the shipment's `expectedDeliveryAt` is used as the fallback.

Because updates are immutable and ordered by `createdAt`, submitting a new update is the only way to change the derived state. To correct a position or ETA, submit a new update rather than attempting to modify an existing one.

## Rate limits

- **Tracking submission endpoints** (single update and bulk import) are protected by the API throttler. Exceeding the limit returns `429 Too Many Requests`; honor the `Retry-After` header and back off before retrying.
- **Carrier webhook ingestion** is also throttled per integration. Carriers should batch or pace deliveries and retry on `429` with backoff.
- **Outbound webhook delivery** retries: max 5 automatic attempts, retryable status codes `429`/`500`/`502`/`503`/`504`, exponential backoff with jitter starting at 30s (see [docs/webhooks.md](./webhooks.md)).