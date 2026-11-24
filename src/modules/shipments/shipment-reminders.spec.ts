import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ShipmentRemindersService, MAX_ACTIVE_REMINDERS } from './shipment-reminders.service';
import { ShipmentReminderJob } from './shipment-reminder.job';

const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe('ShipmentRemindersService (#386)', () => {
  let prisma: any;
  let service: ShipmentRemindersService;

  beforeEach(() => {
    prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue({ id: 's1' }) },
      shipmentReminder: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(async ({ data }: any) => ({ id: 'r1', ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new ShipmentRemindersService(prisma);
  });

  it('creates a reminder for the caller', async () => {
    const r = await service.create('s1', 'u1', { remindAt: future(), message: ' check customs ' });
    expect(r).toMatchObject({ shipmentId: 's1', userId: 'u1', message: 'check customs' });
  });

  it('rejects a remindAt in the past', async () => {
    await expect(
      service.create('s1', 'u1', { remindAt: new Date(Date.now() - 1000).toISOString(), message: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it(`enforces at most ${MAX_ACTIVE_REMINDERS} active reminders per user per shipment`, async () => {
    prisma.shipmentReminder.count.mockResolvedValue(MAX_ACTIVE_REMINDERS);
    await expect(service.create('s1', 'u1', { remindAt: future(), message: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.shipmentReminder.count).toHaveBeenCalledWith({
      where: { shipmentId: 's1', userId: 'u1', sentAt: null },
    });
  });

  it('lists and deletes only the caller\'s reminders', async () => {
    await service.list('s1', 'u1');
    expect(prisma.shipmentReminder.findMany.mock.calls[0][0].where).toEqual({ shipmentId: 's1', userId: 'u1' });

    prisma.shipmentReminder.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.remove('s1', 'r-other', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.shipmentReminder.deleteMany).toHaveBeenCalledWith({
      where: { id: 'r-other', shipmentId: 's1', userId: 'u1' },
    });
  });
});

describe('ShipmentReminderJob (#386)', () => {
  let prisma: any;
  let redis: any;
  let notifications: any;
  let job: ShipmentReminderJob;
  let store: Map<string, any>;

  beforeEach(() => {
    store = new Map([
      ['r1', { id: 'r1', shipmentId: 's1', message: 'm1', sentAt: null, user: { stellarAddress: 'GU1' } }],
      ['r2', { id: 'r2', shipmentId: 's1', message: 'm2', sentAt: null, user: { stellarAddress: 'GU2' } }],
    ]);
    prisma = {
      shipmentReminder: {
        findMany: jest.fn(async () => [...store.values()].filter((r) => !r.sentAt)),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const r = store.get(where.id);
          if (!r || r.sentAt) return { count: 0 };
          r.sentAt = data.sentAt;
          return { count: 1 };
        }),
      },
    };
    redis = { acquireLock: jest.fn().mockResolvedValue(true), releaseLock: jest.fn() };
    notifications = { notifyUser: jest.fn() };
    job = new ShipmentReminderJob(prisma, redis, notifications);
  });

  it('delivers each due reminder exactly once', async () => {
    await expect(job.run()).resolves.toBe(2);
    await expect(job.run()).resolves.toBe(0);
    expect(notifications.notifyUser).toHaveBeenCalledTimes(2);
    expect(redis.releaseLock).toHaveBeenCalledTimes(2);
  });

  it('skips a reminder deleted after it was read', async () => {
    const due = [...store.values()];
    prisma.shipmentReminder.findMany.mockResolvedValueOnce(due);
    store.delete('r2');
    await expect(job.run()).resolves.toBe(1);
    expect(notifications.notifyUser).toHaveBeenCalledWith('GU1', expect.anything(), 'Shipment reminder', 'm1', expect.anything());
  });

  it('does nothing when another instance holds the lock', async () => {
    redis.acquireLock.mockResolvedValue(false);
    await expect(job.run()).resolves.toBe(0);
    expect(prisma.shipmentReminder.findMany).not.toHaveBeenCalled();
  });
});
