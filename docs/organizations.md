# Organizations

Organizations let a group of Stellar addresses collaborate on shipments. An organization has its own roles, member list, audit log, and shared defaults. This guide covers the roles and their permissions, the full set of member-management and organization endpoints, and how org membership affects shipment access.

> **TL;DR** — Org membership grants **shared read visibility** over every member's shipment addresses. It **never** grants on-chain write rights, and access is revoked **immediately** when a member is removed.

---

## Roles and permissions

Every organization member has exactly one role. Roles are **rank-based**: a member may only act on other members whose rank is **strictly lower** than their own, and may only assign roles **strictly lower** than their own. This prevents privilege escalation and lateral takeovers.

| Rank | Role     | Description                                                        |
|------|----------|--------------------------------------------------------------------|
| 4    | `OWNER`  | Full control. Exactly one owner per organization.                  |
| 3    | `ADMIN`  | Manages members and settings below their rank.                     |
| 2    | `MEMBER` | Standard collaborator with shared read visibility.                 |
| 1    | `VIEWER` | Read-only observer.                                                |

### Permission matrix

| Action                                   | `VIEWER` | `MEMBER` | `ADMIN` | `OWNER` |
|------------------------------------------|:--------:|:--------:|:-------:|:-------:|
| Create organization                      | —        | —        | —       | — (any authenticated user may create one; creator becomes `OWNER`) |
| List members (`GET /organizations/:id/members`) | ✅ | ✅ | ✅ | ✅ |
| Add member (`POST /organizations/:id/members`)  | ❌ | ❌ | ✅ (may add `VIEWER`/`MEMBER` only) | ✅ (may add any role below `OWNER`) |
| Change role (`PATCH /organizations/:id/members/:userId`) | ❌ | ❌ | ✅ (target and new role must both be below `ADMIN`) | ✅ (target and new role must both be below `OWNER`) |
| Remove member (`DELETE /organizations/:id/members/:userId`) | ❌ | ❌ | ✅ (target must be below `ADMIN`) | ✅ (target must be below `OWNER`) |
| View audit logs (`GET /organizations/:id/audit-logs`) | ❌ | ❌ | ✅ | ✅ |
| Get defaults (`GET /organizations/:id/defaults`) | ✅ | ✅ | ✅ | ✅ |
| Update defaults (`PATCH /organizations/:id/defaults`) | ❌ | ❌ | ✅ | ✅ |

**Rank rules in practice**

- An `ADMIN` can add or promote someone to `VIEWER` or `MEMBER`, but cannot create another `ADMIN` or touch an existing `ADMIN`/`OWNER`.
- An `OWNER` can promote a `MEMBER` to `ADMIN`, but cannot demote or remove themselves; ownership transfer is out of scope for these endpoints.
- A `MEMBER` or `VIEWER` can read the member list and defaults but cannot mutate membership or settings.

---

## Endpoints

