# Transaction Relay — Preparing and Submitting Signed Transactions

State-changing contract calls (confirming a milestone, raising a dispute, cancelling a shipment) are signed by the user's own wallet. The backend never holds user keys. Instead it:

1. **Prepares** an unsigned, simulated, resource-assembled Soroban transaction.
2. Hands the XDR to the frontend, which asks **Freighter** to sign it.
3. **Relays** the signed envelope to Stellar RPC, retrying transient failures.
4. Reports the **final status** over WebSocket and through a status lookup endpoint.

> **Related docs**
> - Getting a JWT first: [Authentication — Sign-In With Stellar](./authentication.md)
> - Live `chain:tx` events: [WebSockets](./websockets.md)
> - Milestone states: [Shipment Lifecycle](./shipment-lifecycle.md)
> - Error codes: [Disputes](./disputes.md), [Rate Limiting](./rate-limiting.md)

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Step 1 — Prepare the Unsigned Transaction](#step-1--prepare-the-unsigned-transaction)
- [Step 2 — Sign with Freighter](#step-2--sign-with-freighter)
- [Step 3 — Submit the Signed Transaction](#step-3--submit-the-signed-transaction)
- [Step 4 — Track the Final Status](#step-4--track-the-final-status)
- [Status Values](#status-values)
- [Fee Sponsorship](#fee-sponsorship)
- [Error Handling and Retries](#error-handling-and-retries)
- [Full TypeScript Example](#full-typescript-example)

---

## Overview

```
Frontend                         ChainSettle API                      Stellar RPC
   │  POST …/prepare  (JWT)            │                                   │
   │──────────────────────────────────▶│  getAccount + simulateTransaction │
   │                                   │──────────────────────────────────▶│
   │◀──────────── { xdr, … } ──────────│                                   │
   │                                   │                                   │
   │  Freighter.signTransaction(xdr)   │                                   │
   │                                   │                                   │
   │  POST /chain/submit { signedXdr } │                                   │
   │──────────────────────────────────▶│  sendTransaction (with retries)   │
   │◀──── 202 { hash, status } ────────│──────────────────────────────────▶│
   │                                   │  getTransaction (poll every 2 s)  │
   │◀──── WS "chain:tx" {hash,status} ─│──────────────────────────────────▶│
   │  GET /chain/transactions/:hash    │                                   │
```

All endpoints live under the `/api/v1` prefix, require `Authorization: Bearer <JWT>` and wrap successful responses in `{ "success": true, "data": …, "timestamp": … }`. Errors are returned as RFC 9457 problem details (`type`, `title`, `status`, `detail`, `code`).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| A JWT for the signing wallet | Obtain via the [Sign-In With Stellar flow](./authentication.md). The transaction source account is always the JWT's `stellarAddress`. |
| Funded Stellar account | The source account must exist on-chain; otherwise prepare returns `422`. |
| [Freighter](https://www.freighter.app/) on the correct network | Must match the network the API runs against (`networkPassphrase` returned by prepare). |
| `@stellar/freighter-api` | `npm install @stellar/freighter-api` |

---

## Step 1 — Prepare the Unsigned Transaction

| Action | Endpoint | Who may call |
|--------|----------|--------------|
| Confirm a milestone | `POST /api/v1/shipments/:shipmentId/milestones/:index/confirm/prepare` | Buyer, milestone must be `PROOF_SUBMITTED` |
| Raise a dispute | `POST /api/v1/shipments/:shipmentId/milestones/:index/dispute/prepare` | Buyer or supplier, milestone `PENDING` or `PROOF_SUBMITTED` |
| Cancel a shipment | `POST /api/v1/shipments/:shipmentId/cancel/prepare` | Buyer |

All three require the shipment to be `ACTIVE`. The dispute endpoint accepts an optional body `{ "reason": "…" }` (max 500 chars).

The server builds the contract invocation, simulates it against Stellar RPC and assembles the Soroban resource footprint and fees, so the returned XDR is ready to sign as-is.

**Response — HTTP 200**

```json
{
  "success": true,
  "data": {
    "xdr": "AAAAAgAAAAB…",
    "networkPassphrase": "Test SDF Network ; September 2015",
    "simulatedFee": "84213",
    "expiresAtLedger": 1234620
  },
  "timestamp": "2026-11-25T10:00:00.000Z"
}
```

| Field | Meaning |
|-------|---------|
| `xdr` | Base64 unsigned transaction envelope. Do not modify it — any change invalidates the simulation. |
| `networkPassphrase` | Pass this to Freighter so the wallet signs for the right network. |
| `simulatedFee` | Minimum resource fee (stroops) from simulation, for display. |
| `expiresAtLedger` | Approximate ledger after which the transaction's time bounds (300 s) expire. Sign and submit before then, or prepare again. |

---

## Step 2 — Sign with Freighter

```typescript
import { getNetworkDetails, signTransaction } from "@stellar/freighter-api";

async function signWithFreighter(
  xdr: string,
  networkPassphrase: string,
  address: string,
): Promise<string> {
  const network = await getNetworkDetails();
  if (network.networkPassphrase !== networkPassphrase) {
    throw new Error(
      `Freighter is on "${network.network}" but this transaction is for "${networkPassphrase}". ` +
        "Switch networks in Freighter and try again.",
    );
  }

  const result = await signTransaction(xdr, { networkPassphrase, address });
  if ("error" in result && result.error) {
    // User rejected the request or Freighter is locked
    throw new Error(`Freighter declined to sign: ${result.error}`);
  }
  return result.signedTxXdr;
}
```

> The account Freighter signs with must be the same account you authenticated with. The relay rejects envelopes whose source account is not the caller.

---

## Step 3 — Submit the Signed Transaction

**Request**

```http
POST /api/v1/chain/submit
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "signedXdr": "AAAAAgAAAAB…", "sponsor": false }
```

| Field | Type | Notes |
|-------|------|-------|
| `signedXdr` | string | Base64 signed envelope, max 100 000 chars |
| `sponsor` | boolean, optional | Ask the platform to pay the fee via a fee bump — see [Fee Sponsorship](#fee-sponsorship) |

Before relaying, the server checks that:

- the XDR decodes as a transaction for the server's network;
- the inner transaction's source account equals the caller's `stellarAddress` (otherwise `403`);
- the envelope carries a valid signature from the caller. Because the transaction hash commits to the network passphrase, a signature made on the wrong network fails this check (`400`).

The relay then calls `sendTransaction`, retrying up to 3 times with exponential backoff (500 ms, 1 s, 2 s) on network errors or `TRY_AGAIN_LATER`.

**Response — HTTP 202**

```json
{
  "success": true,
  "data": { "hash": "3f1c…e9a0", "status": "PENDING", "sponsored": false },
  "timestamp": "2026-11-25T10:00:05.000Z"
}
```

`202 Accepted` means the network received the transaction — **not** that it succeeded. Keep the `hash` and wait for the final status.

---

## Step 4 — Track the Final Status

After a successful submission the server polls `getTransaction` every 2 seconds, up to 30 times (~60 s), and pushes the outcome to the caller's WebSocket room as a `chain:tx` event:

```json
{ "hash": "3f1c…e9a0", "status": "SUCCESS", "ledger": 1234567, "resultXdr": null }
```

You can also (or instead) poll the REST endpoint, which is useful after a page reload or a dropped socket:

```http
GET /api/v1/chain/transactions/3f1c…e9a0
```

```json
{
  "success": true,
  "data": {
    "hash": "3f1c…e9a0",
    "status": "SUCCESS",
    "ledger": 1234567,
    "createdAt": "2026-11-25T10:00:09.000Z",
    "feeCharged": "84313",
    "resultCode": "txSuccess",
    "envelopeXdr": "…",
    "resultXdr": "…",
    "events": [],
    "shipmentId": "SHIP-001"
  }
}
```

`SUCCESS` and `FAILED` lookups are cached server-side for 24 h. This endpoint is limited to 20 requests per minute — poll every 2–5 seconds, not in a tight loop.

On-chain state changes (e.g. a milestone becoming `CONFIRMED`) are applied to the database by the event indexer once the ledger closes, so the shipment/milestone read endpoints may lag the `SUCCESS` status by a few seconds.

---

## Status Values

### `POST /chain/submit` → `data.status`

| Status | Meaning | What to do |
|--------|---------|------------|
| `PENDING` | Accepted into the RPC node's queue. | Wait for `chain:tx` or poll the status endpoint. |
| `DUPLICATE` | This exact transaction was already submitted. | Treat like `PENDING` — track the same `hash`. |
| `TRY_AGAIN_LATER` | The node was still congested after all server-side retries. | Resubmit the **same** `signedXdr` after a few seconds, while it is still within its time bounds. |
| `FAILED` | Rejected at submission (e.g. bad sequence number, insufficient fee/balance). A `chain:tx` event with `resultXdr` is also pushed. | Inspect the error, then prepare and sign a **new** transaction. |

### `chain:tx` event → `status`

| Status | Meaning |
|--------|---------|
| `SUCCESS` | Included in a ledger and executed successfully. |
| `FAILED` | Included in a ledger but the contract call failed. `resultXdr` holds the base64 result. |
| `TIMEOUT` | Not finalized after ~60 s of polling. The transaction may still land — check `GET /chain/transactions/:hash`. |

### `GET /chain/transactions/:hash` → `data.status`

| Status | Meaning |
|--------|---------|
| `SUCCESS` | Finalized successfully (cached 24 h). |
| `FAILED` | Finalized with an error (cached 24 h). Check `resultCode`. |
| `PENDING` | Known but not finalized yet. Keep polling. |
| `NOT_FOUND` | Not (yet) seen by the RPC node, or outside its retention window. Right after submission, keep polling; if it stays `NOT_FOUND` past `expiresAtLedger`, the transaction expired — prepare a new one. |

---

## Fee Sponsorship

Pass `"sponsor": true` to have the platform's sponsor account wrap your transaction in a fee bump and pay the fee. Sponsorship is subject to a per-user daily cap (`FEE_SPONSOR_DAILY_CAP_STROOPS`).

| Response | Cause |
|----------|-------|
| `403` *Daily fee sponsorship cap reached* | Resubmit without `sponsor`, or try again tomorrow. |
| `503` *Fee sponsorship is not configured* | The server has no `FEE_SPONSOR_SECRET_KEY`; submit without `sponsor`. |
| `400` *Cannot sponsor a transaction that is already a fee bump* | Send the plain signed transaction, not a fee bump. |

If the submission fails, the reserved amount is released back to your daily allowance.

---

## Error Handling and Retries

| HTTP | Endpoint | Cause | Retry? |
|------|----------|-------|--------|
| `401` | any | Missing/expired/revoked JWT | Re-authenticate, then retry. |
| `403` | prepare | Caller is not allowed to perform this action (wrong role on the shipment). | No. |
| `403` | submit | Source account is not the caller, or sponsorship cap reached. | No (sign with the authenticated wallet). |
| `404` | prepare | Shipment or milestone not found. | No. |
| `409` | prepare | Shipment not `ACTIVE` or milestone in the wrong status. | No — refresh the UI state. |
| `422` | prepare | Source account missing on-chain, or contract simulation failed. The body includes `error` and the simulation `events`. | Only after fixing the cause. |
| `400` | submit | Invalid XDR, or not signed by the caller for this network. | No — re-sign on the correct network. |
| `429` | prepare / submit / status | Rate limited (`/chain/submit`: 10 per minute per address). | Yes, after the `Retry-After` header. |
| `502` | submit | RPC unreachable after 3 server-side retries. | Yes — resubmit the same `signedXdr` with backoff. |

General guidance:

- **Resubmitting the same signed XDR is safe.** A transaction can only be applied once; a repeat submission returns `DUPLICATE` or the same hash.
- **Never re-sign an old XDR after it failed on-chain.** Its sequence number is consumed or its time bounds are stale — prepare a fresh one.
- **Re-prepare if the user takes too long.** The transaction is valid for 300 seconds after preparation.
- Treat a Freighter rejection as a user cancellation, not an error to retry automatically.

---

## Full TypeScript Example

```typescript
import { getNetworkDetails, signTransaction } from "@stellar/freighter-api";
import { io, Socket } from "socket.io-client";

const API = "https://api.example.com/api/v1";

type SubmitStatus = "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "FAILED";
type FinalStatus = "SUCCESS" | "FAILED" | "TIMEOUT";

interface PreparedTransaction {
  xdr: string;
  networkPassphrase: string;
  simulatedFee: string;
  expiresAtLedger: number;
}

class ApiError extends Error {
  constructor(public status: number, public problem: any, public retryAfterMs?: number) {
    super(problem?.detail ?? problem?.message ?? `HTTP ${status}`);
  }
}

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    throw new ApiError(res.status, body, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
  }
  return body.data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Step 2 — ask Freighter to sign the prepared XDR. */
async function sign(prepared: PreparedTransaction, address: string): Promise<string> {
  const network = await getNetworkDetails();
  if (network.networkPassphrase !== prepared.networkPassphrase) {
    throw new Error(`Switch Freighter to the network "${prepared.networkPassphrase}"`);
  }
  const result = await signTransaction(prepared.xdr, {
    networkPassphrase: prepared.networkPassphrase,
    address,
  });
  if ("error" in result && result.error) throw new Error(`Signing cancelled: ${result.error}`);
  return result.signedTxXdr;
}

/** Step 3 — submit, retrying transient failures with the same signed XDR. */
async function submit(token: string, signedXdr: string, sponsor = false) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await api<{ hash: string; status: SubmitStatus; sponsored?: boolean }>(
        token,
        "/chain/submit",
        { method: "POST", body: JSON.stringify({ signedXdr, sponsor }) },
      );
      if (res.status !== "TRY_AGAIN_LATER") return res;
    } catch (err) {
      const retryable = err instanceof ApiError && (err.status === 429 || err.status === 502);
      if (!retryable) throw err;
      if (err.retryAfterMs) {
        await sleep(err.retryAfterMs);
        continue;
      }
    }
    await sleep(1000 * 2 ** attempt);
  }
  throw new Error("Network is congested — please try again shortly");
}

/** Step 4 — wait for the final status via WebSocket, falling back to polling. */
function waitForFinalStatus(token: string, socket: Socket, hash: string): Promise<FinalStatus> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: FinalStatus) => {
      if (done) return;
      done = true;
      socket.off("chain:tx", onEvent);
      resolve(status);
    };

    const onEvent = (evt: { hash: string; status: FinalStatus }) => {
      if (evt.hash !== hash) return;
      if (evt.status === "TIMEOUT") void poll(); // may still land — keep checking
      else finish(evt.status);
    };
    socket.on("chain:tx", onEvent);

    // Fallback polling (also covers a dropped socket)
    const poll = async () => {
      for (let i = 0; i < 40 && !done; i++) {
        await sleep(3000);
        try {
          const tx = await api<{ status: string }>(token, `/chain/transactions/${hash}`);
          if (tx.status === "SUCCESS" || tx.status === "FAILED") return finish(tx.status);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 429)) throw err;
        }
      }
      finish("TIMEOUT");
    };
    void poll();
  });
}

/** Prepare → sign → submit → track, for confirming a milestone. */
export async function confirmMilestone(
  token: string,
  address: string,
  shipmentId: string,
  index: number,
): Promise<FinalStatus> {
  const socket = io("wss://api.example.com/notifications", { auth: { token } });
  try {
    const prepared = await api<PreparedTransaction>(
      token,
      `/shipments/${encodeURIComponent(shipmentId)}/milestones/${index}/confirm/prepare`,
      { method: "POST" },
    );

    const signedXdr = await sign(prepared, address);
    const sent = await submit(token, signedXdr);

    if (sent.status === "FAILED") return "FAILED";
    return await waitForFinalStatus(token, socket, sent.hash);
  } finally {
    socket.disconnect();
  }
}
```

Usage:

```typescript
const status = await confirmMilestone(accessToken, stellarAddress, "SHIP-001", 0);
if (status === "SUCCESS") showToast("Milestone confirmed — payment released");
else if (status === "FAILED") showToast("The transaction failed on-chain");
else showToast("Still processing — we'll update you when it lands");
```
