import {
  Injectable,
  NotFoundException,
  Logger,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { TokenRegistryService } from '../../common/token-registry/token-registry.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../../common/redis/redis.service';
import { MetricsService } from '../../common/metrics/metrics.service';
import { CreateShipmentDto, CloneShipmentDto } from './dto/create-shipment.dto';
import { CreateTrackingDto } from './dto/tracking.dto';
import { ShipmentStatus, NotificationType, ArbiterStatus } from '@prisma/client';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { randomUUID } from 'crypto';

@Injectable()
export class ShipmentsService {
  private readonly logger = new Logger(ShipmentsService.name);
  private readonly cacheTtl: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly tokenRegistry: TokenRegistryService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.cacheTtl = this.config.get<number>('SHIPMENTS_CACHE_TTL_SECONDS', 30);
  }

  // ----------------------------------------------------------
  // CREATE — persist after tx is confirmed on-chain
  // ----------------------------------------------------------

  /**
   * Saves a shipment record in the database after the buyer has
   * submitted the create_shipment transaction via the frontend.
   * The frontend sends the confirmed txHash back here.
   * * If templateId is provided, pre-populate fields from the template.
   * Explicit fields in the request override template values.
   */
  async create(dto: CreateShipmentDto) {
    const existing = await this.prisma.shipment.findUnique({
      where: { id: dto.shipmentId },
    });
    if (existing) {
      throw new ConflictException(`Shipment ${dto.shipmentId} already exists`);
    }

    // Check for duplicate referenceNumber if provided
    if (dto.referenceNumber) {
      const withRef = await this.prisma.shipment.findUnique({
        where: { referenceNumber: dto.referenceNumber },
      });
      if (withRef) {
        throw new ConflictException(`Shipment with referenceNumber "${dto.referenceNumber}" already exists`);
      }
    }

    // Pre-populate from template if provided
    let templateData: any = {};
    if (dto.templateId) {
      const template = await this.prisma.shipmentTemplate.findUnique({
        where: { id: dto.templateId },
      });
      if (!template) {
        throw new NotFoundException(`Template ${dto.templateId} not found`);
      }
      templateData = {
        supplierAddress: template.supplierAddress,
        logisticsAddress: template.logisticsAddress,
        arbiterAddress: template.arbiterAddress,
        tokenAddress: template.tokenAddress,
        milestones: template.milestoneTemplates,
      };
    }

    // Merge template data with explicit request values (request overrides template)
    const supplierAddress = dto.supplierAddress ?? templateData.supplierAddress;
    const logisticsAddress = dto.logisticsAddress ?? templateData.logisticsAddress;
    const arbiterAddress = dto.arbiterAddress ?? templateData.arbiterAddress;
    const tokenAddress = dto.tokenAddress ?? templateData.tokenAddress;
    const milestones = dto.milestones ?? templateData.milestones;

    // Validate required fields
    if (!supplierAddress || !logisticsAddress || !arbiterAddress || !tokenAddress || !milestones) {
      throw new ConflictException(
        'Missing required fields: supplierAddress, logisticsAddress, arbiterAddress, tokenAddress, milestones',
      );
    }

    // ==========================================================
    // STEP 3: Defensive Guard for Milestone Payment Sum
    // ==========================================================
    if (milestones && milestones.length > 0) {
      const sum = milestones.reduce(
        (total: number, m: any) => total + (m.paymentPercent || 0),
        0,
      );

      if (sum !== 100) {
        throw new BadRequestException(
          `Milestone payment percentages must sum to exactly 100. Got ${sum}.`
        );
      }
    }
    // ==========================================================

    const token = this.tokenRegistry.getToken(tokenAddress);

    const shipment = await this.prisma.shipment.create({
      data: {
        id: dto.shipmentId,
        buyerAddress: dto.buyerAddress,
        supplierAddress,
        logisticsAddress,
        arbiterAddress,
        tokenAddress,
        tokenDecimals: token.decimals,
        tokenSymbol: token.symbol,
        totalAmount: BigInt(dto.totalAmount),
        txHash: dto.txHash,
        description: dto.description,
        referenceNumber: dto.referenceNumber,
        metadata: dto.metadata,
        tags: dto.tags ?? [],
        milestones: {
          create: milestones.map((m: any, index: number) => ({
            milestoneIndex: index,
            name: m.name,
            paymentPercent: m.paymentPercent,
            ...(m.dueAt ? { dueAt: new Date(m.dueAt) } : {}),
            ...(m.dueDays ? { dueAt: new Date(Date.now() + m.dueDays * 24 * 60 * 60 * 1000) } : {}),
          })),
        },
      },
      include: { milestones: true },
    });

    // Notify the designated arbiter about their assignment
    await this.notifications.notifyUser(
      dto.arbiterAddress,
      NotificationType.ARBITER_INVITED,
      'Arbiter assignment invitation',
      `You have been assigned as arbiter for shipment ${shipment.id}. Please accept or decline this assignment.`,
      { shipmentId: shipment.id, buyerAddress: dto.buyerAddress, supplierAddress: dto.supplierAddress },
    );

    this.logger.log(`Shipment created: ${shipment.id} — arbiter ${dto.arbiterAddress} notified`);
    this.metrics.incrementShipmentsCreated();
    this.metrics.incrementActiveShipments();
    await this.invalidateUserCache(dto.buyerAddress);
    return this.serialize(shipment);
  }

  // ----------------------------------------------------------
  // READ
  // ----------------------------------------------------------

  async findAll(filters: {
    buyerAddress?: string;
    supplierAddress?: string;
    status?: ShipmentStatus;
    referenceNumber?: string;
    tags?: string[];
    page?: number;
    limit?: number;
    cursor?: string;
    createdAfter?: string;
    createdBefore?: string;
    updatedAfter?: string;
    updatedBefore?: string;
    callerStellarAddress?: string;
    isAdmin?: boolean;
    includeArchived?: boolean;
    search?: string;
  }) {
    const {
      buyerAddress,
      supplierAddress,
      status,
      referenceNumber,
      tags,
      page = 1,
      limit = 20,
      cursor,
      createdAfter,
      createdBefore,
      updatedAfter,
      updatedBefore,
      callerStellarAddress,
      isAdmin = false,
      includeArchived = false,
      search,
    } = filters;

    if (cursor && page && page !== 1) {
      throw new BadRequestException('cursor and page are mutually exclusive');
    }

    const where: any = {};

    if (buyerAddress) where.buyerAddress = buyerAddress;
    if (supplierAddress) where.supplierAddress = supplierAddress;
    if (status) where.status = status;
    if (referenceNumber) where.referenceNumber = referenceNumber;
    if (tags && tags.length > 0) {
      where.tags = { hasSome: tags };
    }

    // Dynamic chronological range bounds filters
    if (createdAfter || createdBefore) {
      where.createdAt = {
        ...(createdAfter && { gte: new Date(createdAfter) }),
        ...(createdBefore && { lte: new Date(createdBefore) }),
      };
    }

    if (updatedAfter || updatedBefore) {
      where.updatedAt = {
        ...(updatedAfter && { gte: new Date(updatedAfter) }),
        ...(updatedBefore && { lte: new Date(updatedBefore) }),
      };
    }

    if (!includeArchived) {
      where.archivedAt = null;
    }

    // Scope to shipments where the caller is a participant (buyer/supplier/logistics/arbiter)
    if (!isAdmin && callerStellarAddress) {
      where.AND = where.AND ?? [];
      where.AND.push({
        OR: [
          { buyerAddress: callerStellarAddress },
          { supplierAddress: callerStellarAddress },
          { logisticsAddress: callerStellarAddress },
          { arbiterAddress: callerStellarAddress },
        ],
      });
    }

    let shipments: any[];
    let total: number | null = null;
    let nextCursor: string | null = null;

    if (search) {
      const participantCondition =
        !isAdmin && callerStellarAddress
          ? `AND (buyer_address = $1 OR supplier_address = $1 OR logistics_address = $1 OR arbiter_address = $1)`
          : '';
      const participantParams =
        !isAdmin && callerStellarAddress ? [callerStellarAddress] : [];

      const query = `
        SELECT * FROM shipments
        WHERE description_search @@ plainto_tsquery('english', $2)
        ${participantCondition}
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
      `;

      const countQuery = `
        SELECT COUNT(*) FROM shipments
        WHERE description_search @@ plainto_tsquery('english', $2)
        ${participantCondition}
      `;

      shipments = await this.prisma.$queryRawUnsafe(
        query,
        ...participantParams,
        search,
        limit,
        (page - 1) * limit,
      );

      const countResult = await this.prisma.$queryRawUnsafe(
        countQuery,
        ...participantParams,
        search,
      );
      total = Number((countResult as any[])[0].count);

      for (const s of shipments) {
        s.milestones = await this.prisma.milestone.findMany({
          where: { shipmentId: s.id },
          orderBy: { milestoneIndex: 'asc' },
        });
      }
    } else if (cursor) {
      let decoded: { createdAt: string; id: string };
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
      } catch {
        throw new BadRequestException('Invalid cursor format');
      }

      shipments = await this.prisma.shipment.findMany({
        where: { ...where, createdAt: { lte: new Date(decoded.createdAt) } },
        include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        cursor: { id: decoded.id },
        skip: 1,
        take: limit,
      });

      nextCursor =
        shipments.length === limit
          ? Buffer.from(
              JSON.stringify({
                createdAt: shipments[shipments.length - 1].createdAt.toISOString(),
                id: shipments[shipments.length - 1].id,
              }),
            ).toString('base64')
          : null;
    } else {
      [shipments, total] = await this.prisma.$transaction([
        this.prisma.shipment.findMany({
          where,
          include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.shipment.count({ where }),
      ]);
    }

    return {
      data: shipments.map((s) => this.serialize(s)),
      meta: cursor
        ? { nextCursor, limit }
        : {
            total,
            page,
            limit,
            totalPages: total !== null ? Math.ceil(total / limit) : null,
            nextCursor: null,
          },
    };
  }

  async findOne(id: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      include: {
        milestones: { orderBy: { milestoneIndex: 'asc' } },
        events: { orderBy: { ledger: 'desc' }, take: 20 },
        trackingUpdates: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);
    return this.serialize(shipment);
  }

  async bulkStatus(
    ids: string[],
    callerAddress: string,
    isAdmin: boolean,
  ): Promise<{ results: Record<string, ShipmentStatus> }> {
    const where: any = { id: { in: ids } };

    if (!isAdmin) {
      where.OR = [
        { buyerAddress: callerAddress },
        { supplierAddress: callerAddress },
        { logisticsAddress: callerAddress },
        { arbiterAddress: callerAddress },
      ];
    }

    const shipments = await this.prisma.shipment.findMany({
      where,
      select: { id: true, status: true },
    });

    const results: Record<string, ShipmentStatus> = {};
    for (const s of shipments) {
      results[s.id] = s.status;
    }
    return { results };
  }

  /**
   * Update shipment metadata (description, referenceNumber, metadata, tags).
   * Only the buyer can update a shipment.
   * Financial fields and addresses are immutable and ignored if provided.
   */
  async update(id: string, buyerAddress: string, dto: any) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }

    // Verify buyer is the one making the update
    if (shipment.buyerAddress !== buyerAddress) {
      throw new ForbiddenException('Only the shipment buyer can update it');
    }

    // Check for duplicate referenceNumber if being updated
    if (dto.referenceNumber && dto.referenceNumber !== shipment.referenceNumber) {
      const withRef = await this.prisma.shipment.findUnique({
        where: { referenceNumber: dto.referenceNumber },
      });
      if (withRef) {
        throw new ConflictException(`Shipment with referenceNumber "${dto.referenceNumber}" already exists`);
      }
    }

    // Only allow updating descriptive fields (financial/address fields ignored)
    const updateData: any = {};
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.referenceNumber !== undefined) updateData.referenceNumber = dto.referenceNumber;
    if (dto.metadata !== undefined) updateData.metadata = dto.metadata;
    if (dto.tags !== undefined) updateData.tags = dto.tags;

    const updated = await this.prisma.shipment.update({
      where: { id },
      data: updateData,
      include: {
        milestones: { orderBy: { milestoneIndex: 'asc' } },
        events: { orderBy: { ledger: 'desc' }, take: 20 },
      },
    });

    this.logger.log(`Shipment updated: ${id}`);
    await this.invalidateUserCache(buyerAddress);
    return this.serialize(updated);
  }

  // ----------------------------------------------------------
  // ARBITER ACCEPT / DECLINE
  // ----------------------------------------------------------

  /**
   * Called when the designated arbiter accepts their assignment.
   * Sets arbiterStatus to ACCEPTED and notifies the buyer.
   */
  async arbiterAccept(id: string, callerAddress: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }

    if (shipment.arbiterAddress !== callerAddress) {
      throw new ForbiddenException('Only the designated arbiter can accept this assignment');
    }

    if (shipment.arbiterStatus !== ArbiterStatus.PENDING_ACCEPTANCE) {
      throw new ConflictException(
        `Arbiter assignment is already ${shipment.arbiterStatus.toLowerCase()}`,
      );
    }

    const updated = await this.prisma.shipment.update({
      where: { id },
      data: { arbiterStatus: ArbiterStatus.ACCEPTED },
    });

    await this.notifications.notifyUser(
      shipment.buyerAddress,
      NotificationType.ARBITER_ACCEPTED,
      'Arbiter accepted assignment',
      `The arbiter for shipment ${id} has accepted their assignment.`,
      { shipmentId: id, arbiterAddress: callerAddress },
    );

    this.logger.log(`Arbiter ${callerAddress} accepted assignment for shipment ${id}`);
    return this.serialize(updated);
  }

  /**
   * Called when the designated arbiter declines their assignment.
   * Sets arbiterStatus to DECLINED and notifies the buyer.
   */
  async arbiterDecline(id: string, callerAddress: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }

    if (shipment.arbiterAddress !== callerAddress) {
      throw new ForbiddenException('Only the designated arbiter can decline this assignment');
    }

    if (shipment.arbiterStatus !== ArbiterStatus.PENDING_ACCEPTANCE) {
      throw new ConflictException(
        `Arbiter assignment is already ${shipment.arbiterStatus.toLowerCase()}`,
      );
    }

    const updated = await this.prisma.shipment.update({
      where: { id },
      data: { arbiterStatus: ArbiterStatus.DECLINED },
    });

    await this.notifications.notifyUser(
      shipment.buyerAddress,
      NotificationType.ARBITER_DECLINED,
      'Arbiter declined assignment',
      `The arbiter for shipment ${id} has declined their assignment. Please designate a replacement.`,
      { shipmentId: id, arbiterAddress: callerAddress },
    );

    this.logger.log(`Arbiter ${callerAddress} declined assignment for shipment ${id}`);
    return this.serialize(updated);
  }

  // ----------------------------------------------------------
  // CANCEL — buyer registers on-chain cancellation
  // ----------------------------------------------------------

  async cancel(id: string, buyerAddress: string, txHash: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id } });
    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);
    if (shipment.buyerAddress !== buyerAddress) {
      throw new ForbiddenException('Only the shipment buyer can cancel it');
    }
    if (shipment.status !== ShipmentStatus.ACTIVE) {
      throw new ConflictException(`Shipment is not ACTIVE (current status: ${shipment.status})`);
    }

    const updated = await this.prisma.shipment.update({
      where: { id },
      data: { status: ShipmentStatus.CANCELLED, txHash },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Shipment ${id} cancelled by buyer ${buyerAddress}`);
    this.metrics.decrementActiveShipments();
    await this.invalidateUserCache(buyerAddress);
    return this.serialize(updated);
  }

  // ----------------------------------------------------------
  // CLONE — copy structure into a new ACTIVE shipment
  // ----------------------------------------------------------

  async clone(id: string, buyerAddress: string, dto: CloneShipmentDto) {
    const source = await this.prisma.shipment.findUnique({
      where: { id },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    if (!source) throw new NotFoundException(`Shipment ${id} not found`);

    if (source.buyerAddress !== buyerAddress) {
      throw new ForbiddenException('Only the original shipment buyer can clone it');
    }

    const token = this.tokenRegistry.getToken(source.tokenAddress);
    const newId = randomUUID();

    const cloned = await this.prisma.shipment.create({
      data: {
        id: newId,
        buyerAddress: source.buyerAddress,
        supplierAddress: source.supplierAddress,
        logisticsAddress: source.logisticsAddress,
        arbiterAddress: source.arbiterAddress,
        tokenAddress: source.tokenAddress,
        tokenDecimals: token.decimals,
        tokenSymbol: token.symbol,
        totalAmount: BigInt(dto.totalAmount),
        txHash: dto.txHash,
        description: source.description,
        metadata: source.metadata ?? undefined,
        tags: source.tags,
        status: ShipmentStatus.ACTIVE,
        arbiterStatus: ArbiterStatus.PENDING_ACCEPTANCE,
        milestones: {
          create: source.milestones.map((m, index) => ({
            milestoneIndex: index,
            name: m.name,
            paymentPercent: m.paymentPercent,
          })),
        },
      },
      include: { milestones: true },
    });

    await this.notifications.notifyUser(
      source.arbiterAddress,
      NotificationType.ARBITER_INVITED,
      'Arbiter assignment invitation',
      `You have been assigned as arbiter for shipment ${cloned.id}. Please accept or decline this assignment.`,
      { shipmentId: cloned.id, buyerAddress: source.buyerAddress, supplierAddress: source.supplierAddress },
    );

    this.logger.log(`Shipment ${id} cloned to ${cloned.id} by buyer ${buyerAddress}`);
    return this.serialize(cloned);
  }

  // ----------------------------------------------------------
  // ARCHIVE / UNARCHIVE — hide completed/cancelled shipments
  // ----------------------------------------------------------

  async archive(id: string, buyerAddress: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id } });
    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);
    if (shipment.buyerAddress !== buyerAddress) {
      throw new ForbiddenException('Only the shipment buyer can archive it');
    }
    if (shipment.status === ShipmentStatus.ACTIVE) {
      throw new ConflictException('Only COMPLETED or CANCELLED shipments can be archived');
    }
    if (shipment.archivedAt) {
      throw new ConflictException('Shipment is already archived');
    }

    const updated = await this.prisma.shipment.update({
      where: { id },
      data: { archivedAt: new Date() },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Shipment ${id} archived by buyer ${buyerAddress}`);
    return this.serialize(updated);
  }

  async unarchive(id: string, buyerAddress: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id } });
    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);
    if (shipment.buyerAddress !== buyerAddress) {
      throw new ForbiddenException('Only the shipment buyer can unarchive it');
    }
    if (!shipment.archivedAt) {
      throw new ConflictException('Shipment is not archived');
    }

    const updated = await this.prisma.shipment.update({
      where: { id },
      data: { archivedAt: null },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Shipment ${id} unarchived by buyer ${buyerAddress}`);
    return this.serialize(updated);
  }

  // ----------------------------------------------------------
  // MY ROLE — return the caller's participant role
  // ----------------------------------------------------------

  async getCallerRole(id: string, stellarAddress: string, isAdmin: boolean) {
    if (isAdmin) return { role: 'ADMIN' };

    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      select: {
        buyerAddress: true,
        supplierAddress: true,
        logisticsAddress: true,
        arbiterAddress: true,
      },
    });

    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);

    if (stellarAddress === shipment.buyerAddress) return { role: 'BUYER' };
    if (stellarAddress === shipment.supplierAddress) return { role: 'SUPPLIER' };
    if (stellarAddress === shipment.logisticsAddress) return { role: 'LOGISTICS' };
    if (stellarAddress === shipment.arbiterAddress) return { role: 'ARBITER' };

    return { role: null };
  }

  // ----------------------------------------------------------
  // TRACKING UPDATES — logistics participant submits location/status
  // ----------------------------------------------------------

  /**
   * Create a tracking update for a shipment.
   * Only the logistics participant can submit tracking updates.
   * Tracking updates are immutable after submission.
   */
  async createTracking(
    shipmentId: string,
    callerAddress: string,
    dto: CreateTrackingDto,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { logisticsAddress: true, buyerAddress: true, supplierAddress: true, id: true },
    });

    if (!shipment) {
      throw new ForbiddenException(`Shipment ${shipmentId} not found`);
    }

    if (shipment.logisticsAddress !== callerAddress) {
      throw new ForbiddenException('Only the logistics participant can submit tracking updates');
    }

    const trackingUpdate = await this.prisma.trackingUpdate.create({
      data: {
        shipmentId: shipment.id,
        submittedBy: callerAddress,
        location: dto.location,
        ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
        ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
        status: dto.status,
        ...(dto.estimatedArrival ? { estimatedArrival: new Date(dto.estimatedArrival) } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });

    // Notify buyer and supplier
    const etaText = trackingUpdate.estimatedArrival
      ? ` ETA: ${trackingUpdate.estimatedArrival.toISOString()}`
      : '';
    const notificationMessage = `Logistics update: ${trackingUpdate.status} at ${trackingUpdate.location}.${etaText}`;

    await this.notifications.notifyUser(
      shipment.buyerAddress,
      NotificationType.TRACKING_UPDATED,
      'Shipment tracking update',
      notificationMessage,
      {
        shipmentId: shipment.id,
        status: trackingUpdate.status,
        location: trackingUpdate.location,
        estimatedArrival: trackingUpdate.estimatedArrival?.toISOString() ?? null,
      },
    );

    await this.notifications.notifyUser(
      shipment.supplierAddress,
      NotificationType.TRACKING_UPDATED,
      'Shipment tracking update',
      notificationMessage,
      {
        shipmentId: shipment.id,
        status: trackingUpdate.status,
        location: trackingUpdate.location,
        estimatedArrival: trackingUpdate.estimatedArrival?.toISOString() ?? null,
      },
    );

    this.logger.log(`Tracking update created for shipment ${shipmentId} by ${callerAddress}: ${trackingUpdate.status} at ${trackingUpdate.location}`);
    return trackingUpdate;
  }

  /**
   * Get all tracking updates for a shipment in chronological order.
   * Restricted to shipment participants.
   */
  async getTracking(shipmentId: string, callerAddress: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { buyerAddress: true, supplierAddress: true, logisticsAddress: true, arbiterAddress: true },
    });

    if (!shipment) {
      throw new ForbiddenException(`Shipment ${shipmentId} not found`);
    }

    const isParticipant =
      callerAddress === shipment.buyerAddress ||
      callerAddress === shipment.supplierAddress ||
      callerAddress === shipment.logisticsAddress ||
      callerAddress === shipment.arbiterAddress;

    if (!isParticipant) {
      throw new ForbiddenException('Not authorized to view tracking updates for this shipment');
    }

    const trackingUpdates = await this.prisma.trackingUpdate.findMany({
      where: { shipmentId },
      orderBy: { createdAt: 'asc' },
    });

    return trackingUpdates;
  }

  // ----------------------------------------------------------
  // PARTICIPANTS
  // ----------------------------------------------------------

  async getParticipants(shipmentId: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        buyerAddress: true,
        supplierAddress: true,
        logisticsAddress: true,
        arbiterAddress: true,
        arbiterStatus: true,
        buyer: { select: { name: true } },
        supplier: { select: { name: true } },
        logistics: { select: { name: true } },
        arbiter: { select: { name: true } },
      },
    });

    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);

    return [
      { role: 'BUYER', stellarAddress: shipment.buyerAddress, name: shipment.buyer.name ?? null },
      { role: 'SUPPLIER', stellarAddress: shipment.supplierAddress, name: shipment.supplier.name ?? null },
      { role: 'LOGISTICS', stellarAddress: shipment.logisticsAddress, name: shipment.logistics.name ?? null },
      { role: 'ARBITER', stellarAddress: shipment.arbiterAddress, name: shipment.arbiter.name ?? null, arbiterStatus: shipment.arbiterStatus },
    ];
  }

  // ----------------------------------------------------------
  // SYNC FROM CHAIN — called by EventsService after polling
  // ----------------------------------------------------------

  async syncStatusFromChain(shipmentId: string) {
    try {
      // Convert shipmentId to ScVal String for contract call
      const shipmentIdScVal = nativeToScVal(shipmentId, { type: 'string' });
      
      const onChain = await this.stellar.simulateContractCall('get_shipment', [
        shipmentIdScVal,
      ]);

      // If contract returns null, shipment doesn't exist on-chain yet
      if (!onChain) {
        this.logger.warn(
          `Shipment ${shipmentId} not found on-chain. It may not be created yet or the ID is incorrect.`
        );
        return;
      }

      // Map on-chain status to Prisma enum
      const statusMap: Record<string, ShipmentStatus> = {
        Active: ShipmentStatus.ACTIVE,
        Completed: ShipmentStatus.COMPLETED,
        Cancelled: ShipmentStatus.CANCELLED,
      };

      const mappedStatus = statusMap[onChain.status];
      
      if (!mappedStatus) {
        this.logger.warn(
          `Unknown on-chain status "${onChain.status}" for shipment ${shipmentId}. Skipping update.`
        );
        return;
      }

      // Parse released amount - handle both string and number formats
      const releasedAmount = onChain.released_amount 
        ? BigInt(onChain.released_amount.toString())
        : BigInt(0);

      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          status: mappedStatus,
          releasedAmount,
        },
      });

      this.logger.log(
        `Synced shipment ${shipmentId} from chain: status=${mappedStatus}, releasedAmount=${releasedAmount}`
      );
    } catch (error) {
      // Check if it's a "shipment not found in DB" error
      if (error.code === 'P2025') {
        this.logger.warn(
          `Cannot sync shipment ${shipmentId}: not found in database`
        );
        return;
      }
      
      this.logger.error(
        `Failed to sync shipment ${shipmentId} from chain: ${error.message}`,
        error.stack
      );
      // Don't throw - allow the process to continue
    }
  }

  // ----------------------------------------------------------
  // EXPORT
  // ----------------------------------------------------------

  async exportForUser(callerStellarAddress: string, isAdmin: boolean) {
    const where: any = {};
    if (!isAdmin) {
      where.OR = [
        { buyerAddress: callerStellarAddress },
        { supplierAddress: callerStellarAddress },
        { logisticsAddress: callerStellarAddress },
        { arbiterAddress: callerStellarAddress },
      ];
    }

    return this.prisma.shipment.findMany({
      where,
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  buildCsv(shipments: any[]): string {
    const headers = [
      'shipmentId', 'buyerAddress', 'supplierAddress', 'logisticsAddress',
      'arbiterAddress', 'totalAmount', 'releasedAmount', 'status', 'createdAt',
      'milestoneName', 'milestoneIndex', 'paymentPercent', 'milestoneStatus',
      'proofHash', 'confirmedAt',
    ];

    const escape = (v: any) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const decimals = 7;
    const toUsdc = (raw: bigint) =>
      this.stellar.toHumanAmount(raw ?? 0n, decimals);

    const rows: string[] = [headers.join(',')];

    for (const s of shipments) {
      const base = [
        s.id, s.buyerAddress, s.supplierAddress, s.logisticsAddress,
        s.arbiterAddress,
        toUsdc(s.totalAmount),
        toUsdc(s.releasedAmount),
        s.status,
        s.createdAt?.toISOString() ?? '',
      ];

      if (!s.milestones?.length) {
        rows.push([...base, '', '', '', '', '', ''].map(escape).join(','));
      } else {
        for (const m of s.milestones) {
          rows.push([
            ...base,
            m.name, m.milestoneIndex, m.paymentPercent,
            m.status, m.proofHash ?? '', m.confirmedAt?.toISOString() ?? '',
          ].map(escape).join(','));
        }
      }
    }

    return rows.join('\n');
  }

  buildPdf(shipments: any[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const decimals = 7;
      const toUsdc = (raw: bigint) =>
        this.stellar.toHumanAmount(raw ?? 0n, decimals);

      doc.fontSize(18).text('ChainSettle — Escrow Export', { align: 'center' });
      doc.fontSize(10).text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
      doc.moveDown();

      for (const s of shipments) {
        doc.fontSize(13).text(`Shipment: ${s.id}`, { underline: true });
        doc.fontSize(9);

        const participants = [
          ['Buyer', s.buyerAddress],
          ['Supplier', s.supplierAddress],
          ['Logistics', s.logisticsAddress],
          ['Arbiter', s.arbiterAddress],
        ];
        for (const [role, addr] of participants) {
          doc.text(`${role}: ${addr}`);
        }

        doc.moveDown(0.5);
        doc.text(`Status: ${s.status}   Total: ${toUsdc(s.totalAmount)} USDC   Released: ${toUsdc(s.releasedAmount)} USDC`);
        doc.text(`Created: ${s.createdAt?.toISOString() ?? ''}`);

        if (s.milestones?.length) {
          doc.moveDown(0.5).fontSize(10).text('Milestones:', { underline: true });
          doc.fontSize(9);
          for (const m of s.milestones) {
            doc.text(
              `  [${m.milestoneIndex}] ${m.name} — ${m.paymentPercent}% — ${m.status}` +
              (m.confirmedAt ? ` — confirmed ${m.confirmedAt.toISOString()}` : ''),
            );
          }
        }

        doc.moveDown();
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown();
      }

      doc.end();
    });
  }

  async exportOnePdf(id: string): Promise<Buffer> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      include: {
        milestones: { orderBy: { milestoneIndex: 'asc' } },
        events: { orderBy: { ledger: 'desc' }, take: 50 },
        comments: { where: { visibility: 'ALL' }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const decimals = 7;
      const toUsdc = (raw: bigint) =>
        this.stellar.toHumanAmount(raw ?? 0n, decimals);

      doc.fontSize(18).text('ChainSettle — Shipment Export', { align: 'center' });
      doc.fontSize(10).text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
      doc.moveDown();

      doc.fontSize(13).text(`Shipment: ${shipment.id}`, { underline: true });
      doc.fontSize(9);

      const participants = [
        ['Buyer', shipment.buyerAddress],
        ['Supplier', shipment.supplierAddress],
        ['Logistics', shipment.logisticsAddress],
        ['Arbiter', shipment.arbiterAddress],
      ];
      for (const [role, addr] of participants) {
        doc.text(`${role}: ${addr}`);
      }

      doc.moveDown(0.5);
      doc.text(`Status: ${shipment.status}   Total: ${toUsdc(shipment.totalAmount)} USDC   Released: ${toUsdc(shipment.releasedAmount)} USDC`);
      doc.text(`Created: ${shipment.createdAt?.toISOString() ?? ''}`);

      if (shipment.milestones?.length) {
        doc.moveDown(0.5).fontSize(10).text('Milestones:', { underline: true });
        doc.fontSize(9);
        for (const m of shipment.milestones) {
          doc.text(
            `  [${m.milestoneIndex}] ${m.name} — ${m.paymentPercent}% — ${m.status}` +
            (m.confirmedAt ? ` — confirmed ${m.confirmedAt.toISOString()}` : '') +
            (m.proofHash ? ` — Proof: ${m.proofHash}` : ''),
          );
        }
      }

      if (shipment.events?.length) {
        doc.moveDown(0.5).fontSize(10).text('Chain Events:', { underline: true });
        doc.fontSize(9);
        for (const e of shipment.events) {
          doc.text(`  [${e.ledger}] ${e.eventName} — ${e.txHash}`);
        }
      }

      if (shipment.comments?.length) {
        doc.moveDown(0.5).fontSize(10).text('Comments:', { underline: true });
        doc.fontSize(9);
        for (const c of shipment.comments) {
          doc.text(`  [${c.createdAt.toISOString()}] ${c.authorId}: ${c.body}`);
        }
      }

      doc.moveDown();
      doc.fontSize(8).text(`Exported: ${new Date().toISOString()}`, { align: 'center' });

      doc.end();
    });
  }

  // ----------------------------------------------------------
  // INTERNAL HELPERS
  // ----------------------------------------------------------

  private buildCacheKey(callerStellarAddress: string, filters: Record<string, any>): string {
    const hash = createHash('sha256')
      .update(JSON.stringify(filters))
      .digest('hex')
      .slice(0, 16);
    return `shipments:${callerStellarAddress}:${hash}`;
  }

  private async invalidateUserCache(callerStellarAddress: string): Promise<void> {
    await this.redis.delByPrefix(`shipments:${callerStellarAddress}:`);
  }

  private serialize(shipment: any) {
    const now = new Date();
    const decimals: number = shipment.tokenDecimals ?? 7;
    const symbol: string = shipment.tokenSymbol ?? 'USDC';

    const trackingUpdates = shipment.trackingUpdates?.map((t: any) => ({
      id: t.id,
      location: t.location,
      latitude: t.latitude,
      longitude: t.longitude,
      status: t.status,
      estimatedArrival: t.estimatedArrival?.toISOString() ?? null,
      notes: t.notes,
      createdAt: t.createdAt.toISOString(),
    }));

    const latestTracking = trackingUpdates && trackingUpdates.length > 0
      ? trackingUpdates[trackingUpdates.length - 1]
      : null;

    return {
      ...shipment,
      tokenSymbol: symbol,
      tokenDecimals: decimals,
      totalAmount: shipment.totalAmount?.toString(),
      releasedAmount: shipment.releasedAmount?.toString(),
      totalAmountFormatted: this.stellar.toHumanAmount(shipment.totalAmount ?? 0n, decimals),
      releasedAmountFormatted: this.stellar.toHumanAmount(shipment.releasedAmount ?? 0n, decimals),
      milestones: shipment.milestones?.map((m: any) => {
        const isOverdue =
          m.dueAt &&
          m.dueAt < now &&
          m.status !== 'CONFIRMED' &&
          m.status !== 'RESOLVED';

        return {
          ...m,
          paymentReleased: m.paymentReleased?.toString() ?? null,
          isOverdue: Boolean(isOverdue),
        };
      }),
      trackingUpdates,
      latestTracking,
    };
  }
}