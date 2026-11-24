import { Injectable, Logger, Optional } from '@nestjs/common';
import { NotificationType, OutboxStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MetricsService } from '../../common/metrics/metrics.service';
import { WebhooksService } from '../webhooks/webhooks.service';

/** Attempts after which an event is parked as FAILED instead of retried. */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Rows claimed per batch (one claim query). */
export const OUTBOX_BATCH_SIZE = 25;

/** Hard cap on batches per drain so one tick cannot run forever. */
const MAX_BATCHES_PER_DRAIN = 10;

/** A PROCESSING row older than this is assumed abandoned and reclaimed. */
const STALE_LOCK_SECONDS = 5 * 60;

/** A row claimed by a dispatcher and awaiting delivery. */
export interface ClaimedOutboxEvent {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

export type OutboxHandler = (
  type: string,
  payload: Record<string, unknown>,
) => Promise<void>;

export interface DrainResult {
  claimed: number;
  dispatched: number;
  retried: number;
  deadLettered: number;
}

/**
 * Transactional outbox (#660).
 *
 * Producers call {@link enqueue} with their Prisma transaction client so the
 * outbox row commits atomically with the state change. {@link drain} is run by
 * OutboxDispatcherJob under a Redis lock and delivers each row at least once.
 *
 * Delivery is idempotent at the event level: a row is only handed to a handler
 * after an atomic `PENDING -> PROCESSING` claim (`FOR UPDATE SKIP LOCKED`), and
 * completion is a conditional update guarded by the claim owner, so a row that
 * is already DISPATCHED is never picked up again. If the process dies mid-flight
 * the row is reclaimed after the lock goes stale and retried.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly webhooks?: WebhooksService,
  ) {}

  /**
   * Writes an event row inside the caller's transaction. Must be awaited inside
   * the same `$transaction` as the state change so both commit or roll back
   * together.
   */
  async enqueue(
    tx: Prisma.TransactionClient,
    type: string,
    payload: Record<string, unknown>,
    options?: { dedupeKey?: string; availableAt?: Date },
  ) {
    return tx.outboxEvent.create({
      data: {
        type,
        payload: payload as Prisma.InputJsonValue,
        dedupeKey: options?.dedupeKey ?? null,
        ...(options?.availableAt ? { availableAt: options.availableAt } : {}),
      },
    });
  }

  /**
   * Claims and delivers all due events, up to a bounded number of batches.
   * `handler` defaults to fanning the event out to subscribed webhooks.
   */
  async drain(
    handler: OutboxHandler = this.dispatchWebhookEvent,
    batchSize: number = OUTBOX_BATCH_SIZE,
  ): Promise<DrainResult> {
    const workerId = randomUUID();
    const totals: DrainResult = {
      claimed: 0,
      dispatched: 0,
      retried: 0,
      deadLettered: 0,
    };

    for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch++) {
      const rows = await this.claimBatch(workerId, batchSize);
      if (rows.length === 0) break;

      totals.claimed += rows.length;
      for (const row of rows) {
        await this.processRow(row, workerId, handler, totals);
      }

      if (rows.length < batchSize) break;
    }

    return totals;
  }

  /** Current events per status, used by the backlog gauge. */
  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.prisma.outboxEvent.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});
  }

  private readonly dispatchWebhookEvent: OutboxHandler = async (
    type,
    payload,
  ) => {
    if (!this.webhooks) {
      throw new Error(
        'No outbox handler configured and WebhooksService is unavailable',
      );
    }
    await this.webhooks.dispatch(type as NotificationType, payload);
  };

  /**
   * Atomically claims due PENDING rows (and PROCESSING rows whose lock went
   * stale). `SKIP LOCKED` lets several pods drain concurrently without ever
   * handing the same row to two of them.
   */
  private async claimBatch(
    workerId: string,
    limit: number,
  ): Promise<ClaimedOutboxEvent[]> {
    return this.prisma.$queryRaw<ClaimedOutboxEvent[]>(Prisma.sql`
      UPDATE "outbox_events" AS oe
      SET "status" = 'PROCESSING',
          "lockedAt" = NOW(),
          "lockedBy" = ${workerId},
          "updatedAt" = NOW()
      FROM (
        SELECT "id"
        FROM "outbox_events"
        WHERE ("status" = 'PENDING' AND "availableAt" <= NOW())
           OR (
             "status" = 'PROCESSING'
             AND ("lockedAt" IS NULL OR "lockedAt" < NOW() - (${STALE_LOCK_SECONDS}::int * INTERVAL '1 second'))
           )
        ORDER BY "createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE oe."id" = due."id"
      RETURNING oe."id", oe."type", oe."payload", oe."attempts"
    `);
  }

  private async processRow(
    row: ClaimedOutboxEvent,
    workerId: string,
    handler: OutboxHandler,
    totals: DrainResult,
  ): Promise<void> {
    const payload = (row.payload ?? {}) as Record<string, unknown>;

    try {
      await handler(row.type, payload);

      const marked = await this.prisma.outboxEvent.updateMany({
        where: {
          id: row.id,
          status: OutboxStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: OutboxStatus.DISPATCHED,
          dispatchedAt: new Date(),
          attempts: { increment: 1 },
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });

      if (marked.count > 0) {
        totals.dispatched += 1;
        this.metrics?.recordOutboxEvent('dispatched');
      }
    } catch (err) {
      const attempts = row.attempts + 1;
      const deadLettered = attempts >= OUTBOX_MAX_ATTEMPTS;
      const message = err instanceof Error ? err.message : String(err);

      await this.prisma.outboxEvent.updateMany({
        where: {
          id: row.id,
          status: OutboxStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: deadLettered ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          attempts: { increment: 1 },
          lastError: message.slice(0, 1_000),
          availableAt: new Date(Date.now() + this.backoffMs(attempts)),
          lockedAt: null,
          lockedBy: null,
        },
      });

      if (deadLettered) {
        totals.deadLettered += 1;
        this.metrics?.recordOutboxEvent('dead_lettered');
        this.logger.error(
          `Outbox event ${row.id} (${row.type}) dead-lettered after ${attempts} attempts: ${message}`,
        );
      } else {
        totals.retried += 1;
        this.metrics?.recordOutboxEvent('retried');
        this.logger.warn(
          `Outbox event ${row.id} (${row.type}) failed on attempt ${attempts}, will retry: ${message}`,
        );
      }
    }
  }

  /** Exponential back-off with a 5 minute ceiling. */
  private backoffMs(attempts: number): number {
    return Math.min(2 ** attempts * 5_000, 5 * 60_000);
  }
}
