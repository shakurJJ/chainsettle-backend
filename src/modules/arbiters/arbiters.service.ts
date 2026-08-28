import { Injectable, Logger } from '@nestjs/common';
import { MilestoneStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

export interface ArbiterReputation {
  arbiterAddress: string;
  disputesHandled: number;
  disputesOpen: number;
  averageResolutionTimeHours: number | null;
  hasHistory: boolean;
  computedAt: string;
}

const CACHE_PREFIX = 'arbiter:reputation:';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // recomputed on a schedule; long TTL just guards against stale forever-caching

@Injectable()
export class ArbitersService {
  private readonly logger = new Logger(ArbitersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Returns the cached reputation snapshot for an arbiter (refreshed by
   * ArbiterReputationJob). Falls back to computing it live when nothing has
   * been cached yet, so a brand-new arbiter never hits an error.
   */
  async getReputation(arbiterAddress: string): Promise<ArbiterReputation> {
    const cached = await this.redis.getJson<ArbiterReputation>(CACHE_PREFIX + arbiterAddress);
    if (cached) return cached;

    return this.computeReputation(arbiterAddress);
  }

  /** Recomputes and caches the reputation snapshot for one arbiter address. */
  async recompute(arbiterAddress: string): Promise<ArbiterReputation> {
    const reputation = await this.computeReputation(arbiterAddress);
    await this.redis.setJson(CACHE_PREFIX + arbiterAddress, reputation, CACHE_TTL_SECONDS);
    return reputation;
  }

  /** All distinct arbiter addresses that have ever been assigned to a shipment. */
  async listKnownArbiterAddresses(): Promise<string[]> {
    const rows = await this.prisma.shipment.findMany({
      distinct: ['arbiterAddress'],
      select: { arbiterAddress: true },
    });
    return rows.map((r) => r.arbiterAddress);
  }

  private async computeReputation(arbiterAddress: string): Promise<ArbiterReputation> {
    const milestones = await this.prisma.milestone.findMany({
      where: {
        shipment: { arbiterAddress },
        status: { in: [MilestoneStatus.DISPUTED, MilestoneStatus.RESOLVED] },
      },
      select: {
        status: true,
        disputeEscalatedAt: true,
        confirmedAt: true,
        createdAt: true,
      },
    });

    const resolved = milestones.filter((m) => m.status === MilestoneStatus.RESOLVED && m.confirmedAt);
    const open = milestones.filter((m) => m.status === MilestoneStatus.DISPUTED);

    const resolutionTimesMs = resolved
      .map((m) => {
        const start = m.disputeEscalatedAt ?? m.createdAt;
        return m.confirmedAt!.getTime() - start.getTime();
      })
      .filter((ms) => ms >= 0);

    const averageResolutionTimeHours =
      resolutionTimesMs.length > 0
        ? Math.round(
            (resolutionTimesMs.reduce((a, b) => a + b, 0) / resolutionTimesMs.length / (1000 * 60 * 60)) * 100,
          ) / 100
        : null;

    return {
      arbiterAddress,
      disputesHandled: resolved.length,
      disputesOpen: open.length,
      averageResolutionTimeHours,
      hasHistory: resolved.length > 0 || open.length > 0,
      computedAt: new Date().toISOString(),
    };
  }
}
