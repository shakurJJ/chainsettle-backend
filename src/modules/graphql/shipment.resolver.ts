import { Resolver, Query, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ShipmentGql, MilestoneGql, ChainEventGql } from './shipment.type';
import { ShipmentsService } from '../shipments/shipments.service';
import { MilestonesService } from '../milestones/milestones.service';
import { EventsService } from '../events/events.service';
import { GqlJwtAuthGuard } from './gql-jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Resolver(() => ShipmentGql)
@UseGuards(GqlJwtAuthGuard)
export class ShipmentResolver {
  constructor(
    private readonly shipments: ShipmentsService,
    private readonly milestones: MilestonesService,
    private readonly events: EventsService,
  ) {}

  @Query(() => ShipmentGql, { description: 'Fetch a shipment with its milestones and recent events' })
  async shipment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<ShipmentGql> {
    const s = await this.shipments.findOne(id, userId);
    return this.toGql(s);
  }

  @Query(() => [ShipmentGql], { description: 'List shipments visible to the authenticated user' })
  async shipments(
    @CurrentUser() user: any,
    @Args('status', { nullable: true }) status?: string,
    @Args('page', { nullable: true, type: () => Number }) page?: number,
    @Args('limit', { nullable: true, type: () => Number }) limit?: number,
  ): Promise<ShipmentGql[]> {
    const result = await this.shipments.findAll({
      callerStellarAddress: user.stellarAddress,
      callerUserId: user.id,
      status: status as any,
      page,
      limit,
    });
    return result.data.map((s: any) => this.toGql(s));
  }

  @ResolveField(() => [MilestoneGql])
  async milestones(@Parent() shipment: ShipmentGql): Promise<MilestoneGql[]> {
    if (shipment.milestones?.length) return shipment.milestones;
    return this.milestones.findByShipment(shipment.id);
  }

  @ResolveField(() => [ChainEventGql])
  async recentEvents(@Parent() shipment: ShipmentGql): Promise<ChainEventGql[]> {
    if (shipment.recentEvents?.length) return shipment.recentEvents;
    const result = await this.events.findAll({ shipmentId: shipment.id, limit: 10 });
    return result.data;
  }

  private toGql(s: any): ShipmentGql {
    return {
      id: s.id,
      buyerAddress: s.buyerAddress,
      supplierAddress: s.supplierAddress,
      logisticsAddress: s.logisticsAddress,
      arbiterAddress: s.arbiterAddress,
      status: s.status,
      totalAmount: s.totalAmount?.toString() ?? '0',
      releasedAmount: s.releasedAmount?.toString() ?? '0',
      description: s.description ?? undefined,
      referenceNumber: s.referenceNumber ?? undefined,
      createdAt: s.createdAt,
      milestones: s.milestones ?? [],
      recentEvents: s.events ?? [],
    };
  }
}
