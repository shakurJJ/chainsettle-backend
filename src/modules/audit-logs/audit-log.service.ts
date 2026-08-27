import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildCsvFromRows } from '../../common/utils/csv.util';

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
          actorId: dto.actorId ?? null,
          actorAddress: dto.actorAddress,
          action: dto.action,
          entityType: dto.resourceType,
          entityId: dto.resourceId,
          resourceType: dto.resourceType,
          resourceId: dto.resourceId,
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

    // Read-heavy admin list — route through replica when configured
    const db = this.prisma.read;
    const [logs, total] = await db.$transaction([
      db.auditLog.findMany({
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
      db.auditLog.count({ where }),
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

  async exportCsv(filters: {
    startDate?: Date;
    endDate?: Date;
    userId?: string;
    entityType?: string;
    entityId?: string;
  }) {
    const { startDate, endDate, userId, entityType, entityId } = filters;

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('startDate must be on or before endDate');
    }

    const maxRangeDays = 90;
    if (startDate && endDate) {
      const diffDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays > maxRangeDays) {
        throw new BadRequestException(`Date range cannot exceed ${maxRangeDays} days`);
      }
    }

    const where: any = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }
    if (userId) where.userId = userId;
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        userId: true,
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
        ipAddress: true,
        createdAt: true,
      },
    });

    return buildCsvFromRows(
      rows.map((row: any) => ({
        id: row.id,
        userId: row.userId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        metadata: row.metadata ? JSON.stringify(row.metadata) : '',
        ipAddress: row.ipAddress ?? '',
        createdAt: row.createdAt?.toISOString?.() ?? '',
      })),
    );
  }

  /**
   * Get audit logs for a specific resource (e.g. all actions on a shipment).
   */
  async findByResource(resourceType: string, resourceId: string) {
    return this.prisma.auditLog.findMany({
      where: {
        resourceType,
        resourceId,
      },
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
