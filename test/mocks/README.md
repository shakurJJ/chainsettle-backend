# Mock Stellar chain (DEV ONLY)

Lightweight Soroban JSON-RPC + Horizon stub for local frontend work against this backend **without** a live Stellar testnet connection.

## Quick start

```bash
# Terminal 1 — mock chain
npm run dev:mock-chain

# Terminal 2 — point backend at the mock (override in .env)
STELLAR_RPC_URL=http://127.0.0.1:8787
STELLAR_HORIZON_URL=http://127.0.0.1:8788
npm run start:dev
```

Default ports: RPC `8787`, Horizon `8788` (override with `STELLAR_MOCK_RPC_PORT` / `STELLAR_MOCK_HORIZON_PORT`).

## What works

- Backend boot and `GET /chain/status` (`getHealth` / `getLatestLedger`)
- Event poller idle loop (`getEvents` → empty)
- Auth (wallet signature is local — no RPC)
- Shipment CRUD / favoriting against Postgres (no live chain needed)
- Soft stubs for `simulateTransaction`, `getLedgerEntries`, Horizon `GET /accounts/:id`

## Tradeoffs (read carefully)

| Capability | Mock behavior |
|------------|---------------|
| Signature / tx submission | **Not verified / not submitted** — frontend Freighter writes still need a real network |
| Contract events | Always empty — no real milestone progression from chain |
| `simulateTransaction` | Canned envelope — not real XDR / contract state |
| Ledger progression | Synthetic counter only |

**This is not a staging environment.** Do not use it to validate real Soroban behavior, funding, or event pipelines. Use Stellar testnet for integration tests.
