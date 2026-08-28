# ADR-0004: Prisma / PostgreSQL as the off-chain data layer

**Status:** Accepted

## Context

ChainSettle needs to persist a rich domain model off-chain: users, shipments, milestones, proof submissions, dispute evidence, notifications, audit logs, webhook endpoints, and event cursors. This data is relational by nature (shipments have many milestones; milestones have many dispute evidences; users have many notifications and audit logs).

Requirements for the off-chain store:

- **ACID transactions** for financial-adjacent writes (creating a shipment + its milestones in a single transaction).
- **Rich querying** (filtering, pagination, aggregation, read replicas).
- **Schema evolution** (migrations must be version-controlled and reviewable).
- **Type-safe client** in TypeScript to reduce runtime query errors.

NoSQL alternatives (MongoDB, DynamoDB) were considered, but the domain is inherently relational and the team already had PostgreSQL expertise.

## Decision

Use **PostgreSQL** as the primary database and **Prisma** as the ORM / query builder.

Key design points:

- `prisma/schema.prisma` defines all models and enums. Enums (`ShipmentStatus`, `MilestoneStatus`, `UserRole`) mirror the on-chain Soroban contract enums so off-chain state stays in sync with on-chain state.
- `PrismaService` is a `@Global()` NestJS module, injected everywhere.
- Read replicas are supported via `DATABASE_REPLICA_URL`; read-heavy queries (e.g., `EventsService.findAll()`) explicitly use `this.prisma.read`.
- Connection pooling is configured via `DATABASE_CONNECTION_LIMIT` and `DATABASE_POOL_TIMEOUT`.
- Slow-query logging is enabled in development (`SLOW_QUERY_THRESHOLD_MS`, default 100 ms) via a Prisma query-event listener hooked into Winston.

## Consequences

- **Positive**
  - Strong consistency for shipment and milestone state — critical for a financial workflow.
  - Prisma's migrations (`prisma migrate dev`) are version-controlled and reviewable.
  - Type-safe generated client catches schema mismatches at compile time.
  - Rich relational queries (e.g., `ShipmentParticipantGuard` loading a shipment and its participants in one query).
  - Read-replica support improves read scalability without code duplication.
- **Negative**
  - PostgreSQL operational overhead (backups, vacuum, connection pool sizing).
  - Prisma's abstraction can hide SQL details; complex window functions or CTEs sometimes require `$queryRaw`.
  - Schema migrations in production require care (Prisma's migration engine is not zero-downtime for large tables).
- **Neutral**
  - The database URL is validated at boot to start with `postgres://` or `postgresql://` to prevent misconfiguration.
