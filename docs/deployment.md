# Production Deployment Guide

This document covers everything needed to run ChainSettle in production: process management, reverse proxy, PostgreSQL, Redis, and environment variables. For zero-downtime deploy mechanics and the event-poller leadership handoff see the [Blue/green section](#blue--green-deployment) below.

> **Note:** A Dockerfile is included in the repo root. A `docker-compose.yml` for local development is tracked in the issue backlog.

---

## 1. Prerequisites

| Requirement | Minimum version |
|---|---|
| Node.js | 20 LTS |
| PostgreSQL | 15 |
| Redis | 7 |
| pnpm / npm | pnpm 9+ or npm 10+ |

---

## 2. Build and install

```bash
git clone https://github.com/your-org/chainsettle-backend.git
cd chainsettle-backend
npm ci --omit=dev          # production deps only
npm run build              # compiles TypeScript → dist/
npx prisma migrate deploy  # apply all pending migrations
npx prisma generate        # regenerate Prisma client
```

---

## 3. Environment variables

Copy `.env.example` to `.env` and fill in every **Required** variable before starting.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | Yes | — | Must be `production` |
| `PORT` | No | `3000` | API listen port |
| `API_PREFIX` | No | `api` | Route prefix without version segment |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (primary) |
| `DATABASE_REPLICA_URL` | No | — | Read-replica URL; omit to use primary for all reads |
| `SHIPMENT_ARCHIVAL_DAYS` | No | `90` | Days before terminal shipments move to cold storage |
| `JWT_SECRET` | Yes | — | 32+ random characters; never reuse across environments |
| `JWT_EXPIRES_IN` | No | `7d` | Standard JWT expiry |
| `IMPERSONATION_JWT_EXPIRES_IN` | No | `15m` | Admin impersonation token TTL |
| `STELLAR_NETWORK` | Yes | — | `testnet` or `mainnet` |
| `STELLAR_RPC_URL` | Yes | — | Soroban RPC endpoint |
| `CHAINSETTTLE_CONTRACT_ID` | Yes | — | Deployed contract address |
| `USDC_TOKEN_ADDRESS` | Yes | — | USDC SAC address |
| `REDIS_URL` | Yes | — | Redis connection string (used for rate limiting, caching, poller lock) |
| `SMTP_HOST` | No | — | Email SMTP host; omit to disable email delivery |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `EMAIL_FROM` | No | `noreply@chainsetttle.com` | From address for outgoing email |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Allowed frontend origin (single value) |
| `ALLOWED_ORIGINS` | No | — | Comma-separated list of allowed origins (overrides `CORS_ORIGIN`) |
| `EVENT_POLLING_INTERVAL_MS` | No | `5000` | Stellar event poll interval in ms |
| `THROTTLE_TTL` | No | `60` | Rate-limit window in seconds |
| `THROTTLE_LIMIT` | No | `100` | Max requests per window per key |
| `BACKUP_S3_BUCKET` | No | — | S3 bucket for automated DB backups (omit to skip) |
| `BACKUP_GPG_PASSPHRASE` | No | — | Symmetric passphrase for encrypted backup dumps |

---

## 4. Process manager (PM2)

```bash
npm install -g pm2

pm2 start dist/main.js \
  --name chainsettle-api \
  --instances 2 \
  --exec-mode cluster \
  --max-memory-restart 512M

pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

> **Multi-instance and the event poller:** Only one instance holds the Redis lock `chainsettle:event-poller:leader` at a time. The other instance(s) stand by and acquire the lock automatically if the leader crashes. Never run without Redis when using more than one instance.

---

## 5. Docker

A `Dockerfile` is included in the repo root. Build and run:

```bash
docker build -t chainsettle-api:latest .

docker run -d \
  --name chainsettle-api \
  --env-file .env \
  -p 3000:3000 \
  chainsettle-api:latest
```

For multi-container setups, ensure the container can reach PostgreSQL and Redis by name or IP. Pass `DATABASE_URL` and `REDIS_URL` pointing to those services.

---

## 6. Reverse proxy (nginx)

```nginx
upstream chainsettle {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    location / {
        proxy_pass         http://chainsettle;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";   # required for WebSocket (notifications gateway)
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    server_name api.example.com;
    return 301 https://$host$request_uri;
}
```

Use [Certbot](https://certbot.eff.org/) to obtain and auto-renew the TLS certificate.

---

## 7. PostgreSQL + PgBouncer

### PostgreSQL tuning (minimal)

```sql
-- postgresql.conf
max_connections = 100
shared_buffers = 256MB
work_mem = 4MB
```

### PgBouncer (connection pooling)

```ini
; pgbouncer.ini
[databases]
chainsettle = host=127.0.0.1 port=5432 dbname=chainsettle

[pgbouncer]
pool_mode = transaction
max_client_conn = 200
default_pool_size = 20
listen_port = 6432
auth_type = md5
```

Set `DATABASE_URL` to point at PgBouncer (`port=6432`) rather than Postgres directly.

> Prisma's interactive transactions require `pool_mode = transaction` or `session`. Do not use `statement` mode.

---

## 8. Redis

Redis is required for:
- Rate-limit counters (`@nestjs/throttler` storage)
- Shipment list cache
- Event-poller leader lock

A single Redis instance is sufficient for most deployments. For high availability use Redis Sentinel or a managed service (ElastiCache, Upstash, Redis Cloud).

```bash
# Minimal redis.conf additions
maxmemory 256mb
maxmemory-policy allkeys-lru
```

---

## 9. Health check

```
GET /api/v1/health
```

Returns `200` when the database and dependent services are reachable. Use this as the load-balancer health check target.

For readiness (post-deploy gate):

```
GET /api/v1/health/ready
```

---

## 10. Zero-downtime deploy considerations (event poller)

The `EventsService` acquires a Redis lock `chainsettle:event-poller:leader` on startup. Only the lock holder polls Stellar and processes events. This prevents duplicate event processing across instances or during a rolling deploy.

During a blue/green cutover:

| Moment | Blue | Green | Who polls? |
|---|---|---|---|
| Green boots | holds lock | contending | Blue |
| Blue drains / stops | releases lock | acquires | Green |
| Traffic cut | stopped | live | Green |

Verify after a deploy — no duplicate `(txHash, eventName)` rows should appear:

```sql
SELECT "txHash", "eventName", COUNT(*)
FROM chain_events
GROUP BY 1, 2
HAVING COUNT(*) > 1;
```

The schema enforces `@@unique([txHash, eventName])`, so a double-process attempt fails the insert rather than creating silent duplicates.

The full blue/green GitHub Actions workflow is at `.github/workflows/deploy-blue-green.yml`.

---

## Blue / green deployment

This document covers zero-downtime deploys for ChainSettle, including how the
in-process event poller stays single-leader across the cutover.

### Overview

Deploys use a classic blue/green swap:

1. **Build** the new version (green).
2. **Start green** beside the currently live blue instance — both may accept
   health checks, but only one holds the Redis event-poller lock.
3. **Health-check** green via `GET /api/v1/health/ready` until it passes.
4. **Cut traffic** (load balancer / reverse proxy) from blue → green.
5. **Drain & stop blue**. Green keeps (or acquires) the poller lock; blue
   releases it on shutdown so there is never dual event processing.

The workflow lives at `.github/workflows/deploy-blue-green.yml`.

### Read replica (`DATABASE_REPLICA_URL`)

Optional. When set, read-heavy list/detail GETs (shipments list/detail, events
list, admin audit-log list) use the replica via `PrismaService.read`.

**Eventual consistency:** a shipment created on the primary may not appear on
`GET /shipments` for a short window if that path is served from the replica.
Unset `DATABASE_REPLICA_URL` to keep previous single-DB behaviour.

### Cold-storage shipment archival

Daily job (`ShipmentArchivalJob`, 03:00 UTC) moves `COMPLETED` / `CANCELLED`
shipments older than `SHIPMENT_ARCHIVAL_DAYS` (default 90) into
`archived_shipments` and deletes them from the hot `shipments` table.

- Hot path: `GET /api/v1/shipments` (excludes soft-archived and cold-archived)
- Soft archive (buyer): `POST /shipments/:id/archive` still uses `archivedAt`
- Cold archive retrieval: `GET /api/v1/shipments/archived` and
  `GET /api/v1/shipments/archived/:id` (full history snapshot in `payload`)

### Automated database backups

`.github/workflows/db-backup.yml` runs daily at 03:30 UTC (after the shipment
archival job) via `scripts/db-backup.sh`:

1. `pg_dump` the database (`DATABASE_URL`), gzip it.
2. Encrypt the dump with GPG (AES256 symmetric, `BACKUP_GPG_PASSPHRASE`).
3. Upload to `s3://<BACKUP_S3_BUCKET>/backups/daily/chainsettle-<UTC timestamp>.sql.gz.gpg`.
4. On Sundays, also upload the same file under `backups/weekly/`.

**Retention policy** (enforced by `scripts/db-prune-backups.sh`, run right
after the backup step):

| Prefix | Retention | Env var |
|---|---|---|
| `backups/daily/` | 30 days (default) | `BACKUP_RETENTION_DAILY_DAYS` |
| `backups/weekly/` | 182 days / ~6 months (default) | `BACKUP_RETENTION_WEEKLY_DAYS` |

#### Restoring from a backup

```bash
# 1. Download the encrypted dump
aws s3 cp s3://<BACKUP_S3_BUCKET>/backups/daily/chainsettle-<timestamp>.sql.gz.gpg .

# 2. Decrypt
gpg --batch --yes --passphrase "$BACKUP_GPG_PASSPHRASE" \
  --output chainsettle-<timestamp>.sql.gz \
  --decrypt chainsettle-<timestamp>.sql.gz.gpg

# 3. Decompress and restore into a target database
gunzip -c chainsettle-<timestamp>.sql.gz | psql "$TARGET_DATABASE_URL"
```

Restore into a scratch database first and verify row counts / spot-check
recent rows before pointing production traffic at it.

### Required secrets / variables

| Name | Purpose |
|---|---|
| `DEPLOY_HOST` | SSH host for the staging/prod VM or bastion |
| `DEPLOY_USER` | SSH user |
| `DEPLOY_SSH_KEY` | Private key |
| `DEPLOY_PATH` | App root on the host (contains `docker-compose.yml` or process manager config) |
| `HEALTHCHECK_URL` | e.g. `https://staging.example.com/api/v1/health/ready` |
| `ACTIVE_SLOT_URL` / `PREVIEW_SLOT_URL` | Optional per-slot health URLs during cutover |
| `BACKUP_S3_BUCKET` | Destination bucket for `db-backup.yml`, e.g. `s3://my-backups` (unset = job skips) |
| `BACKUP_S3_ENDPOINT_URL` | Optional, for S3-compatible providers (R2, MinIO, Spaces) |
| `BACKUP_AWS_ACCESS_KEY_ID` / `BACKUP_AWS_SECRET_ACCESS_KEY` / `BACKUP_AWS_REGION` | Credentials for the backup bucket |
| `BACKUP_GPG_PASSPHRASE` | Symmetric encryption passphrase for backup dumps |

### Manual cutover checklist

1. Confirm Redis is reachable from both slots.
2. Deploy green; wait for `/api/v1/health/ready` → 200.
3. Confirm only one instance logs `Acquired event-poller leadership`.
4. Flip LB / nginx upstream to green.
5. Stop blue; confirm leadership transfer in green logs.
6. Spot-check `chain_events` uniqueness query above.

### Rollback

Point the load balancer back at blue (if still warm) or redeploy the previous
image tag as green and cut again. Prefer keeping the prior image tagged for
at least one successful deploy cycle.
