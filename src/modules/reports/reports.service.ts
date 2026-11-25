import { Injectable } from '@nestjs/common';
import { MilestoneStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FxRateService } from '../../common/fx/fx-rate.service';

/** Age buckets, in days past the milestone's due date. */
export const AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Milestone states whose value is still owed to the supplier. */
const UNRELEASED_STATUSES = [MilestoneStatus.PENDING, MilestoneStatus.PROOF_SUBMITTED];

export interface AgingBucketAmount {
  /** Human-readable token amount, e.g. "1234.5000000". */
  amount: string;
  /** Amount in the token's smallest unit (stroops). */
  valueRaw: string;
  milestoneCount: number;
}

export interface TokenAging {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  buckets: Record<AgingBucket, AgingBucketAmount>;
  /** Sum of all four buckets. */
  total: AgingBucketAmount;
  /** USD value of `total`; null unless includeUsdTotal was requested and a rate is cached. */
  totalUsd: number | null;
}

export interface AgingReport {
  supplierAddress: string;
  asOf: string;
  buckets: readonly AgingBucket[];
  byToken: TokenAging[];
  /** USD value of every token total; null unless includeUsdTotal was requested. */
  totalUsd: number | null;
  /** False when a token was left out of the USD total because it has no cached FX rate. */
  usdComplete: boolean;
}

/**
 * Maps days past due onto an aging bucket. Anything not yet due (negative age)
 * is not a receivable and returns null.
 */
export function bucketForAgeDays(ageDays: number): AgingBucket | null {
  if (!Number.isFinite(ageDays) || ageDays < 0) return null;
  if (ageDays <= 30) return '0-30';
  if (ageDays <= 60) return '31-60';
  if (ageDays <= 90) return '61-90';
  return '90+';
}

function emptyBucket(): AgingBucketAmount {
  return { amount: '', valueRaw: '0', milestoneCount: 0 };
}

function emptyBuckets(): Record<AgingBucket, AgingBucketAmount> {
  return {
    '0-30': emptyBucket(),
    '31-60': emptyBucket(),
    '61-90': emptyBucket(),
    '90+': emptyBucket(),
  };
}

/** Exact raw-units → human amount, without floating-point rounding. */
export function formatRawAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction =
    decimals === 0
      ? ''
      : (abs % base)
          .toString()
          .padStart(decimals, '0')
          .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * Receivables aging for suppliers (#659): unreleased (PENDING / PROOF_SUBMITTED)
 * milestone value bucketed by how long it has been past its due date, grouped
 * by settlement token.
 *
 * Only the caller's own shipments are read — the supplier address always comes
 * from the authenticated user, never from a request parameter.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fxRate: FxRateService,
  ) {}

  async getAgingReport(
    supplierAddress: string,
    options: { includeUsdTotal?: boolean; asOf?: Date } = {},
  ): Promise<AgingReport> {
    const asOf = options.asOf ?? new Date();
    const includeUsdTotal = options.includeUsdTotal === true;

    const milestones = await this.prisma.read.milestone.findMany({
      where: {
        status: { in: UNRELEASED_STATUSES },
        deletedAt: null,
        dueAt: { lt: asOf },
        shipment: {
          supplierAddress,
          isDraft: false,
        },
      },
      select: {
        dueAt: true,
        paymentPercent: true,
        shipment: {
          select: {
            totalAmount: true,
            tokenAddress: true,
            tokenSymbol: true,
            tokenDecimals: true,
          },
        },
      },
    });

    interface TokenAccumulator {
      tokenAddress: string;
      tokenSymbol: string;
      tokenDecimals: number;
      buckets: Record<AgingBucket, AgingBucketAmount>;
    }

    const byToken = new Map<string, TokenAccumulator>();

    for (const milestone of milestones) {
      if (!milestone.dueAt) continue;

      const ageDays = Math.floor((asOf.getTime() - milestone.dueAt.getTime()) / MS_PER_DAY);
      const bucket = bucketForAgeDays(ageDays);
      if (!bucket) continue;

      const { shipment } = milestone;
      // Milestone value in raw token units; integer maths keeps it exact.
      const valueRaw = (shipment.totalAmount * BigInt(milestone.paymentPercent)) / 100n;
      if (valueRaw === 0n) continue;

      let token = byToken.get(shipment.tokenAddress);
      if (!token) {
        token = {
          tokenAddress: shipment.tokenAddress,
          tokenSymbol: shipment.tokenSymbol,
          tokenDecimals: shipment.tokenDecimals,
          buckets: emptyBuckets(),
        };
        byToken.set(shipment.tokenAddress, token);
      }

      const target = token.buckets[bucket];
      target.valueRaw = (BigInt(target.valueRaw) + valueRaw).toString();
      target.milestoneCount += 1;
    }

    const report: AgingReport = {
      supplierAddress,
      asOf: asOf.toISOString(),
      buckets: AGING_BUCKETS,
      byToken: [],
      totalUsd: includeUsdTotal ? 0 : null,
      usdComplete: true,
    };

    let totalUsd = 0;

    const tokens = [...byToken.values()].sort((a, b) =>
      a.tokenSymbol.localeCompare(b.tokenSymbol),
    );

    for (const token of tokens) {
      const buckets = emptyBuckets();
      let totalRaw = 0n;
      let milestoneCount = 0;

      for (const bucket of AGING_BUCKETS) {
        const value = BigInt(token.buckets[bucket].valueRaw);
        milestoneCount += token.buckets[bucket].milestoneCount;
        totalRaw += value;
        buckets[bucket] = {
          amount: formatRawAmount(value, token.tokenDecimals),
          valueRaw: value.toString(),
          milestoneCount: token.buckets[bucket].milestoneCount,
        };
      }

      let totalUsdForToken: number | null = null;
      if (includeUsdTotal) {
        const rate = await this.fxRate.getUsdRate(token.tokenSymbol);
        if (rate) {
          const human = Number(totalRaw) / 10 ** token.tokenDecimals;
          totalUsdForToken = round(human * rate.rate);
          totalUsd += totalUsdForToken;
        } else {
          report.usdComplete = false;
        }
      }

      report.byToken.push({
        tokenAddress: token.tokenAddress,
        tokenSymbol: token.tokenSymbol,
        tokenDecimals: token.tokenDecimals,
        buckets,
        total: {
          amount: formatRawAmount(totalRaw, token.tokenDecimals),
          valueRaw: totalRaw.toString(),
          milestoneCount,
        },
        totalUsd: totalUsdForToken,
      });
    }

    if (includeUsdTotal) {
      report.totalUsd = round(totalUsd);
    }

    return report;
  }
}
