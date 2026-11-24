import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebPushService } from './web-push.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationType } from '@prisma/client';

// ── mock web-push before any imports resolve it ──────────────────────────────
const mockSendNotification = jest.fn();
const mockSetVapidDetails = jest.fn();

jest.mock('web-push', () => ({
  setVapidDetails: (...args: unknown[]) => mockSetVapidDetails(...args),
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}));

// ── helpers ──────────────────────────────────────────────────────────────────
const VAPID_PUBLIC = 'BPublicKey';
const VAPID_PRIVATE = 'BPrivateKey';
const VAPID_SUBJECT = 'mailto:test@example.com';

const makeSub = (overrides = {}) => ({
  id: 'sub-1',
  endpoint: 'https://push.example.com/sub/1',
  p256dh: 'p256dh-value',
  auth: 'auth-value',
  ...overrides,
});

describe('WebPushService', () => {
  let service: WebPushService;
  let prisma: jest.Mocked<Pick<PrismaService, 'webPushSubscription'>>;
  let configGet: jest.Mock;

  beforeEach(async () => {
    mockSetVapidDetails.mockReset();
    mockSendNotification.mockReset();

    prisma = {
      webPushSubscription: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn(),
      } as any,
    };

    configGet = jest.fn((key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        VAPID_PUBLIC_KEY: VAPID_PUBLIC,
        VAPID_PRIVATE_KEY: VAPID_PRIVATE,
        VAPID_SUBJECT: VAPID_SUBJECT,
      };
      return map[key] ?? fallback;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebPushService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get<WebPushService>(WebPushService);
    service.onModuleInit(); // trigger VAPID setup
  });

  // ── initialisation ──────────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('sets VAPID details and enables the service when both keys are present', () => {
      expect(mockSetVapidDetails).toHaveBeenCalledWith(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
      expect(service.getPublicKey()).toBe(VAPID_PUBLIC);
    });

    it('stays disabled and skips setVapidDetails when keys are missing', async () => {
      configGet.mockReturnValue(undefined);
      const module = await Test.createTestingModule({
        providers: [
          WebPushService,
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: { get: configGet } },
        ],
      }).compile();
      const disabledService = module.get<WebPushService>(WebPushService);
      mockSetVapidDetails.mockClear();
      disabledService.onModuleInit();

      expect(mockSetVapidDetails).not.toHaveBeenCalled();
      expect(disabledService.getPublicKey()).toBeNull();
    });
  });

  // ── getPublicKey ────────────────────────────────────────────────────────

  describe('getPublicKey', () => {
    it('returns the public key when enabled', () => {
      expect(service.getPublicKey()).toBe(VAPID_PUBLIC);
    });
  });

  // ── subscribe ───────────────────────────────────────────────────────────

  describe('subscribe', () => {
    it('upserts a subscription record', async () => {
      const dto = { endpoint: 'https://push.example.com/1', p256dh: 'pk', auth: 'auth' };
      (prisma.webPushSubscription.upsert as jest.Mock).mockResolvedValue({ id: 'sub-1', ...dto });

      await service.subscribe('user-1', dto);

      expect(prisma.webPushSubscription.upsert).toHaveBeenCalledWith({
        where: { endpoint: dto.endpoint },
        create: { userId: 'user-1', ...dto },
        update: { userId: 'user-1', p256dh: dto.p256dh, auth: dto.auth },
      });
    });
  });

  // ── unsubscribe ─────────────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('deletes the subscription by userId + endpoint', async () => {
      (prisma.webPushSubscription.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.unsubscribe('user-1', 'https://push.example.com/1');

      expect(prisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', endpoint: 'https://push.example.com/1' },
      });
    });
  });

  // ── sendToUser ──────────────────────────────────────────────────────────

  describe('sendToUser', () => {
    const userId = 'user-1';
    const type = NotificationType.SHIPMENT_CREATED;

    it('sends to all subscriptions for the user', async () => {
      const sub = makeSub();
      (prisma.webPushSubscription.findMany as jest.Mock).mockResolvedValue([sub]);
      mockSendNotification.mockResolvedValue({});

      await service.sendToUser(userId, type, 'Title', 'Body');

      expect(mockSendNotification).toHaveBeenCalledTimes(1);
      expect(mockSendNotification).toHaveBeenCalledWith(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        expect.stringContaining('"type":"SHIPMENT_CREATED"'),
        expect.objectContaining({ TTL: 86400 }),
      );
    });

    it('does nothing when the user has no subscriptions', async () => {
      (prisma.webPushSubscription.findMany as jest.Mock).mockResolvedValue([]);

      await service.sendToUser(userId, type, 'Title', 'Body');

      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it('removes stale subscriptions on 404', async () => {
      const sub = makeSub();
      (prisma.webPushSubscription.findMany as jest.Mock).mockResolvedValue([sub]);
      mockSendNotification.mockRejectedValue({ statusCode: 404 });
      (prisma.webPushSubscription.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.sendToUser(userId, type, 'Title', 'Body');

      expect(prisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['sub-1'] } },
      });
    });

    it('removes stale subscriptions on 410', async () => {
      const sub = makeSub();
      (prisma.webPushSubscription.findMany as jest.Mock).mockResolvedValue([sub]);
      mockSendNotification.mockRejectedValue({ statusCode: 410 });
      (prisma.webPushSubscription.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.sendToUser(userId, type, 'Title', 'Body');

      expect(prisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['sub-1'] } },
      });
    });

    it('does not delete subscriptions on other errors', async () => {
      const sub = makeSub();
      (prisma.webPushSubscription.findMany as jest.Mock).mockResolvedValue([sub]);
      mockSendNotification.mockRejectedValue({ statusCode: 500, message: 'Server error' });

      await service.sendToUser(userId, type, 'Title', 'Body');

      expect(prisma.webPushSubscription.deleteMany).not.toHaveBeenCalled();
    });

    it('is a no-op when the service is disabled (missing VAPID keys)', async () => {
      configGet.mockReturnValue(undefined);
      const module = await Test.createTestingModule({
        providers: [
          WebPushService,
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: { get: configGet } },
        ],
      }).compile();
      const disabledService = module.get<WebPushService>(WebPushService);
      disabledService.onModuleInit();

      await disabledService.sendToUser(userId, type, 'Title', 'Body');

      expect(prisma.webPushSubscription.findMany).not.toHaveBeenCalled();
      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it('sends to multiple subscriptions and cleans up only the stale ones', async () => {
      const good = makeSub({ id: 'sub-good', endpoint: 'https://push.example.com/good' });
      const stale = makeSub({ id: 'sub-stale', endpoint: 'https://push.example.com/stale' });
      (prisma.webPushSubscription.findMany as jest.Mock).mockResolvedValue([good, stale]);
      mockSendNotification
        .mockResolvedValueOnce({})                      // good subscription succeeds
        .mockRejectedValueOnce({ statusCode: 410 });    // stale subscription gone
      (prisma.webPushSubscription.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.sendToUser(userId, type, 'Title', 'Body');

      expect(mockSendNotification).toHaveBeenCalledTimes(2);
      expect(prisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['sub-stale'] } },
      });
    });
  });
});
