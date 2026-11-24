import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { UsersController } from './users.controller';
import { SessionService } from './session.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { maskIpAddress } from '../../common/utils/ip.util';

describe('Login History & Sign-in Tracking', () => {
  let authService: AuthService;
  let usersController: UsersController;
  let mockPrisma: {
    user: { findUnique: jest.Mock; upsert: jest.Mock };
    auditLog: { findMany: jest.Mock };
  };
  let mockJwt: { sign: jest.Mock };
  let mockRedis: { get: jest.Mock; del: jest.Mock; setPx: jest.Mock };
  let mockSessions: { registerSession: jest.Mock };
  let mockAuditLog: { record: jest.Mock };

  const userId = 'user-uuid-1';
  const stellarAddress = 'GBZXN7PIRZGNMHGA728RGRTDG2Y52GBJ24773KN4275EAEOT45CQ25EQ';
  const targetUser = {
    id: userId,
    stellarAddress,
    role: UserRole.BUYER,
  };

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      auditLog: {
        findMany: jest.fn(),
      },
    };

    mockJwt = {
      sign: jest.fn().mockReturnValue('mock-jwt-token'),
    };

    mockRedis = {
      get: jest.fn(),
      del: jest.fn(),
      setPx: jest.fn(),
    };

    mockSessions = {
      registerSession: jest.fn().mockResolvedValue(undefined),
    };

    mockAuditLog = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    authService = new AuthService(
      mockPrisma as unknown as PrismaService,
      mockJwt as unknown as JwtService,
      mockRedis as unknown as RedisService,
      {} as ConfigService,
      {} as NotificationsService,
      mockAuditLog as unknown as AuditLogService,
      mockSessions as unknown as SessionService,
    );

    usersController = new UsersController(
      authService,
      mockSessions as unknown as SessionService,
      mockAuditLog as unknown as AuditLogService,
      {} as NotificationsService,
    );
  });

  describe('maskIpAddress', () => {
    it('masks the last octet of standard IPv4 addresses', () => {
      expect(maskIpAddress('192.168.1.42')).toBe('192.168.1.xxx');
      expect(maskIpAddress('10.0.0.1')).toBe('10.0.0.xxx');
      expect(maskIpAddress('203.0.113.195')).toBe('203.0.113.xxx');
    });

    it('masks the last octet of IPv4-mapped IPv6 addresses', () => {
      expect(maskIpAddress('::ffff:192.168.1.42')).toBe('::ffff:192.168.1.xxx');
    });

    it('preserves native IPv6 addresses unchanged', () => {
      expect(maskIpAddress('2001:db8::1')).toBe('2001:db8::1');
    });

    it('handles null, undefined, or empty values safely', () => {
      expect(maskIpAddress(null)).toBeNull();
      expect(maskIpAddress(undefined)).toBeNull();
      expect(maskIpAddress('')).toBeNull();
      expect(maskIpAddress('   ')).toBeNull();
    });

    it('returns original string if format is not standard IPv4', () => {
      expect(maskIpAddress('unknown')).toBe('unknown');
    });
  });

  describe('Login audit logging in AuthService.login', () => {
    it('records LOGIN_SUCCESS audit log with IP, userAgent, and sessionId on successful login', async () => {
      const keypair = Keypair.random();
      const kpAddress = keypair.publicKey();
      const nonce = 'random-challenge-nonce';
      const signature = keypair.sign(Buffer.from(nonce)).toString('base64');

      mockRedis.get.mockResolvedValue(nonce);
      mockPrisma.user.upsert.mockResolvedValue({
        id: 'user-success-id',
        stellarAddress: kpAddress,
        role: UserRole.BUYER,
      });

      const result = await authService.login(
        {
          stellarAddress: kpAddress,
          signedNonce: nonce,
          signature,
        },
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        '192.168.1.55',
      );

      expect(result.accessToken).toBe('mock-jwt-token');
      expect(mockAuditLog.record).toHaveBeenCalledWith({
        actorId: 'user-success-id',
        actorAddress: kpAddress,
        action: 'LOGIN_SUCCESS',
        resourceType: 'User',
        resourceId: 'user-success-id',
        metadata: {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          sessionId: expect.any(String),
        },
        ipAddress: '192.168.1.55',
      });
    });

    it('records LOGIN_FAILED audit log for known user when signature verification fails', async () => {
      const keypair = Keypair.random();
      const kpAddress = keypair.publicKey();
      const nonce = 'random-challenge-nonce';
      // Bad signature (signed by a different keypair)
      const badKeypair = Keypair.random();
      const badSignature = badKeypair.sign(Buffer.from(nonce)).toString('base64');

      mockRedis.get.mockResolvedValue(nonce);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'known-user-id',
        stellarAddress: kpAddress,
      });

      await expect(
        authService.login(
          {
            stellarAddress: kpAddress,
            signedNonce: nonce,
            signature: badSignature,
          },
          'PostmanRuntime/7.29.0',
          '203.0.113.10',
        ),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { stellarAddress: kpAddress },
        select: { id: true, stellarAddress: true },
      });

      expect(mockAuditLog.record).toHaveBeenCalledWith({
        actorId: 'known-user-id',
        actorAddress: kpAddress,
        action: 'LOGIN_FAILED',
        resourceType: 'User',
        resourceId: 'known-user-id',
        metadata: {
          userAgent: 'PostmanRuntime/7.29.0',
          reason: 'Signature verification failed',
        },
        ipAddress: '203.0.113.10',
      });
    });

    it('does not record LOGIN_FAILED if user is not known in database', async () => {
      const keypair = Keypair.random();
      const kpAddress = keypair.publicKey();
      const nonce = 'random-challenge-nonce';
      const badKeypair = Keypair.random();
      const badSignature = badKeypair.sign(Buffer.from(nonce)).toString('base64');

      mockRedis.get.mockResolvedValue(nonce);
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        authService.login(
          {
            stellarAddress: kpAddress,
            signedNonce: nonce,
            signature: badSignature,
          },
          'curl/7.68.0',
          '10.0.0.99',
        ),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockAuditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('AuthService.getLoginHistory', () => {
    const mockLogs = [
      {
        id: 'log-1',
        userId,
        action: 'LOGIN_SUCCESS',
        ipAddress: '192.168.1.100',
        metadata: {
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          sessionId: 'current-jti-123',
        },
        createdAt: new Date('2026-03-30T10:00:00Z'),
      },
      {
        id: 'log-2',
        userId,
        action: 'LOGIN_FAILED',
        ipAddress: '203.0.113.50',
        metadata: {
          userAgent: 'curl/7.81.0',
          reason: 'Signature verification failed',
        },
        createdAt: new Date('2026-03-29T15:30:00Z'),
      },
      {
        id: 'log-3',
        userId,
        action: 'LOGIN_SUCCESS',
        ipAddress: '10.0.0.2',
        metadata: {
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
          sessionId: 'old-jti-456',
        },
        createdAt: new Date('2026-03-28T08:15:00Z'),
      },
    ];

    it('returns formatted login history records with masked IP addresses and current session flag', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue(mockLogs);

      const result = await authService.getLoginHistory(
        userId,
        'current-jti-123',
        undefined,
        20,
      );

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {
          userId,
          action: { in: ['LOGIN_SUCCESS', 'LOGIN_FAILED'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      expect(result.data).toHaveLength(3);

      // Item 1: Successful login & current session
      expect(result.data[0]).toEqual({
        id: 'log-1',
        timestamp: mockLogs[0].createdAt,
        ipAddress: '192.168.1.xxx',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        success: true,
        isCurrentSession: true,
      });

      // Item 2: Failed attempt
      expect(result.data[1]).toEqual({
        id: 'log-2',
        timestamp: mockLogs[1].createdAt,
        ipAddress: '203.0.113.xxx',
        userAgent: 'curl/7.81.0',
        success: false,
        isCurrentSession: false,
      });

      // Item 3: Older successful login (different session)
      expect(result.data[2]).toEqual({
        id: 'log-3',
        timestamp: mockLogs[2].createdAt,
        ipAddress: '10.0.0.xxx',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        success: true,
        isCurrentSession: false,
      });

      expect(result.meta.nextCursor).toBeNull();
      expect(result.meta.limit).toBe(20);
    });

    it('handles cursor pagination and produces nextCursor when limit is reached', async () => {
      // Mock page limit = 2
      mockPrisma.auditLog.findMany.mockResolvedValue([mockLogs[0], mockLogs[1]]);

      const result = await authService.getLoginHistory(
        userId,
        'current-jti-123',
        undefined,
        2,
      );

      expect(result.data).toHaveLength(2);
      expect(result.meta.nextCursor).toBeDefined();

      const decodedCursor = JSON.parse(
        Buffer.from(result.meta.nextCursor!, 'base64').toString('utf-8'),
      );
      expect(decodedCursor).toEqual({
        id: 'log-2',
        createdAt: mockLogs[1].createdAt.toISOString(),
      });

      // Second page with cursor
      mockPrisma.auditLog.findMany.mockResolvedValue([mockLogs[2]]);

      const secondPage = await authService.getLoginHistory(
        userId,
        'current-jti-123',
        result.meta.nextCursor!,
        2,
      );

      expect(mockPrisma.auditLog.findMany).toHaveBeenLastCalledWith({
        where: {
          userId,
          action: { in: ['LOGIN_SUCCESS', 'LOGIN_FAILED'] },
        },
        orderBy: { createdAt: 'desc' },
        cursor: { id: 'log-2' },
        skip: 1,
        take: 2,
      });

      expect(secondPage.data).toHaveLength(1);
      expect(secondPage.meta.nextCursor).toBeNull();
    });

    it('ensures queries are strictly scoped to the requesting user ID', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);

      await authService.getLoginHistory('other-user-456', undefined, undefined, 20);

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'other-user-456',
          }),
        }),
      );
    });
  });

  describe('UsersController.getLoginHistory', () => {
    it('delegates to authService.getLoginHistory with current user context', async () => {
      const spy = jest.spyOn(authService, 'getLoginHistory').mockResolvedValue({
        data: [],
        meta: { nextCursor: null, limit: 20 },
      });

      const currentUser = { id: 'user-789', jti: 'session-jti-xyz' };
      const queryDto = { cursor: 'abc', limit: 10 };

      const res = await usersController.getLoginHistory(currentUser, queryDto);

      expect(spy).toHaveBeenCalledWith('user-789', 'session-jti-xyz', 'abc', 10);
      expect(res).toEqual({
        data: [],
        meta: { nextCursor: null, limit: 20 },
      });
    });
  });
});
