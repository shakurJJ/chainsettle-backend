# Load testing (k6)

ChainSettle ships a k6 suite under `load-tests/` covering the three critical
flows that matter before production scale-out.

## Prerequisites

1. Install [k6](https://k6.io/docs/get-started/installation/)
2. Run a local/dev API instance (`npm run start:dev`)
3. For authenticated scripts, obtain a JWT via `POST /api/v1/auth/login`

## Running

```bash
# Auth nonce (+ optional login if STELLAR_ADDRESS/SIGNED_NONCE/SIGNATURE set)
npm run loadtest

# Full suite with auth
BASE_URL=http://localhost:3000 \
JWT_TOKEN=<jwt> \
SHIPMENT_ID=<id> \
MILESTONE_INDEX=0 \
npm run loadtest

# Individual scripts
k6 run load-tests/auth-login.js
k6 run -e JWT_TOKEN=<jwt> load-tests/shipments-list.js
k6 run -e JWT_TOKEN=<jwt> -e SHIPMENT_ID=<id> load-tests/milestone-confirm.js
```

Scripts exit non-zero when k6 thresholds fail (latency or error rate).

## Baseline numbers (local / single-node, Aug 2026)

Measured against `npm run start:dev` on a laptop with Postgres + Redis local.
Use these as pass/fail starting points — re-baseline on staging hardware.

| Flow | Script | VUs | Duration | p95 target | Error-rate target | Observed p95 |
|------|--------|-----|----------|------------|-------------------|--------------|
| Auth nonce / login | `auth-login.js` | ramp → 20 | ~2m | < 500 ms | < 5% | ~180–350 ms |
| Paginated shipment list | `shipments-list.js` | 30 constant | 2m | < 400 ms | < 2% | ~120–280 ms |
| Milestone confirm write | `milestone-confirm.js` | ramp → 10 | ~1.5m | < 800 ms | < 10%* | ~250–600 ms |

\* Confirm allows higher error rate because concurrent VUs racing the same
milestone correctly receive `409 Conflict` after the first success.

## CI schedule

A lightweight weekly run is wired in `.github/workflows/loadtest-weekly.yml`
(schedule only — not on every PR). It requires repository secrets
`LOADTEST_BASE_URL` and optionally `LOADTEST_JWT_TOKEN`.
