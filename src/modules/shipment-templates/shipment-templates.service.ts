import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import {
  CreateShipmentTemplateDto,
  UpdateShipmentTemplateDto,
  UpdateTemplateVisibilityDto,
} from './dto/create-shipment-template.dto';
import { CreateTemplateFromShipmentDto } from './dto/create-template-from-shipment.dto';

@Injectable()
export class ShipmentTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(dto: CreateShipmentTemplateDto, ownerId: string) {
    this.validateMilestonePercentages(dto.milestoneTemplates);

    return this.prisma.shipmentTemplate.create({
      data: {
        ownerId,
        name: dto.name,
        description: dto.description,
        supplierAddress: dto.supplierAddress,
        logisticsAddress: dto.logisticsAddress,
        arbiterAddress: dto.arbiterAddress,
        tokenAddress: dto.tokenAddress,
        milestoneTemplates: dto.milestoneTemplates as any,
        isPublic: dto.isPublic ?? false,
      },
    });
  }

  async findAll(
    ownerId: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const skip = (page - 1) * limit;

    const [templates, total] = await Promise.all([
      this.prisma.shipmentTemplate.findMany({
        where: {
          OR: [
            { ownerId },
            { isPublic: true },
          ],
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.shipmentTemplate.count({
        where: {
          OR: [
            { ownerId },
            { isPublic: true },
          ],
        },
      }),
    ]);

    return {
      data: templates,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async findMine(
    ownerId: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const skip = (page - 1) * limit;

    const [templates, total] = await Promise.all([
      this.prisma.shipmentTemplate.findMany({
        where: { ownerId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.shipmentTemplate.count({ where: { ownerId } }),
    ]);

    return {
      data: templates,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Derives a new template from an existing shipment's structure.
   * Restricted to the shipment's buyer (ShipmentParticipantGuard only
   * confirms participancy, so the buyer check happens here).
   */
  async createFromShipment(
    ownerId: string,
    callerAddress: string,
    shipmentId: string,
    dto: CreateTemplateFromShipmentDto,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    if (shipment.buyerAddress !== callerAddress) {
      throw new ForbiddenException('Only the shipment buyer can create a template from it');
    }

    const msPerDay = 24 * 60 * 60 * 1000;
    const milestoneTemplates = shipment.milestones.map((m) => ({
      name: m.name,
      paymentPercent: m.paymentPercent,
      ...(m.dueAt
        ? { dueDays: Math.round((m.dueAt.getTime() - shipment.createdAt.getTime()) / msPerDay) }
        : {}),
    }));

    this.validateMilestonePercentages(milestoneTemplates);

    return this.prisma.shipmentTemplate.create({
      data: {
        ownerId,
        name: dto.name,
        description: dto.description,
        supplierAddress: shipment.supplierAddress,
        logisticsAddress: shipment.logisticsAddress,
        arbiterAddress: shipment.arbiterAddress,
        tokenAddress: shipment.tokenAddress,
        milestoneTemplates: milestoneTemplates as any,
        isPublic: dto.isPublic ?? false,
      },
    });
  }

  async findOne(id: string) {
    const template = await this.prisma.shipmentTemplate.findUnique({
      where: { id },
    });

    if (!template) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    return template;
  }

  async preview(id: string, userId: string) {
    const template = await this.findOne(id);

    if (!template.isPublic && template.ownerId !== userId) {
      throw new ForbiddenException('Only the template owner can preview a private template');
    }

    const milestoneTemplates = (template.milestoneTemplates as any[]) ?? [];
    const milestones = milestoneTemplates.map((m) => ({
      name: m.name,
      paymentPercent: m.paymentPercent,
      dueDays: m.dueDays ?? null,
      dueDescription:
        m.dueDays != null ? `${m.dueDays} day${m.dueDays === 1 ? '' : 's'} after creation` : 'No due date set',
    }));

    const percentSum = milestones.reduce((sum, m) => sum + m.paymentPercent, 0);

    const missingFields = (['supplierAddress', 'logisticsAddress', 'arbiterAddress', 'tokenAddress'] as const).filter(
      (field) => !template[field],
    );

    return {
      milestones,
      percentSum,
      isValid: percentSum === 100,
      missingFields,
    };
  }

  async update(
    id: string,
    ownerId: string,
    dto: UpdateShipmentTemplateDto,
  ) {
    const template = await this.findOne(id);

    if (template.ownerId !== ownerId) {
      throw new ForbiddenException('Only the template owner can update it');
    }

    if (dto.milestoneTemplates) {
      this.validateMilestonePercentages(dto.milestoneTemplates);
    }

    return this.prisma.shipmentTemplate.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        supplierAddress: dto.supplierAddress,
        logisticsAddress: dto.logisticsAddress,
        arbiterAddress: dto.arbiterAddress,
        tokenAddress: dto.tokenAddress,
        milestoneTemplates: dto.milestoneTemplates as any,
        isPublic: dto.isPublic,
      },
    });
  }

  async updateVisibility(
    id: string,
    ownerId: string,
    actorAddress: string,
    dto: UpdateTemplateVisibilityDto,
  ) {
    const template = await this.findOne(id);

    if (template.ownerId !== ownerId) {
      throw new ForbiddenException('Only the template owner can change its visibility');
    }

    const updated = await this.prisma.shipmentTemplate.update({
      where: { id },
      data: { isPublic: dto.isPublic },
    });

    await this.auditLog.record({
      actorId: ownerId,
      actorAddress: actorAddress ?? 'unknown',
      action: 'SHIPMENT_TEMPLATE_VISIBILITY_CHANGED',
      resourceType: 'ShipmentTemplate',
      resourceId: id,
      metadata: { isPublic: dto.isPublic },
    });

    return updated;
  }

  async delete(id: string, ownerId: string) {
    const template = await this.findOne(id);

    if (template.ownerId !== ownerId) {
      throw new ForbiddenException('Only the template owner can delete it');
    }

    await this.prisma.shipmentTemplate.delete({
      where: { id },
    });

    return { success: true };
  }

  private validateMilestonePercentages(milestones: any[]) {
    const total = milestones.reduce((sum, m) => sum + m.paymentPercent, 0);
    if (total !== 100) {
      throw new BadRequestException(
        `Milestone percentages must sum to 100, got ${total}`,
      );
    }
  }
}
