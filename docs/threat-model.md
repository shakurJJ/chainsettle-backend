# Threat Model — ChainSettle Backend

## Overview & Scope

ChainSettle is a decentralized supply chain escrow backend deployed on Stellar. The backend coordinates shipment lifecycles, milestone validations, dispute resolutions, metadata indexing, and notification dispatch.

### Core Security Tenet: Non-Custodial Architecture
The backend **signs nothing on users' behalf** and holds no private keys or escrow funds. Funds reside strictly inside Soroban smart contracts on the Stellar network. The backend serves as an untrusted-to-trusted relay for escrow metadata, off-chain document proofs, and state synchronization.

---

## Trust Boundaries & System Architecture

```
                    ┌─────────────────────────┐
                    │   Clients (Web / CLI)   │
                    │  (React, Freighter SDK) │
                    └───────────┬─────────────┘
                                │  [Boundary 1: Public Internet / TLS]
                                │  REST /api/v1/* · WebSocket /notifications
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ChainSettle API Layer (NestJS)                        │
│                                                                             │
│  - Middleware: RequestIdMiddleware, BodyLimitMiddleware                     │
│  - Guards: RateLimitThrottlerGuard, JwtAuthGuard, RolesGuard                │
│  - Strategies: PassportJwtStrategy, ApiKeyStrategy                          │
│  - Interceptors: HttpMetricsInterceptor, TransformInterceptor               │
│  - Pipes: ValidationPipe (whitelist: true, transform: true)                 │
└──────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────┘
       │              │              │              │              │
[Boundary 2]   [Boundary 3]   [Boundary 4]   [Boundary 5]   [Boundary 6]  [Boundary 7]
       │ TLS          │ Auth/TLS     │ API/TLS      │ JSON-RPC     │ HMAC-SHA256 │ HTTPS
       ▼              ▼              ▼              ▼              ▼             ▼
┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────┐
│  PostgreSQL  ││    Redis     ││  IPFS Node   ││ Stellar RPC  ││ External     ││ KYC Provider │
│  (Prisma)    ││  (ioredis)   ││ (Kubo/Gatew) ││  & Horizon   ││ Webhook      ││ API          │
│              ││              ││              ││              ││ Consumers    ││              │
└──────────────┘└──────────────┘└──────────────┘└──────────────┘└──────────────┘└──────────────┘
```

---

## Trust Boundaries Analysis

| Boundary | Interfacing Components | Trust Level Transition | Protocol & Transport | Authentication & Cryptography |
|---|---|---|---|---|
| **Boundary 1** | Clients ↔ NestJS API | Untrusted Public Internet → Application Perimeter | HTTPS / WSS (TLS 1.3) | Stellar Challenge/Response (ed25519), JWT, API Key (SHA-256) |
| **Boundary 2** | API ↔ PostgreSQL DB | Application Perimeter → Internal Data Store | TCP (TLS within VPC) | Database user credentials, Prisma parameterised SQL |
| **Boundary 3** | API ↔ Redis Cache | Application Perimeter → Ephemeral State Store | TCP / TLS (Internal VPC) | Redis `AUTH`, TLS channel encryption |
| **Boundary 4** | API ↔ IPFS Daemon | Application Perimeter → Content-Addressable Storage | HTTP / RPC | CIDv1 cryptographic hash verification |
| **Boundary 5** | API ↔ Stellar Horizon / Soroban RPC | Application Perimeter → External Blockchain Network | HTTPS / JSON-RPC | Multi-node quorum verification, non-custodial transaction envelope inspection |
| **Boundary 6** | API ↔ Webhook Endpoints | Application Perimeter → External Third-Party Systems | HTTPS Outbound | HMAC-SHA256 request payload signatures (`X-Signature`) |
| **Boundary 7** | API ↔ KYC Provider | Application Perimeter → External Regulated Vendor | HTTPS Outbound / Inbound Webhook | API secrets, mutual TLS / webhook signature verification |

---

## STRIDE Threat Analysis per Boundary

### 1. Clients ↔ NestJS API (Perimeter)

