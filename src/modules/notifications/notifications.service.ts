import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as Handlebars from 'handlebars';
import { WebPushService } from './web-push.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationType, UserRole } from '@prisma/client';
import { NotificationsGateway } from './notifications.gateway';
import { OutboxService } from '../outbox/outbox.service';
import { PushNotificationService } from './push-notification.service';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { DEFAULT_LOCALE, I18nService } from '../../i18n/i18n.service';
import { SmsProviderFactory } from '../../common/providers/sms.provider';
import { TelegramService } from './telegram.service';

const NOTIFICATION_DELIVERY_ERROR_MAX = 1_000;

type ChannelPrefs = {
  inApp: boolean;
  email: boolean;
  slack?: boolean;
  sms?: boolean;
  discord?: boolean;
  teams?: boolean;
  push?: boolean;
  telegram?: boolean;
};
type PreferenceMap = Record<NotificationType, ChannelPrefs>;
export type DigestFrequency = "instant" | "daily" | "weekly";
export type ReportFrequency = "off" | "weekly" | "monthly";
type StoredPreferences = PreferenceMap & {
  _meta?: {
    digestFrequency?: DigestFrequency;
    reportFrequency?: ReportFrequency;
  };
  _quietHours?: {
    enabled: boolean;
    start: string;
    end: string;
    timezone: string;
  };
};

type NotificationGroup = {
  key: string;
  shipmentId: string | null;
  referenceNumber: string | null;
  unreadCount: number;
  latestAt: Date;
  notifications: any[];
};

const DEFAULT_DIGEST_FREQUENCY: DigestFrequency = "daily";
export const DEFAULT_REPORT_FREQUENCY: ReportFrequency = "off";

// SMS is only allowed for these notification types
export const SMS_ALLOWED_TYPES: NotificationType[] = [
  NotificationType.DISPUTE_RAISED,
  NotificationType.DISPUTE_RESOLVED,
  NotificationType.PAYMENT_RELEASED,
  NotificationType.MILESTONE_OVERDUE,
];

const TELEGRAM_DEFAULT_TYPES: NotificationType[] = [
  NotificationType.DISPUTE_RAISED,
  NotificationType.DISPUTE_RESOLVED,
  NotificationType.PAYMENT_RELEASED,
  NotificationType.MILESTONE_OVERDUE,
  NotificationType.SYSTEM_ALERT,
];

// Max SMS per user per 24-hour window
const SMS_RATE_LIMIT = 10;

function buildDefaultPreferences(): PreferenceMap {
  return Object.values(NotificationType).reduce((acc, type) => {
    const smsDefault = false;
    const discordDefault = false;
    acc[type] = {
      inApp: true,
      email: true,
      slack: true,
      sms: smsDefault,
      discord: discordDefault,
      teams: false,
      push: true,
      telegram: TELEGRAM_DEFAULT_TYPES.includes(type),
    };
    return acc;
  }, {} as PreferenceMap);
}

