// Stub collaborators so the suite doesn't compile their (unrelated) module graphs.
jest.mock('../audit-logs/audit-log.service', () => ({
  AuditLogService: class {},
}));
jest.mock('../notifications/notifications.service', () => ({
  NotificationsService: class {},
}));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { KycStatus, NotificationType } from '@prisma/client';
import { KycReviewService } from './kyc-review.service';

describe('KycReviewService', () => {
  let prisma: any;
  let auditLog: any;
  let notifications: any;
  let service: KycReviewService;
  const admin = { id: 'admin-1', stellarAddress: 'GADMIN' };
  const pendingUser = {
    id: 'u1',
    stellarAddress: 'GUSER',
    kycStatus: KycStatus.PENDING,
    kycReference: 'ref-1',
  };

  beforeEach(() => {
    prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue(pendingUser),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    auditLog = { record: jest.fn() };
    notifications = { notifyUser: jest.fn() };
    service = new KycReviewService(prisma, auditLog, notifications);
  });

  describe('listQueue', () => {
    it('lists PENDING users oldest first and computes age', async () => {
      const now = new Date('2026-09-29T12:00:00Z');
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'a',
          kycSubmittedAt: new Date('2026-09-28T12:00:00Z'),
          createdAt: new Date('2026-01-01'),
        },
        {
          id: 'b',
          kycSubmittedAt: null,
          createdAt: new Date('2026-09-29T09:30:00Z'),
        },
      ]);
      prisma.user.count.mockResolvedValue(2);

      const res = await service.listQueue(KycStatus.PENDING, 1, 20, now);

      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        kycStatus: KycStatus.PENDING,
        deactivatedAt: null,
      });
      expect(args.orderBy[0]).toEqual({
        kycSubmittedAt: { sort: 'asc', nulls: 'first' },
      });
      expect(res.data.map((d: any) => d.ageHours)).toEqual([24, 2]);
      expect(res.total).toBe(2);
    });

    it('never selects email or raw document fields', async () => {
      await service.listQueue();
      const { select } = prisma.user.findMany.mock.calls[0][0];
      expect(select.email).toBeUndefined();
      expect(select.kycReference).toBe(true);
    });

    it('paginates', async () => {
      prisma.user.count.mockResolvedValue(41);
      const res = await service.listQueue(KycStatus.PENDING, 3, 20);
      expect(prisma.user.findMany.mock.calls[0][0]).toMatchObject({
        skip: 40,
        take: 20,
      });
      expect(res.totalPages).toBe(3);
    });
  });

  it('approves: updates status conditionally, audits and notifies', async () => {
    const res = await service.approve('u1', admin, 'docs ok');
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', kycStatus: KycStatus.PENDING },
      data: { kycStatus: KycStatus.VERIFIED },
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        actorAddress: 'GADMIN',
        action: 'KYC_MANUALLY_APPROVED',
        resourceId: 'u1',
        metadata: expect.objectContaining({
          reason: 'docs ok',
          newStatus: KycStatus.VERIFIED,
          kycReference: 'ref-1',
        }),
      }),
    );
    expect(notifications.notifyUser).toHaveBeenCalledWith(
      'GUSER',
      NotificationType.SYSTEM_ALERT,
      'Identity verification approved',
      expect.any(String),
      { kind: 'KYC_DECISION', kycStatus: KycStatus.VERIFIED },
    );
    expect(res).toEqual({ userId: 'u1', kycStatus: KycStatus.VERIFIED });
  });

  it('rejects with a reason that is audited and sent to the user', async () => {
    await service.reject('u1', admin, '  blurry ID  ');
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'KYC_MANUALLY_REJECTED',
        metadata: expect.objectContaining({ reason: 'blurry ID' }),
      }),
    );
    expect(notifications.notifyUser.mock.calls[0][3]).toContain('blurry ID');
  });

  it('404s for unknown users', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.approve('x', admin)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to review a case that is not PENDING', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...pendingUser,
      kycStatus: KycStatus.VERIFIED,
    });
    await expect(service.reject('u1', admin, 'x')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('refuses when another admin decided the case concurrently', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.approve('u1', admin)).rejects.toBeInstanceOf(ConflictException);
    expect(auditLog.record).not.toHaveBeenCalled();
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  it('keeps the decision when notification fails', async () => {
    notifications.notifyUser.mockRejectedValue(new Error('smtp down'));
    await expect(service.approve('u1', admin)).resolves.toEqual({
      userId: 'u1',
      kycStatus: KycStatus.VERIFIED,
    });
    expect(auditLog.record).toHaveBeenCalled();
  });
});
