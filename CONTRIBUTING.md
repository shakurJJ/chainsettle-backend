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

**Update the changelog.** If your change affects the public API (new/changed/removed
endpoints, response shapes, or behavior visible to consumers), add an entry under the
`[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) in the relevant
`Added` / `Changed` / `Fixed` / `Removed` category. This is required in every PR — include
it in the PR checklist below so consumers can track what changed between deployments.

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
- Add an entry to [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]` for any API-facing
  change (see [updating the changelog](#before-opening-a-pr)).
- Link the issue you're closing with `Closes #<issue-number>`.
- For bug reports or feature proposals, use the templates in
  [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/).

---

## Dependabot PRs

Dependabot is configured in [`.github/dependabot.yml`](.github/dependabot.yml) to open
dependency-update PRs weekly (Mondays, 09:00 UTC) for both the `npm` and
`github-actions` ecosystems.

### How updates are batched

| Update type | Arrives as | Review SLA |
|---|---|---|
| **Security fix** (any severity) | Individual PR, ungrouped | Merge within **24 h** of opening; no grouping so it never waits for the weekly batch |
| Minor / patch — production deps | One grouped PR (`npm-minor-patch`) | Review and merge within **7 days** |
| Minor / patch — dev deps | One grouped PR (`npm-dev-minor-patch`) | Review and merge within **7 days** |
| Minor / patch — GitHub Actions | One grouped PR (`actions-minor-patch`) | Review and merge within **7 days** |
| **Major version bump** | Individual PR, ungrouped | Manual review required; no auto-merge |

Security PRs are **never** placed inside a group, so a critical CVE fix
always lands as its own PR and can be fast-tracked without touching anything else.

### Review checklist for Dependabot PRs

1. **Check the changelog / release notes** linked in the PR description.
2. **Run the test suite** — Dependabot PRs trigger CI automatically; do not
   merge a red PR.
3. For **major bumps**: read the migration guide, update any affected code,
   and open a follow-up PR if the Dependabot PR only bumps the version without
   handling breaking changes.
4. For **Prisma major bumps**: run `npx prisma generate` and check for schema
   warnings before merging.
5. For **`@stellar/stellar-sdk` any bump**: verify that the RPC response shapes
   consumed by `StellarService` haven't changed — the SDK does not follow strict
   semver for XDR / RPC schema changes.
6. After merging, confirm the deployment pipeline passes end-to-end.

### Auto-merge policy

Auto-merge is **not** enabled by default.  A human must approve every Dependabot PR.
If the team decides to enable auto-merge for patch-level updates in future, restrict
it to dev-dependency patches only, and require that all CI checks pass first.

---

## Getting Help

For architecture, module responsibilities, and the full API reference, see
[README.md](README.md).
