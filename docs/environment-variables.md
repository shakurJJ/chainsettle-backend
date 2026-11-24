# Environment Variables Reference

This is the single reference for every environment variable read by ChainSettle.
All variables are validated at startup by the Joi schema in
`src/config/validation.ts`; the process refuses to boot if a required variable is
missing or malformed.

> **Secrets** are marked with 🔒. Never commit real values — inject them via your
> secrets manager (env, AWS Secrets Manager, or Vault) and keep `.env` out of
> version control.

## General / application

| Name | Required | Default | Description | Module |
|---|---|---|---|---|
| `NODE_ENV` | Yes | — | Runtime environment (`development`, `test`, `production`) | `src/config/validation.ts` |
| `PORT` | No | `3000` | HTTP listen port | `src/main.ts` |
| `API_PREFIX` | No | `api` | Route prefix (without version segment) | `src/main.ts` |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Single allowed frontend origin | `src/main.ts` |
| `ALLOWED_ORIGINS` | No | — | Comma-separated allowed origins (overrides `CORS_ORIGIN`) | `src/main.ts` |

## Database

| Name | Required | Default | Description | Module |
|---|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (primary) 🔒 | `src/config/configuration.ts` |
| `DATABASE_REPLICA_URL` | No | — | Read-replica URL; omit to route all reads to primary 🔒 | `src/config/configuration.ts` |
| `SHIPMENT_ARCHIVAL_DAYS` | No | `90` | Days before terminal shipments move to cold storage | `src/config/configuration.ts` |
| `SHIPMENT_ARCHIVAL_CRON` | No | `0 3 * * *` | Cron schedule for the archival job; invalid expressions fail at startup | `src/config/configuration.ts` |

## Redis

| Name | Required | Default | Description | Module |
|---|---|---|---|---|
| `REDIS_URL` | Yes | — | Redis connection string (rate limiting, cache, poller lock) 🔒 | `src/config/configuration.ts` |

## Authentication

| Name | Required | Default | Description | Module |
|---|---|---|---|---|
| `JWT_SECRET` | Yes | — | 32+ random characters; never reuse across environments 🔒 | `src/config/configuration.ts` |
| `JWT_EXPIRES_IN` | No | `7d` | Standard JWT expiry | `src/config/configuration.ts` |
| `IMPERSONATION_JWT_EXPIRES_IN` | No | `15m` | Admin impersonation token TTL | `src/config/configuration.ts` |

## Stellar

| Name | Required | Default | Description | Module |
|---|---|---|---|---|
| `STELLAR_NETWORK` | Yes | — | `testnet` or `mainnet` | `src/config/configuration.ts` |
| `STELLAR_RPC_URL` | Yes | — | Soroban RPC endpoint | `src/config/configuration.ts` |
| `CHAINSETTTLE_CONTRACT_ID` | Yes | — | Deployed contract address | `src/config/configuration.ts` |
| `USDC_TOKEN_ADDRESS` | Yes | — | USDC SAC address | `src/config/configuration.ts` |
| `EVENT_POLLING_INTERVAL_MS` | No | `5000` | Stellar event poll interval in ms | `src/config/configuration.ts` |

## Email

| Name | Required | Default | Description | Module |
|---|---|---|---|---|
| `SMTP_HOST` | No | — | SMTP host; omit to disable email delivery | `src/config/configuration.ts` |
| `SMTP_PORT` | No | `587` | SMTP port | `src/config/configuration.ts` |
| `SMTP_USER` | No | — | SMTP username 🔒 | `src/config/configuration.ts` |
| `SMTP_PASS` | No | — | SMTP password 🔒 | `src/config/configuration.ts` |
| `EMAIL_FROM` | No | `noreply@chainsetttle.com` | From address for outgoing email | `src/config/configuration.ts` |

## Rate limiting

| Name | Required | Default | Description | Module |
|---|---|---|---|---|
| `THROTTLE_TTL` | No | `60` | Rate-limit window in seconds | `src/config/configuration.ts` |
| `THROTTLE_LIMIT` | No | `100` | Max requests per window per key | `src/config/configuration.ts` |

## Jobs / backups

| Name | Required | Default | Description | Module |
|---|---|---|---|---|
| `BACKUP_S3_BUCKET` | No | — | S3 bucket for automated DB backups (omit to skip) | `src/config/configuration.ts` |
| `BACKUP_GPG_PASSPHRASE` | No | — | Symmetric passphrase for encrypted backup dumps 🔒 | `src/config/configuration.ts` |

## Secrets summary

The following variables are secrets and must be supplied through a secrets
provider rather than committed to `.env`:

- `DATABASE_URL`, `DATABASE_REPLICA_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `SMTP_USER`, `SMTP_PASS`
- `BACKUP_GPG_PASSPHRASE`

See [deployment.md](./deployment.md) for production setup and the
[README](../README.md) for local development.
