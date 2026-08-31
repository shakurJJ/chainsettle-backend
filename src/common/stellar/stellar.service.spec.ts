import { StellarService } from './stellar.service';
import { ConfigService } from '@nestjs/config';

// StellarService.onModuleInit() calls the RPC — we skip that by never calling
// it; we only test the pure utility methods here.
function makeService(): StellarService {
  const config = { get: jest.fn() } as unknown as ConfigService;
  return new StellarService(config);
}

describe('StellarService — amount utilities', () => {
  let service: StellarService;

  beforeEach(() => {
    service = makeService();
  });

  // ------------------------------------------------------------------
  // toHumanAmount
  // ------------------------------------------------------------------

  describe('toHumanAmount()', () => {
    describe('7 decimal places (USDC / EURC)', () => {
      it('converts whole unit correctly', () => {
        expect(service.toHumanAmount(10_000_000n, 7)).toBe('1.0000000');
      });

      it('converts fractional amount correctly', () => {
        expect(service.toHumanAmount(15_000_000n, 7)).toBe('1.5000000');
      });

      it('pads leading zeros in the fractional part', () => {
        expect(service.toHumanAmount(100n, 7)).toBe('0.0000100');
      });

      it('handles zero', () => {
        expect(service.toHumanAmount(0n, 7)).toBe('0.0000000');
      });

      it('handles large amounts', () => {
        expect(service.toHumanAmount(1_000_000_000_000_000n, 7)).toBe('100000000.0000000');
      });

      it('accepts string input', () => {
        expect(service.toHumanAmount('10000000', 7)).toBe('1.0000000');
      });

      it('defaults to 7 decimals when argument is omitted', () => {
        expect(service.toHumanAmount(10_000_000n)).toBe('1.0000000');
      });
    });

    describe('6 decimal places (hypothetical token)', () => {
      it('converts whole unit correctly', () => {
        expect(service.toHumanAmount(1_000_000n, 6)).toBe('1.000000');
      });

      it('converts fractional amount correctly', () => {
        expect(service.toHumanAmount(1_500_000n, 6)).toBe('1.500000');
      });

      it('pads leading zeros in the fractional part', () => {
        expect(service.toHumanAmount(100n, 6)).toBe('0.000100');
      });

      it('handles zero', () => {
        expect(service.toHumanAmount(0n, 6)).toBe('0.000000');
      });

      it('displays 10× smaller than 7-decimal token for same raw value', () => {
        // Same raw amount (10_000_000) means 10 USDC (7dp) vs 10.000000 of a
        // 6dp token — i.e. amounts are NOT inflated when decimals match.
        const sevenDp = service.toHumanAmount(10_000_000n, 7);
        const sixDp   = service.toHumanAmount(10_000_000n, 6);
        expect(sevenDp).toBe('1.0000000');
        expect(sixDp).toBe('10.000000');
      });
    });
  });

  // ------------------------------------------------------------------
  // toBaseUnit
  // ------------------------------------------------------------------

  describe('toBaseUnit()', () => {
    it('converts "1.0" to 10_000_000n with 7 decimals', () => {
      expect(service.toBaseUnit('1.0', 7)).toBe(10_000_000n);
    });

    it('converts "1.5" to 15_000_000n with 7 decimals', () => {
      expect(service.toBaseUnit('1.5', 7)).toBe(15_000_000n);
    });

    it('converts "1.5" to 1_500_000n with 6 decimals', () => {
      expect(service.toBaseUnit('1.5', 6)).toBe(1_500_000n);
    });

    it('handles whole-number string (no decimal point)', () => {
      expect(service.toBaseUnit('2', 7)).toBe(20_000_000n);
    });

    it('truncates excess precision rather than rounding', () => {
      expect(service.toBaseUnit('1.12345678', 7)).toBe(11_234_567n);
    });

    it('defaults to 7 decimals when argument is omitted', () => {
      expect(service.toBaseUnit('1.0')).toBe(10_000_000n);
    });
  });

  // ------------------------------------------------------------------
  // Backward-compatible aliases
  // ------------------------------------------------------------------

  describe('backward-compatible aliases', () => {
    it('stroopsToUsdc delegates to toHumanAmount with 7 decimals', () => {
      expect(service.stroopsToUsdc(10_000_000n)).toBe(service.toHumanAmount(10_000_000n, 7));
    });

    it('usdcToStroops delegates to toBaseUnit with 7 decimals', () => {
      expect(service.usdcToStroops('1.5')).toBe(service.toBaseUnit('1.5', 7));
    });
  });
});

describe('StellarService — getFeeStats', () => {
  let service: StellarService;
  let mockRpcClient: any;

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'STELLAR_RPC_URL') return 'https://mock-rpc.org';
        if (key === 'STELLAR_HORIZON_URL') return 'https://mock-horizon.org';
        if (key === 'STELLAR_NETWORK') return 'testnet';
        return undefined;
      }),
    } as unknown as ConfigService;
    service = new StellarService(config);
    service.onModuleInit();

    mockRpcClient = {
      getFeeStats: jest.fn(),
      getLatestLedger: jest.fn(),
      getLedger: jest.fn(),
    };
    (service as any).rpcClient = mockRpcClient;
  });

  it('should query rpcClient.getFeeStats and ledger details, returning combined results', async () => {
    const mockRpcFees = {
      sorobanInclusionFee: { p90: '500' },
      inclusionFee: { p90: '100' },
      latestLedger: 12345,
    };
    mockRpcClient.getFeeStats.mockResolvedValue(mockRpcFees);
    mockRpcClient.getLatestLedger.mockResolvedValue({ sequence: 12345 });
    mockRpcClient.getLedger.mockResolvedValue({ baseFee: 100 });

    const result = await service.getFeeStats();

    expect(mockRpcClient.getFeeStats).toHaveBeenCalled();
    expect(mockRpcClient.getLatestLedger).toHaveBeenCalled();
    expect(mockRpcClient.getLedger).toHaveBeenCalledWith({ ledgerSeq: 12345 });
    expect(result).toEqual({
      baseFee: 100,
      sorobanInclusionFee: { p90: '500' },
      inclusionFee: { p90: '100' },
      latestLedger: 12345,
    });
  });

  it('should fallback to 100 baseFee if ledger details are missing', async () => {
    const mockRpcFees = {
      sorobanInclusionFee: { p90: '500' },
      inclusionFee: { p90: '100' },
      latestLedger: 12345,
    };
    mockRpcClient.getFeeStats.mockResolvedValue(mockRpcFees);
    mockRpcClient.getLatestLedger.mockResolvedValue({ sequence: 12345 });
    mockRpcClient.getLedger.mockResolvedValue(null);

    const result = await service.getFeeStats();

    expect(result.baseFee).toBe(100);
  });
});
