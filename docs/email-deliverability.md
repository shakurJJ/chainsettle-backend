# Email Deliverability — Bounces, Suppression and Unsubscribe

This guide is for operators who need to configure the email provider and work out why a user is not receiving email.

ChainSettle sends notification, verification, digest and report emails over SMTP (nodemailer). Every send passes through three gates, in order:

1. **Suppression list** — addresses that hard-bounced or filed a spam complaint are never emailed again until an admin removes them.
2. **User preferences** — each notification type has a per-channel `email` toggle, which the one-click unsubscribe link switches off.
3. **SMTP delivery** — the provider accepts or rejects the message. Failures are retried by the email queue (`QUEUE_EMAIL_ATTEMPTS`, `QUEUE_EMAIL_BACKOFF_MS`) and recorded in the notification's delivery log.

> **Related docs**
> - Notification channels and preferences: [Notifications](./notifications.md)
> - Queue retries: [Queues](./queues.md)
> - All environment variables: [Environment Variables](./environment-variables.md)

---

## Table of Contents

- [Configuration](#configuration)
- [Provider Webhook Setup (Bounces and Complaints)](#provider-webhook-setup-bounces-and-complaints)
- [Suppression Reasons](#suppression-reasons)
- [Admin Suppression Endpoints](#admin-suppression-endpoints)
- [One-Click Unsubscribe](#one-click-unsubscribe)
- [Troubleshooting](#troubleshooting)

---

## Configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SMTP_HOST` | Yes | — | Provider SMTP host |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_USER` / `SMTP_PASS` | Yes | — | SMTP credentials 🔒 |
| `EMAIL_FROM` | No | `noreply@chainsetttle.com` | `From:` address. Use a domain with SPF, DKIM and DMARC records set up at your provider. |
| `EMAIL_WEBHOOK_SECRET` | For bounce handling | — | Shared secret used to verify the provider webhook signature 🔒. If unset, the webhook rejects every request with `401 Email webhook is not configured`. |
| `API_BASE_URL` | No | `http://localhost:3000` | Public base URL used to build unsubscribe links. Must be reachable by recipients' mail clients. |
| `JWT_SECRET` | Yes | — | Also signs unsubscribe tokens. Rotating it invalidates every unsubscribe link already sent. |

---

## Provider Webhook Setup (Bounces and Complaints)

ChainSettle exposes one public webhook that receives delivery events from the email provider:

```http
POST /api/v1/email/events
Content-Type: application/json
X-Email-Signature: <hex HMAC-SHA256 of the raw request body>
```

### 1. Generate and store a secret

```bash
openssl rand -hex 32
# → set as EMAIL_WEBHOOK_SECRET in the API's environment / secrets provider, then restart
```

### 2. Register the webhook at your provider

In your provider's dashboard (e.g. SendGrid *Event Webhook*, Postmark *Bounce/Spam webhooks*, Mailgun *Webhooks*, or an SES → SNS → relay):

- **URL:** `https://<your-api-host>/api/v1/email/events`
- **Events:** at least *bounce* and *spam complaint*. Delivered/opened/clicked events are accepted but ignored.

### 3. Sign each request

The endpoint verifies `X-Email-Signature` = `hex(HMAC-SHA256(EMAIL_WEBHOOK_SECRET, rawBody))`. An optional `sha256=` prefix is accepted. Comparison is constant-time over the **exact raw bytes** received, so any proxy that re-serialises the JSON will break the signature.

Most providers sign with their own scheme. If yours cannot produce this header directly, put a small relay (Lambda, Cloud Function, worker) in front that verifies the provider's signature, then forwards the body with the ChainSettle signature:

```typescript
import { createHmac } from "crypto";

const body = JSON.stringify(events);
const signature = createHmac("sha256", process.env.EMAIL_WEBHOOK_SECRET!)
  .update(body)
  .digest("hex");

await fetch("https://api.example.com/api/v1/email/events", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Email-Signature": signature },
  body,
});
```

### 4. Payload format

The body may be a single event, an array of events, or `{ "events": [...] }`. Each event is read from these fields:

| Field | Notes |
|-------|-------|
| `type` or `event` | Event name (case-insensitive) — see the classification table below |
| `email` or `recipient` | Recipient address (normalised to lower case) |
| `bounceType` | For `bounce` / `bounced` events: `hard`/`permanent` suppress; `soft`/`transient`/`temporary` are ignored. Missing → treated as hard. |

```json
[
  { "event": "bounce", "email": "Alice@Example.com", "bounceType": "permanent" },
  { "event": "spamreport", "email": "bob@example.com" },
  { "event": "delivered", "email": "carol@example.com" }
]
```

**Response — HTTP 200**

```json
{ "success": true, "data": { "suppressed": 2 }, "timestamp": "2026-11-25T10:00:00.000Z" }
```

### 5. Verify the setup

```bash
SECRET=...   # EMAIL_WEBHOOK_SECRET
BODY='{"event":"bounce","email":"bounce-test@example.com","bounceType":"hard"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

curl -s -X POST https://api.example.com/api/v1/email/events \
  -H "Content-Type: application/json" \
  -H "X-Email-Signature: $SIG" \
  --data-raw "$BODY"
# → { "success": true, "data": { "suppressed": 1 }, ... }
```

Then confirm the address appears in `GET /api/v1/admin/email-suppressions?email=bounce-test` and [remove it](#remove-an-address-from-the-suppression-list) again.

---

## Suppression Reasons

| Event `type` / `event` | Result |
|------------------------|--------|
| `complaint`, `spamreport`, `spam_report`, `abuse` | Suppressed — reason `COMPLAINT` |
| `hard_bounce`, `hardbounce`, `permanent_bounce` | Suppressed — reason `BOUNCE` |
| `bounce`, `bounced` with `bounceType` hard/permanent/missing | Suppressed — reason `BOUNCE` |
| `bounce`, `bounced` with `bounceType` soft/transient/temporary | Ignored (temporary failure, the provider retries) |
| anything else (`delivered`, `open`, `click`, `deferred`, …) | Ignored |

When an address is suppressed for the first time:

- a row is added to `email_suppressions` (`email` is unique and stored lower-cased; repeat events are no-ops);
- if a user has that email, their `emailVerified` flag is set to `false`;
- that user gets an in-app `SYSTEM_ALERT` notification ("Please update your email address") with `data.action = "UPDATE_EMAIL"` and the reason.

While the address is suppressed, every send to it is skipped and logged as `Email to … skipped — address is on the suppression list`. If the suppression lookup itself fails (e.g. database error), sending **fails closed**: the email is skipped to protect sender reputation.

Suppression is keyed by address, not by user. A user who changes to a new, non-suppressed address starts receiving email again; the old address stays suppressed.

---

## Admin Suppression Endpoints

Both endpoints require an `ADMIN` JWT and are subject to the admin IP allowlist.

### List suppressed addresses

```http
GET /api/v1/admin/email-suppressions?page=1&limit=20&email=example.com
Authorization: Bearer <admin JWT>
```

| Query | Default | Notes |
|-------|---------|-------|
| `page` | `1` | 1-based |
| `limit` | `20` | Max `100` |
| `email` | — | Case-insensitive substring match |

**Response — HTTP 200** (newest first)

```json
{
  "success": true,
  "data": {
    "data": [
      {
        "id": "6f1c2e0a-…",
        "email": "alice@example.com",
        "reason": "BOUNCE",
        "createdAt": "2026-11-24T08:12:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 20
  }
}
```

### Remove an address from the suppression list

```http
DELETE /api/v1/admin/email-suppressions/:id
Authorization: Bearer <admin JWT>
```

**Response — HTTP 200**

```json
{ "success": true, "data": { "removed": true, "email": "alice@example.com" } }
```

Returns `404` if the id does not exist.

Before removing an entry:

- **`BOUNCE`** — confirm the mailbox now exists and accepts mail (the user fixed a typo, the mailbox was re-created, the receiving domain's MX was fixed). Removing a still-invalid address just bounces again and hurts sender reputation.
- **`COMPLAINT`** — only remove when the user has explicitly asked to receive email again. Re-mailing someone who marked you as spam is the fastest way to get the sending domain blocked.

Removing a suppression does **not** set `emailVerified` back to `true`. Ask the user to re-verify (`POST /api/v1/auth/resend-verification`) if verification-gated emails matter.

```bash
# find the entry
curl -s "https://api.example.com/api/v1/admin/email-suppressions?email=alice@example.com" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# remove it
curl -s -X DELETE "https://api.example.com/api/v1/admin/email-suppressions/6f1c2e0a-…" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## One-Click Unsubscribe

Every email sent to a known user includes RFC 8058 headers and a footer link:

```
List-Unsubscribe: <https://api.example.com/api/v1/notifications/unsubscribe?token=…>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

- Mail clients that support one-click (Gmail, Apple Mail, Outlook) send `POST /api/v1/notifications/unsubscribe?token=…` with no user interaction beyond the button.
- The footer **Unsubscribe** link opens `GET /api/v1/notifications/unsubscribe?token=…` in the browser.
- Both endpoints are public; the token can also be sent in a JSON body as `{ "token": "…" }` for `POST`.

The token is `base64url(payload).base64url(HMAC-SHA256)` signed with `JWT_SECRET`, where the payload is `{ userId, type, exp }`. Tokens are valid for **30 days**.

| Token `type` | Effect |
|--------------|--------|
| A specific `NotificationType` (e.g. `PAYMENT_RELEASED`) | Sets `email: false` for that type only. Other channels (in-app, push, Slack…) are unchanged. |
| `ALL` (used when the email has no notification type, e.g. digests and reports) | Sets `email: false` for **every** notification type and sets scheduled report frequency to `off`, so re-enabling one type does not quietly resume reports. |

**Response — HTTP 200**

```json
{
  "success": true,
  "data": { "success": true, "message": "Successfully unsubscribed from all email notifications", "type": "ALL" }
}
```

| Error | Cause |
|-------|-------|
| `400 Unsubscribe token is required` | No token in query or body |
| `400 Invalid unsubscribe token format` / `Invalid or tampered unsubscribe token` / `Invalid unsubscribe token payload` | Token was truncated (common when mail clients wrap long URLs), edited, or signed with a different `JWT_SECRET` |
| `400 Unsubscribe token has expired` | Older than 30 days — the user can change preferences in-app instead |
| `404 User not found` | The user was deleted |

Unsubscribing is a **preference**, not a suppression: it does not add the address to `email_suppressions`, and the user can turn email back on at any time via `PATCH /api/v1/notifications/preferences`.

---

## Troubleshooting

Work through these checks in order when a user reports they are not receiving email.

### 1. Does the user have a valid email on file?

Look up the user's record (for example `SELECT id, email, "emailVerified" FROM users WHERE "stellarAddress" = '<G...>';`, or the user can check `GET /api/v1/users/me`). If `email` is empty, nothing is sent. Check for typos (`gmial.com`, trailing spaces) — those typically end up as hard bounces and then suppressions.

### 2. Is the address suppressed?

```bash
curl -s "https://api.example.com/api/v1/admin/email-suppressions?email=<address>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Logs show `Email to <address> skipped — address is on the suppression list` and, at suppression time, `Suppressed <address> (BOUNCE|COMPLAINT)`. If the address should receive mail, follow [Remove an address](#remove-an-address-from-the-suppression-list).

If **many** unrelated addresses are being skipped at once, check for `Suppression lookup failed for …` errors: the database is unreachable and sending is failing closed.

### 3. Did the user unsubscribe or turn email off?

Ask the user to check (or check on their behalf) `GET /api/v1/notifications/preferences`. If `email` is `false` for the relevant notification type, they unsubscribed or disabled it. Look for `User <id> unsubscribed from <type> email notifications` in the logs. Turning it back on via `PATCH /api/v1/notifications/preferences` resumes delivery. Quiet hours also delay (but do not drop) email.

### 4. Did the send fail at SMTP?

Check the notification's delivery log (`GET /api/v1/notifications/:id/deliveries`) and logs for `Email failed to <address>`. Common causes:

| Error | Fix |
|-------|-----|
| `ECONNREFUSED` / `ETIMEDOUT` | `SMTP_HOST`/`SMTP_PORT` wrong, or egress on port 587 blocked |
| `Invalid login` / `535` | `SMTP_USER`/`SMTP_PASS` wrong or rotated |
| `550 … sender not authorized` | `EMAIL_FROM` domain not verified at the provider |

The email queue retries failed sends with exponential backoff (`QUEUE_EMAIL_ATTEMPTS`, default 5). After the last attempt the job is failed — see [Queues](./queues.md).

### 5. Was it accepted but not delivered?

If the provider accepted the message (no SMTP error) but the user still has nothing:

- Check the provider's activity log for the recipient — it shows deferrals, soft bounces and spam-folder placement.
- Ask the user to check spam/junk and to allowlist `EMAIL_FROM`.
- Verify SPF, DKIM and DMARC for the `EMAIL_FROM` domain (for example with `dig TXT <domain>`).

### 6. Bounces are happening but nothing is suppressed

| Symptom | Cause / fix |
|---------|-------------|
| Webhook returns `401 Email webhook is not configured` | `EMAIL_WEBHOOK_SECRET` is not set on the API |
| Webhook returns `401 Missing webhook signature` | Provider/relay is not sending `X-Email-Signature` |
| Webhook returns `401 Invalid webhook signature` | Secret mismatch, or the body was modified/re-serialised between signing and receipt (proxy, pretty-printing, charset change). Sign the exact bytes you send. |
| `200` with `"suppressed": 0` | Event names or fields don't match the [classification table](#suppression-reasons) (e.g. provider uses `Type: "HardBounce"` — map it to `hard_bounce` in your relay), the bounce was soft, or the recipient field is not `email`/`recipient`. |
| Provider shows webhook timeouts | API not reachable from the provider — check ingress/WAF rules for `POST /api/v1/email/events`. |

### 7. Unsubscribe links do not work

- Links point at `localhost:3000` → set `API_BASE_URL` to the public API URL.
- All old links return `Invalid or tampered unsubscribe token` → `JWT_SECRET` was rotated; links in emails sent before the rotation are no longer valid. Users can manage preferences in-app.
- `Unsubscribe token has expired` → link older than 30 days; same remedy.
