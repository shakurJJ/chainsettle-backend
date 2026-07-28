import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateShipmentTemplateDto, UpdateShipmentTemplateDto } from './dto/create-shipment-template.dto';

@Injectable()
export class ShipmentTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

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
