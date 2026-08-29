#!/usr/bin/env bash
# Dumps the ChainSettle PostgreSQL database, encrypts it with GPG (symmetric,
# AES256), and uploads it to an S3-compatible bucket for disaster recovery.
#
# Every run uploads to backups/daily/. On Sundays (UTC) it additionally
# uploads the same encrypted dump to backups/weekly/, so the prune script
# (db-prune-backups.sh) can apply a longer retention window to weekly copies.
#
# Required env vars:
#   DATABASE_URL        - source Postgres connection string (pg_dump reads this)
#   BACKUP_S3_BUCKET     - destination bucket, e.g. s3://my-backups
#   BACKUP_GPG_PASSPHRASE - symmetric encryption passphrase
# Optional:
#   BACKUP_S3_ENDPOINT_URL - set for S3-compatible providers (R2, MinIO, Spaces)
#
# Usage: ./scripts/db-backup.sh
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
: "${BACKUP_GPG_PASSPHRASE:?BACKUP_GPG_PASSPHRASE is required}"

TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DAY_OF_WEEK="$(date -u +%u)" # 1=Monday .. 7=Sunday
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

DUMP_FILE="$WORKDIR/chainsettle-${TIMESTAMP}.sql.gz"
ENCRYPTED_FILE="${DUMP_FILE}.gpg"

echo "==> Dumping database..."
pg_dump --format=plain --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$DUMP_FILE"

echo "==> Encrypting dump..."
gpg --batch --yes --symmetric --cipher-algo AES256 \
  --passphrase "$BACKUP_GPG_PASSPHRASE" \
  --output "$ENCRYPTED_FILE" "$DUMP_FILE"

S3_ARGS=()
if [ -n "${BACKUP_S3_ENDPOINT_URL:-}" ]; then
  S3_ARGS+=(--endpoint-url "$BACKUP_S3_ENDPOINT_URL")
fi

DEST_KEY="chainsettle-${TIMESTAMP}.sql.gz.gpg"

echo "==> Uploading to ${BACKUP_S3_BUCKET}/backups/daily/${DEST_KEY}"
aws s3 cp "${S3_ARGS[@]}" "$ENCRYPTED_FILE" "${BACKUP_S3_BUCKET}/backups/daily/${DEST_KEY}"

if [ "$DAY_OF_WEEK" = "7" ]; then
  echo "==> Sunday — also uploading to ${BACKUP_S3_BUCKET}/backups/weekly/${DEST_KEY}"
  aws s3 cp "${S3_ARGS[@]}" "$ENCRYPTED_FILE" "${BACKUP_S3_BUCKET}/backups/weekly/${DEST_KEY}"
fi

echo "==> Backup complete: ${DEST_KEY}"
