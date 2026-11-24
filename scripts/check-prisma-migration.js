#!/usr/bin/env node
/**
 * Gate: fail when prisma/schema.prisma changes without a matching migration
 * under prisma/migrations/, so that a contributor cannot land a schema edit
 * that only `prisma migrate deploy` will later discover (and manifest as
 * missing columns at deploy time).
 *
 * See docs/testing.md / docs/deployment.md, where `prisma migrate deploy` is
 * described as "CI / staging / production: applies already-committed
 * migrations only – never creates new ones".
 *
 * Which changes are inspected:
 *   - pre-commit (default): the staged changes (`git diff --cached`).
 *   - CI: set PRISMA_CHECK_BASE (e.g. `origin/main`) to inspect every change
 *     on the branch since it diverged from that ref (`git diff BASE...HEAD`).
 *
 * Exit codes:
 *   0 – schema unchanged, or changed together with a new/updated
 *       prisma/migrations/<name>/migration.sql.
 *   1 – schema changed without a migration (or git could not be read).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SCHEMA_FILE = 'prisma/schema.prisma';
const MIGRATION_SQL = /^prisma\/migrations\/[^/]+\/migration\.sql$/;

if (!fs.existsSync(path.join(root, SCHEMA_FILE))) {
  console.error('schema.prisma not found at', path.join(root, SCHEMA_FILE));
  process.exit(1);
}

function changedFiles() {
  const base = process.env.PRISMA_CHECK_BASE;
  const args = base
    ? ['diff', '--name-only', `${base}...HEAD`]
    : ['diff', '--cached', '--name-only'];
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`Failed to read changes with \`git ${args.join(' ')}\`.`);
    if (res.stderr) console.error(res.stderr);
    process.exit(1);
  }
  return res.stdout.split('\n').map((f) => f.trim()).filter(Boolean);
}

const files = changedFiles();
const schemaChanged = files.includes(SCHEMA_FILE);
const migrations = files.filter((f) => MIGRATION_SQL.test(f));

if (!schemaChanged) {
  console.log('✓ prisma/schema.prisma unchanged — no migration required');
  process.exit(0);
}

if (migrations.length > 0) {
  console.log('✓ prisma/schema.prisma changed together with a migration:');
  for (const m of migrations) console.log(`  ${m}`);
  process.exit(0);
}

console.error('✗ prisma/schema.prisma changed without a matching migration.');
console.error('');
console.error('  - prisma migrate deploy (CI / staging / production) applies only');
console.error('    already-committed migrations and will not create columns added');
console.error('    by the schema change.');
console.error('');
console.error('  To resolve this issue:');
console.error('  1. Run `npx prisma migrate dev --name <desc>` locally against a live');
console.error('     PostgreSQL to create the migration from the schema change.');
console.error('  2. Commit both the schema change and the new folder under');
console.error('     prisma/migrations/ (the migration.sql file).');
console.error('');
console.error('  Related docs: docs/testing.md, docs/deployment.md,');
console.error('  docs/adr/0004-prisma-postgresql.md');
console.error('');
process.exit(1);
