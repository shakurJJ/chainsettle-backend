#!/usr/bin/env node
/**
 * CI gate: fail the build when prisma/schema.prisma changes without a
 * matching migration under prisma/migrations/, so that a contributor cannot
 * land a schema edit that only `prisma migrate deploy` will later discover
 * (and manifest as missing columns at deploy time).
 *
 * It mirrors the pattern already used for the SDK drift check
 * (scripts/check-sdk.js, .github/workflows/sdk-drift.yml), but is explicit
 * and self-contained so it cannot drift from the convention in
 * docs/testing.md / docs/deployment.md, where `prisma migrate deploy` is
 * described as "CI / staging / production: applies already-committed
 * migrations only – never creates new ones".
 *
 * Exit codes:
 *   0 – schema is in sync with prisma/migrations/ (schema change with a
 *       matching migration passes CI).
 *   1 – schema changed without a migration (schema change without a matching
 *       migration fails CI).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const schemaPath = path.join(root, 'prisma', 'schema.prisma');
const migrationsDir = path.join(root, 'prisma', 'migrations');

if (!fs.existsSync(schemaPath)) {
  console.error('schema.prisma not found at', schemaPath);
  process.exit(1);
}

if (!fs.existsSync(migrationsDir)) {
  console.error('prisma/migrations directory not found at', migrationsDir);
  process.exit(1);
}

/**
 * Run a git command and return trimmed stdout (exits on git failure).
 */
function git(args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    console.error(`git ${args.join(' ')} failed. Make sure git is available.`);
    if (res.stderr) console.error(res.stderr);
    process.exit(1);
  }
  return res.stdout.trim();
}

/**
 * Compare the working tree (staged + unstaged + untracked) against BASE_REF
 * (default HEAD). In CI set BASE_REF to the PR base, e.g. origin/main.
 */
const baseRef = process.env.BASE_REF || 'HEAD';
const diffBase = baseRef === 'HEAD' ? 'HEAD' : git(['merge-base', baseRef, 'HEAD']);

const schemaChanged =
  git(['diff', '--name-only', diffBase, '--', 'prisma/schema.prisma']).length > 0;

const migrationAtBase = new Set(
  git(['ls-tree', '-r', '--name-only', diffBase, '--', 'prisma/migrations'])
    .split('\n')
    .filter((f) => f.endsWith('/migration.sql')),
);

const newMigrations = fs
  .readdirSync(migrationsDir)
  .filter((entry) => fs.existsSync(path.join(migrationsDir, entry, 'migration.sql')))
  .map((entry) => `prisma/migrations/${entry}/migration.sql`)
  .filter((file) => !migrationAtBase.has(file));

if (!schemaChanged || newMigrations.length > 0) {
  console.log('✓ prisma/schema.prisma is in sync with prisma/migrations/');
  if (schemaChanged) console.log('  new migration(s): ' + newMigrations.join(', '));
  process.exit(0);
}

console.error('✗ prisma/schema.prisma changed without a matching migration.');
console.error('');
console.error('  Schema content is newer than the last committed migration set.');
console.error('');
console.error('  The on-chain and off-chain data layers are out of sync:');
console.error('  - prisma/migrate deploy (CI / staging / production) will apply');
console.error('    only already-committed migrations and will not create columns');
console.error('    added by the schema change.');
console.error('  - Running prisma migrate dev locally would create the new column,');
console.error('    but that is a developer-only operation and must not race');
console.error('    with a CI deploy.');
console.error('');
console.error('  To resolve this issue:');
console.error('  1. Run `npx prisma migrate dev --name <desc>` locally against a live');
console.error('     PostgreSQL to create the migration from the schema change.');
console.error('  2. Commit both the schema change and the new folder under');
console.error('     prisma/migrations/ (the migration.sql file).');
console.error('  3. Commit the generated Prisma client: `npx prisma generate`.');
console.error('  4. Assign the new migration to the branch that changes schema.prisma.');
console.error('');
console.error('  Related docs: docs/testing.md, docs/deployment.md,');
console.error('  docs/adr/0004-prisma-postgresql.md');
console.error('');
console.error('  Compared against: ' + baseRef);
console.error('');

process.exit(1);
