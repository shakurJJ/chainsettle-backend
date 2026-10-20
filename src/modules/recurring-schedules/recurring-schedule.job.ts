import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { TokenRegistryService } from '../../common/token-registry/token-registry.service';
import { NotificationsService } from '../notifications/notifications.service';
import { advance } from './recurring-schedules.service';
import { runTrackedJob } from '../../common/jobs/job-tracker.util';

const LOCK_KEY = 'chainsettle:recurring-schedules:lock';
const LOCK_TTL_MS = 4 * 60 * 1000;
const BATCH_SIZE = 50;

/**
 * Creates draft shipments from templates for due recurring schedules (#389).
 * A Redis lock keeps instances from running concurrently, and each schedule is
 * claimed by a compare-and-set on nextRunAt inside the same transaction that
 * creates the draft, so a run yields exactly one draft.
 */
@Injectable()
export class RecurringScheduleJob {
  private readonly logger = new Logger(RecurringScheduleJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tokenRegistry: TokenRegistryService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'recurring-schedule' })
  async run(): Promise<number> {
    return runTrackedJob(
      this.redis,
      'recurring-schedule',
      async () => {
        const token = randomUUID();
        if (!(await this.redis.acquireLock(LOCK_KEY, token, LOCK_TTL_MS))) {
          this.logger.debug('Skipping recurring schedules — another instance holds the lock');
          return 0;
        }

        let created = 0;
        try {
          const now = new Date();
          const due = await this.prisma.recurringSchedule.findMany({
            where: { active: true, nextRunAt: { lte: now } },
            orderBy: { nextRunAt: 'asc' },
            take: BATCH_SIZE,
            include: { template: true, owner: { select: { stellarAddress: true } } },
          });

          for (const schedule of due) {
            try {
              if (await this.runOne(schedule, now)) created++;
            } catch (err: any) {
              this.logger.error(`Recurring schedule ${schedule.id} failed: ${err.message}`);
            }
          }
        } finally {
          await this.redis.releaseLock(LOCK_KEY, token);
        }

        if (created > 0) this.logger.log(`Created ${created} recurring draft shipment(s)`);
        return created;
      },
      this.logger,
    );
  }

  private async runOne(schedule: any, now: Date): Promise<boolean> {
    const { template } = schedule;
    if (template.deletedAt) {
      await this.prisma.recurringSchedule.update({ where: { id: schedule.id }, data: { active: false } });
      return false;
    }

    // Skip missed intervals so a long outage creates one catch-up draft, not many.
    let nextRunAt = advance(schedule.nextRunAt, schedule.interval);
    while (nextRunAt <= now) nextRunAt = advance(nextRunAt, schedule.interval);

    let decimals = 7;
    let symbol = 'USDC';
    try {
      const t = this.tokenRegistry.getToken(template.tokenAddress);
      decimals = t.decimals;
      symbol = t.symbol;
    } catch {
      // fall back to schema defaults
    }

    const shipmentId = randomUUID();
    const claimed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.recurringSchedule.updateMany({
        where: { id: schedule.id, active: true, nextRunAt: schedule.nextRunAt },
        data: { nextRunAt, lastRunAt: now },
      });
      if (count === 0) return false;

      await tx.shipment.create({
        data: {
          id: shipmentId,
          buyerAddress: schedule.owner.stellarAddress,
          supplierAddress: template.supplierAddress,
          logisticsAddress: template.logisticsAddress,
          arbiterAddress: template.arbiterAddress,
          tokenAddress: template.tokenAddress,
          tokenDecimals: decimals,
          tokenSymbol: symbol,
          totalAmount: schedule.totalAmount,
          description: template.description,
          metadata: { recurringScheduleId: schedule.id, templateId: template.id },
          isDraft: true,
        },
      });
      return true;
    });
    if (!claimed) return false;

    await this.notifications.notifyUser(
      schedule.owner.stellarAddress,
      NotificationType.SYSTEM_ALERT,
      'Recurring draft shipment ready',
      `A draft shipment from template "${template.name}" is ready to review and sign.`,
      { shipmentId, recurringScheduleId: schedule.id, link: `/shipments/${shipmentId}` },
    );
    return true;
  }
}
