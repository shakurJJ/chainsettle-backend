import { Test, TestingModule } from '@nestjs/testing';
import { LateDeliveryJob } from './late-delivery.job';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType, ShipmentStatus } from '@prisma/client';

describe('LateDeliveryJob', () => {
  let job: LateDeliveryJob;
  let prisma: PrismaService;
  let redis: RedisService;
  let notifications: NotificationsService;

  const mockOverdueShipments = [
    {
      id: 'SHIP-OVERDUE-1',
      buyerAddress: 'GBUYER1',
      supplierAddress: 'GSUPPLIER1',
      expectedDeliveryAt: new Date('2026-06-01T00:00:00Z'),
      status: ShipmentStatus.ACTIVE,
    },
    {
      id: 'SHIP-OVERDUE-2',
      buyerAddress: 'GBUYER2',
      supplierAddress: 'GSUPPLIER2',
      expectedDeliveryAt: new Date('2026-06-15T00:00:00Z'),
      status: ShipmentStatus.ACTIVE,
    },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LateDeliveryJob,
        {
          provide: PrismaService,
          useValue: {
            shipment: {
              findMany: jest.fn(),
            },
          },
        },
        {
          provide: RedisService,
          useValue: {
            acquireLock: jest.fn().mockResolvedValue(true),
            releaseLock: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            notifyUser: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    job = module.get<LateDeliveryJob>(LateDeliveryJob);
    prisma = module.get<PrismaService>(PrismaService);
    redis = module.get<RedisService>(RedisService);
    notifications = module.get<NotificationsService>(NotificationsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkOverdueShipments', () => {
    it('queries ACTIVE shipments with expectedDeliveryAt in the past', async () => {
      (prisma.shipment.findMany as jest.Mock).mockResolvedValue(mockOverdueShipments);

      const count = await job.checkOverdueShipments();

      expect(count).toBe(2);
      expect(prisma.shipment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: ShipmentStatus.ACTIVE,
            expectedDeliveryAt: { lt: expect.any(Date) },
          }),
        }),
      );
    });

    it('notifies buyer and supplier for each overdue shipment', async () => {
      (prisma.shipment.findMany as jest.Mock).mockResolvedValue(mockOverdueShipments);

      await job.checkOverdueShipments();

      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'GBUYER1',
        NotificationType.DELIVERY_DELAYED,
        'Shipment delivery overdue',
        expect.stringContaining('SHIP-OVERDUE-1'),
        expect.objectContaining({
          shipmentId: 'SHIP-OVERDUE-1',
          isOverdue: true,
        }),
      );

      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'GSUPPLIER1',
        NotificationType.DELIVERY_DELAYED,
        'Shipment delivery overdue',
        expect.stringContaining('SHIP-OVERDUE-1'),
        expect.objectContaining({
          shipmentId: 'SHIP-OVERDUE-1',
          isOverdue: true,
        }),
      );

      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'GBUYER2',
        NotificationType.DELIVERY_DELAYED,
        'Shipment delivery overdue',
        expect.stringContaining('SHIP-OVERDUE-2'),
        expect.objectContaining({
          shipmentId: 'SHIP-OVERDUE-2',
          isOverdue: true,
        }),
      );
    });

    it('returns 0 when no overdue ACTIVE shipments exist', async () => {
      (prisma.shipment.findMany as jest.Mock).mockResolvedValue([]);

      const count = await job.checkOverdueShipments();

      expect(count).toBe(0);
      expect(notifications.notifyUser).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    it('acquires lock, processes overdue shipments, and releases lock', async () => {
      (prisma.shipment.findMany as jest.Mock).mockResolvedValue(mockOverdueShipments);

      const count = await job.run();

      expect(count).toBe(2);
      expect(redis.acquireLock).toHaveBeenCalled();
      expect(redis.releaseLock).toHaveBeenCalled();
    });

    it('skips execution if lock cannot be acquired', async () => {
      (redis.acquireLock as jest.Mock).mockResolvedValue(false);

      const count = await job.run();

      expect(count).toBe(0);
      expect(prisma.shipment.findMany).not.toHaveBeenCalled();
    });
  });
});
