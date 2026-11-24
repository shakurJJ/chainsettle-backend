import { Args, Context, ID, Resolver, Subscription } from '@nestjs/graphql';
import { ForbiddenException, Inject, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PubSubEngine } from 'graphql-subscriptions';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MilestoneGql, ShipmentGql } from './shipment.type';
import { GQL_PUBSUB } from './gql-pubsub.module';
import { isParticipant } from './graphql.access';
import { MILESTONE_UPDATED, SHIPMENT_UPDATED } from './shipment-events.publisher';

/** Live shipment/milestone updates over graphql-ws (#431). */
@Resolver()
export class ShipmentSubscriptionResolver {
  constructor(
    @Inject(GQL_PUBSUB) private readonly pubSub: PubSubEngine,
    private readonly prisma: PrismaService,
  ) {}

  @Subscription(() => ShipmentGql, {
    filter: (payload, variables) => payload[SHIPMENT_UPDATED].id === variables.id,
  })
  async shipmentUpdated(@Args('id', { type: () => ID }) id: string, @Context('req') req: any) {
    await this.assertCanSubscribe(id, req?.user);
    return this.pubSub.asyncIterator(SHIPMENT_UPDATED);
  }

  @Subscription(() => MilestoneGql, {
    filter: (payload, variables) => payload[MILESTONE_UPDATED].shipmentId === variables.shipmentId,
  })
  async milestoneUpdated(@Args('shipmentId', { type: () => ID }) shipmentId: string, @Context('req') req: any) {
    await this.assertCanSubscribe(shipmentId, req?.user);
    return this.pubSub.asyncIterator(MILESTONE_UPDATED);
  }

  private async assertCanSubscribe(shipmentId: string, user: any): Promise<void> {
    if (!user) throw new UnauthorizedException('Authentication required');
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { buyerAddress: true, supplierAddress: true, logisticsAddress: true, arbiterAddress: true },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);
    if (!isParticipant(shipment, user)) throw new ForbiddenException('Not a participant on this shipment');
  }
}
