import { KycWebhookDto } from './dto/kyc-webhook.dto';

/**
 * Injection token for the configured KYC provider adapter.
 *
 * Consumers (e.g. KycService) should inject the provider via this token so
 * that swapping or combining providers requires no changes in the service.
 */
export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

/**
 * Normalized status values returned by any KYC provider adapter.
 */
export type KycStatus = 'VERIFIED' | 'REJECTED' | 'PENDING';

/**
 * Result of parsing a provider webhook into the application's canonical shape.
 */
export interface KycWebhookResult {
  reference: string;
  stellarAddress: string;
  status: KycStatus;
}

/**
 * Contract every KYC provider adapter must implement.
 *
 * Adding a new provider means implementing this interface and registering it
 * in the provider factory; KycService remains untouched.
 */
export interface KycProvider {
  /**
   * Create a KYC verification session for the given user.
   */
  createSession(user: {
    id: string;
    stellarAddress: string;
  }): Promise<{ reference: string }>;

  /**
   * Parse a provider-specific webhook payload into the canonical result.
   */
  parseWebhook(payload: KycWebhookDto): KycWebhookResult;

  /**
   * Verify the authenticity of an incoming webhook.
   */
  verifySignature(rawPayload: unknown, signature?: string): boolean;
}

/**
 * Configuration keys used to select and configure a KYC provider.
 */
export interface KycProviderConfig {
  /** Name of the provider adapter to use (e.g. 'default'). */
  provider: string;
  /** Secret used to verify webhook signatures. */
  webhookSecret: string;
}