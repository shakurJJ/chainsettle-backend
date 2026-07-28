import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import * as Handlebars from 'handlebars';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import { NotificationsGateway } from './notifications.gateway';
import { WebhooksService } from '../webhooks/webhooks.service';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

type PreferenceMap = Record<NotificationType, { inApp: boolean; email: boolean }>;
export type DigestFrequency = 'instant' | 'daily' | 'weekly';
type StoredPreferences = PreferenceMap & { _meta?: { digestFrequency?: DigestFrequency } };

const DEFAULT_DIGEST_FREQUENCY: DigestFrequency = 'daily';

function buildDefaultPreferences(): PreferenceMap {
  return Object.values(NotificationType).reduce((acc, type) => {
    acc[type] = { inApp: true, email: true };
    return acc;
  }, {} as PreferenceMap);
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: nodemailer.Transporter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly gateway: NotificationsGateway,
    @Optional() private readonly webhooks: WebhooksService,
  ) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get('SMTP_HOST'),
      port: this.config.get<number>('SMTP_PORT', 587),
      secure: false,
      auth: {
        user: this.config.get('SMTP_USER'),
        pass: this.config.get('SMTP_PASS'),
      },
    });
  }

  /**
   * Creates an in-app notification for a user (by their Stellar address)
   * and optionally sends an email if they have one registered.
   * Both channels are gated on the user's NotificationPreference record.
   */
  async notifyUser(
    stellarAddress: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { stellarAddress },
      });

      if (!user) {
        this.logger.warn(`No user found for address ${stellarAddress} — skipping notification`);
        return;
      }

      const prefs = await this.getOrCreatePreferences(user.id);
      const { inApp, email: emailEnabled } = prefs[type];

      if (!inApp) return;

      const notification = await this.prisma.notification.create({
        data: { userId: user.id, type, title, message, data: data ?? {} },
      });

      if (emailEnabled && user.email) {
        await this.sendEmail(user.email, title, message, undefined, type, data);
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: { emailSent: true },
        });
      }

      this.gateway?.pushToUser(user.id, notification);

      this.webhooks
        ?.dispatch(type, { notificationId: notification.id, ...(data ?? {}) })
        .catch((err) => this.logger.error('Webhook dispatch error', err.message));

      return notification;
    } catch (error) {
      this.logger.error(`Failed to notify ${stellarAddress}`, error.message);
    }
  }

  /**
   * Fans out an in-app notification to all users watching a shipment.
   * Watchers do NOT receive email notifications for these events.
   */
  async notifyWatchers(
    shipmentId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ) {
    try {
      const watchers = await this.prisma.shipmentWatcher.findMany({
        where: { shipmentId },
        include: { user: true },
      });

      if (!watchers || watchers.length === 0) return;

      const notificationsData = watchers.map((w) => ({
        userId: w.userId,
        type,
        title,
        message,
        data: data ?? {},
      }));

      await this.prisma.notification.createMany({
        data: notificationsData,
      });

      // Optionally, push to the gateway for live updates
      const newlyCreated = await this.prisma.notification.findMany({
        where: {
          type,
          title,
          userId: { in: watchers.map((w) => w.userId) },
        },
        orderBy: { createdAt: 'desc' },
        take: watchers.length,
      });

      for (const notif of newlyCreated) {
        this.gateway?.pushToUser(notif.userId, notif);
      }
    } catch (error) {
      this.logger.error(`Failed to notify watchers for shipment ${shipmentId}`, (error as Error).message);
    }
  }

  /**
   * Sends a test notification to the caller, routed through the normal
   * notification pipeline so it exercises preferences + email delivery for real.
   */
  async sendTestNotification(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      this.logger.warn(`No user found for id ${userId} — skipping test notification`);
      return;
    }

    return this.notifyUser(
      user.stellarAddress,
      NotificationType.SYSTEM_ALERT,
      'Test Notification',
      'This is a test notification to verify your notification pipeline is working correctly.',
    );
  }

  async getOrCreatePreferences(userId: string): Promise<PreferenceMap> {
    const record = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, preferences: buildDefaultPreferences() },
      update: {},
    });
    return record.preferences as PreferenceMap;
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto): Promise<PreferenceMap> {
    const current = (await this.getOrCreatePreferences(userId)) as StoredPreferences;
    const merged: StoredPreferences = { ...current, ...(dto.preferences ?? {}) };
    if (dto.digestFrequency) {
      merged._meta = { ...current._meta, digestFrequency: dto.digestFrequency };
    }
    const record = await this.prisma.notificationPreference.update({
      where: { userId },
      data: { preferences: merged },
    });
    return record.preferences as PreferenceMap;
  }

  /**
   * Resolves the caller's configured digest cadence, defaulting existing
   * users without a stored value to 'daily' (no migration required).
   */
  async getDigestFrequency(userId: string): Promise<DigestFrequency> {
    const prefs = (await this.getOrCreatePreferences(userId)) as StoredPreferences;
    return prefs._meta?.digestFrequency ?? DEFAULT_DIGEST_FREQUENCY;
  }

  async getPreferencesResponse(userId: string) {
    const prefs = (await this.getOrCreatePreferences(userId)) as StoredPreferences;
    const { _meta, ...typePreferences } = prefs;
    return { ...typePreferences, digestFrequency: _meta?.digestFrequency ?? DEFAULT_DIGEST_FREQUENCY };
  }

  async findForUser(userId: string, unreadOnly = false, page = 1, limit = 20) {
    const where: any = { userId };
    if (unreadOnly) where.read = false;

    const [notifications, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { data: notifications, meta: { total, page, limit } };
  }

  async findOne(userId: string, id: string) {
    return this.prisma.notification.findFirst({ where: { id, userId } });
  }

  async markRead(notificationId: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }

  async deleteAllRead(userId: string) {
    const result = await this.prisma.notification.deleteMany({
      where: { userId, read: true },
    });
    return { deletedCount: result.count };
  }

  async buildDigest(userId: string): Promise<{ subject: string; html: string } | null> {
    const unread = await this.prisma.notification.findMany({
      where: { userId, read: false },
      orderBy: { createdAt: 'desc' },
    });

    if (unread.length === 0) return null;

    const grouped = unread.reduce(
      (acc, n) => {
        const key = n.type as string;
        acc[key] = acc[key] ?? [];
        acc[key].push(n);
        return acc;
      },
      {} as Record<string, typeof unread>,
    );

    const sections = Object.entries(grouped)
      .map(([type, items]) => {
        const rows = items
          .map((n) => `<li>${n.title}</li>`)
          .join('');
        return `<h3 style="color:#1a1a2e;">${type.replace(/_/g, ' ')} (${items.length})</h3><ul>${rows}</ul>`;
      })
      .join('');

    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#1a1a2e;">ChainSettle — Daily Notification Digest</h2>
        <p>You have <strong>${unread.length}</strong> unread notification(s):</p>
        ${sections}
        <hr />
        <small style="color:#888;">Log in to ChainSettle to view and manage your notifications.</small>
      </div>
    `;

    return { subject: `Daily digest — ${unread.length} unread notification(s)`, html };
  }

  /**
   * Loads and renders a Handlebars template for the given notification type.
   * Returns null when no template file exists for that type (triggers plain-text fallback).
   */
  private renderTemplate(type: NotificationType, data: Record<string, any>): string | null {
    const templatePath = path.join(__dirname, 'templates', `${type}.hbs`);
    if (!fs.existsSync(templatePath)) {
      return null;
    }
    try {
      const source = fs.readFileSync(templatePath, 'utf-8');
      const template = Handlebars.compile(source);
      return template(data ?? {});
    } catch (error) {
      this.logger.error(`Failed to render template for ${type}`, error.message);
      return null;
    }
  }

  async sendEmail(
    to: string,
    subject: string,
    text: string,
    html?: string,
    type?: NotificationType,
    data?: Record<string, any>,
  ) {
    try {
      let renderedHtml = html;
      if (!renderedHtml && type) {
        renderedHtml = this.renderTemplate(type, data ?? {}) ?? undefined;
      }
      await this.transporter.sendMail({
        from: this.config.get('EMAIL_FROM', 'noreply@chainsetttle.com'),
        to,
        subject: `ChainSettle — ${subject}`,
        text,
        html: renderedHtml ?? `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a1a2e;">ChainSettle</h2>
            <p>${text}</p>
            <hr />
            <small style="color: #888;">You're receiving this because you're a participant on ChainSettle.</small>
          </div>
        `,
      });
      this.logger.log(`Email sent to ${to}: ${subject}`);
    } catch (error) {
      this.logger.error(`Email failed to ${to}`, error.message);
    }
  }
}
