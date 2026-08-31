import { Test, TestingModule } from '@nestjs/testing';
import { ChainController } from './chain.controller';
import { StellarService } from '../../common/stellar/stellar.service';
import { RedisService } from '../../common/redis/redis.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('ChainController', () => {
  let controller: ChainController;
  let stellarService: jest.Mocked<StellarService>;
  let redisService: jest.Mocked<RedisService>;

  beforeEach(async () => {
    const mockStellarService = {
      getTransactionEvents: jest.fn(),
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

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getTransactionEvents', () => {
    const validTxHash = 'a'.repeat(64);

    it('should throw BadRequestException if txHash is not a 64-character hex string', async () => {
      await expect(controller.getTransactionEvents('invalid-hash')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should call stellar.getTransactionEvents with valid txHash', async () => {
      const mockEvents = [{ id: '123' }];
      stellarService.getTransactionEvents.mockResolvedValue(mockEvents);

      const result = await controller.getTransactionEvents(validTxHash);
      expect(stellarService.getTransactionEvents).toHaveBeenCalledWith(validTxHash);
      expect(result).toEqual(mockEvents);
    });

    it('should propagate NotFoundException from stellar service', async () => {
      stellarService.getTransactionEvents.mockRejectedValue(new NotFoundException('Not found'));

      await expect(controller.getTransactionEvents(validTxHash)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
