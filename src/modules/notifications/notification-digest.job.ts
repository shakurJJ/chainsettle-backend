import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from './notifications.service';
import { NotificationType } from '@prisma/client';

@Injectable()
export class NotificationDigestJob {
  private readonly logger = new Logger(NotificationDigestJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // Runs daily; 'weekly' subscribers are only included when this lands on a
  // Monday (JS Date#getDay() === 1) — a fixed day chosen for simplicity.
  @Cron('0 8 * * *')
  async sendDailyDigests() {
    this.logger.log('Running daily notification digest job');
    const isWeeklyDigestDay = new Date().getDay() === 1;

    const usersWithUnread = await this.prisma.user.findMany({
      where: {
        email: { not: null },
        emailVerified: true,
        notifications: { some: { read: false } },
      },
      select: { id: true, email: true },
    });

    let sent = 0;
    for (const user of usersWithUnread) {
      try {
        const digestFrequency = await this.notifications.getDigestFrequency(user.id);
        if (digestFrequency === 'instant') continue;
        if (digestFrequency === 'weekly' && !isWeeklyDigestDay) continue;

        const prefs = await this.notifications.getOrCreatePreferences(user.id);

        const allEmailDisabled = Object.values(NotificationType).every(
          (type) => !prefs[type]?.email,
        );
        if (allEmailDisabled) continue;

        const digest = await this.notifications.buildDigest(user.id);
        if (!digest) continue;

        await this.notifications.sendEmail(user.email!, digest.subject, '', digest.html);
        sent++;
      } catch (err) {
        this.logger.error(`Digest failed for user ${user.id}`, err.message);
      }
    }

    this.logger.log(`Daily digest complete — sent ${sent} emails`);
  }
}
