import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Gauge } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';

export const ESCROW_LOCKED_GAUGE = 'chainsettle_escrow_locked_amount';

/**
 * Keeps `chainsettle_escrow_locked_amount{token}` in sync with the value held in
 * escrow: sum(totalAmount - releasedAmount) over ACTIVE shipments, per token,
 * in human units. Refreshed on an interval (ESCROW_METRICS_REFRESH_MS) and,
 * debounced, after relevant chain events via `scheduleRefresh()`.
 */
@Injectable()
export class EscrowLockedMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EscrowLockedMetricsService.name);
  private timer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private known = new Set<string>();

  constructor(
    @InjectMetric(ESCROW_LOCKED_GAUGE) private readonly gauge: Gauge<string>,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const interval = Number(this.config.get('ESCROW_METRICS_REFRESH_MS') ?? 60_000);
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), interval);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
  }

  /** Debounced refresh, safe to call on every chain event. */
  scheduleRefresh(delayMs = 2_000): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), delayMs);
    this.debounce.unref?.();
  }

  async refresh(): Promise<void> {
    try {
      const rows = await this.prisma.$queryRaw<{ token: string; decimals: number; locked: bigint }[]>`
        SELECT "tokenSymbol" AS token, MAX("tokenDecimals")::int AS decimals,
               COALESCE(SUM("totalAmount" - "releasedAmount"), 0)::bigint AS locked
        FROM "shipments" WHERE status = 'ACTIVE' GROUP BY "tokenSymbol"`;
      const seen = new Set<string>();
      for (const r of rows) {
        seen.add(r.token);
        this.gauge.set({ token: r.token }, Number(BigInt(r.locked)) / 10 ** r.decimals);
      }
      for (const token of this.known) if (!seen.has(token)) this.gauge.set({ token }, 0);
      seen.forEach((t) => this.known.add(t));
    } catch (err) {
      this.logger.warn(`Failed to refresh ${ESCROW_LOCKED_GAUGE}: ${(err as Error).message}`);
    }
  }
}
