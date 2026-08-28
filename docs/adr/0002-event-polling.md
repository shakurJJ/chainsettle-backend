# ADR-0002: Polling for Stellar contract events instead of streaming subscription

**Status:** Accepted

## Context

The `EventsService` must detect on-chain state changes emitted by the ChainSettle Soroban contract (e.g., `proof_submitted`, `milestone_confirmed`, `dispute_raised`, `shipment_cancelled`). These events drive all off-chain side effects: milestone status updates, notification fan-out, and audit-log entries.

Two broad approaches exist:

1. **Streaming subscription** — a persistent SSE / WebSocket / long-poll connection from the RPC that pushes events as they are emitted.
2. **Polling** — the backend periodically calls `getEvents` on the Soroban RPC, advancing a cursor as it processes results.

At the time of implementation, the Soroban RPC did not offer a reliable, production-grade streaming endpoint for contract events. The Horizon SSE streams exist for *operations*, but Soroban contract events require polling `getEvents` with a `startLedger` cursor anyway.

## Decision

Use **polling** via `StellarService.subscribeToContractEvents()` rather than a streaming subscription.

Implementation details:

- `StellarService.subscribeToContractEvents(startLedger, onEvent, onError)` runs a tight loop: call `fetchContractEvents(currentLedger)`, process results, advance `currentLedger`, then `await new Promise(r => setTimeout(r, 1_000))`.
- `EventsService` owns a DB-persisted `eventCursor` (`id: 'main'`) that survives restarts.
- A Redis distributed lock (`chainsettle:event-poller:leader`) ensures only one instance processes events in multi-pod / blue-green deployments.
- An `EVENT_POLLING_INTERVAL_MS` environment variable exists (default `5000`) for configurability, though the current subscription loop uses a hardcoded 1-second interval.

## Consequences

- **Positive**
  - Works with any Soroban RPC that supports `getEvents`; no dependency on a streaming API that may not exist or may be rate-limited.
  - Simple failure mode: if the loop throws, it exits; a fresh instance picks up the cursor on restart.
  - Cursor is persisted in PostgreSQL, so event processing is resumable after crashes.
  - Leader election via Redis prevents double-processing during rolling deploys.
- **Negative**
  - Events are not truly real-time; there is up to a 1–5 second delay.
  - Tight polling generates more RPC load than a push-based model.
  - The 1-second interval is hardcoded in `stellar.service.ts` despite the existence of `EVENT_POLLING_INTERVAL_MS`; this is a known inconsistency.
- **Neutral**
  - A weekly `ReconciliationJob` (`@Cron('0 2 * * 0')`) exists as a safety net to catch any events that slipped through the poller.
