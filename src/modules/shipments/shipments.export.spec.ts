import { Test, TestingModule } from '@nestjs/testing';
import { ShipmentsService } from './shipments.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { TokenRegistryService } from '../../common/token-registry/token-registry.service';
import { NotificationsService } from '../notifications/notifications.service';

const DECIMALS = 7;
const toHumanAmount = (raw: bigint) => (Number(raw) / 10 ** DECIMALS).toFixed(DECIMALS);

const mockShipments = [
  {
    id: 'SHIP-001',
    buyerAddress: 'GBUYER',
    supplierAddress: 'GSUPPLIER',
    logisticsAddress: 'GLOGISTICS',
    arbiterAddress: 'GARBITER',
    totalAmount: BigInt(1_000_000_000),
    releasedAmount: BigInt(250_000_000),
    status: 'ACTIVE',
    tokenDecimals: DECIMALS,
    tokenSymbol: 'USDC',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    expectedDeliveryAt: new Date('2025-01-10T00:00:00Z'),
    milestones: [
      {
        id: 'm-1',
        milestoneIndex: 0,
        name: 'Dispatch',
        paymentPercent: 25,
        status: 'CONFIRMED',
        proofHash: 'Qm123',
        confirmedAt: new Date('2025-01-02T00:00:00Z'),
      },
      {
        id: 'm-2',
        milestoneIndex: 1,
        name: 'Delivery',
        paymentPercent: 75,
        status: 'PENDING',
        proofHash: null,
        confirmedAt: null,
      },
    ],
  },
];

function buildMocks() {
  return {
    prisma: {
      shipment: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue(mockShipments),
        count: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    },
    stellar: {
      simulateContractCall: jest.fn(),
      toHumanAmount: jest.fn().mockImplementation(toHumanAmount),
    },
    tokenRegistry: { getToken: jest.fn().mockReturnValue({ symbol: 'USDC', decimals: DECIMALS }) },
    notifications: { notifyUser: jest.fn().mockResolvedValue(undefined) },
  };
}

async function buildService(mocks: ReturnType<typeof buildMocks>) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ShipmentsService,
      { provide: PrismaService, useValue: mocks.prisma },
      { provide: StellarService, useValue: mocks.stellar },
      { provide: TokenRegistryService, useValue: mocks.tokenRegistry },
      { provide: NotificationsService, useValue: mocks.notifications },
    ],
  }).compile();
  return module.get(ShipmentsService);
}

describe('ShipmentsService — export', () => {
  let service: ShipmentsService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  afterEach(() => jest.clearAllMocks());

  // ── exportForUser — ownership scoping ────────────────────────────────────

  describe('exportForUser()', () => {
    it('scopes query to caller address for non-admin users', async () => {
      await service.exportForUser('GBUYER', false);

      expect(mocks.prisma.shipment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { buyerAddress: 'GBUYER' },
              { supplierAddress: 'GBUYER' },
              { logisticsAddress: 'GBUYER' },
              { arbiterAddress: 'GBUYER' },
            ],
          },
        }),
      );
    });

    it('applies no where clause for admin users', async () => {
      await service.exportForUser('GADMIN', true);

      expect(mocks.prisma.shipment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });

  // ── buildCsv ─────────────────────────────────────────────────────────────

  describe('buildCsv()', () => {
    it('returns a string starting with the correct header row', () => {
      const csv = service.buildCsv(mockShipments);
      const [header] = csv.split('\n');
      expect(header).toBe(
        'shipmentId,buyerAddress,supplierAddress,logisticsAddress,arbiterAddress,' +
        'totalAmount,releasedAmount,status,createdAt,expectedDeliveryAt,' +
        'milestoneName,milestoneIndex,paymentPercent,milestoneStatus,proofHash,confirmedAt',
      );
    });

    it('produces one data row per milestone', () => {
      const csv = service.buildCsv(mockShipments);
      const rows = csv.split('\n');
      // 1 header + 2 milestone rows
      expect(rows).toHaveLength(3);
    });

    it('includes shipment fields on every milestone row', () => {
      const csv = service.buildCsv(mockShipments);
      const rows = csv.split('\n').slice(1);
      for (const row of rows) {
        expect(row).toContain('SHIP-001');
        expect(row).toContain('GBUYER');
        expect(row).toContain('ACTIVE');
      }
    });

    it('includes milestone-specific fields', () => {
      const csv = service.buildCsv(mockShipments);
      expect(csv).toContain('Dispatch');
      expect(csv).toContain('Delivery');
      expect(csv).toContain('Qm123');
      expect(csv).toContain('CONFIRMED');
      expect(csv).toContain('PENDING');
    });

    it('emits a single empty-milestone row for shipments with no milestones', () => {
      const noMilestones = [{ ...mockShipments[0], milestones: [] }];
      const csv = service.buildCsv(noMilestones);
      const rows = csv.split('\n');
      expect(rows).toHaveLength(2); // header + 1 row
    });

    it('escapes values containing commas', () => {
      const withComma = [
        {
          ...mockShipments[0],
          milestones: [{ ...mockShipments[0].milestones[0], name: 'Step, one' }],
        },
      ];
      const csv = service.buildCsv(withComma);
      expect(csv).toContain('"Step, one"');
    });
  });

  // ── buildPdf ─────────────────────────────────────────────────────────────

  describe('buildPdf()', () => {
    it('resolves to a non-empty Buffer', async () => {
      const buf = await service.buildPdf(mockShipments);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
    });

    it('PDF starts with the %PDF magic bytes', async () => {
      const buf = await service.buildPdf(mockShipments);
      expect(buf.slice(0, 4).toString()).toBe('%PDF');
    });

    it('resolves to a Buffer for an empty shipment list', async () => {
      const buf = await service.buildPdf([]);
      expect(Buffer.isBuffer(buf)).toBe(true);
    });
  });
});