* **Spoofing**
  * *Threat*: An attacker impersonates a buyer, seller, or arbiter to authorize illegitimate shipment actions or milestone approvals.
  * *Mitigation*: Multi-layer authentication. Wallet challenge-response authentication using Stellar ed25519 keypair verification (`src/modules/auth/auth.service.ts`), signed JWT tokens (`src/common/guards/jwt-auth.guard.ts`), and SHA-256 hashed API keys (`src/modules/auth/strategies/api-key.strategy.ts`). Critical escrow state releases require Soroban contract signatures directly from user wallets, ensuring backend spoofing cannot release funds.
* **Tampering**
  * *Threat*: Tampering with payload data (e.g. shipment milestone values, dispute comments, or metadata).
  * *Mitigation*: Strict global `ValidationPipe` with whitelist validation, rejecting unrecognised request properties (`src/main.ts`). Payload size limits enforced by `BodyLimitMiddleware` (`src/common/middleware/body-limit.middleware.ts`).
* **Repudiation**
  * *Threat*: A participant claims they did not initiate a state change or milestone claim.
  * *Mitigation*: Immutable on-chain transaction records on Stellar; structured audit logging interceptors recording user address, IP address, request ID, and timestamp (`src/modules/audit-logs/`).
* **Information Disclosure**
  * *Threat*: Unauthorized users reading private shipment agreements, counterparty details, or API keys.
  * *Mitigation*: Role-based access control via `RolesGuard` (`src/common/guards/roles.guard.ts`) and organization/participant authorization filters preventing unauthorized query access (`src/modules/shipments/`). API key plaintext is displayed once at creation and only stored as SHA-256 hash (`docs/api-keys.md`).
* **Denial of Service (DoS)**
  * *Threat*: Flooding endpoints to starve server resources or exhaust connection pools.
  * *Mitigation*: Redis-backed tiered rate limiting (`RateLimitThrottlerGuard` in `src/common/guards/rate-limit-throttler.guard.ts` and `StellarAddressThrottlerGuard` in `src/common/guards/stellar-address-throttler.guard.ts`). Payload size enforcement via `BodyLimitMiddleware`.
* **Elevation of Privilege**
  * *Threat*: A standard user accessing admin or arbiter capabilities.
  * *Mitigation*: Strict role hierarchy enforcement via `@Roles()` and `RolesGuard`, plus `ImpersonationGuard` (`src/common/guards/impersonation.guard.ts`) restricting administrative impersonation.

---

### 2. API ↔ PostgreSQL Database (Data Layer)

* **Tampering / SQL Injection**
  * *Threat*: Malicious input leading to arbitrary database query manipulation or data corruption.
  * *Mitigation*: Exclusive use of Prisma ORM (`src/common/prisma/prisma.service.ts`) with prepared and parameterised statements. Raw queries are audited and disallow raw string interpolations.
* **Information Disclosure**
  * *Threat*: Leaked database backups or intercepted wire data exposing KYC and escrow records.
  * *Mitigation*: Database credentials managed strictly through environment variables validated at startup (`src/config/env.validation.ts`). SSL enforced for database connections in staging and production.

---

### 3. API ↔ Redis (Ephemeral & Rate Limiting State)

* **Tampering / Cache Poisoning**
  * *Threat*: Poisoning cached exchange rates or IPFS CID metadata.
  * *Mitigation*: Short TTLs on cached external rates (`src/common/fx/fx-rate.service.ts`), cryptographic CID verification before serving cached IPFS documents, and authenticated Redis connections (`src/common/redis/redis.service.ts`).
* **Denial of Service**
  * *Threat*: Cache exhaustion leading to backend rate-limiter collapse or unbounded memory consumption.
  * *Mitigation*: Memory maxmemory eviction policies (`volatile-lru`), partitioned key namespaces, and isolated connections for rate limiting and pub/sub.

---

### 4. API ↔ IPFS (Decentralized File Storage)

* **Tampering / Content Substitution**
  * *Threat*: An attacker alters evidence documents or delivery receipts uploaded to IPFS.
  * *Mitigation*: Cryptographic content-addressing (CIDv1). The hash embedded in the metadata contract guarantees bitwise immutability (`src/common/ipfs/ipfs.service.ts`).
* **Malicious File Upload / Resource Exhaustion**
  * *Threat*: Uploading malicious executables or gigabyte-sized files to overwhelm pinning storage.
  * *Mitigation*: Enforced file-type filtering, MIME-type sniffing, and strict upload payload size caps (`src/common/ipfs/ipfs.controller.ts`).

