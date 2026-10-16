import {
  ArbiterStatus,
  CommentVisibility,
  MilestoneStatus,
  NotificationType,
  PrismaClient,
  ShipmentStatus,
  UserRole,
} from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";

const prisma = new PrismaClient();

const addresses = {
  buyer: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey(),
  supplier: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey(),
  arbiter: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey(),
  admin: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey(),
  token: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).publicKey(),
};

const users = [
  {
    address: addresses.buyer,
    email: "seed.buyer@example.test",
    name: "Seed Buyer",
    role: UserRole.BUYER,
  },
  {
    address: addresses.supplier,
    email: "seed.supplier@example.test",
    name: "Seed Supplier",
    role: UserRole.SUPPLIER,
  },
  {
    address: addresses.arbiter,
    email: "seed.arbiter@example.test",
    name: "Seed Arbiter",
    role: UserRole.ARBITER,
  },
  {
    address: addresses.admin,
    email: "seed.admin@example.test",
    name: "Seed Admin",
    role: UserRole.ADMIN,
  },
];

const shipmentStatuses = [
  {
    id: "seed-draft-01",
    status: ShipmentStatus.ACTIVE,
    isDraft: true,
    description: "Draft shipment awaiting on-chain creation.",
  },
  {
    id: "seed-draft-02",
    status: ShipmentStatus.ACTIVE,
    isDraft: true,
    description: "Draft shipment for the next seasonal order.",
  },
  {
    id: "seed-active-01",
    status: ShipmentStatus.ACTIVE,
    isDraft: false,
    description: "Coffee beans from Kampala to Rotterdam.",
  },
  {
    id: "seed-active-02",
    status: ShipmentStatus.ACTIVE,
    isDraft: false,
    description: "Temperature-controlled pharmaceuticals.",
  },
  {
    id: "seed-active-03",
    status: ShipmentStatus.ACTIVE,
    isDraft: false,
    description: "Machinery parts headed to Singapore.",
  },
  {
    id: "seed-disputed-01",
    status: ShipmentStatus.ACTIVE,
    isDraft: false,
    description: "Textiles with a disputed quality milestone.",
  },
  {
    id: "seed-disputed-02",
    status: ShipmentStatus.ACTIVE,
    isDraft: false,
    description: "Electronics delivery with a proof dispute.",
  },
  {
    id: "seed-completed-01",
    status: ShipmentStatus.COMPLETED,
    isDraft: false,
    description: "Completed cocoa shipment.",
  },
  {
    id: "seed-completed-02",
    status: ShipmentStatus.COMPLETED,
    isDraft: false,
    description: "Completed spare-parts shipment.",
  },
  {
    id: "seed-cancelled-01",
    status: ShipmentStatus.CANCELLED,
    isDraft: false,
    description: "Cancelled shipment after a supplier delay.",
  },
] as const;

const disputedShipments = new Set(["seed-disputed-01", "seed-disputed-02"]);

