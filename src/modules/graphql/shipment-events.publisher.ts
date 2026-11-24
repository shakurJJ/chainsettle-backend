import { Inject, Injectable, Logger } from '@nestjs/common';
import { PubSubEngine } from 'graphql-subscriptions';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toMilestoneGql } from './milestone.mapper';

export const SHIPMENT_UPDATED = 'shipmentUpdated';
export const MILESTONE_UPDATED = 'milestoneUpdated';

/**
 * Publishes shipment/milestone changes to GraphQL subscribers. Called from
 * the same place chain events are processed (#431).
 */
@Injectable()
export class ShipmentEventsPublisher {
  private readonly logger = new Logger(ShipmentEventsPublisher.name);

  constructor(
    @Inject('GQL_PUBSUB') private readonly pubSub: PubSubEngine,
    private readonly prisma: PrismaService,
  ) {}

  async publishShipment(shipmentId: string, milestoneIndex?: number): Promise<void> {
    try {
      const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
      if (!shipment) return;

      await this.pubSub.publish(SHIPMENT_UPDATED, {
        [SHIPMENT_UPDATED]: {
          id: shipment.id,
          buyerAddress: shipment.buyerAddress,
          supplierAddress: shipment.supplierAddress,
          logisticsAddress: shipment.logisticsAddress,
          arbiterAddress: shipment.arbiterAddress,
          status: shipment.status,
          totalAmount: shipment.totalAmount?.toString() ?? '0',
          releasedAmount: shipment.releasedAmount?.toString() ?? '0',
          description: shipment.description ?? undefined,
          referenceNumber: shipment.referenceNumber ?? undefined,
          expectedDeliveryAt: shipment.expectedDeliveryAt ?? undefined,
          createdAt: shipment.createdAt,
          milestones: [],
          recentEvents: [],
        },
      });

      if (milestoneIndex === undefined || Number.isNaN(milestoneIndex)) return;
      const milestone = await this.prisma.milestone.findUnique({
        where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
      });
      if (milestone) {
        await this.pubSub.publish(MILESTONE_UPDATED, { [MILESTONE_UPDATED]: toMilestoneGql(milestone) });
      }
    } catch (err) {
      this.logger.error(`Failed to publish GraphQL update for shipment ${shipmentId}`, (err as Error).message);
    }
  }
}
