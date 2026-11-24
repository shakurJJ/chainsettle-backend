import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { CreateContactDto, UpdateContactDto } from "./dto/contact.dto";

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  list(ownerId: string, query?: string) {
    const normalizedQuery = query?.trim();
    return this.prisma.contact.findMany({
      where: {
        ownerId,
        ...(normalizedQuery
          ? {
              OR: [
                { label: { contains: normalizedQuery, mode: "insensitive" } },
                {
                  stellarAddress: {
                    startsWith: normalizedQuery,
                    mode: "insensitive",
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ label: "asc" }, { createdAt: "asc" }],
    });
  }

  async create(ownerId: string, dto: CreateContactDto) {
    try {
      return await this.prisma.contact.create({ data: { ...dto, ownerId } });
    } catch (error) {
      this.throwOnDuplicate(error);
      throw error;
    }
  }

  async update(ownerId: string, id: string, dto: UpdateContactDto) {
    const existing = await this.prisma.contact.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Contact not found");

    try {
      return await this.prisma.contact.update({ where: { id }, data: dto });
    } catch (error) {
      this.throwOnDuplicate(error);
      throw error;
    }
  }

  async remove(ownerId: string, id: string) {
    const result = await this.prisma.contact.deleteMany({
      where: { id, ownerId },
    });
    if (result.count === 0) throw new NotFoundException("Contact not found");
    return { deleted: true };
  }

  async suggestions(ownerId: string, stellarAddress: string) {
    const [shipments, savedContacts] = await Promise.all([
      this.prisma.shipment.findMany({
        where: {
          isDraft: false,
          OR: [
            { buyerAddress: stellarAddress },
            { supplierAddress: stellarAddress },
            { logisticsAddress: stellarAddress },
            { arbiterAddress: stellarAddress },
          ],
        },
        select: {
          buyerAddress: true,
          supplierAddress: true,
          logisticsAddress: true,
          arbiterAddress: true,
        },
      }),
      this.prisma.contact.findMany({
        where: { ownerId },
        select: { stellarAddress: true },
      }),
    ]);

    const savedAddresses = new Set(
      savedContacts.map((contact) => contact.stellarAddress),
    );
    const shipmentCounts = new Map<string, number>();
    for (const shipment of shipments) {
      const counterparties = new Set([
        shipment.buyerAddress,
        shipment.supplierAddress,
        shipment.logisticsAddress,
        shipment.arbiterAddress,
      ]);
      counterparties.delete(stellarAddress);
      for (const address of counterparties) {
        shipmentCounts.set(address, (shipmentCounts.get(address) ?? 0) + 1);
      }
    }

    return [...shipmentCounts]
      .filter(([address]) => !savedAddresses.has(address))
      .map(([stellarAddress, shipmentCount]) => ({
        stellarAddress,
        shipmentCount,
      }))
      .sort(
        (left, right) =>
          right.shipmentCount - left.shipmentCount ||
          left.stellarAddress.localeCompare(right.stellarAddress),
      );
  }

  private throwOnDuplicate(error: unknown): void {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictException(
        "A contact with this Stellar address already exists",
      );
    }
  }
}
