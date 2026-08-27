# Contributing to ChainSettle Backend

Thanks for contributing! This guide covers the contributor workflow — setup, branching,
commits, tests, and PR expectations. For architecture, module overview, and API details,
see [README.md](README.md).

---

## Quick Start

**Prerequisites:** Node.js v20+, npm (or pnpm), PostgreSQL 15+, Redis.

```bash
# 1. Clone and install
git clone <your-fork-url>
cd chainsetttle-backend
npm install

# 2. Copy env vars
cp .env.example .env
```

To run the **unit test suite**, the values in `.env.example` are enough as-is —
unit tests (`*.spec.ts`) mock `PrismaService` and `StellarService`, so no live
database, Redis, or Stellar connection is required. You only need the Prisma
client generated (from `prisma/schema.prisma`, no DB connection needed for this step):

```bash
npx prisma generate
npm run test
```

That's the fastest path from clone to a test run.

> **Known issue:** as of this writing, `npm run test` fails to compile on a clean
> `main` checkout — `shipments.service.ts` calls `auditLog.record()` without the
> `resourceId` field required by `RecordAuditLogDto`
> (`src/modules/audit-logs/audit-log.service.ts`), which breaks every spec file
> that imports `ShipmentsService`. This is unrelated to your setup; if you hit it,
> it's a pre-existing bug, not something you did wrong. Please check open issues
> or file one before spending time debugging your environment.

To actually **run the dev server** (or the e2e suite) against a real database, fill in
the `[required]` vars in `.env` (`DATABASE_URL`, `JWT_SECRET`, `REDIS_URL`,
`STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, `CHAINSETTTLE_CONTRACT_ID`,
`USDC_TOKEN_ADDRESS`, `STELLAR_SECRET_KEY`, `SMTP_*`), then:

```bash
npx prisma migrate dev --name init
npx prisma generate
npm run start:dev
```

- API: `http://localhost:3000/api/v1`
- Swagger docs: `http://localhost:3000/docs`

See [README.md](README.md#setup) for full setup details and environment variable descriptions.

---

## Branching

Use the pattern:

```
<type>/<issue-number>-<short-description>
```

Examples: `feat/165-remove-pending-milestone`, `fix/201-shipment-status-bug`,
`docs/214-contributing-guide`.

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

---

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description
```

Examples:
- `feat(admin): add POST /admin/tokens for registering new payment tokens`
- `fix(shipments): correct milestone percent validation`
- `docs: add CONTRIBUTING guide`

Use imperative mood ("add", not "added"), and reference the issue number in the
commit body or PR description when relevant.

---

## Before Opening a PR

Run these locally and make sure they pass:

```bash
npm run lint       # ESLint, auto-fixes what it can
npm run test       # Unit tests
npm run test:cov   # Unit tests with coverage
npm run format     # Prettier
```

If your change touches an endpoint used by the frontend or event polling, also run:

```bash
npm run test:e2e
```

---

## Adding or Changing Endpoints

New or modified endpoints are expected to follow the existing Swagger + validation
pattern (see `src/modules/shipments/shipments.controller.ts` and
`src/modules/shipments/dto/create-shipment.dto.ts` for a full example):

- **DTOs**: every input field must have a `class-validator` decorator
  (`@IsString`, `@IsInt`, `@IsOptional`, `@IsISO8601`, etc.), plus a custom
  validator where one already exists for the domain (e.g. `@IsStellarAddress`).
- **Swagger on DTOs**: every DTO field must have `@ApiProperty()` (or
  `@ApiPropertyOptional()`) with an `example` and, where the field isn't
  self-explanatory, a `description`.
- **Swagger on controllers**: every route needs `@ApiOperation()` and at least
  one `@ApiResponse()`; the controller class needs `@ApiTags()`; protected
  routes need `@ApiBearerAuth()`.
- Responses are wrapped by the global `TransformInterceptor` and errors by
  `HttpExceptionFilter` — don't hand-roll response envelopes (see
  [README.md](README.md#response-format)).

---

## Opening a Pull Request

- PRs use [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md),
  which is applied automatically when you open a PR on GitHub. Fill it out fully,
  including the "Type of Change," testing, and migration sections.
- Link the issue you're closing with `Closes #<issue-number>`.
- For bug reports or feature proposals, use the templates in
  [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/).

---

## Getting Help

For architecture, module responsibilities, and the full API reference, see
[README.md](README.md).
