import { ConflictException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-logs/audit-log.service';

describe('AuthService.deactivateUser', () => {
  let authService: AuthService;
  let mockPrisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    shipment: { count: jest.Mock };
  };
  let mockAuditLog: { record: jest.Mock };

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      shipment: {
        count: jest.fn(),
      },
    };

    mockAuditLog = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    authService = new AuthService(
      mockPrisma as unknown as PrismaService,
      {} as JwtService,
      {} as RedisService,
      {} as ConfigService,
      {} as NotificationsService,
      mockAuditLog as unknown as AuditLogService,
    );
  });

  it('soft-deactivates the user and writes USER_DEACTIVATED audit log', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stellarAddress: 'GTESTADDRESS',
      deactivatedAt: null,
    });
    mockPrisma.shipment.count.mockResolvedValue(0);
    mockPrisma.user.update.mockResolvedValue({});

    const result = await authService.deactivateUser('user-1');

    expect(result.message).toBe('Account deactivated successfully');
    expect(result.deactivatedAt).toBeInstanceOf(Date);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { deactivatedAt: expect.any(Date) },
    });
    expect(mockAuditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        actorAddress: 'GTESTADDRESS',
        action: 'USER_DEACTIVATED',
        resourceType: 'User',
        resourceId: 'user-1',
      }),
    );
  });

  it('returns 409 when the user has active shipments', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stellarAddress: 'GTESTADDRESS',
      deactivatedAt: null,
    });
    mockPrisma.shipment.count.mockResolvedValue(2);

    await expect(authService.deactivateUser('user-1')).rejects.toThrow(ConflictException);
    await expect(authService.deactivateUser('user-1')).rejects.toThrow(/active shipment/i);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockAuditLog.record).not.toHaveBeenCalled();
  });

  it('returns 409 when the account is already deactivated', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stellarAddress: 'GTESTADDRESS',
      deactivatedAt: new Date('2026-01-01'),
    });

    await expect(authService.deactivateUser('user-1')).rejects.toThrow(ConflictException);
    expect(mockPrisma.shipment.count).not.toHaveBeenCalled();
  });

  it('returns 404 when the user does not exist', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(authService.deactivateUser('missing')).rejects.toThrow(NotFoundException);
  });

  it('checks ACTIVE shipments for all participant roles', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stellarAddress: 'GTESTADDRESS',
      deactivatedAt: null,
    });
    mockPrisma.shipment.count.mockResolvedValue(0);
    mockPrisma.user.update.mockResolvedValue({});

    await authService.deactivateUser('user-1');

    expect(mockPrisma.shipment.count).toHaveBeenCalledWith({
      where: {
        status: 'ACTIVE',
        OR: [
          { buyerAddress: 'GTESTADDRESS' },
          { supplierAddress: 'GTESTADDRESS' },
          { logisticsAddress: 'GTESTADDRESS' },
          { arbiterAddress: 'GTESTADDRESS' },
        ],
      },
    });
  });
});
