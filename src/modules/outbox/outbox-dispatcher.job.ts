import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { RedisService } from '../../common/redis/redis.service';
import { OutboxService } from './outbox.service';

const OUTBOX_LOCK_KEY = 'chainsettle:outbox-dispatcher:lock';
const OUTBOX_LOCK_TTL_MS = 60 * 1000;

/**
 * Drains the transactional outbox on a fixed cadence (#660). A Redis lock makes
 * sure only one pod dispatches per tick; the SQL claim inside OutboxService also
 * skips rows locked by another worker, so a lock expiry alone cannot cause a
 * duplicate delivery of a row that is still in flight.
 */
@Injectable()
export class OutboxDispatcherJob {
  private readonly logger = new Logger(OutboxDispatcherJob.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly redis: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'outbox-dispatcher' })
  async run(): Promise<void> {
    const token = randomUUID();
    const acquired = await this.redis.acquireLock(
      OUTBOX_LOCK_KEY,
      token,
      OUTBOX_LOCK_TTL_MS,
    );

    if (!acquired) return;

    try {
      const result = await this.outbox.drain();
      if (result.claimed > 0) {
        this.logger.debug(
          `[outbox] claimed=${result.claimed} dispatched=${result.dispatched} retried=${result.retried} dead=${result.deadLettered}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[outbox] dispatcher run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await this.redis
        .releaseLock(OUTBOX_LOCK_KEY, token)
        .catch((err) =>
          this.logger.warn(`[outbox] failed to release lock: ${err.message}`),
        );
    }
  }
}
