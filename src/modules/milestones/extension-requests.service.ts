import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ExtensionRequestStatus, MilestoneStatus, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateExtensionRequestDto, DecideExtensionRequestDto } from './dto/extension-request.dto';

/** Milestone statuses after which a deadline no longer matters. */
const CLOSED_STATUSES: MilestoneStatus[] = [MilestoneStatus.CONFIRMED, MilestoneStatus.RESOLVED];

/**
 * Deadline extension requests (#393). Supplier/logistics propose a later
 * dueAt; the buyer approves (dueAt moves, overdue reminder flags reset) or
 * denies (dueAt unchanged). At most one PENDING request per milestone.
 */
@Injectable()
export class ExtensionRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(shipmentId: string, milestoneIndex: number) {
    const milestone = await this.findMilestone(shipmentId, milestoneIndex);
    return this.prisma.deadlineExtensionRequest.findMany({
      where: { milestoneId: milestone.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    shipmentId: string,
    milestoneIndex: number,
    dto: CreateExtensionRequestDto,
    callerAddress: string,
    callerId?: string,
  ) {
    const shipment = await this.findShipment(shipmentId);
    if (
      shipment.supplierAddress !== callerAddress &&
      shipment.logisticsAddress !== callerAddress
    ) {
      throw new ForbiddenException(
        'Only the shipment supplier or logistics provider may request a deadline extension',
      );
    }
    const milestone = await this.findMilestone(shipmentId, milestoneIndex);
    if (CLOSED_STATUSES.includes(milestone.status)) {
      throw new ConflictException(`Milestone ${milestoneIndex} is ${milestone.status}; its deadline can no longer change`);
    }

    const proposedDueAt = new Date(dto.proposedDueAt);
    if (proposedDueAt.getTime() <= Date.now()) {
      throw new BadRequestException('proposedDueAt must be in the future');
    }
    if (milestone.dueAt && proposedDueAt.getTime() <= milestone.dueAt.getTime()) {
      throw new BadRequestException('proposedDueAt must be later than the current dueAt');
    }

    const pending = await this.prisma.deadlineExtensionRequest.findFirst({
      where: { milestoneId: milestone.id, status: ExtensionRequestStatus.PENDING },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictException(`Milestone ${milestoneIndex} already has a pending extension request (${pending.id})`);
    }

    let request;
    try {
      request = await this.prisma.deadlineExtensionRequest.create({
        data: {
          milestoneId: milestone.id,
          requestedBy: callerAddress,
          proposedDueAt,
          previousDueAt: milestone.dueAt,
          reason: dto.reason.trim(),
        },
      });
    } catch (err) {
      // Partial unique index backs up the check above under concurrency.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Milestone ${milestoneIndex} already has a pending extension request`);
      }
      throw err;
    }

    await this.auditLog.record({
      actorId: callerId,
      actorAddress: callerAddress,
      action: 'milestone.extension.requested',
      resourceType: 'DeadlineExtensionRequest',
      resourceId: request.id,
      metadata: {
        shipmentId,
        milestoneIndex,
        previousDueAt: milestone.dueAt?.toISOString() ?? null,
        proposedDueAt: proposedDueAt.toISOString(),
      },
    });

    await this.notifications.notifyUser(
      shipment.buyerAddress,
      NotificationType.DEADLINE_EXTENSION_REQUESTED,
      'Deadline extension requested',
      `An extension to ${proposedDueAt.toISOString()} was requested for milestone ${milestoneIndex} ("${milestone.name}") on shipment ${shipmentId}: ${request.reason}`,
      { shipmentId, milestoneIndex, requestId: request.id, proposedDueAt: proposedDueAt.toISOString() },
    );

    return request;
  }

  approve(shipmentId: string, milestoneIndex: number, requestId: string, dto: DecideExtensionRequestDto, callerAddress: string, callerId?: string) {
    return this.decide(shipmentId, milestoneIndex, requestId, ExtensionRequestStatus.APPROVED, dto, callerAddress, callerId);
  }

  deny(shipmentId: string, milestoneIndex: number, requestId: string, dto: DecideExtensionRequestDto, callerAddress: string, callerId?: string) {
    return this.decide(shipmentId, milestoneIndex, requestId, ExtensionRequestStatus.DENIED, dto, callerAddress, callerId);
  }

  private async decide(
    shipmentId: string,
    milestoneIndex: number,
    requestId: string,
    decision: ExtensionRequestStatus,
    dto: DecideExtensionRequestDto,
    callerAddress: string,
    callerId?: string,
  ) {
    const shipment = await this.findShipment(shipmentId);
    if (shipment.buyerAddress !== callerAddress) {
      throw new ForbiddenException('Only the shipment buyer may decide extension requests');
    }
    const milestone = await this.findMilestone(shipmentId, milestoneIndex);
    const request = await this.prisma.deadlineExtensionRequest.findFirst({
      where: { id: requestId, milestoneId: milestone.id },
    });
    if (!request) throw new NotFoundException(`Extension request ${requestId} not found`);
    if (request.status !== ExtensionRequestStatus.PENDING) {
      throw new ConflictException(`Extension request ${requestId} is already ${request.status}`);
    }

    const decidedAt = new Date();
    const approved = decision === ExtensionRequestStatus.APPROVED;

    const [updated] = await this.prisma.$transaction([
      // Conditional on PENDING so two concurrent decisions cannot both win.
      this.prisma.deadlineExtensionRequest.updateMany({
        where: { id: request.id, status: ExtensionRequestStatus.PENDING },
        data: { status: decision, decidedAt, decidedBy: callerAddress },
      }),
      ...(approved
        ? [
            this.prisma.milestone.update({
              where: { id: milestone.id },
              data: {
                dueAt: request.proposedDueAt,
                overdueNotifiedAt: null,
                overdueReminder3dAt: null,
              },
            }),
          ]
        : []),
    ]);
    if (updated.count === 0) {
      throw new ConflictException(`Extension request ${requestId} was already decided`);
    }

    await this.auditLog.record({
      actorId: callerId,
      actorAddress: callerAddress,
      action: approved ? 'milestone.extension.approved' : 'milestone.extension.denied',
      resourceType: 'DeadlineExtensionRequest',
      resourceId: request.id,
      metadata: {
        shipmentId,
        milestoneIndex,
        previousDueAt: milestone.dueAt?.toISOString() ?? null,
        proposedDueAt: request.proposedDueAt.toISOString(),
        note: dto.note ?? null,
      },
    });

    await this.notifications.notifyUser(
      request.requestedBy,
      NotificationType.DEADLINE_EXTENSION_DECIDED,
      approved ? 'Deadline extension approved' : 'Deadline extension denied',
      `Your extension request for milestone ${milestoneIndex} ("${milestone.name}") on shipment ${shipmentId} was ${approved ? 'approved' : 'denied'}.` +
        (dto.note ? ` Note: ${dto.note}` : ''),
      { shipmentId, milestoneIndex, requestId: request.id, status: decision },
    );

    return { ...request, status: decision, decidedAt, decidedBy: callerAddress };
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
}
