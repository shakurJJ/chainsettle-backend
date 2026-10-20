import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional, BadRequestException, ConflictException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { MilestonesService } from '../milestones/milestones.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ShipmentEventsPublisher } from '../graphql/shipment-events.publisher';
import { ShipmentsService } from '../shipments/shipments.service';
import { MetricsService } from '../../common/metrics/metrics.service';
import { NotificationType } from '@prisma/client';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { runTrackedJob } from '../../common/jobs/job-tracker.util';

const MAX_ATTEMPTS = 5;
const POLLER_LOCK_KEY = 'chainsettle:event-poller:leader';
/** Lock TTL must exceed the renew interval so a healthy leader keeps ownership. */
const POLLER_LOCK_TTL_MS = 15_000;
const POLLER_LOCK_RENEW_MS = 5_000;

/**
 * EventsService
 *
 * Polls the Stellar RPC every 5 seconds for new contract events emitted
 * by the ChainSettle contract. When events are detected:
 *
 * 1. The relevant DB records (shipments, milestones) are updated
 * 2. Notifications are dispatched to the relevant users
 * 3. The event is saved to the chain_events table for audit trail
 *
 * Failed events are persisted to failed_events (DLQ) and retried with
 * exponential back-off up to MAX_ATTEMPTS times.
 *
 * Only one process holds the Redis leader lock at a time so blue/green
 * deploys (or multi-replica) never double-process chain events.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  /** In-memory mirror of the DB cursor — updated after each processed event. */
  private lastProcessedLedger: number = 0;
  private unsubscribeFn: (() => void) | null = null;
  private reconnectBackoffMs = 0;
  private readonly lockToken = randomUUID();
  private isLeader = false;
  private leadershipTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly stellar: StellarService,
    private readonly milestones: MilestonesService,
    private readonly notifications: NotificationsService,
    private readonly gateway: NotificationsGateway,
    private readonly shipments: ShipmentsService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    @Optional() private readonly gqlPublisher?: ShipmentEventsPublisher,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  async onModuleInit() {
    if (process.env.SDK_GENERATE === '1') {
      this.logger.warn('Skipping event poller init (SDK_GENERATE=1)');
      return;
    }
    try {
      // Attempt to load the persisted cursor from the database
      const cursor = await this.prisma.eventCursor.findUnique({
        where: { id: 'main' },
      });

      if (cursor) {
        // Resume from where we left off
        this.lastProcessedLedger = cursor.lastProcessedLedger;
        this.logger.log(
          `Resuming event poller from persisted ledger ${this.lastProcessedLedger}`,
        );
      } else {
        // First-ever boot: seed from the current chain tip minus a small buffer
        const latest = await this.stellar.getLatestLedger();
        const seedLedger = Math.max(1, latest - 10);

        await this.prisma.eventCursor.create({
          data: { id: 'main', lastProcessedLedger: seedLedger },
        });

        this.lastProcessedLedger = seedLedger;
        this.logger.log(
          `Event cursor seeded at ledger ${this.lastProcessedLedger} (first boot)`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not initialise event cursor from DB: ${error.message} — will retry on first poll`,
      );
      try {
        const latest = await this.stellar.getLatestLedger();
        this.lastProcessedLedger = Math.max(1, latest - 10);
      } catch {
        this.lastProcessedLedger = 1;
      }
    }

    // Try to become leader immediately; keep contending so a deploy handoff is fast.
    await this.tryBecomeLeader();
    this.leadershipTimer = setInterval(() => {
      void this.tryBecomeLeader();
    }, POLLER_LOCK_RENEW_MS);
  }

  async onModuleDestroy() {
    if (this.leadershipTimer) {
      clearInterval(this.leadershipTimer);
      this.leadershipTimer = null;
    }
    await this.stepDownAsLeader();
  }

  private async tryBecomeLeader(): Promise<void> {
    if (this.isLeader) {
      const renewed = await this.redis.renewLock(
        POLLER_LOCK_KEY,
        this.lockToken,
        POLLER_LOCK_TTL_MS,
      );
      if (!renewed) {
        this.logger.warn('Lost event-poller leadership — stopping stream');
        await this.stopStreamSubscription();
        this.isLeader = false;
      }
      return;
    }

    const acquired = await this.redis.acquireLock(
      POLLER_LOCK_KEY,
      this.lockToken,
      POLLER_LOCK_TTL_MS,
    );
    if (!acquired) {
      return;
    }

    this.isLeader = true;
    this.logger.log(`Acquired event-poller leadership (token=${this.lockToken})`);
    this.startStreamSubscription();
  }

  private async stepDownAsLeader(): Promise<void> {
    await this.stopStreamSubscription();
    if (this.isLeader) {
      await this.redis.releaseLock(POLLER_LOCK_KEY, this.lockToken);
      this.isLeader = false;
      this.logger.log('Released event-poller leadership');
    }
  }

  private async stopStreamSubscription(): Promise<void> {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
  }

  // ----------------------------------------------------------
  // STREAMING SUBSCRIPTION
  // ----------------------------------------------------------

  private startStreamSubscription(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }

    this.logger.log(
      `Starting event stream from ledger ${this.lastProcessedLedger}`,
    );

    this.unsubscribeFn = this.stellar.subscribeToContractEvents(
      this.lastProcessedLedger,
      async (event) => {
        this.reconnectBackoffMs = 0;
        try {
          await this.processEvent(event);
        } catch (error) {
          this.metrics.incrementEventsFailed();
          await this.saveToDlq(event, error as Error);
        }
        this.lastProcessedLedger = Math.max(this.lastProcessedLedger, event.ledger + 1);
        try {
          await this.prisma.eventCursor.update({
            where: { id: 'main' },
            data: { lastProcessedLedger: this.lastProcessedLedger },
          });
          this.logger.debug(`Cursor persisted at ledger ${this.lastProcessedLedger}`);
        } catch (err) {
          this.logger.warn(`Cursor DB write failed (in-memory value still correct): ${(err as Error).message}`);
        }
      }
    );
  }

  // ----------------------------------------------------------
  // RETRY CRON — runs every minute, exponential back-off
  // ----------------------------------------------------------

  @Cron(CronExpression.EVERY_MINUTE, { name: 'failed-events-retry' })
  async retryFailedEvents() {
    return runTrackedJob(
      this.redis,
      'failed-events-retry',
      async () => {
        // Only the poller leader retries DLQ work to avoid duplicate side-effects.
        if (!this.isLeader) {
          return;
        }

        const now = new Date();

    const pending = await this.prisma.failedEvent.findMany({
      where: { resolvedAt: null, attemptCount: { lt: MAX_ATTEMPTS } },
    });

    // Only retry events whose back-off window has fully elapsed
    const toRetry = pending.filter((e) => {
      const backoffMs = Math.pow(2, e.attemptCount - 1) * 60 * 1000;
      return e.lastAttemptAt.getTime() + backoffMs <= now.getTime();
    });

    for (const failedEvent of toRetry) {
      try {
        await this.executeHandler(failedEvent.eventName, failedEvent.payload, {
          ledger: failedEvent.ledger,
          txHash: failedEvent.txHash,
        });

        await this.prisma.failedEvent.update({
          where: { id: failedEvent.id },
          data: { resolvedAt: new Date() },
        });

        this.logger.log(`Retry resolved failed event ${failedEvent.id} (${failedEvent.eventName})`);
      } catch (error) {
        const newCount = failedEvent.attemptCount + 1;

        await this.prisma.failedEvent.update({
          where: { id: failedEvent.id },
          data: {
            attemptCount: newCount,
            lastAttemptAt: new Date(),
            error: (error as Error).message,
          },
        });

        this.logger.warn(
          `Failed event ${failedEvent.id} retry ${newCount}/${MAX_ATTEMPTS}: ${(error as Error).message}`,
        );

        if (newCount >= MAX_ATTEMPTS) {
          await this.alertAdmins(failedEvent, error as Error);
        }
      }
    }
  },
  this.logger,
);
  }

  // ----------------------------------------------------------
  // EVENT DISPATCHER
  // ----------------------------------------------------------

  private async processEvent(event: any, tx?: any) {
    const eventName = this.extractEventName(event);
    const payload = this.extractPayload(event);

    this.logger.debug(`Event: ${eventName} | Ledger: ${event.ledger}`);

    await this.saveRawEvent(eventName, event, payload);
    await this.executeHandler(eventName, payload, event);
    this.metrics.incrementEventsProcessed(eventName);
    await this.publishGraphqlUpdate(payload);
  }

  /**
   * Process a single raw Soroban event during a backfill run.
   *
   * Identical to the live-poller path but intentionally skips the GraphQL
   * fanout (backfill replays are not real-time updates) and does not advance
   * the live cursor.  All idempotency guarantees are preserved:
   *  - `saveRawEvent` upserts into chain_events with `update: {}` so existing
   *    rows are never overwritten.
   *  - Domain handlers skip work that was already done (e.g. CONFIRMED check).
   *
   * Called by BackfillService; exposed as public so the two services remain
   * independently injectable without circular deps.
   */
  async processEventForBackfill(event: any): Promise<void> {
    const eventName = this.extractEventName(event);
    const payload = this.extractPayload(event);

    await this.saveRawEvent(eventName, event, payload);
    await this.executeHandler(eventName, payload, event);
    this.metrics.incrementEventsProcessed(eventName);
    // No GraphQL publish — backfill is a repair operation, not a live event.
  }

  /** Fan the processed chain event out to GraphQL subscribers (#431). */
  private async publishGraphqlUpdate(payload: any) {
    if (!this.gqlPublisher) return;
    const [shipmentId, milestoneIndex] = Array.isArray(payload) ? payload : [payload, undefined];
    if (shipmentId === undefined || shipmentId === null) return;
    await this.gqlPublisher.publishShipment(
      String(shipmentId),
      milestoneIndex === undefined ? undefined : Number(milestoneIndex),
    );
  }

  private async executeHandler(eventName: string, payload: any, meta: any) {
    switch (eventName) {
      case 'shipment_created':
        await this.handleShipmentCreated(payload, meta);
        break;
      case 'proof_submitted':
        await this.handleProofSubmitted(payload, meta);
        break;
      case 'milestone_confirmed':
        await this.handleMilestoneConfirmed(payload, meta);
        break;
      case 'dispute_raised':
        await this.handleDisputeRaised(payload, meta);
        break;
      case 'dispute_resolved':
        await this.handleDisputeResolved(payload, meta);
        break;
      case 'shipment_cancelled':
        await this.handleShipmentCancelled(payload, meta);
        break;
      default:
        this.logger.warn(`Unknown event: ${eventName}`);
    }
  }

  // ----------------------------------------------------------
  // EVENT HANDLERS
  // ----------------------------------------------------------

  private async handleShipmentCreated(payload: any, event: any) {
    const shipmentId = payload;
    this.logger.log(`Shipment created on-chain: ${shipmentId}`);
    // Record is created by the frontend POST /shipments; this is a safety-net.
  }

  private async handleProofSubmitted(payload: any, event: any) {
    const [shipmentId, milestoneIndex] = Array.isArray(payload) ? payload : [payload, 0];
    this.logger.log(`Proof submitted on-chain: ${shipmentId} milestone ${milestoneIndex}`);

    await this.milestones.markProofSubmitted(
      String(shipmentId),
      Number(milestoneIndex),
      '',
    );

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: String(shipmentId) },
    });

    if (shipment) {
      await this.notifications.notifyUser(
        shipment.buyerAddress,
        NotificationType.PROOF_SUBMITTED,
        'Proof submitted for review',
        `Milestone ${milestoneIndex} proof has been submitted for shipment ${shipmentId}. Please review and confirm.`,
        { shipmentId, milestoneIndex, proofHash: '' },
      );
    }
  }

  private async handleMilestoneConfirmed(payload: any, event: any) {
    const [shipmentId, milestoneIndex, paymentAmount] = Array.isArray(payload)
      ? payload
      : [payload, 0, 0];

    // The buyer may have already registered this confirmation via
    // POST /shipments/:id/milestones/:index/confirm — skip to avoid
    // double-notifying the supplier once the on-chain event arrives.
    const existing = await this.prisma.milestone.findUnique({
      where: {
        shipmentId_milestoneIndex: {
          shipmentId: String(shipmentId),
          milestoneIndex: Number(milestoneIndex),
        },
      },
    });
    if (existing?.status === 'CONFIRMED') {
      this.logger.debug(
        `Milestone ${shipmentId}[${milestoneIndex}] already confirmed — skipping duplicate event`,
      );
      return;
    }

    this.logger.log(
      `Milestone confirmed: ${shipmentId}[${milestoneIndex}] — ${paymentAmount} released`,
    );

    await this.milestones.markConfirmed(
      String(shipmentId),
      Number(milestoneIndex),
      BigInt(paymentAmount ?? 0),
    );

    await this.shipments.syncStatusFromChain(String(shipmentId));

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: String(shipmentId) },
    });

    if (shipment) {
      const humanAmount = this.stellar.toHumanAmount(
        BigInt(paymentAmount ?? 0),
        shipment.tokenDecimals,
      );

      await this.notifications.notifyUser(
        shipment.supplierAddress,
        NotificationType.PAYMENT_RELEASED,
        'Payment released',
        `${humanAmount} ${shipment.tokenSymbol} has been released for milestone ${milestoneIndex} on shipment ${shipmentId}.`,
        { shipmentId, milestoneIndex, paymentAmount: humanAmount, tokenSymbol: shipment.tokenSymbol },
      );
      
      await this.notifications.notifyWatchers(
        shipmentId,
        NotificationType.MILESTONE_CONFIRMED,
        'Milestone Confirmed',
        `Milestone ${milestoneIndex} for shipment ${shipmentId} has been confirmed.`,
        { shipmentId, milestoneIndex }
      );
    }
  }

  private async handleDisputeRaised(payload: any, event: any) {
    const [shipmentId, milestoneIndex] = Array.isArray(payload) ? payload : [payload, 0];
    this.logger.log(`Dispute raised: ${shipmentId}[${milestoneIndex}]`);

    await this.milestones.markDisputed(String(shipmentId), Number(milestoneIndex));

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: String(shipmentId) },
    });

    if (shipment) {
      for (const address of [shipment.supplierAddress, shipment.arbiterAddress]) {
        await this.notifications.notifyUser(
          address,
          NotificationType.DISPUTE_RAISED,
          'Dispute raised',
          `A dispute has been raised on milestone ${milestoneIndex} for shipment ${shipmentId}.`,
          { shipmentId, milestoneIndex },
        );
      }
    }
  }

  private async handleDisputeResolved(payload: any, event: any) {
    const [shipmentId, milestoneIndex, approved] = Array.isArray(payload)
      ? payload
      : [payload, 0, false];

    this.logger.log(
      `Dispute resolved: ${shipmentId}[${milestoneIndex}] approved=${approved}`,
    );

    await this.milestones.markResolved(
      String(shipmentId),
      Number(milestoneIndex),
      Boolean(approved),
    );

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: String(shipmentId) },
    });

    if (shipment) {
      for (const address of [shipment.buyerAddress, shipment.supplierAddress]) {
        await this.notifications.notifyUser(
          address,
          NotificationType.DISPUTE_RESOLVED,
          `Dispute ${approved ? 'approved' : 'rejected'}`,
          `The dispute on milestone ${milestoneIndex} (shipment ${shipmentId}) was ${
            approved ? 'approved — payment released' : 'rejected — supplier must resubmit proof'
          }.`,
          { shipmentId, milestoneIndex, approved },
        );
      }
    }
  }

  private async handleShipmentCancelled(payload: any, event: any) {
    const [shipmentId, refundAmount] = Array.isArray(payload) ? payload : [payload, undefined];
    this.logger.log(`Shipment cancelled on-chain: ${shipmentId}`);

    await this.prisma.shipment.update({
      where: { id: String(shipmentId) },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        refundTxHash: event.txHash ?? null,
      },
    });
  }

  // ----------------------------------------------------------
  // DLQ HELPERS
  // ----------------------------------------------------------

  private async saveToDlq(event: any, error: Error) {
    const eventName = this.extractEventName(event);
    const payload = this.extractPayload(event);
    const txHash = event.txHash ?? '';

    this.logger.error('Event processing failed — saving to DLQ', {
      eventName,
      ledger: event.ledger,
      txHash,
      error: error.message,
    });

    try {
      await this.prisma.failedEvent.upsert({
        where: { txHash_eventName: { txHash, eventName } },
        create: {
          eventName,
          ledger: event.ledger ?? 0,
          txHash,
          payload: payload ?? {},
          error: error.message,
          attemptCount: 1,
          lastAttemptAt: new Date(),
        },
        update: {
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
          error: error.message,
        },
      });
    } catch (dlqError) {
      this.logger.error('Failed to save event to DLQ', (dlqError as Error).message);
    }
  }

  private async alertAdmins(failedEvent: any, error: Error) {
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN' } });

    for (const admin of admins) {
      await this.notifications.notifyUser(
        admin.stellarAddress,
        NotificationType.SYSTEM_ALERT,
        'Failed event exhausted retries',
        `Event "${failedEvent.eventName}" (id: ${failedEvent.id}) failed ${MAX_ATTEMPTS} times and will not be retried automatically. Last error: ${error.message}`,
        { failedEventId: failedEvent.id, eventName: failedEvent.eventName },
      );
    }
  }

  // ----------------------------------------------------------
  // ADMIN QUERY METHODS (called by EventsController)
  // ----------------------------------------------------------

  async getAdminFailedEvents(page = 1, limit = 20) {
    const where = { resolvedAt: null };

    const [events, total] = await this.prisma.$transaction([
      this.prisma.failedEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.failedEvent.count({ where }),
    ]);

    return { data: events, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async retryFailedEventById(id: string) {
    const failedEvent = await this.prisma.failedEvent.findUniqueOrThrow({ where: { id } });

    await this.executeHandler(failedEvent.eventName, failedEvent.payload, {
      ledger: failedEvent.ledger,
      txHash: failedEvent.txHash,
    });

    await this.prisma.failedEvent.update({
      where: { id },
      data: { resolvedAt: new Date() },
    });

    this.logger.log(`Admin manually retried and resolved failed event ${id}`);
  }

  async getFailedEventById(id: string) {
    return this.prisma.failedEvent.findUniqueOrThrow({ where: { id } });
  }

  // ----------------------------------------------------------
  // READ ENDPOINTS (for EventsController)
  // ----------------------------------------------------------

  async findAll(filters: {
    shipmentId?: string;
    startLedger?: number;
    endLedger?: number;
    eventName?: string;
    page?: number;
    limit?: number;
  }) {
    const {
      shipmentId,
      startLedger,
      endLedger,
      eventName,
      page = 1,
      limit = 20,
    } = filters;

    const where: any = {};

    if (shipmentId) where.shipmentId = shipmentId;
    if (eventName) where.eventName = eventName;

    // Apply ledger range boundaries using Prisma comparison filters
    if (startLedger || endLedger) {
      where.ledger = {
        ...(startLedger && { gte: startLedger }),
        ...(endLedger && { lte: endLedger }),
      };
    }

    // Read-heavy list — route through replica when configured
    const db = this.prisma.read;
    const [events, total] = await db.$transaction([
      db.chainEvent.findMany({
        where,
        orderBy: { ledger: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.chainEvent.count({ where }),
    ]);

    return { 
      data: events, 
      meta: { 
        total, 
        page, 
        limit,
        totalPages: Math.ceil(total / limit)
      } 
    };
  }

  /**
   * Admin diagnostics: compares the in-memory cursor against the
   * DB-persisted one and the live chain tip to surface poller lag.
   */
  async getCursorStatus() {
    const persisted = await this.prisma.eventCursor.findUnique({ where: { id: 'main' } });
    const chainTip = await this.stellar.getLatestLedger();
    const lag = chainTip - this.lastProcessedLedger;

    return {
      inMemoryLedger: this.lastProcessedLedger,
      persistedLedger: persisted?.lastProcessedLedger ?? null,
      chainTip,
      lag,
      updatedAt: persisted?.updatedAt ?? null,
      healthy: lag <= 100,
      isPollerLeader: this.isLeader,
    };
  }

  // ----------------------------------------------------------
  // ADMIN — Cursor rewind
  // ----------------------------------------------------------

  /**
   * Moves the event-poller cursor back to `toLedger` so that all events
   * from that ledger onward are reprocessed.
   *
   * Safety contract:
   *  1. `toLedger` must be ≥ 1 and ≤ current chain tip (no future ledgers).
   *  2. `toLedger` must still be within the Soroban RPC retention window —
   *     validated by probing `getOldestAvailableLedger()`.
   *  3. The operation holds the distributed poller lock for its entire
   *     duration so no competing replica can advance the cursor while we
   *     rewind it.
   *  4. Once the DB and in-memory cursor are updated the stream is restarted
   *     from the new position; existing `chain_events` upserts guarantee that
   *     already-processed events will not create duplicate DB rows.
   *
   * @param toLedger   - Target ledger sequence number.
   * @param actor      - Admin user object from the JWT (for audit logging).
   * @param reason     - Human-readable justification stored in the audit log.
   * @param ipAddress  - Caller IP forwarded from the HTTP request.
   */
  async rewindCursor(
    toLedger: number,
    actor: { id?: string; stellarAddress?: string },
    reason: string,
    ipAddress?: string,
  ): Promise<{
    previousLedger: number;
    newLedger: number;
    chainTip: number;
    oldestAvailableLedger: number;
  }> {
    // --- 1. Validate upper bound: cannot rewind to a future ledger ----------
    const chainTip = await this.stellar.getLatestLedger();
    if (toLedger > chainTip) {
      throw new BadRequestException(
        `toLedger (${toLedger}) is ahead of the current chain tip (${chainTip}). ` +
          `Choose a ledger ≤ ${chainTip}.`,
      );
    }

    // --- 2. Validate lower bound: must be within RPC retention window -------
    const oldestAvailable = await this.stellar.getOldestAvailableLedger();
    if (toLedger < oldestAvailable) {
      throw new BadRequestException(
        `toLedger (${toLedger}) is older than the earliest ledger available on the ` +
          `Soroban RPC node (${oldestAvailable}). The node cannot serve events that ` +
          `far back. Choose a ledger ≥ ${oldestAvailable}.`,
      );
    }

    // --- 3. Acquire or confirm leadership of the distributed poller lock ----
    //
    // We must own the lock before touching the cursor so no other replica
    // advances it concurrently.  If this instance is already the leader it
    // already holds the lock.  If not (e.g. multi-replica and admin hits a
    // follower) we do a one-shot acquisition attempt.
    let acquiredHere = false;
    if (!this.isLeader) {
      const token = this.lockToken;
      const acquired = await this.redis.acquireLock(
        POLLER_LOCK_KEY,
        token,
        POLLER_LOCK_TTL_MS,
      );
      if (!acquired) {
        throw new ConflictException(
          'The event-poller lock is currently held by another replica. ' +
            'Retry in a few seconds, or hit the leader replica directly.',
        );
      }
      acquiredHere = true;
      this.isLeader = true;
    }

    try {
      // --- 4. Read previous cursor value (for audit trail) ------------------
      const persisted = await this.prisma.eventCursor.findUnique({
        where: { id: 'main' },
      });
      const previousLedger = persisted?.lastProcessedLedger ?? this.lastProcessedLedger;

      // --- 5. Persist the new cursor to the DB ------------------------------
      await this.prisma.eventCursor.upsert({
        where: { id: 'main' },
        create: { id: 'main', lastProcessedLedger: toLedger },
        update: { lastProcessedLedger: toLedger },
      });

      // --- 6. Update the in-memory mirror so the restarted stream uses it ---
      this.lastProcessedLedger = toLedger;

      // --- 7. Restart the stream from the new position ----------------------
      this.startStreamSubscription();

      this.logger.log(
        `[rewindCursor] Cursor rewound from ${previousLedger} → ${toLedger} ` +
          `by ${actor.stellarAddress ?? 'unknown'}. Reason: ${reason}`,
      );

      // --- 8. Explicit audit log entry (richer metadata than interceptor) ---
      await this.auditLog?.record({
        actorId: actor.id,
        actorAddress: actor.stellarAddress ?? 'SYSTEM',
        action: 'events.cursor.rewind',
        resourceType: 'EventCursor',
        resourceId: 'main',
        metadata: {
          previousLedger,
          newLedger: toLedger,
          chainTip,
          oldestAvailableLedger: oldestAvailable,
          reason,
        },
        ipAddress,
      });

      return { previousLedger, newLedger: toLedger, chainTip, oldestAvailableLedger: oldestAvailable };
    } finally {
      // Release the lock only if WE acquired it here (i.e. we were a
      // follower that temporarily grabbed leadership for this operation).
      // If we were already the leader, keep the lock — the normal renewal
      // interval will maintain it.
      if (acquiredHere) {
        await this.redis.releaseLock(POLLER_LOCK_KEY, this.lockToken);
        this.isLeader = false;
      }
    }
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

  private extractPayload(event: any): any {
    try {
      return event.value ? JSON.parse(JSON.stringify(event.value)) : null;
    } catch {
      return null;
    }
  }

  private async saveRawEvent(eventName: string, event: any, payload: any, tx?: any) {
    const client = tx || this.prisma;
    try {
      const shipmentId = this.extractShipmentId(payload);

      await client.chainEvent.upsert({
        where: {
          txHash_eventName: {
            txHash: event.txHash ?? '',
            eventName,
          },
        },
        update: {}, 
        create: {
          eventName,
          ledger: event.ledger ?? 0,
          txHash: event.txHash ?? '',
          payload: payload ?? {},
          shipmentId: shipmentId || undefined,
        },
      });
    } catch (error) {
      this.logger.error('Failed to save raw event', (error as Error).message);
    }
  }

  private extractShipmentId(payload: any): string | null {
    if (typeof payload === 'string') return payload;
    if (Array.isArray(payload) && typeof payload[0] === 'string') return payload[0];
    return null;
  }
}