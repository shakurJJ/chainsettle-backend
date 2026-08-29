# Blue / green deployment

This document covers zero-downtime deploys for ChainSettle, including how the
in-process event poller stays single-leader across the cutover.

## Overview

Deploys use a classic blue/green swap:

1. **Build** the new version (green).
2. **Start green** beside the currently live blue instance — both may accept
   health checks, but only one holds the Redis event-poller lock.
3. **Health-check** green via `GET /api/v1/health/ready` until it passes.
4. **Cut traffic** (load balancer / reverse proxy) from blue → green.
5. **Drain & stop blue**. Green keeps (or acquires) the poller lock; blue
   releases it on shutdown so there is never dual event processing.

The workflow lives at `.github/workflows/deploy-blue-green.yml`.

## Event-poller leadership (no duplicate processing)

`EventsService` acquires Redis lock `chainsettle:event-poller:leader`
(SET NX + periodic renew). Only the leader:

- Subscribes to Stellar contract events
- Retries the failed-events DLQ

During a blue/green transition:

| Moment | Blue | Green | Who polls? |
|--------|------|-------|------------|
| Green boots | holds lock | contending | Blue |
| Blue drains / stops | releases lock | acquires | Green |
| Traffic cut | stopped | live | Green |

Verify after a deploy by checking `chain_events`:

```sql
-- No duplicate (txHash, eventName) rows should appear
SELECT "txHash", "eventName", COUNT(*)
FROM chain_events
GROUP BY 1, 2
HAVING COUNT(*) > 1;
```

The schema already enforces `@@unique([txHash, eventName])`, so a double-process
attempt would fail the insert rather than create silent duplicates.

## Read replica (`DATABASE_REPLICA_URL`)

Optional. When set, read-heavy list/detail GETs (shipments list/detail, events
list, admin audit-log list) use the replica via `PrismaService.read`.

**Eventual consistency:** a shipment created on the primary may not appear on
`GET /shipments` for a short window if that path is served from the replica.
Unset `DATABASE_REPLICA_URL` to keep previous single-DB behaviour.

## Cold-storage shipment archival

Daily job (`ShipmentArchivalJob`, 03:00 UTC) moves `COMPLETED` / `CANCELLED`
shipments older than `SHIPMENT_ARCHIVAL_DAYS` (default 90) into
`archived_shipments` and deletes them from the hot `shipments` table.

- Hot path: `GET /api/v1/shipments` (excludes soft-archived and cold-archived)
- Soft archive (buyer): `POST /shipments/:id/archive` still uses `archivedAt`
- Cold archive retrieval: `GET /api/v1/shipments/archived` and
  `GET /api/v1/shipments/archived/:id` (full history snapshot in `payload`)

## Automated database backups

`.github/workflows/db-backup.yml` runs daily at 03:30 UTC (after the shipment
archival job) via `scripts/db-backup.sh`:

1. `pg_dump` the database (`DATABASE_URL`), gzip it.
2. Encrypt the dump with GPG (AES256 symmetric, `BACKUP_GPG_PASSPHRASE`).
3. Upload to `s3://<BACKUP_S3_BUCKET>/backups/daily/chainsettle-<UTC timestamp>.sql.gz.gpg`.
4. On Sundays, also upload the same file under `backups/weekly/`.

**Retention policy** (enforced by `scripts/db-prune-backups.sh`, run right
after the backup step):

| Prefix | Retention | Env var |
|--------|-----------|---------|
| `backups/daily/` | 30 days (default) | `BACKUP_RETENTION_DAILY_DAYS` |
| `backups/weekly/` | 182 days / ~6 months (default) | `BACKUP_RETENTION_WEEKLY_DAYS` |

Objects older than their prefix's retention window are deleted based on the
timestamp encoded in the object key.

### Restoring from a backup

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

## Required secrets / variables

| Name | Purpose |
|------|---------|
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

## Manual cutover checklist

1. Confirm Redis is reachable from both slots.
2. Deploy green; wait for `/api/v1/health/ready` → 200.
3. Confirm only one instance logs `Acquired event-poller leadership`.
4. Flip LB / nginx upstream to green.
5. Stop blue; confirm leadership transfer in green logs.
6. Spot-check `chain_events` uniqueness query above.

## Rollback

Point the load balancer back at blue (if still warm) or redeploy the previous
image tag as green and cut again. Prefer keeping the prior image tagged for
at least one successful deploy cycle.
