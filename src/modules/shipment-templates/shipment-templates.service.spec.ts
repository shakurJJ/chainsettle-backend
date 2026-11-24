import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ShipmentTemplatesService } from "./shipment-templates.service";

describe("ShipmentTemplatesService — soft delete (#306)", () => {
  let service: ShipmentTemplatesService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      shipment: { findUnique: jest.fn() },
      shipmentTemplate: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn(),
      },
      recurringSchedule: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
    };
    service = new ShipmentTemplatesService(prisma, {
      record: jest.fn(),
    } as any);
  });

  it("creates a template for the supplied owner with valid milestone percentages", async () => {
    const dto = {
      name: "Standard shipment",
      milestoneTemplates: [{ name: "Delivery", paymentPercent: 100 }],
    };
    prisma.shipmentTemplate.create = jest
      .fn()
      .mockResolvedValue({ id: "t1", ownerId: "owner-1" });

    await expect(service.create(dto as any, "owner-1")).resolves.toMatchObject({
      id: "t1",
      ownerId: "owner-1",
    });
    expect(prisma.shipmentTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: "owner-1",
        name: "Standard shipment",
        milestoneTemplates: dto.milestoneTemplates,
        isPublic: false,
      }),
    });
  });

  it("rejects a template whose milestone percentages do not total 100", async () => {
    await expect(
      service.create(
        {
          milestoneTemplates: [{ name: "Delivery", paymentPercent: 90 }],
        } as any,
        "owner-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.shipmentTemplate.create).not.toHaveBeenCalled();
  });

  it("rejects updates and deletions by non-owners", async () => {
    prisma.shipmentTemplate.findFirst.mockResolvedValue({
      id: "t1",
      ownerId: "owner-1",
    });

    await expect(
      service.update("t1", "other-owner", { name: "Changed" } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.delete("t1", "other-owner")).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(prisma.shipmentTemplate.update).not.toHaveBeenCalled();
  });

  it("lists owned and public templates with pagination", async () => {
    prisma.shipmentTemplate.findMany.mockResolvedValue([
      { id: "public-template", isPublic: true },
    ]);
    prisma.shipmentTemplate.count.mockResolvedValue(21);

    const result = await service.findAll("owner-1", 2, 10);

    expect(prisma.shipmentTemplate.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [{ ownerId: "owner-1" }, { isPublic: true }],
      },
      skip: 10,
      take: 10,
      orderBy: { createdAt: "desc" },
    });
    expect(result).toEqual({
      data: [{ id: "public-template", isPublic: true }],
      pagination: { page: 2, limit: 10, total: 21, pages: 3 },
    });
  });

  it("duplicates a shipment structure into a template for the buyer", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    prisma.shipment.findUnique.mockResolvedValue({
      id: "shipment-1",
      buyerAddress: "buyer-address",
      supplierAddress: "supplier-address",
      logisticsAddress: "logistics-address",
      arbiterAddress: "arbiter-address",
      tokenAddress: "token-address",
      createdAt,
      milestones: [
        {
          name: "Delivery",
          paymentPercent: 100,
          dueAt: new Date("2026-01-04T00:00:00.000Z"),
          checklistItems: [{ label: "Inspect goods", required: true }],
        },
      ],
    });
    prisma.shipmentTemplate.create = jest.fn().mockResolvedValue({ id: "t2" });

    await expect(
      service.createFromShipment("owner-1", "buyer-address", "shipment-1", {
        name: "Copied",
        milestoneTemplates: [],
      } as any),
    ).resolves.toEqual({ id: "t2" });

    expect(prisma.shipmentTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: "owner-1",
        name: "Copied",
        supplierAddress: "supplier-address",
        logisticsAddress: "logistics-address",
        arbiterAddress: "arbiter-address",
        tokenAddress: "token-address",
        milestoneTemplates: [
          {
            name: "Delivery",
            paymentPercent: 100,
            dueDays: 3,
            checklist: [{ label: "Inspect goods", required: true }],
          },
        ],
      }),
    });
  });

  it("does not allow a non-buyer to duplicate a shipment as a template", async () => {
    prisma.shipment.findUnique.mockResolvedValue({
      id: "shipment-1",
      buyerAddress: "buyer-address",
    });

    await expect(
      service.createFromShipment("owner-1", "supplier-address", "shipment-1", {
        name: "Copied",
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.shipmentTemplate.create).not.toHaveBeenCalled();
  });

  it("sets deletedAt instead of removing the row", async () => {
    prisma.shipmentTemplate.findFirst.mockResolvedValue({
      id: "t1",
      ownerId: "owner-1",
    });

    await expect(service.delete("t1", "owner-1")).resolves.toEqual({
      success: true,
    });

    expect(prisma.shipmentTemplate.delete).not.toHaveBeenCalled();
    expect(prisma.shipmentTemplate.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("deactivates recurring schedules that depend on the deleted template (#389)", async () => {
    prisma.shipmentTemplate.findFirst.mockResolvedValue({
      id: "t1",
      ownerId: "owner-1",
    });

    await service.delete("t1", "owner-1");

    expect(prisma.recurringSchedule.updateMany).toHaveBeenCalledWith({
      where: { templateId: "t1", active: true },
      data: { active: false },
    });
  });

  it("treats a soft-deleted template as not found", async () => {
    prisma.shipmentTemplate.findFirst.mockResolvedValue(null);

    await expect(service.findOne("t1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.shipmentTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: "t1", deletedAt: null },
    });
  });

  it("excludes soft-deleted templates from list queries", async () => {
    await service.findAll("owner-1");
    await service.findMine("owner-1");

    for (const [args] of prisma.shipmentTemplate.findMany.mock.calls) {
      expect(args.where.deletedAt).toBeNull();
    }
    for (const [args] of prisma.shipmentTemplate.count.mock.calls) {
      expect(args.where.deletedAt).toBeNull();
    }
  });
});
