import { KycStatus, NotificationType } from '@prisma/client';

// Stub heavy provider modules — the job receives hand-rolled mocks below.
jest.mock('../notifications/notifications.service', () => ({ NotificationsService: class {} }));
jest.mock('../audit-logs/audit-log.service', () => ({ AuditLogService: class {} }));

import { KycExpiryJob } from './kyc-expiry.job';
import { KycService } from './kyc.service';

const DAY = 24 * 60 * 60 * 1000;

/** Minimal in-memory user table honouring the filters the job uses. */
function makePrisma(users: any[]) {
  const matches = (u: any, where: any) =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const t = u[k]?.getTime?.();
        if (t === undefined) return false;
        if (v.gt && !(t > v.gt.getTime())) return false;
        if (v.lte && !(t <= v.lte.getTime())) return false;
        return true;
      }
      return u[k] === v;
    });
  return {
    user: {
      findMany: jest.fn(async ({ where }) => users.filter((u) => matches(u, where))),
      update: jest.fn(async ({ where, data }) => Object.assign(users.find((u) => u.id === where.id), data)),
    },
  };
}

describe('KycExpiryJob (#429)', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  let users: any[];
  let job: KycExpiryJob;
  let notifications: { notifyUser: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(start);
    users = [
      {
        id: 'u1',
        stellarAddress: 'GUSER1',
        kycStatus: KycStatus.VERIFIED,
        kycExpiresAt: new Date(start.getTime() + 40 * DAY),
        kycReminder30dSentAt: null,
        kycReminder7dSentAt: null,
      },
    ];
    notifications = { notifyUser: jest.fn() };
    job = new KycExpiryJob(makePrisma(users) as any, notifications as any, { record: jest.fn() } as any);
  });

  afterEach(() => jest.useRealTimers());

  const advanceDays = (d: number) => jest.setSystemTime(new Date(Date.now() + d * DAY));

  it('sends each reminder exactly once and expires the user', async () => {
    await job.run(); // 40 days left — nothing
    expect(notifications.notifyUser).not.toHaveBeenCalled();

    advanceDays(11); // 29 days left
    await job.run();
    await job.run(); // same day again — no duplicate
    expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
    expect(notifications.notifyUser.mock.calls[0][1]).toBe(NotificationType.KYC_EXPIRING);
    expect(notifications.notifyUser.mock.calls[0][4].threshold).toBe(30);

    advanceDays(23); // 6 days left
    await job.run();
    await job.run();
    expect(notifications.notifyUser).toHaveBeenCalledTimes(2);
    expect(notifications.notifyUser.mock.calls[1][4].threshold).toBe(7);

    expect(KycService.isActiveVerification(users[0])).toBe(true);
    advanceDays(7); // expired
    expect(KycService.isActiveVerification(users[0])).toBe(false);
    await job.run();
    expect(users[0].kycStatus).toBe(KycStatus.UNVERIFIED);
    expect(notifications.notifyUser.mock.calls[2][1]).toBe(NotificationType.KYC_EXPIRED);
  });
});

describe('KycService expiry (#429)', () => {
  const make = (days?: number, user?: any) => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        findFirst: jest.fn().mockResolvedValue({ id: 'u1' }),
        update: jest.fn(),
      },
    };
    const config = { get: jest.fn((k: string, d: any) => (k === 'KYC_VALIDITY_DAYS' && days ? days : d)) };
    return { svc: new KycService(prisma as any, config as any, { record: jest.fn() } as any), prisma };
  };

  afterEach(() => jest.useRealTimers());

  it('sets kycExpiresAt using the configurable validity period', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { svc, prisma } = make(90);
    await svc.handleWebhook({ reference: 'r', stellarAddress: 'G', status: 'VERIFIED' } as any);
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.kycExpiresAt).toEqual(new Date('2026-04-01T00:00:00Z'));
    expect(data.kycVerifiedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('treats expired verification as unverified for high-value checks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { svc } = make(undefined, { kycStatus: KycStatus.VERIFIED, kycExpiresAt: new Date('2025-12-31T00:00:00Z') });
    await expect(svc.isVerified('G')).resolves.toBe(false);
  });

  it('reports expiry in getStatus', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const expiresAt = new Date('2026-06-01T00:00:00Z');
    const { svc } = make(undefined, { kycStatus: KycStatus.VERIFIED, kycReference: 'r', kycVerifiedAt: null, kycExpiresAt: expiresAt });
    await expect(svc.getStatus('u1')).resolves.toMatchObject({ kycExpiresAt: expiresAt, expired: false, kycStatus: KycStatus.VERIFIED });
  });
});
