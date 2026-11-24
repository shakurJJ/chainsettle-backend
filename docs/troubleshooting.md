# Troubleshooting

Common local-setup and runtime errors, with the exact message you'll see, why it happens, and how to fix it.

Jump to:

1. [Joi env-validation failure at startup](#1-joi-env-validation-failure-at-startup)
2. [Prisma client not generated / missing module](#2-prisma-client-not-generated--missing-module)
3. [Prisma migration fails — database not reachable](#3-prisma-migration-fails--database-not-reachable)
4. [Redis connection refused](#4-redis-connection-refused)
5. [Stellar RPC / Horizon unreachable](#5-stellar-rpc--horizon-unreachable)
6. [IPFS node unreachable / proof upload returns 503](#6-ipfs-node-unreachable--proof-upload-returns-503)
7. [Port 3000 already in use](#7-port-3000-already-in-use)
8. [DATABASE_URL format rejected by Joi](#8-database_url-format-rejected-by-joi)

---

## 1. Joi env-validation failure at startup

### Error

```
[ExceptionHandler] Config validation error:
  "JWT_SECRET" is required
  "DATABASE_URL" is required
  "REDIS_URL" is required
  "STELLAR_RPC_URL" is required
  ...
```

NestJS exits immediately and prints every failing field (the schema uses `abortEarly: false`).

### Cause

The app validates every environment variable against the Joi schema in `src/config/env.validation.ts` before any module initialises. Any required key that is missing or has the wrong format causes this.

The full set of **required** keys (no default) is:

| Key | Example |
|-----|---------|
| `JWT_SECRET` | any long random string |
| `DATABASE_URL` | `postgresql://user:pass@localhost:5432/chainsettle` |
| `REDIS_URL` | `redis://localhost:6379` |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` |
| `CHAINSETTTLE_CONTRACT_ID` | deployed contract ID |
| `USDC_TOKEN_ADDRESS` | USDC asset contract address |
| `STELLAR_SECRET_KEY` | `S...` Stellar secret key |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password / app password |
| `EMAIL_FROM` | `no-reply@yourapp.com` |

### Fix

```bash
cp .env.example .env
# then fill in every [required] placeholder in .env
```

For local development and unit tests you do **not** need a live Stellar node, Redis, or
SMTP server — see the unit-test note in [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 2. Prisma client not generated / missing module

### Error

```
Error: Cannot find module '@prisma/client'
```

or, when the schema changed since the last generate:

```
PrismaClientInitializationError: Prisma Client could not be generated because the
schema has changed since the last `prisma generate` run.
```

or TypeScript errors such as:

```
Property 'organizationName' does not exist on type 'User'
```

### Cause

The Prisma client is generated from `prisma/schema.prisma` into `node_modules/@prisma/client`. It is **not** committed to the repo. After a fresh clone, after pulling a migration that adds new fields, or after running `npm install` in a clean state, the client must be regenerated.

### Fix

```bash
npx prisma generate
```

Run this again whenever you pull a branch that contains a schema change. The `postinstall` hook does **not** run generate automatically in this project.

---

## 3. Prisma migration fails — database not reachable

### Error

```
Error: P1001: Can't reach database server at `localhost:5432`
```

or:

```
Error: P3000: Failed to create database: could not connect to server:
  Connection refused
    Is the server running on host "localhost" (127.0.0.1) and accepting
    TCP/IP connections on port 5432?
```

### Cause

`npx prisma migrate dev` (and `prisma db push`, `prisma studio`) require a live PostgreSQL
connection. The server is not running or `DATABASE_URL` points at the wrong host/port.

### Fix

1. Start PostgreSQL:
   - **macOS (Homebrew):** `brew services start postgresql@15`
   - **Docker:** `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=password postgres:15`
   - **Linux:** `sudo systemctl start postgresql`

2. Verify `DATABASE_URL` in `.env` matches the running instance:

   ```
   DATABASE_URL=postgresql://postgres:password@localhost:5432/chainsettle
   ```

3. Create the database if it doesn't exist yet:

   ```bash
   createdb chainsettle
   # or inside psql:
   # CREATE DATABASE chainsettle;
   ```

4. Re-run the migration:

   ```bash
   npx prisma migrate dev
   npx prisma generate
   ```

---

## 4. Redis connection refused

### Error

In the terminal where `npm run start:dev` is running:

```
[RedisService] Redis connection error: Error: connect ECONNREFUSED 127.0.0.1:6379
```

The app continues to start but all endpoints that touch rate-limiting, session tracking, the
idempotency cache, or shipment-list caching will fail at runtime.

### Cause

ioredis can't reach the Redis server. Either Redis is not running locally, or `REDIS_URL`
points at the wrong address. The default value assumed by the app is `redis://localhost:6379`.

### Fix

1. Start Redis:
   - **macOS (Homebrew):** `brew services start redis`
   - **Docker:** `docker run -d -p 6379:6379 redis:7`
   - **Linux:** `sudo systemctl start redis`

2. Verify your `REDIS_URL` in `.env`:

   ```
   REDIS_URL=redis://localhost:6379
   ```

3. Test the connection manually:

   ```bash
   redis-cli ping   # should print PONG
   ```

4. Restart the dev server. You should see `[RedisService] Redis connected` and then
   `[RedisService] Redis ready` in the log.

---

## 5. Stellar RPC / Horizon unreachable

### Error

Logged during the admin health check (`GET /admin/health/dependencies`) or during event polling:

```
[StellarService] stellar-rpc health check failed: Error: connect ECONNREFUSED
```

or:

```
{ "name": "stellar-rpc", "status": "down", "message": "connect ETIMEDOUT" }
```

The shipment-sync endpoints (`POST /shipments/:id/sync`) and the event-polling job will
also fail with 5xx responses until connectivity is restored.

### Cause

`STELLAR_RPC_URL` or `STELLAR_HORIZON_URL` is unreachable — either the endpoints in `.env`
are wrong, the testnet is temporarily down, or outbound traffic is blocked.

### Fix

1. Check that the URLs in `.env` are correct for your target network:

   | Network | RPC URL | Horizon URL |
   |---------|---------|-------------|
   | testnet | `https://soroban-testnet.stellar.org` | `https://horizon-testnet.stellar.org` |
   | mainnet | Your provider's Soroban RPC endpoint | `https://horizon.stellar.org` |

2. Confirm connectivity from your machine:

   ```bash
   curl https://soroban-testnet.stellar.org/health
   # should return {"status":"healthy"}
   ```

3. If the public testnet is down, check the [Stellar status page](https://status.stellar.org)
   or run a local Stellar quickstart node:

   ```bash
   docker run --rm -p 8000:8000 stellar/quickstart:soroban --testnet
   # then set STELLAR_RPC_URL=http://localhost:8000/soroban/rpc
   #         STELLAR_HORIZON_URL=http://localhost:8000
   ```

---

## 6. IPFS node unreachable / proof upload returns 503

### Error

In the server log:

```
[IpfsService] IPFS node unreachable: Request failed with status code 401
[IpfsService] IPFS node unreachable: connect ECONNREFUSED
```

When a supplier tries to upload proof:

```json
{ "statusCode": 503, "message": "IPFS service is currently unavailable" }
```

### Cause

`IpfsService` runs a connectivity check against Pinata on startup and every
`IPFS_HEALTH_CHECK_INTERVAL_MS` milliseconds (default 60 s). If the check fails, the
`isHealthy` flag is set to `false` and all subsequent upload attempts throw
`ServiceUnavailableException`.

Common reasons:

- `IPFS_API_KEY` is wrong or expired → Pinata returns 401.
- No `IPFS_API_KEY` set at all (local dev) → the service marks itself healthy and returns a
  stub CID (`bafydev…`). This is intentional — you will see a `WARN` log:

  ```
  [IpfsService] IPFS_API_KEY not configured — returning stub CID for development
  ```

  Stub CIDs are fine for local development but are not real IPFS pins.

### Fix

**For local development** — leave `IPFS_API_KEY` empty (or omit it). The stub CID flow
activates automatically. No Pinata account is needed.

**For staging/production:**

1. Create a Pinata account at [pinata.cloud](https://pinata.cloud) and generate an API key
   with `pinFileToIPFS` permission.
2. Set the key in `.env`:
   ```
   IPFS_API_KEY=eyJ...your-pinata-jwt...
   IPFS_GATEWAY_URL=https://gateway.pinata.cloud/ipfs
   ```
3. Restart the server. You should see `[IpfsService] IPFS node reachable` in the logs.
4. If it still fails, test the key directly:
   ```bash
   curl -H "Authorization: Bearer $IPFS_API_KEY" \
     https://api.pinata.cloud/data/testAuthentication
   # should return {"message":"Congratulations! You are communicating with the Pinata API!"}
   ```

---

## 7. Port 3000 already in use

### Error

```
Error: listen EADDRINUSE: address already in use :::3000
```

### Cause

Another process (a previous dev-server instance, another NestJS project, or a different
app) is already bound to port 3000.

### Fix

**Option A — kill the conflicting process:**

```bash
# find the PID
npx kill-port 3000
# or manually:
lsof -ti tcp:3000 | xargs kill   # macOS / Linux
```

**Option B — run on a different port:**

```bash
PORT=3001 npm run start:dev
```

or set `PORT=3001` in your `.env`. The Swagger UI and API base URL will move to
`http://localhost:3001`.

---

## 8. DATABASE_URL format rejected by Joi

### Error

```
Config validation error: "DATABASE_URL" with value "..." fails to match the required pattern
  DATABASE_URL must start with postgresql:// or postgres://
```

### Cause

The Joi schema enforces that `DATABASE_URL` matches `/^postgres(ql)?:\/\//`. A common
mistake is pasting a URL that uses the `pg://` shorthand, a `mysql://` URL, or wrapping
the value in quotes inside `.env`.

### Fix

Use the full scheme and remove any surrounding quotes:

```dotenv
# correct
DATABASE_URL=postgresql://postgres:password@localhost:5432/chainsettle

# wrong — pg:// shorthand
DATABASE_URL=pg://postgres:password@localhost:5432/chainsettle

# wrong — quoted value
DATABASE_URL="postgresql://postgres:password@localhost:5432/chainsettle"
```

If you copied the URL from a cloud provider (Supabase, Neon, Railway) it will usually
already be in the correct `postgresql://` form.

---

## Still stuck?

- Check `GET /health` and `GET /admin/health/dependencies` (admin token required) for a
  live status summary of all external dependencies.
- Run `npm run test` — unit tests mock all external services so they confirm your TypeScript
  and logic are correct independently of your local infrastructure.
- Search [open issues](../../issues) or open a new one with the full error log attached.
