import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { RecurringScheduleJob } from './recurring-schedule.job';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { TokenRegistryService } from '../token-registry/token-registry.service';
import { NotificationsService } from '../notifications/notifications.service';
import { runTrackedJob } from '../../common/jobs/run-tracked-job';

jest.mock('../../common/jobs/run-tracked-job', () => ({
  runTrackedJob: jest.fn(),
}));

describe('RecurringScheduleJob', () => {
  let job: RecurringScheduleJob;
  let prisma: {
    recurringSchedule: {
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    shipment: {
      create: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let redis: {
    acquireLock: jest.Mock;
    releaseLock: jest.Mock;
  };
  let tokenRegistry: {
    getToken: jest.Mock;
  };
  let notifications: {
    notifyUser: jest.Mock;
  };

  const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z');

  const buildSchedule = (overrides: Record<string, any> = {}) => ({
    id: 'sched-1',
    userId: 'user-1',
    templateId: 'template-1',
    interval: 'DAILY',
    nextRunAt: new Date('2024-06-15T10:00:00.000Z'),
    active: true,
    template: {
      id: 'template-1',
      deletedAt: null,
      origin: 'Origin A',
      destination: 'Destination B',
      cargoType: 'GENERAL',
      weightKg: 100,
      ...(overrides.template ?? {}),
    },
    ...overrides,
  });

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);

    prisma = {
      recurringSchedule: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      shipment: {
        create: jest.fn().mockResolvedValue({ id: 'shipment-1' }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));

    redis = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };

    tokenRegistry = {
      getToken: jest.fn().mockResolvedValue('token-1'),
    };

    notifications = {
      notifyUser: jest.fn().mockResolvedValue(undefined),
    };

    (runTrackedJob as jest.Mock).mockImplementation(
      async (_name: string, fn: () => Promise<any>) => fn(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecurringScheduleJob,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: TokenRegistryService, useValue: tokenRegistry },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    job = module.get<RecurringScheduleJob>(RecurringScheduleJob);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('lock handling', () => {
    it('skips processing when the lock is not acquired', async () => {
      redis.acquireLock.mockResolvedValue(false);

      await job.handle();

      expect(redis.acquireLock).toHaveBeenCalled();
      expect(prisma.recurringSchedule.findMany).not.toHaveBeenCalled();
      expect(prisma.shipment.create).not.toHaveBeenCalled();
      expect(redis.releaseLock).not.toHaveBeenCalled();
    });

    it('releases the lock after processing', async () => {
      await job.handle();

      expect(redis.acquireLock).toHaveBeenCalled();
      expect(redis.releaseLock).toHaveBeenCalled();
    });
  });

  describe('shipment generation', () => {
    it('creates a shipment from a due schedule template and advances nextRunAt', async () => {
      const schedule = buildSchedule();
      prisma.recurringSchedule.findMany.mockResolvedValue([schedule]);

      await job.handle();

      expect(prisma.shipment.create).toHaveBeenCalledTimes(1);
      const createArgs = prisma.shipment.create.mock.calls[0][0];
      expect(createArgs.data).toMatchObject({
        userId: 'user-1',
        origin: 'Origin A',
        destination: 'Destination B',
        cargoType: 'GENERAL',
        weightKg: 100,
      });

      expect(prisma.recurringSchedule.updateMany).toHaveBeenCalledTimes(1);
      const updateArgs = prisma.recurringSchedule.updateMany.mock.calls[0][0];
      expect(updateArgs.where).toMatchObject({ id: 'sched-1' });
      expect(updateArgs.data.nextRunAt).toBeInstanceOf(Date);
      expect(updateArgs.data.nextRunAt.getTime()).toBeGreaterThan(
        FIXED_NOW.getTime(),
      );

      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'user-1',
        expect.anything(),
      );
    });

    it('advances nextRunAt by one day for DAILY interval', async () => {
      const schedule = buildSchedule({
        interval: 'DAILY',
        nextRunAt: new Date('2024-06-15T10:00:00.000Z'),
      });
      prisma.recurringSchedule.findMany.mockResolvedValue([schedule]);

      await job.handle();

      const updateArgs = prisma.recurringSchedule.updateMany.mock.calls[0][0];
      expect(updateArgs.data.nextRunAt.toISOString()).toBe(
        '2024-06-16T10:00:00.000Z',
      );
    });

    it('advances nextRunAt by one week for WEEKLY interval', async () => {
      const schedule = buildSchedule({
        interval: 'WEEKLY',
        nextRunAt: new Date('2024-06-15T10:00:00.000Z'),
      });
      prisma.recurringSchedule.findMany.mockResolvedValue([schedule]);

      await job.handle();

      const updateArgs = prisma.recurringSchedule.updateMany.mock.calls[0][0];
      expect(updateArgs.data.nextRunAt.toISOString()).toBe(
        '2024-06-22T10:00:00.000Z',
      );
    });

    it('advances nextRunAt by one month for MONTHLY interval', async () => {
      const schedule = buildSchedule({
        interval: 'MONTHLY',
        nextRunAt: new Date('2024-06-15T10:00:00.000Z'),
      });
      prisma.recurringSchedule.findMany.mockResolvedValue([schedule]);

      await job.handle();

      const updateArgs = prisma.recurringSchedule.updateMany.mock.calls[0][0];
      expect(updateArgs.data.nextRunAt.toISOString()).toBe(
        '2024-07-15T10:00:00.000Z',
      );
    });

    it('skips missed intervals when catching up nextRunAt', async () => {
      const schedule = buildSchedule({
        interval: 'DAILY',
        nextRunAt: new Date('2024-06-01T10:00:00.000Z'),
      });
      prisma.recurringSchedule.findMany.mockResolvedValue([schedule]);

      await job.handle();

      const updateArgs = prisma.recurringSchedule.updateMany.mock.calls[0][0];
      expect(updateArgs.data.nextRunAt.getTime()).toBeGreaterThan(
        FIXED_NOW.getTime(),
      );
      expect(updateArgs.data.nextRunAt.toISOString()).toBe(
        '2024-06-16T10:00:00.000Z',
      );
    });
  });

  describe('template handling', () => {
    it('deactivates schedules whose template is soft-deleted', async () => {
      const schedule = buildSchedule({
        template: { id: 'template-1', deletedAt: new Date('2024-06-10') },
      });
      prisma.recurringSchedule.findMany.mockResolvedValue([schedule]);

      await job.handle();

      expect(prisma.shipment.create).not.toHaveBeenCalled();
      expect(prisma.recurringSchedule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sched-1' },
          data: expect.objectContaining({ active: false }),
        }),
      );
    });
  });

  describe('compare-and-set', () => {
    it('returns false when the compare-and-set updateMany count is 0', async () => {
      const schedule = buildSchedule();
      prisma.recurringSchedule.findMany.mockResolvedValue([schedule]);
      prisma.recurringSchedule.updateMany.mockResolvedValue({ count: 0 });

      const result = await job.handle();

      expect(prisma.recurringSchedule.updateMany).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });
  });

  describe('error handling', () => {
    it('logs the error and continues processing other schedules when shipment creation throws', async () => {
      const loggerSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const failingSchedule = buildSchedule({ id: 'sched-fail' });
      const okSchedule = buildSchedule({ id: 'sched-ok', userId: 'user-2' });
      prisma.recurringSchedule.findMany.mockResolvedValue([
        failingSchedule,
        okSchedule,
      ]);
      prisma.shipment.create
        .mockRejectedValueOnce(new Error('template creation failed'))
        .mockResolvedValueOnce({ id: 'shipment-2' });

      const result = await job.handle();

      expect(prisma.shipment.create).toHaveBeenCalledTimes(2);
      expect(loggerSpy).toHaveBeenCalled();
      expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'user-2',
        expect.anything(),
      );
      expect(result).toBe(1);

      loggerSpy.mockRestore();
    });

    it('does not increment created count when shipment creation fails', async () => {
      const loggerSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const schedule = buildSchedule();
      prisma.recurringSchedule.findMany.mockResolvedValue([schedule]);
      prisma.shipment.create.mockRejectedValue(new Error('boom'));

      const result = await job.handle();

      expect(result).toBe(0);
      expect(notifications.notifyUser).not.toHaveBeenCalled();

      loggerSpy.mockRestore();
    });
  });
});