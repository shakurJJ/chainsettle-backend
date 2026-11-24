import { BadRequestException } from '@nestjs/common';
import { MilestoneStatus, ShipmentStatus } from '@prisma/client';
import { PerformanceService, PERFORMANCE_CACHE_TTL_SECONDS } from './performance.service';

const SUPPLIER = 'G' + 'S'.repeat(55);
const BUYER = 'G' + 'B'.repeat(55);
const STRANGER = 'G' + 'X'.repeat(55);

const H = 60 * 60 * 1000;
const t = (h: number) => new Date(Date.UTC(2026, 0, 1) + h * H);

describe('PerformanceService (#391)', () => {
  let service: PerformanceService;
  let db: any;
  let redis: any;
  let fxRate: any;

  // Seeded data: 3 shipments for SUPPLIER.
  const seeded = [
    {
      // Completed, 2 milestones both on time, proof→confirm 2h and 4h.
      status: ShipmentStatus.COMPLETED,
      totalAmount: 1_000_000_000n, // 100 USDC
      tokenDecimals: 7,
      tokenSymbol: 'USDC',
      milestones: [
        { status: MilestoneStatus.CONFIRMED, dueAt: t(10), confirmedAt: t(5), disputeEscalatedAt: null, proofSubmissions: [{ createdAt: t(3) }] },
        { status: MilestoneStatus.CONFIRMED, dueAt: t(20), confirmedAt: t(12), disputeEscalatedAt: null, proofSubmissions: [{ createdAt: t(1) }, { createdAt: t(8) }] },
      ],
    },
    {
      // Completed, one late milestone that was disputed and resolved.
      status: ShipmentStatus.COMPLETED,
      totalAmount: 500_000_000n, // 50 USDC
      tokenDecimals: 7,
      tokenSymbol: 'USDC',
      milestones: [
        { status: MilestoneStatus.RESOLVED, dueAt: t(10), confirmedAt: t(15), disputeEscalatedAt: null, proofSubmissions: [{ createdAt: t(9) }] },
      ],
    },
    {
      // Active, no deadlines yet.
      status: ShipmentStatus.ACTIVE,
      totalAmount: 900_000_000n,
      tokenDecimals: 7,
      tokenSymbol: 'USDC',
      milestones: [{ status: MilestoneStatus.PENDING, dueAt: null, confirmedAt: null, disputeEscalatedAt: null, proofSubmissions: [] }],
    },
  ];

  beforeEach(() => {
    db = {
      shipment: {
        findMany: jest.fn().mockResolvedValue(seeded),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const store = new Map<string, string>();
    redis = {
      getJson: jest.fn(async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null)),
      setJson: jest.fn(async (k: string, v: unknown) => void store.set(k, JSON.stringify(v))),
    };
    const stellar: any = {
      toHumanAmount: (amount: bigint, decimals: number) => (Number(amount) / 10 ** decimals).toString(),
    };
    fxRate = { getUsdRate: jest.fn().mockResolvedValue({ rate: 1, asOf: '2026-01-01T00:00:00Z' }) };
    service = new PerformanceService({ read: db } as any, redis, stellar, fxRate);
  });

  it('computes metrics correctly for seeded data', async () => {
    const stats = await service.getPerformance(SUPPLIER, { stellarAddress: SUPPLIER });
    expect(stats).toMatchObject({
      totalShipments: 3,
      completedShipments: 2,
      onTimeMilestoneRate: 0.6667, // 2 of 3 due milestones on time
      disputeRate: 0.3333, // 1 of 3 shipments disputed
      avgProofToConfirmHours: 4, // (2 + 4 + 6) / 3
      totalVolumeUsd: 150,
      volumeComplete: true,
    });
  });

  it('returns zeros, not errors, for an address with no history', async () => {
    db.shipment.findMany.mockResolvedValue([]);
    const stats = await service.getPerformance(STRANGER, { stellarAddress: STRANGER });
    expect(stats).toMatchObject({
      totalShipments: 0,
      completedShipments: 0,
      onTimeMilestoneRate: 0,
      disputeRate: 0,
      avgProofToConfirmHours: 0,
      totalVolumeUsd: 0,
    });
  });

  it('hides volume for callers who never traded with the address', async () => {
    const stats = await service.getPerformance(SUPPLIER, { stellarAddress: STRANGER, role: 'BUYER' });
    expect(stats.totalVolumeUsd).toBeNull();
    expect(stats.completedShipments).toBe(2);
  });

  it('shows volume to a counterparty and to admins', async () => {
    db.shipment.findFirst.mockResolvedValue({ id: 'SHIP-1' });
    expect((await service.getPerformance(SUPPLIER, { stellarAddress: BUYER })).totalVolumeUsd).toBe(150);

    db.shipment.findFirst.mockResolvedValue(null);
    expect((await service.getPerformance(SUPPLIER, { stellarAddress: STRANGER, role: 'ADMIN' })).totalVolumeUsd).toBe(150);
  });

  it('uses the cache with a one-hour TTL, keyed by role and since', async () => {
    await service.getPerformance(SUPPLIER, { stellarAddress: SUPPLIER });
    await service.getPerformance(SUPPLIER, { stellarAddress: SUPPLIER });
    expect(db.shipment.findMany).toHaveBeenCalledTimes(1);
    expect(redis.setJson).toHaveBeenCalledWith(
      `performance:${SUPPLIER}:ALL:all`,
      expect.any(Object),
      PERFORMANCE_CACHE_TTL_SECONDS,
    );
    expect(PERFORMANCE_CACHE_TTL_SECONDS).toBe(3600);

    await service.getPerformance(SUPPLIER, { stellarAddress: SUPPLIER }, 'LOGISTICS');
    expect(db.shipment.findMany).toHaveBeenCalledTimes(2);
  });

  it('does not cache per-caller volume visibility', async () => {
    await service.getPerformance(SUPPLIER, { stellarAddress: STRANGER });
    const cached = redis.setJson.mock.calls[0][1];
    expect(cached.totalVolumeUsd).toBe(150);
    db.shipment.findFirst.mockResolvedValue({ id: 'SHIP-1' });
    expect((await service.getPerformance(SUPPLIER, { stellarAddress: BUYER })).totalVolumeUsd).toBe(150);
  });

  it('filters by role and since', async () => {
    await service.compute(SUPPLIER, 'SUPPLIER', '2026-02-01T00:00:00Z');
    expect(db.shipment.findMany.mock.calls[0][0].where).toMatchObject({
      supplierAddress: SUPPLIER,
      createdAt: { gte: new Date('2026-02-01T00:00:00Z') },
    });
  });

  it('flags incomplete volume when a token has no FX rate', async () => {
    fxRate.getUsdRate.mockResolvedValue(null);
    const stats = await service.compute(SUPPLIER, undefined, undefined);
    expect(stats.volumeComplete).toBe(false);
    expect(stats.totalVolumeUsd).toBe(0);
  });

  it('rejects malformed addresses', async () => {
    await expect(service.getPerformance('not-an-address', {})).rejects.toThrow(BadRequestException);
  });
});
