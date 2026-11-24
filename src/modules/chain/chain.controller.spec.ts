import { Test, TestingModule } from '@nestjs/testing';
import { ChainController } from './chain.controller';
import { StellarService } from '../../common/stellar/stellar.service';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { TxHashParamDto } from './tx-hash-param.dto';

const VALID_HASH = 'a'.repeat(64);

/** Minimal transaction shape returned by StellarService.getTransaction() */
const makeTxResult = (
  status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND',
  overrides: Record<string, unknown> = {},
) => ({
  hash: VALID_HASH,
  status,
  ledger: status !== 'NOT_FOUND' ? 42 : null,
  createdAt: status !== 'NOT_FOUND' ? '2024-01-01T00:00:00.000Z' : null,
  feeCharged: status !== 'NOT_FOUND' ? '100' : null,
  resultCode: null,
  envelopeXdr: null,
  resultXdr: null,
  events: [],
  ...overrides,
});

describe('ChainController', () => {
  let controller: ChainController;
  let stellarService: jest.Mocked<StellarService>;
  let redisService: jest.Mocked<RedisService>;
  let prismaService: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockStellarService = {
      getTransactionEvents: jest.fn(),
      getTransaction: jest.fn(),
      getFeeStats: jest.fn(),
      getLedger: jest.fn(),
      getAccountInfo: jest.fn(),
      getNetworkStatus: jest.fn(),
    };

    const mockRedisService = {
      get: jest.fn(),
      set: jest.fn(),
      getJson: jest.fn(),
      setJson: jest.fn(),
    };

    const mockPrismaService = {
      chainEvent: {
        findFirst: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChainController],
      providers: [
        { provide: StellarService, useValue: mockStellarService },
        { provide: RedisService, useValue: mockRedisService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    controller = module.get<ChainController>(ChainController);
    stellarService = module.get(StellarService);
    redisService = module.get(RedisService);
    prismaService = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ----------------------------------------------------------------
  // Existing route — getTransactionEvents
  // ----------------------------------------------------------------

  describe('getTransactionEvents', () => {
    it('should throw BadRequestException if txHash is not a 64-character hex string', async () => {
      await expect(controller.getTransactionEvents('invalid-hash')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should call stellar.getTransactionEvents with valid txHash', async () => {
      const mockEvents = [{ id: '123' }];
      stellarService.getTransactionEvents.mockResolvedValue(mockEvents);

      const result = await controller.getTransactionEvents(VALID_HASH);
      expect(stellarService.getTransactionEvents).toHaveBeenCalledWith(VALID_HASH);
      expect(result).toEqual(mockEvents);
    });

    it('should propagate NotFoundException from stellar service', async () => {
      stellarService.getTransactionEvents.mockRejectedValue(new NotFoundException('Not found'));

      await expect(controller.getTransactionEvents(VALID_HASH)).rejects.toThrow(NotFoundException);
    });
  });

  // ----------------------------------------------------------------
  // New route — getTransactionStatus  GET /chain/transactions/:hash
  // ----------------------------------------------------------------

  describe('getTransactionStatus', () => {
    beforeEach(() => {
      // Default: cache miss, no linked ChainEvent
      (redisService.getJson as jest.Mock).mockResolvedValue(null);
      (prismaService.chainEvent.findFirst as jest.Mock).mockResolvedValue(null);
    });

    describe('input validation — TxHashParamDto', () => {
      async function errorsFor(hash: string) {
        const dto = Object.assign(new TxHashParamDto(), { hash });
        return validate(dto);
      }

      it('rejects a hash that is too short', async () => {
        const errors = await errorsFor('abc123');
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].constraints).toMatchObject({
          matches: expect.stringContaining('64-character'),
        });
      });

      it('rejects a hash that contains non-hex characters', async () => {
        const errors = await errorsFor('z'.repeat(64));
        expect(errors.length).toBeGreaterThan(0);
      });

      it('accepts a valid 64-char lowercase hex hash', async () => {
        const errors = await errorsFor('a'.repeat(64));
        expect(errors.length).toBe(0);
      });

      it('accepts a valid 64-char mixed-case hex hash', async () => {
        const errors = await errorsFor('aAbBcCdD'.repeat(8));
        expect(errors.length).toBe(0);
      });
    });

    describe('cache hit', () => {
      it('returns the cached value without calling the RPC', async () => {
        const cached = makeTxResult('SUCCESS');
        (redisService.getJson as jest.Mock).mockResolvedValue(cached);

        const result = await controller.getTransactionStatus({ hash: VALID_HASH });

        expect(result).toEqual(cached);
        expect(stellarService.getTransaction).not.toHaveBeenCalled();
      });
    });

    describe('live RPC responses', () => {
      it('returns SUCCESS status and does NOT cache again', async () => {
        const tx = makeTxResult('SUCCESS');
        stellarService.getTransaction.mockResolvedValue(tx);

        const result = await controller.getTransactionStatus({ hash: VALID_HASH });

        expect(result.status).toBe('SUCCESS');
        expect(result.ledger).toBe(42);
        expect(redisService.setJson).toHaveBeenCalledWith(
          `chain:tx:${VALID_HASH}`,
          expect.objectContaining({ status: 'SUCCESS' }),
          86_400,
        );
      });

      it('returns FAILED status and caches with 24 h TTL', async () => {
        const tx = makeTxResult('FAILED');
        stellarService.getTransaction.mockResolvedValue(tx);

        const result = await controller.getTransactionStatus({ hash: VALID_HASH });

        expect(result.status).toBe('FAILED');
        expect(redisService.setJson).toHaveBeenCalledWith(
          `chain:tx:${VALID_HASH}`,
          expect.objectContaining({ status: 'FAILED' }),
          86_400,
        );
      });

      it('returns NOT_FOUND status and does NOT cache it', async () => {
        const tx = makeTxResult('NOT_FOUND');
        stellarService.getTransaction.mockResolvedValue(tx);

        const result = await controller.getTransactionStatus({ hash: VALID_HASH });

        expect(result.status).toBe('NOT_FOUND');
        expect(redisService.setJson).not.toHaveBeenCalled();
      });

      it('returns decoded contract events on SUCCESS', async () => {
        const events = [{ id: `${VALID_HASH}-0`, type: 'contract', topic: ['shipment_created'] }];
        const tx = makeTxResult('SUCCESS', { events });
        stellarService.getTransaction.mockResolvedValue(tx);

        const result = await controller.getTransactionStatus({ hash: VALID_HASH });

        expect(result.events).toEqual(events);
      });
    });

    describe('shipment linking', () => {
      it('includes shipmentId when a ChainEvent with the tx hash exists', async () => {
        const tx = makeTxResult('SUCCESS');
        stellarService.getTransaction.mockResolvedValue(tx);
        (prismaService.chainEvent.findFirst as jest.Mock).mockResolvedValue({
          shipmentId: 'shipment-uuid-001',
        });

        const result = await controller.getTransactionStatus({ hash: VALID_HASH });

        expect(result.shipmentId).toBe('shipment-uuid-001');
        expect(prismaService.chainEvent.findFirst).toHaveBeenCalledWith({
          where: { txHash: VALID_HASH },
          select: { shipmentId: true },
        });
      });

      it('sets shipmentId to null when no ChainEvent exists', async () => {
        const tx = makeTxResult('SUCCESS');
        stellarService.getTransaction.mockResolvedValue(tx);
        (prismaService.chainEvent.findFirst as jest.Mock).mockResolvedValue(null);

        const result = await controller.getTransactionStatus({ hash: VALID_HASH });

        expect(result.shipmentId).toBeNull();
      });

      it('sets shipmentId to null when ChainEvent has no shipmentId (system event)', async () => {
        const tx = makeTxResult('SUCCESS');
        stellarService.getTransaction.mockResolvedValue(tx);
        (prismaService.chainEvent.findFirst as jest.Mock).mockResolvedValue({ shipmentId: null });

        const result = await controller.getTransactionStatus({ hash: VALID_HASH });

        expect(result.shipmentId).toBeNull();
      });
    });

    describe('Redis cache key', () => {
      it('reads and writes using the chain:tx:<hash> key', async () => {
        const tx = makeTxResult('SUCCESS');
        stellarService.getTransaction.mockResolvedValue(tx);

        await controller.getTransactionStatus({ hash: VALID_HASH });

        expect(redisService.getJson).toHaveBeenCalledWith(`chain:tx:${VALID_HASH}`);
        expect(redisService.setJson).toHaveBeenCalledWith(
          `chain:tx:${VALID_HASH}`,
          expect.any(Object),
          86_400,
        );
      });
    });
  });
});
