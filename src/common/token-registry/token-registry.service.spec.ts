import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
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
          useValue: { contractExists: jest.fn().mockResolvedValue(true) },
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
});
