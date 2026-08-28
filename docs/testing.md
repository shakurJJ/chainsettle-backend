# Testing

This document explains every test category in the ChainSettle backend, how to run each one,
what local services are required, and how CI executes them. A new contributor should be able
to run all test categories locally by following this guide.

---

## Quick reference

| Suite | Command | Needs DB | Needs Redis | Needs live Stellar |
|-------|---------|----------|-------------|-------------------|
| Unit tests | `npm run test` | No | No | No |
| Unit tests + coverage | `npm run test:cov` | No | No | No |
| Watch mode | `npm run test:watch` | No | No | No |
| E2E tests | `npm run test:e2e` | Yes | Yes | No |
| Pact contract tests | `npm run test:pact` (see below) | No | No | No |
| Load tests | `npm run loadtest` | Yes | Yes | No* |
| Rate-limit shell test | `./test-rate-limit.sh` | Yes | Yes | No |
| Dispute-evidence shell test | `./test-dispute-evidence.sh` | Yes | Yes | No |

\* Load tests call the API, which calls a real (or mocked) Stellar RPC. Set
`STELLAR_RPC_URL=http://127.0.0.1:8787` and run `npm run dev:mock-chain` to avoid a live
testnet dependency.

---

## 1. Unit tests

**What they cover:** individual service methods and utility functions, with all external
dependencies (`PrismaService`, `StellarService`, `RedisService`, etc.) mocked via Jest.
Example: `src/modules/milestones/milestones.service.spec.ts`.

**Command:**

```bash
npm run test
```

**Coverage report:**

```bash
npm run test:cov        # outputs to ./coverage/
```

**Watch mode (TDD):**

```bash
npm run test:watch
```

**Required setup:** none beyond a generated Prisma client.

```bash
# First time only (no database connection needed):
npx prisma generate
```

The values in `.env.example` are sufficient as-is — unit tests mock all infrastructure.

> **Known issue:** as of the current `main` branch, `npm run test` fails to compile
> due to a pre-existing type mismatch in `shipments.service.ts` (missing `resourceId`
> on `RecordAuditLogDto`). This is unrelated to your environment. Check open issues
> before spending time debugging it.

**Configuration:** Jest config lives inline in `package.json`. Test files follow the pattern
`src/**/*.spec.ts`. Coverage is collected from all `src/**/*.ts` files.

---

## 2. End-to-end (E2E) tests

**What they cover:** full request/response lifecycle through the running NestJS application.
The test database is hit directly; no mocks are used for the DB layer. Primary file:
`test/milestone-lifecycle.e2e-spec.ts`.

**Required local services:**

- PostgreSQL 15+ — connection string in `DATABASE_URL`
- Redis — connection string in `REDIS_URL`

**Setup:**

```bash
cp .env.example .env
# Fill in: DATABASE_URL, JWT_SECRET, REDIS_URL, STELLAR_RPC_URL,
#          STELLAR_HORIZON_URL, CHAINSETTTLE_CONTRACT_ID, USDC_TOKEN_ADDRESS,
#          STELLAR_SECRET_KEY, SMTP_*

npx prisma migrate dev --name init
npx prisma generate
```

**Command:**

```bash
npm run test:e2e
```

**Configuration:** `test/jest-e2e.json` — matches `test/**/*.e2e-spec.ts`, same ts-jest
transform as unit tests.

---

## 3. Pact contract tests (consumer-driven)

**What they cover:** API contract between this backend (provider) and the frontend consumer.
Pact files live under `test/pact/`. The provider setup (`test/pact/provider-setup.ts`) spins
up the NestJS app and verifies recorded consumer interactions.

**Files:**

- `test/pact/auth.pact.spec.ts` — auth endpoint contracts
- `test/pact/shipments.pact.spec.ts` — shipments endpoint contracts
- `test/pact/provider-setup.ts` — provider verification harness
- `test/pact/jest-pact.config.js` — separate Jest config for pact runs

