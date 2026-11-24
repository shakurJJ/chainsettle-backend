import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { CommentVisibility, NotificationType } from "@prisma/client";
import { CommentsService } from "./comments.service";

jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));
jest.mock("../organizations/organizations.service", () => ({
  OrganizationsService: class OrganizationsService {},
}));
jest.mock("../outbox/outbox.service", () => ({
  OutboxService: class OutboxService {},
}));

const BUYER = "G" + "B".repeat(55);
const SUPPLIER = "G" + "S".repeat(55);
const LOGISTICS = "G" + "L".repeat(55);
const ARBITER = "G" + "A".repeat(55);
const CREATED_AT = new Date("2026-10-20T10:00:00.000Z");

const shipment = {
  id: "SHIP-1",
  buyerAddress: BUYER,
  supplierAddress: SUPPLIER,
  logisticsAddress: LOGISTICS,
  arbiterAddress: ARBITER,
};

describe("CommentsService — threaded replies (#299)", () => {
  let service: CommentsService;
  let prisma: any;
  let notifications: any;
  let outbox: any;

  beforeEach(() => {
    prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue(shipment) },
      user: { findUnique: jest.fn().mockResolvedValue({ role: "USER" }) },
      shipmentComment: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: "reply-1", createdAt: CREATED_AT, ...data }),
          ),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    prisma.$transaction = jest.fn((arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg),
    );
    notifications = {
      notifyUser: jest.fn().mockResolvedValue(undefined),
      notifyUserWithForcedEmail: jest.fn().mockResolvedValue(undefined),
    };
    outbox = {
      enqueue: jest.fn().mockResolvedValue({}),
    };
    service = new CommentsService(
      prisma,
      notifications as any,
      undefined,
      outbox as any,
    );
  });

  it("stores parentCommentId when replying to a live comment on the same shipment", async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue({ id: "parent-1" });

    const reply = await service.create("SHIP-1", "user-1", BUYER, {
      body: "agreed",
      parentCommentId: "parent-1",
    });

    expect(prisma.shipmentComment.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "parent-1",
        shipmentId: "SHIP-1",
        deletedAt: null,
      }),
    });
    expect(reply.parentCommentId).toBe("parent-1");
  });

  it("rejects a reply to a comment that does not exist on the shipment", async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue(null);

    await expect(
      service.create("SHIP-1", "user-1", BUYER, {
        body: "hi",
        parentCommentId: "missing",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.shipmentComment.create).not.toHaveBeenCalled();
  });

  it("creates a root comment when no parentCommentId is given", async () => {
    const comment = await service.create("SHIP-1", "user-1", BUYER, {
      body: "hello",
    });

    expect(prisma.shipmentComment.findFirst).not.toHaveBeenCalled();
    expect(comment.parentCommentId).toBeNull();
  });

  it("lists replies of a comment, oldest first", async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue({ id: "parent-1" });
    prisma.shipmentComment.findMany.mockResolvedValue([
      { id: "reply-1" },
      { id: "reply-2" },
    ]);
    prisma.shipmentComment.count.mockResolvedValue(2);

    const result = await service.findReplies("SHIP-1", "parent-1", BUYER);

    const args = prisma.shipmentComment.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      shipmentId: "SHIP-1",
      parentCommentId: "parent-1",
      deletedAt: null,
    });
    expect(args.orderBy).toEqual({ createdAt: "asc" });
    expect(result.data.map((r: any) => r.id)).toEqual(["reply-1", "reply-2"]);
    expect(result.meta.total).toBe(2);
  });

  it("still lists replies when the parent comment is soft-deleted", async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue({
      id: "parent-1",
      deletedAt: new Date(),
    });
    prisma.shipmentComment.findMany.mockResolvedValue([{ id: "reply-1" }]);
    prisma.shipmentComment.count.mockResolvedValue(1);

    const result = await service.findReplies("SHIP-1", "parent-1", BUYER);

    // Parent lookup must not filter on deletedAt
    expect(
      prisma.shipmentComment.findFirst.mock.calls[0][0].where,
    ).not.toHaveProperty("deletedAt");
    expect(result.data).toHaveLength(1);
  });

  it("404s for replies of a comment the requester cannot see", async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue(null);

    await expect(
      service.findReplies("SHIP-1", "internal-1", BUYER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects comments from non-participants", async () => {
    const outsider = "G" + "O".repeat(55);

    await expect(
      service.create("SHIP-1", "outsider-1", outsider, { body: "hello" }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.shipmentComment.create).not.toHaveBeenCalled();
  });

  it("allows only the author or an admin to soft-delete a comment", async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue({
      id: "comment-1",
      authorId: "author-1",
    });
    prisma.user.findUnique.mockResolvedValue({ role: "USER" });

    await expect(
      service.remove("SHIP-1", "comment-1", "other-user", BUYER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.shipmentComment.update).not.toHaveBeenCalled();

    await service.remove("SHIP-1", "comment-1", "author-1", BUYER);

    expect(prisma.shipmentComment.update).toHaveBeenCalledWith({
      where: { id: "comment-1" },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("applies pagination to root comments and reports the page count", async () => {
    prisma.shipmentComment.count.mockResolvedValue(31);

    const result = await service.findAll("SHIP-1", BUYER, 2, 10);

    expect(prisma.shipmentComment.findMany.mock.calls[0][0]).toMatchObject({
      skip: 10,
      take: 10,
    });
    expect(result.meta).toEqual({
      total: 31,
      page: 2,
      limit: 10,
      totalPages: 4,
    });
  });

  it("notifies each mentioned participant once and ignores outsiders and the author", async () => {
    const outsider = "G" + "O".repeat(55);
    const comment = await service.create("SHIP-1", "buyer-1", BUYER, {
      body: `Please review ${SUPPLIER} and ${SUPPLIER}; ignore ${outsider} and ${BUYER}`,
    });

    expect(notifications.notifyUserWithForcedEmail).toHaveBeenCalledTimes(1);
    expect(notifications.notifyUserWithForcedEmail).toHaveBeenCalledWith(
      SUPPLIER,
      NotificationType.COMMENT_MENTION,
      "You were mentioned in a comment",
      "You were mentioned in a comment on shipment SHIP-1.",
      { shipmentId: "SHIP-1", commentId: "reply-1", mentionedBy: BUYER },
    );
    expect(comment.mentionedAddresses).toEqual([SUPPLIER]);
  });

  it("lists root comments only, with replyCount, and redacts deleted roots that still have replies", async () => {
    const deletedAt = new Date();
    prisma.shipmentComment.findMany.mockResolvedValue([
      {
        id: "c1",
        body: "live",
        attachmentCid: null,
        deletedAt: null,
        _count: { replies: 2 },
      },
      {
        id: "c2",
        body: "secret",
        attachmentCid: "cid",
        deletedAt,
        _count: { replies: 1 },
      },
    ]);
    prisma.shipmentComment.count.mockResolvedValue(2);

    const result = await service.findAll("SHIP-1", BUYER);

    const where = prisma.shipmentComment.findMany.mock.calls[0][0].where;
    expect(where.parentCommentId).toBeNull();
    expect(where.OR).toEqual([
      { deletedAt: null },
      { replies: { some: { deletedAt: null, visibility: where.visibility } } },
    ]);
    expect(where.visibility.in).toEqual([
      CommentVisibility.ALL,
      CommentVisibility.BUYER_SUPPLIER,
    ]);

    expect(result.data[0]).toMatchObject({
      id: "c1",
      body: "live",
      replyCount: 2,
      deleted: false,
    });
    expect(result.data[0]).not.toHaveProperty("_count");
    expect(result.data[1]).toMatchObject({
      id: "c2",
      body: null,
      attachmentCid: null,
      replyCount: 1,
      deleted: true,
    });
  });
});

describe("CommentsService — SHIPMENT_COMMENT_CREATED webhook (#537)", () => {
  let service: CommentsService;
  let prisma: any;
  let notifications: any;
  let outbox: any;

  beforeEach(() => {
    prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue(shipment) },
      user: { findUnique: jest.fn().mockResolvedValue({ role: "USER" }) },
      shipmentComment: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: "comment-1", createdAt: CREATED_AT, ...data }),
          ),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    prisma.$transaction = jest.fn((arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg),
    );
    notifications = {
      notifyUser: jest.fn().mockResolvedValue(undefined),
      notifyUserWithForcedEmail: jest.fn().mockResolvedValue(undefined),
    };
    outbox = {
      enqueue: jest.fn().mockResolvedValue({}),
    };
    service = new CommentsService(
      prisma,
      notifications as any,
      undefined,
      outbox as any,
    );
  });

  it("enqueues SHIPMENT_COMMENT_CREATED in the same transaction as the comment", async () => {
    await service.create("SHIP-1", "user-1", BUYER, { body: "hello world" });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      prisma,
      NotificationType.SHIPMENT_COMMENT_CREATED,
      {
        shipmentId: "SHIP-1",
        commentId: "comment-1",
        authorAddress: BUYER,
        bodyExcerpt: "hello world",
        createdAt: "2026-10-20T10:00:00.000Z",
      },
    );
  });

  it("truncates the body excerpt to 200 characters", async () => {
    await service.create("SHIP-1", "user-1", BUYER, { body: "x".repeat(500) });

    const payload = outbox.enqueue.mock.calls[0][2];
    expect(payload.bodyExcerpt).toHaveLength(200);
    expect(payload.bodyExcerpt).toBe("x".repeat(200));
  });

  it("does not enqueue an outbox event when comment creation is rejected", async () => {
    const outsider = "G" + "O".repeat(55);

    await expect(
      service.create("SHIP-1", "outsider-1", outsider, { body: "hi" }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("fails the transaction when the outbox insert fails, so comment and event stay consistent", async () => {
    outbox.enqueue.mockRejectedValue(new Error("outbox insert failed"));

    await expect(
      service.create("SHIP-1", "user-1", BUYER, { body: "hello" }),
    ).rejects.toThrow("outbox insert failed");
  });

  it("still creates the comment when no webhook service is wired", async () => {
    const bare = new CommentsService(prisma, notifications as any);

    const comment = await bare.create("SHIP-1", "user-1", BUYER, {
      body: "hello",
    });

    expect(comment.id).toBe("comment-1");
  });
});
