#!/usr/bin/env node
/**
 * Generates the TypeScript SDK from the NestJS OpenAPI document.
 *
 * 1. Boots the app with SDK_GENERATE=1 (skips DB/Redis side effects)
 * 2. Writes sdk/openapi.json
 * 3. Runs openapi-typescript → sdk/schema.ts
 *
 * Usage: npm run generate:sdk
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sdkDir = path.join(root, 'sdk');
const openapiPath = path.join(sdkDir, 'openapi.json');
const schemaPath = path.join(sdkDir, 'schema.ts');

fs.mkdirSync(sdkDir, { recursive: true });

const env = {
  ...process.env,
  SDK_GENERATE: '1',
  NODE_ENV: process.env.NODE_ENV || 'development',
  JWT_SECRET: process.env.JWT_SECRET || 'sdk-generate-secret-not-for-production',
  DATABASE_URL:
    process.env.DATABASE_URL ||
    'postgresql://sdk:sdk@127.0.0.1:5432/sdk_generate',
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  STELLAR_RPC_URL: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  STELLAR_HORIZON_URL:
    process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
  CHAINSETTTLE_CONTRACT_ID:
    process.env.CHAINSETTTLE_CONTRACT_ID || 'C'.padEnd(56, 'A'),
  USDC_TOKEN_ADDRESS: process.env.USDC_TOKEN_ADDRESS || 'C'.padEnd(56, 'B'),
  STELLAR_SECRET_KEY:
    process.env.STELLAR_SECRET_KEY ||
    'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  SMTP_HOST: process.env.SMTP_HOST || 'localhost',
  SMTP_USER: process.env.SMTP_USER || 'sdk',
  SMTP_PASS: process.env.SMTP_PASS || 'sdk',
  EMAIL_FROM: process.env.EMAIL_FROM || 'sdk@example.com',
  API_PREFIX: process.env.API_PREFIX || 'api',
};

console.log('→ Exporting OpenAPI schema via NestJS bootstrap…');
const exportResult = spawnSync(
  'npx',
  ['ts-node', '-r', 'tsconfig-paths/register', 'src/main.ts'],
  { cwd: root, env, encoding: 'utf8', stdio: 'inherit' },
);

if (exportResult.status !== 0) {
  console.error('Failed to export OpenAPI schema');
  process.exit(exportResult.status || 1);
}

if (!fs.existsSync(openapiPath)) {
  console.error(`Expected ${openapiPath} to exist after export`);
  process.exit(1);
}

console.log('→ Generating TypeScript types with openapi-typescript…');
const genResult = spawnSync(
  'npx',
  ['openapi-typescript', openapiPath, '-o', schemaPath],
  { cwd: root, env, encoding: 'utf8', stdio: 'inherit' },
);

if (genResult.status !== 0) {
  console.error('openapi-typescript failed');
  process.exit(genResult.status || 1);
}

console.log('✓ SDK generated in sdk/');
