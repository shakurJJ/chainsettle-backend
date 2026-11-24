import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailSuppressionReason, NotificationType } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';

/** Header carrying `hex(HMAC-SHA256(EMAIL_WEBHOOK_SECRET, rawBody))`. */
export const EMAIL_SIGNATURE_HEADER = 'x-email-signature';

export interface EmailProviderEvent {
  /** Provider event type, e.g. "bounce", "hard_bounce", "complaint", "spamreport". */
  type?: string;
  event?: string;
  email?: string;
  recipient?: string;
  /** "hard" / "permanent" for hard bounces; soft bounces are ignored. */
  bounceType?: string;
}

const COMPLAINT_TYPES = new Set(['complaint', 'spamreport', 'spam_report', 'abuse']);
const HARD_BOUNCE_TYPES = new Set(['hard_bounce', 'hardbounce', 'permanent_bounce']);
const SOFT_BOUNCE_KINDS = new Set(['soft', 'transient', 'temporary']);

/**
 * Maps a provider event to a suppression reason, or null when the event
 * shouldn't suppress the address (deliveries, opens, soft bounces, ...).
 */
export function classifyEmailEvent(evt: EmailProviderEvent): EmailSuppressionReason | null {
  const type = String(evt.type ?? evt.event ?? '').toLowerCase();
  if (COMPLAINT_TYPES.has(type)) return EmailSuppressionReason.COMPLAINT;
  if (HARD_BOUNCE_TYPES.has(type)) return EmailSuppressionReason.BOUNCE;
  if (type === 'bounce' || type === 'bounced') {
    const kind = String(evt.bounceType ?? 'hard').toLowerCase();
    return SOFT_BOUNCE_KINDS.has(kind) ? null : EmailSuppressionReason.BOUNCE;
  }
  return null;
}

@Injectable()
export class EmailSuppressionService {
  private readonly logger = new Logger(EmailSuppressionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Throws 401 unless the signature is a valid HMAC of the raw body. */
  verifySignature(rawBody: Buffer | string | undefined, signature: string | undefined): void {
    const secret = this.config.get<string>('EMAIL_WEBHOOK_SECRET');
    if (!secret) throw new UnauthorizedException('Email webhook is not configured');
    if (!rawBody || !signature) throw new UnauthorizedException('Missing webhook signature');

    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const given = signature.replace(/^sha256=/, '').trim();
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(given, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }

  /** Records suppressions for every hard bounce / complaint in the payload. */
  async handleEvents(events: EmailProviderEvent[]): Promise<{ suppressed: number }> {
    let suppressed = 0;
    for (const evt of events) {
      const reason = classifyEmailEvent(evt);
      const email = (evt.email ?? evt.recipient)?.trim().toLowerCase();
      if (!reason || !email) continue;
      await this.suppress(email, reason);
      suppressed++;
    }
    return { suppressed };
  }

  async suppress(email: string, reason: EmailSuppressionReason) {
    const normalized = email.trim().toLowerCase();
    const existing = await this.prisma.emailSuppression.findUnique({ where: { email: normalized } });
    if (existing) return existing;

    const entry = await this.prisma.emailSuppression.create({ data: { email: normalized, reason } });
    this.logger.warn(`Suppressed ${normalized} (${reason})`);

    // Mark the owner's email unverified and prompt them in-app to fix it.
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: normalized, mode: 'insensitive' } },
      select: { id: true },
    });
    if (user) {
      await this.prisma.user.update({ where: { id: user.id }, data: { emailVerified: false } });
      await this.prisma.notification.create({
        data: {
          userId: user.id,
          type: NotificationType.SYSTEM_ALERT,
          title: 'Please update your email address',
          message:
            reason === EmailSuppressionReason.COMPLAINT
              ? 'Emails to your address were reported as spam, so we stopped sending them. Update your email to resume notifications.'
              : 'Emails to your address are bouncing, so we stopped sending them. Update your email to resume notifications.',
          data: { action: 'UPDATE_EMAIL', reason },
        },
      });
    }
    return entry;
  }

  list(params: { page?: number; limit?: number; email?: string } = {}) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const where = params.email ? { email: { contains: params.email.toLowerCase() } } : {};
    return this.prisma
      .$transaction([
        this.prisma.emailSuppression.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.emailSuppression.count({ where }),
      ])
      .then(([data, total]) => ({ data, total, page, limit }));
  }

  async remove(id: string) {
    const existing = await this.prisma.emailSuppression.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Suppression ${id} not found`);
    await this.prisma.emailSuppression.delete({ where: { id } });
    this.logger.log(`Suppression removed for ${existing.email}`);
    return { removed: true, email: existing.email };
  }
}
