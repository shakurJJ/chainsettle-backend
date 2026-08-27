#!/usr/bin/env bash
# Run the full ChainSettle k6 suite against a local/dev API.
# Requires: k6 (https://k6.io/docs/get-started/installation/)
#
# Usage:
#   BASE_URL=http://localhost:3000 JWT_TOKEN=... ./load-tests/run-all.sh
#   npm run loadtest

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="${BASE_URL:-http://localhost:3000}"
FAILED=0

if ! command -v k6 >/dev/null 2>&1; then
  echo "ERROR: k6 is not installed. See https://k6.io/docs/get-started/installation/"
  exit 1
fi

echo "==> Auth login flow"
if ! BASE_URL="$BASE_URL" k6 run "$ROOT/auth-login.js"; then
  FAILED=1
fi

if [[ -n "${JWT_TOKEN:-}" ]]; then
  echo "==> Shipment list (paginated)"
  if ! BASE_URL="$BASE_URL" JWT_TOKEN="$JWT_TOKEN" k6 run "$ROOT/shipments-list.js"; then
    FAILED=1
  fi

  if [[ -n "${SHIPMENT_ID:-}" ]]; then
    echo "==> Milestone confirmation writes"
    if ! BASE_URL="$BASE_URL" JWT_TOKEN="$JWT_TOKEN" SHIPMENT_ID="$SHIPMENT_ID" \
      MILESTONE_INDEX="${MILESTONE_INDEX:-0}" k6 run "$ROOT/milestone-confirm.js"; then
      FAILED=1
    fi
  else
    echo "SKIP milestone-confirm (set SHIPMENT_ID to enable)"
  fi
else
  echo "SKIP authenticated suites (set JWT_TOKEN to enable shipments-list + milestone-confirm)"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: one or more load tests exceeded thresholds"
  exit 1
fi

echo "PASS: all executed load tests met thresholds"
exit 0
