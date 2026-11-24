import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { CommentVisibility, NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { OrganizationsService } from '../organizations/organizations.service';

/** Maximum number of pinned comments allowed per shipment */
const MAX_PINNED_COMMENTS = 3;

/** Maximum comment body characters included in the SHIPMENT_COMMENT_CREATED webhook payload. */
const COMMENT_EXCERPT_LENGTH = 200;

/**
 * Stellar address regex — G followed by exactly 55 uppercase alphanumeric chars.
 * Used to extract @mentions from comment bodies.
 */
const STELLAR_ADDRESS_RE = /G[A-Z0-9]{55}/g;

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly organizations?: OrganizationsService,
    @Optional() private readonly webhooks?: WebhooksService,
  ) {}

  // ----------------------------------------------------------
  // POST /shipments/:id/comments
  // ----------------------------------------------------------

  async create(
    shipmentId: string,
    authorId: string,
    authorAddress: string,
    dto: CreateCommentDto,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);

    // Org members (#435) may comment unless their org role is VIEWER.
    if (
      !this.isParticipant(authorAddress, shipment) &&
      !(await this.organizations?.canCommentOnShipment(authorId, shipment))
    ) {
      throw new ForbiddenException('Only shipment participants can post comments');
    }

    // Replies (#299) must target a live comment on the same shipment that the
    // author is allowed to see.
    if (dto.parentCommentId) {
      const parent = await this.prisma.shipmentComment.findFirst({
        where: {
          id: dto.parentCommentId,
          shipmentId,
          deletedAt: null,
          visibility: { in: this.buildVisibilityFilter(authorAddress, shipment, false) },
        },
      });
      if (!parent) throw new NotFoundException(`Comment ${dto.parentCommentId} not found`);
    }

    // Milestone-scoped comments (#396) must reference a live milestone.
    if (dto.milestoneIndex !== undefined && dto.milestoneIndex !== null) {
      const milestone = await this.prisma.milestone.findFirst({
        where: { shipmentId, milestoneIndex: dto.milestoneIndex, deletedAt: null },
        select: { id: true },
      });
      if (!milestone) {
        throw new BadRequestException(
          `Milestone ${dto.milestoneIndex} does not exist on shipment ${shipmentId}`,
        );
      }
    }

    const comment = await this.prisma.shipmentComment.create({
      data: {
        shipmentId,
        authorId,
        body: dto.body,
        visibility: dto.visibility ?? CommentVisibility.ALL,
        attachmentCid: dto.attachmentCid,
        parentCommentId: dto.parentCommentId ?? null,
        milestoneIndex: dto.milestoneIndex ?? null,
      },
      include: { author: { select: { id: true, stellarAddress: true, name: true, avatarCid: true } } },
    });

    this.logger.log(`Comment created on shipment ${shipmentId} by ${authorAddress}`);

    // Webhook for external integrations (ERPs, chat bridges) — dispatched once
    // per comment, independent of participants' notification preferences.
    // Fire-and-forget: a webhook failure must not fail comment creation.
    this.webhooks
      ?.dispatch(NotificationType.SHIPMENT_COMMENT_CREATED, {
        shipmentId,
        commentId: comment.id,
        authorAddress,
        bodyExcerpt: comment.body.slice(0, COMMENT_EXCERPT_LENGTH),
        createdAt: comment.createdAt.toISOString(),
      })
      .catch((err) =>
        this.logger.error(
          `Webhook dispatch error for SHIPMENT_COMMENT_CREATED (comment ${comment.id})`,
          err.message,
        ),
      );

    // Notify all participants who can see this comment
    await this.notifyParticipants(shipment, comment, authorAddress);

    // Parse @mentions and send COMMENT_MENTION notifications (#190)
    const mentionedAddresses = await this.handleMentions(
      dto.body,
      shipment,
      comment,
      authorAddress,
    );

    return { ...comment, author: this.formatAuthor(comment.author), mentionedAddresses };
  }

  // ----------------------------------------------------------
  // GET /shipments/:id/comments
  // ----------------------------------------------------------

  /**
   * Returns root comments only (parentCommentId = null), each with a
   * `replyCount` of the visible, non-deleted replies. Replies are fetched via
   * GET /shipments/:id/comments/:commentId/replies (#299).
   *
   * A soft-deleted root that still has visible replies is returned as a
   * tombstone (`deleted: true`, body and attachment redacted) so its thread
   * stays reachable.
   */
  async findAll(
    shipmentId: string,
    requesterAddress: string,
    page = 1,
    limit = 20,
    milestoneIndex?: number,
  ) {
    const { shipment, isAdmin } = await this.loadForRead(shipmentId, requesterAddress);
    const visibility = { in: this.buildVisibilityFilter(requesterAddress, shipment, isAdmin) };
    const visibleReplies = { deletedAt: null, visibility };

    const where = {
      shipmentId,
      parentCommentId: null,
      ...(milestoneIndex !== undefined ? { milestoneIndex } : {}),
      visibility,
      OR: [{ deletedAt: null }, { replies: { some: visibleReplies } }],
    };

    // Pinned comments sort first (by pinnedAt ASC), then the rest chronologically (#189)
    const [comments, total] = await this.prisma.$transaction([
      this.prisma.shipmentComment.findMany({
        where,
        include: {
          author: { select: { id: true, stellarAddress: true, name: true, avatarCid: true } },
          _count: { select: { replies: { where: visibleReplies } } },
        },
        orderBy: [
          // nulls last: pinned comments (pinnedAt != null) come first
          { pinnedAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.shipmentComment.count({ where }),
    ]);

    const data = comments.map(({ _count, ...comment }) => ({
      ...this.redactIfDeleted(comment),
      author: this.formatAuthor(comment.author),
      replyCount: _count.replies,
    }));

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ----------------------------------------------------------
  // GET /shipments/:id/comments/:commentId/replies  (#299)
  // ----------------------------------------------------------

  /**
   * Returns the direct replies to a comment, oldest first. Works even when the
   * parent has been soft-deleted, so deleting a parent never strands its
   * replies.
   */
  async findReplies(
    shipmentId: string,
    commentId: string,
    requesterAddress: string,
    page = 1,
    limit = 20,
  ) {
    const { shipment, isAdmin } = await this.loadForRead(shipmentId, requesterAddress);
    const visibility = { in: this.buildVisibilityFilter(requesterAddress, shipment, isAdmin) };

    const parent = await this.prisma.shipmentComment.findFirst({
      where: { id: commentId, shipmentId, visibility },
    });
    if (!parent) throw new NotFoundException(`Comment ${commentId} not found`);

    const where = { shipmentId, parentCommentId: commentId, deletedAt: null, visibility };

    const [replies, total] = await this.prisma.$transaction([
      this.prisma.shipmentComment.findMany({
        where,
        include: { author: { select: { id: true, stellarAddress: true, name: true, avatarCid: true } } },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.shipmentComment.count({ where }),
    ]);

    const data = replies.map((reply) => ({
      ...this.redactIfDeleted(reply),
      author: this.formatAuthor(reply.author),
    }));

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ----------------------------------------------------------
  // PATCH /shipments/:id/comments/:commentId/pin  (#189)
  // ----------------------------------------------------------

  async setPinned(
    shipmentId: string,
    commentId: string,
    pinned: boolean,
    requesterId: string,
    requesterAddress: string,
  ) {
    const comment = await this.prisma.shipmentComment.findFirst({
      where: { id: commentId, shipmentId, deletedAt: null },
    });
    if (!comment) throw new NotFoundException(`Comment ${commentId} not found`);

    // A soft-deleted comment cannot be pinned
    if (pinned && comment.deletedAt !== null) {
      throw new BadRequestException('Cannot pin a deleted comment');
    }

    if (pinned) {
      // Enforce max 3 pinned per shipment
      const pinnedCount = await this.prisma.shipmentComment.count({
        where: { shipmentId, pinnedAt: { not: null }, deletedAt: null },
      });

      if (pinnedCount >= MAX_PINNED_COMMENTS) {
        throw new ConflictException(
          `Cannot pin more than ${MAX_PINNED_COMMENTS} comments per shipment. Unpin one first.`,
        );
      }
    }

    const updated = await this.prisma.shipmentComment.update({
      where: { id: commentId },
      data: { pinnedAt: pinned ? new Date() : null },
      include: { author: { select: { id: true, stellarAddress: true, name: true, avatarCid: true } } },
    });

    this.logger.log(
      `Comment ${commentId} ${pinned ? 'pinned' : 'unpinned'} by ${requesterAddress}`,
    );

    return { ...updated, author: this.formatAuthor(updated.author) };
  }

  // ----------------------------------------------------------
  // DELETE /shipments/:id/comments/:commentId
  // ----------------------------------------------------------

  async remove(shipmentId: string, commentId: string, requesterId: string, requesterAddress: string) {
    const comment = await this.prisma.shipmentComment.findFirst({
      where: { id: commentId, shipmentId, deletedAt: null },
    });
    if (!comment) throw new NotFoundException(`Comment ${commentId} not found`);

    const requester = await this.prisma.user.findUnique({
      where: { stellarAddress: requesterAddress },
    });
    const isAdmin = requester?.role === 'ADMIN';

    if (comment.authorId !== requesterId && !isAdmin) {
      throw new ForbiddenException('Only the comment author or an admin can delete this comment');
    }

    await this.prisma.shipmentComment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() },
    });

    this.logger.log(`Comment ${commentId} soft-deleted by ${requesterAddress}`);
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  /** Loads the shipment and enforces read access (participants and admins). */
  private async loadForRead(shipmentId: string, requesterAddress: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);

    const requester = await this.prisma.user.findUnique({
      where: { stellarAddress: requesterAddress },
    });
    const isAdmin = requester?.role === 'ADMIN';

    if (
      !isAdmin &&
      !this.isParticipant(requesterAddress, shipment) &&
      !(requester && (await this.organizations?.canReadShipment(requester.id, shipment)))
    ) {
      throw new ForbiddenException('Only shipment participants can read comments');
    }

    return { shipment, isAdmin };
  }

  private formatAuthor(author: any) {
    if (!author) return author;
    return {
      ...author,
      avatarUrl: author.avatarCid ? `/api/v1/ipfs/${author.avatarCid}` : null,
    };
  }

  private redactIfDeleted<T extends { deletedAt: Date | null }>(comment: T) {
    if (!comment.deletedAt) return { ...comment, deleted: false };
    return { ...comment, body: null, attachmentCid: null, deleted: true };
  }

  private isParticipant(address: string, shipment: any): boolean {
    return [
      shipment.buyerAddress,
      shipment.supplierAddress,
      shipment.logisticsAddress,
      shipment.arbiterAddress,
    ].includes(address);
  }

  private buildVisibilityFilter(
    address: string,
    shipment: any,
    isAdmin: boolean,
  ): CommentVisibility[] {
    if (isAdmin) return [CommentVisibility.ALL, CommentVisibility.BUYER_SUPPLIER, CommentVisibility.INTERNAL];

    const isBuyerOrSupplier =
      address === shipment.buyerAddress || address === shipment.supplierAddress;
    const isInternalParty =
      address === shipment.logisticsAddress || address === shipment.arbiterAddress;

    const filter: CommentVisibility[] = [CommentVisibility.ALL];
    if (isBuyerOrSupplier) filter.push(CommentVisibility.BUYER_SUPPLIER);
    if (isInternalParty) filter.push(CommentVisibility.INTERNAL);
    return filter;
  }

  private async notifyParticipants(shipment: any, comment: any, authorAddress: string) {
    const eligibleAddresses = new Set<string>();

    if (
      comment.visibility === CommentVisibility.ALL ||
      comment.visibility === CommentVisibility.BUYER_SUPPLIER
    ) {
      eligibleAddresses.add(shipment.buyerAddress);
      eligibleAddresses.add(shipment.supplierAddress);
    }
    if (
      comment.visibility === CommentVisibility.ALL ||
      comment.visibility === CommentVisibility.INTERNAL
    ) {
      eligibleAddresses.add(shipment.logisticsAddress);
      eligibleAddresses.add(shipment.arbiterAddress);
    }

    // Don't notify the author
    eligibleAddresses.delete(authorAddress);

    for (const address of eligibleAddresses) {
      await this.notifications.notifyUser(
        address,
        NotificationType.COMMENT_ADDED,
        'New comment on shipment',
        `A new comment has been added to shipment ${shipment.id}.`,
        { shipmentId: shipment.id, commentId: comment.id },
      );
    }
  }

  /**
   * Parses @<StellarAddress> mentions from the comment body (#190).
   * For each address that is a participant on the shipment, sends a
   * COMMENT_MENTION notification that always triggers an email regardless
   * of the user's digest preference.
   *
   * Non-participant addresses are silently ignored.
   * Returns the list of addresses that received mention notifications.
   */
  private async handleMentions(
    body: string,
    shipment: any,
    comment: any,
    authorAddress: string,
  ): Promise<string[]> {
    const rawMatches = body.match(STELLAR_ADDRESS_RE) ?? [];
    if (rawMatches.length === 0) return [];

    // Deduplicate
    const unique = [...new Set(rawMatches)];

    const participants = new Set<string>([
      shipment.buyerAddress,
      shipment.supplierAddress,
      shipment.logisticsAddress,
      shipment.arbiterAddress,
    ]);

    const mentionedAddresses: string[] = [];

    for (const address of unique) {
      // Silently ignore non-participants
      if (!participants.has(address)) continue;
      // Don't send a mention notification to the author (they're writing the comment)
      if (address === authorAddress) continue;

      mentionedAddresses.push(address);

      // Send COMMENT_MENTION — always email regardless of digest preference
      await this.notifications.notifyUserWithForcedEmail(
        address,
        NotificationType.COMMENT_MENTION,
        'You were mentioned in a comment',
        `You were mentioned in a comment on shipment ${shipment.id}.`,
        { shipmentId: shipment.id, commentId: comment.id, mentionedBy: authorAddress },
      );
    }

    return mentionedAddresses;
  }
}
