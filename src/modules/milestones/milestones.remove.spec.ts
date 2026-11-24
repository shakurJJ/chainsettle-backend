import { MilestoneStatus } from '@prisma/client';
import { MilestonesService } from './milestones.service';

const BUYER = 'G' + 'B'.repeat(55);

describe('MilestonesService — soft delete (#306)', () => {
  let service: MilestonesService;
  let prisma: any;
  let auditLog: { record: jest.Mock };

  const milestone = (index: number, extra: any = {}) => ({
    id: `m${index}`,
    milestoneIndex: index,
    name: `Milestone ${index}`,
    paymentPercent: 50,
    status: MilestoneStatus.PENDING,
    dueAt: null,
    ...extra,
  });

  beforeEach(() => {
    prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue({ id: 'SHIP-1', buyerAddress: BUYER }) },
      milestone: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn(),
        aggregate: jest.fn(),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
      },
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    service = new MilestonesService(prisma, {} as any, {} as any, {} as any, {} as any, auditLog as any, {} as any, {} as any);
  });

  it('sets deletedAt instead of deleting the row, and audits by the same id', async () => {
    prisma.milestone.findUnique.mockResolvedValue(milestone(1));
    prisma.milestone.findMany.mockResolvedValue([milestone(0), milestone(1)]);

    const result = await service.removeMilestone('SHIP-1', 1, BUYER, 'user-1');

    expect(prisma.milestone.delete).not.toHaveBeenCalled();
    expect(prisma.milestone.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { deletedAt: expect.any(Date) } });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'milestone.removed', resourceType: 'Milestone', resourceId: 'm1' }),
    );
    expect(result).toMatchObject({ removed: true, milestone: { id: 'm1' } });
  });

  it('ignores already soft-deleted milestones when looking up and counting', async () => {
    prisma.milestone.findUnique.mockResolvedValue(milestone(1));
    prisma.milestone.findMany.mockResolvedValue([milestone(0), milestone(1)]);

    await service.removeMilestone('SHIP-1', 1, BUYER);

    expect(prisma.milestone.findUnique.mock.calls[0][0].where.deletedAt).toBeNull();
    expect(prisma.milestone.findMany.mock.calls[0][0].where).toEqual({ shipmentId: 'SHIP-1', deletedAt: null });
  });

  it('refuses to remove the only live milestone', async () => {
    prisma.milestone.findUnique.mockResolvedValue(milestone(1));
    prisma.milestone.findMany.mockResolvedValue([milestone(1)]);

    await expect(service.removeMilestone('SHIP-1', 1, BUYER)).rejects.toThrow('only milestone');
    expect(prisma.milestone.update).not.toHaveBeenCalled();
  });

  it('appends after the highest index, including soft-deleted ones', async () => {
    prisma.milestone.findMany.mockResolvedValue([milestone(0)]);
    prisma.milestone.aggregate.mockResolvedValue({ _max: { milestoneIndex: 1 } });

    const created = await service.appendMilestone('SHIP-1', BUYER, { name: 'New', paymentPercent: 50 } as any);

    expect(prisma.milestone.findMany.mock.calls[0][0].where).toEqual({ shipmentId: 'SHIP-1', deletedAt: null });
    expect(created.milestoneIndex).toBe(2);
  });
});
