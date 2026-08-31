import { Test, TestingModule } from '@nestjs/testing';
import { ChainController } from './chain.controller';
import { StellarService } from '../../common/stellar/stellar.service';
import { RedisService } from '../../common/redis/redis.service';

describe('ChainController — getFees', () => {
  let controller: ChainController;
  let stellarService: jest.Mocked<StellarService>;
  let redisService: jest.Mocked<RedisService>;

  beforeEach(async () => {
    const mockStellarService = {
      getFeeStats: jest.fn(),
      getLedger: jest.fn(),
      getAccountInfo: jest.fn(),
      getNetworkStatus: jest.fn(),
    };

    const mockRedisService = {
      get: jest.fn(),
      set: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChainController],
      providers: [
        { provide: StellarService, useValue: mockStellarService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    controller = module.get<ChainController>(ChainController);
    stellarService = module.get(StellarService);
    redisService = module.get(RedisService);
  });

  it('should return cached fees if present in Redis', async () => {
    const mockCachedFees = { baseFee: 100, cached: true };
    redisService.get.mockResolvedValue(JSON.stringify(mockCachedFees));

    const result = await controller.getFees();

    expect(redisService.get).toHaveBeenCalledWith('chain:fees');
    expect(stellarService.getFeeStats).not.toHaveBeenCalled();
    expect(result).toEqual(mockCachedFees);
  });

  it('should call stellar.getFeeStats and cache the result if not present in Redis', async () => {
    redisService.get.mockResolvedValue(null);
    const mockFees = { baseFee: 100, sorobanInclusionFee: { p90: '500' } };
    stellarService.getFeeStats.mockResolvedValue(mockFees);

    const result = await controller.getFees();

    expect(redisService.get).toHaveBeenCalledWith('chain:fees');
    expect(stellarService.getFeeStats).toHaveBeenCalled();
    expect(redisService.set).toHaveBeenCalledWith('chain:fees', JSON.stringify(mockFees), 30);
    expect(result).toEqual(mockFees);
  });
});
