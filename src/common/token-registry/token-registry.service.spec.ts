import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TokenRegistryService } from './token-registry.service';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { RedisService } from '../redis/redis.service';
import { AuditLogService } from '../../modules/audit-logs/audit-log.service';

describe('TokenRegistryService', () => {
  let service: TokenRegistryService;
  let prisma: { shipment: { count: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      shipment: {
        count: jest.fn().mockResolvedValue(0),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenRegistryService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string, fallback?: any) => fallback ?? undefined) },
        },
        {
          provide: StellarService,
          useValue: {
            contractExists: jest.fn().mockResolvedValue(true),
            toHumanAmount: jest.fn((amount: bigint | string, decimals: number) => {
              const value = BigInt(amount);
              const divisor = BigInt(10 ** decimals);
              return `${value / divisor}.${(value % divisor).toString().padStart(decimals, '0')}`;
            }),
          },
        },
        {
          provide: RedisService,
          useValue: { del: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: AuditLogService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<TokenRegistryService>(TokenRegistryService);
  });

  it('disables a token without deleting it from the registry', async () => {
    const address = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

    const result = await service.updateToken(address, { enabled: false });

    expect(result.enabled).toBe(false);
    expect(service.isEnabled(address)).toBe(false);
    expect(service.findByAddress(address)).toMatchObject({ address, symbol: 'USDC' });
  });

  it('rejects decimals changes once shipments already reference the token', async () => {
    const address = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
    prisma.shipment.count.mockResolvedValue(1);

    await expect(service.updateToken(address, { decimals: 9 })).rejects.toBeInstanceOf(ConflictException);
  });

  describe('per-token min/max shipment value (#304)', () => {
    const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

    it('accepts any value for tokens with no configured bounds', () => {
      expect(() => service.assertValueWithinBounds(USDC, 1n)).not.toThrow();
      expect(() => service.assertValueWithinBounds(USDC, 10n ** 30n)).not.toThrow();
      expect(service.findByAddress(USDC)).toMatchObject({ minValue: null, maxValue: null });
    });

    it('rejects a value below the configured minimum with a descriptive error', async () => {
      await service.updateToken(USDC, { minValue: '10000000' });

      expect(() => service.assertValueWithinBounds(USDC, 9_999_999n)).toThrow(BadRequestException);
      expect(() => service.assertValueWithinBounds(USDC, 9_999_999n)).toThrow(
        /below the minimum of 1\.0000000 USDC/,
      );
      expect(() => service.assertValueWithinBounds(USDC, 10_000_000n)).not.toThrow();
    });

    it('rejects a value above the configured maximum with a descriptive error', async () => {
      await service.updateToken(USDC, { maxValue: '1000000000' });

      expect(() => service.assertValueWithinBounds(USDC, 1_000_000_001n)).toThrow(
        /above the maximum of 100\.0000000 USDC/,
      );
      expect(() => service.assertValueWithinBounds(USDC, 1_000_000_000n)).not.toThrow();
    });

    it('clears a bound when updated to null', async () => {
      await service.updateToken(USDC, { minValue: '10000000' });
      await service.updateToken(USDC, { minValue: null });

      expect(() => service.assertValueWithinBounds(USDC, 1n)).not.toThrow();
    });

    it('rejects minValue greater than maxValue', async () => {
      await expect(service.updateToken(USDC, { minValue: '10', maxValue: '5' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('stores bounds passed at registration', async () => {
      const address = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const token = await service.registerToken({ address, symbol: 'TST', decimals: 7, minValue: '100', maxValue: '200' });

      expect(token).toMatchObject({ minValue: '100', maxValue: '200' });
      expect(() => service.assertValueWithinBounds(address, 99n)).toThrow(BadRequestException);
    });
  });
});
