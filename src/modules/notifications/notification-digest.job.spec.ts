import { Test, TestingModule } from '@nestjs/testing';
import { NotificationDigestJob } from './notification-digest.job';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationsService } from './notifications.service';
import { NotificationType } from '@prisma/client';

describe('NotificationDigestJob', () => {
  let job: NotificationDigestJob;
  let prisma: any;
  let notificationsService: any;
  let redisService: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn(),
      },
    };

    notificationsService = {
      getDigestFrequency: jest.fn(),
      isQuietHours: jest.fn(),
      getOrCreatePreferences: jest.fn(),
      buildDigest: jest.fn(),
      sendEmail: jest.fn(),
    };

    redisService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDigestJob,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redisService },
        { provide: NotificationsService, useValue: notificationsService },
      ],
    }).compile();

    job = module.get<NotificationDigestJob>(NotificationDigestJob);
    jest.clearAllMocks();
  });

  describe('executeDailyDigests', () => {
    it('sends digests to users with unread notifications', async () => {
      // Arrange
      const mockUsers = [
        { id: 'user-1', email: 'user1@example.com' },
        { id: 'user-2', email: 'user2@example.com' },
      ];

      prisma.user.findMany.mockResolvedValue(mockUsers);
      notificationsService.getDigestFrequency.mockResolvedValue('daily');
      notificationsService.isQuietHours.mockResolvedValue(false);
      notificationsService.getOrCreatePreferences.mockResolvedValue({
        [NotificationType.MILESTONE_CONFIRMED]: { email: true },
      });
      notificationsService.buildDigest.mockResolvedValue({
        subject: 'Daily digest — 3 unread',
        html: '<p>You have 3 unread notifications</p>',
      });
      notificationsService.sendEmail.mockResolvedValue(true);

      // Act
      await (job as any).executeDailyDigests();

      // Assert
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          email: { not: null },
          emailVerified: true,
          notifications: { some: { read: false } },
        },
        select: { id: true, email: true },
      });

      expect(notificationsService.getDigestFrequency).toHaveBeenCalledTimes(2);
      expect(notificationsService.sendEmail).toHaveBeenCalledTimes(2);
      expect(notificationsService.sendEmail).toHaveBeenCalledWith(
        'user1@example.com',
        'Daily digest — 3 unread',
        '',
        '<p>You have 3 unread notifications</p>',
        undefined,
        undefined,
        undefined,
        'user-1',
      );
    });

    it('skips users with instant digest frequency', async () => {
      // Arrange
      const mockUsers = [{ id: 'user-1', email: 'user1@example.com' }];

      prisma.user.findMany.mockResolvedValue(mockUsers);
      notificationsService.getDigestFrequency.mockResolvedValue('instant');

      // Act
      await (job as any).executeDailyDigests();

      // Assert
      expect(notificationsService.sendEmail).not.toHaveBeenCalled();
      expect(notificationsService.getOrCreatePreferences).not.toHaveBeenCalled();
    });

    it('skips users during quiet hours', async () => {
      // Arrange
      const mockUsers = [{ id: 'user-1', email: 'user1@example.com' }];

      prisma.user.findMany.mockResolvedValue(mockUsers);
      notificationsService.getDigestFrequency.mockResolvedValue('daily');
      notificationsService.isQuietHours.mockResolvedValue(true);

      // Act
      await (job as any).executeDailyDigests();

      // Assert
      expect(notificationsService.sendEmail).not.toHaveBeenCalled();
    });

    it('skips users with weekly digest on non-Monday', async () => {
      // Arrange
      const mockUsers = [{ id: 'user-1', email: 'user1@example.com' }];

      prisma.user.findMany.mockResolvedValue(mockUsers);
      notificationsService.getDigestFrequency.mockResolvedValue('weekly');
      notificationsService.isQuietHours.mockResolvedValue(false);

      // Spy on Date to simulate a Tuesday (getDay() !== 1)
      const originalDate = Date;
      jest.spyOn(global, 'Date').mockImplementation(() => new originalDate('2026-10-20T12:00:00.000Z') as any);

      // Act
      await (job as any).executeDailyDigests();

      // Assert
      expect(notificationsService.sendEmail).not.toHaveBeenCalled();

      // Cleanup
      jest.spyOn(global, 'Date').mockRestore();
    });

    it('sends weekly digests on Monday', async () => {
      // Arrange
      const mockUsers = [{ id: 'user-1', email: 'user1@example.com' }];

      prisma.user.findMany.mockResolvedValue(mockUsers);
      notificationsService.getDigestFrequency.mockResolvedValue('weekly');
      notificationsService.isQuietHours.mockResolvedValue(false);
      notificationsService.getOrCreatePreferences.mockResolvedValue({
        [NotificationType.MILESTONE_CONFIRMED]: { email: true },
      });
      notificationsService.buildDigest.mockResolvedValue({
        subject: 'Weekly digest — 5 unread',
        html: '<p>You have 5 unread notifications</p>',
      });
      notificationsService.sendEmail.mockResolvedValue(true);

      // Spy on Date to simulate a Monday (getDay() === 1)
      const originalDate = Date;
      jest.spyOn(global, 'Date').mockImplementation(() => new originalDate('2026-10-19T12:00:00.000Z') as any);

      // Act
      await (job as any).executeDailyDigests();

      // Assert
      expect(notificationsService.sendEmail).toHaveBeenCalledWith(
        'user1@example.com',
        'Weekly digest — 5 unread',
        '',
        '<p>You have 5 unread notifications</p>',
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      // Cleanup
      jest.spyOn(global, 'Date').mockRestore();
    });

    it('skips users with all email notifications disabled', async () => {
      // Arrange
      const mockUsers = [{ id: 'user-1', email: 'user1@example.com' }];

      prisma.user.findMany.mockResolvedValue(mockUsers);
      notificationsService.getDigestFrequency.mockResolvedValue('daily');
      notificationsService.isQuietHours.mockResolvedValue(false);

      // All email disabled
      const allEmailDisabled = Object.values(NotificationType).reduce(
        (acc, type) => ({ ...acc, [type]: { email: false } }),
        {},
      );
      notificationsService.getOrCreatePreferences.mockResolvedValue(allEmailDisabled);

      // Act
      await (job as any).executeDailyDigests();

      // Assert
      expect(notificationsService.sendEmail).not.toHaveBeenCalled();
      expect(notificationsService.buildDigest).not.toHaveBeenCalled();
    });

    it('skips users with no digest content', async () => {
      // Arrange
      const mockUsers = [{ id: 'user-1', email: 'user1@example.com' }];

      prisma.user.findMany.mockResolvedValue(mockUsers);
      notificationsService.getDigestFrequency.mockResolvedValue('daily');
      notificationsService.isQuietHours.mockResolvedValue(false);
      notificationsService.getOrCreatePreferences.mockResolvedValue({
        [NotificationType.MILESTONE_CONFIRMED]: { email: true },
      });
      notificationsService.buildDigest.mockResolvedValue(null); // No unread notifications

      // Act
      await (job as any).executeDailyDigests();

      // Assert
      expect(notificationsService.sendEmail).not.toHaveBeenCalled();
    });

    it('continues processing other users when email fails for one user', async () => {
      // Arrange
      const mockUsers = [
        { id: 'user-1', email: 'user1@example.com' },
        { id: 'user-2', email: 'user2@example.com' },
      ];

      prisma.user.findMany.mockResolvedValue(mockUsers);
      notificationsService.getDigestFrequency.mockResolvedValue('daily');
      notificationsService.isQuietHours.mockResolvedValue(false);
      notificationsService.getOrCreatePreferences.mockResolvedValue({
        [NotificationType.MILESTONE_CONFIRMED]: { email: true },
      });
      notificationsService.buildDigest.mockResolvedValue({
        subject: 'Daily digest',
        html: '<p>Test</p>',
      });
      notificationsService.sendEmail
        .mockRejectedValueOnce(new Error('SMTP error'))
        .mockResolvedValueOnce(true);

      const loggerSpy = jest.spyOn((job as any).logger, 'error');

      // Act
      await (job as any).executeDailyDigests();

      // Assert - should still send to second user despite first failing
      expect(notificationsService.sendEmail).toHaveBeenCalledTimes(2);
      expect(loggerSpy).toHaveBeenCalledWith(
        'Digest failed for user user-1',
        'SMTP error',
      );
    });
  });
});