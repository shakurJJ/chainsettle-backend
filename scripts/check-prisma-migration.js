#!/usr/bin/env node
/**
 * Gate: fail when prisma/schema.prisma changes without a matching migration
 * under prisma/migrations/, so a schema edit never lands that only
 * `prisma migrate deploy` would later discover as missing columns.
 *
 * Diff source:
 *   - Pre-commit (default): the staged changes (`git diff --cached`).
 *   - CI: set PRISMA_CHECK_BASE to a ref (e.g. origin/main); the check then
 *     diffs `<base>...HEAD`.
 *
 * Rule: if schema.prisma is in the diff, the same diff must add at least one
 * new `prisma/migrations/<name>/migration.sql`.
 *
 * Exit codes:
 *   0 – no schema change, or schema change with a new migration.
 *   1 – schema changed without a new migration (or git failed).
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SCHEMA = 'prisma/schema.prisma';
const MIGRATION_RE = /^prisma\/migrations\/[^/]+\/migration\.sql$/;

function git(args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`git ${args.join(' ')} failed:\n${res.stderr}`);
    process.exit(1);
  }
  return res.stdout;
}

const base = process.env.PRISMA_CHECK_BASE;
const diffArgs = base
  ? ['diff', '--name-status', `${base}...HEAD`]
  : ['diff', '--cached', '--name-status'];

const changes = git(diffArgs)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, ...paths] = line.split('\t');
    return { status: status[0], file: paths[paths.length - 1] };
  });

const schemaChanged = changes.some((c) => c.file === SCHEMA);
if (!schemaChanged) {
  console.log('✓ prisma/schema.prisma unchanged — migration check skipped');
  process.exit(0);
}

const newMigrations = changes
  .filter((c) => c.status === 'A' && MIGRATION_RE.test(c.file))
  .map((c) => c.file);

if (newMigrations.length > 0) {
  console.log('✓ prisma/schema.prisma change has matching migration(s):');
  newMigrations.forEach((m) => console.log(`  ${m}`));
  process.exit(0);
}

console.error('✗ prisma/schema.prisma changed without a matching migration.');
console.error('');
console.error('  prisma migrate deploy (CI / staging / production) applies only');
console.error('  committed migrations, so the schema change would never reach the DB.');
console.error('');
console.error('  To resolve:');
console.error('  1. Run `npx prisma migrate dev --name <desc>` against a live PostgreSQL');
console.error('     (or hand-write prisma/migrations/<timestamp>_<desc>/migration.sql).');
console.error('  2. Stage/commit the new migration folder together with schema.prisma.');
console.error('');
console.error('  Related docs: docs/testing.md, docs/deployment.md,');
console.error('  docs/adr/0004-prisma-postgresql.md');
process.exit(1);
