import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

import { runTrackedJob } from '../../common/jobs/job-tracker.util';

const CLEANUP_LOCK_KEY = 'chainsettle:notification-cleanup:lock';
const CLEANUP_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BATCH_SIZE = 5_000;
const UNREAD_ARCHIVE_DAYS = 365;

/**
 * Nightly job that deletes read notifications older than NOTIFICATION_RETENTION_DAYS
 * (default 90) in batches of 5,000 to avoid long table locks.
 *
 * Additionally soft-archives (logs a warning for) unread notifications older
 * than 365 days — they are never deleted automatically.
 *
 * A Redis distributed lock ensures only one pod runs the job at a time.
 */
@Injectable()
export class NotificationCleanupJob {
  private readonly logger = new Logger(NotificationCleanupJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  @Cron('0 2 * * *', { name: 'notification-cleanup' }) // 02:00 server time every night
  async runCleanup(): Promise<void> {
    await runTrackedJob(
      this.redis,
      'notification-cleanup',
      async () => {
        const token = randomUUID();
        const acquired = await this.redis.acquireLock(
          CLEANUP_LOCK_KEY,
          token,
          CLEANUP_LOCK_TTL_MS,
        );

        if (!acquired) {
          this.logger.debug('Skipping notification cleanup — another instance holds the lock');
          return;
        }

        try {
          await this.deleteReadNotifications();
          await this.warnStaleUnread();
        } finally {
          await this.redis.releaseLock(CLEANUP_LOCK_KEY, token);
        }
      },
      this.logger,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async deleteReadNotifications(): Promise<void> {
    const days = this.config.get<number>('NOTIFICATION_RETENTION_DAYS', 90);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    this.logger.log(
      `Starting read-notification cleanup (cutoff=${cutoff.toISOString()}, retentionDays=${days})`,
    );

    let totalDeleted = 0;

    // Delete in batches: find a page of IDs, then delete only those IDs so the
    // WHERE clause stays narrow and never escalates to a full-table lock.
    while (true) {
      const batch = await this.prisma.notification.findMany({
        where: { read: true, createdAt: { lte: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
        orderBy: { createdAt: 'asc' },
      });

      if (batch.length === 0) break;

      const ids = batch.map((n) => n.id);
      const { count } = await this.prisma.notification.deleteMany({
        where: { id: { in: ids } },
      });

      totalDeleted += count;
      this.logger.log(`Deleted batch of ${count} read notifications (total so far: ${totalDeleted})`);

      if (batch.length < BATCH_SIZE) break;
    }

    this.logger.log(`Notification cleanup complete — deleted ${totalDeleted} read notifications`);
  }

  /**
   * Logs a warning for users who have unread notifications older than 365 days.
   * These are never deleted; this just surfaces stale data for ops visibility.
   */
  private async warnStaleUnread(): Promise<void> {
    const cutoff = new Date(Date.now() - UNREAD_ARCHIVE_DAYS * 24 * 60 * 60 * 1000);

    const staleCount = await this.prisma.notification.count({
      where: { read: false, createdAt: { lte: cutoff } },
    });

    if (staleCount > 0) {
      this.logger.warn(
        `${staleCount} unread notification(s) are older than ${UNREAD_ARCHIVE_DAYS} days — ` +
          'these are retained but may indicate abandoned accounts.',
      );
    }
  }
}
