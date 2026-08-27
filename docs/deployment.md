# Deployment

How to build and run ChainSettle backend with Docker and Kubernetes (Helm).

## Prerequisites

- Node.js 20+ (local builds)
- Docker
- Kubernetes cluster + Helm 3
- Reachable PostgreSQL 15+ and Redis
- Stellar RPC / Horizon endpoints (or local mock for non-prod only)

## Docker image

```bash
# From repo root
docker build -t chainsettle-backend:latest .

# Run (requires a populated .env matching .env.example)
docker run --rm --env-file .env -p 3000:3000 chainsettle-backend:latest
```

The image:

1. Installs dependencies and runs `prisma generate` + `nest build` in a builder stage
2. Ships a slim Node 20 Alpine runtime with `npm ci --omit=dev`
3. Starts via `node dist/main` on port `3000`
4. Exposes Docker `HEALTHCHECK` against `GET /api/v1/health/live`

Apply Prisma migrations separately before or during deploy:

```bash
npx prisma migrate deploy
# or from a one-shot Job that uses the same image / DATABASE_URL
```

## Helm chart

Chart path: `deploy/helm/chainsettle-backend`

### Important: single replica for the event poller

The Nest process runs the Stellar event poller and several cron jobs **in-process**. Running multiple replicas without a distributed lock can duplicate event handling and notifications.

**Default `replicaCount` is `1`.** Do not scale above 1 until the poller/crons are extracted or locked.

### Install

```bash
# 1. Build / push the image to a registry your cluster can pull
docker build -t <registry>/chainsettle-backend:0.1.0 .
docker push <registry>/chainsettle-backend:0.1.0

# 2. Create a Secret with required keys (preferred for production)
kubectl create secret generic chainsettle-backend-secrets \
  --from-literal=JWT_SECRET='...' \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=REDIS_URL='redis://...' \
  --from-literal=STELLAR_RPC_URL='https://...' \
  --from-literal=STELLAR_HORIZON_URL='https://...' \
  --from-literal=CHAINSETTTLE_CONTRACT_ID='C...' \
  --from-literal=USDC_TOKEN_ADDRESS='C...' \
  --from-literal=STELLAR_SECRET_KEY='S...' \
  --from-literal=SMTP_HOST='...' \
  --from-literal=SMTP_USER='...' \
  --from-literal=SMTP_PASS='...' \
  --from-literal=EMAIL_FROM='...'

# 3. Install the chart
helm install chainsettle ./deploy/helm/chainsettle-backend \
  --set image.repository=<registry>/chainsettle-backend \
  --set image.tag=0.1.0 \
  --set existingSecret=chainsettle-backend-secrets \
  --set replicaCount=1
```

### Probes

| Probe | Path | Purpose |
|-------|------|---------|
| Liveness | `GET /api/v1/health/live` | Process is up |
| Readiness | `GET /api/v1/health/ready` | Postgres (+ IPFS check) reachable |

### Values of note

See `deploy/helm/chainsettle-backend/values.yaml` for resources, env, and probe tuning. Prefer `existingSecret` over embedding secrets in `secretEnv`.

## Local mock chain (not for k8s staging)

For frontend-only local work without testnet, see `test/mocks/README.md` and `npm run dev:mock-chain`. That mock must never be used as a production or staging chain dependency.
