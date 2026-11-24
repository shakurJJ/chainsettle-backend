import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RecurringInterval } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateRecurringScheduleDto, UpdateRecurringScheduleDto } from './dto/recurring-schedule.dto';

/** Advances a run time by one interval. MONTHLY clamps to the month's last day. */
export function advance(from: Date, interval: RecurringInterval): Date {
  const next = new Date(from.getTime());
  if (interval === RecurringInterval.WEEKLY) {
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

@Injectable()
export class RecurringSchedulesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, dto: CreateRecurringScheduleDto) {
    await this.assertUsableTemplate(dto.templateId, ownerId);
    const nextRunAt = dto.startAt ? new Date(dto.startAt) : advance(new Date(), dto.interval);
    if (nextRunAt.getTime() <= Date.now()) {
      throw new BadRequestException('startAt must be in the future');
    }
    const schedule = await this.prisma.recurringSchedule.create({
      data: {
        ownerId,
        templateId: dto.templateId,
        interval: dto.interval,
        totalAmount: BigInt(dto.totalAmount),
        nextRunAt,
      },
    });
    return this.serialize(schedule);
  }

  async findMine(ownerId: string) {
    const rows = await this.prisma.recurringSchedule.findMany({
      where: { ownerId },
      orderBy: { nextRunAt: 'asc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  async update(id: string, ownerId: string, dto: UpdateRecurringScheduleDto) {
    await this.findOwned(id, ownerId);
    const data: any = {};
    if (dto.interval !== undefined) data.interval = dto.interval;
    if (dto.totalAmount !== undefined) data.totalAmount = BigInt(dto.totalAmount);
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.nextRunAt !== undefined) {
      const nextRunAt = new Date(dto.nextRunAt);
      if (nextRunAt.getTime() <= Date.now()) {
        throw new BadRequestException('nextRunAt must be in the future');
      }
      data.nextRunAt = nextRunAt;
    }
    const updated = await this.prisma.recurringSchedule.update({ where: { id }, data });
    return this.serialize(updated);
  }

  async remove(id: string, ownerId: string) {
    await this.findOwned(id, ownerId);
    await this.prisma.recurringSchedule.delete({ where: { id } });
  }

  private async findOwned(id: string, ownerId: string) {
    const schedule = await this.prisma.recurringSchedule.findUnique({ where: { id } });
    if (!schedule || schedule.ownerId !== ownerId) {
      throw new NotFoundException(`Recurring schedule ${id} not found`);
    }
    return schedule;
  }

  /**
   * The template must be the owner's or public, not deleted, and carry every
   * participant address a draft shipment needs.
   */
  private async assertUsableTemplate(templateId: string, ownerId: string) {
    const template = await this.prisma.shipmentTemplate.findFirst({
      where: { id: templateId, deletedAt: null },
    });
    if (!template) throw new NotFoundException(`Template ${templateId} not found`);
    if (template.ownerId !== ownerId && !template.isPublic) {
      throw new ForbiddenException('Template is not visible to you');
    }
    const missing = ['supplierAddress', 'logisticsAddress', 'arbiterAddress', 'tokenAddress'].filter(
      (k) => !(template as any)[k],
    );
    if (missing.length > 0) {
      throw new BadRequestException(`Template is missing required fields: ${missing.join(', ')}`);
    }
    return template;
  }

  private serialize(s: any) {
    return { ...s, totalAmount: s.totalAmount.toString() };
  }
}
