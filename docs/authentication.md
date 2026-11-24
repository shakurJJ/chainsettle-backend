# Authentication — Sign-In With Stellar

ChainSettle uses **Sign-In With Stellar** as its sole primary authentication mechanism — no passwords, no email/password combos. Your Stellar keypair *is* your identity. This guide walks through every step of the flow so you can integrate it into a client application.

> **Related docs**
> - Architecture Decision: [ADR-0001 — Sign-In With Stellar](./adr/0001-sign-in-with-stellar.md)
> - Machine-to-machine auth: [API Keys](./api-keys.md)
> - Role/permission matrix: [RBAC](./rbac.md)
> - Rate limiting headers: see [README — Rate Limiting](../README.md#rate-limiting)

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Step 1 — Request a Nonce](#step-1--request-a-nonce)
- [Step 2 — Sign the Nonce](#step-2--sign-the-nonce)
  - [Signing with Freighter](#signing-with-freighter)
  - [Signing with @stellar/stellar-sdk (server-side / testing)](#signing-with-stellarstellar-sdk-server-side--testing)
- [Step 3 — Exchange the Signature for a JWT](#step-3--exchange-the-signature-for-a-jwt)
- [Step 4 — Use the JWT](#step-4--use-the-jwt)
- [JWT Expiry and Refresh](#jwt-expiry-and-refresh)
- [Logout](#logout)
- [API Keys (M2M Auth)](#api-keys-m2m-auth)
- [Common Errors](#common-errors)
- [Full TypeScript Example](#full-typescript-example)

---

## Overview

The authentication flow follows a classic **challenge–response** pattern:

```
Client                                     Server
  │                                           │
  │── GET /api/v1/auth/nonce?address=G... ──►│
  │◄── { nonce: "chainsettle:G...:ts:rand" } ─│
  │                                           │
  │  [user signs nonce in Freighter wallet]   │
  │                                           │
  │── POST /api/v1/auth/login ───────────────►│
  │   { stellarAddress, signedNonce,          │
  │     signature }                           │
  │◄── { accessToken: "eyJ..." } ─────────── │
  │                                           │
  │── GET /api/v1/shipments                  │
  │   Authorization: Bearer eyJ... ──────────►│
  │◄── { success: true, data: [...] } ────── │
```

Key properties of this design:

| Property | Detail |
|----------|--------|
| **No password** | The private key never leaves the wallet |
| **One-time nonce** | The nonce is deleted on first use — replaying a signature fails |
| **Short-lived nonce** | 5-minute TTL in Redis; expired nonces return `401` |
| **JWT access token** | Short-lived; sent as `Authorization: Bearer <token>` on every request |
| **Phishing-resistant** | Signing `chainsettle:<address>:<timestamp>:<random>` is meaningless on any other service |

---

## Prerequisites

- A Stellar keypair (G… public key + matching secret key)
- [Freighter wallet extension](https://www.freighter.app/) installed in your browser **or** the `@stellar/stellar-sdk` npm package for server-side / testing use
- Your application connected to the correct Stellar network (`testnet` or `mainnet`) — see [Wrong Network error](#wrong-network) below

---

## Step 1 — Request a Nonce

Send the user's Stellar public address to the nonce endpoint. The server generates a unique, time-limited challenge string and stores it in Redis for 5 minutes.

**Request**

```http
GET /api/v1/auth/nonce?address=GABC123XYZ...
```

**Response — HTTP 200**

```json
{
  "success": true,
  "data": {
    "nonce": "chainsettle:GABC123XYZ...:1717600000000:k3x9pq",
    "address": "GABC123XYZ..."
  },
  "timestamp": "2026-06-05T12:00:00.000Z"
}
```

The `nonce` string has four colon-delimited parts:

| Part | Example | Meaning |
|------|---------|--------|
| Prefix | `chainsettle` | Scopes the challenge to this service |
| Address | `GABC123...` | Ties the nonce to one specific keypair |
| Timestamp | `1717600000000` | Unix epoch ms; used to set the 5-minute TTL |
| Random | `k3x9pq` | Entropy that makes the nonce unguessable |

> **Rate limit:** 5 requests per address per 60 seconds. Excess requests return `429 Too Many Requests` with a `Retry-After` header.

**Example — cURL**

```bash
curl -s "https://api.example.com/api/v1/auth/nonce?address=GABC123XYZ..."
```

---

## Step 2 — Sign the Nonce

The nonce must be signed with the private key that corresponds to the Stellar address you provided in Step 1. The signature is computed over the raw UTF-8 bytes of the nonce string and encoded as **Base64**.

### Signing with Freighter

[Freighter](https://www.freighter.app/) is the primary wallet for ChainSettle's browser-based flows. It exposes a `signMessage` method that signs arbitrary bytes without exposing the private key to the page.

```typescript
import {
  isConnected,
  getAddress,
  getNetwork,
  signMessage,
} from "@stellar/freighter-api";

/**
 * Returns the Base64-encoded signature of the nonce, or throws if the
 * user rejects the signing request or is on the wrong network.
 */
async function signChallengeWithFreighter(
  nonce: string,
  expectedNetwork: "TESTNET" | "PUBLIC",
): Promise<{ stellarAddress: string; signature: string }> {
  // 1. Make sure Freighter is installed and connected
  const connected = await isConnected();
  if (!connected) {
    throw new Error(
      "Freighter is not installed. Visit https://www.freighter.app/ to install it.",
    );
  }

  // 2. Confirm the user is on the correct network
  const network = await getNetwork();
  if (network !== expectedNetwork) {
    throw new Error(
      `Wrong network: Freighter is on ${network} but this app requires ${expectedNetwork}. ` +
        `Switch networks in the Freighter extension and try again.`,
    );
  }

  // 3. Get the connected public address
  const stellarAddress = await getAddress();

  // 4. Sign the nonce — Freighter prompts the user to approve
  //    The response is a Base64-encoded signature over the UTF-8 bytes of `nonce`
  const { signedMessage } = await signMessage(nonce, {
    accountToSign: stellarAddress,
  });

  return { stellarAddress, signature: signedMessage };
}
```

> `signMessage` triggers a Freighter popup. The user must click **Sign** before the promise resolves. If the user dismisses the popup, Freighter rejects the promise with an error.

### Signing with @stellar/stellar-sdk (server-side / testing)

For automated tests, CI scripts, or backend-to-backend calls where no browser wallet is available:

```typescript
import { Keypair } from "@stellar/stellar-sdk";

/**
 * Signs a nonce with a raw Stellar secret key.
 * NEVER use this in a browser — it exposes the secret key.
 * Safe for server-side code and test helpers only.
 */
function signChallengeWithKeypair(
  nonce: string,
  secretKey: string, // S... key — keep this secret!
): { stellarAddress: string; signature: string } {
  const keypair = Keypair.fromSecret(secretKey);
  const nonceBytes = Buffer.from(nonce, "utf-8");
  const signatureBytes = keypair.sign(nonceBytes);
  const signature = signatureBytes.toString("base64");

  return {
    stellarAddress: keypair.publicKey(),
    signature,
  };
}
```

---

## Step 3 — Exchange the Signature for a JWT

Send the original nonce string plus the Base64 signature to the login endpoint.

**Request**

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "stellarAddress": "GABC123XYZ...",
  "signedNonce": "chainsettle:GABC123XYZ...:1717600000000:k3x9pq",
  "signature": "<Base64-encoded signature>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `stellarAddress` | string | The G… Stellar public key |
| `signedNonce` | string | The nonce string returned in Step 1 |
| `signature` | string | Base64-encoded ed25519 signature of the nonce |

**Response — HTTP 200**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "clxyz123abc",
      "stellarAddress": "GABC123XYZ...",
      "role": "BUYER",
      "name": null,
      "email": null,
      "createdAt": "2026-06-05T12:00:05.000Z"
    }
  },
  "timestamp": "2026-06-05T12:00:05.000Z"
}
```

The JWT payload looks like this (decoded):

```json
{
  "sub": "clxyz123abc",
  "stellarAddress": "GABC123XYZ...",
  "role": "BUYER",
  "jti": "550e8400-e29b-41d4-a716-446655440000",
  "iat": 1717600005,
  "exp": 1718204805
}
```

| Claim | Meaning |
|-------|---------|
| `sub` | Internal user ID (UUID) |
| `stellarAddress` | The user's G… public key |
| `role` | `BUYER`, `SUPPLIER`, `LOGISTICS`, `ARBITER`, or `ADMIN` |
| `jti` | Unique session ID — used for individual session revocation |
| `iat` | Issued-at timestamp (Unix seconds) |
| `exp` | Expiry timestamp (Unix seconds) |

> **Rate limit:** 10 login attempts per address per 60 seconds.

**Example — cURL**

```bash
curl -s -X POST https://api.example.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "stellarAddress": "GABC123XYZ...",
    "signedNonce": "chainsettle:GABC123XYZ...:1717600000000:k3x9pq",
    "signature": "BASE64_SIGNATURE_HERE"
  }'
```

---

## Step 4 — Use the JWT

Include the access token in the `Authorization` header of every subsequent request:

```http
GET /api/v1/shipments
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

All protected endpoints return `401 Unauthorized` when the token is missing, malformed, expired, or revoked.

```bash
curl -s https://api.example.com/api/v1/shipments \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

## JWT Expiry and Refresh

### Token lifetime

The default access token lifetime is controlled by the `JWT_EXPIRES_IN` environment variable (default `7d`). You can read the `exp` claim from the decoded JWT to know exactly when it expires.

```typescript
import { jwtDecode } from "jwt-decode";

interface JwtPayload {
  sub: string;
  stellarAddress: string;
  role: string;
  jti: string;
  iat: number;
  exp: number;
}

function getTokenExpiryMs(token: string): number {
  const { exp } = jwtDecode<JwtPayload>(token);
  return exp * 1000; // convert to milliseconds
}

function isTokenExpired(token: string): boolean {
  return Date.now() >= getTokenExpiryMs(token);
}
```

### Refresh strategy

ChainSettle does not expose a dedicated `/auth/refresh` endpoint. The refresh token is managed server-side in Redis and is exchanged automatically when the token lifetime is still within the refresh window. The recommended client strategy is:

1. Store the `accessToken` (e.g. in memory or a secure cookie).
2. Before making an API call, check if the token is within 60 seconds of expiry.
3. If it is close to expiry or already expired, re-run the full nonce → sign → login flow to obtain a fresh token.
4. If the user's wallet is connected and auto-sign is not desirable, prompt the user to re-authenticate.

```typescript
let accessToken: string | null = null;

async function getValidToken(
  stellarAddress: string,
  signFn: (nonce: string) => Promise<string>,
): Promise<string> {
  if (accessToken && !isTokenExpired(accessToken)) {
    return accessToken;
  }

  // Re-authenticate: fetch nonce → sign → login
  const nonceRes = await fetch(
    `/api/v1/auth/nonce?address=${encodeURIComponent(stellarAddress)}`,
  );
  const { data: { nonce } } = await nonceRes.json();

  const signature = await signFn(nonce);

  const loginRes = await fetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stellarAddress, signedNonce: nonce, signature }),
  });

  const { data } = await loginRes.json();
  accessToken = data.accessToken;
  return accessToken;
}
```

---

## Logout

Calling the logout endpoint invalidates the current JWT session on the server side. The token's `jti` claim is added to a blocklist in Redis, so the token is rejected on all subsequent requests even if it has not expired yet.

**Request**

```http
POST /api/v1/auth/logout
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Response — HTTP 200**

```json
{
  "success": true,
  "data": {
    "message": "Logged out successfully"
  },
  "timestamp": "2026-06-05T12:30:00.000Z"
}
```

After logout:
- Discard the `accessToken` from your client-side storage.
- Any subsequent request with the old token will return `401 Unauthorized`.

```bash
curl -s -X POST https://api.example.com/api/v1/auth/logout \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

## API Keys (M2M Auth)

For server-to-server integrations, CI pipelines, and scripts that cannot run an interactive Stellar signing flow, ChainSettle supports API keys as an alternative to JWTs.

API keys are created and managed through the JWT-authenticated key-management endpoints and sent via the `X-Api-Key` header:

```bash
curl -s https://api.example.com/api/v1/shipments \
  -H "X-Api-Key: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
```

For the full guide — creating keys, scopes, rotation, revocation, and security best practices — see **[docs/api-keys.md](./api-keys.md)**.

---

## Common Errors

### Nonce expired

```json
{
  "success": false,
  "statusCode": 401,
  "message": "Nonce expired or not found. Request a new one."
}
```

**Cause:** More than 5 minutes elapsed between requesting the nonce and submitting the login request, or the nonce was already consumed by a previous login attempt.

**Fix:** Call `GET /api/v1/auth/nonce` again to get a fresh nonce and re-sign immediately.

---

### Invalid signature

```json
{
  "success": false,
  "statusCode": 401,
  "message": "Signature verification failed"
}
```

**Causes:**
- The `signature` field is not the Base64-encoded signature of the exact nonce string.
- The signing key does not match the `stellarAddress` in the request.
- The nonce bytes were signed after being decoded or re-encoded (sign the raw UTF-8 string, not a hex or buffer representation).
- A mismatch between `signedNonce` (the challenge string) and what was actually signed.

**Fix:** Ensure you sign `Buffer.from(nonce, 'utf-8')` and Base64-encode the resulting signature bytes. Pass the original nonce string as `signedNonce` without any modification.

---

### Wrong network

```json
{
  "success": false,
  "statusCode": 401,
  "message": "Signature verification failed"
}
```

This error has the same HTTP shape as an invalid signature. A common underlying cause on the client side is Freighter being connected to `TESTNET` while the app expects `PUBLIC` (or vice versa). The server validates the signature against the submitted Stellar address — a mismatch between networks is transparent to the server but results in a key that does not match.

**Fix:** In your Freighter integration, check `getNetwork()` before signing and compare it to the expected value (`TESTNET` or `PUBLIC`). Surface a user-friendly error if they mismatch:

```typescript
const network = await getNetwork();
if (network !== "TESTNET") {
  throw new Error(
    `Please switch Freighter to Testnet before signing in to this app.`,
  );
}
```

---

### Expired JWT

```json
{
  "success": false,
  "statusCode": 401,
  "message": "Unauthorized"
}
```

**Cause:** The access token has passed its `exp` claim, or it was manually revoked via the logout endpoint (or an admin force-logout).

**Fix:** Re-run the full nonce → sign → login flow to obtain a fresh token. See [JWT Expiry and Refresh](#jwt-expiry-and-refresh) for the recommended client-side pattern.

---

### Rate limit exceeded

```json
{
  "success": false,
  "statusCode": 429,
  "message": "Too Many Requests"
}
```

Response headers:

```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 42
Retry-After: 42
```

**Cause:** More than 5 nonce requests (or 10 login requests) per address within 60 seconds.

**Fix:** Respect the `Retry-After` header. Do not retry immediately — wait the indicated number of seconds.

---

### Missing or invalid Stellar address

```json
{
  "success": false,
  "statusCode": 400,
  "message": "stellarAddress must be a valid Stellar public key (G...)"
}
```

**Cause:** The `stellarAddress` field is missing, empty, or not a valid Ed25519 public key in Stellar's StrKey encoding (G… prefix, 56 characters).

**Fix:** Validate the address on the client before sending. A valid Stellar public key starts with `G` and is exactly 56 characters long. You can check with:

```typescript
import { StrKey } from "@stellar/stellar-sdk";

const isValid = StrKey.isValidEd25519PublicKey(address);
```

---

## Full TypeScript Example

This example wires together all four steps in a browser context using Freighter.

```typescript
import {
  isConnected,
  getAddress,
  getNetwork,
  signMessage,
} from "@stellar/freighter-api";

const API_BASE = "https://api.example.com/api/v1";
const EXPECTED_NETWORK: "TESTNET" | "PUBLIC" = "TESTNET";

// ---------- Step 1: Get nonce ----------
async function fetchNonce(stellarAddress: string): Promise<string> {
  const res = await fetch(
    `${API_BASE}/auth/nonce?address=${encodeURIComponent(stellarAddress)}`,
  );
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message ?? "Failed to fetch nonce");
  }
  const { data } = await res.json();
  return data.nonce;
}

// ---------- Step 2: Sign nonce with Freighter ----------
async function signNonce(
  nonce: string,
  stellarAddress: string,
): Promise<string> {
  const { signedMessage } = await signMessage(nonce, {
    accountToSign: stellarAddress,
  });
  return signedMessage; // already Base64
}

// ---------- Step 3: Login ----------
async function login(
  stellarAddress: string,
  signedNonce: string,
  signature: string,
): Promise<{ accessToken: string; user: unknown }> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stellarAddress, signedNonce, signature }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message ?? "Login failed");
  }
  const { data } = await res.json();
  return data;
}

