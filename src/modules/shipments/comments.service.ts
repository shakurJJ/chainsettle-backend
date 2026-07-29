import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CommentVisibility, NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateCommentDto } from './dto/create-comment.dto';

/** Maximum number of pinned comments allowed per shipment */
const MAX_PINNED_COMMENTS = 3;

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

    if (!this.isParticipant(authorAddress, shipment)) {
      throw new ForbiddenException('Only shipment participants can post comments');
    }

    const comment = await this.prisma.shipmentComment.create({
      data: {
        shipmentId,
        authorId,
        body: dto.body,
        visibility: dto.visibility ?? CommentVisibility.ALL,
        attachmentCid: dto.attachmentCid,
      },
      include: { author: { select: { id: true, stellarAddress: true, name: true } } },
    });

    this.logger.log(`Comment created on shipment ${shipmentId} by ${authorAddress}`);

    // Notify all participants who can see this comment
    await this.notifyParticipants(shipment, comment, authorAddress);

    // Parse @mentions and send COMMENT_MENTION notifications (#190)
    const mentionedAddresses = await this.handleMentions(
      dto.body,
      shipment,
      comment,
      authorAddress,
    );

    return { ...comment, mentionedAddresses };
  }

  // ----------------------------------------------------------
  // GET /shipments/:id/comments
  // ----------------------------------------------------------

  async findAll(
    shipmentId: string,
    requesterAddress: string,
    page = 1,
    limit = 20,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} not found`);

    const requester = await this.prisma.user.findUnique({
      where: { stellarAddress: requesterAddress },
    });
    const isAdmin = requester?.role === 'ADMIN';

    if (!isAdmin && !this.isParticipant(requesterAddress, shipment)) {
      throw new ForbiddenException('Only shipment participants can read comments');
    }

    const visibilityFilter = this.buildVisibilityFilter(requesterAddress, shipment, isAdmin);

    const where = {
      shipmentId,
      deletedAt: null,
      visibility: { in: visibilityFilter },
    };

    // Pinned comments sort first (by pinnedAt ASC), then the rest chronologically (#189)
    const [comments, total] = await this.prisma.$transaction([
      this.prisma.shipmentComment.findMany({
        where,
        include: { author: { select: { id: true, stellarAddress: true, name: true } } },
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

    return { data: comments, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
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
      include: { author: { select: { id: true, stellarAddress: true, name: true } } },
    });

    this.logger.log(
      `Comment ${commentId} ${pinned ? 'pinned' : 'unpinned'} by ${requesterAddress}`,
    );

    return updated;
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
