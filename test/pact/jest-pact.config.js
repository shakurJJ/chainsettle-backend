/**
 * Jest configuration for Pact provider verification tests.
 *
 * Run separately from unit tests:
 *   npx jest --config test/pact/jest-pact.config.js
 *
 * Required packages (install manually):
 *   npm install --save-dev @pact-foundation/pact @pact-foundation/pact-node
 *
 * Environment variables consumed at runtime:
 *   PACT_BROKER_URL       – URL of the Pact Broker (e.g. https://chainsettle.pactflow.io)
 *   PACT_BROKER_TOKEN     – Bearer token for the broker (CI secret)
 *   PACT_CONSUMER_VERSION – Git SHA / semver of the consumer under verification
 *                           Falls back to "local" when not set
 *   PACT_PUBLISH_RESULTS  – Set to "true" in CI to publish verification results
 */

'use strict';

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../..',
  testRegex: 'test/pact/.*\\.pact\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 60_000, // provider verification can be slow
  globalSetup: '<rootDir>/test/pact/global-setup.ts',
  globalTeardown: '<rootDir>/test/pact/global-teardown.ts',
};
