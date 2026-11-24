import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { KycStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface KycReviewer {
  id: string;
  stellarAddress: string;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Manual KYC review queue (#428). Admins approve or reject cases the provider
 * flagged for review. Only the opaque `kycReference` is ever exposed — raw
 * identity documents are never stored or returned. Every decision is audited
 * with its reason and the user is notified.
 */
@Injectable()
export class KycReviewService {
  private readonly logger = new Logger(KycReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Oldest cases first. `ageHours` is measured from when the case entered review. */
  async listQueue(status: KycStatus = KycStatus.PENDING, page = 1, limit = 20, now: Date = new Date()) {
    const where = { kycStatus: status, deactivatedAt: null };
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: [{ kycSubmittedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          stellarAddress: true,
          name: true,
          role: true,
          kycStatus: true,
          kycReference: true,
          kycSubmittedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const data = users.map((u) => {
      const since = u.kycSubmittedAt ?? u.createdAt;
      return {
        ...u,
        ageHours: Math.max(0, Math.floor((now.getTime() - since.getTime()) / HOUR_MS)),
      };
    });
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  approve(userId: string, reviewer: KycReviewer, reason?: string) {
    return this.decide(userId, reviewer, KycStatus.VERIFIED, reason);
  }

  reject(userId: string, reviewer: KycReviewer, reason: string) {
    return this.decide(userId, reviewer, KycStatus.REJECTED, reason);
  }

  private async decide(userId: string, reviewer: KycReviewer, decision: KycStatus, reason?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        stellarAddress: true,
        kycStatus: true,
        kycReference: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.kycStatus !== KycStatus.PENDING) {
      throw new ConflictException(`KYC case is ${user.kycStatus}, only PENDING cases can be reviewed`);
    }

    // Conditional update guards against two admins deciding the same case concurrently.
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, kycStatus: KycStatus.PENDING },
      data: { kycStatus: decision },
    });
    if (count === 0) throw new ConflictException('KYC case was already reviewed');

    const trimmedReason = reason?.trim() || undefined;
    await this.auditLog.record({
      actorId: reviewer.id,
      actorAddress: reviewer.stellarAddress,
      action: decision === KycStatus.VERIFIED ? 'KYC_MANUALLY_APPROVED' : 'KYC_MANUALLY_REJECTED',
      resourceType: 'User',
      resourceId: userId,
      metadata: {
        previousStatus: user.kycStatus,
        newStatus: decision,
        reason: trimmedReason ?? null,
        kycReference: user.kycReference,
      },
    });

    const approved = decision === KycStatus.VERIFIED;
    try {
      await this.notifications.notifyUser(
        user.stellarAddress,
        NotificationType.SYSTEM_ALERT,
        approved ? 'Identity verification approved' : 'Identity verification rejected',
        approved
          ? 'Your identity verification has been approved.'
          : `Your identity verification was rejected: ${trimmedReason}`,
        { kind: 'KYC_DECISION', kycStatus: decision },
      );
    } catch (err) {
      // The decision stands even if the notification channel fails.
      this.logger.warn(`Failed to notify user ${userId} of KYC decision: ${err.message}`);
    }

    this.logger.log(`KYC case for user ${userId} ${approved ? 'approved' : 'rejected'} by ${reviewer.id}`);
    return { userId, kycStatus: decision };
  }
}
