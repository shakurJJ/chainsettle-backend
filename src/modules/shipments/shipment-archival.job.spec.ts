import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { envValidationSchema } from '../../config/env.validation';
import {
  ARCHIVAL_CRON_JOB_NAME,
  DEFAULT_ARCHIVAL_CRON,
  ShipmentArchivalJob,
} from './shipment-archival.job';

describe('ShipmentArchivalJob scheduling', () => {
  let registry: SchedulerRegistry;

  const createJob = (env: Record<string, string>) =>
    new ShipmentArchivalJob(
      {} as PrismaService,
      {} as RedisService,
      { get: (key: string, fallback?: unknown) => env[key] ?? fallback } as ConfigService,
      registry,
    );

  beforeEach(() => {
    registry = new SchedulerRegistry();
  });

  afterEach(() => {
    registry.getCronJobs().forEach((job) => job.stop());
  });

  it('registers with the default schedule when SHIPMENT_ARCHIVAL_CRON is unset', () => {
    createJob({}).onModuleInit();

    const job: CronJob = registry.getCronJob(ARCHIVAL_CRON_JOB_NAME);
    expect(job.cronTime.source).toBe(DEFAULT_ARCHIVAL_CRON);
  });

  it('honours SHIPMENT_ARCHIVAL_CRON', () => {
    createJob({ SHIPMENT_ARCHIVAL_CRON: '*/15 * * * *' }).onModuleInit();

    const job: CronJob = registry.getCronJob(ARCHIVAL_CRON_JOB_NAME);
    expect(job.cronTime.source).toBe('*/15 * * * *');
  });
});

describe('SHIPMENT_ARCHIVAL_CRON env validation', () => {
  const baseEnv = {
    JWT_SECRET: 'secret',
    DATABASE_URL: 'postgresql://localhost/db',
  };

  it('defaults to 0 3 * * *', () => {
    const { value } = envValidationSchema.validate(baseEnv, { allowUnknown: true });
    expect(value.SHIPMENT_ARCHIVAL_CRON).toBe(DEFAULT_ARCHIVAL_CRON);
  });

  it('accepts a valid cron expression', () => {
    const { error } = envValidationSchema.extract('SHIPMENT_ARCHIVAL_CRON').validate('30 2 * * 1');
    expect(error).toBeUndefined();
  });

  it('rejects an invalid cron expression', () => {
    const { error } = envValidationSchema.extract('SHIPMENT_ARCHIVAL_CRON').validate('not a cron');
    expect(error?.message).toMatch(/valid cron expression/);
  });
});