// ---------- Entry point ----------
export async function connectAndLogin(): Promise<string> {
  // Guard: Freighter installed?
  if (!(await isConnected())) {
    throw new Error(
      "Freighter is not installed. Visit https://www.freighter.app/",
    );
  }

  // Guard: correct network?
  const network = await getNetwork();
  if (network !== EXPECTED_NETWORK) {
    throw new Error(
      `Switch Freighter to ${EXPECTED_NETWORK} before signing in.`,
    );
  }

  const stellarAddress = await getAddress();

  // Step 1
  const nonce = await fetchNonce(stellarAddress);

  // Step 2 — triggers Freighter popup
  const signature = await signNonce(nonce, stellarAddress);

  // Step 3
  const { accessToken } = await login(stellarAddress, nonce, signature);

  // Step 4 — store and use the token
  // Prefer an in-memory variable or a secure httpOnly cookie over localStorage.
  sessionStorage.setItem("chainsettle_token", accessToken);

  return accessToken;
}

// ---------- Authenticated fetch helper ----------
export async function apiFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = sessionStorage.getItem("chainsettle_token");
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

// ---------- Logout ----------
export async function logout(): Promise<void> {
  const token = sessionStorage.getItem("chainsettle_token");
  if (!token) return;

  await fetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  sessionStorage.removeItem("chainsettle_token");
}
```

---

*For questions or issues with this guide, open a GitHub issue or check the [Swagger docs](http://localhost:3000/docs) when running locally.*
