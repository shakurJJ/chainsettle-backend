import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { EventsService } from './events.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { MAX_BACKFILL_RANGE } from './dto/start-backfill.dto';

/** Redis key that enforces only one backfill runs at a time across all replicas. */
const BACKFILL_LOCK_KEY = 'chainsettle:event-backfill:lock';
/** Lock TTL — renewed every BACKFILL_LOCK_RENEW_MS while the job is running. */
const BACKFILL_LOCK_TTL_MS = 30_000;
const BACKFILL_LOCK_RENEW_MS = 10_000;

/** How many ledgers to fetch per RPC call inside the backfill loop. */
const BATCH_SIZE = 1_000;

/**
 * BackfillService
 *
 * Processes a contiguous ledger range by fetching events from Stellar RPC
 * and running them through the same handlers as the live poller.  The live
 * cursor is never touched — polling continues in parallel.
 *
 * Progress is persisted to the `backfill_runs` table so callers can poll
 * GET /admin/events/backfill/:id for status.
 *
 * Concurrency: a Redis lock (`chainsettle:event-backfill:lock`) ensures only
 * one backfill job runs at a time across all replicas.  A second request
 * while a job is active receives a 409.
 *
 * Idempotency: every event is processed via `EventsService.processEventForBackfill`
 * which upserts into `chain_events` with `update: {}` — duplicate raw event
 * rows are never created.  Domain handlers guard their own state changes
 * (e.g. milestones already CONFIRMED are skipped).
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly stellar: StellarService,
    private readonly eventsService: EventsService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ----------------------------------------------------------
  // START
  // ----------------------------------------------------------

  /**
   * Validate the requested range, acquire the distributed lock, persist a
   * PENDING BackfillRun row, then kick off the background job asynchronously.
   *
   * Returns the newly created BackfillRun immediately — the caller polls
   * GET /admin/events/backfill/:id for progress.
   */
  async startBackfill(
    fromLedger: number,
    toLedger: number,
    actor: { id?: string; stellarAddress?: string },
    ipAddress?: string,
  ) {
    // --- 1. Cross-field validation -----------------------------------------
    if (toLedger < fromLedger) {
      throw new BadRequestException(
        `toLedger (${toLedger}) must be ≥ fromLedger (${fromLedger}).`,
      );
    }

    const span = toLedger - fromLedger;
    if (span > MAX_BACKFILL_RANGE) {
      throw new BadRequestException(
        `Requested range is ${span.toLocaleString()} ledgers. ` +
          `Maximum allowed is ${MAX_BACKFILL_RANGE.toLocaleString()} ledgers per backfill. ` +
          `Split the range into smaller jobs.`,
      );
    }

    // --- 2. Validate against chain tip and retention window -----------------
    const [chainTip, oldestAvailable] = await Promise.all([
      this.stellar.getLatestLedger(),
      this.stellar.getOldestAvailableLedger(),
    ]);

    if (fromLedger < oldestAvailable) {
      throw new BadRequestException(
        `fromLedger (${fromLedger}) is older than the earliest ledger the RPC ` +
          `node can serve (${oldestAvailable}). Choose fromLedger ≥ ${oldestAvailable}.`,
      );
    }

    if (toLedger > chainTip) {
      throw new BadRequestException(
        `toLedger (${toLedger}) is ahead of the current chain tip (${chainTip}). ` +
          `Choose toLedger ≤ ${chainTip}.`,
      );
    }

    // --- 3. Enforce one-at-a-time via Redis lock ----------------------------
    const lockToken = randomUUID();
    const acquired = await this.redis.acquireLock(
      BACKFILL_LOCK_KEY,
      lockToken,
      BACKFILL_LOCK_TTL_MS,
    );
    if (!acquired) {
      // Check whether there is actually an active DB row — gives a richer 409.
      const active = await this.prisma.backfillRun.findFirst({
        where: { status: { in: ['PENDING', 'RUNNING'] } },
        orderBy: { startedAt: 'desc' },
      });

      throw new ConflictException(
        active
          ? `A backfill job is already running (id: ${active.id}, ` +
              `ledgers ${active.fromLedger}–${active.toLedger}, status: ${active.status}). ` +
              `Wait for it to complete before starting another.`
          : 'A backfill lock is held by another process. Retry in a few seconds.',
      );
    }

    // --- 4. Persist the run record -----------------------------------------
    const run = await this.prisma.backfillRun.create({
      data: {
        fromLedger,
        toLedger,
        status: 'PENDING',
        initiatedBy: actor.stellarAddress ?? null,
      },
    });

    // --- 5. Audit log -------------------------------------------------------
    await this.auditLog.record({
      actorId: actor.id,
      actorAddress: actor.stellarAddress ?? 'SYSTEM',
      action: 'events.backfill.start',
      resourceType: 'BackfillRun',
      resourceId: run.id,
      metadata: { fromLedger, toLedger, span, chainTip, oldestAvailable },
      ipAddress,
    });

    this.logger.log(
      `Backfill run ${run.id} created for ledgers ${fromLedger}–${toLedger} ` +
        `by ${actor.stellarAddress ?? 'unknown'}`,
    );

    // --- 6. Run the job in the background (non-blocking) --------------------
    // We intentionally do NOT await here so the HTTP response returns immediately.
    void this.runBackfillJob(run.id, fromLedger, toLedger, lockToken, actor);

    return run;
  }

  // ----------------------------------------------------------
  // BACKGROUND JOB
  // ----------------------------------------------------------

  private async runBackfillJob(
    runId: string,
    fromLedger: number,
    toLedger: number,
    lockToken: string,
    actor: { id?: string; stellarAddress?: string },
  ): Promise<void> {
    // Transition to RUNNING
    await this.prisma.backfillRun.update({
      where: { id: runId },
      data: { status: 'RUNNING', currentLedger: fromLedger },
    });

    let processedCount = 0;
    let errorCount = 0;
    const errorSummary: { ledger: number; txHash: string; eventName: string; error: string }[] = [];
    let currentLedger = fromLedger;

    // Renew the lock periodically for long-running backfills
    const renewTimer = setInterval(async () => {
      const renewed = await this.redis.renewLock(
        BACKFILL_LOCK_KEY,
        lockToken,
        BACKFILL_LOCK_TTL_MS,
      );
      if (!renewed) {
        this.logger.warn(`Backfill ${runId}: lock renewal failed — job will continue but may race`);
      }
    }, BACKFILL_LOCK_RENEW_MS);

    try {
      while (currentLedger <= toLedger) {
        const batchEnd = Math.min(currentLedger + BATCH_SIZE - 1, toLedger);

        let events: any[];
        try {
          events = await this.stellar.fetchContractEvents(currentLedger);
        } catch (fetchErr) {
          // RPC fetch failure for this batch — record and advance to avoid infinite loop
          this.logger.error(
            `Backfill ${runId}: RPC fetch failed at ledger ${currentLedger}: ${(fetchErr as Error).message}`,
          );
          errorCount++;
          errorSummary.push({
            ledger: currentLedger,
            txHash: '',
            eventName: 'rpc_fetch_error',
            error: (fetchErr as Error).message,
          });
          currentLedger = batchEnd + 1;
          continue;
        }

        // Filter to events within our batch window (RPC may return beyond batchEnd)
        const batchEvents = events.filter(
          (e) => e.ledger >= currentLedger && e.ledger <= batchEnd,
        );

        for (const event of batchEvents) {
          try {
            await this.eventsService.processEventForBackfill(event);
            processedCount++;
          } catch (handlerErr) {
            errorCount++;
            const summary = {
              ledger: event.ledger ?? currentLedger,
              txHash: event.txHash ?? '',
              eventName: this.extractEventName(event),
              error: (handlerErr as Error).message,
            };
            errorSummary.push(summary);
            this.logger.warn(
              `Backfill ${runId}: handler error for ${summary.eventName} ` +
                `tx=${summary.txHash} ledger=${summary.ledger}: ${summary.error}`,
            );
          }
        }

        // Advance cursor:
        // If the RPC returned a full page (100 events), the last event's ledger
        // tells us where the dense region ends — restart from there to avoid
        // skipping events in high-throughput ledger ranges.
        // If the page was sparse (< 100 events) we know we've seen everything
        // up to batchEnd and can jump the full batch window.
        const lastEventLedger = batchEvents.length > 0
          ? Math.max(...batchEvents.map((e) => e.ledger as number))
          : null;
        const hitPageLimit = events.length >= 100;

        if (hitPageLimit && lastEventLedger !== null && lastEventLedger < batchEnd) {
          // Dense range — re-scan from the last seen ledger (inclusive)
          // to catch any events in the same ledger that were cut off.
          currentLedger = lastEventLedger;
        } else {
          currentLedger = batchEnd + 1;
        }

        // Persist progress after each batch
        await this.prisma.backfillRun.update({
          where: { id: runId },
          data: {
            processedCount,
            errorCount,
            currentLedger: Math.min(currentLedger, toLedger),
            // Keep a rolling cap of 500 errors in the summary to avoid unbounded JSON
            errorSummary: errorSummary.slice(-500) as any,
          },
        });

        this.logger.debug(
          `Backfill ${runId}: progress ${Math.min(currentLedger - 1, toLedger)}/${toLedger} ` +
            `processed=${processedCount} errors=${errorCount}`,
        );
      }

      // --- Completed successfully ------------------------------------------
      await this.prisma.backfillRun.update({
        where: { id: runId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          processedCount,
          errorCount,
          currentLedger: toLedger,
          errorSummary: errorSummary.slice(-500) as any,
        },
      });

      await this.auditLog.record({
        actorId: actor.id,
        actorAddress: actor.stellarAddress ?? 'SYSTEM',
        action: 'events.backfill.complete',
        resourceType: 'BackfillRun',
        resourceId: runId,
        metadata: { fromLedger, toLedger, processedCount, errorCount },
      });

      this.logger.log(
        `Backfill run ${runId} COMPLETED — ` +
          `processed=${processedCount} errors=${errorCount} ` +
          `range=${fromLedger}–${toLedger}`,
      );
    } catch (fatalErr) {
      // --- Unexpected fatal error -------------------------------------------
      this.logger.error(
        `Backfill run ${runId} FAILED: ${(fatalErr as Error).message}`,
        (fatalErr as Error).stack,
      );

      await this.prisma.backfillRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          processedCount,
          errorCount,
          errorSummary: [
            ...errorSummary.slice(-499),
            {
              ledger: currentLedger,
              txHash: '',
              eventName: 'fatal',
              error: (fatalErr as Error).message,
            },
          ] as any,
        },
      });

      await this.auditLog.record({
        actorId: actor.id,
        actorAddress: actor.stellarAddress ?? 'SYSTEM',
        action: 'events.backfill.failed',
        resourceType: 'BackfillRun',
        resourceId: runId,
        metadata: {
          fromLedger,
          toLedger,
          processedCount,
          errorCount,
          error: (fatalErr as Error).message,
        },
      });
    } finally {
      clearInterval(renewTimer);
      await this.redis.releaseLock(BACKFILL_LOCK_KEY, lockToken);
      this.logger.debug(`Backfill ${runId}: lock released`);
    }
  }

  // ----------------------------------------------------------
  // QUERY
  // ----------------------------------------------------------

  /**
   * Return the current state of a backfill run.
   * Calculates a progress percentage for convenience.
   */
  async getBackfillRun(id: string) {
    const run = await this.prisma.backfillRun.findUnique({ where: { id } });
    if (!run) {
      throw new NotFoundException(`Backfill run ${id} not found`);
    }

    const total = run.toLedger - run.fromLedger + 1;
    const done = run.currentLedger != null
      ? Math.min(run.currentLedger - run.fromLedger + 1, total)
      : 0;
    const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

    return {
      ...run,
      progressPct,
      totalLedgers: total,
    };
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  private extractEventName(event: any): string {
    try {
      const topics = event.topic ?? [];
      if (topics.length > 0) return topics[0]?.toString() ?? 'unknown';
    } catch {}
    return 'unknown';
  }
}
