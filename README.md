# ChainSettle — Backend Repo

> **NestJS API for milestone-based supply chain escrow on Stellar**

This is **Repo 2 of 3** in the ChainSettle project:

| Repo | Description |
|------|-------------|
| `chainsetttle-contract` | Soroban smart contract (Rust) |
| `chainsetttle-backend` ← you are here | NestJS REST API + event poller |
| `chainsetttle-frontend` | React + Freighter wallet UI |

> **Contributing?** See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, branching/commit conventions, and PR expectations.

---

## What This Backend Does

The backend is the **bridge between the Stellar blockchain and the frontend**. It does NOT hold user funds or sign transactions on behalf of users — all fund movements are handled by the on-chain contract. The backend:

- Stores off-chain metadata about shipments and users (PostgreSQL via Prisma)
- Polls Stellar RPC every 5 seconds for contract events and updates local state
- Sends in-app and email notifications to relevant parties when milestones change
- Provides a clean REST API for the frontend to query shipment state
- Issues JWT tokens via a Stellar address signature (no passwords)
- Exposes Swagger docs at `/docs`

---

## Architecture

> For a deep-dive into module interactions, the event pipeline, shipment lifecycle, and cross-cutting concerns see [ARCHITECTURE.md](./ARCHITECTURE.md).
>
> For definitions of domain terms used throughout the codebase (shipment, milestone, arbiter, proof, dispute, escalation, reconciliation, reputation) see [docs/glossary.md](./docs/glossary.md).

```
┌─────────────────────────────────────────────────────┐
│                NestJS Application                    │
│                                                     │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │
│  │  Auth   │ │Shipments │ │Milestones│ │ Events │  │
│  │ Module  │ │  Module  │ │  Module  │ │ Module │  │
│  └─────────┘ └──────────┘ └──────────┘ └────────┘  │
│                                          ↑          │
│                                    Cron (5s poll)   │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │  PrismaService   │  │     StellarService        │ │
│  │  (PostgreSQL)    │  │  (Soroban RPC client)     │ │
│  └──────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────┘
         ↕                          ↕
   PostgreSQL DB           Stellar Testnet/Mainnet
                           (ChainSettle Contract)
```

---

## Module Overview

| Module | Responsibility |
|--------|---------------|
| `AuthModule` | Stellar address challenge-response auth → JWT |
| `ShipmentsModule` | CRUD for shipment records, sync from chain |
| `MilestonesModule` | Milestone state updates, proof hash storage |
| `EventsModule` | Stellar event poller (cron), event dispatch |
| `NotificationsModule` | In-app + email notifications via Nodemailer |
| `HealthModule` | `/health` endpoint for DB + service liveness |
| `PrismaModule` | Shared global DB client (PostgreSQL) |
| `StellarModule` | Shared global Stellar RPC client + utilities |

---

## API Endpoints

