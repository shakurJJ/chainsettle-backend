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

---

## Signature verification

Every delivery includes an `X-ChainSettle-Signature` header:

```
X-ChainSettle-Signature: sha256=<hex-digest>
```

The digest is `HMAC-SHA256(secret, rawRequestBody)` where `secret` is the **plaintext** value returned at registration time.

### Node.js verification example

```ts
import * as crypto from 'crypto';

function verifySignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')}`;
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader),
  );
}
```

> Always use `crypto.timingSafeEqual` to prevent timing attacks. Reject the request with `401` if verification fails.

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

// Use raw body parser so the signature check works
app.post('/chainsettle-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-chainsettle-signature'] as string;

  const expected = `sha256=${crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex')}`;

  if (!sig || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(req.body.toString());
  console.log('Received event:', event.eventType, event.payload);

  // Acknowledge immediately — do heavy processing asynchronously
  res.status(200).send('OK');
});

app.listen(3001);
```

> Parse the body as **raw bytes** before passing it to the HMAC. JSON-parsing first changes whitespace and key order, breaking the signature.