async function main() {
  await prisma.$transaction(async (tx) => {
    const seededUsers = new Map<
      string,
      { id: string; stellarAddress: string }
    >();

    for (const user of users) {
      const record = await tx.user.upsert({
        where: { stellarAddress: user.address },
        update: {
          email: user.email,
          name: user.name,
          role: user.role,
          kycStatus: "VERIFIED",
        },
        create: {
          stellarAddress: user.address,
          email: user.email,
          name: user.name,
          role: user.role,
          kycStatus: "VERIFIED",
        },
        select: { id: true, stellarAddress: true },
      });
      seededUsers.set(user.address, record);
    }

    for (const [shipmentIndex, shipment] of shipmentStatuses.entries()) {
      const createdAt = new Date(
        Date.now() - (shipmentStatuses.length - shipmentIndex) * 86_400_000,
      );
      await tx.shipment.upsert({
        where: { id: shipment.id },
        update: {
          buyerAddress: addresses.buyer,
          supplierAddress: addresses.supplier,
          logisticsAddress: addresses.supplier,
          arbiterAddress: addresses.arbiter,
          tokenAddress: addresses.token,
          totalAmount: BigInt(250_000_000 + shipmentIndex * 25_000_000),
          releasedAmount:
            shipment.status === ShipmentStatus.COMPLETED
              ? BigInt(250_000_000 + shipmentIndex * 25_000_000)
              : BigInt(0),
          status: shipment.status,
          arbiterStatus: ArbiterStatus.ACCEPTED,
          description: shipment.description,
          referenceNumber: `SEED-PO-${String(shipmentIndex + 1).padStart(3, "0")}`,
          metadata: {
            seeded: true,
            scenario: shipment.isDraft
              ? "draft"
              : shipment.status.toLowerCase(),
          },
          tags: shipment.isDraft
            ? ["seed", "draft"]
            : ["seed", shipment.status.toLowerCase()],
          expectedDeliveryAt: new Date(createdAt.getTime() + 14 * 86_400_000),
          isDraft: shipment.isDraft,
          createdAt,
        },
        create: {
          id: shipment.id,
          buyerAddress: addresses.buyer,
          supplierAddress: addresses.supplier,
          logisticsAddress: addresses.supplier,
          arbiterAddress: addresses.arbiter,
          tokenAddress: addresses.token,
          totalAmount: BigInt(250_000_000 + shipmentIndex * 25_000_000),
          releasedAmount:
            shipment.status === ShipmentStatus.COMPLETED
              ? BigInt(250_000_000 + shipmentIndex * 25_000_000)
              : BigInt(0),
          status: shipment.status,
          arbiterStatus: ArbiterStatus.ACCEPTED,
          description: shipment.description,
          referenceNumber: `SEED-PO-${String(shipmentIndex + 1).padStart(3, "0")}`,
          metadata: {
            seeded: true,
            scenario: shipment.isDraft
              ? "draft"
              : shipment.status.toLowerCase(),
          },
          tags: shipment.isDraft
            ? ["seed", "draft"]
            : ["seed", shipment.status.toLowerCase()],
          expectedDeliveryAt: new Date(createdAt.getTime() + 14 * 86_400_000),
          isDraft: shipment.isDraft,
          createdAt,
        },
      });

      for (let milestoneIndex = 0; milestoneIndex < 2; milestoneIndex += 1) {
        const isDisputed =
          disputedShipments.has(shipment.id) && milestoneIndex === 1;
        const isCompleted = shipment.status === ShipmentStatus.COMPLETED;
        const milestoneId = `${shipment.id}-milestone-${milestoneIndex}`;
        await tx.milestone.upsert({
          where: { id: milestoneId },
          update: {
            name:
              milestoneIndex === 0
                ? "Pickup and dispatch"
                : "Delivery confirmation",
            paymentPercent: 50,
            status: isDisputed
              ? MilestoneStatus.DISPUTED
              : isCompleted
                ? MilestoneStatus.CONFIRMED
                : MilestoneStatus.PENDING,
            proofHash:
              isCompleted || isDisputed
                ? `bafyseed${shipmentIndex}${milestoneIndex}`
                : null,
            paymentReleased: isCompleted
              ? BigInt((250_000_000 + shipmentIndex * 25_000_000) / 2)
              : null,
            confirmedAt: isCompleted
              ? new Date(createdAt.getTime() + 7 * 86_400_000)
              : null,
            disputedAt: isDisputed
              ? new Date(createdAt.getTime() + 5 * 86_400_000)
              : null,
          },
          create: {
            id: milestoneId,
            shipmentId: shipment.id,
            milestoneIndex,
            name:
              milestoneIndex === 0
                ? "Pickup and dispatch"
                : "Delivery confirmation",
            paymentPercent: 50,
            status: isDisputed
              ? MilestoneStatus.DISPUTED
              : isCompleted
                ? MilestoneStatus.CONFIRMED
                : MilestoneStatus.PENDING,
            proofHash:
              isCompleted || isDisputed
                ? `bafyseed${shipmentIndex}${milestoneIndex}`
                : null,
            paymentReleased: isCompleted
              ? BigInt((250_000_000 + shipmentIndex * 25_000_000) / 2)
              : null,
            confirmedAt: isCompleted
              ? new Date(createdAt.getTime() + 7 * 86_400_000)
              : null,
            disputedAt: isDisputed
              ? new Date(createdAt.getTime() + 5 * 86_400_000)
              : null,
          },
        });
      }

      const commentId = `${shipment.id}-comment`;
      await tx.shipmentComment.upsert({
        where: { id: commentId },
        update: {
          body: `Seed comment for ${shipment.id}`,
          authorId: seededUsers.get(addresses.buyer)!.id,
        },
        create: {
          id: commentId,
          shipmentId: shipment.id,
          authorId: seededUsers.get(addresses.buyer)!.id,
          body: `Seed comment for ${shipment.id}`,
          visibility: CommentVisibility.ALL,
        },
      });
    }

    const notifications = [
      {
        id: "seed-notification-active",
        userId: seededUsers.get(addresses.buyer)!.id,
        type: NotificationType.SHIPMENT_CREATED,
        title: "Shipment created",
        message: "A seeded active shipment is ready to review.",
        shipmentId: "seed-active-01",
      },
      {
        id: "seed-notification-dispute",
        userId: seededUsers.get(addresses.arbiter)!.id,
        type: NotificationType.DISPUTE_RAISED,
        title: "Dispute raised",
        message: "A seeded shipment needs arbiter attention.",
        shipmentId: "seed-disputed-01",
      },
      {
        id: "seed-notification-complete",
        userId: seededUsers.get(addresses.supplier)!.id,
        type: NotificationType.PAYMENT_RELEASED,
        title: "Payment released",
        message: "A seeded shipment has completed.",
        shipmentId: "seed-completed-01",
      },
      {
        id: "seed-notification-cancelled",
        userId: seededUsers.get(addresses.buyer)!.id,
        type: NotificationType.SHIPMENT_CANCELLED,
        title: "Shipment cancelled",
        message: "A seeded shipment was cancelled.",
        shipmentId: "seed-cancelled-01",
      },
    ];

    for (const notification of notifications) {
      const { shipmentId, ...notificationData } = notification;
      await tx.notification.upsert({
        where: { id: notification.id },
        update: {
          ...notificationData,
          data: { shipmentId, seeded: true },
        },
        create: {
          ...notificationData,
          data: { shipmentId, seeded: true },
        },
      });
    }
  });

  console.log(
    `Seeded ${shipmentStatuses.length} shipments and ${users.length} users.`,
  );
}

main()
  .catch((error) => {
    console.error("Database seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