---

### 5. API ↔ Stellar Network & Soroban RPC (Blockchain Layer)

* **Spoofing / RPC Hijacking**
  * *Threat*: Rogue or compromised RPC endpoints returning falsified blockchain heights or transaction statuses.
  * *Mitigation*: Multi-endpoint fallback and quorum verification via `RpcPool` (`src/common/stellar/rpc-pool.ts`). Critical escrow assertions verify transaction confirmation depths and final ledger hashes.
* **Frontrunning / Reorgs**
  * *Threat*: Temporary ledger reorgs causing milestone release desynchronization.
  * *Mitigation*: The backend waits for ledger irreversibility confirmations before updating local tracking states (`src/common/stellar/stellar.service.ts`). Escrow fund release is enforced exclusively on-chain by the Soroban smart contract rules.

---

### 6. API ↔ Webhook Consumers (External Outbound)

* **Tampering / Man-in-the-Middle**
  * *Threat*: Interception or alteration of outbound webhook notifications to ERP/supply-chain systems.
  * *Mitigation*: Outbound webhooks are signed using HMAC-SHA256 (`X-Signature` header) with per-subscriber secrets (`src/modules/webhooks/webhooks.service.ts`). Enforced HTTPS for destination URLs.
* **SSRF (Server-Side Request Forgery)**
  * *Threat*: Malicious users registering loopback or private IP webhook URLs (e.g. `http://169.254.169.254` or `http://localhost:5432`) to probe internal infrastructure.
  * *Mitigation*: Webhook destination URL validation filtering private CIDRs, localhost, and cloud metadata endpoints prior to dispatch.

---

### 7. API ↔ KYC Provider (Identity Verification)

* **Spoofing / Falsified Verification**
  * *Threat*: Attackers forging positive KYC responses to bypass sanctions screening.
  * *Mitigation*: Inbound KYC status webhooks verify cryptographic signatures and cross-check verification IDs directly with the provider API over TLS (`src/modules/kyc/kyc.service.ts`).
* **Information Disclosure (PII)**
  * *Threat*: Storage of sensitive identity documents within backend databases.
  * *Mitigation*: The backend only stores ephemeral status indicators, expiry dates, and tokenized provider IDs (`kyc-expiry.job.ts`); biometric and identity documents are stored directly with the licensed provider.

---

## Known Security Gaps & Tracked Issues

The following gaps are actively tracked for hardening across contribution cycles:

| Issue | Title | Threat Category | Risk Assessment & Remediation Plan |
|---|---|---|---|
| **[#536](https://github.com/shakurJJ/chainsettle-backend/issues/536)** | *Add GET /auth/api-keys/:id/usage — per-key request stats* | Information Disclosure / Elevation of Privilege | **Gap**: API keys currently lack per-key granular usage frequency metrics, making compromised or leaked keys difficult to detect.<br>**Remediation**: Daily Redis usage counters with 31-day expiration and owner-only auditing endpoints. |
| **[#538](https://github.com/shakurJJ/chainsettle-backend/issues/538)** | *Add one-click unsubscribe headers to notification emails* | Tampering / Reputation | **Gap**: Lack of signed one-click unsubscribe headers exposes bulk notification emails to provider spoofing and spam-flag reputation penalties.<br>**Remediation**: Implement RFC 8058 `List-Unsubscribe` headers with cryptographically signed, expiring HMAC tokens. |
| **[#524](https://github.com/shakurJJ/chainsettle-backend/issues/524)** | *Add unit tests for ShipmentArchivalJob* | Denial of Service / Repudiation | **Gap**: Data lifecycle archival background jobs lack dedicated automated unit specs verifying lock contention and historical snapshot retention.<br>**Remediation**: Comprehensive mock unit tests ensuring archival job locks and historical integrity cannot be degraded. |
| **#568** *(Follow-up)* | *Outbound Webhook SSRF IP Blocking* | SSRF / Network Perimeter | Enforce strict DNS-resolution and private IPv4/IPv6 address filtering on all user-supplied webhook destination URLs. |
| **#569** *(Follow-up)* | *Soroban Contract Error Code Sanitization* | Information Disclosure | Normalize raw contract simulation panics into user-friendly error codes to prevent leaking internal memory addresses or environment data. |
