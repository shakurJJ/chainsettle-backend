import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FxRateService } from './fx-rate.service';
import { RedisService } from '../redis/redis.service';
import { TokenRegistryService } from '../token-registry/token-registry.service';
import { CircuitOpenError } from '../utils/circuit-breaker';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('FxRateService', () => {
  let service: FxRateService;
  let redisService: jest.Mocked<RedisService>;
  let tokenRegistry: jest.Mocked<TokenRegistryService>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    const redis = {
      getJson: jest.fn(),
      setJson: jest.fn(),
    };

    const tokenReg = {
      listTokens: jest.fn().mockReturnValue([
        { symbol: 'USDC', decimals: 7 },
        { symbol: 'XLM', decimals: 7 },
      ]),
    };

    const config = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const configMap: Record<string, any> = {
          FX_RATE_CACHE_TTL_SECONDS: 300,
          FX_RATE_API_URL: 'https://api.fx.test/rates',
          FX_STALE_AFTER_MINUTES: 10,
          FX_BREAKER_FAILURE_THRESHOLD: 5,
          FX_BREAKER_COOLDOWN_SECONDS: 60,
        };
        return configMap[key] ?? defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FxRateService,
        { provide: RedisService, useValue: redis },
        { provide: TokenRegistryService, useValue: tokenReg },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<FxRateService>(FxRateService);
    redisService = module.get(RedisService) as jest.Mocked<RedisService>;
    tokenRegistry = module.get(TokenRegistryService) as jest.Mocked<TokenRegistryService>;
    configService = module.get(ConfigService) as jest.Mocked<ConfigService>;
    jest.clearAllMocks();
  });

  describe('rate fetch and Redis caching', () => {
    it('returns cached rate when available', async () => {
      const cachedRate = { rate: 1.05, asOf: '2026-10-22T10:00:00.000Z' };
      redisService.getJson.mockResolvedValue(cachedRate);

      const result = await service.getUsdRate('USDC');

      expect(result).toEqual(cachedRate);
      expect(redisService.getJson).toHaveBeenCalledWith('fx:rate:USDC');
    });

    it('returns null when no rate cached and no fallback', async () => {
      redisService.getJson.mockResolvedValue(null);

      const result = await service.getUsdRate('USDC');

      expect(result).toBeNull();
    });

    it('stores fetched rate in Redis with TTL and last-known copy', async () => {
      mockedAxios.get.mockResolvedValue({ data: { rate: 1.02 } });
      redisService.setJson.mockResolvedValue(undefined);

      await service.refreshAllRates();

      // Should store both fresh and last-known copies
      expect(redisService.setJson).toHaveBeenCalledWith(
        'fx:rate:USDC',
        expect.objectContaining({ rate: 1.02 }),
        300,
      );
      expect(redisService.setJson).toHaveBeenCalledWith(
        'fx:rate:USDC:last',
        expect.objectContaining({ rate: 1.02 }),
      );
    });

    it('fetches USD to fiat rate and caches it', async () => {
      mockedAxios.get.mockResolvedValue({ data: { rate: 0.92 } });
      redisService.setJson.mockResolvedValue(undefined);

      await service.refreshFiatRates();

      // Should fetch EUR, GBP, NGN, etc.
      expect(mockedAxios.get).toHaveBeenCalled();
      expect(redisService.setJson).toHaveBeenCalledWith(
        expect.stringContaining('fx:fiat:'),
        expect.objectContaining({ rate: expect.any(Number) }),
        300,
      );
    });
  });

  describe('fallback when provider fails', () => {
    it('returns last-known rate marked stale when fresh cache expired', async () => {
      const staleRate = { rate: 0.99, asOf: '2026-10-21T10:00:00.000Z' };
      redisService.getJson
        .mockResolvedValueOnce(null) // fresh cache miss
        .mockResolvedValueOnce(staleRate); // last-known hit

      const result = await service.getUsdRate('USDC');

      expect(result).toEqual({ ...staleRate, stale: true });
    });

    it('continues serving stale rate when provider fails repeatedly', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Network timeout'));
      const lastKnown = { rate: 1.01, asOf: '2026-10-20T10:00:00.000Z' };
      redisService.getJson
        .mockResolvedValueOnce(null) // fresh cache miss
        .mockResolvedValueOnce(lastKnown); // last-known hit

      // Attempt refresh (will fail but not throw)
      await service.refreshAllRates();

      // Should still return last-known rate
      const result = await service.getUsdRate('USDC');
      expect(result).toEqual({ ...lastKnown, stale: true });
    });

    it('skips fetch when circuit breaker is open', async () => {
      // Force circuit open by exceeding failure threshold
      mockedAxios.get.mockRejectedValue(new Error('Fail'));
      for (let i = 0; i < 5; i++) {
        await service.refreshAllRates();
      }

      mockedAxios.get.mockClear();

      // Next call should skip due to open circuit
      await service.refreshAllRates();

      // Circuit open means no axios call
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('returns null when provider not configured', async () => {
      configService.get.mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'FX_RATE_API_URL') return undefined;
        return defaultValue;
      });

      // Create new service instance with no API URL
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FxRateService,
          { provide: RedisService, useValue: redisService },
          { provide: TokenRegistryService, useValue: tokenRegistry },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();

      const unconfiguredService = module.get<FxRateService>(FxRateService);

      await unconfiguredService.refreshAllRates();

      // Should not attempt any fetches
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });

  describe('display precision rounding', () => {
    it('rounds USD to 2 decimals by default', () => {
      const result = service.formatValue(10.5, 1.23456, 'USD');
      expect(result).toBe(12.96); // 10.5 * 1.23456 = 12.96288 → 12.96
    });

    it('rounds JPY to 0 decimals (zero-decimal currency)', () => {
      const result = service.formatValue(10.5, 150.7823, 'JPY');
      expect(result).toBe(1583); // 10.5 * 150.7823 = 1583.21415 → 1583
    });

    it('rounds BHD to 3 decimals (four-decimal currency)', () => {
      const result = service.formatValue(10.5, 0.37712, 'BHD');
      expect(result).toBe(3.96); // 10.5 * 0.37712 = 3.95976 → 3.960
    });

    it('respects precision override', () => {
      const result = service.formatValue(10.5, 1.23456, 'USD', 4);
      expect(result).toBe(12.9629); // 10.5 * 1.23456 = 12.96288 → 12.9629
    });

    it('returns correct precision for each supported currency', () => {
      expect(service.getDisplayPrecision('USD')).toBe(2);
      expect(service.getDisplayPrecision('JPY')).toBe(0);
      expect(service.getDisplayPrecision('KRW')).toBe(0);
      expect(service.getDisplayPrecision('BHD')).toBe(3);
      expect(service.getDisplayPrecision('EUR')).toBe(2); // Default
    });
  });

  describe('convertForDisplay', () => {
    it('converts token amount to display currency', async () => {
      const tokenRate = { rate: 1.0, asOf: '2026-10-22T10:00:00.000Z' };
      const fiatRate = { rate: 0.92, asOf: '2026-10-22T10:00:00.000Z' };

      redisService.getJson
        .mockResolvedValueOnce(tokenRate) // USDC rate
        .mockResolvedValueOnce(fiatRate); // EUR rate

      const result = await service.convertForDisplay('USDC', 10000000n, 7, 'EUR');

      expect(result).toMatchObject({
        amount: 0.92, // 1.0 USDC * 1.0 USD/USDC * 0.92 EUR/USD
        currency: 'EUR',
        precision: 2,
      });
    });

    it('returns null when token rate unavailable', async () => {
      redisService.getJson.mockResolvedValue(null);

      const result = await service.convertForDisplay('USDC', 10000000n, 7, 'EUR');

      expect(result).toBeNull();
    });

    it('marks result stale when either rate is stale', async () => {
      const tokenRate = { rate: 1.0, asOf: '2026-10-22T10:00:00.000Z' };
      const staleRate = { rate: 0.92, asOf: '2026-10-22T10:00:00.000Z', stale: true };

      redisService.getJson
        .mockResolvedValueOnce(tokenRate)
        .mockResolvedValueOnce(staleRate);

      const result = await service.convertForDisplay('USDC', 10000000n, 7, 'EUR');

      expect(result?.stale).toBe(true);
    });

    it('returns 1.0 rate for USD (no conversion)', async () => {
      const usdRate = await service.getFiatRate('USD');

      expect(usdRate).toEqual({
        rate: 1,
        asOf: expect.any(String),
      });
    });
  });

  describe('getAllRateEntries', () => {
    it('returns entries for all registered tokens', async () => {
      const usdcRate = { rate: 1.02, asOf: '2026-10-22T10:00:00.000Z' };
      redisService.getJson
        .mockResolvedValueOnce(usdcRate) // USDC
        .mockResolvedValueOnce(null); // XLM (no rate)

      const entries = await service.getAllRateEntries();

      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        symbol: 'USDC',
        rate: 1.02,
        stale: false,
      });
      expect(entries[1]).toMatchObject({
        symbol: 'XLM',
        rate: null,
        stale: true,
      });
    });
  });

  describe('circuit breaker state', () => {
    it('returns breaker snapshot', () => {
      const snapshot = service.getBreakerState();

      expect(snapshot).toHaveProperty('isOpen');
      expect(snapshot).toHaveProperty('consecutiveFailures');
      expect(snapshot).toHaveProperty('lastFailureTime');
    });
  });
});
