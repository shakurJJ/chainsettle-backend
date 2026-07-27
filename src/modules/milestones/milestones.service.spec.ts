import { Test, TestingModule } from '@nestjs/testing';
import { MilestonesService } from './milestones.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IpfsService } from '../../common/ipfs/ipfs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { MilestoneStatus } from '@prisma/client';

describe('MilestonesService', () => {
  let service: MilestonesService;
  const prisma = {
    milestone: { findUnique: jest.fn() },
    disputeEvidence: { findMany: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MilestonesService,
        { provide: PrismaService, useValue: prisma },
        { provide: IpfsService, useValue: { getGatewayUrl: jest.fn().mockReturnValue('https://ipfs.test/abc') } },
        { provide: NotificationsService, useValue: {} },
        { provide: ShipmentsService, useValue: {} },
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
});
