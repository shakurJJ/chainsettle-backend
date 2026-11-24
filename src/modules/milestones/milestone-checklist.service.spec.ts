import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MilestoneStatus } from '@prisma/client';
import { MilestoneChecklistService } from './milestone-checklist.service';

const BUYER = 'G' + 'B'.repeat(55);
const SUPPLIER = 'G' + 'S'.repeat(55);
const LOGISTICS = 'G' + 'L'.repeat(55);
const STRANGER = 'G' + 'X'.repeat(55);

describe('MilestoneChecklistService (#392)', () => {
  let service: MilestoneChecklistService;
  let prisma: any;
  let auditLog: { record: jest.Mock };

  const milestone = (status: MilestoneStatus = MilestoneStatus.PENDING) => ({
    id: 'm0',
    milestoneIndex: 0,
    status,
  });
  const item = (extra: any = {}) => ({
    id: 'i1',
    milestoneId: 'm0',
    label: 'Bill of lading',
    required: true,
    completedAt: null,
    completedBy: null,
    ...extra,
  });

  beforeEach(() => {
    prisma = {
      shipment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'SHIP-1',
          buyerAddress: BUYER,
          supplierAddress: SUPPLIER,
          logisticsAddress: LOGISTICS,
        }),
      },
      milestone: { findFirst: jest.fn().mockResolvedValue(milestone()) },
      milestoneChecklistItem: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(item()),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'i1', ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...item(), ...data })),
        delete: jest.fn().mockResolvedValue(item()),
      },
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    service = new MilestoneChecklistService(prisma, auditLog as any);
  });

  describe('create', () => {
    it('lets the buyer add items while PENDING', async () => {
      const created = await service.create('SHIP-1', 0, { label: '  Bill of lading ' }, BUYER, 'u1');
      expect(prisma.milestoneChecklistItem.create).toHaveBeenCalledWith({
        data: { milestoneId: 'm0', label: 'Bill of lading', required: true },
      });
      expect(created.label).toBe('Bill of lading');
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'milestone.checklist.item_added' }),
      );
    });

    it.each([SUPPLIER, LOGISTICS, STRANGER])('forbids non-buyer %s', async (caller) => {
      await expect(service.create('SHIP-1', 0, { label: 'x' }, caller)).rejects.toThrow(ForbiddenException);
      expect(prisma.milestoneChecklistItem.create).not.toHaveBeenCalled();
    });

    it.each([MilestoneStatus.PROOF_SUBMITTED, MilestoneStatus.CONFIRMED, MilestoneStatus.DISPUTED])(
      'rejects once milestone is %s',
      async (status) => {
        prisma.milestone.findFirst.mockResolvedValue(milestone(status));
        await expect(service.create('SHIP-1', 0, { label: 'x' }, BUYER)).rejects.toThrow(ConflictException);
      },
    );

    it('404s for a missing milestone', async () => {
      prisma.milestone.findFirst.mockResolvedValue(null);
      await expect(service.create('SHIP-1', 9, { label: 'x' }, BUYER)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update (complete / reopen)', () => {
    it.each([SUPPLIER, LOGISTICS])('lets %s mark an item complete', async (caller) => {
      await service.update('SHIP-1', 0, 'i1', { completed: true }, caller);
      expect(prisma.milestoneChecklistItem.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { completedAt: expect.any(Date), completedBy: caller },
      });
    });

    it('reopening clears completion', async () => {
      await service.update('SHIP-1', 0, 'i1', { completed: false }, SUPPLIER);
      expect(prisma.milestoneChecklistItem.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { completedAt: null, completedBy: null },
      });
    });

    it.each([BUYER, STRANGER])('forbids %s', async (caller) => {
      await expect(service.update('SHIP-1', 0, 'i1', { completed: true }, caller)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('404s for an item on another milestone', async () => {
      prisma.milestoneChecklistItem.findFirst.mockResolvedValue(null);
      await expect(service.update('SHIP-1', 0, 'other', { completed: true }, SUPPLIER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('buyer can remove while PENDING', async () => {
      await expect(service.remove('SHIP-1', 0, 'i1', BUYER)).resolves.toEqual({ removed: true, id: 'i1' });
    });

    it('supplier cannot remove', async () => {
      await expect(service.remove('SHIP-1', 0, 'i1', SUPPLIER)).rejects.toThrow(ForbiddenException);
    });

    it('cannot remove after PENDING', async () => {
      prisma.milestone.findFirst.mockResolvedValue(milestone(MilestoneStatus.PROOF_SUBMITTED));
      await expect(service.remove('SHIP-1', 0, 'i1', BUYER)).rejects.toThrow(ConflictException);
    });
  });

  it('list reports progress the buyer can see', async () => {
    prisma.milestoneChecklistItem.findMany.mockResolvedValue([
      item({ id: 'a', completedAt: new Date() }),
      item({ id: 'b' }),
      item({ id: 'c', required: false, completedAt: new Date() }),
    ]);
    const { progress } = await service.list('SHIP-1', 0);
    expect(progress).toEqual({ total: 3, completed: 2, requiredTotal: 2, requiredCompleted: 1 });
  });
});
