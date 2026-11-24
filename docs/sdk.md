# TypeScript SDK

The `sdk/` directory contains a typed TypeScript client generated directly from the
NestJS Swagger document. This guide covers installation, authentication, common usage
patterns, and how to keep the SDK in sync when the API changes.

---

## Contents

- [Installation and import](#installation-and-import)
- [Constructing a client](#constructing-a-client)
- [Authentication](#authentication)
- [Examples](#examples)
  - [1. Login flow (Stellar wallet auth)](#1-login-flow-stellar-wallet-auth)
  - [2. List shipments with pagination](#2-list-shipments-with-pagination)
  - [3. Submit milestone proof](#3-submit-milestone-proof)
  - [4. Error handling](#4-error-handling)
- [Regenerating the SDK](#regenerating-the-sdk)
- [The sdk-drift CI check](#the-sdk-drift-ci-check)
- [How generation works](#how-generation-works)

---

## Installation and import

The SDK lives inside the backend monorepo at `sdk/`. It is a private TypeScript package
with no compiled output — import it directly as TypeScript source.

**In a TypeScript project that lives alongside the backend:**

```ts
// Adjust the relative path to match your directory structure
import { createClient } from '../chainsettle-backend/sdk';
```

**Via a TypeScript path alias (recommended for monorepos):**

Add to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "@chainsettle/sdk": ["../chainsettle-backend/sdk/index.ts"]
    }
  }
}
```

Then import with:

```ts
import { createClient } from '@chainsettle/sdk';
```

The package exposes three named exports:

| Export | What it is |
|---|---|
| `createClient(options)` | Factory function — returns a configured client instance |
| `ClientOptions` | TypeScript type for the options object |
| `ChainSettleClient` | TypeScript type for the return value of `createClient` |
| `paths`, `components`, `operations` | Raw generated OpenAPI types (use for custom typed `request()` calls) |

---

## Constructing a client

```ts
import { createClient } from '@chainsettle/sdk';

const client = createClient({
  baseUrl: 'https://api.your-deployment.com', // required, no trailing slash
  accessToken: 'eyJ...',                       // optional JWT (set after login)
});
```

`ClientOptions`:

| Option | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | yes | API origin, e.g. `https://api.example.com` or `http://localhost:3000` |
| `accessToken` | `string` | no | Bearer JWT or API key — added as `Authorization: Bearer <token>` |
| `fetch` | `typeof fetch` | no | Custom fetch implementation (Node 18+ has a built-in; pass a ponyfill for older environments or to inject mocks in tests) |

The `baseUrl` is not embedded in `sdk/openapi.json` — you must always supply it explicitly.

---

## Authentication

ChainSettle uses **Stellar wallet auth** (Sign-in with Stellar): request a one-time nonce,
sign it with the Stellar keypair, then exchange the signature for a JWT.

Once you have a JWT, construct a new client with it (or reassign `accessToken` on an
existing one — but since `clientOptions` is captured at construction time, the simplest
pattern is to create a second client after login):

```ts
// Unauthenticated client — only needed for /auth/* endpoints
const anonClient = createClient({ baseUrl });

// Authenticated client — used for all other endpoints
const authClient = createClient({ baseUrl, accessToken: jwt });
```

API keys (long-lived machine tokens) can be used in the same way — pass the key string as
`accessToken`; the header is identical.

---

## Examples

### 1. Login flow (Stellar wallet auth)

```ts
import { createClient } from '@chainsettle/sdk';
import { Keypair } from '@stellar/stellar-sdk';

const BASE_URL = 'http://localhost:3000';
const keypair  = Keypair.fromSecret(process.env.STELLAR_SECRET_KEY!);

async function login(): Promise<string> {
  const anonClient = createClient({ baseUrl: BASE_URL });

  // Step 1: get a challenge nonce for the Stellar address
  const nonceRes = await anonClient.request(
    '/api/v1/auth/nonce',
    'get',
    { query: { address: keypair.publicKey() } },
  );
  const nonce = nonceRes.data?.nonce;
  if (!nonce) throw new Error('No nonce returned');

  // Step 2: sign the nonce with the Stellar keypair
  const signedNonce = keypair.sign(Buffer.from(nonce)).toString('hex');

  // Step 3: exchange the signature for a JWT
  const loginRes = await anonClient.request(
    '/api/v1/auth/login',
    'post',
    {
      body: {
        stellarAddress: keypair.publicKey(),
        signedNonce: nonce,
        signature:   signedNonce,
      },
    },
  );

  const token = loginRes.data?.accessToken;
  if (!token) throw new Error('Login failed — no access token');
  return token;
}

// Usage
const jwt = await login();
const client = createClient({ baseUrl: BASE_URL, accessToken: jwt });
```

---

### 2. List shipments with pagination

The `v1.getShipments()` convenience helper forwards any key/value pairs as query params.
Iterate pages until `data.meta.totalPages` is reached:

```ts
async function fetchAllShipments(client: ChainSettleClient) {
  let page = 1;
  const allShipments: unknown[] = [];

  while (true) {
    const res = await client.v1.getShipments({ page, limit: 50, status: 'ACTIVE' });

    const rows   = (res as any)?.data  ?? [];
    const meta   = (res as any)?.meta  ?? {};

    allShipments.push(...(Array.isArray(rows) ? rows : []));

    if (!meta.totalPages || page >= meta.totalPages) break;
    page++;
  }

  return allShipments;
}
```

For a one-liner when you only need a single page:

```ts
const firstPage = await client.v1.getShipments({ page: 1, limit: 20 });
```

For endpoints not covered by the `v1.*` convenience helpers, use the low-level
`request()` method:

```ts
// Filter by date range and participant address
const filtered = await client.request(
  '/api/v1/shipments',
  'get',
  {
    query: {
      status:    'ACTIVE',
      page:      1,
      limit:     20,
      startDate: '2026-01-01',
    },
  },
);
```

---

### 3. Submit milestone proof

Proof upload requires multipart form data, which the SDK's `request()` helper does not
yet generate — use native `fetch` with the JWT from the client options instead:

```ts
async function submitProof(
  client:         ChainSettleClient,
  shipmentId:     string,
  milestoneIndex: number,
  file:           File | Blob,
  fileName:       string,
) {
  // Extract the base URL from the client (store it in a variable when constructing)
  const baseUrl    = 'http://localhost:3000';
  const accessToken = process.env.JWT!;

  const form = new FormData();
  form.append('file', file, fileName);

  const res = await fetch(
    `${baseUrl}/api/v1/shipments/${shipmentId}/milestones/${milestoneIndex}/proof`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body:    form,
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Proof upload failed (${res.status}): ${body}`);
  }

  return res.json();
}
```

---

### 4. Error handling

`client.request()` throws a plain `Error` on any non-2xx response. The message format is:

```
API POST /api/v1/auth/login failed (401): {"statusCode":401,"message":"Invalid signature"}
```

Parse the status code and body from the message, or wrap calls in try/catch:

```ts
try {
  const shipment = await client.v1.getShipment('SHIP-DOES-NOT-EXIST');
} catch (err) {
  if (err instanceof Error) {
    // err.message contains the full HTTP status and response body
    const is404 = err.message.includes('(404)');
    if (is404) {
      console.log('Shipment not found');
    } else {
      throw err; // re-throw unexpected errors
    }
  }
}
```

Common status codes:

| Status | Meaning |
|---|---|
| 400 | Validation error — check the `message` array in the body |
| 401 | Missing or expired JWT / API key |
| 403 | Insufficient role (e.g. non-admin calling an admin endpoint) |
| 404 | Resource not found |
| 409 | Conflict — duplicate resource or illegal state transition |
| 429 | Rate limit exceeded — back off and retry |
| 503 | Dependency unavailable (IPFS, Stellar RPC) |

---

## Regenerating the SDK

Run this command from the **backend repo root** whenever you add, rename, or change the
shape of a controller endpoint, DTO, or response class:

```bash
npm run generate:sdk
```

This does three things in sequence:

1. **Boots NestJS with `SDK_GENERATE=1`** — the app starts just far enough to build the
   Swagger document. All external connections (PostgreSQL, Redis, Stellar RPC, IPFS) are
   skipped. No real infrastructure is needed.
2. **Writes `sdk/openapi.json`** — the full OpenAPI 3.0 document reflecting the current
   controllers and DTOs.
3. **Runs `openapi-typescript`** — converts `sdk/openapi.json` to TypeScript interfaces
   in `sdk/schema.ts`.

`sdk/client.ts` and `sdk/index.ts` are **static** — they are not touched by generation.
Only `sdk/openapi.json` and `sdk/schema.ts` change.

After regenerating, commit both files:

```bash
git add sdk/openapi.json sdk/schema.ts
git commit -m "chore(sdk): regenerate after <describe change>"
```

### When to regenerate

| Change made | Regenerate? |
|---|---|
| Add a new controller route | ✅ Yes |
| Rename or add a field to a DTO | ✅ Yes |
| Change a response shape | ✅ Yes |
| Update business logic only | No |
| Edit `sdk/client.ts` manually | No |
| Add/remove a Prisma model field that affects a DTO | ✅ Yes |

### Improving type coverage

The generated `schema.ts` currently types most response bodies as `unknown` because the
OpenAPI spec uses the generic `Envelope` wrapper. To get richer types for a specific
response:

1. Add a dedicated `@ApiResponse({ type: MyResponseDto })` decorator to the controller
   method.
2. Ensure `MyResponseDto` has `@ApiProperty()` on every field (or rely on the
   `@nestjs/swagger` compiler plugin in `nest-cli.json` which infers them from
   `class-validator` decorators).
3. Run `npm run generate:sdk` — the new type will appear in `schema.ts` under
   `components.schemas` and be referenced from the relevant path entry.

---

## The sdk-drift CI check

The `.github/workflows/sdk-drift.yml` workflow runs on every push to `main`/`master` and
on every pull request:

```yaml
- name: Check SDK is in sync with OpenAPI schema
  run: npm run check:sdk
```

`npm run check:sdk` (implemented in `scripts/check-sdk.js`) does the following:

1. Runs `npm run generate:sdk` to regenerate `sdk/openapi.json` and `sdk/schema.ts`.
2. Runs `git diff --exit-code -- sdk/` — fails with exit code 1 if any tracked file under
   `sdk/` has changed.
3. Runs `git ls-files --others --exclude-standard -- sdk/` — fails if any untracked files
   exist under `sdk/` that should have been committed.

If the check passes, it prints:

```
✓ SDK is in sync with the OpenAPI schema
```

### Fixing a failing sdk-drift run

**Symptom:** the `SDK drift check` CI job fails with:

```
SDK output is stale relative to the OpenAPI schema.
Run `npm run generate:sdk` and commit the updated sdk/ files.
```

or:

```
Untracked files under sdk/ — commit them after generate:sdk:
sdk/schema.ts
```

**Step-by-step fix:**

1. Pull the branch locally:
   ```bash
   git fetch origin
   git checkout your-branch
   ```

2. Regenerate the SDK:
   ```bash
   npm run generate:sdk
   ```

3. Review what changed (`git diff sdk/`). For a new endpoint the diff will add path
   entries to `schema.ts`; for a renamed DTO field it will update the corresponding
   interface property.

4. Stage and commit both generated files:
   ```bash
   git add sdk/openapi.json sdk/schema.ts
   git commit -m "chore(sdk): regenerate after <your change>"
   git push
   ```

5. The CI check will re-run and pass.

**If `npm run generate:sdk` itself fails:**

The script boots NestJS with stub env values, so it does not need a real database or Redis.
Common causes of generation failure:

- **TypeScript compile error** — fix the compile error in the relevant controller or DTO
  first, then retry.
- **Missing `openapi-typescript` binary** — run `npm install` to restore `node_modules`.
- **Circular import added by a recent change** — check for circular dependencies with
  `npx madge --circular src/`.

---

## How generation works

```
npm run generate:sdk
        │
        └─ scripts/generate-sdk.js
               │
               ├─ 1. Sets SDK_GENERATE=1 + stub env values
               │
               ├─ 2. npx ts-node src/main.ts
               │          │
               │          └─ NestJS boots, builds Swagger document,
               │             writes sdk/openapi.json, exits 0
               │
               └─ 3. npx openapi-typescript sdk/openapi.json -o sdk/schema.ts
                          │
                          └─ Emits TypeScript interfaces to sdk/schema.ts
```

Services that check `SDK_GENERATE=1` and skip their `onModuleInit` side-effects:

| Service | What it skips |
|---|---|
| `EventsService` | Stellar event poller, Redis leader election |
| `PrismaService` | Database connection |
| `RedisService` | Redis connection |
| `IpfsService` | Pinata connectivity check |

This means generation works on a developer laptop with no infrastructure running — the
only thing required is the npm dependencies (`npm install`).
