import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface RecordAuditLogDto {
  actorId?: string;
  actorAddress: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
}

/**
 * AuditLogService
 *
 * Records all API mutations (POST, PATCH, DELETE) for regulatory compliance
 * and operational auditing. Audit logs are insert-only and tamper-evident.
 *
 * Every entry must include:
 *   - actor (user ID and Stellar address)
 *   - action (e.g. 'shipment.sync', 'milestone.proof_submitted')
 *   - resource type and ID
 *   - timestamp (auto-generated)
 *   - optional metadata (what changed, context, etc.)
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record an audit log entry for an API action.
   * This is insert-only — no updates or deletes allowed.
   */
  async record(dto: RecordAuditLogDto): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: dto.actorId ?? '',
          action: dto.action,
          entityType: dto.resourceType,
          entityId: dto.resourceId,
          metadata: dto.metadata ?? {},
          ipAddress: dto.ipAddress,
        } as any,
      });

      this.logger.debug(
        `Audit log recorded: ${dto.action} on ${dto.resourceType}/${dto.resourceId} by ${dto.actorAddress}`,
      );
    } catch (error) {
      this.logger.error(`Failed to record audit log: ${dto.action}`, error.message);
      // Don't throw — audit logging failures shouldn't break the business logic
    }
  }

  /**
   * Retrieve paginated audit logs with optional filters.
   * Restricted to admins only (enforced by controller).
   */
  async findAll(filters: {
    actorAddress?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const {
      actorAddress,
      action,
      resourceType,
      resourceId,
      startDate,
      endDate,
      page = 1,
      limit = 50,
    } = filters;

    const where: any = {};

    if (actorAddress) where.userId = actorAddress;
    if (action) where.action = { contains: action, mode: 'insensitive' };
    if (resourceType) where.entityType = resourceType;
    if (resourceId) where.entityId = resourceId;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const [logs, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              stellarAddress: true,
              name: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: logs,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get audit logs for a specific resource (e.g. all actions on a shipment).
   */
  async findByResource(resourceType: string, resourceId: string) {
    return this.prisma.auditLog.findMany({
      where: { entityType: resourceType, entityId: resourceId },
      include: {
        user: {
          select: {
            id: true,
            stellarAddress: true,
            name: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get audit logs for a specific actor (user).
   */
  async findByActor(actorAddress: string, limit = 100) {
    return this.prisma.auditLog.findMany({
      where: { userId: actorAddress },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
