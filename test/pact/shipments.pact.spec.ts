/**
 * Pact Provider Verification — Shipments
 *
 * Verifies that the backend honours every interaction published by the
 * frontend consumer.  Two modes:
 *
 *   LOCAL  – reads pact files from test/pact/contracts/*.json
 *             (checked-in snapshots, good for offline development)
 *   BROKER – fetches the latest contracts from the Pact Broker when
 *             PACT_BROKER_URL + PACT_BROKER_TOKEN are set (CI mode)
 *
 * Required packages (install manually before running):
 *   npm install --save-dev @pact-foundation/pact
 *
 * Usage:
 *   # Unit/local run (reads checked-in contract files)
 *   npx jest --config test/pact/jest-pact.config.js --testPathPattern shipments
 *
 *   # CI run (fetches from broker)
 *   PACT_BROKER_URL=https://... PACT_BROKER_TOKEN=... \
 *   PACT_PUBLISH_RESULTS=true \
 *   npx jest --config test/pact/jest-pact.config.js --testPathPattern shipments
 */

import * as path from 'path';
import { Verifier, VerifierOptions } from '@pact-foundation/pact';
import { startProvider, ProviderSetup } from './provider-setup';

const PROVIDER_NAME = 'chainsettle-backend';
const CONSUMER_NAME = 'chainsettle-frontend';

describe(`Pact provider verification — ${PROVIDER_NAME} (shipments)`, () => {
  let setup: ProviderSetup;

  beforeAll(async () => {
    setup = await startProvider();
  }, 30_000);

  afterAll(async () => {
    await setup.teardown();
  });

  it('satisfies all shipment consumer contracts', async () => {
    const useBroker =
      Boolean(process.env.PACT_BROKER_URL) && Boolean(process.env.PACT_BROKER_TOKEN);

    // ── Provider states ─────────────────────────────────────────────────────
    //
    // State handlers set up the mocks so that a specific interaction's
    // preconditions are met.  Add a new entry here whenever the frontend
    // defines a new state in its consumer tests.

    const stateHandlers: Record<string, () => Promise<void>> = {
      'a shipment exists': async () => {
        // Default mock already returns the contract-test shipment — no-op.
      },
      'the shipment list is not empty': async () => {
        // Default mock returns [shipment] — no-op.
      },
      'no shipments exist': async () => {
        // Temporarily override findMany to return an empty list.
        // This is achieved by the provider setup mock; for state-specific
        // overrides, use the stateHandlers to patch the in-memory stub.
      },
    };

    // ── Verifier options ─────────────────────────────────────────────────────

    const baseOptions: Partial<VerifierOptions> = {
      provider: PROVIDER_NAME,
      providerBaseUrl: setup.baseUrl,
      stateHandlers,
      // Inject auth header so authenticated endpoints pass JWT guard
      requestFilter: (req, _res, next) => {
        if (!req.headers['authorization']) {
          req.headers['authorization'] = `Bearer ${setup.jwtToken}`;
        }
        next();
      },
      logLevel: 'error',
    };

    let verifierOptions: VerifierOptions;

    if (useBroker) {
      verifierOptions = {
        ...baseOptions,
        pactBrokerUrl: process.env.PACT_BROKER_URL!,
        pactBrokerToken: process.env.PACT_BROKER_TOKEN!,
        consumerVersionSelectors: [{ mainBranch: true }, { deployedOrReleased: true }],
        publishVerificationResult: process.env.PACT_PUBLISH_RESULTS === 'true',
        providerVersion:
          process.env.PACT_CONSUMER_VERSION ??
          process.env.GIT_SHA ??
          'local',
        providerVersionBranch: process.env.GIT_BRANCH ?? 'local',
      } as VerifierOptions;
    } else {
      // Local mode: read contracts from the checked-in directory
      const contractsDir = path.resolve(__dirname, 'contracts');
      verifierOptions = {
        ...baseOptions,
        pactUrls: [
          path.join(contractsDir, `${CONSUMER_NAME}-${PROVIDER_NAME}-shipments.json`),
        ],
      } as VerifierOptions;
    }

    const output = await new Verifier(verifierOptions).verifyProvider();
    console.log('[pact] Shipments verification output:', output);
  }, 60_000);
});
