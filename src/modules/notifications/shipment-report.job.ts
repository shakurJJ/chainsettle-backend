import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { runTrackedJob } from '../../common/jobs/job-tracker.util';
import { NotificationsService } from './notifications.service';
import { ShipmentReportService } from './shipment-report.service';

/**
 * Emails opted-in users a summary of their own shipments.
 *
 * Weekly reports go out on Mondays, monthly reports on the 1st. The job only
 * considers users who have stored `_meta.reportFrequency`, so reports stay
 * strictly opt-in; `sendEmail` enforces the bounce/complaint suppression list
 * and unsubscribe is honoured by skipping users with every email channel off.
 */
@Injectable()
export class ShipmentReportJob {
  private readonly logger = new Logger(ShipmentReportJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly reports: ShipmentReportService,
  ) {}

  @Cron('0 9 * * *', { name: 'personal-shipment-report' })
  async sendScheduledReports(): Promise<{ sent: number; skipped: number }> {
    return runTrackedJob(
      this.redis,
      'personal-shipment-report',
      async () => this.executeScheduledReports(),
      this.logger,
    );
  }

  async executeScheduledReports(
    now: Date = new Date(),
  ): Promise<{ sent: number; skipped: number }> {
    const isWeeklyDay = now.getDay() === 1;
    const isMonthlyDay = now.getDate() === 1;
    if (!isWeeklyDay && !isMonthlyDay) return { sent: 0, skipped: 0 };

    const users = await this.prisma.user.findMany({
      where: {
        email: { not: null },
        emailVerified: true,
        deactivatedAt: null,
        notificationPreference: {
          is: {
            OR: [
              {
                preferences: {
                  path: ['_meta', 'reportFrequency'],
                  equals: 'weekly',
                },
              },
              {
                preferences: {
                  path: ['_meta', 'reportFrequency'],
                  equals: 'monthly',
                },
              },
            ],
          },
        },
      },
      select: {
        id: true,
        email: true,
        locale: true,
      },
    });

    let sent = 0;
    let skipped = 0;

    for (const user of users) {
      try {
        const frequency = await this.notifications.getReportFrequency(user.id);
        if (frequency === 'off') {
          skipped++;
          continue;
        }
        if (frequency === 'weekly' && !isWeeklyDay) {
          skipped++;
          continue;
        }
        if (frequency === 'monthly' && !isMonthlyDay) {
          skipped++;
          continue;
        }
        if (await this.notifications.isQuietHours(user.id)) {
          skipped++;
          continue;
        }

        const prefs = await this.notifications.getOrCreatePreferences(user.id);
        const allEmailDisabled = Object.values(NotificationType).every(
          (type) => !prefs[type]?.email,
        );
        if (allEmailDisabled) {
          skipped++;
          continue;
        }

        const report = await this.reports.buildForUser(user.id, frequency, now);
        if (!report) {
          skipped++;
          continue;
        }

        const delivered = await this.notifications.sendEmail(
          user.email!,
          report.subject,
          '',
          report.html,
          undefined,
          undefined,
          user.locale ?? undefined,
          user.id,
        );
        if (delivered) sent++;
        else skipped++;
      } catch (err) {
        skipped++;
        this.logger.error(
          `Shipment report failed for user ${user.id}`,
          (err as Error).message,
        );
      }
    }

    this.logger.log(
      `Personal shipment report complete — sent ${sent}, skipped ${skipped}`,
    );
    return { sent, skipped };
  }
}
