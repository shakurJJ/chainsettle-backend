#!/usr/bin/env node
/**
 * Pre-commit gate: fail when `prisma/schema.prisma` changes without a matching
 * new migration under `prisma/migrations/`, so a schema edit cannot land
 * without the SQL that `prisma migrate deploy` needs in CI/staging/production.
 *
 * How it decides:
 *   1. If the working tree does not change prisma/schema.prisma relative to
 *      HEAD, there is nothing to check — exit 0. This keeps the script safe to
 *      run in CI, where the hook has nothing pending.
 *   2. If the schema did change, at least one migration folder containing a
 *      `migration.sql` must exist in the working tree that is not already in
 *      HEAD (i.e. a newly added migration).
 *
 * Exit codes:
 *   0 – schema unchanged, or schema changed with a new migration.
 *   1 – schema changed without a new migration (or git could not be read).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const schemaRelativePath = 'prisma/schema.prisma';
const schemaPath = path.join(root, schemaRelativePath);
const migrationsRelativePath = 'prisma/migrations';
const migrationsDir = path.join(root, migrationsRelativePath);

if (!fs.existsSync(schemaPath)) {
  console.error('schema.prisma not found at', schemaPath);
  process.exit(1);
}

if (!fs.existsSync(migrationsDir)) {
  console.error(`${migrationsRelativePath} directory not found at`, migrationsDir);
  process.exit(1);
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    console.error(`Failed to run: git ${args.join(' ')}`);
    if (result.stderr) console.error(result.stderr.trim());
    console.error('Make sure this is run from a Git checkout.');
    process.exit(1);
  }
  return result.stdout;
}

/** Migration folder names present on disk, newest state, that contain SQL. */
const workingTreeMigrations = fs
  .readdirSync(migrationsDir)
  .filter((entry) => {
    const full = path.join(migrationsDir, entry);
    return (
      fs.statSync(full).isDirectory() &&
      fs.existsSync(path.join(full, 'migration.sql'))
    );
  })
  .sort();

/** Migration folder names committed in HEAD. */
function headMigrationFolders() {
  const files = git([
    'ls-tree',
    '-r',
    '--name-only',
    'HEAD',
    '--',
    migrationsRelativePath,
  ])
    .split('\n')
    .filter(Boolean);

  return new Set(
    files
      .filter((file) => file.endsWith('/migration.sql'))
      .map((file) => path.basename(path.dirname(file))),
  );
}

const schemaChanged =
  git(['diff', '--name-only', 'HEAD', '--', schemaRelativePath]).trim() !== '';

if (!schemaChanged) {
  console.log('✓ prisma/schema.prisma is unchanged — no migration needed.');
  process.exit(0);
}

const alreadyCommitted = headMigrationFolders();
const newMigrations = workingTreeMigrations.filter(
  (folder) => !alreadyCommitted.has(folder),
);

if (newMigrations.length > 0) {
  console.log('✓ prisma/schema.prisma changed with matching migration(s):');
  for (const folder of newMigrations) {
    console.log(`  ${migrationsRelativePath}/${folder}`);
  }
  process.exit(0);
}

console.error('✗ prisma/schema.prisma changed without a matching migration.');
console.error('');
console.error('  prisma migrate deploy (CI / staging / production) applies only');
console.error('  already-committed migrations, so it would not create the columns');
console.error('  or indexes added by this schema change.');
console.error('');
console.error('  To resolve this:');
console.error('  1. Run `npx prisma migrate dev --name <desc>` against a live');
console.error('     PostgreSQL database to create the migration.');
console.error(`  2. Commit both prisma/schema.prisma and the new folder under`);
console.error(`     ${migrationsRelativePath}/ (including migration.sql).`);
console.error('  3. Assign the new migration to the branch that changes schema.prisma.');
console.error('');
console.error('  Related docs: docs/testing.md, docs/deployment.md,');
console.error('  docs/adr/0004-prisma-postgresql.md');
console.error('');

process.exit(1);
