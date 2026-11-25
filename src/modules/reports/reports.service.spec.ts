import { MilestoneStatus } from '@prisma/client';
import { ReportsService, bucketForAgeDays, formatRawAmount } from './reports.service';

const SUPPLIER = 'G' + 'S'.repeat(55);
const USDC = { tokenAddress: 'USDC-ADDRESS', tokenSymbol: 'USDC', tokenDecimals: 7 };
const EURC = { tokenAddress: 'EURC-ADDRESS', tokenSymbol: 'EURC', tokenDecimals: 7 };

const AS_OF = new Date('2026-06-01T00:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(AS_OF.getTime() - days * MS_PER_DAY);

/** Builds the milestone row shape returned by the Prisma select. */
function milestone(
  token: typeof USDC,
  totalAmount: bigint,
  paymentPercent: number,
  daysPastDue: number,
  status: MilestoneStatus = MilestoneStatus.PENDING,
) {
  return {
    status,
    dueAt: daysAgo(daysPastDue),
    paymentPercent,
    shipment: { ...token, totalAmount },
  };
}

describe('ReportsService — GET /reports/aging (#659)', () => {
  let service: ReportsService;
  let findMany: jest.Mock;
  let fxRate: { getUsdRate: jest.Mock };

  // Fixture: 100 USDC shipment with 3 unreleased past-due milestones (10 / 20 / 30 USDC)
  // and a 50 EURC shipment with one 25 EURC milestone 61 days past due.
  const fixtures = [
    milestone(USDC, 100_0000000n, 10, 10), // 0-30
    milestone(USDC, 100_0000000n, 20, 45, MilestoneStatus.PROOF_SUBMITTED), // 31-60
    milestone(USDC, 100_0000000n, 30, 200), // 90+
    milestone(EURC, 50_0000000n, 50, 61), // 61-90
  ];

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue(fixtures);
    fxRate = {
      getUsdRate: jest.fn(async (symbol: string) =>
        symbol === 'USDC'
          ? { rate: 1, asOf: '2026-05-31T00:00:00.000Z' }
          : { rate: 1.1, asOf: '2026-05-31T00:00:00.000Z' },
      ),
    };
    service = new ReportsService({ read: { milestone: { findMany } } } as any, fxRate as any);
  });

  it('buckets past-due milestone value into 0-30, 31-60, 61-90 and 90+', async () => {
    const report = await service.getAgingReport(SUPPLIER, { asOf: AS_OF });

    expect(report.buckets).toEqual(['0-30', '31-60', '61-90', '90+']);

    const usdc = report.byToken.find((t) => t.tokenSymbol === 'USDC')!;
    expect(usdc.buckets['0-30']).toEqual({ amount: '10', valueRaw: '100000000', milestoneCount: 1 });
    expect(usdc.buckets['31-60']).toEqual({ amount: '20', valueRaw: '200000000', milestoneCount: 1 });
    expect(usdc.buckets['61-90']).toEqual({ amount: '0', valueRaw: '0', milestoneCount: 0 });
    expect(usdc.buckets['90+']).toEqual({ amount: '30', valueRaw: '300000000', milestoneCount: 1 });
    expect(usdc.total).toEqual({ amount: '60', valueRaw: '600000000', milestoneCount: 3 });

    const eurc = report.byToken.find((t) => t.tokenSymbol === 'EURC')!;
    expect(eurc.buckets['61-90']).toEqual({ amount: '25', valueRaw: '250000000', milestoneCount: 1 });
    expect(eurc.total.milestoneCount).toBe(1);
  });

  it('groups by token and leaves USD out unless requested', async () => {
    const report = await service.getAgingReport(SUPPLIER, { asOf: AS_OF });

    expect(report.byToken.map((t) => t.tokenSymbol)).toEqual(['EURC', 'USDC']);
    expect(report.byToken.every((t) => t.totalUsd === null)).toBe(true);
    expect(report.totalUsd).toBeNull();
    expect(fxRate.getUsdRate).not.toHaveBeenCalled();
  });

  it('adds a USD total per token and overall when includeUsdTotal=true', async () => {
    const report = await service.getAgingReport(SUPPLIER, {
      asOf: AS_OF,
      includeUsdTotal: true,
    });

    const usdc = report.byToken.find((t) => t.tokenSymbol === 'USDC')!;
    const eurc = report.byToken.find((t) => t.tokenSymbol === 'EURC')!;
    expect(usdc.totalUsd).toBe(60);
    expect(eurc.totalUsd).toBe(27.5); // 25 EURC × 1.1
    expect(report.totalUsd).toBe(87.5);
    expect(report.usdComplete).toBe(true);
  });

  it('flags an incomplete USD total when a token has no cached rate', async () => {
    fxRate.getUsdRate.mockImplementation(async (symbol: string) =>
      symbol === 'USDC' ? { rate: 1, asOf: '2026-05-31T00:00:00.000Z' } : null,
    );

    const report = await service.getAgingReport(SUPPLIER, {
      asOf: AS_OF,
      includeUsdTotal: true,
    });

    expect(report.byToken.find((t) => t.tokenSymbol === 'EURC')!.totalUsd).toBeNull();
    expect(report.totalUsd).toBe(60);
    expect(report.usdComplete).toBe(false);
  });

  it('scopes the query to the caller as supplier and to unreleased past-due milestones', async () => {
    await service.getAgingReport(SUPPLIER, { asOf: AS_OF });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: [MilestoneStatus.PENDING, MilestoneStatus.PROOF_SUBMITTED] },
          deletedAt: null,
          dueAt: { lt: AS_OF },
          shipment: { supplierAddress: SUPPLIER, isDraft: false },
        },
      }),
    );
  });

  it('returns empty buckets, not an error, when nothing is past due', async () => {
    findMany.mockResolvedValue([]);

    const report = await service.getAgingReport(SUPPLIER, {
      asOf: AS_OF,
      includeUsdTotal: true,
    });

    expect(report.byToken).toEqual([]);
    expect(report.totalUsd).toBe(0);
    expect(report.usdComplete).toBe(true);
  });

  it('maps day boundaries onto the right bucket', () => {
    expect(bucketForAgeDays(0)).toBe('0-30');
    expect(bucketForAgeDays(30)).toBe('0-30');
    expect(bucketForAgeDays(31)).toBe('31-60');
    expect(bucketForAgeDays(60)).toBe('31-60');
    expect(bucketForAgeDays(61)).toBe('61-90');
    expect(bucketForAgeDays(90)).toBe('61-90');
    expect(bucketForAgeDays(91)).toBe('90+');
    expect(bucketForAgeDays(3650)).toBe('90+');
    expect(bucketForAgeDays(-1)).toBeNull();
  });

  it('formats raw token amounts exactly', () => {
    expect(formatRawAmount(10_000_000_000n, 7)).toBe('1000');
    expect(formatRawAmount(1_234_5000000n, 7)).toBe('1234.5');
    expect(formatRawAmount(1n, 7)).toBe('0.0000001');
    expect(formatRawAmount(0n, 7)).toBe('0');
    expect(formatRawAmount(123n, 0)).toBe('123');
  });
});
