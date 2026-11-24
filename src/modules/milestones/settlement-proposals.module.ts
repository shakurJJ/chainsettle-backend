import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, UseGuards, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

class ProposalDto {
  @IsInt() @Min(0) @Max(100) supplierPercent!: number;
  @IsOptional() @IsString() message?: string;
}

@ApiTags('milestones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shipments/:shipmentId/milestones/:index/dispute/proposals')
class SettlementProposalsController {
  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService) {}

  private async context(shipmentId: string, index: string) {
    const milestone = await this.prisma.milestone.findUnique({ where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex: Number(index) } }, include: { shipment: true } });
    if (!milestone) throw new NotFoundException('Milestone not found');
    if (milestone.status !== 'DISPUTED') throw new ConflictException('Settlement proposals require an open dispute');
    return milestone;
  }

  @Post()
  async create(@Param('shipmentId') shipmentId: string, @Param('index') index: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: ProposalDto) {
    const m = await this.context(shipmentId, index); const address = user?.stellarAddress ?? user?.sub;
    if (![m.shipment.buyerAddress, m.shipment.supplierAddress].includes(address)) throw new ForbiddenException('Only buyer or supplier may propose settlement');
    if (await this.prisma.settlementProposal.findFirst({ where: { milestoneId: m.id, status: 'PENDING' } })) throw new ConflictException('A pending proposal already exists');
    return this.prisma.settlementProposal.create({ data: { milestoneId: m.id, proposedBy: address, supplierPercent: dto.supplierPercent, message: dto.message } });
  }

  @Get()
  async list(@Param('shipmentId') shipmentId: string, @Param('index') index: string, @CurrentUser() user: AuthenticatedUser) {
    const m = await this.context(shipmentId, index); const address = user?.stellarAddress ?? user?.sub;
    if (![m.shipment.buyerAddress, m.shipment.supplierAddress, m.shipment.arbiterAddress].includes(address)) throw new ForbiddenException();
    return this.prisma.settlementProposal.findMany({ where: { milestoneId: m.id }, orderBy: { createdAt: 'desc' } });
  }

  @Post(':id/:action')
  async respond(@Param('shipmentId') shipmentId: string, @Param('index') index: string, @Param('id') id: string, @Param('action') action: string, @CurrentUser() user: AuthenticatedUser) {
    if (!['accept', 'reject', 'withdraw'].includes(action)) throw new BadRequestException('Action must be accept, reject, or withdraw');
    const m = await this.context(shipmentId, index); const address = user?.stellarAddress ?? user?.sub;
    const proposal = await this.prisma.settlementProposal.findFirst({ where: { id, milestoneId: m.id, status: 'PENDING' } });
    if (!proposal) throw new NotFoundException('Pending proposal not found');
    const proposerIsBuyer = proposal.proposedBy === m.shipment.buyerAddress;
    const counterparty = proposerIsBuyer ? m.shipment.supplierAddress : m.shipment.buyerAddress;
    if (action === 'withdraw' ? address !== proposal.proposedBy : address !== counterparty) throw new ForbiddenException(action === 'withdraw' ? 'Only the proposer may withdraw' : 'Only the counterparty may respond');
    const status = action === 'accept' ? 'ACCEPTED' : action === 'reject' ? 'REJECTED' : 'WITHDRAWN';
    const result = await this.prisma.settlementProposal.updateMany({ where: { id, status: 'PENDING' }, data: { status, respondedAt: new Date() } });
    if (!result.count) throw new ConflictException('Proposal was already answered');
    if (action === 'accept') await this.notifications.notifyUser(m.shipment.arbiterAddress, 'SYSTEM_ALERT' as any, 'Settlement agreement reached', `The buyer and supplier agreed to a ${proposal.supplierPercent}% supplier / ${100 - proposal.supplierPercent}% buyer split for milestone ${m.milestoneIndex} on shipment ${shipmentId}.`, { shipmentId, milestoneIndex: m.milestoneIndex, supplierPercent: proposal.supplierPercent, message: proposal.message });
    return this.prisma.settlementProposal.findUnique({ where: { id } });
  }
}

@Module({ controllers: [SettlementProposalsController] })
export class SettlementProposalsModule {}
