import { OutboxStatus } from '@prisma/client';
import { OUTBOX_MAX_ATTEMPTS, OutboxService } from './outbox.service';

const metrics = { recordOutboxEvent: jest.fn() };
const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'evt-1',
    type: 'MILESTONE_CONFIRMED',
    payload: { shipmentId: 'SHIP-1' },
    attempts: 0,
    ...overrides,
  };
}

function buildPrisma() {
  return {
    outboxEvent: {
      create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
}

describe('OutboxService', () => {
  let prisma: any;
  let service: OutboxService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = buildPrisma();
    service = new OutboxService(prisma, metrics as any, webhooks as any);
  });

  describe('enqueue', () => {
    it('writes the event through the caller transaction client', async () => {
      const tx = {
        outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-1' }) },
      } as any;

      await service.enqueue(tx, 'MILESTONE_CONFIRMED', {
        shipmentId: 'SHIP-1',
      });

      expect(tx.outboxEvent.create).toHaveBeenCalledWith({
        data: {
          type: 'MILESTONE_CONFIRMED',
          payload: { shipmentId: 'SHIP-1' },
          dedupeKey: null,
        },
      });
      // Never writes outside the caller's transaction.
      expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
    });

    it('passes an optional dedupe key and availableAt through', async () => {
      const tx = {
        outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-1' }) },
      } as any;
      const availableAt = new Date(Date.now() + 60_000);

      await service.enqueue(
        tx,
        'PAYMENT_RELEASED',
        {},
        { dedupeKey: 'pay-1', availableAt },
      );

      expect(tx.outboxEvent.create).toHaveBeenCalledWith({
        data: {
          type: 'PAYMENT_RELEASED',
          payload: {},
          dedupeKey: 'pay-1',
          availableAt,
        },
      });
    });
  });

  describe('drain', () => {
    it('delivers a claimed event and marks it DISPATCHED', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([row()]);
      const handler = jest.fn().mockResolvedValue(undefined);

      const result = await service.drain(handler);

      expect(handler).toHaveBeenCalledWith('MILESTONE_CONFIRMED', {
        shipmentId: 'SHIP-1',
      });
      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'evt-1',
          status: OutboxStatus.PROCESSING,
          lockedBy: expect.any(String),
        },
        data: expect.objectContaining({
          status: OutboxStatus.DISPATCHED,
          dispatchedAt: expect.any(Date),
          attempts: { increment: 1 },
        }),
      });
      expect(result).toMatchObject({
        claimed: 1,
        dispatched: 1,
        retried: 0,
        deadLettered: 0,
      });
      expect(metrics.recordOutboxEvent).toHaveBeenCalledWith('dispatched');
    });

    it('does nothing when no events are due', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      const handler = jest.fn();

      const result = await service.drain(handler);

      expect(handler).not.toHaveBeenCalled();
      expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
      expect(result.claimed).toBe(0);
    });

    it('is idempotent: only the claim owner can complete the row, and a lost race is not counted twice', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([row()]);
      // Another worker already completed the row, so the conditional update matches nothing.
      prisma.outboxEvent.updateMany.mockResolvedValueOnce({ count: 0 });
      const handler = jest.fn().mockResolvedValue(undefined);

      const result = await service.drain(handler);

      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: OutboxStatus.PROCESSING }),
        }),
      );
      expect(result.dispatched).toBe(0);
      expect(metrics.recordOutboxEvent).not.toHaveBeenCalled();
    });

    it('returns a failed event to PENDING with a back-off when the handler fails', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([row({ attempts: 1 })]);
      const handler = jest.fn().mockRejectedValue(new Error('downstream down'));

      const result = await service.drain(handler);

      const update = prisma.outboxEvent.updateMany.mock.calls[0][0];
      expect(update.data.status).toBe(OutboxStatus.PENDING);
      expect(update.data.lastError).toBe('downstream down');
      expect(update.data.availableAt.getTime()).toBeGreaterThan(Date.now());
      expect(result).toMatchObject({
        claimed: 1,
        dispatched: 0,
        retried: 1,
        deadLettered: 0,
      });
      expect(metrics.recordOutboxEvent).toHaveBeenCalledWith('retried');
    });

    it(`dead-letters an event after ${OUTBOX_MAX_ATTEMPTS} attempts`, async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        row({ attempts: OUTBOX_MAX_ATTEMPTS - 1 }),
      ]);
      const handler = jest.fn().mockRejectedValue(new Error('still down'));

      const result = await service.drain(handler);

      const update = prisma.outboxEvent.updateMany.mock.calls[0][0];
      expect(update.data.status).toBe(OutboxStatus.FAILED);
      expect(result.deadLettered).toBe(1);
      expect(metrics.recordOutboxEvent).toHaveBeenCalledWith('dead_lettered');
    });

    it('defaults to fanning events out to webhooks', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([row()]);

      await service.drain();

      expect(webhooks.dispatch).toHaveBeenCalledWith('MILESTONE_CONFIRMED', {
        shipmentId: 'SHIP-1',
      });
    });
  });

  describe('countByStatus', () => {
    it('maps grouped counts by status', async () => {
      prisma.outboxEvent.groupBy.mockResolvedValueOnce([
        { status: OutboxStatus.PENDING, _count: { _all: 3 } },
        { status: OutboxStatus.FAILED, _count: { _all: 1 } },
      ]);

      await expect(service.countByStatus()).resolves.toEqual({
        [OutboxStatus.PENDING]: 3,
        [OutboxStatus.FAILED]: 1,
      });
    });
  });
});
