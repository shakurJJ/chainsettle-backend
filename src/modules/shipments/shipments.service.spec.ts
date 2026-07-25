import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ShipmentsService } from "./shipments.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { StellarService } from "../../common/stellar/stellar.service";
import { TokenRegistryService } from "../../common/token-registry/token-registry.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  NotificationType,
  ShipmentStatus,
  ArbiterStatus,
} from "@prisma/client";

const mockPrisma = {
  shipment: {
    findUnique: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  shipmentTemplate: {
    findUnique: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
  shipmentWatcher: {
    findFirst: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockStellar = {
  simulateContractCall: jest.fn(),
  stroopsToUsdc: jest.fn().mockReturnValue("100.0000000"),
  toHumanAmount: jest.fn().mockReturnValue("100.0000000"),
};

const mockTokenRegistry = {
  getToken: jest.fn().mockReturnValue({ symbol: "USDC", decimals: 7 }),
};

const mockNotifications = {
  notifyUser: jest.fn().mockResolvedValue(undefined),
};

describe("ShipmentsService", () => {
  let service: ShipmentsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShipmentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StellarService, useValue: mockStellar },
        { provide: TokenRegistryService, useValue: mockTokenRegistry },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();

    service = module.get<ShipmentsService>(ShipmentsService);
    jest.clearAllMocks();

    // Sensible defaults
    mockStellar.toHumanAmount.mockReturnValue("100.0000000");
    mockTokenRegistry.getToken.mockReturnValue({ symbol: "USDC", decimals: 7 });
    mockNotifications.notifyUser.mockResolvedValue(undefined);
  });

  describe("create()", () => {
    const dto = {
      shipmentId: "SHIP-001",
      buyerAddress: "GABC",
      supplierAddress: "GDEF",
      logisticsAddress: "GHIJ",
      arbiterAddress: "GKLM",
      tokenAddress: "CNOP",
      totalAmount: "1000000000",
      txHash: "tx_hash",
      description: "desc",
      referenceNumber: "PO-2026-001",
      metadata: { incoterms: "FOB" },
      tags: ["urgent"],
      milestones: [
        { name: "Dispatch", paymentPercent: 25, dueDays: 1 },
        { name: "Transit", paymentPercent: 50, dueDays: 2 },
        { name: "Delivered", paymentPercent: 25, dueDays: 3 },
      ],
    };

    it("creates a shipment successfully and serializes totalAmount as string", async () => {
      mockPrisma.shipment.findUnique.mockResolvedValueOnce(null); // shipmentId guard
      mockPrisma.shipment.findUnique.mockResolvedValueOnce(null); // referenceNumber guard
      mockPrisma.shipment.create.mockResolvedValue({
        id: dto.shipmentId,
        buyerAddress: dto.buyerAddress,
        supplierAddress: dto.supplierAddress,
        logisticsAddress: dto.logisticsAddress,
        arbiterAddress: dto.arbiterAddress,
        tokenAddress: dto.tokenAddress,
        tokenDecimals: 7,
        tokenSymbol: "USDC",
        totalAmount: BigInt(dto.totalAmount),
        releasedAmount: BigInt(0),
        txHash: dto.txHash,
        description: dto.description,
        referenceNumber: dto.referenceNumber,
        metadata: dto.metadata,
        tags: dto.tags,
        status: ShipmentStatus.ACTIVE,
        arbiterStatus: ArbiterStatus.PENDING_ACCEPTANCE,
        milestones: dto.milestones.map((m, i) => ({
          id: `m-${i}`,
          milestoneIndex: i,
          name: m.name,
          paymentPercent: m.paymentPercent,
          dueAt: new Date(),
          paymentReleased: null,
          status: "PENDING",
          proofHash: null,
          confirmedAt: null,
        })),
      });

      const result = await service.create(dto as any);

      expect(result).toBeDefined();
      expect(result.id).toBe(dto.shipmentId);
      // Acceptance: serialized bigint conversion
      expect(typeof result.totalAmount).toBe("string");
      expect(result.totalAmount).toBe(dto.totalAmount);
      expect(typeof result.releasedAmount).toBe("string");
      expect(result.releasedAmount).toBe("0");

      expect(mockPrisma.shipment.create).toHaveBeenCalledTimes(1);
      expect(mockNotifications.notifyUser).toHaveBeenCalledWith(
        dto.arbiterAddress,
        NotificationType.ARBITER_INVITED,
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          shipmentId: dto.shipmentId,
          buyerAddress: dto.buyerAddress,
        }),
      );
    });

    it("throws ConflictException for duplicate shipmentId values", async () => {
      mockPrisma.shipment.findUnique.mockResolvedValueOnce({
        id: dto.shipmentId,
      });

      await expect(service.create(dto as any)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockPrisma.shipment.create).not.toHaveBeenCalled();
    });

    it("throws ConflictException for duplicate referenceNumber values", async () => {
      mockPrisma.shipment.findUnique
        .mockResolvedValueOnce(null) // shipmentId guard
        .mockResolvedValueOnce({
          id: "SHIP-002",
          referenceNumber: dto.referenceNumber,
        }); // referenceNumber guard

      await expect(service.create(dto as any)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe("findAll()", () => {
    it("paginates and sets meta.totalPages = Math.ceil(total/limit)", async () => {
      const shipments = [
        {
          id: "SHIP-1",
          buyerAddress: "G1",
          supplierAddress: "S1",
          logisticsAddress: "L1",
          arbiterAddress: "A1",
          tokenAddress: "T1",
          tokenDecimals: 7,
          tokenSymbol: "USDC",
          totalAmount: BigInt(10),
          releasedAmount: BigInt(0),
          status: ShipmentStatus.ACTIVE,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          milestones: [],
        },
      ];

      // Acceptance: mock prisma.$transaction to return shipments array + total count
      mockPrisma.$transaction.mockResolvedValueOnce([shipments, 25]);

      const res = await service.findAll({ page: 2, limit: 10 });

      expect(mockPrisma.shipment.findMany).toHaveBeenCalled();
      expect(mockPrisma.shipment.count).toHaveBeenCalled();

      expect(res.meta).toEqual(
        expect.objectContaining({
          page: 2,
          limit: 10,
          total: 25,
          totalPages: Math.ceil(25 / 10),
        }),
      );
    });

    it("filters by buyerAddress when the filter is provided", async () => {
      mockPrisma.$transaction.mockResolvedValueOnce([[], 0]);

      await service.findAll({ buyerAddress: "G-BUYER" });

      const calledWith = mockPrisma.shipment.findMany.mock.calls[0][0];
      expect(calledWith.where).toEqual(
        expect.objectContaining({ buyerAddress: "G-BUYER" }),
      );
    });
  });

  describe("findOne()", () => {
    it("throws NotFoundException when shipment is not found", async () => {
      mockPrisma.shipment.findUnique.mockResolvedValueOnce(null);

      await expect(service.findOne("SHIP-MISSING")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("serializes bigint fields to strings", async () => {
      mockPrisma.shipment.findUnique.mockResolvedValueOnce({
        id: "SHIP-1",
        buyerAddress: "G1",
        supplierAddress: "S1",
        logisticsAddress: "L1",
        arbiterAddress: "A1",
        tokenAddress: "T1",
        tokenDecimals: 7,
        tokenSymbol: "USDC",
        totalAmount: BigInt(123),
        releasedAmount: BigInt(45),
        status: ShipmentStatus.ACTIVE,
        arbiterStatus: ArbiterStatus.PENDING_ACCEPTANCE,
        createdAt: new Date(),
        milestones: [],
        events: [],
      });

      const res = await service.findOne("SHIP-1");
      expect(typeof res.totalAmount).toBe("string");
      expect(res.totalAmount).toBe("123");
      expect(typeof res.releasedAmount).toBe("string");
      expect(res.releasedAmount).toBe("45");
    });
  });

  describe("validateMetadata()", () => {
    it("returns valid=true for metadata matching the built-in schema", async () => {
      mockPrisma.shipment.findUnique.mockResolvedValueOnce({
        id: "SHIP-1",
        metadata: { incoterms: "FOB", portOfOrigin: "Lagos" },
      });

      const result = await service.validateMetadata("SHIP-1", "incoterms");

      expect(result).toEqual({ valid: true, errors: [] });
    });

    it("returns field-level errors for invalid metadata", async () => {
      mockPrisma.shipment.findUnique.mockResolvedValueOnce({
        id: "SHIP-1",
        metadata: { incoterms: "NOT_VALID", portOfOrigin: 42 },
      });

      const result = await service.validateMetadata("SHIP-1", "incoterms");

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/incoterms" }),
          expect.objectContaining({ path: "/portOfOrigin" }),
        ]),
      );
    });

    it("throws NotFoundException when the shipment has no metadata", async () => {
      mockPrisma.shipment.findUnique.mockResolvedValueOnce({
        id: "SHIP-1",
        metadata: null,
      });

      await expect(
        service.validateMetadata("SHIP-1", "incoterms"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

});
