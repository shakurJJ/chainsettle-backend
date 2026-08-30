import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationType } from '@prisma/client';

@Injectable()
export class PushNotificationService implements OnModuleInit {
  private readonly logger = new Logger(PushNotificationService.name);
  private app: admin.app.App | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const serviceAccountJson = this.config.get<string>('FCM_SERVICE_ACCOUNT_JSON');
    if (!serviceAccountJson) {
      this.logger.warn('FCM_SERVICE_ACCOUNT_JSON not set — push notifications disabled');
      return;
    }
    try {
      const serviceAccount = JSON.parse(serviceAccountJson);
      this.app = admin.initializeApp(
        { credential: admin.credential.cert(serviceAccount) },
        'chainsettle',
      );
      this.logger.log('Firebase Admin SDK initialised');
    } catch (err) {
      this.logger.error('Failed to initialise Firebase Admin SDK', (err as Error).message);
    }
  }

  async registerToken(userId: string, token: string, platform = 'fcm') {
    return this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId },
    });
  }

  async removeToken(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
  }

  async listTokens(userId: string) {
    return this.prisma.deviceToken.findMany({
      where: { userId },
      select: { id: true, token: true, platform: true, createdAt: true },
    });
  }

  /**
   * Send a push notification to all registered devices for a user.
   * Stale tokens reported by FCM are automatically removed.
   */
  async sendToUser(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    if (!this.app) return;

    const deviceTokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { id: true, token: true },
    });

    if (deviceTokens.length === 0) return;

    const staleIds: string[] = [];

    await Promise.allSettled(
      deviceTokens.map(async ({ id, token }) => {
        try {
          await this.app!.messaging().send({
            token,
            notification: { title, body },
            data: { eventType: type, ...(data ?? {}) },
            android: { priority: 'high' },
            apns: { payload: { aps: { sound: 'default' } } },
          });
        } catch (err: any) {
          const code: string = err?.errorInfo?.code ?? '';
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            staleIds.push(id);
          } else {
            this.logger.warn(`FCM send failed for token ${id}: ${code || err.message}`);
          }
        }
      }),
    );

    if (staleIds.length > 0) {
      await this.prisma.deviceToken.deleteMany({ where: { id: { in: staleIds } } });
      this.logger.log(`Removed ${staleIds.length} stale FCM token(s) for user ${userId}`);
    }
  }
}
