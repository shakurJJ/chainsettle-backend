import { Test, TestingModule } from '@nestjs/testing';
import { MilestonesService } from './milestones.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IpfsService } from '../../common/ipfs/ipfs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { MilestoneStatus } from '@prisma/client';
import { ShipmentApprovalsService } from '../shipments/shipment-approvals.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { FxRateService } from '../../common/fx/fx-rate.service';
import { MetricsService } from '../../common/metrics/metrics.service';

describe('MilestonesService', () => {
  let service: MilestonesService;
  const notifications = { notifyUser: jest.fn() };
  const prisma = {
    milestone: { findUnique: jest.fn() },
    disputeEvidence: { findMany: jest.fn() },
    disputeRationale: { create: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MilestonesService,
        { provide: PrismaService, useValue: prisma },
        { provide: IpfsService, useValue: { getGatewayUrl: jest.fn().mockReturnValue('https://ipfs.test/abc') } },
        { provide: NotificationsService, useValue: notifications },
        { provide: ShipmentsService, useValue: {} },
        { provide: ShipmentApprovalsService, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: StellarService, useValue: {} },
        { provide: FxRateService, useValue: {} },
        { provide: MetricsService, useValue: {} },
      ],
    }).compile();

    service = module.get<MilestonesService>(MilestonesService);
    jest.clearAllMocks();
  });

  it('returns dispute detail for a disputed milestone', async () => {
    prisma.milestone.findUnique.mockResolvedValue({
      id: 'milestone-1',
      status: MilestoneStatus.DISPUTED,
      disputeEscalatedAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    });
    prisma.disputeEvidence.findMany.mockResolvedValue([{ id: 'e1', ipfsCid: 'cid', createdAt: new Date() }]);

    const result = await service.getDisputeDetail('shipment-1', 0);

    expect(result.status).toBe(MilestoneStatus.DISPUTED);
    expect(result.evidence).toHaveLength(1);
    expect(result.disputeEscalatedAt).toBeInstanceOf(Date);
  });

  it('allows the assigned arbiter to store a resolved-dispute rationale', async () => {
    prisma.milestone.findUnique.mockResolvedValue({
      id: 'milestone-1',
      status: MilestoneStatus.RESOLVED,
      disputeRationale: null,
      shipment: {
        arbiterAddress: 'GARBITER',
        buyerAddress: 'GBUYER',
        supplierAddress: 'GSUPPLIER',
      },
    });
    prisma.disputeRationale.create.mockResolvedValue({
      id: 'rationale-1',
      milestoneId: 'milestone-1',
      writtenBy: 'GARBITER',
      rationale: '## Decision',
      ipfsCid: 'bafyCID',
    });

    const result = await service.submitDisputeRationale(
      'shipment-1',
      0,
      'GARBITER',
      '## Decision',
      'bafyCID',
    );

    expect(result.id).toBe('rationale-1');
    expect(prisma.disputeRationale.create).toHaveBeenCalledWith({
      data: {
        milestoneId: 'milestone-1',
        writtenBy: 'GARBITER',
        rationale: '## Decision',
        ipfsCid: 'bafyCID',
      },
    });
    expect(notifications.notifyUser).toHaveBeenCalledTimes(2);
  });

  it('rejects rationale writes by an address that is not the assigned arbiter', async () => {
    prisma.milestone.findUnique.mockResolvedValue({
      id: 'milestone-1',
      status: MilestoneStatus.RESOLVED,
      disputeRationale: null,
      shipment: {
        arbiterAddress: 'GARBITER',
        buyerAddress: 'GBUYER',
        supplierAddress: 'GSUPPLIER',
      },
    });

    await expect(
      service.submitDisputeRationale('shipment-1', 0, 'GBUYER', 'Decision'),
    ).rejects.toThrow('Only the assigned arbiter');
  });

  it('rejects a second rationale after one is already stored', async () => {
    prisma.milestone.findUnique.mockResolvedValue({
      id: 'milestone-1',
      status: MilestoneStatus.RESOLVED,
      disputeRationale: { id: 'rationale-1' },
      shipment: {
        arbiterAddress: 'GARBITER',
        buyerAddress: 'GBUYER',
        supplierAddress: 'GSUPPLIER',
      },
    });

    await expect(
      service.submitDisputeRationale('shipment-1', 0, 'GARBITER', 'Changed'),
    ).rejects.toThrow('immutable');
  });
});
