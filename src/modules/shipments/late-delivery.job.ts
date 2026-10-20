import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType, ShipmentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';

import { runTrackedJob } from '../../common/jobs/job-tracker.util';

const LATE_DELIVERY_LOCK_KEY = 'chainsettle:late-delivery:lock';
const LATE_DELIVERY_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * LateDeliveryJob
 *
 * Runs daily to check for ACTIVE shipments past their expectedDeliveryAt date
 * and flag/alert participants.
 */
@Injectable()
export class LateDeliveryJob {
  private readonly logger = new Logger(LateDeliveryJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'late-delivery' })
  async run(): Promise<number> {
    return runTrackedJob(
      this.redis,
      'late-delivery',
      async () => {
        const token = randomUUID();
        const acquired = await this.redis.acquireLock(
          LATE_DELIVERY_LOCK_KEY,
          token,
          LATE_DELIVERY_LOCK_TTL_MS,
        );

        if (!acquired) {
          this.logger.debug('Skipping late delivery check — another instance holds the lock');
          return 0;
        }

        let flaggedCount = 0;
        try {
          flaggedCount = await this.checkOverdueShipments();
        } catch (err: any) {
          this.logger.error(`Late delivery check failed: ${err.message}`, err.stack);
        } finally {
          await this.redis.releaseLock(LATE_DELIVERY_LOCK_KEY, token);
        }

        return flaggedCount;
      },
      this.logger,
    );
  }

  /**
   * Finds all ACTIVE shipments past their expectedDeliveryAt date, logs a warning,
   * and notifies the buyer and supplier.
   */
  async checkOverdueShipments(): Promise<number> {
    const now = new Date();
    const overdueShipments = await this.prisma.shipment.findMany({
      where: {
        status: ShipmentStatus.ACTIVE,
        expectedDeliveryAt: {
          lt: now,
        },
      },
      select: {
        id: true,
        buyerAddress: true,
        supplierAddress: true,
        expectedDeliveryAt: true,
        status: true,
      },
    });

    if (overdueShipments.length === 0) {
      this.logger.log('No overdue ACTIVE shipments found');
      return 0;
    }

    this.logger.warn(`Found ${overdueShipments.length} overdue ACTIVE shipment(s) past expectedDeliveryAt`);

    for (const shipment of overdueShipments) {
      const expectedStr = shipment.expectedDeliveryAt?.toISOString() ?? 'unknown date';
      const title = 'Shipment delivery overdue';
      const message = `Shipment ${shipment.id} is overdue. Promised delivery date was ${expectedStr}.`;
      const data = {
        shipmentId: shipment.id,
        expectedDeliveryAt: shipment.expectedDeliveryAt?.toISOString(),
        isOverdue: true,
      };

      await this.notifications.notifyUser(
        shipment.buyerAddress,
        NotificationType.DELIVERY_DELAYED,
        title,
        message,
        data,
      );

      await this.notifications.notifyUser(
        shipment.supplierAddress,
        NotificationType.DELIVERY_DELAYED,
        title,
        message,
        data,
      );

      this.logger.warn(`Flagged overdue shipment ${shipment.id} (promised: ${expectedStr})`);
    }

    return overdueShipments.length;
  }
}
