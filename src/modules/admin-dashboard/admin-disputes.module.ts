import { BadRequestException, Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole, MilestoneStatus } from '@prisma/client';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/disputes')
class AdminDisputesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] List open disputes across the platform' })
  async list(@Query('arbiterAddress') arbiterAddress?: string, @Query('minAgeHours') minAgeHours?: string, @Query('escalated') escalated?: string) {
    const hours = minAgeHours === undefined ? undefined : Number(minAgeHours);
    if (hours !== undefined && (!Number.isFinite(hours) || hours < 0)) throw new BadRequestException('minAgeHours must be a non-negative number');
    const since = hours === undefined ? undefined : new Date(Date.now() - hours * 3600000);
    const rows = await this.prisma.milestone.findMany({
      where: { status: MilestoneStatus.DISPUTED, deletedAt: null, ...(since ? { OR: [{ disputedAt: { lte: since } }, { disputedAt: null, createdAt: { lte: since } }] } : {}), ...(escalated === 'true' ? { disputeEscalatedAt: { not: null } } : escalated === 'false' ? { disputeEscalatedAt: null } : {}), ...(arbiterAddress ? { shipment: { arbiterAddress } } : {}) },
      include: { shipment: { select: { arbiterAddress: true } }, _count: { select: { disputeEvidence: true } } },
    });
    const now = Date.now();
    return rows.map(m => ({ shipmentId: m.shipmentId, milestoneIndex: m.milestoneIndex, milestone: m.name, arbiterAddress: m.shipment.arbiterAddress, ageHours: Math.max(0, (now - (m.disputedAt ?? m.createdAt).getTime()) / 3600000), evidenceCount: m._count.disputeEvidence, escalated: m.disputeEscalatedAt !== null })).sort((a, b) => b.ageHours - a.ageHours);
  }
}

@Module({ controllers: [AdminDisputesController] })
export class AdminDisputesModule {}
