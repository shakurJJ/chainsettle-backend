# Webhook Integration Guide

ChainSettle can push real-time event notifications to any HTTPS endpoint you control. This guide covers payload shapes, signature verification, retry behaviour, and a minimal receiver example.

---

## Registering an endpoint

```
POST /api/v1/webhooks
Authorization: Bearer <JWT>

{
  "url": "https://your-service.example.com/chainsettle-webhook",
  "events": ["SHIPMENT_CREATED", "MILESTONE_CONFIRMED", "DISPUTE_RAISED"]
}
```

The response includes a `secret` field **shown once**. Store it securely — it is never returned again. Rotate it at any time with `POST /api/v1/webhooks/:id/rotate-secret`.

---

## Event types

All values of the `NotificationType` enum are subscribable. Retrieve the live list:

```
GET /api/v1/webhooks/event-types
```

| Event type | Triggered when |
|---|---|
| `SHIPMENT_CREATED` | A new shipment is registered |
| `PROOF_SUBMITTED` | Supplier/logistics uploads proof for a milestone |
| `MILESTONE_CONFIRMED` | Buyer confirms a milestone and payment is released |
| `DISPUTE_RAISED` | A dispute is opened on a milestone |
| `DISPUTE_RESOLVED` | An arbiter resolves a dispute |
| `DISPUTE_EVIDENCE_SUBMITTED` | Buyer or supplier submits dispute evidence |
| `SHIPMENT_CANCELLED` | A shipment is cancelled |
| `PAYMENT_RELEASED` | Payment is released for a milestone |
| `MILESTONE_OVERDUE` | A milestone passes its due date without confirmation |
| `COMMENT_ADDED` | A comment is posted on a shipment |
| `COMMENT_MENTION` | A user is @mentioned in a comment |
| `SYSTEM_ALERT` | Platform-level alert (e.g. failed event exhausted retries) |
| `ARBITER_INVITED` | An arbiter is assigned to a shipment |
| `ARBITER_ACCEPTED` | The arbiter accepts their assignment |
| `ARBITER_DECLINED` | The arbiter declines their assignment |
| `TRACKING_UPDATED` | Logistics submits a tracking update |
| `PROOF_REJECTED` | Buyer rejects a submitted proof |
| `SHIPMENT_COMMENT_CREATED` | A comment is created on a shipment — dispatched once per comment to integrations, regardless of participants' notification preferences |

---

## Payload shape

Every delivery is an HTTP `POST` with `Content-Type: application/json`:

```json
{
  "eventType": "MILESTONE_CONFIRMED",
  "payload": {
    "notificationId": "uuid-of-the-notification-record",
    "shipmentId": "SHIP-ABC123",
    "milestoneIndex": 1,
    "paymentAmount": "500.0000000",
    "tokenSymbol": "USDC"
  },
  "timestamp": "2026-08-27T10:00:00.000Z"
}
```

The `payload` object mirrors the `data` field of the corresponding `Notification` record. Fields present depend on the event type — see the table below for common keys.

| Event type | Common `payload` keys |
|---|---|
| `SHIPMENT_CREATED` | `shipmentId`, `buyerAddress`, `supplierAddress` |
| `PROOF_SUBMITTED` | `shipmentId`, `milestoneIndex`, `proofHash` |
| `MILESTONE_CONFIRMED` | `shipmentId`, `milestoneIndex`, `paymentAmount`, `tokenSymbol` |
| `DISPUTE_RAISED` | `shipmentId`, `milestoneIndex` |
| `DISPUTE_RESOLVED` | `shipmentId`, `milestoneIndex`, `approved` |
| `PAYMENT_RELEASED` | `shipmentId`, `milestoneIndex`, `paymentReleased`, `txHash` |
| `SHIPMENT_CANCELLED` | `shipmentId` |
| `TRACKING_UPDATED` | `shipmentId`, `status`, `location`, `estimatedArrival` |
| `PROOF_REJECTED` | `shipmentId`, `milestoneIndex`, `reason` |
| `SHIPMENT_COMMENT_CREATED` | `shipmentId`, `commentId`, `authorAddress`, `bodyExcerpt`, `createdAt` |

> `SHIPMENT_COMMENT_CREATED` is dispatched directly by the comments service
> (not via a `Notification` record), so its payload has no `notificationId`.
> `bodyExcerpt` is the first 200 characters of the comment body and
> `createdAt` is an ISO-8601 timestamp.

---

## Signature verification

Every delivery includes **three** security headers:

```
X-ChainSettle-Timestamp: 1753717200
X-ChainSettle-Signature:    sha256=<hex-digest>
X-ChainSettle-Signature-V2: t=1753717200,v1=<hex-digest>
```

- **`X-ChainSettle-Timestamp`** — the unix time (whole seconds) at which the delivery was signed.  Use this to reject replayed deliveries older than your tolerance window.
- **`X-ChainSettle-Signature`** — **legacy v1** signature.  `HMAC-SHA256(secret, rawRequestBody)`.  Kept for one deprecation cycle; migrate to v2 as soon as possible.
- **`X-ChainSettle-Signature-V2`** — **current v2** signature.  The `v1` digest inside is `HMAC-SHA256(secret, timestamp + "." + rawRequestBody)`.  Including the timestamp in the signed content means a captured payload cannot be re-sent later with a different timestamp — the signature will break.

