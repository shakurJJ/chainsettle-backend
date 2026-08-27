/**
 * Pact Provider Verification — Auth
 *
 * Verifies that the backend's auth endpoints honour every interaction
 * published by the frontend consumer.  See shipments.pact.spec.ts for
 * full usage documentation.
 *
 * Required packages (install manually before running):
 *   npm install --save-dev @pact-foundation/pact
 */

import * as path from 'path';
import { Verifier, VerifierOptions } from '@pact-foundation/pact';
import { startProvider, ProviderSetup, PROVIDER_STELLAR_ADDRESS } from './provider-setup';

const PROVIDER_NAME = 'chainsettle-backend';
const CONSUMER_NAME = 'chainsettle-frontend';

describe(`Pact provider verification — ${PROVIDER_NAME} (auth)`, () => {
  let setup: ProviderSetup;

  beforeAll(async () => {
    setup = await startProvider();
  }, 30_000);

  afterAll(async () => {
    await setup.teardown();
  });

  it('satisfies all auth consumer contracts', async () => {
    const useBroker =
      Boolean(process.env.PACT_BROKER_URL) && Boolean(process.env.PACT_BROKER_TOKEN);

    // ── Provider states ─────────────────────────────────────────────────────

    const stateHandlers: Record<string, () => Promise<void>> = {
      'a nonce has been generated for the address': async () => {
        // The Redis mock already returns a stored nonce string on .get() — no-op.
      },
      'the nonce has been consumed': async () => {
        // Redis mock .get() returns null by default after del — no-op.
      },
      'a user exists with the given Stellar address': async () => {
        // PrismaService mock already returns the provider user — no-op.
      },
      'no user exists with the given Stellar address': async () => {
        // This state is handled by the consumer using an invalid address
        // that the backend rejects at the signature-verification stage.
      },
    };

    const baseOptions: Partial<VerifierOptions> = {
      provider: PROVIDER_NAME,
      providerBaseUrl: setup.baseUrl,
      stateHandlers,
      requestFilter: (req, _res, next) => {
        // Auth routes are public; inject the JWT only for /auth/resend-verification.
        if (req.path?.includes('resend-verification') && !req.headers['authorization']) {
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
      const contractsDir = path.resolve(__dirname, 'contracts');
      verifierOptions = {
        ...baseOptions,
        pactUrls: [
          path.join(contractsDir, `${CONSUMER_NAME}-${PROVIDER_NAME}-auth.json`),
        ],
      } as VerifierOptions;
    }

    const output = await new Verifier(verifierOptions).verifyProvider();
    console.log('[pact] Auth verification output:', output);
  }, 60_000);
});
