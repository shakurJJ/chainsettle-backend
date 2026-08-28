import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';
import axios, { AxiosError } from 'axios';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { NotificationType, Prisma } from '@prisma/client';
import { CreateWebhookDto } from './dto/create-webhook.dto';

// ─── Retry policy ────────────────────────────────────────────────────────────
//
// Up to MAX_AUTO_ATTEMPTS total tries (1 initial + 4 automatic retries).
// Back-off schedule (exponential with ±25 % jitter):
//   attempt 1 → attempt 2 :  ~30 s   (base 30 s)
//   attempt 2 → attempt 3 :  ~2 min  (base 120 s)
//   attempt 3 → attempt 4 :  ~8 min  (base 480 s)
//   attempt 4 → attempt 5 :  ~30 min (base 1800 s)
// Total worst-case window: ≈ 41 minutes, comfortably within the "~24 h" budget
// while giving fast first retries and spacing later ones out.

const MAX_AUTO_ATTEMPTS = 5;

/** HTTP status codes that indicate a transient server-side failure.
 *  Anything else (4xx client error, etc.) is non-retryable. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Arbitrary connection/timeout errors are also retryable. */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ERR_NETWORK',
]);

const DELIVERY_RESPONSE_BODY_MAX = 10 * 1024; // 10 KB

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Base delay in seconds for the n-th retry attempt (1-indexed). */
function baseDelaySeconds(attempt: number): number {
  // 30 s → 120 s → 480 s → 1 800 s
  return 30 * 4 ** (attempt - 1);
}

/** Add ±25 % random jitter to avoid thundering-herd across many endpoints. */
function withJitter(seconds: number): number {
  const jitter = (Math.random() - 0.5) * 0.5; // −0.25 … +0.25
  return Math.round(seconds * (1 + jitter));
}

function nextRetryDate(attemptCount: number): Date {
  const delaySec = withJitter(baseDelaySeconds(attemptCount));
  return new Date(Date.now() + delaySec * 1_000);
}

function isRetryable(err: AxiosError | Error): boolean {
  const axiosErr = err as AxiosError;
  if (axiosErr.response) {
    return RETRYABLE_STATUS_CODES.has(axiosErr.response.status);
  }
  // Network error — check error code
  const code: string = (axiosErr as any).code ?? '';
  return RETRYABLE_ERROR_CODES.has(code) || axiosErr.code === 'ECONNABORTED';
}

function buildBody(eventType: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ eventType, payload, timestamp: new Date().toISOString() });
}

