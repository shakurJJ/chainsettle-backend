# Roles & Permissions (RBAC)

ChainSettle has two independent layers of access control, and conflating them is the most common source of confusion when reading a controller:

1. **Global role (`UserRole`)** — a single field on `User` (`BUYER | SUPPLIER | LOGISTICS | ARBITER | ADMIN`, default `BUYER`), enforced by the global `RolesGuard` reading `@Roles(...)` decorators. **In this codebase, `@Roles()` is used exclusively as an ADMIN-vs-everyone gate** — every `@Roles()` decorator in the repo names only `UserRole.ADMIN`; none of the other four values are ever passed to it.
2. **Per-shipment participant identity** — whether the caller's Stellar address matches a *specific shipment's* `buyerAddress` / `supplierAddress` / `logisticsAddress` / `arbiterAddress`. This is unrelated to the caller's `UserRole` field and is enforced either by `ShipmentParticipantGuard` (route-level) or by manual address-comparison checks inside the relevant service (throwing `ForbiddenException`).

So "can this BUYER do X" almost never means "does `user.role === BUYER`" — it means "is `user.stellarAddress` the `buyerAddress` on *this* shipment". A user's global `UserRole` mostly just labels their primary intent at signup; a single user can be the buyer on one shipment and, in principle, hold any role field while still acting as e.g. the arbiter on another shipment (participant addresses are independent of the account's `role` field).

Roles are set on `User.role` at signup (default `BUYER`) and can only be changed by an admin via `PATCH /users/admin/:id/role`.

---

## 1. Admin-only endpoints (`@Roles(UserRole.ADMIN)`)

