# Contract Testing with Pact

ChainSettle uses [Pact](https://docs.pact.io/) for consumer-driven contract testing between
the `chainsettle-frontend` (consumer) and `chainsettle-backend` (provider).

---

## Overview

| Role | Repo | Responsibility |
|------|------|----------------|
| Consumer | `chainsettle-frontend` | Writes Pact consumer tests; publishes contract files to the broker |
| Provider | `chainsettle-backend` | Runs provider verification against published contracts in CI |

The contract is the source of truth.  **If the backend breaks a consumer contract, CI fails.**

---

## Required packages

Install in this repo before running pact tests:

```bash
npm install --save-dev @pact-foundation/pact
```

---

## Running locally (no broker)

Checked-in example contracts live in `test/pact/contracts/`.  They let you verify the
provider works against a known baseline without any external services.

```bash
npx jest --config test/pact/jest-pact.config.js
```

The test suite bootstraps a full NestJS application with mocked Prisma, Redis, and Stellar
services, so no live database is needed.

---

## Running in CI (with Pact Broker)

Set these environment variables in your CI pipeline:

| Variable | Description |
|----------|-------------|
| `PACT_BROKER_URL` | Full URL to the Pact Broker (e.g. `https://chainsettle.pactflow.io`) |
| `PACT_BROKER_TOKEN` | Read-write API token (store as a CI secret) |
| `PACT_PUBLISH_RESULTS` | Set to `true` to publish verification results back to the broker |
| `GIT_SHA` | Current commit SHA — used as the provider version |
| `GIT_BRANCH` | Current branch name — used as the provider version branch |

When both `PACT_BROKER_URL` and `PACT_BROKER_TOKEN` are present, the test suite
automatically switches to broker mode and fetches the latest consumer contracts from
`mainBranch` and `deployedOrReleased` selectors.

### Recommended CI job (GitHub Actions):

```yaml
- name: Run Pact provider verification
  env:
    PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
    PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
    PACT_PUBLISH_RESULTS: "true"
    GIT_SHA: ${{ github.sha }}
    GIT_BRANCH: ${{ github.ref_name }}
    # Required by AppModule even though Prisma/Redis/Stellar are mocked:
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused"
    JWT_SECRET: "ci-pact-secret"
    REDIS_URL: "redis://localhost:6379"
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org"
    STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org"
    CHAINSETTTLE_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"
    USDC_TOKEN_ADDRESS: "GBDEADBEEF000000000000000000000000000000000000000000000000"
    STELLAR_SECRET_KEY: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"
    SMTP_HOST: "localhost"
    SMTP_USER: "ci@example.com"
    SMTP_PASS: "ci-pass"
    EMAIL_FROM: "ci@example.com"
  run: npx jest --config test/pact/jest-pact.config.js
```

---

## Publishing workflow (frontend → backend)

1. **Frontend** writes consumer tests using `@pact-foundation/pact`'s `PactV2` (or V3/V4)
   DSL for the shipment and auth endpoints.

2. Running `npm test` in the frontend repo generates JSON pact files, typically under
   `pacts/`.

3. The frontend CI job publishes the contracts to the broker:
   ```bash
   npx pact-broker publish pacts/ \
     --broker-base-url $PACT_BROKER_URL \
     --broker-token $PACT_BROKER_TOKEN \
     --consumer-app-version $GIT_SHA \
     --branch $GIT_BRANCH
   ```

4. The backend CI runs provider verification (step above).  Results are published back
   to the broker so the frontend's `can-i-deploy` gate can read them.

5. Before the frontend deploys, its CI runs:
   ```bash
   npx pact-broker can-i-deploy \
     --pacticipant chainsettle-frontend \
     --broker-base-url $PACT_BROKER_URL \
     --broker-token $PACT_BROKER_TOKEN \
     --to-environment production
   ```

---

## Adding new interactions

### Backend change breaks an existing contract

1. CI fails.  Do **not** merge the backend change until the frontend has updated
   its consumer test (and therefore its published contract) to accept the new shape.
2. Coordinate with the frontend team:  publish a new consumer contract that accepts
   both the old and new field name during a transition period, or do a coordinated
   same-sprint rollout.

### Adding a new endpoint that the frontend will consume

1. Frontend writes the consumer test first (contract-first design).
2. Frontend publishes the new contract to the broker (tagged `feat/<branch>`).
3. Backend implements the endpoint and adds a provider state handler in
   `test/pact/shipments.pact.spec.ts` (or `auth.pact.spec.ts`).
4. Backend verification passes → merge both sides.

### Adding a new provider state

Add an entry to `stateHandlers` in the relevant `*.pact.spec.ts` file:

```ts
stateHandlers: {
  'a cancelled shipment exists': async () => {
    prismaMock.shipment.findUnique.mockResolvedValueOnce({
      ...defaultShipment,
      status: 'CANCELLED',
      cancelledAt: new Date(),
    });
  },
},
```

---

## Checked-in contract snapshots

`test/pact/contracts/` contains minimal example contracts that reflect the current
agreed response shape for shipment list/detail and auth endpoints.  Keep these in sync
with the frontend's consumer tests — they are the reference for offline development and
the fallback when no broker is configured.

Do **not** use these files as a replacement for a running broker in production CI.