function signBody(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── Registration ───────────────────────────────────────────────────────────

  async register(userId: string, dto: CreateWebhookDto) {
    const plaintext = crypto.randomBytes(32).toString('hex');
    const hashed = crypto.createHash('sha256').update(plaintext).digest('hex');

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: { userId, url: dto.url, secret: hashed, events: dto.events },
    });

    // Plaintext secret returned once — never persisted
    return { ...endpoint, secret: plaintext };
  }

  findForUser(userId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { userId },
      select: { id: true, url: true, events: true, active: true, createdAt: true },
    });
  }

  async findOneWithSummary(userId: string, id: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, userId },
      select: { id: true, url: true, events: true, active: true, createdAt: true },
    });

    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');

    const recentDeliveries = await this.prisma.webhookDelivery.findMany({
      where: { endpointId: id },
      orderBy: { id: 'desc' },
      take: 20,
      select: { statusCode: true, deliveredAt: true },
    });

    const total = recentDeliveries.length;
    const successCount = recentDeliveries.filter(
      (d) => d.statusCode !== null && d.statusCode >= 200 && d.statusCode < 300,
    ).length;
    const failureCount = total - successCount;
    const lastDeliveryAt = recentDeliveries.reduce<Date | null>((latest, d) => {
      if (!d.deliveredAt) return latest;
      return !latest || d.deliveredAt > latest ? d.deliveredAt : latest;
    }, null);

    return {
      ...endpoint,
      recentDeliveries: { total, successCount, failureCount, lastDeliveryAt },
    };
  }

  async remove(id: string, userId: string) {
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { id, userId } });
    if (!ep) throw new NotFoundException('Webhook endpoint not found');
    return this.prisma.webhookEndpoint.delete({ where: { id } });
  }

  async rotateSecret(id: string, userId: string) {
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { id } });
    if (!ep) throw new NotFoundException('Webhook endpoint not found');
    if (ep.userId !== userId) throw new ForbiddenException('Not the endpoint owner');

    const plaintext = crypto.randomBytes(32).toString('hex');
    const hashed = crypto.createHash('sha256').update(plaintext).digest('hex');

    await this.prisma.webhookEndpoint.update({ where: { id }, data: { secret: hashed } });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stellarAddress: true },
    });

    await this.auditLog.record({
      actorId: userId,
      actorAddress: user?.stellarAddress ?? 'unknown',
      action: 'WEBHOOK_SECRET_ROTATED',
      resourceType: 'WebhookEndpoint',
      resourceId: id,
    });

    this.logger.log(`Webhook secret rotated for endpoint ${id} by user ${userId}`);
    return { secret: plaintext };
  }

  // ── Delivery ───────────────────────────────────────────────────────────────

  /** Fan-out a platform event to all active subscribed endpoints. */
  async dispatch(eventType: NotificationType, payload: Record<string, unknown>) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { active: true, events: { has: eventType } },
    });
    await Promise.allSettled(
      endpoints.map((ep) => this.deliverOnce(ep, eventType as string, payload)),
    );
  }

  async getDelivery(userId: string, endpointId: string, deliveryId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, userId },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');

    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpointId },
    });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');

    return {
      ...delivery,
      responseBody: delivery.responseBody?.slice(0, DELIVERY_RESPONSE_BODY_MAX) ?? null,
      // Surface human-friendly retry state
      retryStatus: this.describeRetryStatus(delivery),
    };
  }

  /** Manual retry — resets permanentlyFailedAt so the delivery gets another chance. */
  async retryDelivery(endpointId: string, deliveryId: string, userId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, userId },
    });
    if (!endpoint) {
      throw new ForbiddenException('Only the endpoint owner can retry deliveries');
    }

    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpointId },
    });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');

    const body = buildBody(delivery.eventType, delivery.payload as Record<string, unknown>);
    const signature = signBody(endpoint.secret, body);

    try {
      const res = await axios.post(endpoint.url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-ChainSettle-Signature': signature,
        },
        timeout: 10_000,
      });

      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          statusCode: res.status,
          responseBody: String(res.data ?? '').slice(0, 1_000),
          deliveredAt: new Date(),
          attemptCount: delivery.attemptCount + 1,
          nextRetryAt: null,
          permanentlyFailedAt: null,
        },
      });
    } catch (err) {
      const statusCode: number | null = (err as AxiosError).response?.status ?? null;
      const responseBody = String(
        (err as AxiosError).response?.data ?? (err as Error).message ?? '',
      ).slice(0, 1_000);

      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          statusCode,
          responseBody,
          attemptCount: delivery.attemptCount + 1,
          // Clear permanent failure — let the scheduler pick it up if retryable
          permanentlyFailedAt: null,
        },
      });
    }

    return { message: 'Webhook delivery retried' };
  }

  // ── Auto-retry scheduler ───────────────────────────────────────────────────

  /**
   * Runs every minute.  Picks up deliveries whose `nextRetryAt` is in the
   * past, haven't been permanently failed, and haven't already succeeded.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processRetryQueue() {
    const due = await this.prisma.webhookDelivery.findMany({
      where: {
        nextRetryAt: { lte: new Date() },
        permanentlyFailedAt: null,
        deliveredAt: null,
      },
      include: { endpoint: true },
      take: 50, // process in batches to avoid long-running ticks
    });

    if (due.length === 0) return;

    this.logger.debug(`[retry-queue] Processing ${due.length} due deliveries`);

    await Promise.allSettled(
      due.map((delivery) =>
        this.executeRetry(delivery.endpoint, delivery),
      ),
    );
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /** Initial delivery attempt called by dispatch(). Creates the delivery row. */
  private async deliverOnce(
    ep: { id: string; url: string; secret: string },
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    const body = buildBody(eventType, payload);
    const signature = signBody(ep.secret, body);

    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        endpointId: ep.id,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        attemptCount: 1,
      },
    });

    try {
      const res = await axios.post(ep.url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-ChainSettle-Signature': signature,
        },
        timeout: 10_000,
      });

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode: res.status,
          responseBody: String(res.data ?? '').slice(0, 1_000),
          deliveredAt: new Date(),
          nextRetryAt: null,
        },
      });
    } catch (err) {
      await this.handleFailure(delivery, ep.secret, ep.url, err as AxiosError | Error);
    }
  }

  /** Retry an existing delivery record. */
  private async executeRetry(
    ep: { id: string; url: string; secret: string },
    delivery: {
      id: string;
      eventType: string;
      payload: unknown;
      attemptCount: number;
    },
  ) {
    const body = buildBody(
      delivery.eventType,
      delivery.payload as Record<string, unknown>,
    );
    const signature = signBody(ep.secret, body);

    // Bump attempt count immediately to avoid duplicate concurrent retries
    const updatedDelivery = await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attemptCount: delivery.attemptCount + 1,
        nextRetryAt: null, // clear while in-flight
      },
    });

    try {
      const res = await axios.post(ep.url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-ChainSettle-Signature': signature,
        },
        timeout: 10_000,
      });

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode: res.status,
          responseBody: String(res.data ?? '').slice(0, 1_000),
          deliveredAt: new Date(),
          nextRetryAt: null,
          permanentlyFailedAt: null,
        },
      });

      this.logger.log(
        `[retry] Delivery ${delivery.id} succeeded on attempt ${updatedDelivery.attemptCount}`,
      );
    } catch (err) {
      await this.handleFailure(
        updatedDelivery,
        ep.secret,
        ep.url,
        err as AxiosError | Error,
      );
    }
  }

  /**
   * Shared failure handler for both initial delivery and retries.
   * Decides whether to schedule another retry or mark as permanently failed.
   */
  private async handleFailure(
    delivery: { id: string; attemptCount: number },
    _secret: string,
    _url: string,
    err: AxiosError | Error,
  ) {
    const statusCode: number | null = (err as AxiosError).response?.status ?? null;
    const responseBody = String(
      (err as AxiosError).response?.data ?? (err as Error).message ?? '',
    ).slice(0, 1_000);

    const retryable = isRetryable(err);
    const exhausted = delivery.attemptCount >= MAX_AUTO_ATTEMPTS;

    if (retryable && !exhausted) {
      // Schedule next retry with exponential back-off + jitter
      const nextRetryAt = nextRetryDate(delivery.attemptCount);

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { statusCode, responseBody, nextRetryAt, permanentlyFailedAt: null },
      });

      this.logger.warn(
        `[retry] Delivery ${delivery.id} failed (attempt ${delivery.attemptCount}/${MAX_AUTO_ATTEMPTS}). ` +
          `Next retry at ${nextRetryAt.toISOString()}`,
      );
    } else {
      // Non-retryable (4xx) or budget exhausted — mark as permanently failed
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode,
          responseBody,
          nextRetryAt: null,
          permanentlyFailedAt: new Date(),
        },
      });

      const reason = !retryable
        ? `non-retryable status ${statusCode}`
        : `max attempts (${MAX_AUTO_ATTEMPTS}) exhausted`;

      this.logger.warn(
        `[retry] Delivery ${delivery.id} permanently failed — ${reason}`,
      );
    }
  }

  /** Produces a human-readable retry state description for the delivery detail response. */
  private describeRetryStatus(delivery: {
    deliveredAt: Date | null;
    permanentlyFailedAt: Date | null;
    nextRetryAt: Date | null;
    attemptCount: number;
  }): {
    state: 'succeeded' | 'pending_retry' | 'permanently_failed' | 'pending';
    nextRetryAt: Date | null;
    attemptCount: number;
  } {
    if (delivery.deliveredAt) {
      return { state: 'succeeded', nextRetryAt: null, attemptCount: delivery.attemptCount };
    }
    if (delivery.permanentlyFailedAt) {
      return {
        state: 'permanently_failed',
        nextRetryAt: null,
        attemptCount: delivery.attemptCount,
      };
    }
    if (delivery.nextRetryAt) {
      return {
        state: 'pending_retry',
        nextRetryAt: delivery.nextRetryAt,
        attemptCount: delivery.attemptCount,
      };
    }
    return { state: 'pending', nextRetryAt: null, attemptCount: delivery.attemptCount };
  }
}
