import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PushNotificationService } from './push-notification.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationType } from '@prisma/client';

// Mock firebase-admin
jest.mock('firebase-admin', () => ({
  credential: {
    cert: jest.fn(),
  },
  initializeApp: jest.fn(() => ({
    messaging: jest.fn(() => ({
      send: jest.fn(),
    })),
  })),
}));

describe('PushNotificationService', () => {
  let service: PushNotificationService;
  let prisma: any;
  let mockMessaging: any;

  const mockApp = {
    messaging: jest.fn(),
  };

  beforeEach(async () => {
    mockMessaging = {
      send: jest.fn(),
    };
    mockApp.messaging.mockReturnValue(mockMessaging);

    prisma = {
      deviceToken: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn(),
        delete: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushNotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<PushNotificationService>(PushNotificationService);
    // Set up the mock app
    (service as any).app = mockApp;
    jest.clearAllMocks();
  });

  describe('registerToken', () => {
    it('should upsert a device token', async () => {
      // Arrange
      const userId = 'user-1';
      const token = 'fcm-token-123';
      prisma.deviceToken.upsert.mockResolvedValue({ id: 'token-id', userId, token, platform: 'fcm' });

      // Act
      const result = await service.registerToken(userId, token);

      // Assert
      expect(prisma.deviceToken.upsert).toHaveBeenCalledWith({
        where: { token },
        create: { userId, token, platform: 'fcm' },
        update: { userId },
      });
      expect(result).toEqual({ id: 'token-id', userId, token, platform: 'fcm' });
    });

    it('should accept custom platform', async () => {
      // Arrange
      const userId = 'user-1';
      const token = 'apns-token-123';
      prisma.deviceToken.upsert.mockResolvedValue({ id: 'token-id', userId, token, platform: 'apns' });

      // Act
      await service.registerToken(userId, token, 'apns');

      // Assert
      expect(prisma.deviceToken.upsert).toHaveBeenCalledWith({
        where: { token },
        create: { userId, token, platform: 'apns' },
        update: { userId },
      });
    });
  });

  describe('removeToken', () => {
    it('should delete a device token', async () => {
      // Arrange
      const userId = 'user-1';
      const token = 'fcm-token-123';
      prisma.deviceToken.deleteMany.mockResolvedValue({ count: 1 });

      // Act
      await service.removeToken(userId, token);

      // Assert
      expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { userId, token },
      });
    });
  });

  describe('listTokens', () => {
    it('should return all tokens for a user', async () => {
      // Arrange
      const userId = 'user-1';
      const tokens = [
        { id: 'token-1', token: 'token-abc', platform: 'fcm', createdAt: new Date() },
        { id: 'token-2', token: 'token-xyz', platform: 'apns', createdAt: new Date() },
      ];
      prisma.deviceToken.findMany.mockResolvedValue(tokens);

      // Act
      const result = await service.listTokens(userId);

      // Assert
      expect(prisma.deviceToken.findMany).toHaveBeenCalledWith({
        where: { userId },
        select: { id: true, token: true, platform: true, createdAt: true },
      });
      expect(result).toEqual(tokens);
    });
  });

  describe('sendToUser', () => {
    it('should send push notification to all device tokens', async () => {
      // Arrange
      const userId = 'user-1';
      const type = NotificationType.MILESTONE_CONFIRMED;
      const title = 'Milestone Confirmed';
      const body = 'Your milestone has been confirmed by the buyer';
      const data = { shipmentId: 'shipment-123' };

      const deviceTokens = [
        { id: 'token-1', token: 'fcm-token-1' },
        { id: 'token-2', token: 'fcm-token-2' },
      ];
      prisma.deviceToken.findMany.mockResolvedValue(deviceTokens);
      mockMessaging.send.mockResolvedValue({ success: true });

      // Act
      await service.sendToUser(userId, type, title, body, data);

      // Assert
      expect(prisma.deviceToken.findMany).toHaveBeenCalledWith({
        where: { userId },
        select: { id: true, token: true },
      });
      expect(mockMessaging.send).toHaveBeenCalledTimes(2);
      expect(mockMessaging.send).toHaveBeenCalledWith({
        token: 'fcm-token-1',
        notification: { title, body },
        data: { eventType: type, shipmentId: 'shipment-123' },
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      });
    });

    it('should skip sending when no tokens registered', async () => {
      // Arrange
      const userId = 'user-1';
      prisma.deviceToken.findMany.mockResolvedValue([]);

      // Act
      await service.sendToUser(
        userId,
        NotificationType.MILESTONE_CONFIRMED,
        'Test',
        'Body',
      );

      // Assert
      expect(mockMessaging.send).not.toHaveBeenCalled();
    });

    it('should skip sending when FCM app is not initialized', async () => {
      // Arrange
      (service as any).app = null;
      const userId = 'user-1';

      // Act
      await service.sendToUser(
        userId,
        NotificationType.MILESTONE_CONFIRMED,
        'Test',
        'Body',
      );

      // Assert
      expect(prisma.deviceToken.findMany).not.toHaveBeenCalled();
    });

    it('should remove stale tokens on invalid registration error', async () => {
      // Arrange
      const userId = 'user-1';
      const deviceTokens = [
        { id: 'token-1', token: 'valid-token' },
        { id: 'token-2', token: 'stale-token' },
      ];
      prisma.deviceToken.findMany.mockResolvedValue(deviceTokens);

      // First token succeeds, second token is stale
      mockMessaging.send
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce({
          errorInfo: { code: 'messaging/registration-token-not-registered' },
        });

      // Act
      await service.sendToUser(
        userId,
        NotificationType.MILESTONE_CONFIRMED,
        'Test',
        'Body',
      );

      // Assert
      expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['token-2'] } },
      });
    });

    it('should remove tokens on invalid registration error', async () => {
      // Arrange
      const userId = 'user-1';
      const deviceTokens = [
        { id: 'token-1', token: 'invalid-token' },
      ];
      prisma.deviceToken.findMany.mockResolvedValue(deviceTokens);

      mockMessaging.send.mockRejectedValue({
        errorInfo: { code: 'messaging/invalid-registration-token' },
      });

      // Act
      await service.sendToUser(
        userId,
        NotificationType.MILESTONE_CONFIRMED,
        'Test',
        'Body',
      );

      // Assert
      expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['token-1'] } },
      });
    });

    it('should log warning for non-stale errors and not remove token', async () => {
      // Arrange
      const userId = 'user-1';
      const deviceTokens = [
        { id: 'token-1', token: 'token-1' },
      ];
      prisma.deviceToken.findMany.mockResolvedValue(deviceTokens);

      // A different error (not stale token)
      mockMessaging.send.mockRejectedValue({
        errorInfo: { code: 'messaging/internal-error' },
        message: 'Internal server error',
      });

      const loggerSpy = jest.spyOn((service as any).logger, 'warn');

      // Act
      await service.sendToUser(
        userId,
        NotificationType.MILESTONE_CONFIRMED,
        'Test',
        'Body',
      );

      // Assert
      expect(prisma.deviceToken.deleteMany).not.toHaveBeenCalled();
      expect(loggerSpy).toHaveBeenCalled();
    });

    it('should handle mixed success and failure for tokens', async () => {
      // Arrange
      const userId = 'user-1';
      const deviceTokens = [
        { id: 'token-1', token: 'valid-token-1' },
        { id: 'token-2', token: 'stale-token' },
        { id: 'token-3', token: 'valid-token-2' },
      ];
      prisma.deviceToken.findMany.mockResolvedValue(deviceTokens);

      mockMessaging.send
        .mockResolvedValueOnce({ success: true }) // valid
        .mockRejectedValueOnce({
          errorInfo: { code: 'messaging/registration-token-not-registered' },
        }) // stale
        .mockRejectedValueOnce({
          errorInfo: { code: 'messaging/internal-error' },
        }); // non-stale error

      // Act
      await service.sendToUser(
        userId,
        NotificationType.MILESTONE_CONFIRMED,
        'Test',
        'Body',
      );

      // Assert - only stale token should be removed
      expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['token-2'] } },
      });
    });
  });

  describe('onModuleInit', () => {
    it('should not initialize FCM when service account JSON is not set', async () => {
      // Create new instance with no FCM config
      const mockConfig = {
        get: jest.fn().mockReturnValue(undefined),
      };

      const newService = new PushNotificationService(
        { } as PrismaService,
        mockConfig as any,
      );

      await newService.onModuleInit();

      expect((newService as any).app).toBeNull();
    });

    it('should initialize FCM when service account JSON is provided', async () => {
      const mockConfig = {
        get: jest.fn().mockReturnValue(JSON.stringify({
          type: 'service_account',
          project_id: 'test-project',
          private_key: 'fake-key',
          client_email: 'test@test.iam.gserviceaccount.com',
        })),
      };

      const newService = new PushNotificationService(
        { } as PrismaService,
        mockConfig as any,
      );

      await newService.onModuleInit();

      expect((newService as any).app).not.toBeNull();
    });

    it('should log error when FCM initialization fails', async () => {
      const mockConfig = {
        get: jest.fn().mockReturnValue('invalid-json'),
      };

      const newService = new PushNotificationService(
        { } as PrismaService,
        mockConfig as any,
      );

      const loggerSpy = jest.spyOn((newService as any).logger, 'error');

      await newService.onModuleInit();

      expect(loggerSpy).toHaveBeenCalledWith(
        'Failed to initialise Firebase Admin SDK',
        expect.any(String),
      );
    });
  });
});