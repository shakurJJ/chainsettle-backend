import { Resolver, Query, Args, ID, ResolveField, Parent, Context } from '@nestjs/graphql';
import { NotFoundException, UseGuards } from '@nestjs/common';
import { MilestoneGql, ProofSubmissionGql } from './shipment.type';
import { GqlJwtAuthGuard } from './gql-jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GqlLoaders } from './graphql.loaders';
import { assertParticipant } from './graphql.access';
import { toMilestoneGql } from './milestone.mapper';

const PARTICIPANT_SELECT = {
  buyerAddress: true,
  supplierAddress: true,
  logisticsAddress: true,
  arbiterAddress: true,
} as const;

/** Milestone queries and proof history for GraphQL clients (#430). */
@Resolver(() => MilestoneGql)
@UseGuards(GqlJwtAuthGuard)
export class MilestoneResolver {
  constructor(private readonly prisma: PrismaService) {}

  @Query(() => [MilestoneGql], { description: 'Milestones of a shipment the caller participates in' })
  async milestones(
    @Args('shipmentId', { type: () => ID }) shipmentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Context('loaders') loaders: GqlLoaders,
  ): Promise<MilestoneGql[]> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId }, select: PARTICIPANT_SELECT });
    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);
    assertParticipant(shipment, user);
    const rows = await loaders.milestonesByShipment.load(shipmentId);
    return rows.map(toMilestoneGql);
  }

  @Query(() => MilestoneGql, { description: 'A single milestone by id' })
  async milestone(@Args('id', { type: () => ID }) id: string, @CurrentUser() user: AuthenticatedUser): Promise<MilestoneGql> {
    const milestone = await this.prisma.milestone.findFirst({
      where: { id, deletedAt: null },
      include: { shipment: { select: PARTICIPANT_SELECT } },
    });
    if (!milestone) throw new NotFoundException(`Milestone ${id} not found`);
    assertParticipant(milestone.shipment, user);
    return toMilestoneGql(milestone);
  }

  @ResolveField(() => [ProofSubmissionGql])
  async proofSubmissions(
    @Parent() milestone: MilestoneGql,
    @Context('loaders') loaders: GqlLoaders,
  ): Promise<ProofSubmissionGql[]> {
    return loaders.proofsByMilestone.load(milestone.id);
  }
}
