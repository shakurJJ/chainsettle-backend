import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { PrismaService } from "../../common/prisma/prisma.service";
import { RedisService } from "../../common/redis/redis.service";
import { TokenRegistryService } from "../../common/token-registry/token-registry.service";
import { FxRateService } from "../../common/fx/fx-rate.service";
import { VolumeReportQueryDto } from "./dto/volume-report-query.dto";
import { ScheduledJobDto } from "./dto/scheduled-job.dto";
import { UserExportQueryDto } from "./dto/user-export-query.dto";
import { buildCsvFromRows } from "../../common/utils/csv.util";
import {
  getJobRedisKey,
  JobRunRecord,
} from "../../common/jobs/job-tracker.util";
import { AuditLogService } from "../audit-logs/audit-log.service";
import { Request, Response } from "express";

export interface DashboardSnapshot {
  /** ISO-8601 timestamp of when this snapshot was taken */
  timestamp: string;
  activeShipments: number;
  /** Number of webhook deliveries that have permanently failed */
  failedWebhookCount: number;
  /** Ledger number of the last processed chain event (null = not yet polled) */
  eventPollerLedger: number | null;
  /** Approximate poller lag in ledgers (current tip − last processed) */
  eventPollerLag: number | null;
}

export interface VolumeBucket {
  periodStart: string;
  shipmentsCreated: number;
  shipmentsCompleted: number;
  totalValue: string;
  totalValueUsd: number;
  releasedValue: string;
}

@Injectable()
export class AdminDashboardService {
  private readonly logger = new Logger(AdminDashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tokenRegistry: TokenRegistryService,
    private readonly fxRate: FxRateService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly auditLog: AuditLogService,
  ) {}

  async getSnapshot(): Promise<DashboardSnapshot> {
    const [activeShipments, failedWebhookCount, cursorRow] =
      await Promise.allSettled([
        this.prisma.shipment.count({ where: { status: "ACTIVE" } }),
        this.prisma.webhookDelivery.count({
          where: { permanentlyFailedAt: { not: null } },
        }),
        this.prisma.eventCursor.findUnique({ where: { id: "main" } }),
      ]);

    const activeShipmentsValue =
      activeShipments.status === "fulfilled" ? activeShipments.value : 0;

    const failedWebhookValue =
      failedWebhookCount.status === "fulfilled" ? failedWebhookCount.value : 0;

    const cursor = cursorRow.status === "fulfilled" ? cursorRow.value : null;

    const eventPollerLedger: number | null =
      cursor?.lastProcessedLedger ?? null;
    let eventPollerLag: number | null = null;

    if (eventPollerLedger !== null) {
      try {
        const tipRaw = await this.redis.get(
          "chainsettle:stellar:latest-ledger",
        );
        if (tipRaw) {
          const tip = parseInt(tipRaw, 10);
          if (Number.isFinite(tip)) {
            eventPollerLag = Math.max(0, tip - eventPollerLedger);
          }
        }
      } catch (err: any) {
        this.logger.debug(
          `Could not read stellar tip from Redis: ${err.message}`,
        );
      }
    }

    return {
      timestamp: new Date().toISOString(),
      activeShipments: activeShipmentsValue,
      failedWebhookCount: failedWebhookValue,
      eventPollerLedger,
      eventPollerLag,
    };
  }