describe('ShipmentArchivalJob runArchival execution', () => {
  let job: ShipmentArchivalJob;
  let prisma: any;
  let redis: any;
  let config: any;
  let txMock: any;

  beforeEach(() => {
    txMock = {
      archivedShipment: { upsert: jest.fn().mockResolvedValue({}) },
      chainEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      milestone: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      shipment: { delete: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      shipment: { findMany: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (callback) => callback(txMock)),
    };

    redis = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };

    config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'SHIPMENT_ARCHIVAL_DAYS') return 90;
        return fallback;
      }),
    };

    job = new ShipmentArchivalJob(
      prisma as PrismaService,
      redis as RedisService,
      config as ConfigService,
      new SchedulerRegistry(),
    );
  });

  it('skips archival when lock acquisition fails (lock contention)', async () => {
    redis.acquireLock.mockResolvedValue(false);

    await job.runArchival();

    expect(redis.acquireLock).toHaveBeenCalledWith(
      'chainsettle:shipment-archival:lock',
      expect.any(String),
      10 * 60 * 1000,
    );
    expect(prisma.shipment.findMany).not.toHaveBeenCalled();
    expect(redis.releaseLock).not.toHaveBeenCalled();
  });

  it('archives completed and cancelled shipments older than cutoff', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const mockCompletedShipment = {
      id: 'ship-1',
      status: 'COMPLETED',
      buyerAddress: 'GBUYER123',
      supplierAddress: 'GSUPPLIER123',
      logisticsAddress: 'GLOGISTICS123',
      arbiterAddress: 'GARBITER123',
      referenceNumber: 'REF-001',
      cancelledAt: null,
      updatedAt: oldDate,
      milestones: [
        {
          id: 'm1',
          milestoneIndex: 0,
          confirmedAt: oldDate,
          disputeEvidence: [],
          proofSubmissions: [],
        },
      ],
      events: [{ id: 'ev1', ledger: 100 }],
      comments: [{ id: 'c1', text: 'Delivered' }],
      shipmentNotes: [],
      trackingUpdates: [],
      watchers: [],
    };

    const mockCancelledShipment = {
      id: 'ship-2',
      status: 'CANCELLED',
      buyerAddress: 'GBUYER456',
      supplierAddress: 'GSUPPLIER456',
      logisticsAddress: null,
      arbiterAddress: null,
      referenceNumber: 'REF-002',
      cancelledAt: oldDate,
      updatedAt: oldDate,
      milestones: [],
      events: [],
      comments: [],
      shipmentNotes: [],
      trackingUpdates: [],
      watchers: [],
    };

    prisma.shipment.findMany
      .mockResolvedValueOnce([mockCompletedShipment, mockCancelledShipment])
      .mockResolvedValueOnce([]);

    await job.runArchival();

    expect(prisma.shipment.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['COMPLETED', 'CANCELLED'] },
        updatedAt: { lte: expect.any(Date) },
      },
      take: 50,
      orderBy: { updatedAt: 'asc' },
      include: expect.any(Object),
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);

    expect(txMock.archivedShipment.upsert).toHaveBeenCalledWith({
      where: { id: 'ship-1' },
      create: expect.objectContaining({
        id: 'ship-1',
        status: 'COMPLETED',
        buyerAddress: 'GBUYER123',
        supplierAddress: 'GSUPPLIER123',
        referenceNumber: 'REF-001',
        terminalAt: oldDate,
        payload: expect.any(Object),
      }),
      update: expect.objectContaining({
        status: 'COMPLETED',
        terminalAt: oldDate,
        payload: expect.any(Object),
        archivedAt: expect.any(Date),
      }),
    });
    expect(txMock.chainEvent.updateMany).toHaveBeenCalledWith({
      where: { shipmentId: 'ship-1' },
      data: { shipmentId: null },
    });
    expect(txMock.milestone.deleteMany).toHaveBeenCalledWith({ where: { shipmentId: 'ship-1' } });
    expect(txMock.shipment.delete).toHaveBeenCalledWith({ where: { id: 'ship-1' } });

    expect(redis.releaseLock).toHaveBeenCalledWith('chainsettle:shipment-archival:lock', expect.any(String));
  });

  it('skips shipment if terminalAt is newer than the cutoff date', async () => {
    const oldUpdatedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const recentMilestoneDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    const shipmentWithRecentConfirmation = {
      id: 'ship-recent',
      status: 'COMPLETED',
      buyerAddress: 'GBUYER',
      supplierAddress: 'GSUPP',
      logisticsAddress: null,
      arbiterAddress: null,
      referenceNumber: 'REF-REC',
      cancelledAt: null,
      updatedAt: oldUpdatedAt,
      milestones: [
        {
          id: 'm-rec',
          milestoneIndex: 0,
          confirmedAt: recentMilestoneDate,
          disputeEvidence: [],
          proofSubmissions: [],
        },
      ],
      events: [],
      comments: [],
      shipmentNotes: [],
      trackingUpdates: [],
      watchers: [],
    };

    prisma.shipment.findMany.mockResolvedValueOnce([shipmentWithRecentConfirmation]);

    await job.runArchival();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(txMock.archivedShipment.upsert).not.toHaveBeenCalled();
    expect(redis.releaseLock).toHaveBeenCalledWith('chainsettle:shipment-archival:lock', expect.any(String));
  });

  it('safely serializes bigints in shipment payload', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const shipmentWithBigInt = {
      id: 'ship-bigint',
      status: 'COMPLETED',
      buyerAddress: 'GBUYER',
      supplierAddress: 'GSUPP',
      logisticsAddress: null,
      arbiterAddress: null,
      referenceNumber: 'REF-BIG',
      escrowAmount: BigInt('1000000000000000000'),
      cancelledAt: null,
      updatedAt: oldDate,
      milestones: [],
      events: [],
      comments: [],
      shipmentNotes: [],
      trackingUpdates: [],
      watchers: [],
    };

    prisma.shipment.findMany.mockResolvedValueOnce([shipmentWithBigInt]);

    await job.runArchival();

    expect(txMock.archivedShipment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          payload: expect.objectContaining({
            escrowAmount: '1000000000000000000',
          }),
        }),
      }),
    );
  });

  it('handles empty candidates list cleanly', async () => {
    prisma.shipment.findMany.mockResolvedValueOnce([]);

    await job.runArchival();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.releaseLock).toHaveBeenCalledWith('chainsettle:shipment-archival:lock', expect.any(String));
  });

  it('releases lock even if database transaction throws an error', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    prisma.shipment.findMany.mockResolvedValueOnce([
      {
        id: 'ship-err',
        status: 'COMPLETED',
        cancelledAt: oldDate,
        updatedAt: oldDate,
        milestones: [],
      },
    ]);
    prisma.$transaction.mockRejectedValueOnce(new Error('DB deadlock'));

    await expect(job.runArchival()).resolves.not.toThrow();

    expect(redis.releaseLock).toHaveBeenCalledWith('chainsettle:shipment-archival:lock', expect.any(String));
  });
});
