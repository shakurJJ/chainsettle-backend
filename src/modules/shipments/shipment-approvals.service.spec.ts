import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ShipmentApprovalsService } from './shipment-approvals.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const THRESHOLD = '1000000000000'; // 100,000 USDC at 7 decimals

describe('ShipmentApprovalsService', () => {
  let service: ShipmentApprovalsService;
  let prisma: {
    shipment: { findUnique: jest.Mock };
    shipmentApproval: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      count: jest.Mock;
    };
  };

  const BUYER = 'GBUYER';
  const SUPPLIER = 'GSUPPLIER';
  const LOGISTICS = 'GLOGISTICS';
  const ARBITER = 'GARBITER';
  const OUTSIDER = 'GOUTSIDER';

  function shipmentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'SHIP-1',
      requiredApprovals: 2,
      buyerAddress: BUYER,
      supplierAddress: SUPPLIER,
      logisticsAddress: LOGISTICS,
      arbiterAddress: ARBITER,
      ...overrides,
    };
  }

  beforeEach(async () => {
    prisma = {
      shipment: { findUnique: jest.fn() },
      shipmentApproval: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShipmentApprovalsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(THRESHOLD) },
        },
      ],
    }).compile();

    service = module.get<ShipmentApprovalsService>(ShipmentApprovalsService);
  });

  // -- Threshold --------------------------------------------------------------

  describe('meetsThreshold', () => {
    it('is true at exactly the threshold', () => {
      expect(service.meetsThreshold(BigInt(THRESHOLD))).toBe(true);
    });

    it('is true above the threshold', () => {
      expect(service.meetsThreshold(BigInt(THRESHOLD) + BigInt(1))).toBe(true);
    });

    it('is false below the threshold', () => {
      expect(service.meetsThreshold(BigInt(THRESHOLD) - BigInt(1))).toBe(false);
    });
  });

  // -- Creation ---------------------------------------------------------------

  describe('resolveRequiredApprovals', () => {
    it('returns null when the field is omitted, leaving the flow unchanged', () => {
      expect(
        service.resolveRequiredApprovals(undefined, BigInt(THRESHOLD)),
      ).toBeNull();
    });

    it('returns null for a small shipment that omits the field', () => {
      expect(service.resolveRequiredApprovals(undefined, BigInt(5))).toBeNull();
    });

    it('accepts a count on a shipment at the threshold', () => {
      expect(service.resolveRequiredApprovals(2, BigInt(THRESHOLD))).toBe(2);
    });

    it('rejects a count on a shipment below the threshold', () => {
      expect(() => service.resolveRequiredApprovals(2, BigInt(5))).toThrow(
        BadRequestException,
      );
    });

    it('rejects a zero or negative count', () => {
      expect(() => service.resolveRequiredApprovals(0, BigInt(THRESHOLD))).toThrow(
        BadRequestException,
      );
      expect(() => service.resolveRequiredApprovals(-1, BigInt(THRESHOLD))).toThrow(
        BadRequestException,
      );
    });

    it('rejects a non-integer count', () => {
      expect(() =>
        service.resolveRequiredApprovals(1.5, BigInt(THRESHOLD)),
      ).toThrow(BadRequestException);
    });
  });

  // -- Recording approvals ----------------------------------------------------

  describe('approve', () => {
    it('records an approval from a shipment participant', async () => {
      prisma.shipment.findUnique.mockResolvedValue(shipmentRow());
      prisma.shipmentApproval.create.mockResolvedValue({
        id: 'a1',
        shipmentId: 'SHIP-1',
        approverAddress: SUPPLIER,
      });
      prisma.shipmentApproval.count.mockResolvedValue(1);

      const result = await service.approve('SHIP-1', SUPPLIER, 'looks good');

      expect(prisma.shipmentApproval.create).toHaveBeenCalledWith({
        data: {
          shipmentId: 'SHIP-1',
          approverAddress: SUPPLIER,
          note: 'looks good',
        },
      });
      expect(result.approvalCount).toBe(1);
      expect(result.requiredApprovals).toBe(2);
      expect(result.quorumMet).toBe(false);
    });

    it('reports quorum met once the final approval lands', async () => {
      prisma.shipment.findUnique.mockResolvedValue(shipmentRow());
      prisma.shipmentApproval.create.mockResolvedValue({ id: 'a2' });
      prisma.shipmentApproval.count.mockResolvedValue(2);

      const result = await service.approve('SHIP-1', ARBITER);

      expect(result.quorumMet).toBe(true);
    });

    it('rejects an approver who is not on the shipment', async () => {
      prisma.shipment.findUnique.mockResolvedValue(shipmentRow());

      await expect(service.approve('SHIP-1', OUTSIDER)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.shipmentApproval.create).not.toHaveBeenCalled();
    });

    it('rejects a second approval from the same address', async () => {
      prisma.shipment.findUnique.mockResolvedValue(shipmentRow());
      prisma.shipmentApproval.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(service.approve('SHIP-1', SUPPLIER)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.shipmentApproval.create).not.toHaveBeenCalled();
    });

    it('rejects approval on a shipment that does not use multi-signature', async () => {
      prisma.shipment.findUnique.mockResolvedValue(
        shipmentRow({ requiredApprovals: null }),
      );

      await expect(service.approve('SHIP-1', SUPPLIER)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('404s for an unknown shipment', async () => {
      prisma.shipment.findUnique.mockResolvedValue(null);

      await expect(service.approve('NOPE', SUPPLIER)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('accepts each of the four participant roles', async () => {
      prisma.shipmentApproval.create.mockResolvedValue({ id: 'a' });
      prisma.shipmentApproval.count.mockResolvedValue(1);

      for (const address of [BUYER, SUPPLIER, LOGISTICS, ARBITER]) {
        prisma.shipment.findUnique.mockResolvedValue(shipmentRow());
        await expect(service.approve('SHIP-1', address)).resolves.toBeDefined();
      }
    });
  });

  // -- Quorum gate ------------------------------------------------------------

  describe('assertQuorum', () => {
    it('passes straight through for a single-approver shipment', async () => {
      prisma.shipment.findUnique.mockResolvedValue({ requiredApprovals: null });

      await expect(service.assertQuorum('SHIP-1')).resolves.toBeUndefined();
      expect(prisma.shipmentApproval.count).not.toHaveBeenCalled();
    });

    it('blocks confirmation while approvals are short of the quorum', async () => {
      prisma.shipment.findUnique.mockResolvedValue({ requiredApprovals: 2 });
      prisma.shipmentApproval.count.mockResolvedValue(1);

      await expect(service.assertQuorum('SHIP-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('names the shortfall so the caller knows what is missing', async () => {
      prisma.shipment.findUnique.mockResolvedValue({ requiredApprovals: 3 });
      prisma.shipmentApproval.count.mockResolvedValue(1);

      await expect(service.assertQuorum('SHIP-1')).rejects.toThrow(
        /requires 3 approvals/,
      );
    });

    it('allows confirmation once the quorum is exactly met', async () => {
      prisma.shipment.findUnique.mockResolvedValue({ requiredApprovals: 2 });
      prisma.shipmentApproval.count.mockResolvedValue(2);

      await expect(service.assertQuorum('SHIP-1')).resolves.toBeUndefined();
    });

    it('allows confirmation when approvals exceed the quorum', async () => {
      prisma.shipment.findUnique.mockResolvedValue({ requiredApprovals: 2 });
      prisma.shipmentApproval.count.mockResolvedValue(5);

      await expect(service.assertQuorum('SHIP-1')).resolves.toBeUndefined();
    });

    it('does not block when the shipment is missing, leaving that to the caller', async () => {
      prisma.shipment.findUnique.mockResolvedValue(null);

      await expect(service.assertQuorum('SHIP-1')).resolves.toBeUndefined();
    });
  });

  describe('hasQuorum', () => {
    it('is true for a single-approver shipment', async () => {
      prisma.shipment.findUnique.mockResolvedValue({ requiredApprovals: null });

      await expect(service.hasQuorum('SHIP-1')).resolves.toBe(true);
    });

    it('is false while short of the quorum', async () => {
      prisma.shipment.findUnique.mockResolvedValue({ requiredApprovals: 2 });
      prisma.shipmentApproval.count.mockResolvedValue(1);

      await expect(service.hasQuorum('SHIP-1')).resolves.toBe(false);
    });

    it('is true once the quorum is met', async () => {
      prisma.shipment.findUnique.mockResolvedValue({ requiredApprovals: 2 });
      prisma.shipmentApproval.count.mockResolvedValue(2);

      await expect(service.hasQuorum('SHIP-1')).resolves.toBe(true);
    });
  });

  // -- Detail response --------------------------------------------------------

  describe('getApprovalStatus', () => {
    it('reports a single-approver shipment as already at quorum', async () => {
      await expect(service.getApprovalStatus('SHIP-1', null)).resolves.toEqual({
        required: null,
        count: 0,
        quorumMet: true,
        approvals: [],
      });
      expect(prisma.shipmentApproval.findMany).not.toHaveBeenCalled();
    });

    it('reports progress for a multi-signature shipment', async () => {
      prisma.shipmentApproval.findMany.mockResolvedValue([
        { id: 'a1', approverAddress: SUPPLIER },
      ]);

      await expect(service.getApprovalStatus('SHIP-1', 2)).resolves.toEqual({
        required: 2,
        count: 1,
        quorumMet: false,
        approvals: [{ id: 'a1', approverAddress: SUPPLIER }],
      });
    });

    it('reports quorum met when enough approvals are recorded', async () => {
      prisma.shipmentApproval.findMany.mockResolvedValue([
        { id: 'a1' },
        { id: 'a2' },
      ]);

      const status = await service.getApprovalStatus('SHIP-1', 2);
      expect(status.quorumMet).toBe(true);
    });
  });
});
