import { Test, TestingModule } from '@nestjs/testing';
import { AdminHealthController, HealthController } from './health.controller';
import { HealthCheckService } from '@nestjs/terminus';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IpfsService } from '../../common/ipfs/ipfs.service';
import { RedisService } from '../../common/redis/redis.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { ConfigService } from '@nestjs/config';

describe('HealthController', () => {
  let controller: AdminHealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminHealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: { check: jest.fn().mockResolvedValue({ status: 'ok' }) },
        },
        {
          provide: PrismaService,
          useValue: { $queryRaw: jest.fn().mockResolvedValue([{ ok: true }]) },
        },
        {
          provide: IpfsService,
          useValue: { isHealthy: true },
        },
        {
          provide: RedisService,
          useValue: { getClient: jest.fn(() => ({ ping: jest.fn().mockResolvedValue('PONG') })) },
        },
        {
          provide: StellarService,
          useValue: { getClient: jest.fn(() => ({ getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }) })) },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string, defaultValue?: any) => defaultValue) },
        },
      ],
    }).compile();

    controller = module.get<AdminHealthController>(AdminHealthController);
  });

  it('returns a per-dependency admin summary without failing the whole endpoint', async () => {
    const result = await controller.dependenciesSummary();

    expect(result).toMatchObject({
      status: 'ok',
      dependencies: expect.any(Array),
    });
    expect(result.dependencies.some((dep: any) => dep.name === 'stellar-rpc')).toBe(true);
    expect(result.dependencies.some((dep: any) => dep.name === 'database')).toBe(true);
  });
});