All endpoints require authentication (a valid bearer token identifying the caller's Stellar address). Path parameters are shown as `:id` (organization id) and `:userId` (member user id).

### Create an organization

`POST /organizations`

Any authenticated user may create an organization. The creator is automatically added as `OWNER`.

**Request**

```http
POST /organizations
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Acme Logistics",
  "slug": "acme-logistics"
}
```

**Response** `201 Created`

```json
{
  "id": "org_01HZX8K3Q9",
  "name": "Acme Logistics",
  "slug": "acme-logistics",
  "createdBy": "user_01HZX8K3Q9",
  "createdAt": "2024-06-01T12:00:00.000Z"
}
```

---

### List my organizations

`GET /organizations/mine`

Returns every organization the caller belongs to, along with the caller's role in each.

**Request**

```http
GET /organizations/mine
Authorization: Bearer <token>
```

**Response** `200 OK`

```json
[
  {
    "id": "org_01HZX8K3Q9",
    "name": "Acme Logistics",
    "slug": "acme-logistics",
    "role": "OWNER"
  },
  {
    "id": "org_01HZX9A2B7",
    "name": "Partner Freight",
    "slug": "partner-freight",
    "role": "MEMBER"
  }
]
```

---

### List members

`GET /organizations/:id/members`

Available to all roles (`VIEWER` and above).

**Request**

```http
GET /organizations/org_01HZX8K3Q9/members
Authorization: Bearer <token>
```

**Response** `200 OK`

```json
[
  {
    "userId": "user_01HZX8K3Q9",
    "stellarAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "role": "OWNER",
    "joinedAt": "2024-06-01T12:00:00.000Z"
  },
  {
    "userId": "user_01HZX9A2B7",
    "stellarAddress": "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "role": "MEMBER",
    "joinedAt": "2024-06-02T09:30:00.000Z"
  }
]
```

---

### Add a member

`POST /organizations/:id/members`

Requires `ADMIN` or `OWNER`. The caller may only assign a role strictly below their own rank.

The `AddOrganizationMemberDto` accepts **either** a `userId` **or** a `stellarAddress` to identify the new member (exactly one is required), plus the `role` to assign.

| Field           | Type   | Required | Notes                                                        |
|-----------------|--------|----------|--------------------------------------------------------------|
| `userId`        | string | one of   | Existing user id.                                            |
| `stellarAddress`| string | one of   | Stellar public key; resolved to a user.                      |
| `role`          | enum   | yes      | `VIEWER`, `MEMBER`, or `ADMIN` (never `OWNER`).              |

**Request (by user id)**

```http
POST /organizations/org_01HZX8K3Q9/members
Authorization: Bearer <token>
Content-Type: application/json

{
  "userId": "user_01HZX9A2B7",
  "role": "MEMBER"
}
```

**Request (by Stellar address)**

```http
POST /organizations/org_01HZX8K3Q9/members
Authorization: Bearer <token>
Content-Type: application/json

{
  "stellarAddress": "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "role": "VIEWER"
}
```

**Response** `201 Created`

```json
{
  "userId": "user_01HZX9A2B7",
  "stellarAddress": "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "role": "MEMBER",
  "joinedAt": "2024-06-02T09:30:00.000Z"
}
```

---

### Change a member's role

`PATCH /organizations/:id/members/:userId`

Requires `ADMIN` or `OWNER`. Both the **target member's current role** and the **new role** must be strictly below the caller's rank.

**Request**

```http
PATCH /organizations/org_01HZX8K3Q9/members/user_01HZX9A2B7
Authorization: Bearer <token>
Content-Type: application/json

{
  "role": "ADMIN"
}
```

**Response** `200 OK`

```json
{
  "userId": "user_01HZX9A2B7",
  "stellarAddress": "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "role": "ADMIN",
  "joinedAt": "2024-06-02T09:30:00.000Z"
}
```

---

### Remove a member

`DELETE /organizations/:id/members/:userId`

Requires `ADMIN` or `OWNER`. The target member's role must be strictly below the caller's rank. Removal takes effect **immediately** — the removed member loses shared read visibility on the next request (see [Shipment access](#how-org-membership-affects-shipment-access)).

**Request**

```http
DELETE /organizations/org_01HZX8K3Q9/members/user_01HZX9A2B7
Authorization: Bearer <token>
```

**Response** `204 No Content`

---

### View audit logs

`GET /organizations/:id/audit-logs`

Requires `ADMIN` or `OWNER`. Returns a chronological record of membership and settings changes.

**Request**

```http
GET /organizations/org_01HZX8K3Q9/audit-logs
Authorization: Bearer <token>
```

**Response** `200 OK`

```json
[
  {
    "id": "log_01HZXA1C2D",
    "actorId": "user_01HZX8K3Q9",
    "action": "MEMBER_ADDED",
    "targetUserId": "user_01HZX9A2B7",
    "metadata": { "role": "MEMBER" },
    "createdAt": "2024-06-02T09:30:00.000Z"
  },
  {
    "id": "log_01HZXA3E4F",
    "actorId": "user_01HZX8K3Q9",
    "action": "MEMBER_ROLE_CHANGED",
    "targetUserId": "user_01HZX9A2B7",
    "metadata": { "from": "MEMBER", "to": "ADMIN" },
    "createdAt": "2024-06-03T14:10:00.000Z"
  }
]
```

---

### Get organization defaults

`GET /organizations/:id/defaults`

Available to all roles (`VIEWER` and above). Defaults are applied to new shipments created by members.

**Request**

```http
GET /organizations/org_01HZX8K3Q9/defaults
Authorization: Bearer <token>
```

**Response** `200 OK`

```json
{
  "defaultCurrency": "USD",
  "defaultVisibility": "ORG",
  "notifyOnStatusChange": true
}
```

---

### Update organization defaults

`PATCH /organizations/:id/defaults`

Requires `ADMIN` or `OWNER`. Only the provided fields are updated.

**Request**

```http
PATCH /organizations/org_01HZX8K3Q9/defaults
Authorization: Bearer <token>
Content-Type: application/json

{
  "defaultVisibility": "PRIVATE",
  "notifyOnStatusChange": false
}
```

**Response** `200 OK`

```json
{
  "defaultCurrency": "USD",
  "defaultVisibility": "PRIVATE",
  "notifyOnStatusChange": false
}
```

---

## How org membership affects shipment access

Organization membership changes **who can read** shipment data — it does **not** change **who can write** it.

### Shared read visibility

While you are a member of an organization, every other member of that organization can **read** the shipment addresses associated with your account. This gives teams a shared view of shipments without requiring each member to be individually granted access.

- Visibility is **read-only** and applies to shipment **addresses** (the on-chain identifiers and their associated shipment records).
- It is **symmetric**: you see the shipments of other members, and they see yours.
- It applies to **all roles**, including `VIEWER`.

### No on-chain write rights

Org membership **never** grants the ability to sign transactions or otherwise write to the Stellar network on another member's behalf. On-chain write authority remains governed solely by possession of the relevant signing keys. Being an `OWNER` or `ADMIN` of an organization does not let you move funds, modify, or cancel another member's shipments on-chain.

### Immediate revocation on removal

When a member is removed (via `DELETE /organizations/:id/members/:userId`), their shared read visibility is revoked **immediately**. There is no grace period or cached access: subsequent requests from the removed member will no longer see the organization's shared shipment addresses, and remaining members will no longer see the removed member's shipments through the organization.

> **Note:** Removal is recorded in the audit log (`MEMBER_REMOVED`) so admins can trace access changes.