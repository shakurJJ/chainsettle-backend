import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateShipmentReminderDto } from './dto/shipment-reminder.dto';

export const MAX_ACTIVE_REMINDERS = 20;

/**
 * Personal shipment reminders (#386). Every query is scoped to the caller's
 * userId so reminders stay private to their creator.
 */
@Injectable()
export class ShipmentRemindersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(shipmentId: string, userId: string, dto: CreateShipmentReminderDto) {
    const remindAt = new Date(dto.remindAt);
    if (Number.isNaN(remindAt.getTime()) || remindAt.getTime() <= Date.now()) {
      throw new BadRequestException('remindAt must be in the future');
    }

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { id: true },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);

    const active = await this.prisma.shipmentReminder.count({
      where: { shipmentId, userId, sentAt: null },
    });
    if (active >= MAX_ACTIVE_REMINDERS) {
      throw new BadRequestException(
        `At most ${MAX_ACTIVE_REMINDERS} active reminders are allowed per shipment`,
      );
    }

    return this.prisma.shipmentReminder.create({
      data: { shipmentId, userId, remindAt, message: dto.message.trim() },
    });
  }

  list(shipmentId: string, userId: string) {
    return this.prisma.shipmentReminder.findMany({
      where: { shipmentId, userId },
      orderBy: { remindAt: 'asc' },
    });
  }

  async remove(shipmentId: string, reminderId: string, userId: string) {
    const { count } = await this.prisma.shipmentReminder.deleteMany({
      where: { id: reminderId, shipmentId, userId },
    });
    if (count === 0) throw new NotFoundException(`Reminder ${reminderId} not found`);
  }
}
