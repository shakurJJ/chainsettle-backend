# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- CHANGELOG.md now tracks API changes for frontend and webhook integrators.

## [0.1.0] - 2026-08-28

### Added

- **Authentication & API keys**
  - Stellar nonce-challenge login (`GET /auth/nonce`, `POST /auth/login`) issuing JWTs.
  - API key authentication strategy for machine-to-machine integrators, with endpoints
    to create, list, get, patch, and delete API keys.
  - JWT + WebSocket notification gateway authentication.
  - Rate limiting on auth endpoints to prevent nonce-flooding attacks; Redis-backed nonce store.
  - Refresh / logout DTOs and endpoint groundwork.

- **Shipments**
  - Shipment registration, listing (with filters), detail, and on-chain sync.
  - Shipment favorites, cloning, cancellation (with on-chain tx hash verification), and
    comments and notes.
  - Shipment context fields, tag replacement, role summary, and `my-role` query.
  - Shipment CSV import and shipment-derived templates.
  - Redis response caching for the shipment list; shipment watchers and optimized search queries.

- **Milestones**
  - Milestone lifecycle (list, detail, confirm), milestone payment percent validation, and
    evidence proof submission with resubmission history.
  - Bulk milestone confirmation and multi-threshold overdue reminders with escalation.
  - Buyer rejection of proofs and append/remove milestone operations.

- **Events (on-chain audit log)**
  - Durable event polling, idempotent database storage, and cursor-based pagination.
  - ScVal encoding for `syncStatusFromChain` and shipment-reviewed event streaming.
  - Failed-event DLQ with single-fetch admin endpoint.

- **Notifications & Webhooks**
  - Notifications read/preferences, daily email digest cron, and Slack notifications.
  - WebSocket notifications gateway with JWT.
  - Webhook detail/event-types endpoints, webhook delivery detail, and secret rotation.

- **IPFS**
  - IPFS proof upload service with SHA-256 Redis dedup cache.
  - IPFS config, IPFS proxy, IPFS health check, and pin status.

- **Templates**
  - Reusable escrow shipment templates for milestones/payments, with preview.

- **Arbitration & Disputes**
  - Arbiter assignment workflow with acceptance confirmation and arbiter reputation.
  - Dispute evidence submission and dispute resolution escalation cron.

- **Chain & Token registry**
  - Multi-token support and `GET /tokens` token registry.
  - `GET /chain/status`, `GET /chain/account/:address`, and `GET /chain/ledger/:number`.

- **Admin & Governance**
  - Admin shipment tools, audit log export, impersonation, and admin user tools.
  - `POST /admin/tokens` for registering payment tokens.
  - Shipment cold archival.

- **Security, Compliance & Ops**
  - Audit logging, KYC gating, FX USD estimates, and GDPR export.
  - Env validation, roles guard, Prisma pool config, and shipment cold archival.
  - API versioning (`/api/v1` + `/api/v2`), read replicas, blue-green deploys, Helm charts,
    k6 load tests, i18n, rate-limit headers, mock chain, and SBOM CI.

### Fixed

- IPFS dedup via SHA-256 Redis cache in `IpfsService.uploadFile`.
- Milestone percent validation enforcing a 100% sum.

---

## How to update this file

Every feature PR **must** add an entry under `[Unreleased]` in the relevant
`Added` / `Changed` / `Fixed` / `Removed` section before it can be merged. When a release is
cut, rename `[Unreleased]` to the new version and date, then start a fresh `[Unreleased]`
section. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full PR checklist.

[Unreleased]: https://github.com/shakurJJ/chainsettle-backend/compare/0.1.0...HEAD
[0.1.0]: https://github.com/shakurJJ/chainsettle-backend/releases/tag/0.1.0
