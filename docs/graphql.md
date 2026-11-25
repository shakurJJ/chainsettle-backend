# GraphQL API

ChainSettle exposes a GraphQL API alongside its REST endpoints. Both layers share the same authentication, database, and business-logic services — GraphQL is simply an alternative query interface that lets clients fetch exactly the fields they need and receive real-time updates over WebSocket subscriptions.

---

## Table of Contents

- [Endpoint](#endpoint)
- [Authentication](#authentication)
- [Schema Overview](#schema-overview)
- [Queries](#queries)
  - [shipment](#shipment)
  - [shipments](#shipments)
  - [milestones](#milestones)
  - [milestone](#milestone)
- [Mutations](#mutations)
  - [addComment](#addcomment)
  - [editComment](#editcomment)
  - [deleteComment](#deletecomment)
- [Subscriptions](#subscriptions)
  - [shipmentUpdated](#shipmentupdated)
  - [milestoneUpdated](#milestoneupdated)
  - [commentAdded](#commentadded)
- [Query Limits](#query-limits)
- [Persisted Queries (APQ)](#persisted-queries-apq)
  - [Automatic Persisted Queries](#automatic-persisted-queries)
  - [Allowlist mode](#allowlist-mode)
  - [Extracting queries from the frontend](#extracting-queries-from-the-frontend)
- [DataLoader Batching](#dataloader-batching)
- [GraphQL vs REST: When to Use Which](#graphql-vs-rest-when-to-use-which)
- [Introspection and Playground](#introspection-and-playground)

---

## Endpoint

| Transport | URL |
|-----------|-----|
| HTTP (queries & mutations) | `POST /graphql` |
| WebSocket (subscriptions) | `ws://<host>/graphql` (uses the `graphql-ws` sub-protocol) |

> Note: the GraphQL path is `/graphql` — it does **not** carry the `/api/v1` prefix used by the REST API.

---

## Authentication

All queries, mutations, and subscriptions require a valid JWT obtained from the REST login flow (`POST /api/v1/auth/login`).

### HTTP requests

Send the token in the standard `Authorization` header:

```
Authorization: Bearer <your-jwt>
```

`GqlJwtAuthGuard` (which wraps the same `JwtAuthGuard` used by REST) extracts the request from the GraphQL execution context and verifies the token identically. Requests without a valid token receive a `401 Unauthorized` error.

### WebSocket subscriptions

Pass the token in the `connectionParams` when opening the WebSocket connection. Either of the following key names is accepted:

```json
{ "authorization": "Bearer <your-jwt>" }
```

```json
{ "Authorization": "Bearer <your-jwt>" }
```

```json
{ "token": "<your-jwt>" }
```

The server authenticates the connection in `onConnect` before any subscription is started. Unauthenticated connections are refused immediately (the socket is closed). A deactivated user account is also rejected.

### Participant-only access

Every shipment and milestone operation enforces the same participant rule as REST: the caller's Stellar address must match one of `buyerAddress`, `supplierAddress`, `logisticsAddress`, or `arbiterAddress` on the shipment. Admin users bypass this check. Violations return `403 Forbidden`.

---

## Schema Overview

```graphql
type ShipmentGql {
  id: ID!
  buyerAddress: String!
  supplierAddress: String!
  logisticsAddress: String!
  arbiterAddress: String!
  status: String!
  totalAmount: String!       # stroops, as a string
  releasedAmount: String!    # stroops, as a string
  description: String
  referenceNumber: String
  createdAt: DateTime!
  milestones: [MilestoneGql!]!
  recentEvents: [ChainEventGql!]!
}

type MilestoneGql {
  id: ID!
  shipmentId: String!
  milestoneIndex: Int!
  name: String!
  paymentPercent: Int!
  status: String!
  proofHash: String
  confirmedAt: DateTime
  dueAt: DateTime
  paymentReleased: String     # stroops; null until payment released
  createdAt: DateTime
  proofSubmissions: [ProofSubmissionGql!]!
}

type ProofSubmissionGql {
  id: ID!
  milestoneId: String!
  ipfsCid: String!
  submittedBy: String!
  createdAt: DateTime!
}

type ChainEventGql {
  id: ID!
  eventName: String!
  ledger: Int!
  txHash: String!
  createdAt: DateTime!
}

type CommentGql {
  id: ID!
  shipmentId: String!
  authorAddress: String!
  body: String!
  createdAt: DateTime!
  updatedAt: DateTime!
}
```

---

## Queries

### shipment

Fetches a single shipment including its milestones and up to 10 recent on-chain events. The caller must be a participant on the shipment.

**Signature**

```graphql
query shipment($id: ID!): ShipmentGql!
```

**Example**

```graphql
query GetShipment($id: ID!) {
  shipment(id: $id) {
    id
    status
    totalAmount
    releasedAmount
    buyerAddress
    supplierAddress
    milestones {
      milestoneIndex
      name
      status
      paymentPercent
      confirmedAt
    }
    recentEvents {
      eventName
      ledger
      txHash
      createdAt
    }
  }
}
```

Variables:

```json
{ "id": "clx1abc2def3ghi4jkl5" }
```

curl:

```bash
curl -s -X POST https://api.example.com/graphql \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query GetShipment($id: ID!) { shipment(id: $id) { id status totalAmount milestones { name status } } }",
    "variables": { "id": "clx1abc2def3ghi4jkl5" }
  }'
```

---

### shipments

Returns the list of shipments visible to the authenticated user (i.e. shipments where the caller is a participant). Supports optional filtering and pagination.

**Signature**

```graphql
query shipments(
  status: String       # filter by shipment status, e.g. "PENDING", "IN_TRANSIT"
  page: Float          # 1-based page number
  limit: Float         # items per page
): [ShipmentGql!]!
```

**Example — all in-transit shipments, first page**

```graphql
query ListShipments($status: String, $page: Float, $limit: Float) {
  shipments(status: $status, page: $page, limit: $limit) {
    id
    status
    referenceNumber
    buyerAddress
    supplierAddress
    createdAt
    milestones {
      milestoneIndex
      name
      status
    }
  }
}
```

Variables:

```json
{ "status": "IN_TRANSIT", "page": 1, "limit": 20 }
```

curl:

```bash
curl -s -X POST https://api.example.com/graphql \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query ListShipments($status: String, $page: Float, $limit: Float) { shipments(status: $status, page: $page, limit: $limit) { id status referenceNumber createdAt } }",
    "variables": { "status": "IN_TRANSIT", "page": 1, "limit": 20 }
  }'
```

---

### milestones

Returns all milestones for a shipment. The caller must be a participant on the shipment. Milestone rows are batched through a DataLoader so fetching milestones for multiple shipments in a single request issues one database query, not one per shipment.

**Signature**

```graphql
query milestones($shipmentId: ID!): [MilestoneGql!]!
```

**Example — with full proof history**

```graphql
query GetMilestones($shipmentId: ID!) {
  milestones(shipmentId: $shipmentId) {
    id
    milestoneIndex
    name
    status
    paymentPercent
    paymentReleased
    proofHash
    dueAt
    confirmedAt
    proofSubmissions {
      ipfsCid
      submittedBy
      createdAt
    }
  }
}
```

Variables:

```json
{ "shipmentId": "clx1abc2def3ghi4jkl5" }
```

curl:

```bash
curl -s -X POST https://api.example.com/graphql \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query GetMilestones($shipmentId: ID!) { milestones(shipmentId: $shipmentId) { id name status proofHash proofSubmissions { ipfsCid submittedBy createdAt } } }",
    "variables": { "shipmentId": "clx1abc2def3ghi4jkl5" }
  }'
```

---

### milestone

Fetches a single milestone by its UUID. The caller must be a participant on the parent shipment.

**Signature**

```graphql
query milestone($id: ID!): MilestoneGql!
```

**Example**

```graphql
query GetMilestone($id: ID!) {
  milestone(id: $id) {
    id
    shipmentId
    milestoneIndex
    name
    status
    paymentPercent
    paymentReleased
    proofHash
    confirmedAt
    dueAt
    proofSubmissions {
      ipfsCid
      submittedBy
      createdAt
    }
  }
}
```

Variables:

```json
{ "id": "clm9xyz1abc2def3ghi4" }
```

curl:

```bash
curl -s -X POST https://api.example.com/graphql \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query GetMilestone($id: ID!) { milestone(id: $id) { id name status paymentPercent confirmedAt } }",
    "variables": { "id": "clm9xyz1abc2def3ghi4" }
  }'
```

---

## Mutations

The comment thread on a shipment can be managed entirely through GraphQL. The three comment mutations delegate to the same `CommentsService` used by the REST endpoints, so validation, access rules, and throttling behave identically across both layers.

### Access rules

All comment mutations enforce the same participant rule as the queries: the caller's Stellar address must match one of `buyerAddress`, `supplierAddress`, `logisticsAddress`, or `arbiterAddress` on the shipment. Admin users bypass this check. Violations return `403 Forbidden`.

Additional per-mutation rules:

| Mutation | Rule |
|----------|------|
| `addComment` | Caller must be a participant on the shipment |
| `editComment` | Caller must be the comment's author (admins may edit any comment) |
| `deleteComment` | Caller must be the comment's author (admins may delete any comment) |

### Throttling

Comment mutations are rate-limited per user, using the same throttler configuration as the REST comment endpoints. Exceeding the limit returns a `429 Too Many Requests` error with the standard `THROTTLED` extension code.

### addComment

Creates a comment on a shipment and publishes a `commentAdded` subscription event to all subscribers watching that shipment.

**Signature**

```graphql
mutation addComment($shipmentId: ID!, $body: String!): CommentGql!
```

**Example**

```graphql
mutation AddComment($shipmentId: ID!, $body: String!) {
  addComment(shipmentId: $shipmentId, body: $body) {
    id
    shipmentId
    authorAddress
    body
    createdAt
  }
}
```

Variables:

```json
{ "shipmentId": "clx1abc2def3ghi4jkl5", "body": "Proof of delivery uploaded to IPFS." }
```

curl:

```bash
curl -s -X POST https://api.example.com/graphql \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation AddComment($shipmentId: ID!, $body: String!) { addComment(shipmentId: $shipmentId, body: $body) { id body createdAt } }",
    "variables": { "shipmentId": "clx1abc2def3ghi4jkl5", "body": "Proof of delivery uploaded to IPFS." }
  }'
```

---

### editComment

Updates the body of an existing comment. Only the comment's author (or an admin) may edit it.

**Signature**

```graphql
mutation editComment($id: ID!, $body: String!): CommentGql!
```

**Example**

```graphql
mutation EditComment($id: ID!, $body: String!) {
  editComment(id: $id, body: $body) {
    id
    body
    updatedAt
  }
}
```

Variables:

```json
{ "id": "cmt7abc2def3ghi4jkl5", "body": "Proof of delivery uploaded to IPFS (corrected CID)." }
```

curl:

```bash
curl -s -X POST https://api.example.com/graphql \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation EditComment($id: ID!, $body: String!) { editComment(id: $id, body: $body) { id body updatedAt } }",
    "variables": { "id": "cmt7abc2def3ghi4jkl5", "body": "Proof of delivery uploaded to IPFS (corrected CID)." }
  }'
```

---

### deleteComment

Deletes a comment. Only the comment's author (or an admin) may delete it.

**Signature**

```graphql
mutation deleteComment($id: ID!): Boolean!
```

**Example**

```graphql
mutation DeleteComment($id: ID!) {
  deleteComment(id: $id)
}
```

Variables:

```json
{ "id": "cmt7abc2def3ghi4jkl5" }
```

curl:

```bash
curl -s -X POST https://api.example.com/graphql \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation DeleteComment($id: ID!) { deleteComment(id: $id) }",
    "variables": { "id": "cmt7abc2def3ghi4jkl5" }
  }'
```

---

## Subscriptions

Subscriptions deliver real-time pushes when on-chain events are processed. They use the `graphql-ws` protocol over a persistent WebSocket connection.

Authentication is handled at connection time (see [Authentication](#authentication) above). Per-subscription participant checks are also applied — the server refuses to start a subscription if the caller is not a participant on the requested shipment.

### shipmentUpdated

Fires whenever the shipment record changes (status updates, amount releases, etc.). Filtered server-side: only events for the requested shipment ID are delivered to this subscriber.

**Signature**

```graphql
subscription shipmentUpdated($id: ID!): ShipmentGql!
```

**Example**

```graphql
subscription WatchShipment($id: ID!) {
  shipmentUpdated(id: $id) {
    id
    status
    releasedAmount
    totalAmount
  }
}
```

**graphql-ws client example (TypeScript)**

```typescript
import { createClient } from 'graphql-ws';

const client = createClient({
  url: 'ws://localhost:3000/graphql',
  connectionParams: {
    authorization: `Bearer ${jwt}`,
  },
});

const unsubscribe = client.subscribe(
  {
    query: `
      subscription WatchShipment($id: ID!) {
        shipmentUpdated(id: $id) {
          id
          status
          releasedAmount
        }
      }
    `,
    variables: { id: 'clx1abc2def3ghi4jkl5' },
  },
  {
    next: (data) => console.log('Shipment update:', data),
    error: (err) => console.error('Subscription error:', err),
    complete: () => console.log('Subscription ended'),
  },
);

// Call unsubscribe() to stop listening
```

---

### milestoneUpdated

Fires whenever a milestone on the given shipment changes (proof submitted, confirmed, payment released, etc.). Filtered server-side by `shipmentId`.

**Signature**

```graphql
subscription milestoneUpdated($shipmentId: ID!): MilestoneGql!
```

**Example**

```graphql
subscription WatchMilestones($shipmentId: ID!) {
  milestoneUpdated(shipmentId: $shipmentId) {
    id
    milestoneIndex
    name
    status
    confirmedAt
    paymentReleased
  }
}
```

**graphql-ws client example (TypeScript)**

```typescript
const unsubscribe = client.subscribe(
  {
    query: `
      subscription WatchMilestones($shipmentId: ID!) {
        milestoneUpdated(shipmentId: $shipmentId) {
          id
          milestoneIndex
          name
          status
          confirmedAt
          paymentReleased
        }
      }
    `,
    variables: { shipmentId: 'clx1abc2def3ghi4jkl5' },
  },
  {
    next: (data) => console.log('Milestone update:', data),
    error: (err) => console.error(err),
    complete: () => console.log('Done'),
  },
);
```

---

### commentAdded

Fires whenever a new comment is created on the given shipment (via `addComment`). Filtered server-side by `shipmentId`. Edits and deletions do not emit events.

**Signature**

```graphql
subscription commentAdded($shipmentId: ID!): CommentGql!
```

**Example**

```graphql
subscription WatchComments($shipmentId: ID!) {
  commentAdded(shipmentId: $shipmentId) {
    id
    authorAddress
    body
    createdAt
  }
}
```

**graphql-ws client example (TypeScript)**

```typescript
const unsubscribe = client.subscribe(
  {
    query: `
      subscription WatchComments($shipmentId: ID!) {
        commentAdded(shipmentId: $shipmentId) {
          id
          authorAddress
          body
          createdAt
        }
      }
    `,
    variables: { shipmentId: 'clx1abc2def3ghi4jkl5' },
  },
  {
    next: (data) => console.log('New comment:', data),
    error: (err) => console.error(err),
    complete: () => console.log('Done'),
  },
);
```

---

## Query Limits

Two safety rules prevent abusive queries. Both are enforced at validation time — rejected operations never reach the resolvers.

### Depth limit

Queries may not nest fields deeper than **7 levels** (configurable via `GRAPHQL_MAX_DEPTH` env var). Introspection fields (`__schema`, `__type`) are excluded from the depth count.

Example rejection — depth 8:

```graphql
# This query would be rejected (depth exceeds 7)
{ shipments { milestones { proofSubmissions { milestone { shipment { milestones { proofSubmissions { id } } } } } } } }
```

Error response:

```json
{
  "errors": [{
    "message": "Query depth 8 exceeds the maximum allowed depth of 7",
    "extensions": { "code": "QUERY_TOO_DEEP", "depth": 8, "maxDepth": 7 }
  }]
}
```

### Complexity limit

Each field costs 1 point; list fields multiply by the requested `limit` argument (or 10 if no limit is provided). Operations over **1000 points** (configurable via `GRAPHQL_MAX_COMPLEXITY` env var) are rejected.

```json
{
  "errors": [{
    "message": "Query complexity 1200 exceeds the maximum allowed complexity of 1000",
    "extensions": { "code": "QUERY_TOO_COMPLEX", "complexity": 1200, "maxComplexity": 1000 }
  }]
}
```

To keep complexity low: request only the fields you need, pass explicit `limit` arguments on `shipments`, and avoid deeply nested selections.

---

## Persisted Queries (APQ)

The GraphQL endpoint supports **Automatic Persisted Queries (APQ)**. Instead of sending the full query text on every request, clients send a SHA-256 hash of the query; the server looks the query up in a Redis-backed cache and only asks the client to resend the full text if it has never seen that hash before. This reduces request payload size and shrinks the attack surface for ad-hoc queries.

### Automatic Persisted Queries

APQ is enabled by default. Any Apollo Client instance with `createPersistedQueryLink()` (or the built-in APQ support in Apollo Client 3+) works without further configuration:

```typescript
import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client';
import { createPersistedQueryLink } from '@apollo/client/link/persisted-queries';
import { sha256 } from 'crypto-hash';

const client = new ApolloClient({
  link: createPersistedQueryLink({ sha256 }).concat(
    new HttpLink({
      uri: 'https://api.example.com/graphql',
      headers: { Authorization: `Bearer ${jwt}` },
    }),
  ),
  cache: new InMemoryCache(),
});
```

How it works:

1. The client sends `extensions.persistedQuery = { version: 1, sha256Hash: "<hash>" }` with **no** `query` field.
2. If the server has the query cached (Redis), it executes it and returns the result.
3. If not, the server responds with `PersistedQueryNotFound`. The client automatically retries, this time including both the hash and the full query text.
4. The server validates, caches the query under its hash in Redis, and executes it.

Relevant environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GRAPHQL_APQ_ENABLED` | `true` | Set to `false` to disable APQ entirely (clients must always send full query text). |
| `GRAPHQL_APQ_TTL_SECONDS` | `86400` | How long a persisted query stays in the Redis cache. |
| `GRAPHQL_PERSISTED_ONLY` | `false` | Allowlist mode — see below. |

The Redis cache is shared across all API instances, so a query persisted by one instance is immediately available to the others.

### Allowlist mode

Setting `GRAPHQL_PERSISTED_ONLY=true` turns the endpoint into an **allowlist-only** server: any request whose query hash is not in the allowlist is rejected, even if the client sends the full query text. This is the recommended configuration for production deployments where the set of queries is known ahead of time.

```bash
GRAPHQL_PERSISTED_ONLY=true
GRAPHQL_ALLOWLIST_PATH=graphql/allowlist.json
```

| Variable | Default | Description |
|----------|---------|-------------|
| `GRAPHQL_PERSISTED_ONLY` | `false` | When `true`, only queries whose SHA-256 hash appears in the allowlist are executed. |
| `GRAPHQL_ALLOWLIST_PATH` | `graphql/allowlist.json` | Path to the allowlist file (relative to the project root). |

Rejected requests receive:

```json
{
  "errors": [{
    "message": "PersistedQueryNotSupported: query is not in the persisted query allowlist",
    "extensions": { "code": "PERSISTED_QUERY_NOT_ALLOWED" }
  }]
}
```

> Note: the allowlist is loaded once at startup. Restart the API (or redeploy) after regenerating it.

### Extracting queries from the frontend

The allowlist is generated from the GraphQL documents used by the frontend. The extraction script scans the frontend source directory for `query`, `mutation`, and `subscription` documents in `.ts`, `.tsx`, `.js`, `.jsx`, and `.graphql`/`.gql` files, normalizes each document (whitespace and comments stripped, fields sorted), computes its SHA-256 hash, and writes the hashes to the allowlist file.

Run it via the npm script:

```bash
npm run graphql:extract-queries
```

The script accepts the following options (all optional):

| Option | Default | Description |
|--------|---------|-------------|
| `--src <dir>` | `frontend/src` | Directory to scan for GraphQL documents. |
| `--out <file>` | `graphql/allowlist.json` | Output allowlist file. |
| `--check` | — | Do not write; exit non-zero if the allowlist is out of date (useful in CI). |

Example output (`graphql/allowlist.json`):

```json
{
  "version": 1,
  "generatedAt": "2024-01-01T00:00:00.000Z",
  "hashes": [
    "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
    "9a8b7c6d5e4f30211203f4e5d6c7b8a99a8b7c6d5e4f30211203f4e5d6c7b8a9"
  ]
}
```

Commit the regenerated allowlist whenever frontend queries change, and add `npm run graphql:extract-queries -- --check` to CI so a stale allowlist fails the build. Because the hash is computed over the normalized document, reformatting a query (indentation, comments) does not change its hash — but renaming a field or changing arguments does.

---

## DataLoader Batching

Nested fields on `ShipmentGql` and `MilestoneGql` are resolved through per-request DataLoaders:

| Loader | Batches |
|--------|---------|
| `milestonesByShipment` | All `milestones` sub-fields across a `shipments` list in one DB query |
| `proofsByMilestone` | All `proofSubmissions` sub-fields across a `milestones` list in one DB query |

This means fetching 20 shipments with their milestones costs 2 database queries (one for shipments, one batched milestone fetch), not 21. You do not need to do anything special to take advantage of this — it is automatic.

---

## GraphQL vs REST: When to Use Which

| Situation | Prefer |
|-----------|--------|
| You need a single shipment with milestones and events in one round-trip | **GraphQL** — `shipment` query returns everything nested |
| You want live updates when a milestone confirms | **GraphQL** — `milestoneUpdated` subscription |
| You are building a dashboard that lists shipments with variable columns | **GraphQL** — request only the fields rendered |
| You are posting, editing, or deleting a shipment comment | **GraphQL** — `addComment`, `editComment`, `deleteComment` mutations, plus the `commentAdded` subscription |
| You are submitting a proof, confirming a milestone, or any other write operation | **REST** — GraphQL only exposes comment mutations; all other writes go through REST |
| You are a CI pipeline or script using an API key | **REST** — API key auth is not supported on the GraphQL endpoint |
| You want Swagger-generated docs or SDK types | **REST** — the OpenAPI spec and TypeScript SDK are REST-only |
| You need paginated event history beyond the 10 most recent | **REST** — `GET /api/v1/events?shipmentId=...` supports full pagination |

In short: **read** with GraphQL when you benefit from field selection or subscriptions; use GraphQL **mutations** for the comment thread; **write** everything else with REST.

---

## Introspection and Playground

In development (`NODE_ENV` ≠ `production`):

- **Apollo Sandbox / Playground** is available at `http://localhost:3000/graphql` in a browser. Open it to explore the schema interactively with autocomplete.
- **Introspection** is enabled — tools like GraphQL Code Generator and Insomnia can pull the schema automatically.

In production both are disabled to avoid schema enumeration. Use `npm run generate:sdk` (which generates from the REST OpenAPI spec) or export the schema from a development instance if you need a static schema file.

When `GRAPHQL_PERSISTED_ONLY=true`, introspection is also effectively unavailable to ad-hoc clients: only the queries in the allowlist can be executed, so schema exploration must be done against a development instance.
