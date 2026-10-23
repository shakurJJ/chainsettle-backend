import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../../common/redis/redis.service';
import { runTrackedJob } from '../../common/jobs/job-tracker.util';
import { MilestoneStatus, NotificationType, UserRole } from '@prisma/client';

/**
 * DisputeEscalationJob
 *
 * Runs hourly. For every milestone that has been in DISPUTED status for longer
 * than DISPUTE_ESCALATION_DAYS (default 7) without being resolved, sends a
 * SYSTEM_ALERT notification to every ADMIN user and sets disputeEscalatedAt to
 * prevent repeated alerts.
 */
@Injectable()
export class DisputeEscalationJob {
  private readonly logger = new Logger(DisputeEscalationJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'dispute-escalation' })
  async checkAndEscalateDisputes() {
    const execute = async () => {
      try {
        this.logger.log('Starting dispute escalation check...');

      const days = this.config.get<number>('DISPUTE_ESCALATION_DAYS', 7);
      const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const overdue = await this.prisma.milestone.findMany({
        where: {
          status: MilestoneStatus.DISPUTED,
          updatedAt: { lt: threshold },
          disputeEscalatedAt: null,
        },
        include: {
          shipment: {
            select: {
              id: true,
              arbiterAddress: true,
              arbiter: { select: { arbiterAwayUntil: true, awayMessage: true } },
            },
          },
        },
      });

      if (overdue.length === 0) {
        this.logger.log('No disputes require escalation');
        return;
      }

      this.logger.log(`Found ${overdue.length} dispute(s) requiring escalation`);

      const admins = await this.prisma.user.findMany({
        where: { role: UserRole.ADMIN },
        select: { stellarAddress: true },
      });

      if (admins.length === 0) {
        this.logger.warn('No admin users found — disputes cannot be escalated');
      }

        for (const milestone of overdue) {
          await this.escalate(milestone, admins, days);
        }
      } catch (error) {
        this.logger.error('Dispute escalation check failed', error.message);
      }
    };

    if (this.redis) {
      await runTrackedJob(this.redis, 'dispute-escalation', execute, this.logger);
    } else {
      await execute();
    }
  }

  private async escalate(
    milestone: any,
    admins: { stellarAddress: string }[],
    days: number,
  ) {
    try {
      const { shipment, milestoneIndex, id } = milestone;

      const awayUntil: Date | null = shipment.arbiter?.arbiterAwayUntil ?? null;
      const arbiterAway = !!awayUntil && awayUntil > new Date();

      const title = `Unresolved dispute — shipment ${shipment.id} milestone ${milestoneIndex}`;
      const message =
        `Dispute on shipment ${shipment.id} milestone ${milestoneIndex} has been unresolved for over ${days} days. Arbiter: ${shipment.arbiterAddress}.` +
        (arbiterAway ? ` The arbiter is marked away until ${awayUntil!.toISOString()}.` : '');

      for (const admin of admins) {
        await this.notifications.notifyUser(
          admin.stellarAddress,
          NotificationType.SYSTEM_ALERT,
          title,
          message,
          {
            shipmentId: shipment.id,
            milestoneIndex,
            arbiterAddress: shipment.arbiterAddress,
            arbiterAway,
            arbiterAwayUntil: arbiterAway ? awayUntil!.toISOString() : null,
          },
        );
      }

      await this.prisma.milestone.update({
        where: { id },
        data: { disputeEscalatedAt: new Date() },
      });

      this.logger.log(`Escalated dispute: shipment ${shipment.id}[${milestoneIndex}]`);
    } catch (error) {
      this.logger.error(
        `Failed to escalate dispute for milestone ${milestone.id}`,
        error.message,
      );
    }
  }
}
