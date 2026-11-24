#!/usr/bin/env node
/**
 * CI / pre-commit gate: fail when prisma/schema.prisma changes without a
 * matching migration under prisma/migrations/.
 *
 * The check compares the files being committed against the commit they are
 * based on:
 *   - nothing staged (or a CI checkout with no pending changes)  → pass
 *   - schema.prisma unchanged                                   → pass
 *   - schema.prisma changed AND a migration.sql added/changed   → pass
 *   - schema.prisma changed AND no new migration.sql            → fail
 *
 * Exit codes:
 *   0 – schema is in sync with prisma/migrations/
 *   1 – schema changed without a matching migration (or git state unreadable)
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SCHEMA = 'prisma/schema.prisma';
const MIGRATIONS_DIR = 'prisma/migrations';

function git(args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`Failed to read git state: git ${args.join(' ')}`);
    console.error((res.stderr || '').trim());
    process.exit(1);
  }
  return res.stdout;
}

function splitLines(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Files in the commit under construction, or in HEAD when nothing is staged. */
function changedFiles() {
  const staged = splitLines(git(['diff', '--name-only', '--cached', 'HEAD']));
  if (staged.length > 0) {
    return staged;
  }

  // Nothing staged: CI typically checks out an already-created commit, so
  // compare HEAD against its parent instead.
  const parent = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (parent.status === 0) {
    return splitLines(git(['diff', '--name-only', 'HEAD^', 'HEAD']));
  }

  // Initial commit: every tracked file is new.
  return splitLines(git(['ls-tree', '-r', '--name-only', 'HEAD']));
}

if (!fs.existsSync(path.join(root, SCHEMA))) {
  console.error(`✗ ${SCHEMA} not found`);
  process.exit(1);
}

if (!fs.existsSync(path.join(root, MIGRATIONS_DIR))) {
  console.error(`✗ ${MIGRATIONS_DIR} directory not found`);
  process.exit(1);
}

const files = changedFiles();
const schemaChanged = files.includes(SCHEMA);

const migrationsAdded = files.filter(
  (file) =>
    file.startsWith(`${MIGRATIONS_DIR}/`) &&
    file.endsWith('/migration.sql') &&
    file.split('/').length === 4,
);

if (!schemaChanged) {
  console.log('✓ prisma/schema.prisma unchanged — no migration required');
  process.exit(0);
}

if (migrationsAdded.length === 0) {
  console.error('✗ prisma/schema.prisma changed without a matching migration.');
  console.error('');
  console.error('  `prisma migrate deploy` (CI / staging / production) only applies');
  console.error('  already-committed migrations, so a schema edit on its own would');
  console.error('  leave those environments missing the new columns or tables.');
  console.error('');
  console.error('  To resolve this:');
  console.error('  1. Run `npx prisma migrate dev --name <desc>` against a live PostgreSQL.');
  console.error('  2. Commit the new prisma/migrations/<timestamp>_<desc>/migration.sql');
  console.error('     together with the schema change.');
  console.error('');
  console.error('  Related docs: docs/testing.md, docs/deployment.md,');
  console.error('  docs/adr/0004-prisma-postgresql.md');
  process.exit(1);
}

console.log('✓ prisma/schema.prisma change is accompanied by migration(s):');
for (const migration of migrationsAdded) {
  console.log(`  - ${migration}`);
}
process.exit(0);
