import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let mockPrisma: { user: { findUnique: jest.Mock } };

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
      },
    };

    const mockConfig = {
      get: jest.fn().mockReturnValue('test-secret'),
    } as unknown as ConfigService;

    strategy = new JwtStrategy(mockConfig, mockPrisma as unknown as PrismaService);
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
});
