import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MilestoneStatus, ProofRejectionReason, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { FxRateService } from '../../common/fx/fx-rate.service';
import { PerformanceRole } from './dto/performance-query.dto';

/** Stats are cached per (address, role, since) for one hour. */
export const PERFORMANCE_CACHE_TTL_SECONDS = 3600;

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
const MS_PER_HOUR = 60 * 60 * 1000;

export interface PerformanceStats {
  stellarAddress: string;
  role: PerformanceRole | 'ALL';
  since: string | null;
  totalShipments: number;
  completedShipments: number;
  /** Share of milestones with a dueAt that were confirmed on or before it (0–1). */
  onTimeMilestoneRate: number;
  /** Share of shipments with at least one disputed milestone (0–1). */
  disputeRate: number;
  /** Mean hours between the latest proof upload and buyer confirmation. */
  avgProofToConfirmHours: number;
  /** USD value of completed shipments. null when hidden from the caller. */
  totalVolumeUsd: number | null;
  /** False if some token had no cached FX rate and was left out of the volume. */
  volumeComplete: boolean;
  /**
   * Count of proof rejections grouped by reason code.
   * Only codes that have at least one rejection appear in the map.
   */
  rejectionsByReason: Partial<Record<ProofRejectionReason, number>>;
  computedAt: string;
}

/**
 * Counterparty track record (#391) — on-time delivery, disputes and volume
 * for a supplier or logistics provider.
 */
