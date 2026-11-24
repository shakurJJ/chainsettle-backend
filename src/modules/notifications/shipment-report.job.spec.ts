import { Test, TestingModule } from '@nestjs/testing';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationsService } from './notifications.service';
import { ShipmentReportService } from './shipment-report.service';
import { ShipmentReportJob } from './shipment-report.job';

const MONDAY = new Date('2026-11-23T09:00:00.000Z'); // 1st is not reached
const TUESDAY = new Date('2026-11-24T09:00:00.000Z');
const FIRST_OF_MONTH = new Date('2026-12-01T09:00:00.000Z');

function allEmailEnabled() {
  return Object.values(NotificationType).reduce(
    (acc, type) => ({ ...acc, [type]: { email: true } }),
    {},
  );
}

describe('ShipmentReportJob', () => {
  let job: ShipmentReportJob;
  let prisma: any;
  let notifications: any;
  let reports: any;

  beforeEach(async () => {
    prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    notifications = {
      getReportFrequency: jest.fn(),
      isQuietHours: jest.fn().mockResolvedValue(false),
      getOrCreatePreferences: jest.fn().mockResolvedValue(allEmailEnabled()),
      sendEmail: jest.fn().mockResolvedValue(true),
    };
    reports = {
      buildForUser: jest.fn().mockResolvedValue({
        subject: 'Your weekly shipment report',
        html: '<p>report</p>',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShipmentReportJob,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RedisService,
          useValue: { setJson: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NotificationsService, useValue: notifications },
        { provide: ShipmentReportService, useValue: reports },
      ],
    }).compile();

    job = module.get(ShipmentReportJob);
  });

  afterEach(() => jest.clearAllMocks());

  const user = { id: 'user-1', email: 'user@example.com', locale: 'en' };

  it('does nothing on days that are neither Monday nor the 1st', async () => {
    prisma.user.findMany.mockResolvedValue([user]);

    const result = await job.executeScheduledReports(TUESDAY);

    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(notifications.sendEmail).not.toHaveBeenCalled();
  });

  it('queries only opted-in, verified, active users', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await job.executeScheduledReports(MONDAY);

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: { not: null },
          emailVerified: true,
          deactivatedAt: null,
          notificationPreference: {
            is: {
              OR: [
                {
                  preferences: {
                    path: ['_meta', 'reportFrequency'],
                    equals: 'weekly',
                  },
                },
                {
                  preferences: {
                    path: ['_meta', 'reportFrequency'],
                    equals: 'monthly',
                  },
                },
              ],
            },
          },
        }),
      }),
    );
  });

  it('sends the weekly report on Monday', async () => {
    prisma.user.findMany.mockResolvedValue([user]);
    notifications.getReportFrequency.mockResolvedValue('weekly');

    const result = await job.executeScheduledReports(MONDAY);

    expect(reports.buildForUser).toHaveBeenCalledWith(
      'user-1',
      'weekly',
      MONDAY,
    );
    expect(notifications.sendEmail).toHaveBeenCalledWith(
      'user@example.com',
      'Your weekly shipment report',
      '',
      '<p>report</p>',
      undefined,
      undefined,
      'en',
      'user-1',
    );
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  it('skips a weekly subscriber when Monday does not apply', async () => {
    prisma.user.findMany.mockResolvedValue([user]);
    notifications.getReportFrequency.mockResolvedValue('weekly');

    const result = await job.executeScheduledReports(FIRST_OF_MONTH);

    expect(reports.buildForUser).not.toHaveBeenCalled();
    expect(notifications.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  it('sends the monthly report on the 1st', async () => {
    prisma.user.findMany.mockResolvedValue([user]);
    notifications.getReportFrequency.mockResolvedValue('monthly');

    const result = await job.executeScheduledReports(FIRST_OF_MONTH);

    expect(reports.buildForUser).toHaveBeenCalledWith(
      'user-1',
      'monthly',
      FIRST_OF_MONTH,
    );
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  it('runs both cadences when Monday falls on the 1st', async () => {
    const weeklyUser = {
      id: 'weekly',
      email: 'weekly@example.com',
      locale: 'en',
    };
    const monthlyUser = {
      id: 'monthly',
      email: 'monthly@example.com',
      locale: 'en',
    };
    prisma.user.findMany.mockResolvedValue([weeklyUser, monthlyUser]);
    notifications.getReportFrequency.mockImplementation((id: string) =>
      Promise.resolve(id === 'weekly' ? 'weekly' : 'monthly'),
    );
    const mondayFirst = new Date('2026-06-01T09:00:00.000Z');

    const result = await job.executeScheduledReports(mondayFirst);

    expect(reports.buildForUser).toHaveBeenCalledWith(
      'weekly',
      'weekly',
      mondayFirst,
    );
    expect(reports.buildForUser).toHaveBeenCalledWith(
      'monthly',
      'monthly',
      mondayFirst,
    );
    expect(result).toEqual({ sent: 2, skipped: 0 });
  });

  it('skips a monthly subscriber on a non-1st day', async () => {
    prisma.user.findMany.mockResolvedValue([user]);
    notifications.getReportFrequency.mockResolvedValue('monthly');

    const result = await job.executeScheduledReports(MONDAY);

    expect(notifications.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  it('skips users who opted out', async () => {
    prisma.user.findMany.mockResolvedValue([user]);
    notifications.getReportFrequency.mockResolvedValue('off');

    const result = await job.executeScheduledReports(MONDAY);

    expect(notifications.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  it('skips users during quiet hours', async () => {
    prisma.user.findMany.mockResolvedValue([user]);
    notifications.getReportFrequency.mockResolvedValue('weekly');
    notifications.isQuietHours.mockResolvedValue(true);

    const result = await job.executeScheduledReports(MONDAY);

    expect(reports.buildForUser).not.toHaveBeenCalled();
    expect(notifications.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  it('skips users who unsubscribed from all email notifications', async () => {
    prisma.user.findMany.mockResolvedValue([user]);
    notifications.getReportFrequency.mockResolvedValue('weekly');
    const allDisabled = Object.values(NotificationType).reduce(
      (acc, type) => ({ ...acc, [type]: { email: false } }),
      {},
    );
    notifications.getOrCreatePreferences.mockResolvedValue(allDisabled);

    const result = await job.executeScheduledReports(MONDAY);

    expect(reports.buildForUser).not.toHaveBeenCalled();
    expect(notifications.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  it('does not count an address suppressed by the email service as sent', async () => {
    prisma.user.findMany.mockResolvedValue([user]);
    notifications.getReportFrequency.mockResolvedValue('weekly');
    notifications.sendEmail.mockResolvedValue(false); // suppressed

    const result = await job.executeScheduledReports(MONDAY);

    expect(notifications.sendEmail).toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  it('skips users with no reportable shipments', async () => {
    prisma.user.findMany.mockResolvedValue([user]);
    notifications.getReportFrequency.mockResolvedValue('weekly');
    reports.buildForUser.mockResolvedValue(null);

    const result = await job.executeScheduledReports(MONDAY);

    expect(notifications.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  it('continues with other users when one report fails', async () => {
    const second = { id: 'user-2', email: 'second@example.com', locale: null };
    prisma.user.findMany.mockResolvedValue([user, second]);
    notifications.getReportFrequency.mockResolvedValue('weekly');
    reports.buildForUser
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ subject: 'Report', html: '<p>ok</p>' });

    const errorSpy = jest.spyOn((job as any).logger, 'error');
    const result = await job.executeScheduledReports(MONDAY);

    expect(result).toEqual({ sent: 1, skipped: 1 });
    expect(notifications.sendEmail).toHaveBeenCalledWith(
      'second@example.com',
      'Report',
      '',
      '<p>ok</p>',
      undefined,
      undefined,
      undefined,
      'user-2',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'Shipment report failed for user user-1',
      'db down',
    );
  });
});
