# ADR-0001: Sign-In With Stellar (challenge/nonce JWT) instead of passwords

**Status:** Accepted

## Context

ChainSettle is a multi-party trade-settlement platform built on Stellar / Soroban. Every user already holds a Stellar keypair and interacts with the network through a wallet extension (Freighter). Shipping counterparties — buyers, suppliers, logistics providers, and arbiters — are identified on-chain by their Stellar public keys.

Introducing a separate username/password system would:

- Duplicate identity (a user would need both a Stellar address and a password).
- Require password reset flows, email verification, and breach-response procedures.
- Add a credential type that is not native to the Stellar ecosystem.
- Increase onboarding friction for users who already have a wallet.

We need an authentication mechanism that is tightly coupled to the user's on-chain identity and wallet workflow.

## Decision

Adopt **Sign-In With Stellar** as the sole primary authentication method.

The flow is:

1. Frontend requests a nonce for a Stellar address: `GET /api/v1/auth/nonce?address=G<pubkey>`.
2. `AuthService.generateNonce()` creates a challenge string (`chainsettle:<address>:<timestamp>:<random>`), stores it in Redis under key `nonce:<address>` with a 5-minute TTL, and returns it to the client.
3. The user signs the nonce bytes with Freighter (ed25519).
4. Frontend sends `POST /api/v1/auth/login` with `{ stellarAddress, signature }`.
5. `AuthService.login()` retrieves the nonce from Redis, deletes it immediately (one-time use), and verifies the signature using `Keypair.verify(nonce bytes, signature, publicKey)`.
6. On success, the backend issues a short-lived access JWT (`sub = userId`, `stellarAddress`, `role`) and a refresh token (hashed, stored in Redis).

No passwords, password-reset endpoints, or email-as-identity flows exist for primary authentication.

## Consequences

- **Positive**
  - Users authenticate with the same wallet they already use for on-chain transactions.
  - No password database to secure, breach-notify, or reset.
  - Phishing resistance: the nonce is single-use and short-lived.
  - The Stellar address *is* the identity — no account-linking complexity.
- **Negative**
  - Users must have Freighter (or a compatible wallet) installed.
  - Lost wallet access = lost account access; no password recovery path.
  - Nonce endpoint is vulnerable to flooding if not rate-limited (mitigated by `StellarAddressThrottlerGuard` and Redis-backed throttling).
- **Neutral**
  - API keys (`X-API-Key`) were later added for machine-to-machine auth because JWTs are inconvenient for scripts.
