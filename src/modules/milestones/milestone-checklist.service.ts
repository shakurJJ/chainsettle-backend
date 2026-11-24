import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { MilestoneStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { CreateChecklistItemDto, UpdateChecklistItemDto } from './dto/checklist.dto';

/**
 * Milestone checklists (#392) — the proof items parties agree are expected
 * for a milestone. The buyer defines items while the milestone is PENDING;
 * supplier/logistics tick them off; every participant can read progress.
 */
@Injectable()
export class MilestoneChecklistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(shipmentId: string, milestoneIndex: number) {
    const milestone = await this.findMilestone(shipmentId, milestoneIndex);
    const items = await this.prisma.milestoneChecklistItem.findMany({
      where: { milestoneId: milestone.id },
      orderBy: { createdAt: 'asc' },
    });
    return { items, progress: summarize(items) };
  }

  async create(
    shipmentId: string,
    milestoneIndex: number,
    dto: CreateChecklistItemDto,
    callerAddress: string,
    callerId?: string,
  ) {
    const shipment = await this.findShipment(shipmentId);
    if (shipment.buyerAddress !== callerAddress) {
      throw new ForbiddenException('Only the shipment buyer may define checklist items');
    }
    const milestone = await this.findMilestone(shipmentId, milestoneIndex);
    this.assertPending(milestone);

    const item = await this.prisma.milestoneChecklistItem.create({
      data: {
        milestoneId: milestone.id,
        label: dto.label.trim(),
        required: dto.required ?? true,
      },
    });

    await this.auditLog.record({
      actorId: callerId,
      actorAddress: callerAddress,
      action: 'milestone.checklist.item_added',
      resourceType: 'MilestoneChecklistItem',
      resourceId: item.id,
      metadata: { shipmentId, milestoneIndex, label: item.label, required: item.required },
    });
    return item;
  }

  async update(
    shipmentId: string,
    milestoneIndex: number,
    itemId: string,
    dto: UpdateChecklistItemDto,
    callerAddress: string,
    callerId?: string,
  ) {
    const shipment = await this.findShipment(shipmentId);
    if (
      shipment.supplierAddress !== callerAddress &&
      shipment.logisticsAddress !== callerAddress
    ) {
      throw new ForbiddenException(
        'Only the shipment supplier or logistics provider may complete checklist items',
      );
    }
    const milestone = await this.findMilestone(shipmentId, milestoneIndex);
    const item = await this.findItem(milestone.id, itemId);

    const updated = await this.prisma.milestoneChecklistItem.update({
      where: { id: item.id },
      data: dto.completed
        ? { completedAt: new Date(), completedBy: callerAddress }
        : { completedAt: null, completedBy: null },
    });

    await this.auditLog.record({
      actorId: callerId,
      actorAddress: callerAddress,
      action: dto.completed ? 'milestone.checklist.item_completed' : 'milestone.checklist.item_reopened',
      resourceType: 'MilestoneChecklistItem',
      resourceId: item.id,
      metadata: { shipmentId, milestoneIndex },
    });
    return updated;
  }

  async remove(
    shipmentId: string,
    milestoneIndex: number,
    itemId: string,
    callerAddress: string,
    callerId?: string,
  ) {
    const shipment = await this.findShipment(shipmentId);
    if (shipment.buyerAddress !== callerAddress) {
      throw new ForbiddenException('Only the shipment buyer may remove checklist items');
    }
    const milestone = await this.findMilestone(shipmentId, milestoneIndex);
    this.assertPending(milestone);
    const item = await this.findItem(milestone.id, itemId);

    await this.prisma.milestoneChecklistItem.delete({ where: { id: item.id } });

    await this.auditLog.record({
      actorId: callerId,
      actorAddress: callerAddress,
      action: 'milestone.checklist.item_removed',
      resourceType: 'MilestoneChecklistItem',
      resourceId: item.id,
      metadata: { shipmentId, milestoneIndex, label: item.label },
    });
    return { removed: true, id: item.id };
  }

  /**
   * Labels of required items not yet completed. Used to warn (not block)
   * when proof is submitted with an incomplete checklist.
   */
  async incompleteRequired(milestoneId: string): Promise<string[]> {
    const items = await this.prisma.milestoneChecklistItem.findMany({
      where: { milestoneId, required: true, completedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { label: true },
    });
    return items.map((i) => i.label);
  }

  private async findShipment(shipmentId: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { id: true, buyerAddress: true, supplierAddress: true, logisticsAddress: true },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);
    return shipment;
  }

  private async findMilestone(shipmentId: string, milestoneIndex: number) {
    const milestone = await this.prisma.milestone.findFirst({
      where: { shipmentId, milestoneIndex, deletedAt: null },
    });
    if (!milestone) {
      throw new NotFoundException(`Milestone ${milestoneIndex} not found on shipment ${shipmentId}`);
    }
    return milestone;
  }

  private async findItem(milestoneId: string, itemId: string) {
    const item = await this.prisma.milestoneChecklistItem.findFirst({
      where: { id: itemId, milestoneId },
    });
    if (!item) throw new NotFoundException(`Checklist item ${itemId} not found`);
    return item;
  }

  private assertPending(milestone: { milestoneIndex: number; status: MilestoneStatus }) {
    if (milestone.status !== MilestoneStatus.PENDING) {
      throw new ConflictException(
        `Checklist for milestone ${milestone.milestoneIndex} can only be changed while PENDING (status is ${milestone.status})`,
      );
    }
  }
}

function summarize(items: { required: boolean; completedAt: Date | null }[]) {
  const required = items.filter((i) => i.required);
  return {
    total: items.length,
    completed: items.filter((i) => i.completedAt).length,
    requiredTotal: required.length,
    requiredCompleted: required.filter((i) => i.completedAt).length,
  };
}
