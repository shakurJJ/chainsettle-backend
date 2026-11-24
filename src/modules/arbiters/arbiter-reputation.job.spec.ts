import { Test, TestingModule } from '@nestjs/testing';
import { ArbiterReputationJob } from './arbiter-reputation.job';
import { ArbitersService } from './arbiters.service';

describe('ArbiterReputationJob', () => {
  let job: ArbiterReputationJob;
  let arbitersService: ArbitersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArbiterReputationJob,
        {
          provide: ArbitersService,
          useValue: {
            listKnownArbiterAddresses: jest.fn(),
            recompute: jest.fn(),
          },
        },
      ],
    }).compile();

    job = module.get<ArbiterReputationJob>(ArbiterReputationJob);
    arbitersService = module.get<ArbitersService>(ArbitersService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('recomputeAll', () => {
    it('should list known arbiter addresses', async () => {
      const listSpy = jest.spyOn(arbitersService, 'listKnownArbiterAddresses').mockResolvedValue([]);

      await job.recomputeAll();

      expect(listSpy).toHaveBeenCalledTimes(1);
    });

    it('should not recompute when no arbiters exist', async () => {
      jest.spyOn(arbitersService, 'listKnownArbiterAddresses').mockResolvedValue([]);
      const recomputeSpy = jest.spyOn(arbitersService, 'recompute');

      await job.recomputeAll();

      expect(recomputeSpy).not.toHaveBeenCalled();
    });

    it('should recompute reputation for each known arbiter', async () => {
      const addresses = ['GARBITER1', 'GARBITER2', 'GARBITER3'];
      jest.spyOn(arbitersService, 'listKnownArbiterAddresses').mockResolvedValue(addresses);
      const recomputeSpy = jest.spyOn(arbitersService, 'recompute').mockResolvedValue({
        arbiterAddress: 'GARBITER1',
        disputesHandled: 5,
        disputesOpen: 2,
        averageResolutionTimeHours: 12.5,
        hasHistory: true,
        computedAt: new Date().toISOString(),
      });

      await job.recomputeAll();

      expect(recomputeSpy).toHaveBeenCalledTimes(3);
      expect(recomputeSpy).toHaveBeenCalledWith('GARBITER1');
      expect(recomputeSpy).toHaveBeenCalledWith('GARBITER2');
      expect(recomputeSpy).toHaveBeenCalledWith('GARBITER3');
    });

    it('should log the number of arbiters being processed', async () => {
      const addresses = ['GARBITER1', 'GARBITER2'];
      jest.spyOn(arbitersService, 'listKnownArbiterAddresses').mockResolvedValue(addresses);
      jest.spyOn(arbitersService, 'recompute').mockResolvedValue({
        arbiterAddress: 'GARBITER1',
        disputesHandled: 0,
        disputesOpen: 0,
        averageResolutionTimeHours: null,
        hasHistory: false,
        computedAt: new Date().toISOString(),
      });

      const loggerSpy = jest.spyOn(job['logger'], 'log');

      await job.recomputeAll();

      expect(loggerSpy).toHaveBeenCalledWith('Recomputing reputation for 2 arbiter(s)');
    });

    it('should continue processing remaining arbiters if one fails', async () => {
      const addresses = ['GARBITER1', 'GARBITER2', 'GARBITER3'];
      jest.spyOn(arbitersService, 'listKnownArbiterAddresses').mockResolvedValue(addresses);

      const recomputeSpy = jest
        .spyOn(arbitersService, 'recompute')
        .mockResolvedValueOnce({
          arbiterAddress: 'GARBITER1',
          disputesHandled: 1,
          disputesOpen: 0,
          averageResolutionTimeHours: 10,
          hasHistory: true,
          computedAt: new Date().toISOString(),
        })
        .mockRejectedValueOnce(new Error('Database connection lost'))
        .mockResolvedValueOnce({
          arbiterAddress: 'GARBITER3',
          disputesHandled: 3,
          disputesOpen: 1,
          averageResolutionTimeHours: 15,
          hasHistory: true,
          computedAt: new Date().toISOString(),
        });

      await job.recomputeAll();

      expect(recomputeSpy).toHaveBeenCalledTimes(3);
    });

    it('should log errors for failed recomputations without throwing', async () => {
      const addresses = ['GARBITER_FAIL'];
      const error = new Error('Redis timeout');

      jest.spyOn(arbitersService, 'listKnownArbiterAddresses').mockResolvedValue(addresses);
      jest.spyOn(arbitersService, 'recompute').mockRejectedValue(error);
      const errorLogSpy = jest.spyOn(job['logger'], 'error');

      await job.recomputeAll();

      expect(errorLogSpy).toHaveBeenCalledWith(
        'Failed to recompute reputation for arbiter GARBITER_FAIL: Redis timeout',
      );
    });

    it('should handle a mix of successful and failed recomputations', async () => {
      const addresses = ['GARBITER_OK', 'GARBITER_FAIL_1', 'GARBITER_FAIL_2', 'GARBITER_OK_2'];

      jest.spyOn(arbitersService, 'listKnownArbiterAddresses').mockResolvedValue(addresses);
      const recomputeSpy = jest
        .spyOn(arbitersService, 'recompute')
        .mockResolvedValueOnce({
          arbiterAddress: 'GARBITER_OK',
          disputesHandled: 2,
          disputesOpen: 0,
          averageResolutionTimeHours: 8,
          hasHistory: true,
          computedAt: new Date().toISOString(),
        })
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce({
          arbiterAddress: 'GARBITER_OK_2',
          disputesHandled: 7,
          disputesOpen: 1,
          averageResolutionTimeHours: 20,
          hasHistory: true,
          computedAt: new Date().toISOString(),
        });

      const errorLogSpy = jest.spyOn(job['logger'], 'error');

      await job.recomputeAll();

      expect(recomputeSpy).toHaveBeenCalledTimes(4);
      expect(errorLogSpy).toHaveBeenCalledTimes(2);
      expect(errorLogSpy).toHaveBeenCalledWith(
        'Failed to recompute reputation for arbiter GARBITER_FAIL_1: Network error',
      );
      expect(errorLogSpy).toHaveBeenCalledWith(
        'Failed to recompute reputation for arbiter GARBITER_FAIL_2: Timeout',
      );
    });

    it('should process arbiters sequentially in the order returned by listKnownArbiterAddresses', async () => {
      const addresses = ['GARBITER_A', 'GARBITER_B', 'GARBITER_C'];
      const callOrder: string[] = [];

      jest.spyOn(arbitersService, 'listKnownArbiterAddresses').mockResolvedValue(addresses);
      jest.spyOn(arbitersService, 'recompute').mockImplementation(async (address: string) => {
        callOrder.push(address);
        return {
          arbiterAddress: address,
          disputesHandled: 0,
          disputesOpen: 0,
          averageResolutionTimeHours: null,
          hasHistory: false,
          computedAt: new Date().toISOString(),
        };
      });

      await job.recomputeAll();

      expect(callOrder).toEqual(['GARBITER_A', 'GARBITER_B', 'GARBITER_C']);
    });

    it('should handle empty error messages gracefully', async () => {
      const addresses = ['GARBITER_ERROR'];
      const errorWithoutMessage = new Error();
      errorWithoutMessage.message = '';

      jest.spyOn(arbitersService, 'listKnownArbiterAddresses').mockResolvedValue(addresses);
      jest.spyOn(arbitersService, 'recompute').mockRejectedValue(errorWithoutMessage);
      const errorLogSpy = jest.spyOn(job['logger'], 'error');

      await job.recomputeAll();

      expect(errorLogSpy).toHaveBeenCalledWith(
        'Failed to recompute reputation for arbiter GARBITER_ERROR: ',
      );
    });

    it('should complete successfully when all recomputations succeed', async () => {
      const addresses = ['GARBITER1', 'GARBITER2'];
      jest.spyOn(arbitersService, 'listKnownArbiterAddresses').mockResolvedValue(addresses);
      jest.spyOn(arbitersService, 'recompute').mockResolvedValue({
        arbiterAddress: 'GARBITER1',
        disputesHandled: 4,
        disputesOpen: 1,
        averageResolutionTimeHours: 14.2,
        hasHistory: true,
        computedAt: new Date().toISOString(),
      });

      const errorLogSpy = jest.spyOn(job['logger'], 'error');

      await job.recomputeAll();

      expect(errorLogSpy).not.toHaveBeenCalled();
    });
  });
});
