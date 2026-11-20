import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { WebPushService } from './web-push.service';
import { TelegramService } from './telegram.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BadRequestException } from '@nestjs/common';

const mockTelegramService = {
  createLink: jest.fn(),
  unlink: jest.fn(),
};

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let notificationsService: jest.Mocked<NotificationsService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    const mockNotificationsService = {
      buildDigest: jest.fn(),
      findForUser: jest.fn(),
      markRead: jest.fn(),
      markAllRead: jest.fn(),
      deleteAllRead: jest.fn(),
      getPreferencesResponse: jest.fn(),
      updatePreferences: jest.fn(),
      sendTestNotification: jest.fn(),
      findOne: jest.fn(),
      snooze: jest.fn(),
      unsnooze: jest.fn(),
      unsubscribe: jest.fn(),
    };

    const mockWebPushService = {
      getPublicKey: jest.fn().mockReturnValue('mock-key'),
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: WebPushService, useValue: mockWebPushService },
        { provide: TelegramService, useValue: mockTelegramService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<NotificationsController>(NotificationsController);
    notificationsService = module.get(NotificationsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('creates a Telegram linking URL for the authenticated user', async () => {
    const result = { link: 'https://t.me/example_bot?start=one-time-code', expiresAt: new Date() };
    mockTelegramService.createLink.mockResolvedValue(result);

    await expect(controller.createTelegramLink('user-123')).resolves.toBe(result);
    expect(mockTelegramService.createLink).toHaveBeenCalledWith('user-123');
  });

  it('unlinks Telegram for the authenticated user', async () => {
    mockTelegramService.unlink.mockResolvedValue({ unlinked: true });

    await expect(controller.unlinkTelegram('user-123')).resolves.toEqual({ unlinked: true });
    expect(mockTelegramService.unlink).toHaveBeenCalledWith('user-123');
  });

  describe('getDigestPreview', () => {
    const userId = 'user-123';

    it('should return digest if notifications exist', async () => {
      const mockDigest = { subject: 'Test Digest', html: '<p>Test</p>' };
      notificationsService.buildDigest.mockResolvedValue(mockDigest);

      const result = await controller.getDigestPreview(userId);
      expect(notificationsService.buildDigest).toHaveBeenCalledWith(userId);
      expect(result).toEqual(mockDigest);
    });

    it('should return empty subject and html if no digest exists', async () => {
      notificationsService.buildDigest.mockResolvedValue(null);

      const result = await controller.getDigestPreview(userId);
      expect(notificationsService.buildDigest).toHaveBeenCalledWith(userId);
      expect(result).toEqual({ subject: '', html: '' });
    });
  });

  describe('snooze', () => {
    const userId = 'user-123';
    const notifId = 'notif-abc';
    const until = '2099-01-01T09:00:00.000Z';

    it('calls service.snooze with the correct args and returns nothing (204)', async () => {
      notificationsService.snooze.mockResolvedValue(undefined);

      const result = await controller.snooze(notifId, userId, { until });

      expect(notificationsService.snooze).toHaveBeenCalledWith(userId, notifId, until);
      expect(result).toBeUndefined();
    });

    it('propagates NotFoundException from the service', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      notificationsService.snooze.mockRejectedValue(new NotFoundException('Notification not found'));

      await expect(controller.snooze(notifId, userId, { until })).rejects.toThrow('Notification not found');
    });

    it('propagates BadRequestException when the service rejects a past date', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      notificationsService.snooze.mockRejectedValue(new BadRequestException('Snooze time must be in the future'));

      await expect(controller.snooze(notifId, userId, { until: '2000-01-01T00:00:00.000Z' })).rejects.toThrow(
        'Snooze time must be in the future',
      );
    });
  });

  describe('unsnooze', () => {
    const userId = 'user-123';
    const notifId = 'notif-abc';

    it('calls service.unsnooze with the correct args and returns nothing (204)', async () => {
      notificationsService.unsnooze.mockResolvedValue(undefined);

      const result = await controller.unsnooze(notifId, userId);

      expect(notificationsService.unsnooze).toHaveBeenCalledWith(userId, notifId);
      expect(result).toBeUndefined();
    });

    it('propagates NotFoundException from the service', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      notificationsService.unsnooze.mockRejectedValue(new NotFoundException('Notification not found'));

      await expect(controller.unsnooze(notifId, userId)).rejects.toThrow('Notification not found');
    });
  });

  describe('unsubscribe', () => {
    const validToken = 'valid.token.here';

    it('unsubscribes via query parameter on POST', async () => {
      const mockResult = { success: true, message: 'Successfully unsubscribed', type: 'PAYMENT_RELEASED' };
      notificationsService.unsubscribe.mockResolvedValue(mockResult);

      const result = await controller.unsubscribe(validToken);
      expect(notificationsService.unsubscribe).toHaveBeenCalledWith(validToken);
      expect(result).toEqual(mockResult);
    });

    it('unsubscribes via body parameter on POST', async () => {
      const mockResult = { success: true, message: 'Successfully unsubscribed', type: 'ALL' };
      notificationsService.unsubscribe.mockResolvedValue(mockResult);

      const result = await controller.unsubscribe(undefined, { token: validToken });
      expect(notificationsService.unsubscribe).toHaveBeenCalledWith(validToken);
      expect(result).toEqual(mockResult);
    });

    it('throws BadRequestException on POST when no token provided', async () => {
      await expect(controller.unsubscribe(undefined, undefined)).rejects.toThrow(BadRequestException);
      await expect(controller.unsubscribe(undefined, {})).rejects.toThrow(BadRequestException);
    });

    it('unsubscribes via GET request with token query param', async () => {
      const mockResult = { success: true, message: 'Successfully unsubscribed', type: 'DISPUTE_RAISED' };
      notificationsService.unsubscribe.mockResolvedValue(mockResult);

      const result = await controller.unsubscribeGet(validToken);
      expect(notificationsService.unsubscribe).toHaveBeenCalledWith(validToken);
      expect(result).toEqual(mockResult);
    });

    it('throws BadRequestException on GET when no token provided', async () => {
      await expect(controller.unsubscribeGet(undefined)).rejects.toThrow(BadRequestException);
    });
  });
});