All endpoints are prefixed with `/api/v1` (URI versioning; see [API Versioning](#api-versioning) below). Protected routes require `Authorization: Bearer <JWT>`.

> Database schema reference (ERD + tables): [docs/database.md](./docs/database.md)
>
> Typed TypeScript SDK: [sdk/](./sdk/) — regenerate with `npm run generate:sdk`

### Auth
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/nonce?address=G...` | Get challenge nonce for a Stellar address |
| `POST` | `/auth/login` | Submit signed nonce, receive JWT |

### Shipments
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/shipments` | ✓ | Register on-chain shipment in DB |
| `GET` | `/shipments` | ✓ | List shipments (filters: buyer, supplier, status, `favorite=true`) |
| `GET` | `/shipments/:id` | ✓ | Full shipment detail + milestones + events (`isFavorited`) |
| `POST` | `/shipments/:id/favorite` | ✓ | Favorite (star) a shipment (participant only; private) |
| `DELETE` | `/shipments/:id/favorite` | ✓ | Remove shipment from caller's favorites |
| `POST` | `/shipments/:id/sync` | ✓ | Force sync shipment from Stellar chain |

### Milestones
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/shipments/:id/milestones` | ✓ | List all milestones for a shipment |
| `GET` | `/shipments/:id/milestones/:index` | ✓ | Get single milestone |
| `POST` | `/shipments/:id/milestones/:index/confirm` | ✓ | Confirm a single milestone (buyer) |
| `POST` | `/shipments/:id/milestones/bulk-confirm` | ✓ | Batch-confirm milestones (buyer) |

### Events (on-chain audit log)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/events` | ✓ | List chain events (filter by shipmentId) |

### Notifications
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/notifications` | ✓ | Get user notifications |
| `PATCH` | `/notifications/:id/read` | ✓ | Mark notification as read |
| `PATCH` | `/notifications/read-all` | ✓ | Mark all as read |
| `GET` | `/notifications/preferences` | ✓ | Get channel preferences (+ Slack webhook) |
| `PATCH` | `/notifications/preferences` | ✓ | Update preferences / Slack webhook URL |

### Health
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Database + service health check |

---

## Project Structure

```
chainsetttle-backend/
├── .env.example                     ← copy to .env and fill in values
├── .gitignore
├── nest-cli.json
├── package.json
├── tsconfig.json
├── README.md
│
├── prisma/
│   └── schema.prisma                ← Database schema (User, Shipment, Milestone, etc.)
│
└── src/
    ├── main.ts                      ← App bootstrap (Swagger, CORS, pipes, guards)
    ├── app.module.ts                ← Root module
    │
    ├── common/
    │   ├── prisma/
    │   │   ├── prisma.module.ts
    │   │   └── prisma.service.ts    ← PrismaClient wrapper
    │   ├── stellar/
    │   │   ├── stellar.module.ts
    │   │   └── stellar.service.ts   ← RPC client, event fetching, utilities
    │   ├── filters/
    │   │   └── http-exception.filter.ts  ← Standardised error responses
    │   ├── interceptors/
    │   │   └── transform.interceptor.ts  ← Wraps all responses in { success, data, timestamp }
    │   ├── guards/
    │   │   └── jwt-auth.guard.ts
    │   └── decorators/
    │       └── current-user.decorator.ts
    │
    └── modules/
        ├── auth/
        │   ├── auth.module.ts
        │   ├── auth.controller.ts
        │   ├── auth.service.ts      ← Nonce generation + JWT issuance
        │   ├── jwt.strategy.ts
        │   └── dto/login.dto.ts
        │
        ├── shipments/
        │   ├── shipments.module.ts
        │   ├── shipments.controller.ts
        │   ├── shipments.service.ts
        │   ├── shipments.service.spec.ts ← Unit tests
        │   └── dto/create-shipment.dto.ts
        │
        ├── milestones/
        │   ├── milestones.module.ts
        │   ├── milestones.controller.ts
        │   └── milestones.service.ts  ← DB updates triggered by chain events
        │
        ├── events/
        │   ├── events.module.ts
        │   ├── events.controller.ts
        │   └── events.service.ts    ← Stellar RPC poller (cron every 5s)
        │
        ├── notifications/
        │   ├── notifications.module.ts
        │   ├── notifications.controller.ts
        │   └── notifications.service.ts ← In-app + email via Nodemailer
        │
        └── health/
            ├── health.module.ts
            └── health.controller.ts
```

---

## Prerequisites

- **Node.js** v20+
- **pnpm** (recommended) or npm
- **PostgreSQL** 15+
- **Stellar CLI** (only needed if deploying the contract)

---

## Setup

### 1. Install dependencies

```bash
npm install
# or
pnpm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values:
- `DATABASE_URL` — your PostgreSQL connection string
- `JWT_SECRET` — a long random string
- `CHAINSETTTLE_CONTRACT_ID` — the deployed contract ID from `chainsetttle-contract`
- `SMTP_*` — email credentials (use Gmail app password or any SMTP)

### 3. Set up the database

```bash
# Create and apply migrations
npx prisma migrate dev --name init

# Generate Prisma client
npx prisma generate

# (Optional) seed initial data
# npx prisma db seed
```

### 4. Start the development server

```bash
npm run start:dev
```

API available at: `http://localhost:3000/api/v1`
Swagger docs at: `http://localhost:3000/docs`

---

## API Versioning

The API uses NestJS **URI versioning**. The global prefix is `api`; the version segment is `v1`, `v2`, etc.

| Version | Base path | Status |
|---------|-----------|--------|
| v1 | `/api/v1/*` | Current (default) |
| v2 | `/api/v2/*` | Introduce when you need a breaking change |

### Adding a `/api/v2` controller without touching v1

Create a parallel controller (new file) and set the version explicitly:

```ts
import { Controller, Get, Version } from '@nestjs/common';

// Option A — version on the controller
@Controller({ path: 'shipments', version: '2' })
export class ShipmentsV2Controller {
  @Get()
  listV2() { /* new response shape */ }
}

// Option B — version on a single handler inside a shared controller
@Controller('shipments')
export class ShipmentsController {
  @Get()
  @Version('1')
  listV1() { /* existing */ }

  @Get()
  @Version('2')
  listV2() { /* breaking change */ }
}
```

Register the new controller in the same module. Existing `@Controller('shipments')` handlers keep serving **v1** via `defaultVersion: '1'` in `main.ts`.

### Deprecation policy

When a v1 route is scheduled for removal:

1. Annotate it with `@DeprecatedRoute({ sunset: 'Wed, 01 Jul 2027 00:00:00 GMT', link: 'https://docs.example.com/migration' })`.
2. Clients receive `Deprecation` and `Sunset` response headers (and optional `Link`).
3. Keep the route until the Sunset date; then remove it once consumers have moved to v2.

`Deprecation` / `Sunset` / `Link` are exposed in CORS `exposedHeaders` so browsers can read them.

---

## TypeScript SDK

A typed client is generated from the Swagger/OpenAPI document into [`sdk/`](./sdk/):

```bash
npm run generate:sdk   # refresh openapi.json + schema.ts
npm run check:sdk      # CI: fail if sdk/ is stale
```

See [sdk/README.md](./sdk/README.md).

---

## Running Tests

```bash
# Unit tests
npm run test

# Unit tests with coverage
npm run test:cov

# Watch mode
npm run test:watch
```

---

## Authentication Flow

ChainSettle uses a **Sign-In With Stellar** pattern — no passwords:

```
1. Frontend → GET /auth/nonce?address=GABC...
   ← { nonce: "chainsetttle:GABC...:1234567890:abc123" }

2. User signs the nonce with Freighter wallet
   (Keypair.sign on the frontend)

3. Frontend → POST /auth/login
   { stellarAddress, signedNonce, signature }
   ← { accessToken: "eyJ..." }

4. All subsequent requests:
   Authorization: Bearer eyJ...
```

The backend verifies the signature against the public key, then issues a JWT. Wire up the `Keypair.verify()` call in `auth.service.ts` before production.

---

## Rate Limiting

All API routes are rate-limited via Redis-backed `@nestjs/throttler`. Defaults are controlled by `THROTTLE_TTL` (window seconds, default `60`) and `THROTTLE_LIMIT` (max requests per key, default `100`). Auth and upload routes use tighter per-route limits; some auth routes key by Stellar address instead of IP.

Every throttled response includes:

| Header | Meaning |
|--------|---------|
| `X-RateLimit-Limit` | Max requests allowed in the current window |
| `X-RateLimit-Remaining` | Requests left in the window (`0` when limited) |
| `X-RateLimit-Reset` | Seconds until the window resets |
| `Retry-After` | Present on `429` responses — same value as `X-RateLimit-Reset` |

These headers are CORS-exposed so browser clients can read them. Use `./test-rate-limit.sh` against a running local API to verify success and `429` header behavior.

---

## Local mock Stellar chain (frontend dev)

To iterate on the API/UI without a live testnet RPC:

```bash
npm run dev:mock-chain
# set STELLAR_RPC_URL=http://127.0.0.1:8787 and STELLAR_HORIZON_URL=http://127.0.0.1:8788
npm run start:dev
```

See [`test/mocks/README.md`](test/mocks/README.md) for tradeoffs. **Dev-only** — not for integration testing of real chain behavior.

---

## Stellar Event Polling

The `EventsService` runs a cron job every 5 seconds using `@nestjs/schedule`. It:

1. Calls `stellar.fetchContractEvents(lastProcessedLedger)` via the Soroban RPC
2. Routes each event to the correct handler (e.g. `handleMilestoneConfirmed`)
3. Updates Prisma DB records to reflect the new state
4. Triggers notifications to relevant Stellar addresses
5. Saves the raw event to `chain_events` for audit trail
6. Advances `lastProcessedLedger` cursor

For production, persist `lastProcessedLedger` in the DB (or Redis) so it survives restarts.

---

## Response Format

All responses are wrapped by the global `TransformInterceptor`:

```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-05-17T12:00:00.000Z"
}
```

Errors follow a standardised format from `HttpExceptionFilter`:

```json
{
  "success": false,
  "statusCode": 404,
  "timestamp": "2026-05-17T12:00:00.000Z",
  "path": "/api/v1/shipments/SHIP-999",
  "message": "Shipment SHIP-999 not found"
}
```

Send `Accept-Language: es` to receive Spanish error messages for mapped strings (falls back to English). See [`src/i18n/README.md`](src/i18n/README.md).

---

## SBOM (Software Bill of Materials)

Release builds generate a CycloneDX SBOM via [`.github/workflows/sbom.yml`](.github/workflows/sbom.yml). The artifact `sbom.cdx.json` is uploaded on release/tag runs and attached to GitHub Releases.

Regenerate locally (requires Node 20+ and an installed lockfile):

```bash
npm run sbom
# writes ./sbom.cdx.json from package-lock.json
```

---

## Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use a strong `JWT_SECRET` (32+ random chars)
- [ ] Swap in-memory nonce store for Redis
- [ ] Persist `lastProcessedLedger` in DB (not memory) for crash recovery
- [ ] Enable HTTPS (reverse proxy — nginx or Caddy)
- [ ] Set up Prisma connection pooling (PgBouncer)
- [ ] Configure `BACKUP_S3_BUCKET` + related secrets for automated encrypted DB backups (`.github/workflows/db-backup.yml` — see `docs/deployment.md`)
- [ ] Optionally set `DATABASE_REPLICA_URL` for read-heavy GET offload (see `docs/deployment.md`)
- [ ] Wire up real Stellar `Keypair.verify()` in `auth.service.ts`
- [ ] Set `CORS_ORIGIN` to your production frontend URL
- [ ] Add rate limiting tuning for production traffic
- [ ] Deploy via blue/green workflow (`.github/workflows/deploy-blue-green.yml` — see `docs/deployment.md`)
- [ ] Run `npm run loadtest` against staging before scale-up (see `docs/load-testing.md`)

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | Yes | `development` or `production` |
| `PORT` | No | API port (default: 3000) |
| `API_PREFIX` | No | Route prefix without version (default: `api`) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DATABASE_REPLICA_URL` | No | Optional read-replica URL for GET-heavy paths |
| `SHIPMENT_ARCHIVAL_DAYS` | No | Days before terminal shipments move to cold storage (default: 90) |
| `JWT_SECRET` | Yes | Secret for signing JWTs |
| `JWT_EXPIRES_IN` | No | Token expiry (default: `7d`) |
| `IMPERSONATION_JWT_EXPIRES_IN` | No | Admin impersonation token TTL (default: `15m`) |
| `STELLAR_NETWORK` | Yes | `testnet` or `mainnet` |
| `STELLAR_RPC_URL` | Yes | Soroban RPC endpoint |
| `CHAINSETTTLE_CONTRACT_ID` | Yes | Deployed contract address |
| `USDC_TOKEN_ADDRESS` | Yes | USDC SAC address |
| `SMTP_HOST` | No | Email SMTP host |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | SMTP password |
| `CORS_ORIGIN` | No | Allowed frontend origin |
| `EVENT_POLLING_INTERVAL_MS` | No | Cron interval in ms (default: 5000) |

---

## License

MIT
