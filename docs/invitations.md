# Invitations

Invitations let a buyer (or any authenticated user) invite a counterparty — a supplier, logistics provider, or arbiter — by email, even if that person does not yet have an account. This document describes the full lifecycle: how an invitation is created, how the recipient receives and uses the token, and what happens when things go wrong.

## Flow overview

```
 Buyer                         Platform                         Recipient
   |                               |                                 |
   |-- POST /invitations --------->|                                 |
   |   { email, role, ... }        |                                 |
   |                               |-- generate 32-byte token        |
   |                               |-- store SHA-256(token) + TTL    |
   |<-- 201 { id, email, ... } ----|                                 |
   |                               |-- send email with token link -->|
   |                               |                                 |
   |                               |<-- GET /invitations/:token -----|
   |                               |    (recipient opens link)       |
   |                               |                                 |
   |                               |<-- sign up or log in -----------|
   |                               |                                 |
   |                               |<-- POST /invitations/:token/accept
   |                               |-- verify hash, TTL, unused      |
   |                               |-- mark invitation used          |
   |                               |-- grant role / link shipment -->|
   |                               |                                 |
   |                               |--- 200 { accepted: true } ----->|
```

1. **Invite** — An authenticated user calls `POST /invitations` with the recipient's email and the role to grant.
2. **Email** — The platform generates a random token, stores only its hash, and emails a link containing the raw token to the recipient. The raw token is never stored or logged.
3. **Sign up / log in** — The recipient follows the link. If they do not have an account, they register; otherwise they log in. The token remains valid until it is accepted or expires.
4. **Accept** — The recipient calls `POST /invitations/:token/accept`. The platform verifies the token, marks the invitation as used, and applies the granted role (and shipment link, if any).

## Token lifecycle

| Property | Value |
| --- | --- |
| Generation | 32 random bytes, encoded for use in a URL |
| Delivery | Emailed once to the invited address; never returned by the API |
| Storage | Only the SHA-256 hash of the token is persisted |
| TTL | 7 days from creation (`INVITATION_TTL_MS`) |
| Reuse | Single-use; enforced by a conditional update that only succeeds while the invitation is unused and unexpired |

The raw token exists only in the invitation email. Because only its hash is stored, a database leak does not expose usable tokens. An invitation becomes unusable once it is accepted or once its TTL elapses; there is no way to "un-use" a token.

## Security notes

- **Never logged.** The raw token must not appear in application logs, error messages, or analytics. Only the invitation `id` and recipient email may be logged.
- **Hashed at rest.** The database stores `sha256(token)`; lookups hash the presented token and compare.
- **Rate limited.** Each user may send at most **20 invitations per day**. Exceeding this returns `429`.
- **Role restriction.** Invitations may only grant `SUPPLIER`, `LOGISTICS`, or `ARBITER`. Other roles are rejected with `400`.
- **Email-bound.** The invitation is addressed to a specific email; accepting it with a different account should be treated as a mismatch by the client flow.

## Example payloads

### Create an invitation

`POST /invitations`

```json
{
  "email": "supplier@example.com",
  "role": "SUPPLIER",
  "shipmentId": "shp_01H8Z3K4Q9",
  "templateId": "tpl_7f2c"
}
```

`CreateInvitationDto` fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `email` | string | yes | Recipient address; must be a valid email |
| `role` | enum | yes | One of `SUPPLIER`, `LOGISTICS`, `ARBITER` |
| `shipmentId` | string | no | Links the invitation to a shipment |
| `templateId` | string | no | Applies an invitation template |

Response `201 Created`:

```json
{
  "id": "inv_01H8Z4M2R7",
  "email": "supplier@example.com",
  "role": "SUPPLIER",
  "shipmentId": "shp_01H8Z3K4Q9",
  "status": "PENDING",
  "expiresAt": "2024-06-15T12:00:00.000Z",
  "createdAt": "2024-06-08T12:00:00.000Z"
}
```

Note that the response never contains the token.

### List sent invitations

`GET /invitations/sent`

Response `200 OK`:

```json
[
  {
    "id": "inv_01H8Z4M2R7",
    "email": "supplier@example.com",
    "role": "SUPPLIER",
    "status": "PENDING",
    "expiresAt": "2024-06-15T12:00:00.000Z",
    "createdAt": "2024-06-08T12:00:00.000Z"
  },
  {
    "id": "inv_01H8Z3A1B2",
    "email": "logistics@example.com",
    "role": "LOGISTICS",
    "status": "ACCEPTED",
    "expiresAt": "2024-06-10T09:30:00.000Z",
    "createdAt": "2024-06-03T09:30:00.000Z"
  }
]
```

### Accept an invitation

`POST /invitations/:token/accept`

No request body is required; the token is carried in the path.

Response `200 OK`:

```json
{
  "accepted": true,
  "role": "SUPPLIER",
  "shipmentId": "shp_01H8Z3K4Q9"
}
```

## Error responses

| Status | Condition | Example body |
| --- | --- | --- |
| `400 Bad Request` | Validation failure — invalid email, missing `role`, or a role outside `SUPPLIER`/`LOGISTICS`/`ARBITER` | `{ "statusCode": 400, "message": "role must be one of SUPPLIER, LOGISTICS, ARBITER" }` |
| `401 Unauthorized` | Caller is not authenticated | `{ "statusCode": 401, "message": "Unauthorized" }` |
| `404 Not Found` | No invitation matches the presented token | `{ "statusCode": 404, "message": "Invitation not found" }` |
| `410 Gone` | Invitation has expired or was already used | `{ "statusCode": 410, "message": "Invitation expired or already used" }` |
| `429 Too Many Requests` | Sender has reached the daily limit of 20 invitations | `{ "statusCode": 429, "message": "Daily invitation limit reached" }` |

## Related documents

- [Shipment lifecycle](./shipment-lifecycle.md) — how invitations fit into the broader shipment flow.