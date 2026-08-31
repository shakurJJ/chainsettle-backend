import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let notificationsService: jest.Mocked<NotificationsService>;

  beforeEach(async () => {
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
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationsService, useValue: mockNotificationsService },
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
});
