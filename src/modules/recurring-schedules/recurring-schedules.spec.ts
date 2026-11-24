import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RecurringInterval } from '@prisma/client';
import { RecurringSchedulesService, advance } from './recurring-schedules.service';
import { RecurringScheduleJob } from './recurring-schedule.job';

const template = {
  id: 't1',
  ownerId: 'u1',
  name: 'Weekly beans',
  description: 'Coffee',
  isPublic: false,
  deletedAt: null,
  supplierAddress: 'GSUP',
  logisticsAddress: 'GLOG',
  arbiterAddress: 'GARB',
  tokenAddress: 'CTOKEN',
};

describe('advance()', () => {
  it('adds 7 days for WEEKLY', () => {
    expect(advance(new Date('2026-01-01T00:00:00Z'), RecurringInterval.WEEKLY).toISOString()).toBe(
      '2026-01-08T00:00:00.000Z',
    );
  });
  it('clamps MONTHLY to the last day of a shorter month', () => {
    expect(advance(new Date('2026-01-31T10:00:00Z'), RecurringInterval.MONTHLY).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
  });
});

describe('RecurringSchedulesService (#389)', () => {
  let prisma: any;
  let service: RecurringSchedulesService;

  beforeEach(() => {
    prisma = {
      shipmentTemplate: { findFirst: jest.fn().mockResolvedValue(template) },
      recurringSchedule: {
        create: jest.fn(async ({ data }: any) => ({ id: 'rs1', ...data })),
        findUnique: jest.fn().mockResolvedValue({ id: 'rs1', ownerId: 'u1' }),
        update: jest.fn(async ({ data }: any) => ({ id: 'rs1', totalAmount: 1n, ...data })),
        delete: jest.fn(),
      },
    };
    service = new RecurringSchedulesService(prisma);
  });

  it('creates a schedule from an owned template', async () => {
    const s = await service.create('u1', { templateId: 't1', interval: RecurringInterval.WEEKLY, totalAmount: '500' });
    expect(s).toMatchObject({ ownerId: 'u1', templateId: 't1', totalAmount: '500' });
    expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a template that is neither owned nor public', async () => {
    prisma.shipmentTemplate.findFirst.mockResolvedValue({ ...template, ownerId: 'other' });
    await expect(
      service.create('u1', { templateId: 't1', interval: RecurringInterval.WEEKLY, totalAmount: '500' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a template missing participant addresses', async () => {
    prisma.shipmentTemplate.findFirst.mockResolvedValue({ ...template, arbiterAddress: null });
    await expect(
      service.create('u1', { templateId: 't1', interval: RecurringInterval.WEEKLY, totalAmount: '500' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pauses a schedule with active=false', async () => {
    await service.update('rs1', 'u1', { active: false });
    expect(prisma.recurringSchedule.update).toHaveBeenCalledWith({ where: { id: 'rs1' }, data: { active: false } });
  });

  it("hides other users' schedules", async () => {
    await expect(service.update('rs1', 'u2', { active: false })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove('rs1', 'u2')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RecurringScheduleJob (#389)', () => {
  let schedule: any;
  let prisma: any;
  let redis: any;
  let notifications: any;
  let job: RecurringScheduleJob;
  const shipments: any[] = [];

  beforeEach(() => {
    shipments.length = 0;
    schedule = {
      id: 'rs1',
      active: true,
      interval: RecurringInterval.WEEKLY,
      totalAmount: 500n,
      nextRunAt: new Date(Date.now() - 60_000),
      template,
      owner: { stellarAddress: 'GBUYER' },
    };
    const tx = {
      recurringSchedule: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (!schedule.active || where.nextRunAt.getTime() !== schedule.nextRunAt.getTime()) return { count: 0 };
          Object.assign(schedule, data);
          return { count: 1 };
        }),
      },
      shipment: { create: jest.fn(async ({ data }: any) => shipments.push(data)) },
    };
    prisma = {
      recurringSchedule: {
        findMany: jest.fn(async () => (schedule.active && schedule.nextRunAt <= new Date() ? [{ ...schedule }] : [])),
        update: jest.fn(),
      },
      $transaction: jest.fn((fn: any) => fn(tx)),
    };
    redis = { acquireLock: jest.fn().mockResolvedValue(true), releaseLock: jest.fn() };
    notifications = { notifyUser: jest.fn() };
    job = new RecurringScheduleJob(prisma, redis, { getToken: () => ({ decimals: 7, symbol: 'USDC' }) } as any, notifications);
  });

  it('creates exactly one draft per due run and notifies the owner with a link', async () => {
    await expect(job.run()).resolves.toBe(1);
    expect(shipments).toHaveLength(1);
    expect(shipments[0]).toMatchObject({ isDraft: true, buyerAddress: 'GBUYER', supplierAddress: 'GSUP', totalAmount: 500n });
    expect(schedule.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(notifications.notifyUser).toHaveBeenCalledWith(
      'GBUYER',
      expect.anything(),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ link: expect.stringMatching(/^\/shipments\//) }),
    );
    await expect(job.run()).resolves.toBe(0);
    expect(shipments).toHaveLength(1);
  });

  it('creates only one draft when two instances read the same due schedule', async () => {
    const stale = { ...schedule };
    prisma.recurringSchedule.findMany.mockResolvedValueOnce([stale]).mockResolvedValueOnce([stale]);
    const [a, b] = await Promise.all([job.run(), job.run()]);
    expect(a + b).toBe(1);
    expect(shipments).toHaveLength(1);
  });

  it('does not generate for paused schedules', async () => {
    schedule.active = false;
    await expect(job.run()).resolves.toBe(0);
    expect(shipments).toHaveLength(0);
  });

  it('skips when another instance holds the lock', async () => {
    redis.acquireLock.mockResolvedValue(false);
    await expect(job.run()).resolves.toBe(0);
    expect(prisma.recurringSchedule.findMany).not.toHaveBeenCalled();
  });
});