**Command:**

```bash
npx jest --config test/pact/jest-pact.config.js
```

**Required services:** none for consumer-side generation; a running application is needed for
provider verification (see `provider-setup.ts`).

---

## 4. Load tests (k6)

**What they cover:** throughput and latency under sustained load, with pass/fail thresholds.
Scripts are in `load-tests/`:

| Script | Scenario |
|--------|---------|
| `auth-login.js` | Sign-in flow (`GET /auth/nonce` + `POST /auth/login`) |
| `shipments-list.js` | Paginated `GET /shipments` with a valid JWT |
| `milestone-confirm.js` | `POST /shipments/:id/milestones/:index/confirm` write path |

**Prerequisites:**

- [k6](https://k6.io/docs/get-started/installation/) installed and on `PATH`
- A running local API (`npm run start:dev`)
- PostgreSQL, Redis, and (optionally) a mock Stellar chain

**Commands:**

```bash
# Run all load-test scenarios:
npm run loadtest
# equivalent to: bash load-tests/run-all.sh

# Run a single script directly:
BASE_URL=http://localhost:3000 JWT_TOKEN=<token> k6 run load-tests/shipments-list.js

# With a mock Stellar chain (avoids testnet):
npm run dev:mock-chain &
STELLAR_RPC_URL=http://127.0.0.1:8787 npm run start:dev &
BASE_URL=http://localhost:3000 JWT_TOKEN=<token> npm run loadtest
```

`run-all.sh` will skip authenticated suites if `JWT_TOKEN` is not set, and skip
`milestone-confirm.js` if `SHIPMENT_ID` is also not set.

---

## 5. Shell test scripts

Two standalone Bash scripts exercise specific scenarios against a running local API.
They require no test framework — just `curl` and `jq`.

### `./test-rate-limit.sh`

**Scenarios:**
- Sends 7 successive `GET /auth/nonce` requests (limit is 5/min) and prints
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` from each response.
  Requests 6 and 7 should return `429` with `Retry-After`.
- Sends 12 successive `POST /auth/login` requests (limit is 10/min). Requests 1–10 return
  `401` (bad signature, not rate-limited); 11 and 12 return `429`.

**Run:**

```bash
# API must be running on localhost:3000
./test-rate-limit.sh
```

### `./test-dispute-evidence.sh`

**Scenarios:**
- Submit dispute evidence as buyer, supplier, arbiter, and logistics participant.
- List evidence for a disputed milestone.
- Attempt to submit as a non-participant (should receive `403`).

**Prerequisites:**
- A running API with a shipment in `DISPUTED` milestone status.
- Valid JWTs for buyer, supplier, arbiter, and logistics — edit the token variables at the
  top of the script.

**Run:**

```bash
# Set BUYER_TOKEN, SUPPLIER_TOKEN, etc. at the top of the script, then:
./test-dispute-evidence.sh
```

---

## 6. CI

CI runs the following matrix on every push and pull request:

```
1. npm run lint
2. npm run test          # unit
3. npm run test:e2e      # requires DB and Redis service containers
```

Load tests run on a separate weekly schedule via
`.github/workflows/loadtest-weekly.yml` and are not part of the standard PR check.

The SDK drift check (`npm run check:sdk`) is gated via `.github/workflows/sdk-drift.yml`.

---

## Mock Stellar RPC (frontend / integration dev)

When you need the full API without a live testnet:

```bash
npm run dev:mock-chain
# then in a separate terminal:
STELLAR_RPC_URL=http://127.0.0.1:8787 STELLAR_HORIZON_URL=http://127.0.0.1:8788 npm run start:dev
```

The mock server is at `test/mocks/stellar-rpc-server.ts`. See
[`test/mocks/README.md`](../test/mocks/README.md) for its limitations — it is for dev
iteration only, not for validating real chain behaviour.
