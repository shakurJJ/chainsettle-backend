import { MilestoneStatus, ShipmentStatus } from '@prisma/client';
import {
  buildShipmentReportSummary,
  formatTokenAmount,
  ReportShipment,
  ShipmentReportService,
} from './shipment-report.service';

const NOW = new Date('2026-11-23T09:00:00.000Z');
const PERIOD_START = new Date('2026-11-16T09:00:00.000Z');
const ADDRESS = 'GBUYER';

function shipment(overrides: Partial<ReportShipment> = {}): ReportShipment {
  return {
    id: 'ship-1',
    referenceNumber: 'REF-1',
    status: ShipmentStatus.ACTIVE,
    buyerAddress: ADDRESS,
    supplierAddress: 'GSUPPLIER',
    logisticsAddress: 'GLOGISTICS',
    arbiterAddress: 'GARBITER',
    totalAmount: BigInt(1_000_000_000),
    releasedAmount: BigInt(250_000_000),
    tokenSymbol: 'USDC',
    tokenDecimals: 7,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-20T00:00:00.000Z'),
    milestones: [],
    ...overrides,
  };
}

function build(
  shipments: ReportShipment[],
  frequency: 'weekly' | 'monthly' = 'weekly',
) {
  return buildShipmentReportSummary({
    stellarAddress: ADDRESS,
    frequency,
    shipments,
    periodStart: PERIOD_START,
    periodEnd: NOW,
    now: NOW,
  });
}

describe('formatTokenAmount', () => {
  it('formats stroops and trims trailing zeros', () => {
    expect(formatTokenAmount(BigInt(750_000_000), 7)).toBe('75');
    expect(formatTokenAmount(BigInt(1_234_567), 7)).toBe('0.1234567');
    expect(formatTokenAmount(BigInt(0), 7)).toBe('0');
    expect(formatTokenAmount(BigInt(1_500_000), 6)).toBe('1.5');
  });

  it('handles numbers, nulls and negatives', () => {
    expect(formatTokenAmount(15_000_000, 7)).toBe('1.5');
    expect(formatTokenAmount(null, 7)).toBe('0');
    expect(formatTokenAmount(-2_500_000, 6)).toBe('-2.5');
  });
});

