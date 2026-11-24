import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_QUEUE_POLICIES,
  resolveQueuePolicies,
} from './queue-policy';
import { QUEUE_EMAILS, QUEUE_EXPORTS, QUEUE_WEBHOOKS } from './queue.constants';

function configWith(values: Record<string, string | number>): ConfigService {
  return {
    get: (key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
  } as unknown as ConfigService;
}

describe('resolveQueuePolicies (#661)', () => {
  it('falls back to the documented defaults', () => {
    const policies = resolveQueuePolicies(configWith({}));

    expect(policies[QUEUE_WEBHOOKS]).toEqual(DEFAULT_QUEUE_POLICIES.webhooks);
    expect(policies[QUEUE_EMAILS]).toEqual(DEFAULT_QUEUE_POLICIES.emails);
    expect(policies[QUEUE_EXPORTS]).toEqual(DEFAULT_QUEUE_POLICIES.exports);
  });

  it('reads concurrency and retry policy per queue from config', () => {
    const policies = resolveQueuePolicies(
      configWith({
        QUEUE_WEBHOOK_CONCURRENCY: '25',
        QUEUE_WEBHOOK_ATTEMPTS: 8,
        QUEUE_WEBHOOK_BACKOFF_MS: '45000',
        QUEUE_EMAIL_CONCURRENCY: 3,
        QUEUE_EXPORT_ATTEMPTS: 2,
      }),
    );

    expect(policies[QUEUE_WEBHOOKS]).toEqual({
      concurrency: 25,
      attempts: 8,
      backoffMs: 45_000,
    });
    expect(policies[QUEUE_EMAILS].concurrency).toBe(3);
    expect(policies[QUEUE_EMAILS].attempts).toBe(
      DEFAULT_QUEUE_POLICIES.emails.attempts,
    );
    expect(policies[QUEUE_EXPORTS].attempts).toBe(2);
  });

  it('clamps out-of-range values and ignores non-numeric ones', () => {
    const policies = resolveQueuePolicies(
      configWith({
        QUEUE_WEBHOOK_CONCURRENCY: '0',
        QUEUE_WEBHOOK_ATTEMPTS: '999',
        QUEUE_WEBHOOK_BACKOFF_MS: 'not-a-number',
      }),
    );

    expect(policies[QUEUE_WEBHOOKS].concurrency).toBe(1);
    expect(policies[QUEUE_WEBHOOKS].attempts).toBe(20);
    expect(policies[QUEUE_WEBHOOKS].backoffMs).toBe(
      DEFAULT_QUEUE_POLICIES.webhooks.backoffMs,
    );
  });
});
