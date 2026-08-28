#!/usr/bin/env node
/**
 * CI drift detection: regenerate the SDK and fail if sdk/ differs from git.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');

console.log('→ Regenerating SDK…');
const gen = spawnSync('node', ['scripts/generate-sdk.js'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

if (gen.status !== 0) {
  process.exit(gen.status || 1);
}

console.log('→ Checking for drift in sdk/…');
const diff = spawnSync('git', ['diff', '--exit-code', '--', 'sdk/'], {
  cwd: root,
  encoding: 'utf8',
});

if (diff.status !== 0) {
  console.error('SDK output is stale relative to the OpenAPI schema.');
  console.error('Run `npm run generate:sdk` and commit the updated sdk/ files.');
  if (diff.stdout) console.error(diff.stdout);
  if (diff.stderr) console.error(diff.stderr);
  process.exit(1);
}

// Also fail on untracked sdk files that should be committed
const untracked = spawnSync(
  'git',
  ['ls-files', '--others', '--exclude-standard', '--', 'sdk/'],
  { cwd: root, encoding: 'utf8' },
);

if (untracked.stdout && untracked.stdout.trim().length > 0) {
  console.error('Untracked files under sdk/ — commit them after generate:sdk:');
  console.error(untracked.stdout);
  process.exit(1);
}

console.log('✓ SDK is in sync with the OpenAPI schema');
