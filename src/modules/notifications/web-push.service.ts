import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webPush from 'web-push';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import { RegisterWebPushDto } from './dto/register-web-push.dto';

@Injectable()
export class WebPushService implements OnModuleInit {
  private readonly logger = new Logger(WebPushService.name);
  /** True only when both VAPID keys are present and valid */
  private enabled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY');
    const subject = this.config.get<string>('VAPID_SUBJECT', 'mailto:noreply@chainsettle.io');

    if (!publicKey || !privateKey) {
      this.logger.warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web push disabled');
      return;
    }

    try {
      webPush.setVapidDetails(subject, publicKey, privateKey);
      this.enabled = true;
      this.logger.log('Web Push (VAPID) initialised');
    } catch (err) {
      this.logger.error('Failed to initialise VAPID details', (err as Error).message);
    }
  }

  /** Returns the VAPID public key, or null when the feature is disabled. */
  getPublicKey(): string | null {
    if (!this.enabled) return null;
    return this.config.get<string>('VAPID_PUBLIC_KEY') ?? null;
  }

  /** Upsert a push subscription for a user (keyed on endpoint). */
  async subscribe(userId: string, dto: RegisterWebPushDto) {
    return this.prisma.webPushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: { userId, endpoint: dto.endpoint, p256dh: dto.p256dh, auth: dto.auth },
      update: { userId, p256dh: dto.p256dh, auth: dto.auth },
    });
  }

  /** Remove a specific subscription by endpoint for the authenticated user. */
  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.webPushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  /**
   * Send a push notification to every active subscription for `userId`.
   * Subscriptions that respond with 404 or 410 (expired / unsubscribed) are
   * deleted automatically.
   *
   * Silently returns when the feature is disabled (no VAPID keys configured).
   */
  async sendToUser(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    if (!this.enabled) return;

    const subscriptions = await this.prisma.webPushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });

    if (subscriptions.length === 0) return;

    const payload = JSON.stringify({ type, title, body, ...(data ?? {}) });
    const staleIds: string[] = [];

    await Promise.allSettled(
      subscriptions.map(async ({ id, endpoint, p256dh, auth }) => {
        try {
          await webPush.sendNotification(
            { endpoint, keys: { p256dh, auth } },
            payload,
            { TTL: 86400 }, // 24 h — let the push service buffer while the browser is offline
          );
        } catch (err: any) {
          const status: number = err?.statusCode ?? 0;
          if (status === 404 || status === 410) {
            // Subscription is gone on the push service side
            staleIds.push(id);
          } else {
            this.logger.warn(`Web push failed for subscription ${id}: ${status || err.message}`);
          }
        }
      }),
    );

    if (staleIds.length > 0) {
      await this.prisma.webPushSubscription.deleteMany({ where: { id: { in: staleIds } } });
      this.logger.log(`Removed ${staleIds.length} stale web-push subscription(s) for user ${userId}`);
    }
  }
}
