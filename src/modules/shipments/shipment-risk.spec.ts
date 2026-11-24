import { NotFoundException } from '@nestjs/common';
import { MilestoneStatus, ArbiterStatus, KycStatus, UserRole } from '@prisma/client';
import { computeShipmentRisk, RiskLevel } from './utils/risk.util';
import { ShipmentsService } from './shipments.service';
import { ShipmentsController } from './shipments.controller';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('Shipment Risk Assessment (GET /shipments/:id/risk)', () => {
  const baseNow = new Date('2026-03-30T12:00:00.000Z');

  const verifiedUser = {
    id: 'user-1',
    stellarAddress: 'GBUYER123',
    kycStatus: KycStatus.VERIFIED,
  };

  const createBaseShipment = () => ({
    id: 'shipment-123',
    buyerAddress: 'GBUYER123',
    supplierAddress: 'GSUPPLIER123',
    logisticsAddress: 'GLOGISTICS123',
    arbiterAddress: 'GARBITER123',
    arbiterStatus: ArbiterStatus.ACCEPTED,
    createdAt: new Date('2026-03-25T10:00:00.000Z'),
    updatedAt: new Date('2026-03-28T10:00:00.000Z'), // 2 days ago
    buyer: { ...verifiedUser, stellarAddress: 'GBUYER123' },
    supplier: { ...verifiedUser, id: 'user-2', stellarAddress: 'GSUPPLIER123' },
    logistics: { ...verifiedUser, id: 'user-3', stellarAddress: 'GLOGISTICS123' },
    arbiter: { ...verifiedUser, id: 'user-4', stellarAddress: 'GARBITER123' },
    milestones: [
      {
        id: 'm-1',
        milestoneIndex: 0,
        status: MilestoneStatus.CONFIRMED,
        dueAt: new Date('2026-03-20T00:00:00.000Z'),
        createdAt: new Date('2026-03-20T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
      },
      {
        id: 'm-2',
        milestoneIndex: 1,
        status: MilestoneStatus.PENDING,
        dueAt: new Date('2026-04-10T00:00:00.000Z'), // in future
        createdAt: new Date('2026-03-20T00:00:00.000Z'),
        updatedAt: new Date('2026-03-28T10:00:00.000Z'),
      },
    ],
    trackingUpdates: [],
    comments: [],
  });

  describe('computeShipmentRisk unit tests', () => {
    it('evaluates a completely healthy shipment as LOW risk with 0 reasons', () => {
      const shipment = createBaseShipment();
      const result = computeShipmentRisk(shipment, baseNow);

      expect(result.level).toBe(RiskLevel.LOW);
      expect(result.reasons).toEqual([]);
      expect(result.indicators).toEqual({
        overdueMilestones: 0,
        openDisputes: 0,
        arbiterNotAccepted: false,
        daysSinceLastActivity: 2,
        unverifiedCounterparties: 0,
      });
      expect(result.shipmentId).toBe('shipment-123');
    });

    describe('HIGH Risk boundaries', () => {
      it('returns HIGH risk when there is at least 1 open dispute', () => {
        const shipment = createBaseShipment();
        shipment.milestones.push({
          id: 'm-3',
          milestoneIndex: 2,
          status: MilestoneStatus.DISPUTED,
          dueAt: new Date('2026-04-15T00:00:00.000Z'),
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-28T00:00:00.000Z'),
        });

        const result = computeShipmentRisk(shipment, baseNow);
        expect(result.level).toBe(RiskLevel.HIGH);
        expect(result.indicators.openDisputes).toBe(1);
        expect(result.reasons).toContain('1 open dispute(s)');
      });

      it('returns HIGH risk when 2 or more milestones are overdue', () => {
        const shipment = createBaseShipment();
        // Add 2 overdue milestones
        shipment.milestones.push(
          {
            id: 'm-overdue-1',
            milestoneIndex: 2,
            status: MilestoneStatus.PENDING,
            dueAt: new Date('2026-03-25T00:00:00.000Z'), // past
            createdAt: new Date('2026-03-20T00:00:00.000Z'),
            updatedAt: new Date('2026-03-20T00:00:00.000Z'),
          },
          {
            id: 'm-overdue-2',
            milestoneIndex: 3,
            status: MilestoneStatus.PROOF_SUBMITTED,
            dueAt: new Date('2026-03-27T00:00:00.000Z'), // past
            createdAt: new Date('2026-03-20T00:00:00.000Z'),
            updatedAt: new Date('2026-03-20T00:00:00.000Z'),
          },
        );

        const result = computeShipmentRisk(shipment, baseNow);
        expect(result.level).toBe(RiskLevel.HIGH);
        expect(result.indicators.overdueMilestones).toBe(2);
        expect(result.reasons).toContain('2 overdue milestone(s)');
      });

      it('returns HIGH risk when inactive for 30 days or more', () => {
        const shipment = createBaseShipment();
        shipment.createdAt = new Date('2026-01-01T00:00:00.000Z');
        shipment.updatedAt = new Date('2026-02-15T00:00:00.000Z'); // 43 days before baseNow
        shipment.milestones = [
          {
            id: 'm-1',
            milestoneIndex: 0,
            status: MilestoneStatus.PENDING,
            dueAt: new Date('2026-05-01T00:00:00.000Z'),
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-02-15T00:00:00.000Z'),
          },
        ];

        const result = computeShipmentRisk(shipment, baseNow);
        expect(result.level).toBe(RiskLevel.HIGH);
        expect(result.indicators.daysSinceLastActivity).toBe(43);
        expect(result.reasons.some((r) => r.includes('exceeds 30-day threshold'))).toBe(true);
      });

      it('returns HIGH risk when 1 milestone is overdue AND arbiter has not accepted', () => {
        const shipment = createBaseShipment();
        shipment.arbiterStatus = ArbiterStatus.PENDING_ACCEPTANCE;
        shipment.milestones.push({
          id: 'm-overdue-1',
          milestoneIndex: 2,
          status: MilestoneStatus.PENDING,
          dueAt: new Date('2026-03-25T00:00:00.000Z'), // past
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-20T00:00:00.000Z'),
        });

        const result = computeShipmentRisk(shipment, baseNow);
        expect(result.level).toBe(RiskLevel.HIGH);
        expect(result.indicators.overdueMilestones).toBe(1);
        expect(result.indicators.arbiterNotAccepted).toBe(true);
        expect(result.reasons).toContain('1 overdue milestone(s)');
        expect(result.reasons.some((r) => r.includes('Arbiter has not accepted'))).toBe(true);
      });
    });

    describe('MEDIUM Risk boundaries', () => {
      it('returns MEDIUM risk when exactly 1 milestone is overdue and arbiter is accepted', () => {
        const shipment = createBaseShipment();
        shipment.arbiterStatus = ArbiterStatus.ACCEPTED;
        shipment.milestones.push({
          id: 'm-overdue-1',
          milestoneIndex: 2,
          status: MilestoneStatus.PENDING,
          dueAt: new Date('2026-03-25T00:00:00.000Z'), // past
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-28T00:00:00.000Z'),
        });

        const result = computeShipmentRisk(shipment, baseNow);
        expect(result.level).toBe(RiskLevel.MEDIUM);
        expect(result.indicators.overdueMilestones).toBe(1);
        expect(result.reasons).toContain('1 overdue milestone(s)');
      });

      it('returns MEDIUM risk when arbiter has not accepted (with no other issues)', () => {
        const shipment = createBaseShipment();
        shipment.arbiterStatus = ArbiterStatus.PENDING_ACCEPTANCE;

        const result = computeShipmentRisk(shipment, baseNow);
        expect(result.level).toBe(RiskLevel.MEDIUM);
        expect(result.indicators.arbiterNotAccepted).toBe(true);
        expect(result.reasons.some((r) => r.includes('Arbiter has not accepted'))).toBe(true);
      });

      it('returns MEDIUM risk when days since last activity is between 14 and 29 days', () => {
        const shipment = createBaseShipment();
        shipment.updatedAt = new Date('2026-03-10T12:00:00.000Z'); // 20 days ago
        shipment.milestones[0].updatedAt = new Date('2026-03-10T12:00:00.000Z');
        shipment.milestones[1].updatedAt = new Date('2026-03-10T12:00:00.000Z');

        const result = computeShipmentRisk(shipment, baseNow);
        expect(result.level).toBe(RiskLevel.MEDIUM);
        expect(result.indicators.daysSinceLastActivity).toBe(20);
        expect(result.reasons.some((r) => r.includes('exceeds 14-day threshold'))).toBe(true);
      });

      it('returns MEDIUM risk when counterparties are unverified for KYC', () => {
        const shipment = createBaseShipment();
        shipment.supplier = {
          id: 'user-unverified',
          stellarAddress: 'GSUPPLIER123',
          kycStatus: KycStatus.UNVERIFIED,
        };
        shipment.logistics = null as any; // not registered in DB

        const result = computeShipmentRisk(shipment, baseNow);
        expect(result.level).toBe(RiskLevel.MEDIUM);
        expect(result.indicators.unverifiedCounterparties).toBe(2);
        expect(result.reasons.some((r) => r.includes('2 counterparty(ies) have not completed KYC'))).toBe(true);
      });
    });

    it('ignores deleted milestones when computing overdue and open disputes', () => {
      const shipment = createBaseShipment();
      shipment.milestones.push(
        {
          id: 'm-deleted-dispute',
          milestoneIndex: 2,
          status: MilestoneStatus.DISPUTED,
          dueAt: new Date('2026-03-25T00:00:00.000Z'),
          deletedAt: new Date('2026-03-29T00:00:00.000Z'),
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-20T00:00:00.000Z'),
        },
        {
          id: 'm-deleted-overdue',
          milestoneIndex: 3,
          status: MilestoneStatus.PENDING,
          dueAt: new Date('2026-03-25T00:00:00.000Z'),
          deletedAt: new Date('2026-03-29T00:00:00.000Z'),
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-20T00:00:00.000Z'),
        },
      );

      const result = computeShipmentRisk(shipment, baseNow);
      expect(result.indicators.openDisputes).toBe(0);
      expect(result.indicators.overdueMilestones).toBe(0);
      expect(result.level).toBe(RiskLevel.LOW);
    });
  });

  describe('ShipmentsService.getShipmentRisk', () => {
    let shipmentsService: ShipmentsService;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        read: {
          shipment: {
            findUnique: jest.fn(),
          },
        },
      };

      shipmentsService = new ShipmentsService(
        mockPrisma as unknown as PrismaService,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('retrieves shipment and calculates risk result', async () => {
      const shipment = createBaseShipment();
      mockPrisma.read.shipment.findUnique.mockResolvedValue(shipment);

      const result = await shipmentsService.getShipmentRisk('shipment-123');

      expect(mockPrisma.read.shipment.findUnique).toHaveBeenCalledWith({
        where: { id: 'shipment-123' },
        include: {
          milestones: { where: { deletedAt: null }, orderBy: { milestoneIndex: 'asc' } },
          trackingUpdates: { orderBy: { createdAt: 'desc' }, take: 1 },
          comments: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 },
          buyer: { select: { id: true, stellarAddress: true, kycStatus: true } },
          supplier: { select: { id: true, stellarAddress: true, kycStatus: true } },
          logistics: { select: { id: true, stellarAddress: true, kycStatus: true } },
          arbiter: { select: { id: true, stellarAddress: true, kycStatus: true } },
        },
      });

      expect(result.shipmentId).toBe('shipment-123');
      expect(result.level).toBe(RiskLevel.LOW);
    });

    it('throws NotFoundException when shipment does not exist', async () => {
      mockPrisma.read.shipment.findUnique.mockResolvedValue(null);

      await expect(shipmentsService.getShipmentRisk('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('ShipmentsController.getRisk', () => {
    let shipmentsController: ShipmentsController;
    let mockShipmentsService: any;

    beforeEach(() => {
      mockShipmentsService = {
        getShipmentRisk: jest.fn(),
      };

      shipmentsController = new ShipmentsController(
        mockShipmentsService as unknown as ShipmentsService,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('delegates to shipmentsService.getShipmentRisk', async () => {
      const mockResult = {
        shipmentId: 'shipment-123',
        level: RiskLevel.HIGH,
        reasons: ['1 open dispute(s)'],
        indicators: {
          overdueMilestones: 0,
          openDisputes: 1,
          arbiterNotAccepted: false,
          daysSinceLastActivity: 2,
          unverifiedCounterparties: 0,
        },
        evaluatedAt: '2026-03-30T12:00:00.000Z',
      };

      mockShipmentsService.getShipmentRisk.mockResolvedValue(mockResult);

      const result = await shipmentsController.getRisk('shipment-123');

      expect(mockShipmentsService.getShipmentRisk).toHaveBeenCalledWith('shipment-123');
      expect(result).toEqual(mockResult);
    });
  });
});