`secret` is always the **plaintext** value returned at registration time (never the SHA-256 hash that ChainSettle stores).

### Recommended tolerance

Reject deliveries whose `X-ChainSettle-Timestamp` is more than **5 minutes (300 seconds)** away from the current unix time.  This covers clock skew while effectively closing the replay window.

### Node.js verification example (v2, recommended)

```ts
import * as crypto from 'crypto';

const TOLERANCE_SECONDS = 300;

function verifyV2(
  rawBody: Buffer,
  timestampHeader: string | undefined,
  signatureV2Header: string | undefined,
  secret: string,
): boolean {
  if (!timestampHeader || !signatureV2Header) return false;

  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestampHeader);
  if (!Number.isInteger(ts)) return false;
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) return false;

  const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signatureV2Header);
  if (!m || m[1] !== timestampHeader) return false;

  const signedContent = `${ts}.${rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedContent)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]));
}
```

### Python verification example (v2, recommended)

```python
import hashlib
import hmac
import time
from typing import Optional

TOLERANCE_SECONDS = 300

def verify_v2(
    raw_body: bytes,
    timestamp_header: Optional[str],
    signature_v2_header: Optional[str],
    secret: str,
) -> bool:
    if not timestamp_header or not signature_v2_header:
        return False

    now = int(time.time())
    try:
        ts = int(timestamp_header)
    except ValueError:
        return False
    if abs(now - ts) > TOLERANCE_SECONDS:
        return False

    import re
    m = re.fullmatch(r"t=(\d+),v1=([a-f0-9]{64})", signature_v2_header)
    if not m or m.group(1) != timestamp_header:
        return False

    signed_content = f"{ts}.".encode("utf-8") + raw_body
    expected = hmac.new(
        secret.encode("utf-8"), signed_content, hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(expected, m.group(2))
```

> Always use `crypto.timingSafeEqual` / `hmac.compare_digest` to prevent timing attacks.  Reject the request with `401` if verification fails.

---

## Retry and backoff behaviour

ChainSettle retries failed deliveries automatically using exponential backoff with ±25 % jitter:

| Attempt | Approximate delay |
|---|---|
| 1 → 2 | ~30 s |
| 2 → 3 | ~2 min |
| 3 → 4 | ~8 min |
| 4 → 5 | ~30 min |

After **5 total attempts** the delivery is marked `permanently_failed` and no further automatic retries occur.

**Retryable conditions** (server-side transient errors):
- HTTP status: `429`, `500`, `502`, `503`, `504`
- Network errors: `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`

**Non-retryable conditions**: any `4xx` status other than `429` (e.g. `400`, `401`, `404`).

Your endpoint must respond within **10 seconds**. Return any `2xx` status to acknowledge receipt.

### Inspecting delivery history

```
GET /api/v1/webhooks/:id                          # summary with last 20 deliveries
GET /api/v1/webhooks/:id/deliveries/:deliveryId   # full detail + retryStatus
```

The `retryStatus` field in the delivery detail response has one of four states:

| State | Meaning |
|---|---|
| `pending` | Initial attempt in flight |
| `pending_retry` | Waiting for the next scheduled retry |
| `permanently_failed` | All retries exhausted or non-retryable error |
| `succeeded` | Delivered successfully |

### Manual retry

```
POST /api/v1/webhooks/:id/deliveries/:deliveryId/retry
```

Clears `permanentlyFailedAt` and immediately re-attempts delivery regardless of prior exhaustion.

---

## Minimal receiver (Express)

```ts
import express from 'express';
import * as crypto from 'crypto';

const app = express();
const WEBHOOK_SECRET = process.env.CHAINSETTLE_WEBHOOK_SECRET!;
const TOLERANCE_SECONDS = 300;

// Use raw body parser so the signature check works
app.post('/chainsettle-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const tsHeader = req.headers['x-chainsettle-timestamp'] as string | undefined;
  const sigV2 = req.headers['x-chainsettle-signature-v2'] as string | undefined;

  if (!tsHeader || !sigV2) {
    return res.status(401).send('Missing security headers');
  }

  // 1. Reject stale deliveries outside the 5-minute tolerance window
  const now = Math.floor(Date.now() / 1000);
  const ts = Number(tsHeader);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > TOLERANCE_SECONDS) {
    return res.status(401).send('Timestamp outside tolerance');
  }

  // 2. Verify the v2 HMAC over `${ts}.${rawBody}`
  const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(sigV2);
  if (!m || m[1] !== tsHeader) {
    return res.status(401).send('Invalid signature format');
  }
  const signedContent = `${ts}.${req.body.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(signedContent)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]))) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(req.body.toString());
  console.log('Received event:', event.eventType, event.payload);

  // Acknowledge immediately — do heavy processing asynchronously
  res.status(200).send('OK');
});

app.listen(3001);
```

> Parse the body as **raw bytes** before passing it to the HMAC.  JSON-parsing first changes whitespace and key order, breaking the signature.  Always verify the timestamp **and** the timestamp-matching assertion (that `t=` matches `X-ChainSettle-Timestamp`) so that a malicious sender cannot mix-and-match timestamp and signature from two different deliveries.