describe('buildShipmentReportSummary', () => {
  it('returns null when the user has no shipments', () => {
    expect(build([])).toBeNull();
  });

  it('counts shipments by status and by the caller role', () => {
    const report = build([
      shipment({ id: 'a' }),
      shipment({
        id: 'b',
        status: ShipmentStatus.COMPLETED,
        buyerAddress: 'GOTHER',
        supplierAddress: ADDRESS,
      }),
      shipment({
        id: 'c',
        status: ShipmentStatus.CANCELLED,
        buyerAddress: 'GOTHER',
        logisticsAddress: ADDRESS,
      }),
    ]);

    expect(report).not.toBeNull();
    expect(report!.stats).toMatchObject({
      totalShipments: 3,
      activeShipments: 1,
      completedShipments: 1,
      cancelledShipments: 1,
      roles: { BUYER: 1, SUPPLIER: 1, LOGISTICS: 1, ARBITER: 0, OBSERVER: 0 },
    });
    expect(report!.subject).toContain('weekly shipment report');
    expect(report!.subject).toContain('1 active shipment(s)');
  });

  it('reports outstanding escrow per token for ACTIVE shipments only', () => {
    const report = build([
      shipment({
        id: 'a',
        totalAmount: BigInt(1_000_000_000),
        releasedAmount: BigInt(250_000_000),
      }),
      shipment({
        id: 'b',
        totalAmount: BigInt(500_000_000),
        releasedAmount: BigInt(0),
        tokenSymbol: 'EURC',
      }),
      shipment({
        id: 'c',
        status: ShipmentStatus.COMPLETED,
        totalAmount: BigInt(900_000_000),
        releasedAmount: BigInt(0),
      }),
    ]);

    expect(report!.stats.escrowByToken).toEqual({ USDC: '75', EURC: '50' });
    expect(report!.html).toContain('75 USDC');
  });

  it('counts shipments created and updated inside the reporting period', () => {
    const report = build([
      shipment({
        id: 'old',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-02T00:00:00Z'),
      }),
      shipment({
        id: 'new',
        createdAt: new Date('2026-11-18T00:00:00Z'),
        updatedAt: new Date('2026-11-19T00:00:00Z'),
      }),
    ]);

    expect(report!.stats.createdInPeriod).toBe(1);
    expect(report!.stats.updatedInPeriod).toBe(1);
  });

  it('lists overdue and upcoming open milestones, sorted by due date', () => {
    const report = build([
      shipment({
        id: 'a',
        milestones: [
          {
            milestoneIndex: 0,
            name: 'Pickup',
            status: MilestoneStatus.PENDING,
            dueAt: new Date('2026-11-20T00:00:00Z'),
          },
          {
            milestoneIndex: 1,
            name: 'Delivery',
            status: MilestoneStatus.PROOF_SUBMITTED,
            dueAt: new Date('2026-11-26T00:00:00Z'),
          },
          {
            milestoneIndex: 2,
            name: 'Customs',
            status: MilestoneStatus.PENDING,
            dueAt: new Date('2026-12-30T00:00:00Z'),
          },
        ],
      }),
      shipment({
        id: 'b',
        milestones: [
          {
            milestoneIndex: 0,
            name: 'Inspection',
            status: MilestoneStatus.CONFIRMED,
            dueAt: new Date('2026-11-01T00:00:00Z'),
          },
          {
            milestoneIndex: 1,
            name: 'Dispatch',
            status: MilestoneStatus.PENDING,
            dueAt: new Date('2026-11-22T00:00:00Z'),
          },
        ],
      }),
    ]);

    expect(report!.stats.overdueMilestones.map((m) => m.name)).toEqual([
      'Pickup',
      'Dispatch',
    ]);
    expect(report!.stats.upcomingMilestones.map((m) => m.name)).toEqual([
      'Delivery',
    ]);
    // Out-of-window and completed milestones never appear.
    expect(report!.html).not.toContain('Customs');
    expect(report!.html).not.toContain('Inspection');
  });

  it('says so when no open milestone is due soon', () => {
    const report = build([shipment({ milestones: [] })]);
    expect(report!.html).toContain(
      'No open milestones are due in the next 7 days.',
    );
  });

  it('uses the monthly wording and shows the supplied reporting period', () => {
    const monthlyStart = new Date('2026-10-24T09:00:00.000Z');
    const report = buildShipmentReportSummary({
      stellarAddress: ADDRESS,
      frequency: 'monthly',
      shipments: [shipment()],
      periodStart: monthlyStart,
      periodEnd: NOW,
      now: NOW,
    });

    expect(report!.subject).toContain('monthly shipment report');
    expect(report!.html).toContain('2026-10-24 → 2026-11-23');
  });

  it('escapes shipment and milestone text before embedding it in HTML', () => {
    const report = build([
      shipment({
        referenceNumber: '<script>alert(1)</script>',
        milestones: [
          {
            milestoneIndex: 0,
            name: '<b>danger</b>',
            status: MilestoneStatus.PENDING,
            dueAt: new Date('2026-11-22T00:00:00Z'),
          },
        ],
      }),
    ]);

    expect(report!.html).not.toContain('<script>');
    expect(report!.html).not.toContain('<b>danger</b>');
    expect(report!.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('ShipmentReportService.buildForUser', () => {
  function serviceWith(prisma: any) {
    return new ShipmentReportService(prisma);
  }

  it('does not query anything when reports are turned off', async () => {
    const prisma = {
      user: { findUnique: jest.fn() },
      shipment: { findMany: jest.fn() },
    };

    const result = await serviceWith(prisma).buildForUser('user-1', 'off', NOW);

    expect(result).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.shipment.findMany).not.toHaveBeenCalled();
  });

  it('loads only the caller shipments and passes them to the builder', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ stellarAddress: ADDRESS }),
      },
      shipment: {
        findMany: jest.fn().mockResolvedValue([shipment({ milestones: [] })]),
      },
    };

    const report = await serviceWith(prisma).buildForUser(
      'user-1',
      'weekly',
      NOW,
    );

    expect(prisma.shipment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isDraft: false,
          OR: [
            { buyerAddress: ADDRESS },
            { supplierAddress: ADDRESS },
            { logisticsAddress: ADDRESS },
            { arbiterAddress: ADDRESS },
          ],
        }),
      }),
    );
    expect(report!.stats.totalShipments).toBe(1);
    expect(prisma.shipment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          milestones: expect.objectContaining({
            where: { deletedAt: null },
          }),
        }),
      }),
    );
  });

  it('uses the previous calendar month for a monthly report', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ stellarAddress: ADDRESS }),
      },
      shipment: {
        findMany: jest.fn().mockResolvedValue([shipment({ milestones: [] })]),
      },
    };

    const result = await serviceWith(prisma).buildForUser(
      'user-1',
      'monthly',
      NOW,
    );

    expect(result!.html).toContain('2026-10-01 → 2026-11-01');
  });

  it('uses a rolling 7-day window for a weekly report', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ stellarAddress: ADDRESS }),
      },
      shipment: {
        findMany: jest.fn().mockResolvedValue([shipment({ milestones: [] })]),
      },
    };

    const result = await serviceWith(prisma).buildForUser(
      'user-1',
      'weekly',
      NOW,
    );

    expect(result!.html).toContain('2026-11-16 → 2026-11-23');
  });

  it('returns null when the user no longer exists', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      shipment: { findMany: jest.fn() },
    };

    expect(
      await serviceWith(prisma).buildForUser('gone', 'weekly', NOW),
    ).toBeNull();
    expect(prisma.shipment.findMany).not.toHaveBeenCalled();
  });
});
