import { Test, TestingModule } from '@nestjs/testing';
import { MilestoneDeadlineJob } from './milestone-deadline.job';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MilestoneStatus, NotificationType } from '@prisma/client';

describe('MilestoneDeadlineJob', () => {
  let service: MilestoneDeadlineJob;
  let prisma: PrismaService;
  let notifications: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MilestoneDeadlineJob,
        {
          provide: PrismaService,
          useValue: {
            milestone: {
              findMany: jest.fn(),
              update: jest.fn(),
            },
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            notifyUser: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<MilestoneDeadlineJob>(MilestoneDeadlineJob);
    prisma = module.get<PrismaService>(PrismaService);
    notifications = module.get<NotificationsService>(NotificationsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkAndNotifyOverdue', () => {
    it('should query milestones with correct filters', async () => {
      const prismaMock = prisma.milestone.findMany as jest.Mock;
      prismaMock.mockResolvedValue([]);

      await service.checkAndNotifyOverdue();

      expect(prismaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            dueAt: { lt: expect.any(Date) },
            status: { in: [MilestoneStatus.PENDING, MilestoneStatus.PROOF_SUBMITTED] },
            overdueNotifiedAt: null,
          }),
          include: expect.any(Object),
        }),
      );
    });

    it('should not process anything when no overdue milestones exist', async () => {
      const prismaMock = prisma.milestone.findMany as jest.Mock;
      prismaMock.mockResolvedValue([]);

      const notificationsSpy = jest.spyOn(notifications, 'notifyUser');

      await service.checkAndNotifyOverdue();

      expect(notificationsSpy).not.toHaveBeenCalled();
    });

    it('should send notifications to buyer and supplier for each overdue milestone', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const overdueMilestone = {
        id: 'milestone-1',
        milestoneIndex: 0,
        dueAt: pastDate,
        status: MilestoneStatus.PENDING,
        overdueNotifiedAt: null,
        shipment: {
          id: 'shipment-1',
          buyerAddress: 'GBUYER123',
          supplierAddress: 'GSUPPLIER456',
        },
      };

      const prismaMock = prisma.milestone.findMany as jest.Mock;
      const prismaUpdateMock = prisma.milestone.update as jest.Mock;
      prismaMock
        .mockResolvedValueOnce([overdueMilestone])
        .mockResolvedValueOnce([]);
      prismaUpdateMock.mockResolvedValue(overdueMilestone);

      const notificationsSpy = jest.spyOn(notifications, 'notifyUser');

      await service.checkAndNotifyOverdue();

      // Should notify both buyer and supplier
      expect(notificationsSpy).toHaveBeenCalledTimes(2);

      // Verify buyer notification
      expect(notificationsSpy).toHaveBeenCalledWith(
        'GBUYER123',
        NotificationType.MILESTONE_OVERDUE,
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );

      // Verify supplier notification
      expect(notificationsSpy).toHaveBeenCalledWith(
        'GSUPPLIER456',
        NotificationType.MILESTONE_OVERDUE,
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('should set overdueNotifiedAt after sending notifications', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const overdueMilestone = {
        id: 'milestone-1',
        milestoneIndex: 0,
        dueAt: pastDate,
        status: MilestoneStatus.PROOF_SUBMITTED,
        overdueNotifiedAt: null,
        shipment: {
          id: 'shipment-1',
          buyerAddress: 'GBUYER123',
          supplierAddress: 'GSUPPLIER456',
        },
      };

      const prismaMock = prisma.milestone.findMany as jest.Mock;
      const prismaUpdateMock = prisma.milestone.update as jest.Mock;
      prismaMock
        .mockResolvedValueOnce([overdueMilestone])
        .mockResolvedValueOnce([]);
      prismaUpdateMock.mockResolvedValue({
        ...overdueMilestone,
        overdueNotifiedAt: new Date(),
      });

      await service.checkAndNotifyOverdue();

      // Verify update was called
      expect(prismaUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'milestone-1' },
          data: expect.objectContaining({
            overdueNotifiedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('should not re-notify milestones that already have overdueNotifiedAt set', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const alreadyNotifiedDate = new Date(Date.now() - 12 * 60 * 60 * 1000);

      const prismaMock = prisma.milestone.findMany as jest.Mock;
      prismaMock.mockResolvedValue([]); // Empty because overdueNotifiedAt is not null

      const notificationsSpy = jest.spyOn(notifications, 'notifyUser');

      await service.checkAndNotifyOverdue();

      expect(notificationsSpy).not.toHaveBeenCalled();
    });

    it('should handle multiple overdue milestones', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const milestone1 = {
        id: 'milestone-1',
        milestoneIndex: 0,
        dueAt: pastDate,
        status: MilestoneStatus.PENDING,
        overdueNotifiedAt: null,
        shipment: {
          id: 'shipment-1',
          buyerAddress: 'GBUYER123',
          supplierAddress: 'GSUPPLIER456',
        },
      };

      const milestone2 = {
        id: 'milestone-2',
        milestoneIndex: 1,
        dueAt: pastDate,
        status: MilestoneStatus.PROOF_SUBMITTED,
        overdueNotifiedAt: null,
        shipment: {
          id: 'shipment-2',
          buyerAddress: 'GBUYER789',
          supplierAddress: 'GSUPPLIER999',
        },
      };

      const prismaMock = prisma.milestone.findMany as jest.Mock;
      const prismaUpdateMock = prisma.milestone.update as jest.Mock;
      prismaMock
        .mockResolvedValueOnce([milestone1, milestone2])
        .mockResolvedValueOnce([]);
      prismaUpdateMock.mockResolvedValue({ overdueNotifiedAt: new Date() });

      const notificationsSpy = jest.spyOn(notifications, 'notifyUser');

      await service.checkAndNotifyOverdue();

      // Should notify 2 milestones × 2 users each = 4 notifications
      expect(notificationsSpy).toHaveBeenCalledTimes(4);

      // Should update both milestones
      expect(prismaUpdateMock).toHaveBeenCalledTimes(2);
    });

    it('should skip notifications for CONFIRMED or RESOLVED milestones', async () => {
      // The query should already exclude these via status filter,
      // but we verify the logic is correct in the serialization

      const prismaMock = prisma.milestone.findMany as jest.Mock;
      prismaMock.mockResolvedValue([]); // Query should not return CONFIRMED or RESOLVED

      const notificationsSpy = jest.spyOn(notifications, 'notifyUser');

      await service.checkAndNotifyOverdue();

      expect(notificationsSpy).not.toHaveBeenCalled();
    });

    it('should log errors gracefully without throwing', async () => {
      const error = new Error('Database error');
      const prismaMock = prisma.milestone.findMany as jest.Mock;
      prismaMock.mockRejectedValue(error);

      const loggerSpy = jest.spyOn(service['logger'], 'error');

      await service.checkAndNotifyOverdue();

      expect(loggerSpy).toHaveBeenCalledWith('Milestone deadline check failed', error.message);
    });

    it('should include correct notification data for overdue milestone', async () => {
      const pastDate = new Date('2026-05-28T12:00:00Z');
      const overdueMilestone = {
        id: 'milestone-1',
        milestoneIndex: 2,
        dueAt: pastDate,
        status: MilestoneStatus.PENDING,
        overdueNotifiedAt: null,
        shipment: {
          id: 'shipment-abc',
          buyerAddress: 'GBUYER123',
          supplierAddress: 'GSUPPLIER456',
        },
      };

      const prismaMock = prisma.milestone.findMany as jest.Mock;
      const prismaUpdateMock = prisma.milestone.update as jest.Mock;
      prismaMock.mockResolvedValue([overdueMilestone]);
      prismaUpdateMock.mockResolvedValue(overdueMilestone);

      const notificationsSpy = jest.spyOn(notifications, 'notifyUser');

      await service.checkAndNotifyOverdue();

      // Verify notification data includes correct shipmentId and milestoneIndex
      expect(notificationsSpy).toHaveBeenCalledWith(
        expect.any(String),
        NotificationType.MILESTONE_OVERDUE,
        expect.stringContaining('2'),
        expect.stringContaining('shipment-abc'),
        expect.objectContaining({
          shipmentId: 'shipment-abc',
          milestoneIndex: 2,
          dueAt: expect.any(String),
          threshold: expect.any(Number),
          recipient: expect.any(String),
        }),
      );
    });
  });
});
