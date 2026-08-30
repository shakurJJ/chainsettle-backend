import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SessionService } from './session.service';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let mockPrisma: { user: { findUnique: jest.Mock } };
  let mockSessions: jest.Mocked<SessionService>;

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
      },
    };

    const mockConfig = {
      get: jest.fn().mockReturnValue('test-secret'),
    } as unknown as ConfigService;

    mockSessions = {
      isBlocked: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<SessionService>;

    strategy = new JwtStrategy(mockConfig, mockPrisma as unknown as PrismaService, mockSessions);
  });

  it('returns user identity when account is active', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stellarAddress: 'GTEST',
      role: 'BUYER',
      deactivatedAt: null,
    });

    const result = await strategy.validate({ sub: 'user-1' });

    expect(result).toEqual({
      id: 'user-1',
      stellarAddress: 'GTEST',
      role: 'BUYER',
      isImpersonation: false,
      impersonatorAdminId: undefined,
      impersonatorAddress: undefined,
      jti: undefined,
      exp: undefined,
    });
  });

  it('returns impersonation context when token is tagged', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-1',
        stellarAddress: 'GTEST',
        role: 'BUYER',
        deactivatedAt: null,
      })
      .mockResolvedValueOnce({
        id: 'admin-1',
        stellarAddress: 'GADMIN',
        role: 'ADMIN',
        deactivatedAt: null,
      });

    const result = await strategy.validate({
      sub: 'user-1',
      isImpersonation: true,
      impersonatorAdminId: 'admin-1',
      impersonatorAddress: 'GADMIN',
    });

    expect(result).toEqual({
      id: 'user-1',
      stellarAddress: 'GTEST',
      role: 'BUYER',
      isImpersonation: true,
      impersonatorAdminId: 'admin-1',
      impersonatorAddress: 'GADMIN',
      jti: undefined,
      exp: undefined,
    });
  });

  it('rejects tokens for deactivated users with 401', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stellarAddress: 'GTEST',
      role: 'BUYER',
      deactivatedAt: new Date('2026-01-01'),
    });

    await expect(strategy.validate({ sub: 'user-1' })).rejects.toThrow(UnauthorizedException);
    await expect(strategy.validate({ sub: 'user-1' })).rejects.toThrow(
      'Account has been deactivated',
    );
  });

  it('rejects tokens when user is not found', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(strategy.validate({ sub: 'missing' })).rejects.toThrow(UnauthorizedException);
  });

  it('rejects blocked (logged-out) tokens', async () => {
    mockSessions.isBlocked.mockResolvedValue(true);

    await expect(strategy.validate({ sub: 'user-1', jti: 'revoked-session' })).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(strategy.validate({ sub: 'user-1', jti: 'revoked-session' })).rejects.toThrow(
      'Token has been revoked',
    );
  });
});
