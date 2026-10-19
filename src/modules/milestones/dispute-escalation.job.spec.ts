import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DisputeEscalationJob } from './dispute-escalation.job';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MilestoneStatus, NotificationType, UserRole } from '@prisma/client';

describe('DisputeEscalationJob', () => {
  let service: DisputeEscalationJob;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let config: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeEscalationJob,
        {
          provide: PrismaService,
          useValue: {
            milestone: {
              findMany: jest.fn(),
              update: jest.fn(),
            },
            user: {
              findMany: jest.fn(),
            },
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            notifyUser: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'DISPUTE_ESCALATION_DAYS') return 7;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<DisputeEscalationJob>(DisputeEscalationJob);
    prisma = module.get<PrismaService>(PrismaService);
    notifications = module.get<NotificationsService>(NotificationsService);
    config = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkAndEscalateDisputes', () => {
    it('should read DISPUTE_ESCALATION_DAYS from ConfigService and query disputes beyond threshold', async () => {
      const configSpy = jest.spyOn(config, 'get');
      const prismaMilestoneMock = prisma.milestone.findMany as jest.Mock;
      prismaMilestoneMock.mockResolvedValue([]);

      await service.checkAndEscalateDisputes();

      expect(configSpy).toHaveBeenCalledWith('DISPUTE_ESCALATION_DAYS', 7);
      expect(prismaMilestoneMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: MilestoneStatus.DISPUTED,
            updatedAt: { lt: expect.any(Date) },
            disputeEscalatedAt: null,
          }),
        }),
      );
    });

    it('should escalate overdue disputes to admin users', async () => {
      const disputedMilestone = {
        id: 'milestone-1',
        milestoneIndex: 0,
        status: MilestoneStatus.DISPUTED,
        updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        disputeEscalatedAt: null,
        shipment: {
          id: 'shipment-1',
          arbiterAddress: 'GARBITER123',
          arbiter: null,
        },
      };

      const adminUser = {
        stellarAddress: 'GADMIN123',
      };

      (prisma.milestone.findMany as jest.Mock).mockResolvedValue([disputedMilestone]);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([adminUser]);
      (prisma.milestone.update as jest.Mock).mockResolvedValue({
        ...disputedMilestone,
        disputeEscalatedAt: new Date(),
      });

      const notifySpy = jest.spyOn(notifications, 'notifyUser');

      await service.checkAndEscalateDisputes();

      expect(notifySpy).toHaveBeenCalledWith(
        'GADMIN123',
        NotificationType.SYSTEM_ALERT,
        expect.stringContaining('Unresolved dispute'),
        expect.stringContaining('7 days'),
        expect.objectContaining({
          shipmentId: 'shipment-1',
          milestoneIndex: 0,
          arbiterAddress: 'GARBITER123',
        }),
      );

      expect(prisma.milestone.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'milestone-1' },
          data: { disputeEscalatedAt: expect.any(Date) },
        }),
      );
    });

    it('should respect custom DISPUTE_ESCALATION_DAYS value from ConfigService', async () => {
      (config.get as jest.Mock).mockReturnValue(14);
      const prismaMilestoneMock = prisma.milestone.findMany as jest.Mock;
      prismaMilestoneMock.mockResolvedValue([]);

      const before = Date.now();
      await service.checkAndEscalateDisputes();
      const after = Date.now();

      const queryArgs = prismaMilestoneMock.mock.calls[0][0];
      const queriedThreshold: Date = queryArgs.where.updatedAt.lt;

      const expectedMin = before - 14 * 24 * 60 * 60 * 1000;
      const expectedMax = after - 14 * 24 * 60 * 60 * 1000;

      expect(queriedThreshold.getTime()).toBeGreaterThanOrEqual(expectedMin - 1000);
      expect(queriedThreshold.getTime()).toBeLessThanOrEqual(expectedMax + 1000);
    });
  });
});