@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly stellar: StellarService,
    private readonly fxRate: FxRateService,
  ) {}

  async getPerformance(
    stellarAddress: string,
    caller: { stellarAddress?: string; role?: string },
    role?: PerformanceRole,
    since?: string,
  ): Promise<PerformanceStats> {
    if (!STELLAR_ADDRESS.test(stellarAddress)) {
      throw new BadRequestException('stellarAddress must be a valid Stellar public key');
    }

    const stats = await this.getCachedStats(stellarAddress, role, since);
    const canSeeVolume = await this.canSeeVolume(stellarAddress, caller);
    return canSeeVolume ? stats : { ...stats, totalVolumeUsd: null };
  }

  /**
   * Volume is commercially sensitive: only the address itself, admins, and
   * callers who share at least one shipment with it may see it.
   */
  async canSeeVolume(
    stellarAddress: string,
    caller: { stellarAddress?: string; role?: string },
  ): Promise<boolean> {
    if (caller.role === 'ADMIN') return true;
    if (!caller.stellarAddress) return false;
    if (caller.stellarAddress === stellarAddress) return true;

    const participant = (addr: string) => ({
      OR: [
        { buyerAddress: addr },
        { supplierAddress: addr },
        { logisticsAddress: addr },
        { arbiterAddress: addr },
      ],
    });
    const shared = await this.prisma.read.shipment.findFirst({
      where: { AND: [participant(stellarAddress), participant(caller.stellarAddress)] },
      select: { id: true },
    });
    return shared !== null;
  }

  private async getCachedStats(
    stellarAddress: string,
    role: PerformanceRole | undefined,
    since: string | undefined,
  ): Promise<PerformanceStats> {
    const sinceKey = since ? new Date(since).toISOString() : 'all';
    const key = `performance:${stellarAddress}:${role ?? 'ALL'}:${sinceKey}`;

    try {
      const cached = await this.redis.getJson<PerformanceStats>(key);
      if (cached) return cached;
    } catch (err) {
      this.logger.warn(`Performance cache read failed: ${(err as Error).message}`);
    }

    const stats = await this.compute(stellarAddress, role, since);
    try {
      await this.redis.setJson(key, stats, PERFORMANCE_CACHE_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(`Performance cache write failed: ${(err as Error).message}`);
    }
    return stats;
  }

  async compute(
    stellarAddress: string,
    role: PerformanceRole | undefined,
    since: string | undefined,
  ): Promise<PerformanceStats> {
    const roleWhere =
      role === 'SUPPLIER'
        ? { supplierAddress: stellarAddress }
        : role === 'LOGISTICS'
          ? { logisticsAddress: stellarAddress }
          : { OR: [{ supplierAddress: stellarAddress }, { logisticsAddress: stellarAddress }] };

    const shipments = await this.prisma.read.shipment.findMany({
      where: {
        ...roleWhere,
        isDraft: false,
        ...(since ? { createdAt: { gte: new Date(since) } } : {}),
      },
      select: {
        status: true,
        totalAmount: true,
        tokenDecimals: true,
        tokenSymbol: true,
        milestones: {
          where: { deletedAt: null },
          select: {
            status: true,
            dueAt: true,
            confirmedAt: true,
            disputeEscalatedAt: true,
            proofSubmissions: {
              select: {
                createdAt: true,
                rejectionCode: true,
              },
            },
          },
        },
      },
    });

    let completedShipments = 0;
    let disputedShipments = 0;
    let dueMilestones = 0;
    let onTimeMilestones = 0;
    let proofToConfirmMs = 0;
    let proofToConfirmCount = 0;
    const volumeByToken = new Map<string, number>();
    const rejectionsByReason: Partial<Record<ProofRejectionReason, number>> = {};

    for (const s of shipments) {
      if (s.status === ShipmentStatus.COMPLETED) {
        completedShipments++;
        const human = Number(this.stellar.toHumanAmount(s.totalAmount, s.tokenDecimals));
        volumeByToken.set(s.tokenSymbol, (volumeByToken.get(s.tokenSymbol) ?? 0) + human);
      }

      let disputed = false;
      for (const m of s.milestones) {
        if (
          m.status === MilestoneStatus.DISPUTED ||
          m.status === MilestoneStatus.RESOLVED ||
          m.disputeEscalatedAt
        ) {
          disputed = true;
        }

        if (m.dueAt && m.confirmedAt) {
          dueMilestones++;
          if (m.confirmedAt.getTime() <= m.dueAt.getTime()) onTimeMilestones++;
        } else if (m.dueAt && m.dueAt.getTime() < Date.now()) {
          // Past due and still unconfirmed counts against the rate.
          dueMilestones++;
        }

        if (m.confirmedAt) {
          const confirmedAt = m.confirmedAt.getTime();
          const lastProof = m.proofSubmissions
            .map((p) => p.createdAt.getTime())
            .filter((t) => t <= confirmedAt)
            .reduce((max, t) => Math.max(max, t), -Infinity);
          if (Number.isFinite(lastProof)) {
            proofToConfirmMs += confirmedAt - lastProof;
            proofToConfirmCount++;
          }
        }

        // Tally rejection reason codes from proof submission history.
        for (const p of m.proofSubmissions) {
          if (p.rejectionCode) {
            rejectionsByReason[p.rejectionCode] = (rejectionsByReason[p.rejectionCode] ?? 0) + 1;
          }
        }
      }
      if (disputed) disputedShipments++;
    }

    let totalVolumeUsd = 0;
    let volumeComplete = true;
    for (const [symbol, amount] of volumeByToken) {
      const rate = await this.fxRate.getUsdRate(symbol);
      if (!rate) {
        volumeComplete = false;
        continue;
      }
      totalVolumeUsd += amount * rate.rate;
    }

    return {
      stellarAddress,
      role: role ?? 'ALL',
      since: since ? new Date(since).toISOString() : null,
      totalShipments: shipments.length,
      completedShipments,
      onTimeMilestoneRate: ratio(onTimeMilestones, dueMilestones),
      disputeRate: ratio(disputedShipments, shipments.length),
      avgProofToConfirmHours: round(
        proofToConfirmCount === 0 ? 0 : proofToConfirmMs / proofToConfirmCount / MS_PER_HOUR,
      ),
      totalVolumeUsd: round(totalVolumeUsd),
      volumeComplete,
      rejectionsByReason,
      computedAt: new Date().toISOString(),
    };
  }
}

function ratio(n: number, d: number): number {
  return d === 0 ? 0 : round(n / d, 4);
}

function round(value: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
