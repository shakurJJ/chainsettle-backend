import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShipmentsService } from './shipments.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { TokenRegistryService } from '../../common/token-registry/token-registry.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../../common/redis/redis.service';
import { MetricsService } from '../../common/metrics/metrics.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { KycService } from '../kyc/kyc.service';
import { ShipmentApprovalsService } from './shipment-approvals.service';
import { FxRateService } from '../../common/fx/fx-rate.service';
import { ConfigService } from '@nestjs/config';
import { CommentVisibility } from '@prisma/client';

describe('ShipmentsService — getDocuments (#documents)', () => {
  let service: ShipmentsService;

  const mockShipment = {
    id: 'SHIP-DOC-1',
    buyerAddress: 'GBUYER',
    supplierAddress: 'GSUPPLIER',
    logisticsAddress: 'GLOGISTICS',
    arbiterAddress: 'GARBITER',
  };

  const mockProofs = [
    {
      id: 'proof-1',
      milestoneId: 'm-1',
      ipfsCid: 'QmProof123',
      submittedBy: 'GSUPPLIER',
      createdAt: new Date('2026-06-01T10:00:00Z'),
      milestone: { milestoneIndex: 0 },
    },
  ];

  const mockEvidence = [
    {
      id: 'ev-1',
      milestoneId: 'm-2',
      submittedBy: 'GBUYER',
      ipfsCid: 'QmEvidence456',
      fileName: 'damaged_goods.jpg',
      mimeType: 'image/jpeg',
      createdAt: new Date('2026-06-03T14:00:00Z'),
      milestone: { milestoneIndex: 1 },
    },
  ];

  const mockComments = [
    {
      id: 'c-all',
      shipmentId: 'SHIP-DOC-1',
      authorId: 'u-1',
      body: 'Public spec doc',
      visibility: CommentVisibility.ALL,
      attachmentCid: 'QmCommentAll',
      milestoneIndex: null,
      createdAt: new Date('2026-06-02T12:00:00Z'),
      deletedAt: null,
      author: { stellarAddress: 'GBUYER' },
    },
    {
      id: 'c-bs',
      shipmentId: 'SHIP-DOC-1',
      authorId: 'u-2',
      body: 'Commercial invoice',
      visibility: CommentVisibility.BUYER_SUPPLIER,
      attachmentCid: 'QmCommentBuyerSupplier',
      milestoneIndex: 0,
      createdAt: new Date('2026-06-04T16:00:00Z'),
      deletedAt: null,
      author: { stellarAddress: 'GSUPPLIER' },
    },
    {
      id: 'c-int',
      shipmentId: 'SHIP-DOC-1',
      authorId: 'u-3',
      body: 'Internal customs manifest',
      visibility: CommentVisibility.INTERNAL,
      attachmentCid: 'QmCommentInternal',
      milestoneIndex: 0,
      createdAt: new Date('2026-06-05T09:00:00Z'),
      deletedAt: null,
      author: { stellarAddress: 'GLOGISTICS' },
    },
  ];

  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      shipment: {
        findUnique: jest.fn().mockResolvedValue(mockShipment),
      },
      proofSubmission: {
        findMany: jest.fn().mockResolvedValue(mockProofs),
      },
      disputeEvidence: {
        findMany: jest.fn().mockResolvedValue(mockEvidence),
      },
      shipmentComment: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          const visibilities: CommentVisibility[] = where?.visibility?.in ?? [];
          return mockComments.filter((c) => visibilities.includes(c.visibility));
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShipmentsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: StellarService, useValue: { toHumanAmount: jest.fn().mockReturnValue('100') } },
        { provide: TokenRegistryService, useValue: { getToken: jest.fn() } },
        { provide: NotificationsService, useValue: { notifyUser: jest.fn() } },
        { provide: RedisService, useValue: { delByPrefix: jest.fn() } },
        { provide: MetricsService, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: KycService, useValue: {} },
        { provide: ShipmentApprovalsService, useValue: {} },
        { provide: FxRateService, useValue: { getUsdRate: jest.fn().mockResolvedValue(null), getFiatRate: jest.fn().mockResolvedValue(null) } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<ShipmentsService>(ShipmentsService);
  });

  it('merges proofs, evidence, and visible comments into one list sorted by uploadedAt desc', async () => {
    const docs = await service.getDocuments('SHIP-DOC-1', 'GBUYER', false);

    expect(docs).toBeDefined();
    // Buyer can see: proof-1, ev-1, c-all, c-bs (not c-int)
    expect(docs).toHaveLength(4);

    // Sorted descending by uploadedAt:
    // 1. c-bs (2026-06-04)
    // 2. ev-1 (2026-06-03)
    // 3. c-all (2026-06-02)
    // 4. proof-1 (2026-06-01)
    expect(docs[0].cid).toBe('QmCommentBuyerSupplier');
    expect(docs[0].source).toBe('COMMENT');
    expect(docs[0].downloadUrl).toBe('/api/v1/ipfs/QmCommentBuyerSupplier');

    expect(docs[1].cid).toBe('QmEvidence456');
    expect(docs[1].source).toBe('DISPUTE_EVIDENCE');
    expect(docs[1].fileName).toBe('damaged_goods.jpg');
    expect(docs[1].mimeType).toBe('image/jpeg');
    expect(docs[1].downloadUrl).toBe('/api/v1/ipfs/QmEvidence456');

    expect(docs[2].cid).toBe('QmCommentAll');
    expect(docs[2].source).toBe('COMMENT');

    expect(docs[3].cid).toBe('QmProof123');
    expect(docs[3].source).toBe('PROOF');
    expect(docs[3].milestoneIndex).toBe(0);
    expect(docs[3].downloadUrl).toBe('/api/v1/ipfs/QmProof123');
  });

  describe('comment visibility rules', () => {
    it('buyer sees ALL and BUYER_SUPPLIER comment attachments, but NOT INTERNAL', async () => {
      const docs = await service.getDocuments('SHIP-DOC-1', 'GBUYER', false);
      const cids = docs.map((d) => d.cid);
      expect(cids).toContain('QmCommentAll');
      expect(cids).toContain('QmCommentBuyerSupplier');
      expect(cids).not.toContain('QmCommentInternal');
    });

    it('supplier sees ALL and BUYER_SUPPLIER comment attachments, but NOT INTERNAL', async () => {
      const docs = await service.getDocuments('SHIP-DOC-1', 'GSUPPLIER', false);
      const cids = docs.map((d) => d.cid);
      expect(cids).toContain('QmCommentAll');
      expect(cids).toContain('QmCommentBuyerSupplier');
      expect(cids).not.toContain('QmCommentInternal');
    });

    it('logistics sees ALL and INTERNAL comment attachments, but NOT BUYER_SUPPLIER', async () => {
      const docs = await service.getDocuments('SHIP-DOC-1', 'GLOGISTICS', false);
      const cids = docs.map((d) => d.cid);
      expect(cids).toContain('QmCommentAll');
      expect(cids).toContain('QmCommentInternal');
      expect(cids).not.toContain('QmCommentBuyerSupplier');
    });

    it('arbiter sees ALL and INTERNAL comment attachments, but NOT BUYER_SUPPLIER', async () => {
      const docs = await service.getDocuments('SHIP-DOC-1', 'GARBITER', false);
      const cids = docs.map((d) => d.cid);
      expect(cids).toContain('QmCommentAll');
      expect(cids).toContain('QmCommentInternal');
      expect(cids).not.toContain('QmCommentBuyerSupplier');
    });

    it('admin sees all comment attachments regardless of visibility', async () => {
      const docs = await service.getDocuments('SHIP-DOC-1', 'GADMIN', true);
      const cids = docs.map((d) => d.cid);
      expect(cids).toContain('QmCommentAll');
      expect(cids).toContain('QmCommentBuyerSupplier');
      expect(cids).toContain('QmCommentInternal');
      expect(docs).toHaveLength(5);
    });

    it('non-participant is rejected with ForbiddenException', async () => {
      await expect(
        service.getDocuments('SHIP-DOC-1', 'GSTRANGER', false),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('source filter', () => {
    it('filters to PROOF source only', async () => {
      const docs = await service.getDocuments('SHIP-DOC-1', 'GBUYER', false, 'PROOF');
      expect(docs).toHaveLength(1);
      expect(docs[0].source).toBe('PROOF');
      expect(docs[0].cid).toBe('QmProof123');
    });

    it('filters to DISPUTE_EVIDENCE source only', async () => {
      const docs = await service.getDocuments('SHIP-DOC-1', 'GBUYER', false, 'DISPUTE_EVIDENCE');
      expect(docs).toHaveLength(1);
      expect(docs[0].source).toBe('DISPUTE_EVIDENCE');
      expect(docs[0].cid).toBe('QmEvidence456');
    });

    it('filters to COMMENT source only', async () => {
      const docs = await service.getDocuments('SHIP-DOC-1', 'GBUYER', false, 'COMMENT');
      expect(docs).toHaveLength(2);
      expect(docs.every((d) => d.source === 'COMMENT')).toBe(true);
    });
  });

  it('throws NotFoundException if shipment does not exist', async () => {
    prismaMock.shipment.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.getDocuments('NON_EXISTENT', 'GBUYER', false),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
