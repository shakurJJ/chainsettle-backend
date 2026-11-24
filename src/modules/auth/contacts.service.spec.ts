import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ContactsService } from "./contacts.service";

describe("ContactsService", () => {
  let service: ContactsService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      contact: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      shipment: { findMany: jest.fn() },
    };
    service = new ContactsService(prisma);
  });

  it("scopes contact searches to the owner and searches label text or address prefixes", async () => {
    prisma.contact.findMany.mockResolvedValue([]);

    await service.list("owner-1", " Acme ");

    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ownerId: "owner-1",
          OR: [
            { label: { contains: "Acme", mode: "insensitive" } },
            { stellarAddress: { startsWith: "Acme", mode: "insensitive" } },
          ],
        },
      }),
    );
  });

  it("returns 409 when the owner saves a duplicate address", async () => {
    prisma.contact.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    await expect(
      service.create("owner-1", { stellarAddress: "GABC", label: "Acme" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("hides contacts owned by someone else on update", async () => {
    prisma.contact.findFirst.mockResolvedValue(null);

    await expect(
      service.update("owner-1", "other-contact", { label: "Changed" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it("suggests unsaved counterparties and counts each address once per shipment", async () => {
    prisma.shipment.findMany.mockResolvedValue([
      {
        buyerAddress: "GOWNER",
        supplierAddress: "GSUPPLIER",
        logisticsAddress: "GLOGISTICS",
        arbiterAddress: "GARBITER",
      },
      {
        buyerAddress: "GOWNER",
        supplierAddress: "GSUPPLIER",
        logisticsAddress: "GSUPPLIER",
        arbiterAddress: "GARBITER",
      },
    ]);
    prisma.contact.findMany.mockResolvedValue([{ stellarAddress: "GARBITER" }]);

    await expect(service.suggestions("owner-1", "GOWNER")).resolves.toEqual([
      { stellarAddress: "GSUPPLIER", shipmentCount: 2 },
      { stellarAddress: "GLOGISTICS", shipmentCount: 1 },
    ]);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { ownerId: "owner-1" },
      select: { stellarAddress: true },
    });
  });
});
