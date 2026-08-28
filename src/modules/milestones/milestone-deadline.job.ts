import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MilestoneStatus, NotificationType } from '@prisma/client';

/**
 * MilestoneDeadlineJob
 *
 * Runs hourly to check for overdue milestones and send notifications.
 * A milestone is considered overdue when:
 *   - status is PENDING or PROOF_SUBMITTED
 *   - dueAt is in the past
 *   - overdueNotifiedAt is NULL (hasn't been notified yet)
 *
 * Escalation thresholds (env-var configurable):
 *   - OVERDUE_REMINDER_1_DAYS (default 0): initial overdue notification
 *   - OVERDUE_REMINDER_3_DAYS (default 3): follow-up escalation notification
 *
 * For each overdue milestone, notifies both the buyer and supplier,
 * then sets overdueNotifiedAt to prevent duplicate notifications.
 * After 3 days, sends a second escalation and sets overdueReminder3dAt.
 */
@Injectable()
export class MilestoneDeadlineJob {
  private readonly logger = new Logger(MilestoneDeadlineJob.name);

  private readonly reminder1Days: number;
  private readonly reminder3Days: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    this.reminder1Days = parseInt(process.env.OVERDUE_REMINDER_1_DAYS ?? '0', 10);
    this.reminder3Days = parseInt(process.env.OVERDUE_REMINDER_3_DAYS ?? '3', 10);
  }

  /**
   * Scheduled job: runs every hour
   * Detects overdue milestones and sends notifications
   */
  @Cron(CronExpression.EVERY_HOUR)
  async checkAndNotifyOverdue() {
    try {
      this.logger.log('Starting milestone deadline check...');

      const now = new Date();

      // --- Initial overdue notification ---
      const overdueMillestones = await this.prisma.milestone.findMany({
        where: {
          dueAt: { lt: now },
          status: {
            in: [MilestoneStatus.PENDING, MilestoneStatus.PROOF_SUBMITTED],
          },
          overdueNotifiedAt: null,
        },
        include: {
          shipment: {
            select: {
              id: true,
              buyerAddress: true,
              supplierAddress: true,
            },
          },
        },
      });

      if (overdueMillestones.length === 0) {
        this.logger.log('No overdue milestones found');
      } else {
        this.logger.log(`Found ${overdueMillestones.length} overdue milestone(s)`);
        for (const milestone of overdueMillestones) {
          await this.notifyOverdue(milestone);
        }
      }

      // --- 3-day escalation notification ---
      const escalationThresholdMs = this.reminder3Days * 24 * 60 * 60 * 1000;
      const escalationCutoff = new Date(now.getTime() - escalationThresholdMs);

      const escalationMilestones = await this.prisma.milestone.findMany({
        where: {
          status: {
            in: [MilestoneStatus.PENDING, MilestoneStatus.PROOF_SUBMITTED],
          },
          overdueNotifiedAt: {
            not: null,
            lt: escalationCutoff, // initial notice was sent more than 3 days ago
          },
          overdueReminder3dAt: null, // escalation not yet sent
        },
        include: {
          shipment: {
            select: {
              id: true,
              buyerAddress: true,
              supplierAddress: true,
            },
          },
        },
      });

      if (escalationMilestones.length === 0) {
        this.logger.log('No milestones require 3-day escalation');
      } else {
        this.logger.log(`Found ${escalationMilestones.length} milestone(s) requiring 3-day escalation`);
        for (const milestone of escalationMilestones) {
          await this.notifyEscalation(milestone);
        }
      }
    } catch (error) {
      this.logger.error('Milestone deadline check failed', error.message);
    }
  }

  /**
   * Notify buyer and supplier about overdue milestone (initial notice)
   * Then set overdueNotifiedAt to prevent re-notification
   */
  private async notifyOverdue(milestone: any) {
    try {
      const { shipment, milestoneIndex, dueAt } = milestone;
      const shipmentId = shipment.id;

      const dueDateStr = new Date(dueAt).toISOString().split('T')[0];
      const title = `Milestone ${milestoneIndex} overdue`;
      const message = `Milestone ${milestoneIndex} for shipment ${shipmentId} is overdue (was due ${dueDateStr}). Please take action or raise a dispute.`;

      await this.notifications.notifyUser(
        shipment.buyerAddress,
        NotificationType.MILESTONE_OVERDUE,
        title,
        message,
        {
          shipmentId,
          milestoneIndex,
          dueAt: dueAt.toISOString(),
          threshold: this.reminder1Days,
          recipient: shipment.buyerAddress,
          escalation: false,
        },
      );

      await this.notifications.notifyUser(
        shipment.supplierAddress,
        NotificationType.MILESTONE_OVERDUE,
        title,
        message,
        {
          shipmentId,
          milestoneIndex,
          dueAt: dueAt.toISOString(),
          threshold: this.reminder1Days,
          recipient: shipment.supplierAddress,
          escalation: false,
        },
      );

      await this.prisma.milestone.update({
        where: { id: milestone.id },
        data: { overdueNotifiedAt: new Date() },
      });

      this.logger.log(`Notified overdue milestone: ${shipmentId}[${milestoneIndex}]`);
    } catch (error) {
      this.logger.error(
        `Failed to notify overdue milestone ${milestone.id}`,
        error.message,
      );
    }
  }

  /**
   * Notify buyer and supplier about 3-day escalation
   * Then set overdueReminder3dAt to prevent re-sending
   */
  private async notifyEscalation(milestone: any) {
    try {
      const { shipment, milestoneIndex, dueAt } = milestone;
      const shipmentId = shipment.id;

      const dueDateStr = new Date(dueAt).toISOString().split('T')[0];
      const title = `Milestone ${milestoneIndex} overdue — escalation`;
      const message = `This milestone is now ${this.reminder3Days} days overdue. Milestone ${milestoneIndex} for shipment ${shipmentId} (was due ${dueDateStr}) still requires action. Please resolve immediately or raise a dispute.`;

      await this.notifications.notifyUser(
        shipment.buyerAddress,
        NotificationType.MILESTONE_OVERDUE,
        title,
        message,
        {
          shipmentId,
          milestoneIndex,
          dueAt: dueAt.toISOString(),
          threshold: this.reminder3Days,
          recipient: shipment.buyerAddress,
          escalation: true,
        },
      );

      await this.notifications.notifyUser(
        shipment.supplierAddress,
        NotificationType.MILESTONE_OVERDUE,
        title,
        message,
        {
          shipmentId,
          milestoneIndex,
          dueAt: dueAt.toISOString(),
          threshold: this.reminder3Days,
          recipient: shipment.supplierAddress,
          escalation: true,
        },
      );

      await this.prisma.milestone.update({
        where: { id: milestone.id },
        data: { overdueReminder3dAt: new Date() },
      });

      this.logger.log(`Escalation notification sent: ${shipmentId}[${milestoneIndex}]`);
    } catch (error) {
      this.logger.error(
        `Failed to send escalation for milestone ${milestone.id}`,
        error.message,
      );
    }
  }
}