  async getVolumeReport(
    query: VolumeReportQueryDto,
  ): Promise<VolumeBucket[] | string> {
    const interval = query.interval || "day";
    const now = new Date();

    let toDate = query.to ? new Date(query.to) : now;
    if (isNaN(toDate.getTime())) {
      throw new BadRequestException('Invalid "to" date parameter');
    }

    let fromDate: Date;
    if (query.from) {
      fromDate = new Date(query.from);
      if (isNaN(fromDate.getTime())) {
        throw new BadRequestException('Invalid "from" date parameter');
      }
    } else {
      fromDate = new Date(toDate);
      fromDate.setMonth(fromDate.getMonth() - 1);
    }

    if (fromDate > toDate) {
      throw new BadRequestException(
        '"from" date must be before or equal to "to" date',
      );
    }

    // Enforce 2 years max range
    const maxMs = 2 * 365 * 24 * 60 * 60 * 1000;
    if (toDate.getTime() - fromDate.getTime() > maxMs) {
      throw new BadRequestException("Date range cannot exceed 2 years");
    }

    // Cache key for 10 minutes cache
    const cacheKey = `admin:reports:volume:${fromDate.toISOString()}:${toDate.toISOString()}:${interval}:${query.token || "all"}:${query.format || "json"}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      if (query.format === "csv") {
        return cached;
      }
      try {
        return JSON.parse(cached);
      } catch {
        // Fallthrough if cache parse fails
      }
    }

    // Resolve token decimals and symbol if token filter is provided
    let tokenAddressFilter: string | undefined = undefined;
    let tokenDecimals = 7;
    let tokenSymbol = "USDC";

    if (query.token) {
      const entry =
        this.tokenRegistry.findByAddress(query.token) ||
        this.tokenRegistry
          .listTokens()
          .find((t) => t.symbol.toUpperCase() === query.token?.toUpperCase());
      if (entry) {
        tokenAddressFilter = entry.address;
        tokenDecimals = entry.decimals;
        tokenSymbol = entry.symbol;
      } else {
        tokenSymbol = query.token.toUpperCase();
      }
    }

    // Get exchange rate for token to USD
    const rateEntry = await this.fxRate.getUsdRate(tokenSymbol);
    const usdRate = rateEntry?.rate ?? 1.0;

    // Build raw SQL query using date_trunc
    const dateTruncUnit = interval; // 'day', 'week', 'month'

    // We select created shipments and completed shipments aggregated by bucket
    // Note: totalAmount and releasedAmount are BigInt stroops in DB
    const rawCreated: Array<{
      period_start: Date;
      shipments_created: bigint | number;
      total_value: bigint | number;
      released_value: bigint | number;
    }> = await this.prisma.$queryRawUnsafe(
      `
      SELECT 
        date_trunc('${dateTruncUnit}', "createdAt") AS period_start,
        COUNT(*)::bigint AS shipments_created,
        COALESCE(SUM("totalAmount"), 0)::bigint AS total_value,
        COALESCE(SUM("releasedAmount"), 0)::bigint AS released_value
      FROM shipments
      WHERE "createdAt" >= $1 AND "createdAt" <= $2
        ${tokenAddressFilter ? `AND UPPER("tokenAddress") = UPPER('${tokenAddressFilter}')` : ""}
      GROUP BY period_start
      ORDER BY period_start ASC
    `,
      fromDate,
      toDate,
    );

    const rawCompleted: Array<{
      period_start: Date;
      shipments_completed: bigint | number;
    }> = await this.prisma.$queryRawUnsafe(
      `
      SELECT 
        date_trunc('${dateTruncUnit}', "updatedAt") AS period_start,
        COUNT(*)::bigint AS shipments_completed
      FROM shipments
      WHERE status = 'COMPLETED' AND "updatedAt" >= $1 AND "updatedAt" <= $2
        ${tokenAddressFilter ? `AND UPPER("tokenAddress") = UPPER('${tokenAddressFilter}')` : ""}
      GROUP BY period_start
      ORDER BY period_start ASC
    `,
      fromDate,
      toDate,
    );

    const createdMap = new Map<
      string,
      { count: number; totalValue: bigint; releasedValue: bigint }
    >();
    for (const row of rawCreated) {
      const key = new Date(row.period_start).toISOString();
      createdMap.set(key, {
        count: Number(row.shipments_created),
        totalValue: BigInt(row.total_value.toString()),
        releasedValue: BigInt(row.released_value.toString()),
      });
    }

    const completedMap = new Map<string, number>();
    for (const row of rawCompleted) {
      const key = new Date(row.period_start).toISOString();
      completedMap.set(key, Number(row.shipments_completed));
    }

    // Generate continuous time series buckets (filling empty periods with zeros)
    const buckets: VolumeBucket[] = [];
    let curr = new Date(fromDate);

    // Align curr to period start
    if (interval === "day") {
      curr.setUTCHours(0, 0, 0, 0);
    } else if (interval === "week") {
      curr.setUTCHours(0, 0, 0, 0);
      const day = curr.getUTCDay();
      const diff = curr.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday start
      curr.setUTCDate(diff);
    } else if (interval === "month") {
      curr.setUTCHours(0, 0, 0, 0);
      curr.setUTCDate(1);
    }

    while (curr <= toDate) {
      const periodIso = curr.toISOString();
      const createdData = createdMap.get(periodIso) || {
        count: 0,
        totalValue: BigInt(0),
        releasedValue: BigInt(0),
      };
      const completedCount = completedMap.get(periodIso) || 0;

      const totalValHuman =
        Number(createdData.totalValue) / 10 ** tokenDecimals;
      const releasedValHuman =
        Number(createdData.releasedValue) / 10 ** tokenDecimals;
      const totalValueUsd = Math.round(totalValHuman * usdRate * 100) / 100;

      buckets.push({
        periodStart: periodIso,
        shipmentsCreated: createdData.count,
        shipmentsCompleted: completedCount,
        totalValue: totalValHuman.toFixed(tokenDecimals),
        totalValueUsd,
        releasedValue: releasedValHuman.toFixed(tokenDecimals),
      });

      // Increment curr
      if (interval === "day") {
        curr.setUTCDate(curr.getUTCDate() + 1);
      } else if (interval === "week") {
        curr.setUTCDate(curr.getUTCDate() + 7);
      } else if (interval === "month") {
        curr.setUTCMonth(curr.getUTCMonth() + 1);
      }
    }

    if (query.format === "csv") {
      const csvStr = buildCsvFromRows(
        buckets.map((b) => ({
          periodStart: b.periodStart,
          shipmentsCreated: b.shipmentsCreated,
          shipmentsCompleted: b.shipmentsCompleted,
          totalValue: b.totalValue,
          totalValueUsd: b.totalValueUsd,
          releasedValue: b.releasedValue,
        })),
      );
      await this.redis.set(cacheKey, csvStr, 600); // 10 minutes cache
      return csvStr;
    }

    await this.redis.set(cacheKey, JSON.stringify(buckets), 600); // 10 minutes cache
    return buckets;
  }

  /**
   * Retrieves all registered cron jobs with their schedule, next execution time,
   * and previous run metrics from Redis (#533).
   */
  async getScheduledJobs(): Promise<ScheduledJobDto[]> {
    const cronJobs = this.schedulerRegistry.getCronJobs();
    const jobs: ScheduledJobDto[] = [];

    for (const [name, cronJob] of cronJobs.entries()) {
      let nextRunAt: string | null = null;
      try {
        if (typeof (cronJob as any).nextDate === "function") {
          const next = (cronJob as any).nextDate();
          if (next) {
            nextRunAt =
              typeof next.toISO === "function"
                ? next.toISO()
                : new Date(next).toISOString();
          }
        }
      } catch {
        nextRunAt = null;
      }

      let schedule = "";
      try {
        schedule = (cronJob as any).cronTime?.source?.toString() || "";
      } catch {
        schedule = "";
      }

      const redisKey = getJobRedisKey(name);
      const lastRun = await this.redis.getJson<JobRunRecord>(redisKey);

      jobs.push({
        name,
        schedule,
        lastRunAt: lastRun?.lastRunAt ?? null,
        lastResult: lastRun?.lastResult ?? null,
        durationMs: lastRun?.durationMs ?? null,
        nextRunAt,
      });
    }

    return jobs.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Export users to CSV with streaming to handle large datasets.
   * Logs the export action for audit purposes.
   */
  async exportUsers(
    query: UserExportQueryDto,
    res: Response,
    req: Request,
  ): Promise<void> {
    // Build the where clause from filters
    const where: any = {};

    if (query.role) {
      where.role = query.role;
    }

    if (query.emailVerified !== undefined) {
      where.emailVerified = query.emailVerified;
    }

    if (query.kycStatus) {
      where.kycStatus = query.kycStatus;
    }

    if (query.deactivated !== undefined) {
      if (query.deactivated) {
        where.deactivatedAt = { not: null };
      } else {
        where.deactivatedAt = null;
      }
    }

    if (query.search) {
      where.OR = [
        { email: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { stellarAddress: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    // Log the export for audit
    const actor = (req as any).user;
    await this.auditLog.record({
      actorId: actor?.id,
      actorAddress: actor?.stellarAddress ?? 'SYSTEM',
      action: 'users.exported',
      resourceType: 'User',
      resourceId: 'bulk-export',
      metadata: {
        filters: {
          role: query.role,
          emailVerified: query.emailVerified,
          kycStatus: query.kycStatus,
          deactivated: query.deactivated,
          search: query.search,
        },
      },
      ipAddress: req.ip,
    });

    // Write CSV header
    const headers = ['id', 'stellarAddress', 'email', 'name', 'role', 'kycStatus', 'emailVerified', 'deactivatedAt', 'createdAt'];
    res.write(headers.join(',') + '\n');

    // Stream users in batches using cursor-based pagination
    const BATCH_SIZE = 1000;
    let cursor: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const batch = await this.prisma.user.findMany({
        where,
        select: {
          id: true,
          stellarAddress: true,
          email: true,
          name: true,
          role: true,
          kycStatus: true,
          emailVerified: true,
          deactivatedAt: true,
          createdAt: true,
        },
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { createdAt: 'asc' },
      });

      if (batch.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        cursor = batch[batch.length - 1].id;
      }

      // Convert to CSV rows and write
      for (const user of batch) {
        const row = [
          user.id,
          user.stellarAddress,
          user.email ?? '',
          user.name ?? '',
          user.role,
          user.kycStatus,
          user.emailVerified,
          user.deactivatedAt ? user.deactivatedAt.toISOString() : '',
          user.createdAt.toISOString(),
        ];
        // Escape values (quotes, commas, newlines)
        const escapedRow = row.map((value) => {
          const str = String(value);
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        });
        res.write(escapedRow.join(',') + '\n');
      }
    }

    res.end();
  }
}
