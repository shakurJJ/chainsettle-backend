import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

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

/**
 * Aggregates live platform metrics for the admin dashboard.
 * The same snapshot is used both by the SSE stream (GET /admin/dashboard/realtime)
 * and, in future, by a point-in-time GET /admin/stats endpoint.
 */
@Injectable()
export class AdminDashboardService {
  private readonly logger = new Logger(AdminDashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getSnapshot(): Promise<DashboardSnapshot> {
    const [activeShipments, failedWebhookCount, cursorRow] = await Promise.allSettled([
      this.prisma.shipment.count({ where: { status: 'ACTIVE' } }),
      this.prisma.webhookDelivery.count({ where: { permanentlyFailedAt: { not: null } } }),
      this.prisma.eventCursor.findUnique({ where: { id: 'main' } }),
    ]);

    const activeShipmentsValue =
      activeShipments.status === 'fulfilled' ? activeShipments.value : 0;

    const failedWebhookValue =
      failedWebhookCount.status === 'fulfilled' ? failedWebhookCount.value : 0;

    const cursor =
      cursorRow.status === 'fulfilled' ? cursorRow.value : null;

    const eventPollerLedger: number | null = cursor?.lastProcessedLedger ?? null;
    let eventPollerLag: number | null = null;

    if (eventPollerLedger !== null) {
      try {
        const tipRaw = await this.redis.get('chainsettle:stellar:latest-ledger');
        if (tipRaw) {
          const tip = parseInt(tipRaw, 10);
          if (Number.isFinite(tip)) {
            eventPollerLag = Math.max(0, tip - eventPollerLedger);
          }
        }
      } catch (err: any) {
        this.logger.debug(`Could not read stellar tip from Redis: ${err.message}`);
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
}
