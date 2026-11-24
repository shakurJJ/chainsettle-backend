import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ExtensionRequestStatus, MilestoneStatus, NotificationType, Prisma } from '@prisma/client';
import { ExtensionRequestsService } from './extension-requests.service';

const BUYER = 'G' + 'B'.repeat(55);
const SUPPLIER = 'G' + 'S'.repeat(55);
const LOGISTICS = 'G' + 'L'.repeat(55);

const DAY = 24 * 60 * 60 * 1000;

describe('ExtensionRequestsService (#393)', () => {
  let service: ExtensionRequestsService;
  let prisma: any;
  let auditLog: { record: jest.Mock };
  let notifications: { notifyUser: jest.Mock };

  const currentDue = new Date(Date.now() + 2 * DAY);
  const proposedDue = new Date(Date.now() + 10 * DAY);

  const milestone = (extra: any = {}) => ({
    id: 'm0',
    milestoneIndex: 0,
    name: 'Goods dispatched',
    status: MilestoneStatus.PENDING,
    dueAt: currentDue,
    ...extra,
  });
  const pendingRequest = (extra: any = {}) => ({
    id: 'r1',
    milestoneId: 'm0',
    requestedBy: SUPPLIER,
    proposedDueAt: proposedDue,
    previousDueAt: currentDue,
    reason: 'Port congestion',
    status: ExtensionRequestStatus.PENDING,
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
      milestone: {
        findFirst: jest.fn().mockResolvedValue(milestone()),
        update: jest.fn().mockImplementation((args) => args),
      },
      deadlineExtensionRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'r1', ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    notifications = { notifyUser: jest.fn().mockResolvedValue(undefined) };
    service = new ExtensionRequestsService(prisma, auditLog as any, notifications as any);
  });

  describe('create', () => {
    const dto = () => ({ proposedDueAt: proposedDue.toISOString(), reason: 'Port congestion' });

    it.each([SUPPLIER, LOGISTICS])('%s can request; buyer is notified and audited', async (caller) => {
      const req = await service.create('SHIP-1', 0, dto(), caller, 'u1');
      expect(req).toMatchObject({ requestedBy: caller, previousDueAt: currentDue });
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        BUYER,
        NotificationType.DEADLINE_EXTENSION_REQUESTED,
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ requestId: 'r1' }),
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'milestone.extension.requested' }),
      );
    });

    it('buyer cannot request', async () => {
      await expect(service.create('SHIP-1', 0, dto(), BUYER)).rejects.toThrow(ForbiddenException);
    });

    it('second pending request returns 409', async () => {
      prisma.deadlineExtensionRequest.findFirst.mockResolvedValue({ id: 'r0' });
      await expect(service.create('SHIP-1', 0, dto(), SUPPLIER)).rejects.toThrow(ConflictException);
      expect(prisma.deadlineExtensionRequest.create).not.toHaveBeenCalled();
    });

    it('maps a unique-index race to 409', async () => {
      prisma.deadlineExtensionRequest.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      );
      await expect(service.create('SHIP-1', 0, dto(), SUPPLIER)).rejects.toThrow(ConflictException);
    });

    it('rejects a date not later than the current dueAt', async () => {
      const earlier = new Date(currentDue.getTime() - 1000).toISOString();
      await expect(
        service.create('SHIP-1', 0, { proposedDueAt: earlier, reason: 'x' }, SUPPLIER),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a past date', async () => {
      prisma.milestone.findFirst.mockResolvedValue(milestone({ dueAt: null }));
      await expect(
        service.create('SHIP-1', 0, { proposedDueAt: new Date(Date.now() - DAY).toISOString(), reason: 'x' }, SUPPLIER),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects on a confirmed milestone', async () => {
      prisma.milestone.findFirst.mockResolvedValue(milestone({ status: MilestoneStatus.CONFIRMED }));
      await expect(service.create('SHIP-1', 0, dto(), SUPPLIER)).rejects.toThrow(ConflictException);
    });
  });

  describe('approve / deny', () => {
    beforeEach(() => {
      prisma.deadlineExtensionRequest.findFirst.mockResolvedValue(pendingRequest());
    });

    it('approve updates dueAt and clears overdue reminder flags', async () => {
      const result = await service.approve('SHIP-1', 0, 'r1', {}, BUYER, 'u1');

      expect(prisma.milestone.update).toHaveBeenCalledWith({
        where: { id: 'm0' },
        data: { dueAt: proposedDue, overdueNotifiedAt: null, overdueReminder3dAt: null },
      });
      expect(prisma.deadlineExtensionRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'r1', status: ExtensionRequestStatus.PENDING },
        data: { status: ExtensionRequestStatus.APPROVED, decidedAt: expect.any(Date), decidedBy: BUYER },
      });
      expect(result.status).toBe(ExtensionRequestStatus.APPROVED);
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        SUPPLIER,
        NotificationType.DEADLINE_EXTENSION_DECIDED,
        'Deadline extension approved',
        expect.any(String),
        expect.objectContaining({ status: ExtensionRequestStatus.APPROVED }),
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'milestone.extension.approved' }),
      );
    });

    it('deny leaves dueAt unchanged', async () => {
      const result = await service.deny('SHIP-1', 0, 'r1', { note: 'No' }, BUYER);
      expect(prisma.milestone.update).not.toHaveBeenCalled();
      expect(result.status).toBe(ExtensionRequestStatus.DENIED);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'milestone.extension.denied' }),
      );
    });

    it.each([SUPPLIER, LOGISTICS])('%s cannot decide', async (caller) => {
      await expect(service.approve('SHIP-1', 0, 'r1', {}, caller)).rejects.toThrow(ForbiddenException);
    });

    it('cannot decide an already-decided request', async () => {
      prisma.deadlineExtensionRequest.findFirst.mockResolvedValue(
        pendingRequest({ status: ExtensionRequestStatus.DENIED }),
      );
      await expect(service.approve('SHIP-1', 0, 'r1', {}, BUYER)).rejects.toThrow(ConflictException);
    });

    it('concurrent decision losing the race returns 409', async () => {
      prisma.deadlineExtensionRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.deny('SHIP-1', 0, 'r1', {}, BUYER)).rejects.toThrow(ConflictException);
    });
  });

  it('list returns full history newest first', async () => {
    await service.list('SHIP-1', 0);
    expect(prisma.deadlineExtensionRequest.findMany).toHaveBeenCalledWith({
      where: { milestoneId: 'm0' },
      orderBy: { createdAt: 'desc' },
    });
  });
});
