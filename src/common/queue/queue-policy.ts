import { ConfigService } from '@nestjs/config';
import {
  QUEUE_EMAILS,
  QUEUE_EXPORTS,
  QUEUE_NAMES,
  QUEUE_WEBHOOKS,
  QueueName,
} from './queue.constants';

/**
 * Per-queue execution policy. Concurrency bounds how many jobs one worker
 * processes at a time; attempts/backoffMs control BullMQ's exponential retry
 * policy for failed jobs (#661).
 */
export interface JobQueuePolicy {
  concurrency: number;
  attempts: number;
  backoffMs: number;
}

export const DEFAULT_QUEUE_POLICIES: Record<QueueName, JobQueuePolicy> = {
  [QUEUE_WEBHOOKS]: { concurrency: 10, attempts: 5, backoffMs: 30_000 },
  [QUEUE_EMAILS]: { concurrency: 5, attempts: 5, backoffMs: 5_000 },
  [QUEUE_EXPORTS]: { concurrency: 2, attempts: 3, backoffMs: 10_000 },
};

const ENV_KEYS: Record<
  QueueName,
  { concurrency: string; attempts: string; backoffMs: string }
> = {
  [QUEUE_WEBHOOKS]: {
    concurrency: 'QUEUE_WEBHOOK_CONCURRENCY',
    attempts: 'QUEUE_WEBHOOK_ATTEMPTS',
    backoffMs: 'QUEUE_WEBHOOK_BACKOFF_MS',
  },
  [QUEUE_EMAILS]: {
    concurrency: 'QUEUE_EMAIL_CONCURRENCY',
    attempts: 'QUEUE_EMAIL_ATTEMPTS',
    backoffMs: 'QUEUE_EMAIL_BACKOFF_MS',
  },
  [QUEUE_EXPORTS]: {
    concurrency: 'QUEUE_EXPORT_CONCURRENCY',
    attempts: 'QUEUE_EXPORT_ATTEMPTS',
    backoffMs: 'QUEUE_EXPORT_BACKOFF_MS',
  },
};

function integerInRange(
  config: Pick<ConfigService, 'get'>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = config.get<string | number>(key, fallback);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** Resolves the effective concurrency/retry policy for every queue. */
export function resolveQueuePolicies(
  config: Pick<ConfigService, 'get'>,
): Record<QueueName, JobQueuePolicy> {
  const policies = {} as Record<QueueName, JobQueuePolicy>;

  for (const name of QUEUE_NAMES) {
    const defaults = DEFAULT_QUEUE_POLICIES[name];
    const keys = ENV_KEYS[name];
    policies[name] = {
      concurrency: integerInRange(
        config,
        keys.concurrency,
        defaults.concurrency,
        1,
        100,
      ),
      attempts: integerInRange(config, keys.attempts, defaults.attempts, 1, 20),
      // BullMQ exponential back-off: delay * 2^(attemptsMade - 1)
      backoffMs: integerInRange(
        config,
        keys.backoffMs,
        defaults.backoffMs,
        100,
        3_600_000,
      ),
    };
  }

  return policies;
}
