import { NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { AdminUsersController } from './admin-users.controller';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ImpersonationGuard } from '../../common/guards/impersonation.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { BLOCK_IMPERSONATION_KEY } from '../../common/decorators/block-impersonation.decorator';

describe('Admin Force Logout', () => {
  let authService: AuthService;
  let mockPrisma: {
    user: { findUnique: jest.Mock };
    apiKey: { updateMany: jest.Mock };
  };
  let mockSessions: {
    revokeAllSessions: jest.Mock;
  };
  let mockAuditLog: {
    record: jest.Mock;
  };

  const adminUser = {
    id: 'admin-1',
    stellarAddress: 'GADMIN123',
    role: UserRole.ADMIN,
  };

  const targetUser = {
    id: 'user-to-logout',
    stellarAddress: 'GTARGET456',
    role: UserRole.BUYER,
  };

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
      },
      apiKey: {
        updateMany: jest.fn(),
      },
    };

    mockSessions = {
      revokeAllSessions: jest.fn(),
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
      mockSessions as unknown as SessionService,
    );
  });

  describe('AuthService.forceLogoutUser', () => {
    it('revokes all sessions without revoking API keys when revokeApiKeys is false or omitted', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(targetUser);
      mockSessions.revokeAllSessions.mockResolvedValue(3);

      const result = await authService.forceLogoutUser(
        targetUser.id,
        adminUser.id,
        adminUser.stellarAddress,
        { revokeApiKeys: false },
        '192.168.1.1',
      );

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: targetUser.id },
        select: { id: true, stellarAddress: true },
      });

      // Revokes all sessions for target user
      expect(mockSessions.revokeAllSessions).toHaveBeenCalledWith(
        targetUser.id,
        '',
        true,
      );

      // API keys must not be revoked
      expect(mockPrisma.apiKey.updateMany).not.toHaveBeenCalled();

      // Audit log must be recorded
      expect(mockAuditLog.record).toHaveBeenCalledWith({
        actorId: adminUser.id,
        actorAddress: adminUser.stellarAddress,
        action: 'ADMIN_FORCE_LOGOUT',
        resourceType: 'User',
        resourceId: targetUser.id,
        metadata: {
          targetUserId: targetUser.id,
          targetStellarAddress: targetUser.stellarAddress,
          revokedSessionsCount: 3,
          revokedApiKeysCount: 0,
          revokeApiKeys: false,
        },
        ipAddress: '192.168.1.1',
      });

      expect(result).toEqual({
        message: 'User force-logged out successfully',
        revokedSessionsCount: 3,
        revokedApiKeysCount: 0,
      });
    });

    it('revokes both sessions and active API keys when revokeApiKeys is true', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(targetUser);
      mockSessions.revokeAllSessions.mockResolvedValue(2);
      mockPrisma.apiKey.updateMany.mockResolvedValue({ count: 4 });

      const result = await authService.forceLogoutUser(
        targetUser.id,
        adminUser.id,
        adminUser.stellarAddress,
        { revokeApiKeys: true },
        '10.0.0.1',
      );

      expect(mockSessions.revokeAllSessions).toHaveBeenCalledWith(
        targetUser.id,
        '',
        true,
      );

      expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledWith({
        where: {
          userId: targetUser.id,
          revokedAt: null,
        },
        data: {
          revokedAt: expect.any(Date),
          gracePeriodEndsAt: null,
        },
      });

      expect(mockAuditLog.record).toHaveBeenCalledWith({
        actorId: adminUser.id,
        actorAddress: adminUser.stellarAddress,
        action: 'ADMIN_FORCE_LOGOUT',
        resourceType: 'User',
        resourceId: targetUser.id,
        metadata: {
          targetUserId: targetUser.id,
          targetStellarAddress: targetUser.stellarAddress,
          revokedSessionsCount: 2,
          revokedApiKeysCount: 4,
          revokeApiKeys: true,
        },
        ipAddress: '10.0.0.1',
      });

      expect(result).toEqual({
        message: 'User force-logged out successfully',
        revokedSessionsCount: 2,
        revokedApiKeysCount: 4,
      });
    });

    it('throws NotFoundException (404) when target user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        authService.forceLogoutUser(
          'non-existent-user',
          adminUser.id,
          adminUser.stellarAddress,
        ),
      ).rejects.toThrow(NotFoundException);

      expect(mockSessions.revokeAllSessions).not.toHaveBeenCalled();
      expect(mockPrisma.apiKey.updateMany).not.toHaveBeenCalled();
      expect(mockAuditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('AdminUsersController', () => {
    let controller: AdminUsersController;

    beforeEach(() => {
      controller = new AdminUsersController(authService);
    });

    it('invokes authService.forceLogoutUser with ip extracted from headers or socket', async () => {
      const spy = jest
        .spyOn(authService, 'forceLogoutUser')
        .mockResolvedValue({
          message: 'User force-logged out successfully',
          revokedSessionsCount: 1,
          revokedApiKeysCount: 0,
        });

      const fakeReq = {
        headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
        socket: {},
      } as any;

      const result = await controller.forceLogout(
        'target-id',
        adminUser,
        { revokeApiKeys: true },
        fakeReq,
      );

      expect(spy).toHaveBeenCalledWith(
        'target-id',
        adminUser.id,
        adminUser.stellarAddress,
        { revokeApiKeys: true },
        '203.0.113.195',
      );
      expect(result.revokedSessionsCount).toBe(1);
    });

    it('has @Roles(UserRole.ADMIN) decorator', () => {
      const reflector = new Reflector();
      const roles = reflector.get<UserRole[]>(
        ROLES_KEY,
        AdminUsersController.prototype.forceLogout,
      );
      expect(roles).toEqual([UserRole.ADMIN]);
    });

    it('is protected against impersonation via @BlockImpersonation', () => {
      const reflector = new Reflector();
      const blockedClass = reflector.get<boolean>(
        BLOCK_IMPERSONATION_KEY,
        AdminUsersController,
      );
      expect(blockedClass).toBe(true);
    });

    it('RolesGuard blocks non-admin users with 403', () => {
      const reflector = new Reflector();
      const rolesGuard = new RolesGuard(reflector);

      const mockExecutionContext = (role: UserRole) =>
        ({
          getHandler: () => AdminUsersController.prototype.forceLogout,
          getClass: () => AdminUsersController,
          switchToHttp: () => ({
            getRequest: () => ({ user: { id: 'u1', role } }),
          }),
        } as any);

      expect(rolesGuard.canActivate(mockExecutionContext(UserRole.ADMIN))).toBe(true);
      expect(rolesGuard.canActivate(mockExecutionContext(UserRole.BUYER))).toBe(false);
      expect(rolesGuard.canActivate(mockExecutionContext(UserRole.SUPPLIER))).toBe(false);
    });

    it('ImpersonationGuard blocks impersonated requests with 403', () => {
      const reflector = new Reflector();
      const impersonationGuard = new ImpersonationGuard(reflector);

      const mockExecutionContext = (isImpersonation: boolean) =>
        ({
          getHandler: () => AdminUsersController.prototype.forceLogout,
          getClass: () => AdminUsersController,
          switchToHttp: () => ({
            getRequest: () => ({ user: { id: 'admin-1', isImpersonation } }),
          }),
        } as any);

      expect(impersonationGuard.canActivate(mockExecutionContext(false))).toBe(true);
      expect(() => impersonationGuard.canActivate(mockExecutionContext(true))).toThrow(
        /This action is not allowed while impersonating another user/,
      );
    });
  });
});
