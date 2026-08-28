import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import { I18nService } from '../../i18n/i18n.service';

const ALL_TYPES = Object.values(NotificationType);

function allEnabled() {
  return ALL_TYPES.reduce((acc, t) => ({ ...acc, [t]: { inApp: true, email: true, slack: true } }), {});
}

const mockUser = { id: 'user-1', stellarAddress: 'GABC', email: 'user@example.com' };
const mockNotification = { id: 'notif-1', userId: 'user-1', type: NotificationType.PROOF_SUBMITTED };

function buildPrisma(prefOverride?: object, slackWebhookUrl: string | null = null) {
  return {
    user: { findUnique: jest.fn().mockResolvedValue(mockUser) },
    notification: {
      create: jest.fn().mockResolvedValue(mockNotification),
      update: jest.fn().mockResolvedValue(mockNotification),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    notificationPreference: {
      upsert: jest.fn().mockResolvedValue({
        preferences: prefOverride ?? allEnabled(),
        slackWebhookUrl,
      }),
      update: jest.fn().mockResolvedValue({
        preferences: prefOverride ?? allEnabled(),
        slackWebhookUrl,
      }),
    },
    $transaction: jest.fn().mockResolvedValue([[], 0]),
  };
}

async function buildService(prisma: any) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      NotificationsService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      {
        provide: I18nService,
        useValue: {
          getEmailCopy: jest.fn().mockReturnValue(null),
          t: jest.fn((key: string) => key),
        },
      },
    ],
  }).compile();
  return module.get(NotificationsService);
}

describe('NotificationsService — preferences', () => {
  afterEach(() => jest.clearAllMocks());

  describe('default preferences', () => {
    it('upserts a default preference record on first notifyUser call', async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);

      await service.notifyUser('GABC', NotificationType.PROOF_SUBMITTED, 'title', 'msg');

      expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } }),
      );
    });

    it('all types default to inApp: true, email: true, slack: true', async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);

      const prefs = await service.getOrCreatePreferences('user-1');

      ALL_TYPES.forEach((type) => {
        expect(prefs[type]).toEqual({ inApp: true, email: true, slack: true });
      });
    });
  });

  describe('inApp: false', () => {
    it('skips DB insert when inApp is false for the event type', async () => {
      const prefs = { ...allEnabled(), [NotificationType.PROOF_SUBMITTED]: { inApp: false, email: true } };
      const prisma = buildPrisma(prefs);
      const service = await buildService(prisma);

      const result = await service.notifyUser('GABC', NotificationType.PROOF_SUBMITTED, 'title', 'msg');

      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('still creates notification for a different type that has inApp: true', async () => {
      const prefs = { ...allEnabled(), [NotificationType.PROOF_SUBMITTED]: { inApp: false, email: true } };
      const prisma = buildPrisma(prefs);
      const service = await buildService(prisma);

      await service.notifyUser('GABC', NotificationType.SHIPMENT_CREATED, 'title', 'msg');

      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('email: false', () => {
    it('skips sendEmail when email preference is false', async () => {
      const prefs = { ...allEnabled(), [NotificationType.PROOF_SUBMITTED]: { inApp: true, email: false } };
      const prisma = buildPrisma(prefs);
      const service = await buildService(prisma);

      // Spy on sendEmail to confirm it is not called
      const sendEmailSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue(undefined);

      await service.notifyUser('GABC', NotificationType.PROOF_SUBMITTED, 'title', 'msg');

      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      expect(sendEmailSpy).not.toHaveBeenCalled();
    });

    it('sends email when email preference is true and user has an email', async () => {
      const prisma = buildPrisma(); // all enabled
      const service = await buildService(prisma);
      const sendEmailSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue(undefined);

      await service.notifyUser('GABC', NotificationType.PROOF_SUBMITTED, 'title', 'msg');

      expect(sendEmailSpy).toHaveBeenCalledWith(
        'user@example.com',
        'title',
        'msg',
        undefined,
        NotificationType.PROOF_SUBMITTED,
        undefined,
      );
    });
  });

  describe('updatePreferences', () => {
    it('merges partial update into existing preferences', async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);

      await service.updatePreferences('user-1', {
        preferences: { [NotificationType.PROOF_SUBMITTED]: { inApp: true, email: false } },
      });

      expect(prisma.notificationPreference.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          data: expect.objectContaining({
            preferences: expect.objectContaining({
              [NotificationType.PROOF_SUBMITTED]: { inApp: true, email: false },
            }),
          }),
        }),
      );
    });
  });

  describe('Slack channel', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      jest.clearAllMocks();
    });

    it('posts to Slack when webhook URL is configured and slack is enabled', async () => {
      const prisma = buildPrisma(undefined, 'https://hooks.slack.com/services/T/B/X');
      const service = await buildService(prisma);
      global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => 'ok' }) as any;

      await service.notifyUser('GABC', NotificationType.PROOF_SUBMITTED, 'Proof in', 'msg', {
        shipmentId: 'ship-1',
        milestoneIndex: 0,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://hooks.slack.com/services/T/B/X',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('skips Slack when webhook URL is removed', async () => {
      const prisma = buildPrisma(undefined, null);
      const service = await buildService(prisma);
      global.fetch = jest.fn() as any;

      await service.notifyUser('GABC', NotificationType.PROOF_SUBMITTED, 'Proof in', 'msg');

      expect(global.fetch).not.toHaveBeenCalled();
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    });
  });
});
