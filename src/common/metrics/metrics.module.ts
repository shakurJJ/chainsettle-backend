import { Global, Logger, Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { makeCounterProvider, makeGaugeProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { OutboxStatus, ShipmentStatus } from '@prisma/client';
import { Gauge } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from './metrics.service';
import {
  EVENTS_PROCESSED_COUNTER,
  EVENTS_FAILED_COUNTER,
  SHIPMENTS_CREATED_COUNTER,
  ACTIVE_SHIPMENTS_GAUGE,
  STELLAR_ENDPOINT_GAUGE,
  SHIPMENTS_BY_STATUS_GAUGE,
  OPEN_DISPUTES_GAUGE,
  DISPUTE_RESOLUTION_TIME_HISTOGRAM,
  JOB_DURATION_HISTOGRAM,
  JOB_RUNS_COUNTER,
  OUTBOX_EVENTS_COUNTER,
  OUTBOX_BACKLOG_GAUGE,
} from './metrics.service';
import { resolveBuildInfo } from '../build-info';
import { ESCROW_LOCKED_GAUGE, EscrowLockedMetricsService } from './escrow-locked.service';
import { CONTRACT_TTL_GAUGE, SPONSORED_FEES_COUNTER } from './metric-names';

const logger = new Logger('MetricsModule');

/**
 * Refreshes chainsettle_shipments_by_status on every /metrics scrape from a
 * single grouped query (#305). Every status gets a series, so a status with no
 * shipments reports 0 rather than disappearing. On a DB error the previous
 * values are kept so the scrape itself still succeeds.
 */
export async function collectShipmentsByStatus(this: Gauge<string>, prisma: PrismaService) {
  try {
    const rows = await prisma.shipment.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts = new Map(rows.map((row) => [row.status, row._count._all]));
    for (const status of Object.values(ShipmentStatus)) {
      this.set({ status }, counts.get(status) ?? 0);
    }
  } catch (err) {
    logger.warn(`Failed to refresh ${SHIPMENTS_BY_STATUS_GAUGE}: ${err.message}`);
  }
}

/**
 * Refreshes chainsettle_outbox_backlog on every scrape (#660): how many outbox
 * events are still waiting to be dispatched, grouped by status. A growing
 * PENDING series means the dispatcher is down or falling behind.
 */
export async function collectOutboxBacklog(this: Gauge<string>, prisma: PrismaService) {
  try {
    const rows = await prisma.outboxEvent.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts = new Map(rows.map((row) => [row.status, row._count._all]));
    for (const status of Object.values(OutboxStatus)) {
      this.set({ status }, counts.get(status) ?? 0);
    }
  } catch (err) {
    logger.warn(`Failed to refresh ${OUTBOX_BACKLOG_GAUGE}: ${err.message}`);
  }
}

export async function collectOpenDisputes(this: Gauge<string>, prisma: PrismaService) {
  try { this.set(await prisma.milestone.count({ where: { status: 'DISPUTED', deletedAt: null } })); }
  catch (err) { logger.warn('Failed to refresh open dispute gauge'); }
}

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: { enabled: true },
    }),
  ],
  providers: [
    makeCounterProvider({
      name: EVENTS_PROCESSED_COUNTER,
      help: 'Total number of on-chain events processed',
      labelNames: ['eventName'],
    }),
    makeCounterProvider({
      name: EVENTS_FAILED_COUNTER,
      help: 'Total number of on-chain events that failed processing',
    }),
    makeCounterProvider({
      name: SHIPMENTS_CREATED_COUNTER,
      help: 'Total number of shipments created',
    }),
    makeGaugeProvider({
      name: ACTIVE_SHIPMENTS_GAUGE,
      help: 'Current number of active shipments',
    }),
    makeGaugeProvider({
      name: STELLAR_ENDPOINT_GAUGE,
      help: 'Stellar RPC/Horizon endpoint health (1 = healthy); active="true" marks the endpoint in use',
      labelNames: ['type', 'url', 'active'],
    }),
    makeGaugeProvider({
      name: OPEN_DISPUTES_GAUGE,
      help: 'Current number of open disputes',
      inject: [PrismaService],
      collect: collectOpenDisputes,
    }),
    makeHistogramProvider({ name: DISPUTE_RESOLUTION_TIME_HISTOGRAM, help: 'Time taken to resolve disputes in hours', buckets: [1, 6, 12, 24, 48, 72, 168, 336] }),
    makeHistogramProvider({
      name: JOB_DURATION_HISTOGRAM,
      help: 'Duration of cron job executions in seconds',
      labelNames: ['job'],
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300],
    }),
    makeCounterProvider({
      name: JOB_RUNS_COUNTER,
      help: 'Total number of cron job executions',
      labelNames: ['job', 'result'],
    }),
    makeCounterProvider({
      name: OUTBOX_EVENTS_COUNTER,
      help: 'Total outbox events delivered, by outcome',
      labelNames: ['result'],
    }),
    makeGaugeProvider({
      name: OUTBOX_BACKLOG_GAUGE,
      help: 'Current outbox events awaiting dispatch, by status',
      labelNames: ['status'],
      inject: [PrismaService],
      collect: collectOutboxBacklog,
    }),
    makeGaugeProvider({
      name: SHIPMENTS_BY_STATUS_GAUGE,
      help: 'Current number of shipments in each status',
      labelNames: ['status'],
      inject: [PrismaService],
      collect: collectShipmentsByStatus,
    }),
    makeGaugeProvider({
      name: BUILD_INFO_GAUGE,
      help: 'Build information for the running instance; value is always 1',
      labelNames: ['version', 'gitSha', 'buildTime', 'nodeVersion'],
      collect: collectBuildInfo,
    }),
    makeGaugeProvider({
      name: ESCROW_LOCKED_GAUGE,
      help: 'Value currently locked in escrow per token (human units): active shipments minus released milestones',
      labelNames: ['token'],
    }),
    makeGaugeProvider({
      name: CONTRACT_TTL_GAUGE,
      help: 'Remaining ledgers before a Soroban contract storage entry is archived',
      labelNames: ['entry'],
    }),
    makeCounterProvider({
      name: SPONSORED_FEES_COUNTER,
      help: 'Total fees paid by the platform sponsor account for fee-bumped transactions (stroops)',
    }),
    MetricsService,
    EscrowLockedMetricsService,
  ],
  exports: [MetricsService, EscrowLockedMetricsService],
})
export class MetricsModule {}
