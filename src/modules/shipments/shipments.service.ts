import {
  Injectable,
  NotFoundException,
  Logger,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
  PreconditionFailedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { TokenRegistryService } from '../../common/token-registry/token-registry.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../../common/redis/redis.service';
import { MetricsService } from '../../common/metrics/metrics.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { KycService } from '../kyc/kyc.service';
import { ShipmentApprovalsService } from './shipment-approvals.service';
import { FxRateService } from '../../common/fx/fx-rate.service';
import { CreateShipmentDto, CloneShipmentDto } from './dto/create-shipment.dto';
import { CreateTrackingDto } from './dto/tracking.dto';
import { ShipmentDocumentDto } from './dto/shipment-document.dto';
import { ShipmentStatus, NotificationType, ArbiterStatus, CommentVisibility } from '@prisma/client';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { randomUUID } from 'crypto';
import { parse } from 'csv-parse/sync';
import Ajv from 'ajv';
import { metadataSchemas } from './schemas/metadata.schemas';
import { pickFields } from './shipment-fields';
import { computeShipmentRisk, RiskLevel, ShipmentRiskResult } from './utils/risk.util';

const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Strong ETag for a shipment's mutable state (#387). Derived from id and
 * updatedAt so every successful write produces a new value.
 */
export function shipmentEtag(shipment: { id: string; updatedAt: Date }, milestoneUpdatedAt?: Date | null): string {
  const hash = createHash('sha1')
    .update(`${shipment.id}:${new Date(shipment.updatedAt).toISOString()}:${milestoneUpdatedAt ? new Date(milestoneUpdatedAt).toISOString() : ''}`)
    .digest('hex');
  return `W/"${hash}"`;
}

/** True when an If-Match header value matches the current ETag (or is `*`). */
export function ifMatchSatisfied(ifMatch: string, currentEtag: string): boolean {
  const normalize = (value: string) => value.trim().replace(/^W\//, '');
  const normalizedCurrent = normalize(currentEtag);
  return ifMatch
    .split(',')
    .map(normalize)
    .some((v) => v === '*' || v === normalizedCurrent);
}

import { computeFieldChanges, extractChanges, isHiddenField } from './shipment-diff.util';

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
    private readonly auditLog: AuditLogService,
    private readonly kyc: KycService,
    private readonly approvals: ShipmentApprovalsService,
    private readonly fxRate: FxRateService,
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
      const template = await this.prisma.shipmentTemplate.findFirst({
        where: { id: dto.templateId, deletedAt: null },
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

    if (arbiterAddress && [dto.buyerAddress, supplierAddress, logisticsAddress].some(a => a && a.toLowerCase() === arbiterAddress.toLowerCase())) throw new BadRequestException({ code: 'ARBITER_CONFLICT', message: 'Arbiter cannot be a shipment party' });

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

    // KYC/AML gate — shipments at or above the configured value threshold
    // require both buyer and supplier to be KYC-verified (#233).
    const totalAmountBigInt = BigInt(dto.totalAmount);
    if (this.kyc.meetsThreshold(totalAmountBigInt)) {
      const [buyerVerified, supplierVerified] = await Promise.all([
        this.kyc.isVerified(dto.buyerAddress),
        this.kyc.isVerified(supplierAddress),
      ]);
      if (!buyerVerified || !supplierVerified) {
        throw new ForbiddenException(
          'This shipment value requires KYC verification. Both the buyer and supplier must complete KYC verification before a shipment of this size can be created.',
        );
      }
    }

    const token = this.tokenRegistry.getToken(tokenAddress);
    if (!token.enabled) {
      throw new BadRequestException(`Token ${tokenAddress} is disabled and cannot be used for new shipments`);
    }

    // Per-token min/max shipment value (#304) — no-op for tokens without bounds.
    this.tokenRegistry.assertValueWithinBounds(tokenAddress, totalAmountBigInt);

    // Multi-signature approval gate (#234). Rejects the field outright on
    // shipments below the configured value threshold rather than dropping it
    // silently, so a caller is never wrong about having gated a shipment.
    const requiredApprovals = this.approvals.resolveRequiredApprovals(
      dto.requiredApprovals,
      totalAmountBigInt,
    );

    const shipment = await this.prisma.shipment.create({
      data: {
        id: dto.shipmentId,
        ...(requiredApprovals !== null ? { requiredApprovals } : {}),
        buyerAddress: dto.buyerAddress,
        supplierAddress,
        logisticsAddress,
        arbiterAddress,
        tokenAddress,
        tokenDecimals: token.decimals,
        tokenSymbol: token.symbol,
        totalAmount: totalAmountBigInt,
        txHash: dto.txHash,
        description: dto.description,
        referenceNumber: dto.referenceNumber,
        metadata: dto.metadata,
        tags: dto.tags ?? [],
        expectedDeliveryAt: dto.expectedDeliveryAt ? new Date(dto.expectedDeliveryAt) : null,
        milestones: {
          create: milestones.map((m: any, index: number) => ({
            milestoneIndex: index,
            name: m.name,
            paymentPercent: m.paymentPercent,
            ...(m.dueAt ? { dueAt: new Date(m.dueAt) } : {}),
            ...(m.dueDays ? { dueAt: new Date(Date.now() + m.dueDays * 24 * 60 * 60 * 1000) } : {}),
            // Template checklists (#392) become real checklist items.
            ...(Array.isArray(m.checklist) && m.checklist.length > 0
              ? {
                  checklistItems: {
                    create: m.checklist.map((c: any) => ({
                      label: String(c.label),
                      required: c.required ?? true,
                    })),
                  },
                }
              : {}),
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
    return { ...(await this.serialize(shipment)), warnings: await this.getArbiterWarnings(arbiterAddress, dto.buyerAddress, supplierAddress) };
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
    isDraft?: boolean;
    favorite?: boolean;
    callerUserId?: string;
    /** Sparse fieldset (#390), already validated by parseFields(). */
    fields?: string[];
    /** ISO-4217 display currency for FX-converted values. Defaults to 'USD'. */
    displayCurrency?: string;
    /** Computed risk level filter (LOW, MEDIUM, HIGH). */
    riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
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
      isDraft,
      favorite,
      callerUserId,
      fields,
      displayCurrency = 'USD',
      riskLevel,
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
        const shipments = await db.shipment.findMany({
          where: { ...where, createdAt: { lte: new Date(decoded.createdAt) } },
          ...projection,
          orderBy: { createdAt: 'desc' },
          cursor: { id: decoded.id },
          skip: 1,
          take: limit,
        });
    }

    if (favorite === true) {
      if (!callerUserId) {
        throw new BadRequestException('Authentication required to filter favorites');
      }
      where.favorites = { some: { userId: callerUserId } };
    }

    // Scope to shipments where the caller is a participant (buyer/supplier/logistics/arbiter)
    if (participantAddresses) {
      where.AND = where.AND ?? [];
      where.AND.push({
        OR: [
          { buyerAddress: { in: participantAddresses } },
          { supplierAddress: { in: participantAddresses } },
          { logisticsAddress: { in: participantAddresses } },
          { arbiterAddress: { in: participantAddresses } },
        ],
      });
    } else if (!isAdmin && callerStellarAddress) {
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

    const favoriteInclude = callerUserId
      ? { favorites: { where: { userId: callerUserId }, select: { id: true } } }
      : {};

    const riskInclude = riskLevel
      ? {
          buyer: { select: { id: true, stellarAddress: true, kycStatus: true } },
          supplier: { select: { id: true, stellarAddress: true, kycStatus: true } },
          logistics: { select: { id: true, stellarAddress: true, kycStatus: true } },
          arbiter: { select: { id: true, stellarAddress: true, kycStatus: true } },
          trackingUpdates: { orderBy: { createdAt: 'desc' as const }, take: 1 },
          comments: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' as const }, take: 1 },
        }
      : {};

    // Sparse fieldsets (#390): push the selection into Prisma rather than
    // trimming afterwards. When no fields are requested, keep the full include.
    const milestonesQuery = { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' as const } };
    const projection: any = fields
      ? { select: this.buildSelect(fields, { milestones: milestonesQuery, ...favoriteInclude, ...riskInclude }) }
      : { include: { milestones: milestonesQuery, ...favoriteInclude, ...riskInclude } };

    let shipments: any[];
    let total: number | null = null;
    let nextCursor: string | null = null;

    if (search) {
      const scopeAddresses = participantAddresses
        ? participantAddresses
        : !isAdmin && callerStellarAddress
          ? [callerStellarAddress]
          : null;
      const participantCondition = scopeAddresses
        ? `AND (buyer_address = ANY($1::text[]) OR supplier_address = ANY($1::text[]) OR logistics_address = ANY($1::text[]) OR arbiter_address = ANY($1::text[]))`
        : '';
      const participantParams = scopeAddresses ? [scopeAddresses] : [];

      const query = `
        SELECT * FROM shipments
        WHERE (description_search @@ plainto_tsquery('english', $2) OR reference_number ILIKE '%' || $2 || '%')
        ${participantCondition}
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
      `;

      const countQuery = `
        SELECT COUNT(*) FROM shipments
        WHERE (description_search @@ plainto_tsquery('english', $2) OR reference_number ILIKE '%' || $2 || '%')
        ${participantCondition}
      `;

      // Read-heavy list path — use replica when DATABASE_REPLICA_URL is set
      const db = this.prisma.read;

      shipments = await db.$queryRawUnsafe(
        query,
        ...participantParams,
        search,
        limit,
        (page - 1) * limit,
      );

      const countResult = await db.$queryRawUnsafe(
        countQuery,
        ...participantParams,
        search,
      );
      total = Number((countResult as any[])[0].count);

      for (const s of shipments) {
        if (!fields || fields.includes('milestones')) {
          s.milestones = await db.milestone.findMany({
            where: { shipmentId: s.id, deletedAt: null },
            orderBy: { milestoneIndex: 'asc' },
          });
        }
        if (callerUserId) {
          s.favorites = await this.prisma.shipmentFavorite.findMany({
            where: { shipmentId: s.id, userId: callerUserId },
            select: { id: true },
          });
        }
      }
    } else if (cursor) {
      let decoded: { createdAt: string; id: string };
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
      } catch {
        throw new BadRequestException('Invalid cursor format');
      }

      const db = this.prisma.read;
      shipments = await db.shipment.findMany({
        where: { ...where, createdAt: { lte: new Date(decoded.createdAt) } },
        ...projection,
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
      const db = this.prisma.read;
      [shipments, total] = await db.$transaction([
        db.shipment.findMany({
          where,
          ...projection,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        db.shipment.count({ where }),
      ]);
    }

    if (riskLevel) {
      shipments = shipments.filter((s) => computeShipmentRisk(s).level === riskLevel);
      if (total !== null) {
        total = shipments.length;
      }
    }

    return {
      data: await Promise.all(
        shipments.map(async (s) => {
          const serialized = await this.serialize(s, callerUserId, undefined, displayCurrency);
          return fields ? pickFields(serialized, fields) : serialized;
        }),
      ),
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

  async findOne(id: string, callerUserId?: string, precisionOverride?: number, fields?: string[], displayCurrency = 'USD') {
    const db = this.prisma.read;
    const relations = {
      milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' as const } },
      events: { orderBy: { ledger: 'desc' as const }, take: 20 },
      trackingUpdates: { orderBy: { createdAt: 'asc' as const } },
      approvals: { orderBy: { createdAt: 'asc' as const } },
      ...(callerUserId
        ? { favorites: { where: { userId: callerUserId }, select: { id: true } } }
        : {}),
    };
    const shipment: any = await db.shipment.findUnique({
      where: { id },
      ...(fields ? { select: this.buildSelect(fields, relations) } : { include: relations }),
    } as any);
    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);
    const serialized = await this.serialize(shipment, callerUserId, precisionOverride, displayCurrency);
    return fields ? pickFields(serialized, fields) : serialized;
  }

  /** Computes the detail representation validator without loading its full relations. */
  async getDetailEtag(id: string): Promise<string> {
    const db = this.prisma.read ?? this.prisma;
    const shipment = await db.shipment.findUnique({
      where: { id },
      select: {
        id: true,
        updatedAt: true,
        milestones: {
          where: { deletedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { updatedAt: true },
        },
      },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);
    return shipmentEtag(shipment, shipment.milestones[0]?.updatedAt);
  }

  /**
   * Evaluates computed risk indicators and derives overall risk level for a shipment.
   */
  async getShipmentRisk(id: string): Promise<ShipmentRiskResult> {
    const db = this.prisma.read;
    const shipment: any = await db.shipment.findUnique({
      where: { id },
      include: {
        milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } },
        trackingUpdates: { orderBy: { createdAt: 'desc' }, take: 1 },
        comments: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 },
        buyer: { select: { id: true, stellarAddress: true, kycStatus: true } },
        supplier: { select: { id: true, stellarAddress: true, kycStatus: true } },
        logistics: { select: { id: true, stellarAddress: true, kycStatus: true } },
        arbiter: { select: { id: true, stellarAddress: true, kycStatus: true } },
      },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }

    return computeShipmentRisk(shipment);
  }

  /**
   * findAll with a short-lived per-caller Redis cache. The key hashes every
   * filter — including the sparse fieldset — so different field selections
   * never share an entry (#390).
   */
  async findAllCached(filters: Parameters<ShipmentsService['findAll']>[0]) {
    const caller = filters.callerStellarAddress;
    if (!caller || filters.search) return this.findAll(filters);

    const key = this.buildCacheKey(caller, filters);
    try {
      const cached = await this.redis.getJson<Awaited<ReturnType<ShipmentsService['findAll']>>>(key);
      if (cached) return cached;
    } catch (err) {
      this.logger.warn(`Shipment list cache read failed: ${(err as Error).message}`);
    }

    const result = await this.findAll(filters);
    try {
      await this.redis.setJson(key, result, this.cacheTtl);
    } catch (err) {
      this.logger.warn(`Shipment list cache write failed: ${(err as Error).message}`);
    }
    return result;
  }

  /**
   * List shipments moved to cold storage by the archival job.
   * Always reads from primary so freshly archived rows are immediately visible.
   */
  async findArchived(filters: {
    page?: number;
    limit?: number;
    callerStellarAddress?: string;
    isAdmin?: boolean;
    status?: ShipmentStatus;
  }) {
    const { page = 1, limit = 20, callerStellarAddress, isAdmin = false, status } = filters;
    const where: any = {};

    if (status) where.status = status;

    if (!isAdmin && callerStellarAddress) {
      where.OR = [
        { buyerAddress: callerStellarAddress },
        { supplierAddress: callerStellarAddress },
        { logisticsAddress: callerStellarAddress },
        { arbiterAddress: callerStellarAddress },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.archivedShipment.findMany({
        where,
        orderBy: { archivedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.archivedShipment.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        ...(row.payload as object),
        id: row.id,
        status: row.status,
        buyerAddress: row.buyerAddress,
        supplierAddress: row.supplierAddress,
        logisticsAddress: row.logisticsAddress,
        arbiterAddress: row.arbiterAddress,
        coldArchivedAt: row.archivedAt,
        terminalAt: row.terminalAt,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findArchivedOne(id: string, callerStellarAddress?: string, isAdmin = false) {
    const row = await this.prisma.archivedShipment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Archived shipment ${id} not found`);

    if (
      !isAdmin &&
      callerStellarAddress &&
      row.buyerAddress !== callerStellarAddress &&
      row.supplierAddress !== callerStellarAddress &&
      row.logisticsAddress !== callerStellarAddress &&
      row.arbiterAddress !== callerStellarAddress
    ) {
      throw new ForbiddenException('Not a participant on this archived shipment');
    }

    return {
      ...(row.payload as object),
      id: row.id,
      status: row.status,
      coldArchivedAt: row.archivedAt,
      terminalAt: row.terminalAt,
    };
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

  async addNote(shipmentId: string, authorId: string, body: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    const note = await this.prisma.shipmentNote.create({
      data: {
        shipmentId,
        authorId,
        body,
      },
    });

    await this.auditLog.record({
      actorId: authorId,
      actorAddress: '',
      action: 'shipment.note_added',
      resourceType: 'Shipment',
      resourceId: shipmentId,
      metadata: { noteId: note.id },
    });

    return note;
  }

  async listNotes(shipmentId: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    return this.prisma.shipmentNote.findMany({
      where: { shipmentId },
      orderBy: { createdAt: 'desc' },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            stellarAddress: true,
          },
        },
      },
    });
  }

  async getRoleSummary(stellarAddress: string): Promise<{
    asBuyer: number;
    asSupplier: number;
    asLogistics: number;
    asArbiter: number;
    total: number;
  }> {
    const activeWhere = { status: ShipmentStatus.ACTIVE };

    const [asBuyer, asSupplier, asLogistics, asArbiter, shipmentIds] = await Promise.all([
      this.prisma.shipment.count({ where: { ...activeWhere, buyerAddress: stellarAddress } }),
      this.prisma.shipment.count({ where: { ...activeWhere, supplierAddress: stellarAddress } }),
      this.prisma.shipment.count({ where: { ...activeWhere, logisticsAddress: stellarAddress } }),
      this.prisma.shipment.count({ where: { ...activeWhere, arbiterAddress: stellarAddress } }),
      this.prisma.shipment.findMany({
        where: {
          ...activeWhere,
          OR: [
            { buyerAddress: stellarAddress },
            { supplierAddress: stellarAddress },
            { logisticsAddress: stellarAddress },
            { arbiterAddress: stellarAddress },
          ],
        },
        select: { id: true },
      }),
    ]);

    return {
      asBuyer,
      asSupplier,
      asLogistics,
      asArbiter,
      total: new Set(shipmentIds.map((shipment) => shipment.id)).size,
    };
  }

  /**
   * Update shipment metadata (description, referenceNumber, metadata, tags).
   * Only the buyer can update a shipment.
   * Financial fields and addresses are immutable and ignored if provided.
   */
  async update(id: string, buyerAddress: string, dto: any, ifMatch?: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }
    await this.assertIfMatch(shipment, ifMatch);

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
    if (dto.expectedDeliveryAt !== undefined) {
      if (shipment.status !== ShipmentStatus.ACTIVE) {
        throw new ConflictException(`Shipment is not ACTIVE (current status: ${shipment.status})`);
      }
      updateData.expectedDeliveryAt = dto.expectedDeliveryAt ? new Date(dto.expectedDeliveryAt) : null;
    }

    const updated = await this.conditionalUpdate(shipment, ifMatch, {
      data: updateData,
      include: {
        milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } },
        events: { orderBy: { ledger: 'desc' }, take: 20 },
      },
    });

    // Record before/after snapshots of the changed fields only (#436).
    const changes = computeFieldChanges(
      shipment as unknown as Record<string, unknown>,
      updateData,
      Object.keys(updateData),
    );
    if (changes.length > 0) {
      await this.auditLog.record({
        actorId: callerId,
        actorAddress: buyerAddress,
        action: 'SHIPMENT_UPDATED',
        resourceType: 'Shipment',
        resourceId: id,
        metadata: { changes },
      });
    }

    this.logger.log(`Shipment updated: ${id}`);
    await this.invalidateUserCache(buyerAddress);
    return await this.serialize(updated);
  }

  /**
   * GET /shipments/:id/history/:auditId/diff (#436)
   * Field-level before/after values for one audit entry. Entries recorded
   * before snapshots existed return an empty diff.
   */
  async getHistoryDiff(shipmentId: string, auditId: string, isAdmin = false) {
    const entry = await this.prisma.auditLog.findFirst({
      where: {
        id: auditId,
        OR: [
          { resourceType: 'Shipment', resourceId: shipmentId },
          { entityType: 'Shipment', entityId: shipmentId },
        ],
      },
    });
    if (!entry) {
      throw new NotFoundException(`Audit entry ${auditId} not found for shipment ${shipmentId}`);
    }
    const changes = extractChanges(entry.metadata);
    return isAdmin ? changes : changes.filter((c) => !isHiddenField(c.field));
  }

  /**
   * GET /shipments/:id/documents
   * Return every IPFS document linked to a shipment (proofs, dispute evidence, comment attachments)
   * in one list, filtered by visibility rules and optional source filter, sorted by uploadedAt desc.
   */
  async getDocuments(
    shipmentId: string,
    callerAddress: string,
    isAdmin = false,
    source?: string,
  ): Promise<ShipmentDocumentDto[]> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        id: true,
        buyerAddress: true,
        supplierAddress: true,
        logisticsAddress: true,
        arbiterAddress: true,
      },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    if (
      !isAdmin &&
      callerAddress !== shipment.buyerAddress &&
      callerAddress !== shipment.supplierAddress &&
      callerAddress !== shipment.logisticsAddress &&
      callerAddress !== shipment.arbiterAddress
    ) {
      throw new ForbiddenException('Only shipment participants can view shipment documents');
    }

    // Comment visibility filtering
    const isBuyerOrSupplier =
      callerAddress === shipment.buyerAddress || callerAddress === shipment.supplierAddress;
    const isInternalParty =
      callerAddress === shipment.logisticsAddress || callerAddress === shipment.arbiterAddress;

    const allowedVisibilities: CommentVisibility[] = [CommentVisibility.ALL];
    if (isBuyerOrSupplier) allowedVisibilities.push(CommentVisibility.BUYER_SUPPLIER);
    if (isInternalParty) allowedVisibilities.push(CommentVisibility.INTERNAL);
    if (isAdmin) {
      allowedVisibilities.push(CommentVisibility.BUYER_SUPPLIER, CommentVisibility.INTERNAL);
    }

    const [proofs, evidence, comments] = await Promise.all([
      this.prisma.proofSubmission.findMany({
        where: {
          milestone: {
            shipmentId,
            deletedAt: null,
          },
        },
        include: {
          milestone: {
            select: { milestoneIndex: true },
          },
        },
      }),
      this.prisma.disputeEvidence.findMany({
        where: {
          milestone: {
            shipmentId,
            deletedAt: null,
          },
          ipfsCid: { not: null },
        },
        include: {
          milestone: {
            select: { milestoneIndex: true },
          },
        },
      }),
      this.prisma.shipmentComment.findMany({
        where: {
          shipmentId,
          deletedAt: null,
          attachmentCid: { not: null },
          visibility: { in: allowedVisibilities },
        },
        include: {
          author: {
            select: { stellarAddress: true },
          },
        },
      }),
    ]);

    const items: ShipmentDocumentDto[] = [];

    for (const p of proofs) {
      if (p.ipfsCid) {
        items.push({
          source: 'PROOF',
          cid: p.ipfsCid,
          uploadedBy: p.submittedBy,
          uploadedAt: p.createdAt,
          milestoneIndex: p.milestone?.milestoneIndex ?? undefined,
          downloadUrl: `/api/v1/ipfs/${p.ipfsCid}`,
        });
      }
    }

    for (const e of evidence) {
      if (e.ipfsCid) {
        items.push({
          source: 'DISPUTE_EVIDENCE',
          cid: e.ipfsCid,
          fileName: e.fileName ?? undefined,
          mimeType: e.mimeType ?? undefined,
          uploadedBy: e.submittedBy,
          uploadedAt: e.createdAt,
          milestoneIndex: e.milestone?.milestoneIndex ?? undefined,
          downloadUrl: `/api/v1/ipfs/${e.ipfsCid}`,
        });
      }
    }

    for (const c of comments) {
      if (c.attachmentCid) {
        items.push({
          source: 'COMMENT',
          cid: c.attachmentCid,
          uploadedBy: c.author?.stellarAddress ?? c.authorId,
          uploadedAt: c.createdAt,
          milestoneIndex: c.milestoneIndex ?? undefined,
          downloadUrl: `/api/v1/ipfs/${c.attachmentCid}`,
        });
      }
    }

    let filtered = items;
    if (source) {
      const normalized = source.toUpperCase().trim();
      filtered = filtered.filter((item) => {
        if (normalized === 'PROOF' || normalized === 'PROOF_SUBMISSION') {
          return item.source === 'PROOF';
        }
        return item.source === normalized;
      });
    }

    filtered.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

    return filtered;
  }

  async replaceTags(
    id: string,
    tags: string[] | undefined,
    callerAddress?: string,
    callerId?: string,
    ifMatch?: string,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      select: { id: true, tags: true, updatedAt: true },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }
    await this.assertIfMatch(shipment, ifMatch);

    if (!Array.isArray(tags)) {
      throw new BadRequestException('tags must be an array');
    }

    const normalizedTags = new Map<string, string>();
    for (const tag of tags) {
      if (typeof tag !== 'string') {
        throw new BadRequestException('each tag must be a string');
      }

      const trimmed = tag.trim();
      if (trimmed.length < 1 || trimmed.length > 30) {
        throw new BadRequestException('each tag must be between 1 and 30 characters');
      }

      const key = trimmed.toLowerCase();
      if (!normalizedTags.has(key)) {
        normalizedTags.set(key, trimmed);
      }
    }

    if (normalizedTags.size > 20) {
      throw new BadRequestException('A shipment can have at most 20 tags');
    }

    const nextTags = Array.from(normalizedTags.values());

    const updated = await this.conditionalUpdate(shipment, ifMatch, {
      data: { tags: nextTags },
      include: {
        milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } },
        events: { orderBy: { ledger: 'desc' }, take: 20 },
      },
    });

    await this.auditLog.record({
      actorId: callerId,
      actorAddress: callerAddress ?? 'unknown',
      action: 'SHIPMENT_TAGS_REPLACED',
      resourceType: 'Shipment',
      resourceId: id,
      metadata: {
        previousTags: shipment.tags,
        nextTags,
        changes: computeFieldChanges({ tags: shipment.tags }, { tags: nextTags }, ['tags']),
      },
    });

    this.logger.log(`Shipment tags replaced: ${id}`);
    return await this.serialize(updated);
  }

  // ----------------------------------------------------------
  // OPTIMISTIC CONCURRENCY (#387)
  // ----------------------------------------------------------

  /** Returns the current ETag for a shipment. */
  async getEtag(id: string): Promise<string> {
    return this.getDetailEtag(id);
  }

  private async assertIfMatch(shipment: { id: string; updatedAt: Date }, ifMatch?: string) {
    if (ifMatch === undefined || ifMatch === null || ifMatch === '') {
      if (this.config.get<string>('SHIPMENT_REQUIRE_IF_MATCH') === 'true') {
        throw new PreconditionFailedException('If-Match header is required');
      }
      return;
    }
    if (!ifMatchSatisfied(ifMatch, await this.getDetailEtag(shipment.id))) {
      throw new PreconditionFailedException('Shipment has been modified; refetch and retry');
    }
  }

  /**
   * Updates a shipment, and when an If-Match was supplied also pins the write
   * to the updatedAt that was checked so a concurrent writer that slipped in
   * between the read and the write causes a 412 instead of a lost update.
   */
  private async conditionalUpdate(
    shipment: { id: string; updatedAt: Date },
    ifMatch: string | undefined,
    args: { data: any; include?: any },
  ) {
    const where: any = ifMatch
      ? { id: shipment.id, updatedAt: shipment.updatedAt }
      : { id: shipment.id };
    try {
      return await this.prisma.shipment.update({ where, ...args });
    } catch (err: any) {
      if (ifMatch && err?.code === 'P2025') {
        throw new PreconditionFailedException('Shipment has been modified; refetch and retry');
      }
      throw err;
    }
  }

  // ----------------------------------------------------------
  // DUPLICATE CHECK (#388)
  // ----------------------------------------------------------

  /**
   * Finds the caller's ACTIVE shipments that look like duplicates of a
   * shipment about to be created. Read-only.
   */
  async findPossibleDuplicates(
    buyerAddress: string,
    dto: { supplierAddress?: string; tokenAddress?: string; totalAmount?: string; referenceNumber?: string },
  ) {
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    let amount: bigint | undefined;
    try {
      amount = dto.totalAmount !== undefined ? BigInt(dto.totalAmount) : undefined;
    } catch {
      throw new BadRequestException('totalAmount must be an integer string');
    }

    const or: any[] = [];
    if (dto.supplierAddress && dto.tokenAddress && amount !== undefined) {
      or.push({
        supplierAddress: dto.supplierAddress,
        tokenAddress: dto.tokenAddress,
        totalAmount: amount,
        createdAt: { gte: since },
      });
    }
    if (dto.referenceNumber) {
      or.push({ referenceNumber: dto.referenceNumber });
    }
    if (or.length === 0) return { possibleDuplicates: [] };

    const matches = await this.prisma.shipment.findMany({
      where: { buyerAddress, status: ShipmentStatus.ACTIVE, OR: or },
      select: {
        id: true,
        createdAt: true,
        referenceNumber: true,
        supplierAddress: true,
        tokenAddress: true,
        totalAmount: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      possibleDuplicates: matches.map((m) => {
        const matchReasons: string[] = [];
        if (
          amount !== undefined &&
          m.supplierAddress === dto.supplierAddress &&
          m.tokenAddress === dto.tokenAddress &&
          BigInt(m.totalAmount) === amount &&
          m.createdAt >= since
        ) {
          matchReasons.push('SAME_SUPPLIER_TOKEN_AMOUNT_WITHIN_7_DAYS');
        }
        if (dto.referenceNumber && m.referenceNumber === dto.referenceNumber) {
          matchReasons.push('SAME_REFERENCE_NUMBER');
        }
        return { id: m.id, createdAt: m.createdAt, referenceNumber: m.referenceNumber, matchReasons };
      }),
    };
  }

  // ----------------------------------------------------------
  // TAGS — atomic add/remove
  // ----------------------------------------------------------

  /**
   * Atomically add a tag to a shipment.
   * Only the buyer can add tags, and only when shipment is ACTIVE.
   * Uses Prisma `push` for atomic append at the DB level.
   */
  async addTag(id: string, buyerAddress: string, tag: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      select: { buyerAddress: true, status: true, tags: true },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }

    if (shipment.buyerAddress !== buyerAddress) {
      throw new ForbiddenException('Only the shipment buyer can modify tags');
    }

    if (shipment.status !== ShipmentStatus.ACTIVE) {
      throw new ConflictException(`Shipment is not ACTIVE (current status: ${shipment.status})`);
    }

    // Check if tag already exists
    if (shipment.tags.includes(tag)) {
      throw new ConflictException(`Tag "${tag}" already exists on shipment ${id}`);
    }

    // Atomic append using Prisma push
    const updated = await this.prisma.shipment.update({
      where: { id },
      data: {
        tags: {
          push: [tag],
        },
      },
      include: {
        milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } },
        events: { orderBy: { ledger: 'desc' }, take: 20 },
      },
    });

    this.logger.log(`Tag "${tag}" added to shipment ${id} by buyer ${buyerAddress}`);
    await this.invalidateUserCache(buyerAddress);
    return await this.serialize(updated);
  }

  /**
   * Atomically remove a tag from a shipment.
   * Only the buyer can remove tags, and only when shipment is ACTIVE.
   * Uses PostgreSQL array_remove via $executeRaw for atomic removal.
   */
  async removeTag(id: string, buyerAddress: string, tag: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      select: { buyerAddress: true, status: true, tags: true },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }

    if (shipment.buyerAddress !== buyerAddress) {
      throw new ForbiddenException('Only the shipment buyer can modify tags');
    }

    if (shipment.status !== ShipmentStatus.ACTIVE) {
      throw new ConflictException(`Shipment is not ACTIVE (current status: ${shipment.status})`);
    }

    // Check if tag exists
    if (!shipment.tags.includes(tag)) {
      throw new NotFoundException(`Tag "${tag}" not found on shipment ${id}`);
    }

    // Atomic removal using PostgreSQL array_remove
    await this.prisma.$executeRaw`
      UPDATE shipments 
      SET tags = array_remove(tags, ${tag})
      WHERE id = ${id}
    `;

    // Fetch the updated shipment
    const updated = await this.prisma.shipment.findUnique({
      where: { id },
      include: {
        milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } },
        events: { orderBy: { ledger: 'desc' }, take: 20 },
      },
    });

    this.logger.log(`Tag "${tag}" removed from shipment ${id} by buyer ${buyerAddress}`);
    await this.invalidateUserCache(buyerAddress);
    return await this.serialize(updated);
  }

  // ----------------------------------------------------------
  // REFUND DETAIL
  // ----------------------------------------------------------

  /**
   * Returns refund details for a cancelled shipment.
   * Looks up the shipment_cancelled ChainEvent to extract the refunded amount.
   */
  async getRefundDetail(id: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }

    if (!shipment.cancelledAt) {
      throw new NotFoundException(`Shipment ${id} has not been cancelled`);
    }

    // Look up the corresponding ChainEvent for refund amount
    const cancelEvent = await this.prisma.chainEvent.findFirst({
      where: {
        shipmentId: id,
        eventName: 'shipment_cancelled',
      },
      orderBy: { ledger: 'desc' },
    });

    if (!cancelEvent) {
      throw new InternalServerErrorException(
        `Cancellation chain event not found for shipment ${id}. The on-chain event may not have been processed yet.`,
      );
    }

    // Extract refunded amount from the event payload.
    // Payload is expected to be [shipmentId, refundedAmount] (matching other event shapes).
    // If only shipmentId is present, fall back to totalAmount as the refund.
    let refundedAmountRaw: bigint;
    try {
      const payload = cancelEvent.payload as any;
      if (Array.isArray(payload) && payload.length >= 2) {
        refundedAmountRaw = BigInt(payload[1] ?? 0);
      } else {
        // Fallback: full escrow amount is refunded on cancellation
        refundedAmountRaw = shipment.totalAmount;
      }
    } catch {
      this.logger.warn(
        `Failed to parse refund amount from payload for shipment ${id}, falling back to totalAmount`,
      );
      refundedAmountRaw = shipment.totalAmount;
    }

    const decimals: number = shipment.tokenDecimals ?? 7;

    return {
      cancelledAt: shipment.cancelledAt.toISOString(),
      refundTxHash: shipment.refundTxHash ?? cancelEvent.txHash,
      refundedAmount: this.stellar.toHumanAmount(refundedAmountRaw, decimals),
      refundedTo: shipment.buyerAddress,
    };
  }

  // ----------------------------------------------------------
  private async getArbiterWarnings(arbiterAddress: string, buyerAddress: string, supplierAddress: string): Promise<string[]> {
    const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const relatedTrade = await this.prisma.shipment.findFirst({ where: { createdAt: { gte: since }, OR: [
      { buyerAddress: arbiterAddress, supplierAddress: { in: [buyerAddress, supplierAddress] } },
      { supplierAddress: arbiterAddress, buyerAddress: { in: [buyerAddress, supplierAddress] } },
    ] }, select: { id: true } });
    const [total, sameBuyer] = await Promise.all([
      this.prisma.milestone.count({ where: { status: 'RESOLVED', shipment: { arbiterAddress } } }),
      this.prisma.milestone.count({ where: { status: 'RESOLVED', shipment: { arbiterAddress, buyerAddress } } }),
    ]);
    const threshold = Math.min(1, Math.max(0, Number(process.env.ARBITER_REPEAT_BUYER_WARNING_THRESHOLD ?? 0.5)));
    const warnings: string[] = [];
    if (relatedTrade) warnings.push('Arbiter has traded with a shipment party in the last 12 months.');
    if (total > 0 && sameBuyer / total > threshold) warnings.push(`More than ${Math.round(threshold * 100)}% of this arbiter's past resolutions involved this buyer.`);
    return warnings;
  }

  async replaceArbiter(id: string, buyerAddress: string, arbiterAddress: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id } });
    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);
    if (shipment.buyerAddress !== buyerAddress) throw new ForbiddenException('Only the buyer may replace the arbiter');
    if (shipment.arbiterStatus === ArbiterStatus.ACCEPTED) throw new ConflictException('An accepted arbiter cannot be replaced');
    if ([shipment.buyerAddress, shipment.supplierAddress, shipment.logisticsAddress].some(a => a.toLowerCase() === arbiterAddress.toLowerCase())) throw new BadRequestException({ code: 'ARBITER_CONFLICT', message: 'Arbiter cannot be a shipment party' });
    const updated = await this.prisma.shipment.update({ where: { id }, data: { arbiterAddress, arbiterStatus: ArbiterStatus.PENDING_ACCEPTANCE } });
    await this.notifications.notifyUser(arbiterAddress, NotificationType.ARBITER_INVITED, 'Arbiter assignment invitation', `You have been assigned as arbiter for shipment ${id}.`, { shipmentId: id, buyerAddress, supplierAddress: shipment.supplierAddress });
    return { ...(await this.serialize(updated)), warnings: await this.getArbiterWarnings(arbiterAddress, buyerAddress, shipment.supplierAddress) };
  }
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
    return await this.serialize(updated);
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
    return await this.serialize(updated);
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
      data: {
        status: ShipmentStatus.CANCELLED,
        txHash,
        cancelledAt: new Date(),
        refundTxHash: txHash || undefined,
      },
      include: { milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Shipment ${id} cancelled by buyer ${buyerAddress}`);
    this.metrics.decrementActiveShipments();
    await this.invalidateUserCache(buyerAddress);
    
    await this.notifications.notifyWatchers(
      id,
      NotificationType.SHIPMENT_CANCELLED,
      'Shipment Cancelled',
      `Shipment ${id} has been cancelled.`,
      { shipmentId: id }
    );

    return await this.serialize(updated);
  }

  // ----------------------------------------------------------
  // REFUND DETAIL
  // ----------------------------------------------------------

  /**
   * Returns refund details for a cancelled shipment.
   * Looks up the shipment_cancelled ChainEvent to extract the refunded amount.
   */
  async getRefundDetail(id: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }

    if (!shipment.cancelledAt) {
      throw new NotFoundException(`Shipment ${id} has not been cancelled`);
    }

    // Look up the corresponding ChainEvent for refund amount
    const cancelEvent = await this.prisma.chainEvent.findFirst({
      where: {
        shipmentId: id,
        eventName: 'shipment_cancelled',
      },
      orderBy: { ledger: 'desc' },
    });

    if (!cancelEvent) {
      throw new InternalServerErrorException(
        `Cancellation chain event not found for shipment ${id}. The on-chain event may not have been processed yet.`,
      );
    }

    // Extract refunded amount from the event payload.
    // Payload is expected to be [shipmentId, refundedAmount].
    // Falls back to totalAmount if payload doesn't include amount.
    let refundedAmountRaw: bigint;
    try {
      const payload = cancelEvent.payload as any;
      if (Array.isArray(payload) && payload.length >= 2) {
        refundedAmountRaw = BigInt(payload[1] ?? 0);
      } else {
        refundedAmountRaw = shipment.totalAmount;
      }
    } catch {
      this.logger.warn(
        `Failed to parse refund amount from payload for shipment ${id}, falling back to totalAmount`,
      );
      refundedAmountRaw = shipment.totalAmount;
    }

    const decimals: number = shipment.tokenDecimals ?? 7;

    return {
      cancelledAt: shipment.cancelledAt.toISOString(),
      refundTxHash: shipment.refundTxHash ?? cancelEvent.txHash,
      refundedAmount: this.stellar.toHumanAmount(refundedAmountRaw, decimals),
      refundedTo: shipment.buyerAddress,
    };
  }

  // ----------------------------------------------------------
  // CLONE — copy structure into a new ACTIVE shipment
  // ----------------------------------------------------------

  async clone(id: string, buyerAddress: string, dto: CloneShipmentDto) {
    const source = await this.prisma.shipment.findUnique({
      where: { id },
      include: { milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } } },
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
    return await this.serialize(cloned);
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
      include: { milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Shipment ${id} archived by buyer ${buyerAddress}`);
    
    await this.notifications.notifyWatchers(
      id,
      NotificationType.SYSTEM_ALERT,
      'Shipment Archived',
      `Shipment ${id} has been archived.`,
      { shipmentId: id }
    );

    return await this.serialize(updated);
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
      include: { milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Shipment ${id} unarchived by buyer ${buyerAddress}`);
    return await this.serialize(updated);
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
  // METADATA VALIDATION
  // ----------------------------------------------------------

  async validateMetadata(id: string, schemaKey: 'incoterms' | 'customs') {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      select: { metadata: true },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }

    if (!shipment.metadata) {
      throw new NotFoundException(`Shipment ${id} has no metadata set`);
    }

    const ajv = new Ajv({ allErrors: true });
    const schema = metadataSchemas[schemaKey];
    const validate = ajv.compile(schema);
    const valid = validate(shipment.metadata);

    if (valid) {
      return { valid: true, errors: [] };
    }

    const errors = validate.errors?.map((err) => ({
      path: err.instancePath,
      message: err.message,
    })) || [];

    return { valid: false, errors };
  }

  // ----------------------------------------------------------
  // FAVORITES
  // ----------------------------------------------------------

  async favoriteShipment(shipmentId: string, userId: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);

    const existing = await this.prisma.shipmentFavorite.findFirst({
      where: { shipmentId, userId },
    });

    if (!existing) {
      await this.prisma.shipmentFavorite.create({
        data: { shipmentId, userId },
      });
    }

    return { favorited: true, shipmentId, userId };
  }

  async unfavoriteShipment(shipmentId: string, userId: string) {
    await this.prisma.shipmentFavorite.deleteMany({
      where: { shipmentId, userId },
    });

    return { unfavorited: true };
  }

  // ----------------------------------------------------------
  // WATCHERS
  // ----------------------------------------------------------

  async watchShipment(shipmentId: string, stellarAddress: string) {
    const user = await this.prisma.user.findUnique({
      where: { stellarAddress },
    });
    if (!user) throw new NotFoundException('User not found');

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);

    const existing = await this.prisma.shipmentWatcher.findFirst({
      where: { shipmentId, userId: user.id },
    });

    if (!existing) {
      await this.prisma.shipmentWatcher.create({
        data: { shipmentId, userId: user.id },
      });
    }

    return { watched: true, shipmentId, userId: user.id };
  }

  async unwatchShipment(shipmentId: string, stellarAddress: string) {
    const user = await this.prisma.user.findUnique({
      where: { stellarAddress },
    });
    if (!user) return { unwatched: true }; // No user, so they aren't watching

    await this.prisma.shipmentWatcher.deleteMany({
      where: { shipmentId, userId: user.id },
    });

    return { unwatched: true };
  }

  async getWatchers(shipmentId: string) {
    const watchers = await this.prisma.shipmentWatcher.findMany({
      where: { shipmentId },
      include: {
        user: { select: { id: true, stellarAddress: true, name: true, role: true } },
      },
    });
    return watchers.map(w => w.user);
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
      select: { logisticsAddress: true, buyerAddress: true, supplierAddress: true, id: true, expectedDeliveryAt: true },
    });

    if (!shipment) {
      throw new ForbiddenException(`Shipment ${shipmentId} not found`);
    }

    if (shipment.logisticsAddress !== callerAddress) {
      throw new ForbiddenException('Only the logistics participant can submit tracking updates');
    }

    const latestPriorTracking = await this.prisma.trackingUpdate.findFirst({
      where: { shipmentId: shipment.id },
      orderBy: { createdAt: 'desc' },
    });

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

    // If tracking update has an estimatedArrival later than expectedDeliveryAt, notify buyer and supplier (DELIVERY_DELAYED)
    if (dto.estimatedArrival && shipment.expectedDeliveryAt) {
      const newEta = new Date(dto.estimatedArrival);
      if (newEta > shipment.expectedDeliveryAt) {
        const priorEtaTime = latestPriorTracking?.estimatedArrival
          ? new Date(latestPriorTracking.estimatedArrival).getTime()
          : null;
        if (newEta.getTime() !== priorEtaTime) {
          const delayTitle = 'Shipment delivery delayed';
          const delayMessage = `Delivery for shipment ${shipment.id} is delayed. New ETA: ${newEta.toISOString()} (promised: ${shipment.expectedDeliveryAt.toISOString()}).`;
          const delayPayload = {
            shipmentId: shipment.id,
            expectedDeliveryAt: shipment.expectedDeliveryAt.toISOString(),
            estimatedArrival: newEta.toISOString(),
          };

          await this.notifications.notifyUser(
            shipment.buyerAddress,
            NotificationType.DELIVERY_DELAYED,
            delayTitle,
            delayMessage,
            delayPayload,
          );

          await this.notifications.notifyUser(
            shipment.supplierAddress,
            NotificationType.DELIVERY_DELAYED,
            delayTitle,
            delayMessage,
            delayPayload,
          );
        }
      }
    }

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
        buyer: { select: { name: true, organizationName: true, countryCode: true } },
        supplier: { select: { name: true, organizationName: true, countryCode: true } },
        logistics: { select: { name: true, organizationName: true, countryCode: true } },
        arbiter: { select: { name: true, organizationName: true, countryCode: true } },
      },
    });

    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);

    return [
      { role: 'BUYER', stellarAddress: shipment.buyerAddress, name: shipment.buyer.name ?? null, organizationName: shipment.buyer.organizationName ?? null, countryCode: shipment.buyer.countryCode ?? null },
      { role: 'SUPPLIER', stellarAddress: shipment.supplierAddress, name: shipment.supplier.name ?? null, organizationName: shipment.supplier.organizationName ?? null, countryCode: shipment.supplier.countryCode ?? null },
      { role: 'LOGISTICS', stellarAddress: shipment.logisticsAddress, name: shipment.logistics.name ?? null, organizationName: shipment.logistics.organizationName ?? null, countryCode: shipment.logistics.countryCode ?? null },
      { role: 'ARBITER', stellarAddress: shipment.arbiterAddress, name: shipment.arbiter.name ?? null, organizationName: shipment.arbiter.organizationName ?? null, countryCode: shipment.arbiter.countryCode ?? null, arbiterStatus: shipment.arbiterStatus },
    ];
  }

  // ----------------------------------------------------------
  // ADMIN — force resync bypassing participant guard
  // ----------------------------------------------------------

  /**
   * Admin-only resync of a shipment from chain, bypassing the participant
   * ownership check. Reuses the same chain-read logic as the
   * participant-facing sync endpoint, then writes an audit log entry
   * since this bypasses the normal ownership guard.
   */
  async adminForceSync(shipmentId: string, adminUserId: string, adminAddress: string) {
    await this.syncStatusFromChain(shipmentId);

    await this.auditLog.record({
      actorId: adminUserId,
      actorAddress: adminAddress,
      action: 'ADMIN_FORCE_SYNC',
      resourceType: 'Shipment',
      resourceId: shipmentId,
      metadata: { adminUserId, shipmentId },
    });

    this.logger.log(`Shipment ${shipmentId} force-synced by admin ${adminUserId}`);
    return this.findOne(shipmentId);
  }

  // ----------------------------------------------------------
  // ADMIN — find shipments with no recent milestone activity
  // ----------------------------------------------------------

  /**
   * Finds ACTIVE shipments where the most recent milestone update (or the
   * shipment's own updatedAt, when it has no milestones) is older than
   * `minDays` days. Used by admins to surface shipments that look
   * abandoned so they can follow up.
   */
  async findStuckShipments(minDays: number, page = 1, limit = 20) {
    const offset = (page - 1) * limit;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        buyerAddress: string;
        supplierAddress: string;
        lastActivityAt: Date;
      }>
    >`
      SELECT
        s.id,
        s."buyerAddress"    AS "buyerAddress",
        s."supplierAddress" AS "supplierAddress",
        COALESCE(MAX(m."updatedAt"), s."updatedAt") AS "lastActivityAt"
      FROM shipments s
      LEFT JOIN milestones m ON m."shipmentId" = s.id
      WHERE s.status = 'ACTIVE'
      GROUP BY s.id
      HAVING COALESCE(MAX(m."updatedAt"), s."updatedAt") < now() - make_interval(days => ${minDays})
      ORDER BY "lastActivityAt" ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countResult = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT s.id
        FROM shipments s
        LEFT JOIN milestones m ON m."shipmentId" = s.id
        WHERE s.status = 'ACTIVE'
        GROUP BY s.id
        HAVING COALESCE(MAX(m."updatedAt"), s."updatedAt") < now() - make_interval(days => ${minDays})
      ) sub
    `;

    const total = Number(countResult[0]?.count ?? 0);
    const now = Date.now();

    const data = rows.map((r) => ({
      id: r.id,
      buyerAddress: r.buyerAddress,
      supplierAddress: r.supplierAddress,
      lastActivityAt: r.lastActivityAt.toISOString(),
      daysSinceActivity: Math.floor((now - r.lastActivityAt.getTime()) / 86_400_000),
    }));

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
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
    } catch (error: any) {
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

    const userSelect = { select: { name: true, organizationName: true } };

    return this.prisma.shipment.findMany({
      where,
      include: {
        milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } },
        buyer:     userSelect,
        supplier:  userSelect,
        logistics: userSelect,
        arbiter:   userSelect,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  buildCsv(shipments: any[]): string {
    const headers = [
      'shipmentId', 'buyerAddress', 'supplierAddress', 'logisticsAddress',
      'arbiterAddress', 'totalAmount', 'releasedAmount', 'status', 'createdAt',
      'expectedDeliveryAt',
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
        s.expectedDeliveryAt ? (s.expectedDeliveryAt instanceof Date ? s.expectedDeliveryAt.toISOString() : new Date(s.expectedDeliveryAt).toISOString()) : '',
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
          ['Buyer',     s.buyerAddress,     s.buyer],
          ['Supplier',  s.supplierAddress,  s.supplier],
          ['Logistics', s.logisticsAddress, s.logistics],
          ['Arbiter',   s.arbiterAddress,   s.arbiter],
        ];
        for (const [role, addr, user] of participants) {
          const label = user?.organizationName
            ? `${role}: ${addr} (${user.organizationName})`
            : `${role}: ${addr}`;
          doc.text(label);
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
        milestones: {
          where: { deletedAt: null },
          orderBy: { milestoneIndex: 'asc' },
          include: { proofSubmissions: { orderBy: { createdAt: 'desc' }, take: 1 } },
        },
        events: { orderBy: { ledger: 'desc' }, take: 50 },
        comments: { where: { visibility: 'ALL' }, orderBy: { createdAt: 'asc' } },
        buyer:     { select: { name: true, organizationName: true } },
        supplier:  { select: { name: true, organizationName: true } },
        logistics: { select: { name: true, organizationName: true } },
        arbiter:   { select: { name: true, organizationName: true } },
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
        ['Buyer',     shipment.buyerAddress,     shipment.buyer],
        ['Supplier',  shipment.supplierAddress,  shipment.supplier],
        ['Logistics', shipment.logisticsAddress, shipment.logistics],
        ['Arbiter',   shipment.arbiterAddress,   shipment.arbiter],
      ];
      for (const [role, addr, user] of participants) {
        const label = (user as any)?.organizationName
          ? `${role}: ${addr} (${(user as any).organizationName})`
          : `${role}: ${addr}`;
        doc.text(label);
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
            (m.proofHash ? ` — Proof: ${m.proofHash}` : '') +
            (m.proofSubmissions?.[0]?.sha256 ? ` — SHA-256: ${m.proofSubmissions[0].sha256}` : ''),
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
  // VALUE RELEASED OVER TIME — time series for charting
  // ----------------------------------------------------------

  async getPaymentTimeSeries(id: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      select: {
        totalAmount: true,
        tokenDecimals: true,
        tokenSymbol: true,
      },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);

    const milestones = await this.prisma.milestone.findMany({
      where: {
        shipmentId: id,
        status: { in: ['CONFIRMED', 'RESOLVED'] as any },
        confirmedAt: { not: null },
      },
      orderBy: { confirmedAt: 'asc' },
    });

    const decimals: number = shipment.tokenDecimals ?? 7;
    const totalAmount: bigint = shipment.totalAmount ?? 0n;

    let cumulative = 0n;
    const entries = milestones.map((m) => {
      const amount: bigint = m.paymentReleased ?? 0n;
      cumulative += amount;
      const percentComplete =
        totalAmount > 0n
          ? Math.round(Number((cumulative * 10000n) / totalAmount)) / 100
          : 0;

      return {
        milestoneIndex: m.milestoneIndex,
        name: m.name,
        releasedAt: m.confirmedAt!.toISOString(),
        amount: this.stellar.toHumanAmount(amount, decimals),
        cumulativeReleased: this.stellar.toHumanAmount(cumulative, decimals),
        percentComplete,
      };
    });

    const percentComplete =
      totalAmount > 0n
        ? Math.round(Number((cumulative * 10000n) / totalAmount)) / 100
        : 0;

    return {
      entries,
      summary: {
        totalReleased: this.stellar.toHumanAmount(cumulative, decimals),
        totalAmount: this.stellar.toHumanAmount(totalAmount, decimals),
        percentComplete,
        remainingAmount: this.stellar.toHumanAmount(
          totalAmount > cumulative ? totalAmount - cumulative : 0n,
          decimals,
        ),
      },
    };
  }

  // ----------------------------------------------------------
  // CSV BULK IMPORT — create draft shipments from CSV
  // ----------------------------------------------------------

  /**
   * Parses a CSV buffer and creates draft shipment records.
   * Each row is processed independently — a malformed row does not affect
   * valid rows. The caller (buyer) is set as the buyerAddress for all rows.
   *
   * CSV columns (case-insensitive header):
   *   supplierAddress, logisticsAddress, arbiterAddress, tokenAddress,
   *   totalAmount, description, referenceNumber
   *
   * @returns Per-row result array with { row, status, shipmentId?, error? }
   */
  async importDrafts(
    userId: string,
    buyerAddress: string,
    csvBuffer: Buffer,
  ): Promise<{ results: Array<{ row: number; status: 'created' | 'error'; shipmentId?: string; error?: string }> }> {
    const raw: string = csvBuffer.toString('utf-8').replace(/^\uFEFF/, ''); // strip BOM

    const records: any[] = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
    });

    if (records.length > 100) {
      throw new BadRequestException(
        `CSV file has ${records.length} rows; maximum allowed is 100 rows per import.`,
      );
    }

    const results: Array<{ row: number; status: 'created' | 'error'; shipmentId?: string; error?: string }> = [];
    const tokenRegistry = this.tokenRegistry;

    for (let i = 0; i < records.length; i++) {
      const rowNum = i + 2; // 1-indexed + header row
      const r = records[i];

      try {
        // Normalise header names (case-insensitive)
        const supplierAddress = (r.supplierAddress ?? r.supplieraddress ?? '').trim();
        const logisticsAddress = (r.logisticsAddress ?? r.logisticsaddress ?? '').trim();
        const arbiterAddress = (r.arbiterAddress ?? r.arbiteraddress ?? '').trim();
        const tokenAddress = (r.tokenAddress ?? r.tokenaddress ?? '').trim();
        const totalAmount = (r.totalAmount ?? r.totalamount ?? '').trim();
        const description = (r.description ?? '').trim();
        const referenceNumber = (r.referenceNumber ?? r.referencenumber ?? '').trim();

        if (arbiterAddress && [buyerAddress, supplierAddress, logisticsAddress].some(a => a.toLowerCase() === arbiterAddress.toLowerCase())) throw new BadRequestException({ code: 'ARBITER_CONFLICT', message: 'Arbiter cannot be a shipment party' });

        // Validate required fields
        if (!supplierAddress) throw new Error('supplierAddress is required');
        if (!logisticsAddress) throw new Error('logisticsAddress is required');
        if (!arbiterAddress) throw new Error('arbiterAddress is required');
        if (!tokenAddress) throw new Error('tokenAddress is required');
        if (!totalAmount) throw new Error('totalAmount is required');

        // Validate totalAmount is a positive integer string
        const amountMatch = totalAmount.match(/^\d+$/);
        if (!amountMatch) {
          throw new Error(`totalAmount must be a positive integer (got "${totalAmount}")`);
        }
        const amountBigInt = BigInt(totalAmount);
        if (amountBigInt <= 0n) {
          throw new Error(`totalAmount must be greater than 0 (got ${totalAmount})`);
        }

        // Validate description length
        if (description && description.length > 1000) {
          throw new Error('description must be at most 1000 characters');
        }

        // Check for duplicate referenceNumber
        if (referenceNumber) {
          const existing = await this.prisma.shipment.findUnique({
            where: { referenceNumber },
          });
          if (existing) {
            throw new Error(`referenceNumber "${referenceNumber}" is already in use by shipment ${existing.id}`);
          }
        }

        // Resolve token metadata
        let token: { decimals: number; symbol: string };
        try {
          token = tokenRegistry.getToken(tokenAddress);
        } catch {
          throw new Error(`Unknown tokenAddress "${tokenAddress}"`);
        }

        // Parse milestones if provided
        const milestoneData: { name: string; paymentPercent: number; milestoneIndex: number }[] = [];
        if (milestonesRaw) {
          const parts = milestonesRaw.split('|');
          let sum = 0;
          for (let idx = 0; idx < parts.length; idx++) {
            const part = parts[idx];
            const [name, percentStr] = part.split(':');
            if (!name || !percentStr) {
              throw new Error(`Invalid milestone format in "${part}". Expected Name:Percent`);
            }
            const percent = parseInt(percentStr.trim(), 10);
            if (isNaN(percent) || percent <= 0) {
              throw new Error(`Milestone percentage must be a positive number in "${part}"`);
            }
            sum += percent;
            milestoneData.push({ name: name.trim(), paymentPercent: percent, milestoneIndex: idx });
          }
          if (sum !== 100) {
            throw new Error(`Milestone percentages must sum to 100. Got ${sum}.`);
          }
        }

        const shipmentId = randomUUID();

        const shipment = await this.prisma.shipment.create({
          data: {
            id: shipmentId,
            buyerAddress,
            supplierAddress,
            logisticsAddress,
            arbiterAddress,
            tokenAddress,
            tokenDecimals: token.decimals,
            tokenSymbol: token.symbol,
            totalAmount: amountBigInt,
            description: description || null,
            referenceNumber: referenceNumber || null,
            isDraft: true,
            milestones: milestoneData.length > 0 ? { create: milestoneData } : undefined,
            // Draft shipments have no txHash, createdLedger, or on-chain backing
          },
        });

        results.push({
          row: rowNum,
          status: 'created',
          shipmentId: shipment.id,
        });
      } catch (err: any) {
        results.push({
          row: rowNum,
          status: 'error',
          error: err.message || 'Unknown error',
        });
      }
    }

    await this.auditLog.record({
      actorId: userId,
      actorAddress: buyerAddress,
      action: 'shipment.csv_import',
      resourceType: 'Shipment',
      resourceId: 'csv-import',
      metadata: {
        totalRows: records.length,
        created: results.filter((r) => r.status === 'created').length,
        errors: results.filter((r) => r.status === 'error').length,
      },
    });

    this.logger.log(
      `CSV import completed by buyer ${buyerAddress}: ` +
        `${results.filter((r) => r.status === 'created').length} created, ` +
        `${results.filter((r) => r.status === 'error').length} errors`,
    );

    return { results };
  }

  // ----------------------------------------------------------
  // INTERNAL HELPERS
  // ----------------------------------------------------------

  /**
   * Prisma `select` for a sparse fieldset. Always includes the columns the
   * serializer needs (id, createdAt for cursors, token decimals/symbol for
   * amount formatting); those extras are trimmed by pickFields() afterwards.
   */
  private buildSelect(fields: string[], relations: Record<string, any>): Record<string, any> {
    const select: Record<string, any> = {
      id: true,
      createdAt: true,
      tokenDecimals: true,
      tokenSymbol: true,
    };
    for (const f of fields) {
      select[f] = relations[f] ?? true;
    }
    if (relations.favorites) select.favorites = relations.favorites;
    return select;
  }

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

  private async serialize(shipment: any, callerUserId?: string, precisionOverride?: number, displayCurrency = 'USD') {
    const now = new Date();
    const decimals: number = shipment.tokenDecimals ?? 7;
    const symbol: string = shipment.tokenSymbol ?? 'USDC';
    const currency = displayCurrency.toUpperCase();

    // Estimated display-currency value (#231 / displayCurrency).
    // Uses convertForDisplay which handles token→USD then USD→target cross-rate.
    // Omitted entirely when no FX rate is cached — never causes the response to fail.
    // Fetch both rates once and reuse for totalAmount and releasedAmount.
    const [tokenUsdRate, fiatRate] = await Promise.all([
      this.fxRate.getUsdRate(symbol),
      this.fxRate.getFiatRate(currency),
    ]);

    const estimatedUsdValue = (tokenUsdRate && fiatRate)
      ? (() => {
          const effectiveRate = tokenUsdRate.rate * fiatRate.rate;
          const totalHuman = Number(this.stellar.toHumanAmount(shipment.totalAmount ?? 0n, decimals));
          const releasedHuman = Number(this.stellar.toHumanAmount(shipment.releasedAmount ?? 0n, decimals));
          const precision = precisionOverride ?? this.fxRate.getDisplayPrecision(currency);
          const asOf = tokenUsdRate.asOf < fiatRate.asOf ? tokenUsdRate.asOf : fiatRate.asOf;
          return {
            totalAmountUsd: this.fxRate.formatValue(totalHuman, effectiveRate, currency, precisionOverride),
            releasedAmountUsd: this.fxRate.formatValue(releasedHuman, effectiveRate, currency, precisionOverride),
            precision,
            currency,
            rate: effectiveRate,
            asOf,
            estimate: true,
            ...((tokenUsdRate.stale || fiatRate.stale) && { stale: true }),
          };
        })()
      : undefined;

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

    const { favorites, approvals, ...rest } = shipment;
    const isFavorited = callerUserId
      ? Array.isArray(favorites) && favorites.length > 0
      : false;

    // Multi-signature progress (#234). requiredApprovals is null on the default
    // single-approver flow, in which case quorum is trivially met.
    const requiredApprovals: number | null = shipment.requiredApprovals ?? null;
    const recordedApprovals = Array.isArray(approvals) ? approvals : [];
    const approvalStatus = {
      required: requiredApprovals,
      count: recordedApprovals.length,
      quorumMet:
        requiredApprovals === null || recordedApprovals.length >= requiredApprovals,
      approvals: recordedApprovals,
    };

    return {
      ...rest,
      approvalStatus,
      tokenSymbol: symbol,
      tokenDecimals: decimals,
      totalAmount: shipment.totalAmount?.toString(),
      releasedAmount: shipment.releasedAmount?.toString(),
      totalAmountFormatted: this.stellar.toHumanAmount(shipment.totalAmount ?? 0n, decimals),
      releasedAmountFormatted: this.stellar.toHumanAmount(shipment.releasedAmount ?? 0n, decimals),
      isFavorited,
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