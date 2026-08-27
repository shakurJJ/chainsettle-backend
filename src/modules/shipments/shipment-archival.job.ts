import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma, ShipmentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

const ARCHIVAL_LOCK_KEY = 'chainsettle:shipment-archival:lock';
const ARCHIVAL_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BATCH_SIZE = 50;

/**
 * Moves COMPLETED/CANCELLED shipments older than SHIPMENT_ARCHIVAL_DAYS out of
 * the hot `shipments` table into `archived_shipments` (cold storage), retaining
 * a full JSON snapshot of milestones, events, comments, tracking, and notes.
 */
@Injectable()
export class ShipmentArchivalJob {
  private readonly logger = new Logger(ShipmentArchivalJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  @Cron('0 3 * * *') // override via SHIPMENT_ARCHIVAL_CRON is documented; Nest binds at boot from env if set before import
  async runArchival() {
    const token = randomUUID();
    const acquired = await this.redis.acquireLock(
      ARCHIVAL_LOCK_KEY,
      token,
      ARCHIVAL_LOCK_TTL_MS,
    );
    if (!acquired) {
      this.logger.debug('Skipping archival — another instance holds the lock');
      return;
    }

    try {
      const days = this.config.get<number>('SHIPMENT_ARCHIVAL_DAYS', 90);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      this.logger.log(
        `Starting shipment cold-storage archival (cutoff=${cutoff.toISOString()}, days=${days})`,
      );

      let archivedCount = 0;
      let hasMore = true;

      while (hasMore) {
        const candidates = await this.prisma.shipment.findMany({
          where: {
            status: { in: [ShipmentStatus.COMPLETED, ShipmentStatus.CANCELLED] },
            updatedAt: { lte: cutoff },
          },
          take: BATCH_SIZE,
          orderBy: { updatedAt: 'asc' },
          include: {
            milestones: {
              orderBy: { milestoneIndex: 'asc' },
              include: {
                disputeEvidence: true,
                proofSubmissions: true,
              },
            },
            events: { orderBy: { ledger: 'asc' } },
            comments: true,
            shipmentNotes: true,
            trackingUpdates: { orderBy: { createdAt: 'asc' } },
            watchers: true,
          },
        });

        if (candidates.length === 0) {
          hasMore = false;
          break;
        }

        for (const shipment of candidates) {
          const terminalAt =
            shipment.cancelledAt ??
            shipment.milestones
              .map((m) => m.confirmedAt)
              .filter((d): d is Date => !!d)
              .sort((a, b) => b.getTime() - a.getTime())[0] ??
            shipment.updatedAt;

          // Skip if still within the retention window for COMPLETED without cancelledAt
          if (terminalAt > cutoff) {
            continue;
          }

          const payload = JSON.parse(
            JSON.stringify(shipment, (_key, value) =>
              typeof value === 'bigint' ? value.toString() : value,
            ),
          ) as Prisma.InputJsonValue;

          await this.prisma.$transaction(async (tx) => {
            await tx.archivedShipment.upsert({
              where: { id: shipment.id },
              create: {
                id: shipment.id,
                status: shipment.status,
                buyerAddress: shipment.buyerAddress,
                supplierAddress: shipment.supplierAddress,
                logisticsAddress: shipment.logisticsAddress,
                arbiterAddress: shipment.arbiterAddress,
                referenceNumber: shipment.referenceNumber,
                terminalAt,
                payload,
              },
              update: {
                status: shipment.status,
                terminalAt,
                payload,
                archivedAt: new Date(),
              },
            });

            // Detach chain_events so the global audit trail remains queryable
            await tx.chainEvent.updateMany({
              where: { shipmentId: shipment.id },
              data: { shipmentId: null },
            });

            // Milestones (and cascaded evidence/proofs) are fully captured in payload
            await tx.milestone.deleteMany({ where: { shipmentId: shipment.id } });

            // Cascades remove comments, notes, tracking, watchers
            await tx.shipment.delete({ where: { id: shipment.id } });
          });

          archivedCount++;
          this.logger.debug(`Cold-archived shipment ${shipment.id}`);
        }

        if (candidates.length < BATCH_SIZE) {
          hasMore = false;
        }
      }

      this.logger.log(`Shipment archival complete — moved ${archivedCount} shipment(s)`);
    } catch (err: any) {
      this.logger.error(`Shipment archival failed: ${err.message}`, err.stack);
    } finally {
      await this.redis.releaseLock(ARCHIVAL_LOCK_KEY, token);
    }
  }
}