function normalizeChannelPrefs(
  raw: Partial<ChannelPrefs> | undefined,
  type?: NotificationType,
): ChannelPrefs {
  return {
    inApp: raw?.inApp ?? true,
    email: raw?.email ?? true,
    slack: raw?.slack ?? true,
    sms: raw?.sms ?? false,
    discord: raw?.discord ?? false,
    teams: raw?.teams ?? false,
    push: raw?.push ?? true,
    telegram:
      raw?.telegram ??
      (type !== undefined && TELEGRAM_DEFAULT_TYPES.includes(type)),
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: nodemailer.Transporter;
  private smsProvider: ReturnType<SmsProviderFactory["create"]>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly i18n: I18nService,
    @Optional() private readonly gateway: NotificationsGateway,
    @Optional() private readonly outbox: OutboxService,
    @Optional() private readonly smsProviderFactory: SmsProviderFactory,
    @Optional() private readonly webPush: WebPushService,
    @Optional() private readonly telegram: TelegramService,
  ) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get("SMTP_HOST"),
      port: this.config.get<number>("SMTP_PORT", 587),
      secure: false,
      auth: {
        user: this.config.get("SMTP_USER"),
        pass: this.config.get("SMTP_PASS"),
      },
    });

    // Initialize SMS provider if configured
    if (this.smsProviderFactory) {
      this.smsProvider = this.smsProviderFactory.create();
    }
  }

  /**
   * Creates an in-app notification for a user (by their Stellar address)
   * and optionally sends an email if they have one registered.
   * Both channels are gated on the user's NotificationPreference record.
   * Optional Slack, Discord, Teams, SMS, push, and Telegram channels are sent when
   * their per-type preference and channel configuration allow delivery.
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
        this.logger.warn(
          `No user found for address ${stellarAddress} — skipping notification`,
        );
        return;
      }

      const { preferences: prefs, slackWebhookUrl, discordWebhookUrl, teamsWebhookUrl, telegramChatId } = await this.getOrCreatePreferenceRecord(user.id);
      const quietHours = (prefs as StoredPreferences)._quietHours;
      const deliverAfter = type === NotificationType.SYSTEM_ALERT && data?.urgent === true ? null : this.getQuietHoursEnd(new Date(), quietHours);
      const { inApp, email: emailEnabled, slack: slackEnabled, sms: smsEnabled, discord: discordEnabled, teams: teamsEnabled, push: pushEnabled, telegram: telegramEnabled } = normalizeChannelPrefs(prefs[type], type);

      if (!inApp) return;

      // The notification and its webhook event commit together, so a crash
      // between commit and delivery cannot drop the event (#660).
      const notification = await this.prisma.$transaction(async (tx) => {
        const created = await tx.notification.create({
          data: {
            userId: user.id,
            type,
            title,
            message,
            data: data ?? {},
            ...(deliverAfter ? { deliverAfter } : {}),
          },
        });
        await this.outbox?.enqueue(tx, type, {
          notificationId: created.id,
          ...(data ?? {}),
        });
        return created;
      });

      if (!deliverAfter && emailEnabled && user.email) {
        const emailError = await this.deliverEmail(
          user.email,
          title,
          message,
          undefined,
          type,
          data,
          user.locale ?? DEFAULT_LOCALE,
        );
        await this.recordDelivery(notification.id, 'EMAIL', emailError);
        if (!emailError) {
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: { emailSent: true },
          });
        }
      }

      if (!deliverAfter && slackEnabled && slackWebhookUrl) {
        const slackError = await this.sendSlackMessage(
          slackWebhookUrl,
          type,
          title,
          message,
          data,
        );
        await this.recordDelivery(notification.id, 'SLACK', slackError);
      }

      // Send SMS if enabled, user has verified phone, type is allowed, and rate limit not exceeded
      if (
        smsEnabled &&
        user.phoneVerified &&
        user.phoneNumber &&
        SMS_ALLOWED_TYPES.includes(type)
      ) {
        await this.sendSmsNotification(
          user.id,
          user.phoneNumber,
          type,
          title,
          message,
          data,
        );
      }

      // Send Discord notification if enabled and webhook is configured
      if (!deliverAfter && discordEnabled && discordWebhookUrl) {
        await this.sendDiscordMessage(
          discordWebhookUrl,
          type,
          title,
          message,
          data,
        );
      }

      if (!deliverAfter && teamsEnabled && teamsWebhookUrl) {
        void this.sendTeamsMessage(
          teamsWebhookUrl,
          type,
          title,
          message,
          data,
        ).catch((error) =>
          this.logger.error(
            `Teams notification dispatch error for ${type}`,
            (error as Error).message,
          ),
        );
      }

      if (!deliverAfter && telegramEnabled && telegramChatId) {
        await this.telegram?.sendMessage(telegramChatId, `ChainSettle — ${title}\n\n${message}`);
      }

      this.gateway?.pushToUser(user.id, notification);

      if (!deliverAfter && pushEnabled) {
        this.webPush
          ?.sendToUser(
            user.id,
            type,
            title,
            message,
            data as Record<string, string> | undefined,
          )
          .catch((err) =>
            this.logger.error("Web push dispatch error", err.message),
          );
      }

      return notification;
    } catch (error) {
      this.logger.error(`Failed to notify ${stellarAddress}`, error.message);
    }
  }

  /**
   * Like notifyUser() but always sends an email regardless of the user's digest
   * preference. Used for high-signal events such as direct @mentions (#190).
   */
  async notifyUserWithForcedEmail(
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
        this.logger.warn(
          `No user found for address ${stellarAddress} — skipping mention notification`,
        );
        return;
      }

      const prefs = await this.getOrCreatePreferences(user.id);
      const deliverAfter =
        type === NotificationType.SYSTEM_ALERT && data?.urgent === true
          ? null
          : this.getQuietHoursEnd(
              new Date(),
              (prefs as StoredPreferences)._quietHours,
            );
      const { inApp } = prefs[type] ?? prefs[NotificationType.COMMENT_ADDED];

      if (!inApp) return;

      const notification = await this.prisma.$transaction(async (tx) => {
        const created = await tx.notification.create({
          data: {
            userId: user.id,
            type,
            title,
            message,
            data: {
              ...(data ?? {}),
              ...(deliverAfter ? { forceEmail: true } : {}),
            },
            ...(deliverAfter ? { deliverAfter } : {}),
          },
        });
        await this.outbox?.enqueue(tx, type, {
          notificationId: created.id,
          ...(data ?? {}),
        });
        return created;
      });

      // Force email delivery regardless of digest preference when the user has an email
      if (user.email && !deliverAfter) {
        const emailError = await this.deliverEmail(
          user.email,
          title,
          message,
          undefined,
          type,
          data,
          user.locale ?? DEFAULT_LOCALE,
        );
        await this.recordDelivery(notification.id, 'EMAIL', emailError);
        if (!emailError) {
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: { emailSent: true },
          });
        }
      }

      this.gateway?.pushToUser(user.id, notification);

      return notification;
    } catch (error) {
      this.logger.error(
        `Failed to send mention notification to ${stellarAddress}`,
        error.message,
      );
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
        orderBy: { createdAt: "desc" },
        take: watchers.length,
      });

      for (const notif of newlyCreated) {
        this.gateway?.pushToUser(notif.userId, notif);
      }
    } catch (error) {
      this.logger.error(
        `Failed to notify watchers for shipment ${shipmentId}`,
        (error as Error).message,
      );
    }
  }

  /**
   * Sends a test notification to the caller, routed through the normal
   * notification pipeline so it exercises preferences + email delivery for real.
   */
  async sendTestNotification(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      this.logger.warn(
        `No user found for id ${userId} — skipping test notification`,
      );
      return;
    }

    return this.notifyUser(
      user.stellarAddress,
      NotificationType.SYSTEM_ALERT,
      "Test Notification",
      "This is a test notification to verify your notification pipeline is working correctly.",
    );
  }

  async sendTeamsTestNotification(userId: string) {
    const { teamsWebhookUrl } = await this.getOrCreatePreferenceRecord(userId);
    if (!teamsWebhookUrl) {
      throw new BadRequestException('Configure a Teams webhook URL first');
    }

    const sent = await this.sendTeamsMessage(
      teamsWebhookUrl,
      NotificationType.SYSTEM_ALERT,
      'Test Notification',
      'This is a test notification to verify your Microsoft Teams webhook is working correctly.',
    );
    if (!sent) {
      throw new ServiceUnavailableException(
        'The Microsoft Teams webhook test could not be delivered',
      );
    }
    return { success: true };
  }

  async getOrCreatePreferences(userId: string): Promise<PreferenceMap> {
    const record = await this.getOrCreatePreferenceRecord(userId);
    return record.preferences;
  }

  private async getOrCreatePreferenceRecord(userId: string): Promise<{
    preferences: PreferenceMap;
    slackWebhookUrl: string | null;
    discordWebhookUrl: string | null;
    teamsWebhookUrl: string | null;
    telegramChatId: string | null;
  }> {
    const record = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, preferences: buildDefaultPreferences() },
      update: {},
    });
    return {
      preferences: record.preferences as PreferenceMap,
      slackWebhookUrl: record.slackWebhookUrl ?? null,
      discordWebhookUrl: record.discordWebhookUrl ?? null,
      teamsWebhookUrl: record.teamsWebhookUrl ?? null,
      telegramChatId: record.telegramChatId ?? null,
    };
  }

  private validateQuietHours(q: any): void {
    if (
      !q ||
      typeof q.enabled !== "boolean" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(q.start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(q.end) ||
      typeof q.timezone !== "string"
    )
      throw new BadRequestException(
        "quietHours must contain enabled, HH:mm start/end, and an IANA timezone",
      );
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: q.timezone });
    } catch {
      throw new BadRequestException(
        "quietHours.timezone must be a valid IANA timezone",
      );
    }
  }

  async isQuietHours(userId: string): Promise<boolean> {
    const prefs = (await this.getOrCreatePreferences(
      userId,
    )) as StoredPreferences;
    return this.getQuietHoursEnd(new Date(), prefs._quietHours) !== null;
  }
  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    if (dto.quietHours !== undefined) this.validateQuietHours(dto.quietHours);
    const current = (await this.getOrCreatePreferences(
      userId,
    )) as StoredPreferences;
    const merged: StoredPreferences = {
      ...current,
      ...(dto.preferences ?? {}),
    };
    if (dto.quietHours !== undefined) merged._quietHours = dto.quietHours;
    if (dto.digestFrequency) {
      merged._meta = { ...current._meta, digestFrequency: dto.digestFrequency };
    }
    if (dto.reportFrequency) {
      merged._meta = { ...merged._meta, reportFrequency: dto.reportFrequency };
    }

    const data: {
      preferences: StoredPreferences;
      slackWebhookUrl?: string | null;
      discordWebhookUrl?: string | null;
      teamsWebhookUrl?: string | null;
    } = {
      preferences: merged,
    };
    if (dto.slackWebhookUrl !== undefined) {
      data.slackWebhookUrl =
        dto.slackWebhookUrl === "" || dto.slackWebhookUrl === null
          ? null
          : dto.slackWebhookUrl;
    }
    if (dto.discordWebhookUrl !== undefined) {
      data.discordWebhookUrl =
        dto.discordWebhookUrl === "" || dto.discordWebhookUrl === null
          ? null
          : dto.discordWebhookUrl;
    }
    if (dto.teamsWebhookUrl !== undefined) {
      data.teamsWebhookUrl =
        dto.teamsWebhookUrl === "" || dto.teamsWebhookUrl === null
          ? null
          : dto.teamsWebhookUrl;
    }

    await this.prisma.notificationPreference.update({
      where: { userId },
      data,
    });
    return this.getPreferencesResponse(userId);
  }

  /**
   * Resolves the caller's configured digest cadence, defaulting existing
   * users without a stored value to 'daily' (no migration required).
   */
  async getDigestFrequency(userId: string): Promise<DigestFrequency> {
    const prefs = (await this.getOrCreatePreferences(
      userId,
    )) as StoredPreferences;
    return prefs._meta?.digestFrequency ?? DEFAULT_DIGEST_FREQUENCY;
  }

  /**
   * Resolves the caller's opt-in cadence for the personal shipment report.
   * Missing values mean 'off': reports are strictly opt-in.
   */
  async getReportFrequency(userId: string): Promise<ReportFrequency> {
    const prefs = (await this.getOrCreatePreferences(
      userId,
    )) as StoredPreferences;
    return prefs._meta?.reportFrequency ?? DEFAULT_REPORT_FREQUENCY;
  }

  async getPreferencesResponse(userId: string) {
    const { preferences, slackWebhookUrl, discordWebhookUrl, teamsWebhookUrl, telegramChatId } =
      await this.getOrCreatePreferenceRecord(userId);
    const stored = preferences as StoredPreferences;
    const { _meta, _quietHours, ...typePreferences } = stored;
    const resolvedTypePreferences = Object.values(NotificationType).reduce(
      (resolved, type) => ({
        ...resolved,
        [type]: normalizeChannelPrefs(typePreferences[type], type),
      }),
      {} as PreferenceMap,
    );
    return {
      ...resolvedTypePreferences,
      digestFrequency: _meta?.digestFrequency ?? DEFAULT_DIGEST_FREQUENCY,
      reportFrequency: _meta?.reportFrequency ?? DEFAULT_REPORT_FREQUENCY,
      quietHours: _quietHours ?? {
        enabled: false,
        start: "22:00",
        end: "08:00",
        timezone: "UTC",
      },
      slackWebhookUrl,
      discordWebhookUrl,
      teamsWebhookUrl,
      telegramLinked: telegramChatId !== null,
    };
  }

  private getQuietHoursEnd(now: Date, q?: { enabled: boolean; start: string; end: string; timezone: string }): Date | null {
    if (!q?.enabled) return null;
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: q.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const n = Number(local.find((x) => x.type === 'hour')?.value) * 60 + Number(local.find((x) => x.type === 'minute')?.value);
    const [sh, sm] = q.start.split(':').map(Number);
    const [eh, em] = q.end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    const active = start === end || (start < end ? n >= start && n < end : n >= start || n < end);
    if (!active) return null;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: q.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const plusDay = start > end && n >= start;
    const [y, mo, d] = date.split('-').map(Number);
    const wall = Date.UTC(y, mo - 1, d + (plusDay ? 1 : 0), eh, em);
    let utc = wall;
    for (let i = 0; i < 2; i++) {
      const parts: any = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: q.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
          .formatToParts(new Date(utc))
          .map((x) => [x.type, x.value]),
      );
      utc += wall - Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    }
    return new Date(utc);
  }

  /**
   * Generates a signed, expiring unsubscribe token for a user and notification type.
   */
  generateUnsubscribeToken(userId: string, type: NotificationType | string = 'ALL'): string {
    const secret = this.config.get<string>('JWT_SECRET', 'secret');
    const exp = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
    const payload = { userId, type, exp };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    return `${data}.${sig}`;
  }

  /**
   * Verifies an unsubscribe token and returns the payload.
   * Throws BadRequestException if token is missing, malformed, tampered, or expired.
   */
  verifyUnsubscribeToken(token: string): { userId: string; type: NotificationType | string } {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Unsubscribe token is required');
    }
    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new BadRequestException('Invalid unsubscribe token format');
    }
    const [data, sig] = parts;
    const secret = this.config.get<string>('JWT_SECRET', 'secret');
    const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      throw new BadRequestException('Invalid or tampered unsubscribe token');
    }

    let payload: { userId: string; type: NotificationType | string; exp: number };
    try {
      payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid unsubscribe token payload');
    }

    if (!payload.userId || !payload.type || !payload.exp) {
      throw new BadRequestException('Invalid unsubscribe token payload');
    }

    if (Date.now() > payload.exp) {
      throw new BadRequestException('Unsubscribe token has expired');
    }

    return { userId: payload.userId, type: payload.type };
  }

  /**
   * Builds the full unsubscribe URL with a signed token.
   */
  getUnsubscribeUrl(userId: string, type: NotificationType | string = 'ALL'): string {
    const token = this.generateUnsubscribeToken(userId, type);
    const apiBaseUrl = this.config.get<string>('API_BASE_URL', 'http://localhost:3000');
    return `${apiBaseUrl}/api/v1/notifications/unsubscribe?token=${token}`;
  }

  /**
   * Unsubscribes a user from email notifications using a signed token.
   * Updates NotificationPreference to set email: false for the specified notification type (or ALL).
   */
  async unsubscribe(token: string): Promise<{ success: boolean; message: string; type: string }> {
    const { userId, type } = this.verifyUnsubscribeToken(token);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const current = (await this.getOrCreatePreferences(userId)) as StoredPreferences;
    const merged: StoredPreferences = { ...current };

    if (type === 'ALL') {
      for (const notifType of Object.values(NotificationType)) {
        const existing = normalizeChannelPrefs(merged[notifType]);
        merged[notifType] = { ...existing, email: false };
      }
      // The report email shares this unsubscribe link, so make the opt-out
      // durable: re-enabling a single notification email must not quietly
      // resume scheduled reports.
      merged._meta = { ...merged._meta, reportFrequency: 'off' };
    } else {
      const notifType = type as NotificationType;
      const existing = normalizeChannelPrefs(merged[notifType]);
      merged[notifType] = { ...existing, email: false };
    }

    await this.prisma.notificationPreference.update({
      where: { userId },
      data: { preferences: merged },
    });

    this.logger.log(`User ${userId} unsubscribed from ${type} email notifications`);
    return {
      success: true,
      message: `Successfully unsubscribed from ${type === 'ALL' ? 'all' : type} email notifications`,
      type: String(type),
    };
  }

  async findForUser(
    userId: string,
    unreadOnly = false,
    page = 1,
    limit = 20,
    groupBy?: "shipment" | "none",
  ) {
    const where: any = { userId };
    if (unreadOnly) where.read = false;
    // Exclude notifications that are actively snoozed (snoozedUntil is in the future).
    // Once the snooze time passes the row reappears automatically — no cron needed.
    where.OR = [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }];

    if (groupBy === "shipment") {
      const notifications = await this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
      });

      const groups = new Map<string, NotificationGroup>();
      const shipmentIds = Array.from(
        new Set(
          notifications
            .map((n) =>
              n.data && typeof n.data === "object" && "shipmentId" in n.data
                ? String((n.data as any).shipmentId)
                : null,
            )
            .filter((id): id is string => Boolean(id)),
        ),
      );

      const shipments = shipmentIds.length
        ? await this.prisma.shipment.findMany({
            where: { id: { in: shipmentIds } },
            select: { id: true, referenceNumber: true },
          })
        : [];
      const shipmentMap = new Map(shipments.map((s) => [s.id, s]));

      for (const notification of notifications) {
        const shipmentId =
          notification.data &&
          typeof notification.data === "object" &&
          "shipmentId" in notification.data
            ? String((notification.data as any).shipmentId)
            : null;
        const key = shipmentId ?? "__general__";
        const group = groups.get(key) ?? {
          key,
          shipmentId,
          referenceNumber: shipmentId
            ? (shipmentMap.get(shipmentId)?.referenceNumber ?? null)
            : null,
          unreadCount: 0,
          latestAt: notification.createdAt,
          notifications: [],
        };

        group.notifications.push(notification);
        group.latestAt = new Date(
          Math.max(
            new Date(group.latestAt).getTime(),
            new Date(notification.createdAt).getTime(),
          ),
        );
        group.unreadCount += notification.read ? 0 : 1;
        groups.set(key, group);
      }

      const grouped = Array.from(groups.values())
        .map((group) => ({
          ...group,
          notifications: group.notifications
            .slice()
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, 3),
        }))
        .sort(
          (a, b) =>
            new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime(),
        )
        .slice((page - 1) * limit, page * limit);

      return { data: grouped, meta: { total: grouped.length, page, limit } };
    }

    const [notifications, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { data: notifications, meta: { total, page, limit } };
  }

  async markReadByShipment(userId: string, shipmentId: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        userId,
        read: false,
        data: {
          path: ["shipmentId"],
          equals: shipmentId,
        },
      },
      data: { read: true },
    });
    return { updatedCount: result.count };
  }

  async findOne(userId: string, id: string) {
    return this.prisma.notification.findFirst({ where: { id, userId } });
  }

  async snooze(userId: string, id: string, until: string): Promise<void> {
    const snoozedUntil = new Date(until);
    if (snoozedUntil <= new Date()) {
      throw new BadRequestException("Snooze time must be in the future");
    }

    const result = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { snoozedUntil },
    });

    if (result.count === 0) {
      throw new NotFoundException("Notification not found");
    }
  }

  async unsnooze(userId: string, id: string): Promise<void> {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { snoozedUntil: null },
    });

    if (result.count === 0) {
      throw new NotFoundException("Notification not found");
    }
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

  async buildDigest(
    userId: string,
  ): Promise<{ subject: string; html: string } | null> {
    const unread = await this.prisma.notification.findMany({
      where: { userId, read: false },
      orderBy: { createdAt: "desc" },
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
        const rows = items.map((n) => `<li>${n.title}</li>`).join("");
        return `<h3 style="color:#1a1a2e;">${type.replace(/_/g, " ")} (${items.length})</h3><ul>${rows}</ul>`;
      })
      .join("");

    const unsubscribeUrl = this.getUnsubscribeUrl(userId, 'ALL');

    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#1a1a2e;">ChainSettle — Daily Notification Digest</h2>
        <p>You have <strong>${unread.length}</strong> unread notification(s):</p>
        ${sections}
        <hr />
        <small style="color:#888;">Log in to ChainSettle to view and manage your notifications.</small>
        <br />
        <small style="color:#888;"><a href="${unsubscribeUrl}" style="color:#888;text-decoration:underline;">Unsubscribe</a></small>
      </div>
    `;

    return {
      subject: `Daily digest — ${unread.length} unread notification(s)`,
      html,
    };
  }

  /**
   * Loads and renders a Handlebars template for the given notification type.
   * Returns null when no template file exists for that type (triggers plain-text fallback).
   * Supports locale-specific templates (<locale>/<type>.hbs) with fallback to English
   * and root templates directory (#543).
   * Localized copy is injected as `t` from the i18n email catalog.
   */
  private renderTemplate(
    type: NotificationType,
    data: Record<string, any>,
    locale: string = DEFAULT_LOCALE,
    unsubscribeUrl?: string,
  ): string | null {
    const candidatePaths = [
      path.join(__dirname, "templates", locale, `${type}.hbs`),
      path.join(__dirname, "templates", DEFAULT_LOCALE, `${type}.hbs`),
      path.join(__dirname, "templates", `${type}.hbs`),
    ];

    const templatePath = candidatePaths.find((p) => fs.existsSync(p));
    if (!templatePath) {
      return null;
    }
    try {
      const source = fs.readFileSync(templatePath, "utf-8");
      const template = Handlebars.compile(source);
      const emailCopy = this.i18n.getEmailCopy(type, locale);
      const interpolated = emailCopy
        ? Object.fromEntries(
            Object.entries(emailCopy).map(([k, v]) => [
              k,
              typeof v === "string" ? Handlebars.compile(v)(data ?? {}) : v,
            ]),
          )
        : {};
      return template({ ...(data ?? {}), t: interpolated, unsubscribeUrl });
    } catch (error) {
      this.logger.error(`Failed to render template for ${type}`, error.message);
      return null;
    }
  }

  /**
   * Records a single channel delivery attempt (#635). `error` null = success.
   * Never throws — logging must not break notification delivery.
   */
  private async recordDelivery(
    notificationId: string,
    channel: 'EMAIL' | 'SLACK' | 'IN_APP',
    error: string | null,
  ) {
    try {
      await this.prisma.notificationDelivery.create({
        data: {
          notificationId,
          channel,
          status: error ? 'FAILED' : 'SUCCESS',
          error: error ? error.slice(0, NOTIFICATION_DELIVERY_ERROR_MAX) : null,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to record ${channel} delivery for ${notificationId}: ${(err as Error).message}`);
    }
  }

  /** GET /notifications/:id/deliveries — owner or admin only. */
  async getDeliveries(notificationId: string, requester: { id: string; role?: string }) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { id: true, userId: true },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.userId !== requester.id && requester.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only the notification owner or an admin can view deliveries');
    }
    return this.prisma.notificationDelivery.findMany({
      where: { notificationId },
      orderBy: { attemptedAt: 'asc' },
    });
  }

  /** Sends an email; resolves true on success, false otherwise. */
  async sendEmail(
    ...args: Parameters<NotificationsService['deliverEmail']>
  ): Promise<boolean> {
    return (await this.deliverEmail(...args)) === null;
  }

  /** Sends an email; resolves null on success, or the error message on failure (#635). */
  async deliverEmail(
    to: string,
    subject: string,
    text: string,
    html?: string,
    type?: NotificationType,
    data?: Record<string, any>,
    locale: string = DEFAULT_LOCALE,
    userId?: string,
  ): Promise<string | null> {
    // Never send to addresses that hard-bounced or complained (#434).
    if (await this.isEmailSuppressed(to)) {
      this.logger.warn(
        `Email to ${to} skipped — address is on the suppression list`,
      );
      return 'Address is on the email suppression list';
    }
    try {
      let resolvedUserId = userId;
      if (!resolvedUserId) {
        try {
          const user = await this.prisma.user.findFirst({
            where: { email: { equals: to.trim().toLowerCase(), mode: 'insensitive' } },
            select: { id: true },
          });
          resolvedUserId = user?.id;
        } catch {
          // ignore lookup errors
        }
      }

      let unsubscribeUrl: string | undefined;
      let headers: Record<string, string> | undefined;

      if (resolvedUserId) {
        unsubscribeUrl = this.getUnsubscribeUrl(resolvedUserId, type ?? 'ALL');
        headers = {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        };
      }

      let renderedHtml = html;
      if (!renderedHtml && type) {
        renderedHtml = this.renderTemplate(type, data ?? {}, locale, unsubscribeUrl) ?? undefined;
      }
      const localizedSubject =
        type && this.i18n.getEmailCopy(type, locale)?.subject
          ? this.i18n.getEmailCopy(type, locale)!.subject
          : subject;
      const footer =
        this.i18n.t("email.GENERIC_FOOTER", locale) ||
        "You're receiving this because you're a participant on ChainSettle.";
      const footerHtml = unsubscribeUrl
        ? `<small style="color: #888;">${footer}</small><br /><small style="color: #888;"><a href="${unsubscribeUrl}" style="color: #888; text-decoration: underline;">Unsubscribe</a></small>`
        : `<small style="color: #888;">${footer}</small>`;

      await this.transporter.sendMail({
        from: this.config.get("EMAIL_FROM", "noreply@chainsetttle.com"),
        to,
        subject: `ChainSettle — ${localizedSubject}`,
        text,
        html:
          renderedHtml ??
          `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a1a2e;">ChainSettle</h2>
            <p>${text}</p>
            <hr />
            ${footerHtml}
          </div>
        `,
        ...(headers ? { headers } : {}),
      });
      this.logger.log(`Email sent to ${to}: ${localizedSubject}`);
      return null;
    } catch (error) {
      this.logger.error(`Email failed to ${to}`, error.message);
      return String(error?.message ?? error);
    }
  }

  /** True when the address is on the bounce/complaint suppression list (#434). */
  async isEmailSuppressed(email: string): Promise<boolean> {
    try {
      const hit = await (this.prisma as any).emailSuppression?.findUnique({
        where: { email: email.trim().toLowerCase() },
        select: { id: true },
      });
      return !!hit;
    } catch (error) {
      // Fail closed: if we can't check the list, don't risk hurting sender reputation.
      this.logger.error(`Suppression lookup failed for ${email}`, (error as any).message);
      return true;
    }
  }

  /**
   * Posts a Slack Incoming Webhook payload for a notification event.
   * Failures are logged and never throw — Slack must not break in-app/email.
   * Returns null on success, or the error message on failure.
   */
  async sendSlackMessage(
    webhookUrl: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ) {
    try {
      const shipmentId = data?.shipmentId ? String(data.shipmentId) : undefined;
      const milestoneIndex =
        data?.milestoneIndex !== undefined
          ? String(data.milestoneIndex)
          : undefined;

      const fields = [
        shipmentId
          ? {
              type: "mrkdwn",
              text: `*Shipment:*
\`${shipmentId}\``,
            }
          : null,
        milestoneIndex !== undefined
          ? {
              type: "mrkdwn",
              text: `*Milestone:*
${milestoneIndex}`,
            }
          : null,
        {
          type: "mrkdwn",
          text: `*Type:*
${type}`,
        },
      ].filter(Boolean);

      const payload = {
        text: `ChainSettle — ${title}`,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `ChainSettle — ${title}`,
              emoji: true,
            },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: message },
          },
          ...(fields.length ? [{ type: "section", fields }] : []),
        ],
      };

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const msg = `Slack webhook failed (${response.status}): ${body || response.statusText}`;
        this.logger.error(msg);
        return msg;
      }

      this.logger.log(`Slack notification sent for ${type}: ${title}`);
      return null;
    } catch (error) {
      this.logger.error(
        `Slack notification failed for ${type}`,
        (error as Error).message,
      );
      return (error as Error).message;
    }
  }

  /**
   * Sends an SMS notification to a user's phone number.
   * Applies rate limiting (10 SMS per user per 24h) and checks the user's preference.
   * Only sends for allowed notification types.
   */
  private async sendSmsNotification(
    userId: string,
    phoneNumber: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ): Promise<void> {
    if (!this.smsProvider) {
      this.logger.debug("SMS provider not configured, skipping SMS");
      return;
    }

    try {
      // Check rate limit using the preference record
      const pref = await this.prisma.notificationPreference.findUnique({
        where: { userId },
      });

      if (!pref) {
        return;
      }

      const now = new Date();
      const windowStart = pref.smsWindowStart;
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Reset count if we're past the 24h window
      let currentCount = pref.smsSentCount;
      if (windowStart < twentyFourHoursAgo) {
        currentCount = 0;
        await this.prisma.notificationPreference.update({
          where: { userId },
          data: { smsSentCount: 0, smsWindowStart: now },
        });
      }

      if (currentCount >= SMS_RATE_LIMIT) {
        this.logger.warn(`SMS rate limit exceeded for user ${userId}`);
        return;
      }

      // Format SMS message - keep it concise
      const smsBody = `ChainSettle: ${title} - ${message.substring(0, 140)}`;

      await this.smsProvider.sendSms(phoneNumber, smsBody);

      // Increment sent count
      await this.prisma.notificationPreference.update({
        where: { userId },
        data: { smsSentCount: currentCount + 1 },
      });

      this.logger.log(`SMS notification sent for ${type}: ${title}`);
    } catch (error) {
      this.logger.error(
        `SMS notification failed for ${type}`,
        (error as Error).message,
      );
    }
  }

  /**
   * Posts a Discord webhook message for a notification event.
   * Uses Discord embed format and handles rate limiting (429) with retry.
   */
  async sendDiscordMessage(
    webhookUrl: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ): Promise<void> {
    try {
      const shipmentId = data?.shipmentId ? String(data.shipmentId) : undefined;
      const milestoneIndex =
        data?.milestoneIndex !== undefined
          ? String(data.milestoneIndex)
          : undefined;

      // Color based on notification type
      const colorMap: Record<string, number> = {
        DISPUTE_RAISED: 0xff0000, // Red
        DISPUTE_RESOLVED: 0x00ff00, // Green
        PAYMENT_RELEASED: 0x00ff00, // Green
        MILESTONE_OVERDUE: 0xffaa00, // Orange
        PROOF_SUBMITTED: 0x0099ff, // Blue
        MILESTONE_CONFIRMED: 0x00ff00, // Green
        SHIPMENT_CANCELLED: 0xff0000, // Red
        COMMENT_ADDED: 0x888888, // Gray
        SYSTEM_ALERT: 0xffaa00, // Orange
      };
      const color = colorMap[type] || 0x666666;

      const embed: any = {
        title: `ChainSettle — ${title}`,
        description: message,
        color,
        timestamp: new Date().toISOString(),
        footer: { text: "ChainSettle" },
        fields: [],
      };

      if (shipmentId) {
        embed.fields.push({
          name: "Shipment",
          value: shipmentId,
          inline: true,
        });
      }
      if (milestoneIndex !== undefined) {
        embed.fields.push({
          name: "Milestone",
          value: milestoneIndex,
          inline: true,
        });
      }
      embed.fields.push({ name: "Type", value: type, inline: true });

      const payload = {
        embeds: [embed],
      };

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.status === 429) {
        // Handle rate limiting - Discord sends retry_after in the response
        const retryAfter = response.headers.get("retry-after");
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
        this.logger.warn(
          `Discord rate limited, waiting ${waitMs}ms before retry`,
        );

        // Wait and retry once
        await new Promise((resolve) => setTimeout(resolve, waitMs));

        const retryResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!retryResponse.ok) {
          const body = await retryResponse.text().catch(() => "");
          this.logger.error(
            `Discord webhook retry failed (${retryResponse.status}): ${body || retryResponse.statusText}`,
          );
          return;
        }

        this.logger.log(
          `Discord notification sent for ${type}: ${title} (after retry)`,
        );
        return;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        this.logger.error(
          `Discord webhook failed (${response.status}): ${body || response.statusText}`,
        );
        return;
      }

      this.logger.log(`Discord notification sent for ${type}: ${title}`);
    } catch (error) {
      this.logger.error(
        `Discord notification failed for ${type}`,
        (error as Error).message,
      );
    }
  }

  /**
   * Posts an Adaptive Card to a Microsoft Teams Incoming Webhook.
   * Failures are logged and returned so they never interrupt other channels.
   */
  async sendTeamsMessage(
    webhookUrl: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ): Promise<boolean> {
    const shipmentId = data?.shipmentId ? String(data.shipmentId) : undefined;
    const milestoneIndex =
      data?.milestoneIndex !== undefined
        ? String(data.milestoneIndex)
        : undefined;
    const facts = [
      ...(shipmentId ? [{ title: 'Shipment', value: shipmentId }] : []),
      ...(milestoneIndex !== undefined
        ? [{ title: 'Milestone', value: milestoneIndex }]
        : []),
      { title: 'Type', value: type },
    ];
    const payload = {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              {
                type: 'TextBlock',
                text: `ChainSettle — ${title}`,
                weight: 'Bolder',
                size: 'Medium',
                wrap: true,
              },
              { type: 'TextBlock', text: message, wrap: true },
              { type: 'FactSet', facts },
            ],
          },
        },
      ],
    };

    const post = () =>
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

    try {
      let response = await post();
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
        const retryAt = retryAfter ? Date.parse(retryAfter) : NaN;
        const waitMs = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : Number.isFinite(retryAt)
            ? Math.max(0, retryAt - Date.now())
            : 5000;
        this.logger.warn(
          `Teams webhook rate limited, waiting ${waitMs}ms before retry`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        response = await post();
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.error(
          `Teams webhook failed (${response.status}): ${body || response.statusText}`,
        );
        return false;
      }

      this.logger.log(`Teams notification sent for ${type}: ${title}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Teams notification failed for ${type}`,
        (error as Error).message,
      );
      return false;
    }
  }
}