These require a valid JWT **and** `user.role === ADMIN`. Every row below is enforced by the `@Roles()` decorator (cross-checked against every `@Roles(` occurrence in `src/`), except where noted as manually enforced.

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/ipfs-config` | Read IPFS pinning configuration |
| `PATCH` | `/admin/ipfs-config` | Update IPFS pinning configuration |
| `POST` | `/admin/tokens` | Register a new supported token |
| `PATCH` | `/admin/tokens/:address` | Update a token's config (enable/disable, etc.) |
| `GET` | `/admin/arbiters` | List every known arbiter with cached reputation |
| `POST` | `/admin/arbiters/:address/reputation/recompute` | Force an out-of-cycle reputation recompute |
| `GET` | `/admin/shipments/stuck` | Find ACTIVE shipments with no recent milestone activity |
| `POST` | `/admin/shipments/:id/force-sync` | Resync a shipment from chain, bypassing participant guard |
| `POST` | `/shipments/:id/notes` | Create an admin note on a shipment |
| `GET` | `/shipments/:id/notes` | List admin notes on a shipment |
| `GET` | `/admin/audit-logs` | List audit log entries |
| `GET` | `/admin/audit-logs/export` | Export audit log entries |
| `GET` | `/admin/audit-logs/resource/:resourceType/:resourceId` | Audit trail for one resource |
| `GET` | `/admin/audit-logs/:id` | Get a single audit log entry |
| `GET` | `/events/admin/failed-events` | List unresolved failed on-chain events (DLQ) |
| `POST` | `/events/admin/failed-events/:id/retry` | Manually retry a failed event |
| `GET` | `/admin/health/dependencies` | Detailed dependency health check |
| `GET` | `/users/admin/users` | List all users |
| `POST` | `/users/admin/:id/deactivate` | Deactivate a user account |
| `POST` | `/users/admin/:id/reactivate` | Reactivate a user account |
| `GET` | `/users/admin/:id` | Get any user by id |
| `PATCH` | `/users/admin/:id/role` | Change a user's role *(manually enforced — see [Caveats](#3-caveats--known-inconsistencies))* |
| `POST` | `/admin/users/:id/impersonate` | Start an impersonation session for a user |
| `POST` | `/admin/webhooks/:id/deliveries/replay` | Bulk-replay failed webhook deliveries in a date range (#308) |

`ADMIN` also **bypasses** `ShipmentParticipantGuard` everywhere it's used (see §2) — an admin can read any shipment's detail, milestones, tracking, etc. without being a participant. It does **not** bypass the buyer/supplier/logistics/arbiter-only *mutation* checks below (e.g. `PATCH /shipments/:id`) — those compare the caller's address directly to the shipment record and have no admin override, so an admin must use the dedicated `/admin/*` routes for actions like force-sync instead.

---

## 2. Shipment & milestone participant matrix

These endpoints are **not** gated by `UserRole` — they're gated by whether the caller's Stellar address matches the given field on the specific shipment referenced in the URL. "✅ (own)" means: allowed only when the caller is that role *on that shipment*.

| Action | Buyer | Supplier | Logistics | Arbiter | Admin | Enforcement |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Create shipment (`POST /shipments`) | ✅ (as self only) | ❌ | ❌ | ❌ | ✅ (any buyer) | Controller: `dto.buyerAddress` must equal caller's address, unless caller is admin |
| List shipments (`GET /shipments`) | ✅ (own only) | ✅ (own only) | ✅ (own only) | ✅ (own only) | ✅ (all) | Service scopes to shipments where caller is any participant; admin unscoped + can filter by buyer/supplier address |
| View shipment detail / participants / tracking / refund / approvals / value time-series / `:id/export` / `calendar.ics` | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (any) | `ShipmentParticipantGuard` (admin bypass built in) |
| Update shipment metadata (`PATCH /shipments/:id`) | ✅ (own) | ❌ | ❌ | ❌ | ❌ *(no bypass)* | Service: `shipment.buyerAddress !== caller` → 403 |
| Cancel shipment | ✅ (own) | ❌ | ❌ | ❌ | ❌ *(no bypass)* | Service: buyer-only |
| Clone shipment | ✅ (own) | ❌ | ❌ | ❌ | ❌ *(no bypass)* | Service: buyer-only |
| Archive / unarchive shipment | ✅ (own) | ❌ | ❌ | ❌ | ❌ *(no bypass)* | Service: buyer-only |
| Add / remove shipment tags | ✅ (own) | ❌ | ❌ | ❌ | ❌ *(no bypass)* | Service: buyer-only |
| Favorite / unfavorite shipment | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ | `ShipmentParticipantGuard` |
| Replace shipment tags (`PUT :id/tags`), get participants | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ | `ShipmentParticipantGuard` |
| Watch / unwatch shipment | ✅ | ✅ | ✅ | ✅ | ✅ | Any authenticated user (no participant check) |
| Accept / decline arbiter assignment | ❌ | ❌ | ❌ | ✅ (own, designated arbiter) | ❌ | Service: `shipment.arbiterAddress !== caller` → 403 |
| Record multi-sig approval (`POST :id/approve`) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (own) | ❌ *(admin isn't a shipment participant unless also an address on the record)* | Service: caller's address must be one of the 4 participant fields |
| Submit tracking update (`POST :id/tracking`) | ❌ | ❌ | ✅ (own) | ❌ | ❌ *(no bypass)* | Service: `logisticsAddress`-only |
| View tracking updates (`GET :id/tracking`) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (own) | — *(see caveats)* | Service: any of the 4 participant addresses |
| Submit milestone proof (`POST milestones/:index/proof`) | ❌ | ✅ (own) | ✅ (own) | ❌ | ❌ *(no bypass)* | Service: supplier **or** logistics address only |
| Confirm milestone | ✅ (own) | ❌ | ❌ | ❌ | ❌ *(no bypass)* | Service: buyer-only |
| Reject proof / bulk-reject | ✅ (own) | ❌ | ❌ | ❌ | ❌ *(no bypass)* | Service: buyer-only |
| Append / remove / rebalance milestones | ✅ (own) | ❌ | ❌ | ❌ | ❌ *(no bypass)* | Service: buyer-only |
| View milestone list / one / dispute detail / reminders / proof history | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ | `ShipmentParticipantGuard` (most routes) |
| View dispute evidence (`GET :index/evidence/:evidenceId`) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ | Service-side: participant-or-admin check |
| Post / read shipment comments | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (read only) | Service: participant-only to post; participant-or-admin to read |
| Pin / unpin a comment | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ | `ShipmentParticipantGuard` |
| Delete a comment | Comment author only | Comment author only | Comment author only | Comment author only | ✅ (any) | Service: author or admin |

Notes:
- "**❌ *(no bypass)***" flags mutation endpoints that check the caller's address literally against the shipment record with **no** `user.role === ADMIN` escape hatch — an admin who needs to force one of these through uses the dedicated `/admin/shipments/:id/force-sync` route instead (there is no admin equivalent for cancel/clone/archive/tag actions; those remain strictly buyer-controlled by design).
- A given user can be the buyer on one shipment and the supplier/logistics/arbiter on another — participation is per-shipment, not a global relationship.

## 2a. Shipment templates (ownership, not participation)

| Action | Rule |
|---|---|
| Create a template | Any authenticated user (owns what they create) |
| Create a template from an existing shipment | Shipment **buyer** only |
| List public + own templates, get one, list "mine" | Any authenticated user |
| Preview a **private** template | Template owner only |
| Update / change visibility / delete a template | Template owner only |

## 2b. Webhooks (ownership, not participation)

| Action | Rule |
|---|---|
| Register / list / get / delete own webhook endpoint, bulk-test | Endpoint owner only (scoped by `userId` from the JWT) |
| Rotate endpoint secret, retry a single failed delivery | Endpoint owner only — service throws if `endpoint.userId !== caller` |
| Bulk-replay failed deliveries by date range (`POST /admin/webhooks/:id/deliveries/replay`) | **Admin only** (`@Roles(ADMIN)`) — not scoped to the admin's own endpoints; any endpoint's deliveries can be replayed |

## 2c. Self-scoped endpoints (any authenticated user, own data only)

`GET/PATCH /users/me*`, `DELETE /users/me`, device-token endpoints, `GET /users/:stellarAddress` (any user's public profile), API key create/delete (delete is owner-only), notification list/read/preferences, saved shipment filters, KYC initiate/status/withdraw, calendar-token minting — all scoped by `@CurrentUser('id')`/`@CurrentUser('stellarAddress')` passed into the service layer, not by role.

## 2d. Any-authenticated-user endpoints (no ownership or role restriction)

`GET /events`, `GET /tokens`, `GET /tokens/:address`, `GET /ipfs/:cid[/status]`, `GET /arbiters/:address/reputation`, `GET /arbiters/:address/history`, `GET /chain/ledger/:number`, `GET /chain/account/:address`.

## 2e. Public endpoints (no JWT required)

`GET /auth/nonce`, `POST /auth/login`, `GET /auth/verify-email`, `GET /kyc/requirements`, `POST /kyc/webhook` (HMAC-signed instead — see [docs/kyc-integration.md](./kyc-integration.md)), `GET /health`, `GET /health/live`, `GET /health/ready`, `GET /chain/status`, `GET /users/me/milestones/calendar.ics` (token-in-query-param gated, not JWT — calendar apps can't send an `Authorization` header).

---

## 3. Caveats & known inconsistencies

These are documented here because they affect what the matrix above actually guarantees — flagged for accuracy, not fixed as part of this doc:

- **`PATCH /users/admin/:id/role` has no `@Roles()` decorator.** It's admin-only in practice only because the handler manually checks `if (user?.role !== 'ADMIN') throw new ForbiddenException(...)`. Functionally equivalent to the decorator today, but it means this one route wouldn't be caught by a "grep for `@Roles`" audit — if the manual check is ever refactored away, the route would silently open up to any authenticated user.
- **`GET /events/admin/failed-events/:id` and `GET /events/admin/cursor` are broken as written.** Both call `this.requireAdmin(user)` with a `@CurrentUser()` parameter, but `src/modules/events/events.controller.ts` neither imports `CurrentUser` nor defines a `requireAdmin` method anywhere in the class. Unlike their sibling routes (`GET /events/admin/failed-events`, `POST /events/admin/failed-events/:id/retry`), which correctly use `@Roles(UserRole.ADMIN)`, these two routes are not currently enforceable as documented and should not be relied on until fixed.
- **`MilestonesService.submitDisputeEvidence()`** (buyer-or-supplier-only) has no corresponding controller route anywhere in the codebase — it's unreachable from HTTP today, despite a matching DTO existing. Not included in the matrix above as a live endpoint.
- **Admin does not have blanket override on shipment mutation endpoints.** Buyer/supplier/logistics/arbiter-only actions (update, cancel, clone, archive, tag edits, tracking submission, milestone confirm/reject/append/rebalance) compare the caller's address directly to the shipment record with no `role === ADMIN` escape hatch. This is different from `ShipmentParticipantGuard`-protected *read* endpoints, which do let admins through. Don't assume "admin can do anything" holds for these write paths.
- **`GET /shipments/:id/tracking`** checks participant address membership directly in the service (not via `ShipmentParticipantGuard`), so it does not get the guard's admin bypass — worth re-verifying if admin access to tracking history is expected.

---

## Cross-reference

- Role enum source: `UserRole` in [`prisma/schema.prisma`](../prisma/schema.prisma).
- Decorator/guard source: [`src/common/decorators/roles.decorator.ts`](../src/common/decorators/roles.decorator.ts), [`src/common/guards/roles.guard.ts`](../src/common/guards/roles.guard.ts) (global `APP_GUARD` in `src/app.module.ts`), [`src/modules/shipments/guards/shipment-participant.guard.ts`](../src/modules/shipments/guards/shipment-participant.guard.ts).
- GraphQL (`src/modules/graphql/`) reuses `ShipmentsService.findOne`/`findAll` under a `GqlJwtAuthGuard`, so the same participant scoping applies there; no `@Roles()` is used in the GraphQL module.
