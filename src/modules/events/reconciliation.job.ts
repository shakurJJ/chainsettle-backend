import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../../common/redis/redis.service';
import { runTrackedJob } from '../../common/jobs/job-tracker.util';
import { ShipmentStatus, NotificationType, UserRole } from '@prisma/client';
import { nativeToScVal } from '@stellar/stellar-sdk';

@Injectable()
export class ReconciliationJob {
  private readonly logger = new Logger(ReconciliationJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly shipments: ShipmentsService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  @Cron('0 2 * * 0', { name: 'reconciliation' })
  async runReconciliation() {
    const execute = async () => {
      const run = await this.prisma.reconciliationRun.create({
        data: { startedAt: new Date() },
      });

    let checkedCount = 0;
    let mismatchCount = 0;
    const errors: string[] = [];

    try {
      this.logger.log('Starting weekly contract state reconciliation...');

      const activeShipments = await this.prisma.shipment.findMany({
        where: { status: ShipmentStatus.ACTIVE },
        select: { id: true, status: true },
      });

      checkedCount = activeShipments.length;
      this.logger.log(`Reconciling ${checkedCount} ACTIVE shipment(s)`);

      const admins = await this.prisma.user.findMany({
        where: { role: UserRole.ADMIN },
        select: { stellarAddress: true },
      });

      if (admins.length === 0) {
        this.logger.warn('No admin users found — drift alerts will not be sent');
      }

      const statusMap: Record<string, ShipmentStatus> = {
        Active: ShipmentStatus.ACTIVE,
        Completed: ShipmentStatus.COMPLETED,
        Cancelled: ShipmentStatus.CANCELLED,
      };

      for (const shipment of activeShipments) {
        try {
          const shipmentIdScVal = nativeToScVal(shipment.id, { type: 'string' });
          const onChain = await this.stellar.simulateContractCall('get_shipment', [shipmentIdScVal]);

          if (!onChain) {
            this.logger.warn(`Reconciliation: shipment ${shipment.id} not found on-chain`);
            continue;
          }

          const onChainStatus = statusMap[onChain.status];

          if (onChainStatus && onChainStatus !== shipment.status) {
            mismatchCount++;

            const mismatchDetail = `DB=${shipment.status}, on-chain=${onChain.status}`;
            this.logger.warn(`State drift detected: shipment ${shipment.id} — ${mismatchDetail}`);

            for (const admin of admins) {
              await this.notifications.notifyUser(
                admin.stellarAddress,
                NotificationType.SYSTEM_ALERT,
                'Contract state drift detected',
                `State drift on shipment ${shipment.id}: ${mismatchDetail}`,
                { shipmentId: shipment.id, dbStatus: shipment.status, onChainStatus: onChain.status },
              );
            }

            if (onChainStatus === ShipmentStatus.COMPLETED || onChainStatus === ShipmentStatus.CANCELLED) {
              await this.shipments.syncStatusFromChain(shipment.id);
              this.logger.log(`Auto-corrected shipment ${shipment.id} to ${onChainStatus}`);
            }
          }
        } catch (err: any) {
          const msg = `Failed to reconcile shipment ${shipment.id}: ${err.message}`;
          this.logger.error(msg);
          errors.push(msg);
        }
      }

      await this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: {
          completedAt: new Date(),
          checkedCount,
          mismatchCount,
          errors: errors.length > 0 ? errors : undefined,
        },
      });

      this.logger.log(
        `Reconciliation complete: checked=${checkedCount}, mismatches=${mismatchCount}, errors=${errors.length}`,
      );
    } catch (err: any) {
      this.logger.error(`Reconciliation job failed: ${err.message}`, err.stack);
      await this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: {
          completedAt: new Date(),
          checkedCount,
          mismatchCount,
          errors: [...errors, err.message],
        },
      });
    }
  };

  if (this.redis) {
    await runTrackedJob(this.redis, 'reconciliation', execute, this.logger);
  } else {
    await execute();
  }
}
}
