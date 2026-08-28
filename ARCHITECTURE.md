# ChainSettle Backend — Architecture

> Deep-dive into module interactions, data flows, and cross-cutting concerns.
> For setup and API reference see [README.md](./README.md).
> For architectural decisions see [docs/adr/](./docs/adr/).

---

## Table of Contents

1. [High-Level Data Flow](#1-high-level-data-flow)
2. [Module Graph](#2-module-graph)
3. [Global vs Feature Modules](#3-global-vs-feature-modules)
4. [Module Reference](#4-module-reference)
5. [Shipment Lifecycle](#5-shipment-lifecycle)
6. [Event Pipeline — Stellar → Database → Notifications](#6-event-pipeline)
7. [Notification Fan-Out](#7-notification-fan-out)
8. [Scheduled Jobs](#8-scheduled-jobs)
9. [Cross-Cutting Concerns](#9-cross-cutting-concerns)
10. [Database Schema Overview](#10-database-schema-overview)
11. [Authentication & Authorisation](#11-authentication--authorisation)

---

## 1. High-Level Data Flow

```
                         ┌──────────────┐
                         │   Frontend   │  (React + Freighter)
                         └──────┬───────┘
                                │  REST  /api/v1/*
                                │  WS    /notifications
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                          NestJS Application                                    │
│                                                                               │
│  Middleware     RequestIdMiddleware  → attaches X-Request-ID to every request │
│                                                                               │
│  Guards (global) ThrottlerGuard → RolesGuard                                  │
│  Interceptors   AuditLogInterceptor · HttpMetricsInterceptor · Transform      │
│  Filters        HttpExceptionFilter · ThrottlerExceptionFilter                │
│  Pipe           ValidationPipe (whitelist + transform)                        │
│                                                                               │
│  ┌──────────┐ ┌──────────────┐ ┌─────────────┐ ┌────────────┐ ┌──────────┐  │
│  │   Auth   │ │  Shipments   │ │  Milestones │ │   Events   │ │  Health  │  │
│  │  Module  │ │    Module    │ │    Module   │ │   Module   │ │  Module  │  │
│  └──────────┘ └──────────────┘ └─────────────┘ └─────┬──────┘ └──────────┘  │
│                                                       │ streaming             │
│  ┌──────────────────────────────────────────┐         │                      │
│  │         NotificationsModule              │◄────────┘                      │
│  │  Service · Gateway (Socket.io) · Digest  │                                │
│  └────────────────────┬─────────────────────┘                                │
│                       │ webhooks                                              │
│               ┌───────▼──────┐                                               │
│               │  Webhooks    │                                                │
│               │   Module     │                                                │
│               └──────────────┘                                               │
│                                                                               │
│  ┌────────────────────┐  ┌──────────────────────────┐  ┌──────────────────┐  │
│  │   PrismaService    │  │     StellarService        │  │   RedisService   │  │
│  │   (PostgreSQL)     │  │  (Soroban RPC + Horizon)  │  │   (ioredis)      │  │
│  └────────────────────┘  └──────────────────────────┘  └──────────────────┘  │
│                                                                               │
│  ┌──────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ │
│  │   IPFS   │ │  TokenRegistry   │ │  MetricsModule   │ │   AuditLogs      │ │
│  │  Module  │ │     Module       │ │  (Prometheus)    │ │    Module        │ │
│  └──────────┘ └──────────────────┘ └──────────────────┘ └──────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
       │  PostgreSQL                │  Soroban RPC / Horizon
       ▼                            ▼
  PostgreSQL DB            Stellar Testnet / Mainnet
                           (ChainSettle Soroban Contract)
```

---

## 2. Module Graph

Arrows indicate an explicit NestJS `imports: [...]` dependency. `@Global()` modules are available everywhere without being listed in `imports`.

```
AppModule
├── [Global] ConfigModule
├── [Global] PrismaModule
├── [Global] StellarModule
├── [Global] RedisModule
├── [Global] IpfsModule          ← depends on RedisModule (caching)
├── [Global] TokenRegistryModule
├── [Global] MetricsModule       ← registers Prometheus counters/gauges
│
├── ThrottlerModule (Redis-backed storage)
├── ScheduleModule
├── TerminusModule
│
├── AuthModule
│   ├── PassportModule
│   ├── JwtModule
│   ├── NotificationsModule ─────────────────────────────────────────┐
│   └── AuditLogsModule ─────────────────────────────────────────────┤
│                                                                     │
├── ShipmentsModule                                                   │
│   ├── NotificationsModule ──────────────────────────────────────────┤ (same instance)
│   ├── RedisModule (rate-limit caching)                              │
│   └── AuditLogsModule ─────────────────────────────────────────────┤
│                                                                     │
├── MilestonesModule                                                  │
│   ├── NotificationsModule ──────────────────────────────────────────┤
│   ├── ShipmentsModule ◄── exports ShipmentsService                  │
│   └── AuditLogsModule ─────────────────────────────────────────────┤
│                                                                     │
├── EventsModule                                                      │
│   ├── MilestonesModule ◄── exports MilestonesService               │
│   ├── NotificationsModule ──────────────────────────────────────────┘
│   └── ShipmentsModule ◄── exports ShipmentsService
│
├── NotificationsModule
│   ├── JwtModule (for WS gateway token verification)
│   └── WebhooksModule ◄── exports WebhooksService
│       └── AuditLogsModule
│
├── AuditLogsModule  (exports AuditLogService + AuditLogInterceptor)
│
├── WebhooksModule   (exports WebhooksService)
├── HealthModule
├── ChainModule
└── ShipmentTemplatesModule
```

Key takeaway: `NotificationsModule` is a shared feature module (not `@Global()`), re-exported by any module that needs it. NestJS deduplicates the providers, so only one `NotificationsService` instance exists at runtime.

---

## 3. Global vs Feature Modules

### Global Infrastructure (`@Global()`)

These providers are injected across the entire application without each consumer needing to list them in `imports`.

| Module | File | Exported providers |
|--------|------|--------------------|
| `ConfigModule` | NestJS built-in | `ConfigService` |
| `PrismaModule` | `src/common/prisma/` | `PrismaService` |
| `StellarModule` | `src/common/stellar/` | `StellarService` |
| `RedisModule` | `src/common/redis/` | `RedisService` |
| `IpfsModule` | `src/common/ipfs/` | `IpfsService` |
| `TokenRegistryModule` | `src/common/token-registry/` | `TokenRegistryService` |
| `MetricsModule` | `src/common/metrics/` | `MetricsService` + Prometheus counters |

### Feature Modules

These must be explicitly imported. They encapsulate a bounded domain.

| Module | File | Key exports |
|--------|------|-------------|
| `AuthModule` | `src/modules/auth/` | `AuthService` |
| `ShipmentsModule` | `src/modules/shipments/` | `ShipmentsService` |
| `MilestonesModule` | `src/modules/milestones/` | `MilestonesService` |
| `EventsModule` | `src/modules/events/` | _(internal only)_ |
| `NotificationsModule` | `src/modules/notifications/` | `NotificationsService`, `NotificationsGateway` |
| `AuditLogsModule` | `src/modules/audit-logs/` | `AuditLogService`, `AuditLogInterceptor` |
| `WebhooksModule` | `src/modules/webhooks/` | `WebhooksService` |
| `HealthModule` | `src/modules/health/` | _(endpoint only)_ |
| `ChainModule` | `src/modules/chain/` | _(endpoint only)_ |
| `ShipmentTemplatesModule` | `src/modules/shipment-templates/` | _(internal only)_ |

---

## 4. Module Reference

### AuthModule (`src/modules/auth/`)

Implements Sign-In With Stellar — no passwords.

- `AuthService` — nonce generation (Redis-backed), Stellar signature verification, JWT issuance and refresh, API-key management, user profile CRUD.
- `JwtStrategy` — Passport strategy; validates Bearer token, attaches `User` to request.
- `ApiKeyStrategy` — Passport strategy; validates `X-API-Key` header, looks up hashed key in `api_keys` table.
- `StellarAddressThrottlerGuard` — overrides the IP-based throttler on `/auth/*` routes to key rate limits by Stellar address instead.
- Controllers: `AuthController`, `UsersController`, `ApiKeysController`.

### ShipmentsModule (`src/modules/shipments/`)

Owns shipment CRUD and chain sync.

- `ShipmentsService` — create, list, get, sync, cancel, archive, export (CSV), bulk-import (CSV draft shipments), watcher management, tagging, tracking updates.
- `CommentsService` — threaded comments on shipments with visibility scoping (`ALL`, `BUYER_SUPPLIER`, `INTERNAL`) and @mention detection.
- `ShipmentParticipantGuard` (`src/modules/shipments/guards/`) — module-level guard that enforces only buyers, suppliers, logistics, or arbiters of a shipment can access its routes. Reads `:id` from route params and checks against `shipments` table.
- Controllers: `ShipmentsController`, `AdminShipmentsController`, `CommentsController`.

### MilestonesModule (`src/modules/milestones/`)

Manages milestone state machine and proof files.

- `MilestonesService` — proof upload to IPFS, `markProofSubmitted`, `markConfirmed`, `markDisputed`, `markResolved`, dispute-evidence CRUD, milestone rebalancing, arbiter acceptance.
- `MilestoneDeadlineJob` — hourly cron; notifies buyers and suppliers when `dueAt` passes and `overdueNotifiedAt` is null. Sends a second reminder after `OVERDUE_REMINDER_3_DAYS` (default 3 days).
- `DisputeEscalationJob` — hourly cron; escalates milestones stuck in `DISPUTED` for > `DISPUTE_ESCALATION_DAYS` (default 7) by alerting all `ADMIN` users.

### EventsModule (`src/modules/events/`)

Drives the on-chain to off-chain synchronisation.

- `EventsService` — see [§6 Event Pipeline](#6-event-pipeline).
- `ReconciliationJob` — weekly cron (Sundays 02:00 UTC); scans all `ACTIVE` shipments, calls `stellar.getShipmentState()` for each, compares against DB, and triggers `shipments.syncStatusFromChain()` for any mismatch. Results saved to `reconciliation_runs`.
- `EventsController` — exposes `GET /events` (paginated chain event log) and admin endpoints for the DLQ (`GET /events/admin/failed`, `POST /events/admin/failed/:id/retry`, `GET /events/cursor`).

### NotificationsModule (`src/modules/notifications/`)

Real-time and asynchronous notification delivery.

- `NotificationsService` — see [§7 Notification Fan-Out](#7-notification-fan-out).
- `NotificationsGateway` — Socket.io gateway on the `/notifications` namespace. Authenticates via JWT passed in `handshake.auth.token`. Places each connection in a room `user:<userId>`. Supports client-side type filtering via `subscribe`/`unsubscribe` messages.
- `NotificationDigestJob` — daily cron (08:00 UTC). Skips users with `digestFrequency = 'instant'`. Only processes weekly users on Mondays. Builds an HTML digest of unread notifications and sends it via Nodemailer.

### WebhooksModule (`src/modules/webhooks/`)

HTTP callbacks for external integrations.

- `WebhooksService` — `dispatch(eventType, payload)` fans out to all active `WebhookEndpoint` records that subscribe to the given `NotificationType`. Signs each payload with HMAC-SHA256 using the endpoint's stored secret. Persists delivery attempts to `webhook_deliveries`. Retries with exponential back-off.

### AuditLogsModule (`src/modules/audit-logs/`)

Immutable record of all write operations.

- `AuditLogService` — `log(userId, action, entityType, entityId, metadata)` writes to `audit_logs`.
- `AuditLogInterceptor` — registered globally as `APP_INTERCEPTOR`; runs after every mutating request (`POST`, `PUT`, `PATCH`, `DELETE`), extracts actor identity from the JWT, and calls `AuditLogService.log()`.
- `AuditLogsController` — admin-only `GET /audit-logs` endpoint with filtering.

---

## 5. Shipment Lifecycle

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          SHIPMENT LIFECYCLE                                  │
│                                                                              │
│  1. CREATION                                                                 │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Frontend calls Soroban contract directly (Freighter signs the tx)           │
│         │                                                                    │
│         ▼                                                                    │
│  Frontend → POST /api/v1/shipments                                           │
│         │   Body: { id, buyerAddress, supplierAddress, logisticsAddress,     │
│         │           arbiterAddress, tokenAddress, milestones[], ... }        │
│         ▼                                                                    │
│  ShipmentsController → ShipmentsService.create()                            │
│    • Validates milestone sum === 100%  (MilestoneSumValidator)               │
│    • Looks up token metadata via TokenRegistryService                        │
│    • Inserts Shipment + Milestone rows in Prisma ($transaction)              │
│    • MetricsService.incrementShipmentsCreated()                              │
│    • Notifies buyer/supplier via NotificationsService (SHIPMENT_CREATED)     │
│    • AuditLogInterceptor records the write                                   │
│                                                                              │
│  2. PROOF SUBMISSION                                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Supplier/Logistics calls Soroban contract (Freighter)                       │
│         │                                                                    │
│         ▼                                                                    │
│  Frontend → POST /api/v1/shipments/:id/milestones/:index/proof (multipart)  │
│         ▼                                                                    │
│  MilestonesController → MilestonesService.submitProof()                     │
│    • Enforces caller is supplierAddress or logisticsAddress                  │
│    • Uploads file to IPFS via IpfsService → returns CID                     │
│    • Updates Milestone.status = PROOF_SUBMITTED, .proofHash = CID           │
│    • Inserts ProofSubmission row                                             │
│    • Notifies buyer (PROOF_SUBMITTED) via NotificationsService               │
│    • AuditLog records the write                                              │
│                                                                              │
│  EventsService also picks up on-chain proof_submitted event asynchronously  │
│  and calls MilestonesService.markProofSubmitted() as a safety net           │
│                                                                              │
│  3. MILESTONE CONFIRMATION                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Buyer confirms on-chain via Freighter                                       │
│         │                                                                    │
│         │  [EventsService receives milestone_confirmed event]                │
│         ▼                                                                    │
│  EventsService.handleMilestoneConfirmed()                                   │
│    • Deduplication check: if already CONFIRMED, skip                         │
│    • MilestonesService.markConfirmed(shipmentId, index, paymentAmount)       │
│       └─ Updates Milestone.status = CONFIRMED                                │
│       └─ Sets .confirmedAt, .paymentReleased                                 │
│    • ShipmentsService.syncStatusFromChain(shipmentId)                       │
│       └─ Queries Soroban RPC for current contract state                     │
│       └─ Updates Shipment.status (→ COMPLETED if all milestones done)       │
│    • NotificationsService.notifyUser(supplierAddress, PAYMENT_RELEASED)     │
│    • NotificationsService.notifyWatchers(shipmentId, MILESTONE_CONFIRMED)   │
│                                                                              │
│  Alternatively, buyer can also call:                                         │
│  POST /api/v1/shipments/:id/milestones/:index/confirm                       │
│  → MilestonesController → MilestonesService.confirm()                       │
│  (same DB writes; event handler deduplicates on CONFIRMED check)             │
│                                                                              │
│  4. DISPUTE (optional path)                                                  │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Buyer raises dispute on-chain                                               │
│         │                                                                    │
│         ▼                                                                    │
│  EventsService.handleDisputeRaised()                                        │
│    • MilestonesService.markDisputed(shipmentId, index)                       │
│       └─ Milestone.status = DISPUTED                                         │
│    • Notifies supplier + arbiter (DISPUTE_RAISED)                            │
│                                                                              │
│  Supplier/Buyer submit evidence via:                                         │
│  POST /api/v1/shipments/:id/milestones/:index/dispute-evidence              │
│  → MilestonesService.submitDisputeEvidence() → IPFS upload + DB insert      │
│                                                                              │
│  DisputeEscalationJob (hourly) alerts ADMINs after 7 days unresolved        │
│                                                                              │
│  Arbiter resolves on-chain                                                   │
│         │                                                                    │
│         ▼                                                                    │
│  EventsService.handleDisputeResolved()                                       │
│    • MilestonesService.markResolved(shipmentId, index, approved)             │
│       └─ RESOLVED if approved, back to PENDING if rejected                  │
│    • Notifies buyer + supplier (DISPUTE_RESOLVED)                            │
│                                                                              │
│  5. CANCELLATION                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Buyer cancels on-chain OR via DELETE /api/v1/shipments/:id                 │
│         │                                                                    │
│         ▼                                                                    │
│  ShipmentsService.cancel()                                                  │
│    • Sets Shipment.status = CANCELLED, .cancelledAt = now                   │
│    • Notifies all participants (SHIPMENT_CANCELLED)                          │
│    • EventsService.handleShipmentCancelled() calls the same method          │
│      with a null callerAddress; 409 conflict = already cancelled, skip       │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Event Pipeline

The `EventsService` is the backbone that keeps the database in sync with on-chain state.

### Startup / Cursor Initialisation (`onModuleInit`)

```
EventsService.onModuleInit()
  ├─ prisma.eventCursor.findUnique({ id: 'main' })
  │    ├─ Found  → lastProcessedLedger = cursor.lastProcessedLedger  (resume)
  │    └─ Not found → stellar.getLatestLedger()
  │                   seedLedger = latestLedger - 10
  │                   prisma.eventCursor.create({ id: 'main', seedLedger })
  │
  └─ startStreamSubscription()
```

### Streaming Subscription

```
stellar.subscribeToContractEvents(fromLedger, callback)
  │
  │  [for each on-chain event emitted by the ChainSettle contract]
  ▼
EventsService.processEvent(event)
  ├─ extractEventName(event)    // reads event.topic[0]
  ├─ extractPayload(event)      // JSON-serialises event.value
  ├─ saveRawEvent()             // upsert into chain_events (idempotent on txHash+eventName)
  ├─ executeHandler(eventName, payload, event)
  │    ├─ 'shipment_created'    → handleShipmentCreated()  (safety-net only)
  │    ├─ 'proof_submitted'     → handleProofSubmitted()
  │    │     └─ milestones.markProofSubmitted()
  │    │     └─ notifications.notifyUser(buyer, PROOF_SUBMITTED)
  │    ├─ 'milestone_confirmed' → handleMilestoneConfirmed()
  │    │     └─ dedup check (already CONFIRMED? skip)
  │    │     └─ milestones.markConfirmed()
  │    │     └─ shipments.syncStatusFromChain()
  │    │     └─ notifications.notifyUser(supplier, PAYMENT_RELEASED)
  │    │     └─ notifications.notifyWatchers(shipmentId, MILESTONE_CONFIRMED)
  │    ├─ 'dispute_raised'      → handleDisputeRaised()
  │    │     └─ milestones.markDisputed()
  │    │     └─ notifications.notifyUser(supplier, DISPUTE_RAISED)
  │    │     └─ notifications.notifyUser(arbiter, DISPUTE_RAISED)
  │    ├─ 'dispute_resolved'    → handleDisputeResolved()
  │    │     └─ milestones.markResolved()
  │    │     └─ notifications.notifyUser(buyer, DISPUTE_RESOLVED)
  │    │     └─ notifications.notifyUser(supplier, DISPUTE_RESOLVED)
  │    └─ 'shipment_cancelled'  → handleShipmentCancelled()
  │          └─ shipments.cancel(shipmentId, null, txHash)
  │
  ├─ metrics.incrementEventsProcessed(eventName)
  ├─ lastProcessedLedger = max(lastProcessedLedger, event.ledger + 1)
  └─ prisma.eventCursor.update({ lastProcessedLedger })
```

### DLQ — Failed Events

When a handler throws, the event is written to `failed_events` and retried by a `@Cron(EVERY_MINUTE)` job:

```
retryFailedEvents()  ← runs every minute
  ├─ prisma.failedEvent.findMany({ resolvedAt: null, attemptCount < 5 })
  ├─ Filter: only retry when backoff window has elapsed
  │   backoffMs = 2^(attemptCount - 1) × 60 000 ms   (exponential, up to ~16 min)
  ├─ executeHandler() on each eligible event
  │    ├─ Success → failedEvent.resolvedAt = now
  │    └─ Failure → attemptCount++, lastAttemptAt = now
  │                  if attemptCount >= 5 → alertAdmins() (SYSTEM_ALERT notification)
  └─ Admin can also retry manually via POST /api/v1/events/admin/failed/:id/retry
```

### Reconciliation (Weekly)

```
ReconciliationJob  ← @Cron('0 2 * * 0')  (Sundays 02:00 UTC)
  ├─ prisma.shipment.findMany({ status: ACTIVE })
  ├─ For each shipment:
  │   ├─ stellar.getShipmentState(shipmentId)
  │   └─ Compare on-chain status with DB status
  │       └─ Mismatch → shipments.syncStatusFromChain(shipmentId)
  └─ Writes result to reconciliation_runs (checkedCount, mismatchCount, errors)
```

---

## 7. Notification Fan-Out

Every call to `NotificationsService.notifyUser()` fans out through four channels in sequence:

```
notifyUser(stellarAddress, type, title, message, data?)
  │
  ├─ prisma.user.findUnique({ stellarAddress })
  │    └─ Not found? → warn + return (no error thrown)
  │
  ├─ getOrCreatePreferences(userId)
  │    └─ Checks NotificationPreference.preferences[type].inApp
  │         └─ inApp = false? → return (all channels suppressed)
  │
  ├─ ① prisma.notification.create(...)         [always, if inApp = true]
  │
  ├─ ② Email via Nodemailer                    [if prefs[type].email && user.email]
  │    ├─ renderTemplate(type, data)           // loads .hbs file from templates/
  │    │    Available templates: DISPUTE_RAISED, PROOF_SUBMITTED, PAYMENT_RELEASED
  │    │    Falls back to inline HTML if no template exists for the type
  │    └─ transporter.sendMail(to, subject, html)
  │         └─ prisma.notification.update({ emailSent: true })
  │
  ├─ ③ WebSocket push via NotificationsGateway
  │    └─ gateway.pushToUser(userId, notification)
  │         └─ server.sockets.adapter.rooms.get('user:<userId>')
  │              └─ For each socket: check typeFilters → emit 'notification' event
  │                  (sockets without a filter receive all types)
  │
  └─ ④ Webhooks via WebhooksService           [fire-and-forget, errors swallowed]
       └─ webhooks.dispatch(type, { notificationId, ...data })
            └─ prisma.webhookEndpoint.findMany({ events: { has: type }, active: true })
                 └─ For each endpoint: HMAC-sign payload → HTTP POST → persist delivery
```

`notifyWatchers()` is a lighter variant that inserts notifications in bulk (`createMany`) for all users watching a shipment, then pushes via the gateway. It does **not** send emails.

`notifyUserWithForcedEmail()` bypasses the `email` preference check — used for high-priority direct mentions.

---

## 8. Scheduled Jobs

| Job | Class | Schedule | Location |
|-----|-------|----------|----------|
| Event stream reconnect | `EventsService` | continuous (streaming) | `src/modules/events/events.service.ts` |
| DLQ retry | `EventsService.retryFailedEvents()` | every minute | `src/modules/events/events.service.ts` |
| State reconciliation | `ReconciliationJob` | Sundays 02:00 UTC | `src/modules/events/reconciliation.job.ts` |
| Milestone deadline check | `MilestoneDeadlineJob` | every hour | `src/modules/milestones/milestone-deadline.job.ts` |
| Dispute escalation | `DisputeEscalationJob` | every hour | `src/modules/milestones/dispute-escalation.job.ts` |
| Notification digest | `NotificationDigestJob` | daily 08:00 UTC | `src/modules/notifications/notification-digest.job.ts` |

All jobs are registered as providers inside their respective modules and rely on `ScheduleModule.forRoot()` (registered in `AppModule`).

---

## 9. Cross-Cutting Concerns

All of the following live under `src/common/`.

### Request Lifecycle (in order)

```
Incoming HTTP request
  │
  ▼
RequestIdMiddleware          src/common/middleware/request-id.middleware.ts
  Attaches X-Request-ID header (UUID). Runs before all guards.
  │
  ▼
ThrottlerGuard (APP_GUARD)   ThrottlerModule + RedisThrottlerStorageService
  Default: 100 req / 60 s per IP, stored in Redis for multi-pod consistency.
  Auth routes use StellarAddressThrottlerGuard (keyed by address, not IP).
  │
  ▼
RolesGuard (APP_GUARD)       src/common/guards/roles.guard.ts
  Reads @Roles(...) decorator from handler/class.
  If no roles required → passes through.
  If roles required → checks req.user.role.
  │
  ▼
JwtAuthGuard / ApiKeyGuard   src/common/guards/jwt-auth.guard.ts
  (applied per controller, not globally)
  @Public() decorator bypasses JWT check.
  API key auth via X-API-Key header using ApiKeyStrategy.
  │
  ▼
ShipmentParticipantGuard     src/modules/shipments/guards/shipment-participant.guard.ts
  (applied at controller level on shipment/milestone routes)
  Loads Shipment from DB; enforces caller is buyer, supplier, logistics, or arbiter.
  │
  ▼
ValidationPipe               configured in main.ts
  whitelist: true — strips unknown fields.
  transform: true — coerces query params to declared types.
  forbidNonWhitelisted: true — rejects unknown fields.
  │
  ▼
Route Handler
  │
  ▼
AuditLogInterceptor (APP_INTERCEPTOR)   src/modules/audit-logs/audit-log.interceptor.ts
  Intercepts POST/PUT/PATCH/DELETE responses.
  Writes actor + action + entity to audit_logs after the handler completes.
  │
  ▼
HttpMetricsInterceptor (APP_INTERCEPTOR)   src/common/interceptors/http-metrics.interceptor.ts
  Records request duration in chainsettle_http_request_duration_seconds histogram.
  Labels: method, route path, HTTP status.
  │
  ▼
TransformInterceptor (global)   src/common/interceptors/transform.interceptor.ts
  Wraps every successful response body:
  { success: true, data: <original>, timestamp: "..." }
  │
  ▼
HttpExceptionFilter (global)   src/common/filters/http-exception.filter.ts
  Normalises NestJS HTTP exceptions:
  { success: false, statusCode, timestamp, path, message }

ThrottlerExceptionFilter (global)   src/common/filters/throttler-exception.filter.ts
  Handles ThrottlerException with a 429 response.
```

### Decorators

| Decorator | File | Purpose |
|-----------|------|---------|
| `@Public()` | `src/common/decorators/public.decorator.ts` | Marks a route as open (bypass JwtAuthGuard) |
| `@CurrentUser()` | `src/common/decorators/current-user.decorator.ts` | Extracts `req.user` into a parameter |
| `@Roles(...roles)` | `src/common/decorators/roles.decorator.ts` | Declares required `UserRole` values for RolesGuard |
| `@IsStellarAddress()` | `src/common/decorators/is-stellar-address.decorator.ts` | class-validator rule for G... Stellar addresses |
| `@IsContractAddress()` | `src/common/decorators/is-contract-address.decorator.ts` | class-validator rule for C... Soroban contract addresses |

### Logging

`src/common/logger/winston.logger.ts` — creates a Winston logger wired into NestJS's `LoggerService`. Slow SQL queries (> `SLOW_QUERY_THRESHOLD_MS`, default 100 ms) are logged as `warn` in development via a Prisma query event listener.

### Validators

`src/common/validators/milestone-sum.validator.ts` — custom class-validator constraint that ensures milestone `paymentPercent` values sum to exactly 100. Applied to `CreateShipmentDto`.

### Security Headers

Helmet is applied in `main.ts` with:
- Custom CSP: `default-src 'self'`
- HSTS: max-age 1 year, includeSubDomains
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- X-Powered-By removed

### Metrics (`/metrics`)

The `GET /metrics` endpoint is excluded from the `/api/v1` prefix so Prometheus can scrape it directly. Exposed metrics:

| Metric | Type | Labels |
|--------|------|--------|
| `chainsettle_events_processed_total` | Counter | `eventName` |
| `chainsettle_events_failed_total` | Counter | — |
| `chainsettle_shipments_created_total` | Counter | — |
| `chainsettle_active_shipments` | Gauge | — |
| `chainsettle_http_request_duration_seconds` | Histogram | `method`, `route`, `status` |
| Node.js default metrics | (various) | — |

---

## 10. Database Schema Overview

The schema is in `prisma/schema.prisma`. Key relationships:

```
User ────────────────────────────────────────────────────────────────────┐
  │  (buyerAddress / supplierAddress / logisticsAddress / arbiterAddress) │
  ▼                                                                       │
Shipment ──────────── Milestone ──────── ProofSubmission                  │
  │                       │                                              │
  │                       ├──────────── DisputeEvidence ◄── User         │
  │                       └─ (status machine)                            │
  │                            PENDING                                   │
  │                            PROOF_SUBMITTED                           │
  │                            CONFIRMED                                 │
  │                            DISPUTED                                  │
  │                            RESOLVED                                  │
  │                                                                       │
  ├── ChainEvent     (raw on-chain events, linked to Shipment)            │
  ├── ShipmentComment ◄── User                                            │
  ├── ShipmentNote ◄── User                                               │
  ├── TrackingUpdate ◄── User                                             │
  └── ShipmentWatcher ◄── User                                            │
                                                                          │
User ◄───────────────────────────────────────────────────────────────────┘
  ├── Notification
  ├── NotificationPreference   (per-type inApp/email flags + digestFrequency)
  ├── AuditLog
  ├── ApiKey
  ├── WebhookEndpoint ──── WebhookDelivery
  └── ShipmentTemplate

EventCursor          (single row 'main'; tracks lastProcessedLedger)
FailedEvent          (DLQ; events that errored during processing)
ReconciliationRun    (audit trail for weekly reconciliation job)
AppConfig            (key/value store for runtime config)
```

Enums mirror the on-chain Soroban contract:
- `ShipmentStatus`: `ACTIVE`, `COMPLETED`, `CANCELLED`
- `MilestoneStatus`: `PENDING`, `PROOF_SUBMITTED`, `CONFIRMED`, `DISPUTED`, `RESOLVED`
- `UserRole`: `BUYER`, `SUPPLIER`, `LOGISTICS`, `ARBITER`, `ADMIN`

---

## 11. Authentication & Authorisation

### Sign-In With Stellar (challenge-response)

```
1.  GET /api/v1/auth/nonce?address=G<pubkey>
      → AuthService.generateNonce()
        • Creates / upserts User row
        • Generates nonce string: "chainsetttle:<address>:<timestamp>:<random>"
        • Stores nonce in Redis with 5-min TTL (key: nonce:<address>)
      ← { nonce: "chainsetttle:GABC...:1234567890:abc123" }

2.  User signs nonce bytes with Freighter (ed25519)

3.  POST /api/v1/auth/login  { stellarAddress, signature }
      → AuthService.login()
        • Fetches nonce from Redis; deletes it immediately (one-time use)
        • Keypair.verify(nonce bytes, signature, publicKey)
        • Issues access JWT (sub = userId, stellarAddress)
        • Issues refresh token (stored hashed in Redis)
      ← { accessToken, refreshToken, expiresIn }

4.  POST /api/v1/auth/refresh  { refreshToken }
      → Validates refresh token hash in Redis → issues new access JWT

5.  POST /api/v1/auth/logout
      → Deletes refresh token from Redis
```

### API Keys

Machine clients can authenticate with a static API key instead of JWT:
- Key created via `POST /api/v1/auth/api-keys` (requires active JWT)
- SHA-256 hash stored in `api_keys` table; plaintext returned once at creation
- `X-API-Key: <plaintext>` header → `ApiKeyStrategy` hashes and looks up

### Authorisation Layers

1. **ThrottlerGuard** (global) — rate limiting by IP; auth routes use `StellarAddressThrottlerGuard` (by address).
2. **JwtAuthGuard / ApiKeyGuard** (per-controller) — validates Bearer token or X-API-Key.
3. **RolesGuard** (global) — checks `req.user.role` against `@Roles()` decorator.
4. **ShipmentParticipantGuard** (shipment/milestone controllers) — ensures caller is a direct participant of the specific shipment.
