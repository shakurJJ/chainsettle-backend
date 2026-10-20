import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { runTrackedJob } from '../../common/jobs/job-tracker.util';

const REMINDER_LOCK_KEY = 'chainsettle:shipment-reminders:lock';
const REMINDER_LOCK_TTL_MS = 4 * 60 * 1000;
const BATCH_SIZE = 100;

/**
 * Delivers due personal shipment reminders (#386) every 5 minutes through the
 * owner's notification preferences. Each reminder is claimed by atomically
 * setting sentAt, so it is delivered exactly once even across instances.
 */
@Injectable()
export class ShipmentReminderJob {
  private readonly logger = new Logger(ShipmentReminderJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('*/5 * * * *', { name: 'shipment-reminder' })
  async run(): Promise<number> {
    return runTrackedJob(
      this.redis,
      'shipment-reminder',
      async () => {
        const token = randomUUID();
        if (!(await this.redis.acquireLock(REMINDER_LOCK_KEY, token, REMINDER_LOCK_TTL_MS))) {
          this.logger.debug('Skipping reminders — another instance holds the lock');
          return 0;
        }

        let sent = 0;
    try {
      const due = await this.prisma.shipmentReminder.findMany({
        where: { sentAt: null, remindAt: { lte: new Date() } },
        orderBy: { remindAt: 'asc' },
        take: BATCH_SIZE,
        include: { user: { select: { stellarAddress: true } } },
      });

      for (const reminder of due) {
        // Claim first: a reminder deleted or already sent since the read is skipped.
        const { count } = await this.prisma.shipmentReminder.updateMany({
          where: { id: reminder.id, sentAt: null },
          data: { sentAt: new Date() },
        });
        if (count === 0) continue;

        await this.notifications.notifyUser(
          reminder.user.stellarAddress,
          NotificationType.SYSTEM_ALERT,
          'Shipment reminder',
          reminder.message,
          { shipmentId: reminder.shipmentId, reminderId: reminder.id },
        );
        sent++;
      }
    } finally {
      await this.redis.releaseLock(REMINDER_LOCK_KEY, token);
    }

        if (sent > 0) this.logger.log(`Sent ${sent} shipment reminder(s)`);
        return sent;
      },
      this.logger,
    );
  }
}
