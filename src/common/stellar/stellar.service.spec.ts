import { StellarService } from './stellar.service';
import { ConfigService } from '@nestjs/config';
import { nativeToScVal, xdr, StrKey } from '@stellar/stellar-sdk';
import { NotFoundException } from '@nestjs/common';

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

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

describe('StellarService — getTransactionEvents', () => {
  let service: StellarService;
  let mockRpcClient: any;

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'STELLAR_RPC_URL') return 'https://mock-rpc.org';
        if (key === 'STELLAR_HORIZON_URL') return 'https://mock-horizon.org';
        if (key === 'STELLAR_NETWORK') return 'testnet';
        if (key === 'CHAINSETTTLE_CONTRACT_ID') return 'C1234567890';
        return undefined;
      }),
    } as unknown as ConfigService;
    service = new StellarService(config);
    service.onModuleInit();

    mockRpcClient = {
      getTransaction: jest.fn(),
    };
    (service as any).rpcClient = mockRpcClient;
  });

  it('should throw NotFoundException if tx status is NOT_FOUND', async () => {
    mockRpcClient.getTransaction.mockResolvedValue({
      status: 'NOT_FOUND',
    });

    await expect(service.getTransactionEvents('txhash')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should return empty array if tx status is not SUCCESS', async () => {
    mockRpcClient.getTransaction.mockResolvedValue({
      status: 'FAILED',
    });

    const result = await service.getTransactionEvents('txhash');
    expect(result).toEqual([]);
  });

  it('should return empty array if resultMetaXdr is missing', async () => {
    mockRpcClient.getTransaction.mockResolvedValue({
      status: 'SUCCESS',
      resultMetaXdr: undefined,
    });

    const result = await service.getTransactionEvents('txhash');
    expect(result).toEqual([]);
  });

  it('should parse and decode events from resultMetaXdr matching contractId', async () => {
    const mockEvent = {
      contractId: () => Buffer.from('mock-contract-id-bytes'),
      type: () => ({ name: 'contract', value: 0 }),
      body: () => ({
        v0: () => ({
          topics: () => [nativeToScVal('shipment_created'), nativeToScVal('shipment-1')],
          data: () => nativeToScVal({ amount: 100 }),
        }),
      }),
    };

    const mockSorobanMeta = {
      events: () => [mockEvent],
    };

    const mockMeta = {
      switch: () => 3,
      v3: () => ({
        sorobanMeta: () => mockSorobanMeta,
      }),
    };

    mockRpcClient.getTransaction.mockResolvedValue({
      status: 'SUCCESS',
      resultMetaXdr: mockMeta,
      ledger: 100,
    });

    const encodeContractSpy = jest.spyOn(StrKey, 'encodeContract').mockReturnValue('C1234567890');

    const result = await service.getTransactionEvents('txhash');

    expect(encodeContractSpy).toHaveBeenCalled();
    expect(result).toEqual([
      {
        id: 'txhash-0',
        contractId: 'C1234567890',
        type: 'contract',
        topic: ['shipment_created', 'shipment-1'],
        value: { amount: 100n },
        ledger: 100,
        txHash: 'txhash',
      },
    ]);

    encodeContractSpy.mockRestore();
  });
});

