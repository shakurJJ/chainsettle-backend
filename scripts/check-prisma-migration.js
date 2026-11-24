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
 * Read the schema file hash and the set of committed, dated migration
 * folders. We only consider migration directories that contain a
 * migration.sql file, which is the real marker of a committed Prisma
 * migration in this repository.
 */
const schemaStat = fs.statSync(schemaPath);
const schemaMtimeMs = schemaStat.mtimeMs;

const committedMigrationFolders = fs
  .readdirSync(migrationsDir)
  .filter((entry) => {
    const full = path.join(migrationsDir, entry);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'migration.sql'));
  })
  .sort();

const migrationIds = committedMigrationFolders.join('\n');
const migrationsHash = require('crypto')
  .createHash('sha256')
  .update(migrationIds, 'utf8')
  .digest('hex');

/** The current state of the working tree (schema + migrations found by git). */
function currentTreeState() {
  const schemaDiff = spawnSync(
    'git',
    ['hash-object', schemaPath],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );

  const migrationDiff = spawnSync(
    'git',
    ['ls-tree', '--name-only', 'HEAD', '--', 'prisma/migrations'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );

  if (schemaDiff.status !== 0 || migrationDiff.status !== 0) {
    console.error('Failed to read the committed Git state. Make sure git is available.');
    console.error(`schemaDiff.status=${schemaDiff.status}`);
    if (schemaDiff.stderr) console.error(schemaDiff.stderr);
    if (migrationDiff.stderr) console.error(migrationDiff.stderr);
    process.exit(1);
  }

  const schemaHash = schemaDiff.stdout.trim();
  const migrationFiles = migrationDiff.stdout
    .split('\n')
    .filter(Boolean)
    .sort();

  return { schemaHash, migrationFiles };
}

const { schemaHash, migrationFiles } = currentTreeState();
const migrationIdsForTree = migrationFiles
  .filter((file) => file.endsWith('/migration.sql'))
  .map((file) => path.basename(path.dirname(file)))
  .sort()
  .join('\n');

const treeMigrationHash = require('crypto')
  .createHash('sha256')
  .update(migrationIdsForTree, 'utf8')
  .digest('hex');

if (schemaHash === treeMigrationHash) {
  // Schema and committed migrations are in sync. If the hash were the same,
  // the committed migration list is also the same (we hash the sorted list
  // of migration files). We still copy the working-tree migration set into
  // the bundle so a future "schema-only" reference hash is stable, but no
  // new comparison pair is needed here.
  console.log('✓ prisma/schema.prisma is in sync with prisma/migrations/');
  console.log(`  schema: ${schemaHash}`);
  console.log(`  migrations: ${treeMigrationHash}`);

  // Write the current tree state into a stable artifact next to this script
  // so the check can be run repeatedly without re-running git.
  const stateDir = path.join(root, '.prisma-migration-state');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    // Best-effort; the artifact is not part of the repository.
  }
  fs.writeFileSync(
    path.join(stateDir, 'schema-hash.txt'),
    `${schemaHash}\n`,
    { encoding: 'utf8' }
  );
  fs.writeFileSync(
    path.join(stateDir, 'migrations-hash.txt'),
    `${treeMigrationHash}\n`,
    { encoding: 'utf8' }
  );
  fs.writeFileSync(
    path.join(stateDir, 'migration-files.txt'),
    migrationFiles.join('\n'),
    { encoding: 'utf8' }
  );

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
console.error('  Schema (new):  ', schemaHash.substring(0, 12));
console.error('  Migrations:    ', treeMigrationHash.substring(0, 12));
console.error('  Committed:     ' + migrationFiles.join('\n                '));
console.error('');

process.exit(1);
