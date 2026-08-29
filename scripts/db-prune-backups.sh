#!/usr/bin/env bash
# Prunes database backups older than the configured retention policy:
#   - backups/daily/  : keep BACKUP_RETENTION_DAILY_DAYS days   (default 30)
#   - backups/weekly/ : keep BACKUP_RETENTION_WEEKLY_DAYS days  (default 182, ~6 months)
#
# Backup object keys are named chainsettle-<ISO8601 UTC timestamp>.sql.gz.gpg
# (see db-backup.sh), so the cutoff is applied by parsing that timestamp out
# of each key rather than relying on S3 object metadata.
#
# Required env vars:
#   BACKUP_S3_BUCKET - bucket the backups live in, e.g. s3://my-backups
# Optional:
#   BACKUP_S3_ENDPOINT_URL     - set for S3-compatible providers (R2, MinIO, Spaces)
#   BACKUP_RETENTION_DAILY_DAYS
#   BACKUP_RETENTION_WEEKLY_DAYS
#
# Usage: ./scripts/db-prune-backups.sh
set -euo pipefail

: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
DAILY_RETENTION_DAYS="${BACKUP_RETENTION_DAILY_DAYS:-30}"
WEEKLY_RETENTION_DAYS="${BACKUP_RETENTION_WEEKLY_DAYS:-182}"

S3_ARGS=()
if [ -n "${BACKUP_S3_ENDPOINT_URL:-}" ]; then
  S3_ARGS+=(--endpoint-url "$BACKUP_S3_ENDPOINT_URL")
fi

# prune_prefix <prefix> <retention_days>
prune_prefix() {
  local prefix="$1"
  local retention_days="$2"
  local cutoff_epoch
  cutoff_epoch="$(date -u -d "-${retention_days} days" +%s)"

  echo "==> Pruning ${BACKUP_S3_BUCKET}/${prefix} older than ${retention_days} days"

  aws s3 ls "${S3_ARGS[@]}" "${BACKUP_S3_BUCKET}/${prefix}" | awk '{print $NF}' | while read -r key; do
    [ -z "$key" ] && continue
    # key: chainsettle-2026-08-01T03-00-00Z.sql.gz.gpg
    ts_part="${key#chainsettle-}"
    ts_part="${ts_part%%.sql.gz.gpg}"
    iso_ts="$(echo "$ts_part" | sed -E 's/^([0-9-]+)T([0-9]{2})-([0-9]{2})-([0-9]{2})Z$/\1T\2:\3:\4Z/')"
    key_epoch="$(date -u -d "$iso_ts" +%s 2>/dev/null || echo "")"

    if [ -z "$key_epoch" ]; then
      echo "    skip (unparseable key): $key"
      continue
    fi

    if [ "$key_epoch" -lt "$cutoff_epoch" ]; then
      echo "    delete: $key"
      aws s3 rm "${S3_ARGS[@]}" "${BACKUP_S3_BUCKET}/${prefix}${key}"
    fi
  done
}

prune_prefix "backups/daily/" "$DAILY_RETENTION_DAYS"
prune_prefix "backups/weekly/" "$WEEKLY_RETENTION_DAYS"

echo "==> Prune complete"
