import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent, Context } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ShipmentGql, MilestoneGql, ChainEventGql } from './shipment.type';
import { CommentGql } from './comment.type';
import { ShipmentsService } from '../shipments/shipments.service';
import { EventsService } from '../events/events.service';
import { CommentsService } from '../comments/comments.service';
import { ShipmentEventsPublisher } from '../events/shipment-events.publisher';
import { GqlJwtAuthGuard } from './gql-jwt-auth.guard';
import { GqlThrottlerGuard } from './gql-throttler.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { GqlLoaders } from './graphql.loaders';
import { assertParticipant } from './graphql.access';
import { toMilestoneGql } from './milestone.mapper';

@Resolver(() => ShipmentGql)
@UseGuards(GqlJwtAuthGuard)
export class ShipmentResolver {
  constructor(
    private readonly shipmentsService: ShipmentsService,
    private readonly events: EventsService,
    private readonly commentsService: CommentsService,
    private readonly eventsPublisher: ShipmentEventsPublisher,
  ) {}

  @Query(() => ShipmentGql, { description: 'Fetch a shipment with its milestones and recent events' })
  async shipment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ShipmentGql> {
    const s = await this.shipmentsService.findOne(id, user?.id);
    assertParticipant(s as any, user);
    return this.toGql(s);
  }

  @Query(() => [ShipmentGql], { description: 'List shipments visible to the authenticated user' })
  async shipments(
    @CurrentUser() user: AuthenticatedUser,
    @Args('status', { nullable: true }) status?: string,
    @Args('page', { nullable: true, type: () => Number }) page?: number,
    @Args('limit', { nullable: true, type: () => Number }) limit?: number,
  ): Promise<ShipmentGql[]> {
    const result = await this.shipmentsService.findAll({
      callerStellarAddress: user.stellarAddress,
      callerUserId: user.id,
      status: status as any,
      page,
      limit,
    });
    return result.data.map((s: any) => this.toGql(s));
  }

  @ResolveField(() => [MilestoneGql])
  async milestones(
    @Parent() shipment: ShipmentGql,
    @Context('loaders') loaders: GqlLoaders,
  ): Promise<MilestoneGql[]> {
    // Batched through DataLoader so listing shipments doesn't fan out into
    // one milestone query per shipment (#430).
    const rows = await loaders.milestonesByShipment.load(shipment.id);
    return rows.map(toMilestoneGql);
  }

  @ResolveField(() => [ChainEventGql])
  async recentEvents(@Parent() shipment: ShipmentGql): Promise<ChainEventGql[]> {
    if (shipment.recentEvents?.length) return shipment.recentEvents;
    const result = await this.events.findAll({ shipmentId: shipment.id, limit: 10 });
    return result.data;
  }

  @Mutation(() => CommentGql, { description: 'Add a comment to a shipment' })
  @UseGuards(GqlThrottlerGuard)
  async addComment(
    @Args('shipmentId', { type: () => ID }) shipmentId: string,
    @Args('body') body: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CommentGql> {
    const shipment = await this.shipmentsService.findOne(shipmentId, user?.id);
    assertParticipant(shipment as any, user);
    const comment = await this.commentsService.create(
      { shipmentId, body },
      { id: user.id, stellarAddress: user.stellarAddress } as any,
    );
    this.eventsPublisher.publishCommentCreated(shipmentId, comment);
    return comment as any;
  }

  @Mutation(() => CommentGql, { description: 'Edit an existing shipment comment' })
  @UseGuards(GqlThrottlerGuard)
  async editComment(
    @Args('id', { type: () => ID }) id: string,
    @Args('body') body: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CommentGql> {
    const existing = await this.commentsService.findOne(id);
    const shipment = await this.shipmentsService.findOne(existing.shipmentId, user?.id);
    assertParticipant(shipment as any, user);
    const comment = await this.commentsService.update(
      id,
      { body },
      { id: user.id, stellarAddress: user.stellarAddress } as any,
    );
    return comment as any;
  }

  @Mutation(() => Boolean, { description: 'Delete a shipment comment' })
  @UseGuards(GqlThrottlerGuard)
  async deleteComment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<boolean> {
    const existing = await this.commentsService.findOne(id);
    const shipment = await this.shipmentsService.findOne(existing.shipmentId, user?.id);
    assertParticipant(shipment as any, user);
    await this.commentsService.remove(id, {
      id: user.id,
      stellarAddress: user.stellarAddress,
    } as any);
    return true;
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
      expectedDeliveryAt: s.expectedDeliveryAt ?? undefined,
      createdAt: s.createdAt,
      milestones: [],
      recentEvents: s.events ?? [],
    };
  }
}
