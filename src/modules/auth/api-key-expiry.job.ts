import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '@prisma/client';

/**
 * ApiKeyExpiryJob
 *
 * Runs once daily to warn API key owners whose keys will expire within 7 days.
 *
 * A warning is sent when ALL of the following are true:
 *   - The key has a non-null expiresAt
 *   - expiresAt is between now and now + 7 days (key hasn't expired yet)
 *   - expiryWarningSentAt is NULL (warning not already dispatched)
 *   - revokedAt is NULL (key is still active)
 *
 * After sending, expiryWarningSentAt is stamped to prevent duplicates.
 *
 * Issue #369.
 */
@Injectable()
export class ApiKeyExpiryJob {
  private readonly logger = new Logger(ApiKeyExpiryJob.name);

  /** Look-ahead window: 7 days in milliseconds. */
  private static readonly WARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async warnExpiringKeys() {
    try {
      this.logger.log('Starting API key expiry warning check...');

      const now = new Date();
      const warningCutoff = new Date(now.getTime() + ApiKeyExpiryJob.WARNING_WINDOW_MS);

      const expiringKeys = await this.prisma.apiKey.findMany({
        where: {
          revokedAt: null,
          expiryWarningSentAt: null,
          expiresAt: {
            gt: now,           // not already expired
            lte: warningCutoff, // expires within 7 days
          },
        },
        include: {
          user: {
            select: {
              id: true,
              stellarAddress: true,
            },
          },
        },
      });

      if (expiringKeys.length === 0) {
        this.logger.log('No API keys require an expiry warning today.');
        return;
      }

      this.logger.log(`Found ${expiringKeys.length} API key(s) expiring within 7 days.`);

      for (const key of expiringKeys) {
        await this.sendExpiryWarning(key, now);
      }
    } catch (error) {
      this.logger.error('API key expiry warning job failed', error.message);
    }
  }

  private async sendExpiryWarning(
    key: { id: string; name: string; expiresAt: Date | null; user: { id: string; stellarAddress: string } },
    now: Date,
  ) {
    try {
      const expiresAt = key.expiresAt as Date;
      const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      const expiryDateStr = expiresAt.toISOString().split('T')[0];

      const title = `API key "${key.name}" expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
      const message =
        `Your API key "${key.name}" will expire on ${expiryDateStr}. ` +
        `Create a new key before then to avoid service interruption.`;

      await this.notifications.notifyUser(
        key.user.stellarAddress,
        NotificationType.SYSTEM_ALERT,
        title,
        message,
        {
          apiKeyId: key.id,
          apiKeyName: key.name,
          expiresAt: expiresAt.toISOString(),
          daysLeft,
        },
      );

      // Stamp the warning so we never re-send it for this key
      await this.prisma.apiKey.update({
        where: { id: key.id },
        data: { expiryWarningSentAt: new Date() },
      });

      this.logger.log(`Expiry warning sent for API key "${key.name}" (${key.id}) — expires ${expiryDateStr}`);
    } catch (error) {
      this.logger.error(
        `Failed to send expiry warning for API key ${key.id}`,
        error.message,
      );
    }
  }
}
